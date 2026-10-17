// The gateway's protocol on one socket (BUILD-PLAN C0.7, TECH-SPEC T19 item 10; the frames are
// packages/shared gateway.ts's): hello and version negotiation, then sub, unsub and ping, strictly
// validated, through an inbound token bucket. realtime/socket.ts owns the sockets and their indexes,
// and gives this its context (FrameContext): sending, closing, the decision lane and the stream.
//
// A socket's topics (S2). Each topic it holds has an entry with a state (deciding or live) and the
// generation it was made in. Every step that continues after an await (a lane result, the reader's
// first read of the org's stream) acts on a topic only if the socket is still open and the entry
// still has the generation and state it started with; unsub, a drop and the close delete the entry,
// so a later sub makes a new generation and nothing pending can bring the old one back. An ack is
// built from the state after its last await, so a topic dropped meanwhile is in none of its lists:
// its dropped frame went first. A sub of a topic the socket already holds decides nothing: it is
// acked ok if live in the generation the sub found, and otherwise retry (an earlier sub is still
// deciding it, or answered it refused or retry meanwhile); one an unsub or a drop ended meanwhile is
// in no list (forget()). A topic counts towards the 100 from the moment it is asked for, deciding
// ones included.
//
// Resume is re-authorise and refetch (the owner's decision; T19 item 9, GW-09). A sub names topics
// only, a new socket holds none, and every topic is decided by can() whatever the client held
// before; the client refetches each topic acked ok over REST. No frame carries a stream position:
// ack and pong say nothing about the org's stream, and an ev only its own topic's ids. A topic goes
// live (and into the reader's index) before its ack, and the ack waits for the reader to follow the
// org's stream (stream.ts ready()), so every entry appended after the ack reaches the socket and
// the client's fetch, which starts after the ack, covers everything before it.
import { randomUUID } from 'node:crypto'
import { ClientFrame, chooseVersion, type GatewayClose, Hello } from '@hearth/shared'
import { type RawData, WebSocket } from 'ws'
import type { SessionIds } from '#src/db/pre-org.ts'
import type { CheckRequest, CheckResult } from '#src/realtime/checks.ts'
import type { GatewayPolicy } from '#src/realtime/policy.ts'

// A socket's hold on one topic: its state, its generation and the time it was last confirmed
// allowed (performance.now): its decision's askedAt, then each check's start. A live topic is in the
// reader's index (socket.ts byTopic) and gets each entry at once; a deciding one isn't granted yet,
// so it is in no index, gets nothing (its client fetches it after its ack), and its confirmedAt is 0,
// so closeUnconfirmed doesn't count it.
export interface TopicEntry {
  state: 'deciding' | 'live'
  gen: number
  confirmedAt: number
}

// One open socket. Its session, org and person come from the upgrade's lookup, never from a frame
// (GW-13).
export interface Conn {
  readonly ws: WebSocket
  // Random, for support logs (welcome.socket).
  readonly id: string
  readonly session: SessionIds
  // `<org>:<person>`, the per-person index's key.
  readonly person: string
  // The version welcome chose; undefined until hello.
  version: number | undefined
  // Set by the first close the server sends (or by ws's own on a protocol error): nothing more is
  // sent, and the socket is cut closeGraceMs later.
  closing: boolean
  closeTimer: NodeJS.Timeout | undefined
  helloTimer: NodeJS.Timeout | undefined
  // When a frame or pong was last heard, and when the server last pinged (performance.now). The
  // pong answering that ping is free of the bucket; any other takes a token (awaitingPong).
  lastSeen: number
  lastPing: number
  awaitingPong: boolean
  // The inbound token bucket (P7): full when the socket opens.
  tokens: number
  refilledAt: number
  // Since when the send buffer has been past the soft mark.
  softSince: number | undefined
  // The generation counter, and the topics held in any state.
  gen: number
  readonly topics: Map<string, TopicEntry>
  // Subs still being answered, and while there are any, the generations an unsub or a drop ended
  // (forget()): a sub that found such a topic held leaves it out of every list of its ack, since the
  // client heard of its end, and asks for any other it found held but not live in retry.
  subs: number
  readonly ended: Set<number>
  // When the session was last confirmed live: the upgrade's arrival, then each check's start.
  sessionConfirmedAt: number
  // Resolves once the socket has closed, which the socket's one close listener says (closed()).
  readonly done: Promise<void>
  readonly closed: () => void
}

