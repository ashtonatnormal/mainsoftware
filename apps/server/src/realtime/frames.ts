// The gateway's protocol on one socket (BUILD-PLAN C0.7, TECH-SPEC T19 item 10; the frames are
// packages/shared gateway.ts's): hello and version negotiation, then sub, unsub and ping, strictly
// validated, through an inbound token bucket. realtime/socket.ts owns the sockets and their indexes,
// and gives this its context (FrameContext): sending, closing, the decision lane and the stream.
//
// A socket's topics (S2). Each topic it holds has an entry with a state (deciding, replaying or
// live) and the generation it was made in. Every step that resumes after an await (a lane result,
// the stream's position, a replay's read) acts on a topic only if the socket is still open and the
// entry still has the generation and state it started with; unsub, a drop and the close delete the
// entry, so a later sub makes a new generation and nothing pending can bring the old one back. An
// ack is built from the state after its last await, so a topic dropped meanwhile is in none of its
// lists: its dropped frame went first. A topic counts towards the 100 from the moment it is asked
// for, deciding and replaying included.
//
// Resume (§7.6, GW-09): a sub with since whose topics are allowed replays each topic's missed
// entries (realtime/stream.ts planResume), one replay at a time per socket and eight per process
// (ReplayQueue), then acks, then sends whatever the reader held for the topics meanwhile, in stream
// order, and marks them live. A topic that can't be resumed is still held, and its ack lists it in
// reset: the client refetches it over REST.
import { randomUUID } from 'node:crypto'
import {
  ClientFrame,
  chooseVersion,
  type GatewayClose,
  type GatewayNudge,
  Hello,
  type Position,
  parseTopic,
} from '@hearth/shared'
import { type RawData, WebSocket } from 'ws'
import type { SessionIds } from '#src/db/pre-org.ts'
import type { CheckRequest, CheckResult } from '#src/realtime/checks.ts'
import type { GatewayPolicy } from '#src/realtime/policy.ts'
import {
  compareIds,
  type HeldEntry,
  type ResumeOutcome,
  type ResumePlan,
  type ResumeRequest,
  type TopicHold,
} from '#src/realtime/stream.ts'

// A socket's hold on one topic: what the reader reads (TopicHold), and its generation and the time
// it was last confirmed allowed (performance.now): its decision's askedAt, then each check's start.
// A deciding topic isn't granted yet, so its confirmedAt is 0 and closeUnconfirmed doesn't count it.
export interface TopicEntry extends TopicHold {
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
  // When a frame or pong was last heard, and when the server last pinged (performance.now).
  lastSeen: number
  lastPing: number
  // The inbound token bucket (P7): full when the socket opens.
  tokens: number
  refilledAt: number
  // Since when the send buffer has been past the soft mark.
  softSince: number | undefined
  // The generation counter, and the topics held in any state.
  gen: number
  readonly topics: Map<string, TopicEntry>
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
    tokens: burst,
    refilledAt: at,
    softSince: undefined,
    gen: 0,
    topics: new Map(),
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

// Sends a frame with the backpressure marks (T19 item 11): nothing to a socket that isn't open or is
// closing (P9); past hardBufferBytes buffered, or past softBufferBytes for softBufferMs, the socket is
// too slow (the caller closes it with 4408); past softBufferBytes a droppable frame is shed.
export function sendFrame(
  conn: Conn,
  text: string,
  droppable: boolean,
  policy: Pick<GatewayPolicy, 'softBufferBytes' | 'hardBufferBytes' | 'softBufferMs'>,
  now: number,
): SendResult {
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
  conn.ws.send(text)
  return 'sent'
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
  // The topic is now replaying or live on the socket (dispatch reads it), or no longer.
  index(conn: Conn, topic: string): void
  unindex(conn: Conn, topic: string): void
  // The decision lane: the batch's whole result, or a rejection (the lane failed).
  decide(conn: Conn, request: CheckRequest): Promise<CheckResult>
  // A lane found the socket's session ended (4401 for every socket of it, path recheck), or its
  // person not admitted (4403 for every socket of theirs).
  sessionEnded(conn: Conn, endedAt: number | undefined): void
  notAdmitted(conn: Conn): void
  // A people signal for the socket's person arrived at or after askedAt: re-check them now (§8.2).
  recheckIfChanged(conn: Conn, askedAt: number): void
  // The org's stream: its position once read (null if Valkey can't be reached), read at once, and
  // how many times it has been reset (a reset during a replay leaves the replay's position in the
  // old epoch).
  position(orgId: string): Promise<Position | null>
  current(orgId: string): Position | null
  resets(orgId: string): number
  // Runs a replay under the replay caps, or answers 'busy'.
  replay<T>(conn: Conn, work: () => Promise<T>): Promise<T | 'busy'>
  // Plans a resume (stream.ts planResume); throws if Valkey can't answer.
  plan(orgId: string, request: ResumeRequest, current: Position | null): Promise<ResumePlan>
  // Counters for the gauges.
  retried(topics: number): void
  resumed(outcome: ResumeOutcome, topics: number): void
  // A frame handler threw.
  failed(conn: Conn, error: unknown): void
}

type Sub = Extract<ClientFrame, { t: 'sub' }>

interface Lists {
  refused: string[]
  retry: string[]
  reset: string[]
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