export function newConn(ws: WebSocket, session: SessionIds, at: number, askedAt: number, burst: number): Conn {
  let closed: () => void = () => {}
  const done = new Promise<void>(resolve => {
    closed = resolve
  })
  return {
    ws,
    id: randomUUID(),
    session,
    person: `${session.orgId}:${session.userId}`,
    version: undefined,
    closing: false,
    closeTimer: undefined,
    helloTimer: undefined,
    lastSeen: at,
    lastPing: at,
    awaitingPong: false,
    tokens: burst,
    refilledAt: at,
    softSince: undefined,
    gen: 0,
    topics: new Map(),
    subs: 0,
    ended: new Set(),
    sessionConfirmedAt: askedAt,
    done,
    closed,
  }
}

// Whether the socket is open and the server hasn't closed it: the check every step makes after an
// await.
export function isOpen(conn: Conn): boolean {
  return !conn.closing && conn.ws.readyState === WebSocket.OPEN
}

// Ends the socket's hold on a topic in a way its client hears of, an unsub or a dropped frame, and
// answers the entry that ended (undefined if none was held). The caller unindexes it.
export function forget(conn: Conn, topic: string): TopicEntry | undefined {
  const entry = conn.topics.get(topic)
  if (entry === undefined) return undefined
  conn.topics.delete(topic)
  if (conn.subs > 0) conn.ended.add(entry.gen)
  return entry
}

// Takes a token from the socket's bucket, refilled at framesPerSecond up to frameBurst; false if
// it is empty (P7).
export function takeToken(conn: Conn, policy: Pick<GatewayPolicy, 'frameBurst' | 'framesPerSecond'>, now: number) {
  const elapsed = Math.max(0, now - conn.refilledAt)
  conn.tokens = Math.min(policy.frameBurst, conn.tokens + (elapsed / 1000) * policy.framesPerSecond)
  conn.refilledAt = now
  if (conn.tokens < 1) return false
  conn.tokens -= 1
  return true
}

export type SendResult = 'sent' | 'shed' | 'too_slow' | 'closed'

type Marks = Pick<GatewayPolicy, 'softBufferBytes' | 'hardBufferBytes' | 'softBufferMs'>

// The backpressure marks (T19 item 11), for one more frame: nothing to a socket that isn't open or
// is closing (P9); past hardBufferBytes buffered, or past softBufferBytes for softBufferMs, the socket
// is too slow (the caller closes it with 4408); past softBufferBytes a droppable frame is shed.
// 'sent' means it may go.
export function marks(conn: Conn, droppable: boolean, policy: Marks, now: number): SendResult {
  if (!isOpen(conn)) return 'closed'
  const buffered = conn.ws.bufferedAmount
  if (buffered >= policy.hardBufferBytes) return 'too_slow'
  if (buffered >= policy.softBufferBytes) {
    conn.softSince ??= now
    if (now - conn.softSince > policy.softBufferMs) return 'too_slow'
    if (droppable) return 'shed'
  } else {
    conn.softSince = undefined
  }
  return 'sent'
}

// Sends a frame through the marks.
export function sendFrame(conn: Conn, text: string, droppable: boolean, policy: Marks, now: number): SendResult {
  const result = marks(conn, droppable, policy, now)
  if (result === 'sent') conn.ws.send(text)
  return result
}

// Sends a protocol ping (the heartbeat) or pong (the answer to a client's ping) through the same
// marks, as a droppable frame: ws's own automatic pong is off, so no frame the server sends gets
// past them (T19 item 11).
export function sendControl(
  conn: Conn,
  kind: 'ping' | 'pong',
  data: Buffer | undefined,
  policy: Marks,
  now: number,
): SendResult {
  const result = marks(conn, true, policy, now)
  if (result === 'sent') {
    if (kind === 'ping') conn.ws.ping(data)
    else conn.ws.pong(data)
  }
  return result
}

// What a socket's protocol needs of the gateway (realtime/socket.ts).
export interface FrameContext {
  readonly policy: GatewayPolicy
  // The protocol versions this server speaks (GATEWAY_VERSIONS unless a test sets others).
  readonly versions: readonly number[]
  // The monotonic clock (performance.now).
  now(): number
  // The reconnect spread welcome and pong carry (P3).
  spreadMs(): number
  // Sends a frame through the marks; a socket too slow for it is closed with 4408.
  send(conn: Conn, text: string, options?: { droppable?: boolean }): void
  // Closes the socket once (the idempotent close, P9), counted under counter.
  close(conn: Conn, close: GatewayClose, counter: 'policy' | 'outdated' | 'versionNewer' | 'error'): void
  // The topic is now live on the socket (dispatch reads it), or no longer.
  index(conn: Conn, topic: string): void
  unindex(conn: Conn, topic: string): void
  // The decision lane: the batch's whole result, or a rejection (the lane failed).
  decide(conn: Conn, request: CheckRequest): Promise<CheckResult>
  // The open sockets of the socket's person, now.
  personSockets(conn: Conn): readonly Conn[]
  // A lane found the socket's session ended (4401 for every socket of it, path recheck), or its
  // person not admitted: 4403 for the person's sockets taken before the decision was asked for,
  // never one opened after its read (as for a check, which closes only the sockets it asked about).
  sessionEnded(conn: Conn, endedAt: number | undefined): void
  notAdmitted(sockets: readonly Conn[]): void
  // A people signal for the socket's person arrived at or after askedAt: re-check them now (§8.2).
  recheckIfChanged(conn: Conn, askedAt: number): void
  // Whether the reader follows the org's stream, waiting for its first read of it (stream.ts
  // ready()); false if Valkey can't be reached, and the reader resets the org once it can.
  streamReady(orgId: string): Promise<boolean>
  // Counters for the gauges.
  retried(topics: number): void
  // A frame handler threw.
  failed(conn: Conn, error: unknown): void
}

type Sub = Extract<ClientFrame, { t: 'sub' }>

interface Lists {
  refused: string[]
  retry: string[]
}

// A sub's topics: those asked, those it decided (with the generation it made each in), and those it
// found held (with theirs).
interface Own {
  asked: readonly string[]
  gens: ReadonlyMap<string, number>
  held: ReadonlyMap<string, number>
}

export class Frames {
  readonly #ctx: FrameContext

  constructor(ctx: FrameContext) {
    this.#ctx = ctx
  }

  // A socket was accepted: it says hello within helloTimeoutMs, or closes with 1008 hello_timeout.
  opened(conn: Conn): void {
    conn.helloTimer = setTimeout(
      () => this.#ctx.close(conn, 'helloTimeout', 'policy'),
      Math.max(1, this.#ctx.policy.helloTimeoutMs),
    )
  }

  // One frame from the client (§6.6's order).
  message(conn: Conn, data: RawData, isBinary: boolean): void {
    const ctx = this.#ctx
    if (!isOpen(conn)) return
    if (isBinary) {
      ctx.close(conn, 'badFrame', 'policy')
      return
    }
    if (!takeToken(conn, ctx.policy, ctx.now())) {
      ctx.close(conn, 'tooManyFrames', 'policy')
      return
    }
    conn.lastSeen = ctx.now()
    let value: unknown
    try {
      value = JSON.parse(String(data))
    } catch {
      ctx.close(conn, 'badFrame', 'policy')
      return
    }
    if (conn.version === undefined) {
      this.#hello(conn, value)
      return
    }
    // Every frame after hello is in the version welcome chose, strictly; a second hello falls here.
    const parsed = ClientFrame.safeParse(value)
    if (!parsed.success || parsed.data.v !== conn.version) {
      ctx.close(conn, 'badFrame', 'policy')
      return
    }
    const frame = parsed.data
    switch (frame.t) {
      case 'ping':
        this.#pong(conn)
        return
      case 'unsub':
        this.#unsub(conn, frame.id, frame.topics)
        return
      case 'sub':
        this.#sub(conn, frame).catch(error => ctx.failed(conn, error))
        return
    }
  }

  // welcome, or why there's no version both speak (P5).
  #hello(conn: Conn, value: unknown): void {
    const ctx = this.#ctx
    const hello = Hello.safeParse(value)
    if (!hello.success) {
      ctx.close(conn, 'badFrame', 'policy')
      return
    }
    const chosen = chooseVersion(hello.data.versions, ctx.versions)
    if (chosen === 'client_outdated') {
      ctx.close(conn, 'clientOutdated', 'outdated')
      return
    }
    // A client newer than this server: it reconnects within the spread, and reaches a newer task
    // once the deploy moves on.
    if (chosen === 'server_outdated') {
      ctx.close(conn, 'tryAgain', 'versionNewer')
      return
    }
    clearTimeout(conn.helloTimer)
    conn.helloTimer = undefined
    conn.version = chosen.v
    const { policy } = ctx
    ctx.send(
      conn,
      JSON.stringify({
        v: chosen.v,
        t: 'welcome',
        socket: conn.id,
        heartbeatMs: policy.heartbeatMs,
        maxTopics: policy.maxTopicsPerSocket,
        maxTopicsPerFrame: policy.maxTopicsPerFrame,
        maxFrameBytes: policy.maxFrameBytes,
        reconnectSpreadMs: ctx.spreadMs(),
      }),
    )
  }