  // The org's position as the reader last dispatched it (null before it has read the tail), and the
  // spread.
  #pong(conn: Conn): void {
    const ctx = this.#ctx
    ctx.send(
      conn,
      JSON.stringify({
        v: conn.version,
        t: 'pong',
        pos: ctx.current(conn.session.orgId),
        reconnectSpreadMs: ctx.spreadMs(),
      }),
    )
  }

  // Forgets the topics in any state: a pending decision or replay then does nothing for them, and
  // their held entries go. A topic not held is fine.
  #unsub(conn: Conn, id: number, topics: readonly string[]): void {
    const ctx = this.#ctx
    const asked = [...new Set(topics)]
    for (const topic of asked) {
      if (conn.topics.delete(topic)) ctx.unindex(conn, topic)
    }
    ctx.send(
      conn,
      JSON.stringify({
        v: conn.version,
        t: 'ack',
        id,
        ok: asked,
        refused: [],
        reset: [],
        retry: [],
        pos: ctx.current(conn.session.orgId),
      }),
    )
  }

  // sub (§7.4): new topics are decided in the lane (the session confirmed first), then acked, or
  // resumed from since.
  async #sub(conn: Conn, frame: Sub): Promise<void> {
    const ctx = this.#ctx
    const { orgId, userId: person } = conn.session
    const asked = [...new Set(frame.topics)]
    const fresh = asked.filter(topic => !conn.topics.has(topic))
    if (conn.topics.size + fresh.length > ctx.policy.maxTopicsPerSocket) {
      ctx.close(conn, 'tooManyTopics', 'policy')
      return
    }
    const gens = new Map<string, number>()
    for (const topic of fresh) {
      conn.gen++
      conn.topics.set(topic, { state: 'deciding', gen: conn.gen, confirmedAt: 0 })
      gens.set(topic, conn.gen)
    }
    const lists: Lists = { refused: [], retry: [], reset: [] }
    const replaying = new Map<string, number>()
    let eras: ReadonlyMap<string, number> = new Map()
    if (fresh.length > 0) {
      const askedAt = ctx.now()
      const teams = frame.since === undefined ? [] : fresh.filter(topic => parseTopic(topic)?.kind === 'team')
      const request: CheckRequest = {
        sessions: [conn.session.sessionId],
        topics: new Map([[person, new Set(fresh)]]),
        ...(teams.length > 0 ? { eras: new Map([[person, new Set(teams)]]) } : {}),
      }
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
        if (result.notAdmitted.has(person)) return ctx.notAdmitted(conn)
        conn.sessionConfirmedAt = Math.max(conn.sessionConfirmedAt, askedAt)
        const decided = result.topics.get(person)
        for (const [topic, gen] of gens) {
          const entry = deciding(topic, gen)
          if (entry === undefined) continue
          if (decided?.get(topic) === true) {
            entry.state = frame.since === undefined ? 'live' : 'replaying'
            entry.confirmedAt = askedAt
            ctx.index(conn, topic)
            if (frame.since === undefined) ctx.resumed('fresh', 1)
            else replaying.set(topic, gen)
          } else {
            conn.topics.delete(topic)
            lists.refused.push(topic)
          }
        }
        eras = result.eras.get(person) ?? new Map()
        // A removal whose signal arrived while this was decided (§8.2): re-check at once.
        ctx.recheckIfChanged(conn, askedAt)
      }
    }
    if (frame.since !== undefined && replaying.size > 0) {
      return this.#resume(conn, frame.id, asked, frame.since, replaying, eras, lists)
    }
    const pos = await ctx.position(orgId)
    if (!isOpen(conn)) return
    this.#ack(conn, frame.id, asked, lists, pos)
  }

  // The ack, built from the state now: ok is every topic asked that is replaying or live and not
  // reset.
  #ack(conn: Conn, id: number, asked: readonly string[], lists: Lists, pos: Position | null): void {
    const ok = asked.filter(topic => {
      const entry = conn.topics.get(topic)
      return entry !== undefined && entry.state !== 'deciding' && !lists.reset.includes(topic)
    })
    this.#ctx.send(
      conn,
      JSON.stringify({
        v: conn.version,
        t: 'ack',
        id,
        ok,
        refused: lists.refused,
        reset: lists.reset,
        retry: lists.retry,
        pos,
      }),
    )
  }

  async #resume(
    conn: Conn,
    id: number,
    asked: readonly string[],
    since: Position,
    replaying: ReadonlyMap<string, number>,
    eras: ReadonlyMap<string, number>,
    lists: Lists,
  ): Promise<void> {
    const ctx = this.#ctx
    const { orgId } = conn.session
    const still = (topic: string) => {
      const entry = conn.topics.get(topic)
      return entry !== undefined && entry.gen === replaying.get(topic) && entry.state === 'replaying'
        ? entry
        : undefined
    }
    const resetsBefore = ctx.resets(orgId)
    const ran = await ctx.replay(conn, async () => {
      const position = await ctx.position(orgId)
      const topics = [...replaying.keys()].filter(topic => still(topic) !== undefined)
      if (topics.length === 0) return { position, plan: { outcomes: new Map(), frames: [] } as ResumePlan }
      try {
        return { position, plan: await ctx.plan(orgId, { since, topics, eras }, position) }
      } catch {
        return { position, plan: undefined }
      }
    })
    if (!isOpen(conn)) return
    const outcomes = new Map<string, ResumeOutcome>()
    let frames: ResumePlan['frames'] = []
    let position: Position | null = null
    const all = (outcome: ResumeOutcome) => {
      for (const topic of replaying.keys()) outcomes.set(topic, outcome)
    }
    if (ran === 'busy') {
      all('reset_busy')
    } else if (ran.plan === undefined) {
      // Valkey failed mid-decision: the continuity can't be confirmed.
      all('reset_epoch')
      position = ran.position
    } else {
      for (const [topic, outcome] of ran.plan.outcomes) outcomes.set(topic, outcome)
      frames = ran.plan.frames
      position = ran.position
    }
    // The org's stream was reset while this replayed: its position is in the old epoch.
    const reset = ctx.resets(orgId) !== resetsBefore
    if (reset) {
      all('reset_epoch')
      frames = []
    }
    // The missed entries, in order, for the topics still replaying.
    for (const frame of frames) {
      if (outcomes.get(frame.topic) === 'resumed' && still(frame.topic) !== undefined) ctx.send(conn, frame.text)
    }
    const flushing: TopicEntry[] = []
    for (const topic of replaying.keys()) {
      const entry = still(topic)
      if (entry === undefined) continue
      // Past replayFramesMax held entries, the reader dropped them: refetch instead.
      if (outcomes.get(topic) === 'resumed' && entry.overflowed === true) outcomes.set(topic, 'reset_long')
      const outcome = outcomes.get(topic) ?? 'reset_epoch'
      if (outcome !== 'resumed') lists.reset.push(topic)
      ctx.resumed(outcome, 1)
      flushing.push(entry)
    }
    const pos = reset || ran === 'busy' ? ctx.current(orgId) : position
    this.#ack(conn, id, asked, lists, pos)
    // What the reader held for these topics meanwhile, after the replay's position, in stream order
    // across them all, so the client's per-socket positions never skip one. Each topic is live from
    // here on, a reset one too: it is held, and the client refetches it.
    const held: HeldEntry[] = []
    for (const entry of flushing) {
      for (const h of entry.held ?? []) if (pos === null || compareIds(h.id, pos.pos) > 0) held.push(h)
      entry.state = 'live'
      entry.held = undefined
      entry.overflowed = undefined
    }
    held.sort((a, b) => compareIds(a.id, b.id))
    for (const h of held) ctx.send(conn, h.text)
  }
}

// The flags nudge's coalescing (P4): per org and code, a nudge goes at once if none went in the
// last coalesceMs, and otherwise one is sent coalesceMs after the last, so the last change is
// always nudged and an org gets at most one a second.
export class Nudger {
  readonly #send: (orgId: string, what: GatewayNudge) => void
  readonly #coalesceMs: number
  readonly #now: () => number
  readonly #last = new Map<string, number>()
  readonly #timers = new Map<string, NodeJS.Timeout>()

  constructor(send: (orgId: string, what: GatewayNudge) => void, coalesceMs: number, now: () => number) {
    this.#send = send
    this.#coalesceMs = coalesceMs
    this.#now = now
  }

  nudge(orgId: string, what: GatewayNudge): void {
    const key = `${orgId} ${what}`
    // One already scheduled carries this change too.
    if (this.#timers.has(key)) return
    const since = this.#now() - (this.#last.get(key) ?? Number.NEGATIVE_INFINITY)
    if (since >= this.#coalesceMs) {
      this.#last.set(key, this.#now())
      this.#send(orgId, what)
      return
    }
    const timer = setTimeout(
      () => {
        this.#timers.delete(key)
        this.#last.set(key, this.#now())
        this.#send(orgId, what)
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