  // The spread, and nothing about the org's stream.
  #pong(conn: Conn): void {
    const ctx = this.#ctx
    ctx.send(conn, JSON.stringify({ v: conn.version, t: 'pong', reconnectSpreadMs: ctx.spreadMs() }))
  }

  // Forgets the topics in any state: a pending decision then does nothing for them. A topic not held
  // is fine.
  #unsub(conn: Conn, id: number, topics: readonly string[]): void {
    const ctx = this.#ctx
    const asked = [...new Set(topics)]
    for (const topic of asked) {
      if (forget(conn, topic) !== undefined) ctx.unindex(conn, topic)
    }
    ctx.send(conn, JSON.stringify({ v: conn.version, t: 'ack', id, ok: asked, refused: [], retry: [] }))
  }

  // sub (§7.4): new topics are decided in the lane (the session confirmed first), then acked once
  // the reader follows the org's stream.
  async #sub(conn: Conn, frame: Sub): Promise<void> {
    conn.subs++
    try {
      await this.#subscribe(conn, frame)
    } finally {
      if (--conn.subs === 0) conn.ended.clear()
    }
  }

  async #subscribe(conn: Conn, frame: Sub): Promise<void> {
    const ctx = this.#ctx
    const { orgId, userId: person } = conn.session
    const asked = [...new Set(frame.topics)]
    // The topics already held, in any state, with the generation each is held in: never decided
    // again, and acked from their state at the ack (S2).
    const held = new Map<string, number>()
    for (const topic of asked) {
      const entry = conn.topics.get(topic)
      if (entry !== undefined) held.set(topic, entry.gen)
    }
    const fresh = asked.filter(topic => !held.has(topic))
    if (conn.topics.size + fresh.length > ctx.policy.maxTopicsPerSocket) {
      ctx.close(conn, 'tooManyTopics', 'policy')
      return
    }
    // This sub's own topics, with their generations.
    const gens = new Map<string, number>()
    for (const topic of fresh) {
      conn.gen++
      conn.topics.set(topic, { state: 'deciding', gen: conn.gen, confirmedAt: 0 })
      gens.set(topic, conn.gen)
    }
    const lists: Lists = { refused: [], retry: [] }
    if (fresh.length > 0) {
      const askedAt = ctx.now()
      const request: CheckRequest = { sessions: [conn.session.sessionId], topics: new Map([[person, new Set(fresh)]]) }
      // The person's sockets before the decision reads admission: a not-admitted verdict closes only
      // these, never one opened (and admitted) after its read.
      const sockets = ctx.personSockets(conn)
      let result: CheckResult | undefined
      try {
        result = await ctx.decide(conn, request)
      } catch {
        // The lane failed: nothing closes, and the topics come back in retry (P8).
        result = undefined
      }
      if (!isOpen(conn)) return
      const deciding = (topic: string, gen: number) => {
        const entry = conn.topics.get(topic)
        return entry !== undefined && entry.gen === gen && entry.state === 'deciding' ? entry : undefined
      }
      if (result === undefined) {
        for (const [topic, gen] of gens) {
          if (deciding(topic, gen) === undefined) continue
          conn.topics.delete(topic)
          lists.retry.push(topic)
        }
        ctx.retried(lists.retry.length)
      } else {
        const session = result.sessions.get(conn.session.sessionId)
        // An ended session is never granted a topic (S1, m2).
        if (session === undefined || !session.live) return ctx.sessionEnded(conn, session?.endedAt)
        if (result.notAdmitted.has(person)) return ctx.notAdmitted(sockets)
        conn.sessionConfirmedAt = Math.max(conn.sessionConfirmedAt, askedAt)
        const decided = result.topics.get(person)
        for (const [topic, gen] of gens) {
          const entry = deciding(topic, gen)
          if (entry === undefined) continue
          if (decided?.get(topic) === true) {
            // Live, and in the reader's index, before the ack: an entry appended after the ack
            // reaches the socket.
            entry.state = 'live'
            entry.confirmedAt = askedAt
            ctx.index(conn, topic)
          } else {
            conn.topics.delete(topic)
            lists.refused.push(topic)
          }
        }
        // A removal whose signal arrived while this was decided (§8.2): a targeted re-check follows.
        ctx.recheckIfChanged(conn, askedAt)
      }
    }
    // Waits for the reader to follow the org's stream, so every entry appended after the ack is
    // dispatched and the client's fetch covers the rest. If Valkey can't be reached the ack goes
    // anyway, after waiting no longer than the command client's 1 s timeout, and the reader resets
    // the org once it reads the stream.
    await ctx.streamReady(orgId)
    if (!isOpen(conn)) return
    this.#ack(conn, frame.id, { asked, gens, held }, lists)
  }

  // The ack, built from the state now.
  //   - ok: each topic this sub granted and still holds live in the generation it made, and each it
  //     found held that is live now in the same generation. The client fetches each over REST.
  //   - retry, besides the lane's: each other topic it found held, unless an unsub or a drop ended
  //     it meanwhile. Such a topic was still being decided for an earlier sub, or that sub refused it
  //     or answered it retry; the client asks again after its back-off, by when the earlier sub's
  //     ack has come.
  //   - A topic asked for in none of the lists was dropped first (its dropped frame came before the
  //     ack), or unsubscribed since.
  #ack(conn: Conn, id: number, sub: Own, lists: Lists): void {
    const ctx = this.#ctx
    const ok: string[] = []
    const pending: string[] = []
    for (const topic of sub.asked) {
      const entry = conn.topics.get(topic)
      const mine = sub.gens.get(topic)
      if (mine !== undefined) {
        if (entry?.gen === mine && entry.state === 'live') ok.push(topic)
        continue
      }
      const gen = sub.held.get(topic)
      if (gen === undefined) continue
      if (entry?.gen === gen && entry.state === 'live') ok.push(topic)
      else if (!conn.ended.has(gen)) pending.push(topic)
    }
    if (pending.length > 0) ctx.retried(pending.length)
    ctx.send(
      conn,
      JSON.stringify({
        v: conn.version,
        t: 'ack',
        id,
        ok,
        refused: lists.refused,
        retry: [...lists.retry, ...pending],
      }),
    )
  }
}

// Coalescing on the trailing edge (P4), per key: the flags nudge (per org and code) and the reset
// (per org; T19 item 9). A signal is sent at once if none went for its key in the last coalesceMs,
// and otherwise one is sent coalesceMs after the last, which carries every signal meanwhile. So the
// last signal is always followed by a send, and a key gets at most one each coalesceMs.
export class Coalescer {
  readonly #coalesceMs: number
  readonly #now: () => number
  readonly #last = new Map<string, number>()
  readonly #timers = new Map<string, NodeJS.Timeout>()

  constructor(coalesceMs: number, now: () => number) {
    this.#coalesceMs = coalesceMs
    this.#now = now
  }

  // send is what the key's signal does; one already scheduled for the key carries this signal too.
  signal(key: string, send: () => void): void {
    if (this.#timers.has(key)) return
    const since = this.#now() - (this.#last.get(key) ?? Number.NEGATIVE_INFINITY)
    if (since >= this.#coalesceMs) {
      this.#last.set(key, this.#now())
      send()
      return
    }
    const timer = setTimeout(
      () => {
        this.#timers.delete(key)
        this.#last.set(key, this.#now())
        send()
      },
      Math.max(1, this.#coalesceMs - since),
    )
    timer.unref()
    this.#timers.set(key, timer)
  }

  stop(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer)
    this.#timers.clear()
  }
}
