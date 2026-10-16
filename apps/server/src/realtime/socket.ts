// The realtime gateway on /ws (BUILD-PLAN C0.7, TECH-SPEC T19; grown from C0.5's minimal socket). A
// socket opens only for a live session, from the app's own origin (CLAUDE.md, Security and
// privacy), then speaks the versioned, ids-only protocol of packages/shared gateway.ts
// (realtime/frames.ts): hello, then topics (person, org and team), each decided by can() once the
// subscriber's session is confirmed live, with events fanned out from the org's Valkey stream
// (realtime/stream.ts).
//
// Revocation (Rule 6, ACC-05): a session's sockets close with 4401, and a topic is dropped with a
// dropped frame, within 60 s of the access ending. Three paths get them there: the api's push
// (revoked) and the worker's durable jobs (access), which name ended sessions (closed at once, with
// no database read) and people whose keys changed (re-checked against Postgres in the decision
// lane); and the periodic check of every socket's session, admission and topics every 15 s, which is
// the guarantee. While checks fail (Postgres down), a socket whose session or a topic would go
// unconfirmed past 60 s if the next failed too closes with 1013, never 4401. Each revocation
// applied is logged with its latency (revocation/latency.ts). The races (T19 item 6): a session
// named on either channel is refused at upgrade for 60 s, every gate after the lookup runs in the
// same tick as handleUpgrade, and a people signal during an accept or a subscribe decision re-checks
// the person at once.
//
// Limits (T19 item 11): 8 sockets a session, 40 a person and 25,000 a process; 5 session lookups at
// once and 1,000 waiting, each slot held until its lookup settles (M1); an inbound token bucket and
// 100 topics a socket; send-buffer marks. The heartbeat (T19 item 12): a protocol ping 25 s after the
// last, and a socket silent for 55 s is cut. At SIGTERM the gateway refuses upgrades and closes every
// socket with 1001 within 1 s; clients reconnect within the spread welcome and pong carry (P3).
//
// Once a listener for 'upgrade' exists, Node hands every upgrade request to it and never to Fastify,
// and leaves one it doesn't answer hanging. So the handler here answers every upgrade, whatever its
// path, and never lets a client's error reach the process: main.ts exits on an uncaught exception,
// so one client resetting its connection would otherwise end every socket. The api and worker roles
// have no listener, so Node answers an upgrade there as an ordinary request, which their 404 handler
// refuses.
//
// Logs carry counts and an org id, never a person's or session's id, a token or content (T19 items
// 13 and 14): the per-socket open and error lines are at debug.
import { type IncomingMessage, STATUS_CODES } from 'node:http'
import type { Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { GATEWAY_CLOSE, GATEWAY_VERSIONS, type GatewayClose, type GatewayNudge, type Position } from '@hearth/shared'
import type { FastifyInstance } from 'fastify'
import type { Logger } from 'pino'
import { type WebSocket, WebSocketServer } from 'ws'
import { readCookie, SESSION_COOKIE } from '#src/auth/cookies.ts'
import { sha256 } from '#src/auth/crypto.ts'
import { SOCKET_REVOKE_MS, SOCKETS_PER_SESSION } from '#src/auth/policy.ts'
import { NoSystemPrincipal } from '#src/db/database.ts'
import type { SessionIds } from '#src/db/pre-org.ts'
import { failureFields } from '#src/db/sqlstate.ts'
import { pathOf } from '#src/logger.ts'
import { isAppOrigin } from '#src/origin.ts'
import {
  type CheckOrg,
  type CheckRequest,
  type CheckResult,
  DecisionLane,
  TargetedQueue,
} from '#src/realtime/checks.ts'
import { type Conn, type FrameContext, Frames, isOpen, Nudger, newConn, sendFrame } from '#src/realtime/frames.ts'
import { GATEWAY_POLICY, type GatewayPolicy, gatewayPolicy, reconnectSpreadMs } from '#src/realtime/policy.ts'
import {
  RESUME_OUTCOMES,
  ReplayQueue,
  type ResumeOutcome,
  type ResumePlan,
  type ResumeRequest,
  type StreamTarget,
} from '#src/realtime/stream.ts'
import type { RevocationLatency, RevocationPath, StartSource } from '#src/revocation/latency.ts'

export const SOCKET_PATH = '/ws'

// The numbers here are realtime/policy.ts's (T19). A frame from a client may be at most 4 KiB; a
// larger one closes that socket.
export const MAX_FRAME_BYTES = GATEWAY_POLICY.maxFrameBytes

// How long a session lookup may take, from the upgrade's arrival, before the upgrade is refused 503.
export const LOOKUP_TIMEOUT_MS = GATEWAY_POLICY.lookupTimeoutMs

// How long one check may take, at most, before it counts as failed (never longer than the check
// interval), so a query on a connection that has stopped answering can't hold up every later check
// and keep ended sessions' sockets open past T5's 60 s.
export const RECHECK_TIMEOUT_MS = GATEWAY_POLICY.recheckTimeoutMs

// How long a client gets to finish the closing handshake before its socket is cut.
export const CLOSE_GRACE_MS = GATEWAY_POLICY.closeGraceMs

// The close every socket gets when the server stops: the client reconnects (to another task).
export const STOPPING_CLOSE = GATEWAY_CLOSE.stopping

// The close a socket gets when its session or a topic couldn't be confirmed in time, because the
// checks kept failing: the session may still be live, so the client reconnects, and the upgrade's
// own lookup decides.
export const UNCHECKED_CLOSE = GATEWAY_CLOSE.tryAgain

// Refused upgrades are logged at debug, since anyone can repeat them without limit, and summed up
// at info at most this often.
const REFUSAL_LOG_MS = 60_000

// Why an upgrade was refused, and what it was answered. The browser sees none of these (every
// refusal is close 1006 to it), so they are for logs and the gauges.
const REFUSALS = {
  path: { status: 404, error: 'not_found' },
  origin: { status: 403, error: 'forbidden' },
  session: { status: 401, error: 'signed_out' },
  // T14's 8 sockets a session, and the 40 a person (S4).
  busySession: { status: 429, error: 'too_many_requests' },
  busyPerson: { status: 429, error: 'too_many_requests' },
  // The process's 25,000 sockets, or the lookup queue full.
  full: { status: 503, error: 'unavailable' },
  error: { status: 503, error: 'unavailable' },
} as const
export type Refusal = keyof typeof REFUSALS
const REFUSAL_NAMES = Object.keys(REFUSALS) as Refusal[]

// Why the server closed a socket, as the gauges count them.
const CLOSES = [
  // 4401 by the api's push, the worker's durable path, or a check.
  'revoked',
  'durable',
  'recheck',
  // 4403: the admission hook no longer admits the person.
  'notAdmitted',
  // 1013: unconfirmed in time, or no system principal.
  'unchecked',
  // Cut after the dead limit.
  'dead',
  // 1008: hello timeout, bad frame, too many frames or topics.
  'policy',
  // 4408.
  'slow',
  // 1001.
  'stopping',
  // 1013: a client newer than this server; 4426: one older.
  'versionNewer',
  'outdated',
  // ws's own close on a protocol error (1009 for a frame over 4 KiB), or a frame handler that threw
  // (1011).
  'error',
] as const
type CloseCounter = (typeof CLOSES)[number]

const zero = <K extends string>(keys: readonly K[]): Record<K, number> =>
  Object.fromEntries(keys.map(key => [key, 0])) as Record<K, number>

// What a revocation message asks of the gateway: its path (the api's push, or the worker's durable
// jobs), its cause code, and when the change happened, if the publisher knows.
export interface Trigger {
  path: 'push' | 'durable'
  cause: string
  at?: number | undefined
}

// How what a check finds is labelled: its path, and the cause of the trigger that asked for it (a
// periodic check has none: its closes are 'ended', its drops 'keys_changed').
interface Label {
  path: RevocationPath
  cause?: string | undefined
}

// The org's event stream as the gateway uses it (realtime/stream.ts StreamReader).
export interface GatewayStream {
  start(): void
  stop(): Promise<void>
  watch(orgId: string): void
  position(orgId: string): Promise<Position | null>
  current(orgId: string): Position | null
  lagMs(): number
  stuck(): boolean
}

// With no stream (unit tests that don't need one): every position is unknown.
const NO_STREAM: GatewayStream = {
  start: () => {},
  stop: async () => {},
  watch: () => {},
  position: async () => null,
  current: () => null,
  lagMs: () => 0,
  stuck: () => false,
}

export interface SocketServerOptions {
  appOrigin: string
  logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>
  // The live session behind a token's SHA-256, or undefined (db/pre-org.ts sessionByToken in
  // production; a fake in unit tests). A throw refuses the upgrade 503.
  lookup: (tokenHash: Buffer) => Promise<SessionIds | undefined>
  // One org's check (realtime/checks.ts orgChecker in production; a fake in unit tests). A throw
  // closes nothing at once: only what closeUnconfirmed names, and NoSystemPrincipal closes the org's
  // sockets with 1013.
  check: CheckOrg
  // How often the periodic check runs: SOCKET_RECHECK_MS unless a test shortens it.
  recheckMs: number
  // How soon a lost session or topic must go: SOCKET_REVOKE_MS unless a test shortens it.
  revokeWithinMs?: number
  // policy.lookupTimeoutMs and policy.recheckTimeoutMs (or the check interval if that is shorter),
  // unless a test sets them.
  lookupTimeoutMs?: number
  recheckTimeoutMs?: number
  // A test's overrides of realtime/policy.ts.
  policy?: Partial<GatewayPolicy>
  // The protocol versions spoken (GATEWAY_VERSIONS unless a test sets others).
  versions?: readonly number[]
  // The org's event stream, given the gateway as its target (StreamReader in production).
  stream?: (target: StreamTarget<Conn>) => GatewayStream
  // Plans a resume against the stream (stream.ts planResume on the command client). Without it,
  // every resume answers reset.
  resume?: (orgId: string, request: ResumeRequest, current: Position | null) => Promise<ResumePlan>
  // Whether an admission hook is set (C0.9; the check asks it): every accept is then re-checked.
  admission?: boolean
  // Records each revocation applied (revocation/latency.ts).
  latency?: Pick<RevocationLatency, 'record' | 'summarise' | 'oldest' | 'stop'>
}

export interface SocketCounts {
  // Sockets open now, and the topics they hold in any state.
  open: number
  topics: number
  // Upgrades refused since the server started, by reason.
  refused: Record<Refusal, number>
  // Sockets closed by the server, by why. closedRevoked is the api's push alone.
  closedRevoked: number
  closedDurable: number
  closedRecheck: number
  closedNotAdmitted: number
  closedUnchecked: number
  closedDead: number
  closedPolicy: number
  closedSlow: number
  closedStopping: number
  closedVersionNewer: number
  closedOutdated: number
  closedError: number
  // (socket, topic) pairs dropped, by path.
  dropped: Record<RevocationPath, number>
  // Resubscribed topics, by how they resumed.
  resume: Record<ResumeOutcome, number>
  // Droppable frames shed, and topics answered retry.
  shed: number
  retried: number
}

export interface SocketServer {
  // Closes every open socket of these sessions with 4401, and returns how many (§8.1). Publishers
  // name only sessions that have ended, so nothing is read; each session is refused at upgrade for
  // the next 60 s, and each person with a socket left here is re-checked.
  closeSessions(sessionIds: readonly string[], trigger: Trigger): number
  // People whose access changed: re-checked against Postgres in the lane, and re-checked again
  // after any accept or subscribe decided before the signal arrived (§8.1, §8.2).
  peopleChanged(orgId: string, people: readonly string[], trigger: Trigger): void
  // Tells every socket of the org that has said hello to re-read something (droppable; coalesced
  // on its trailing edge, P4).
  nudge(orgId: string, what: GatewayNudge): void
  counts(): SocketCounts
  // For readiness (realtime/index.ts): whether the server is stopping, whether the last two
  // periodic checks that had sockets to check both failed, and whether the stream reader is stuck.
  stopping(): boolean
  checksFailing(): boolean
  readerStuck(): boolean
}

// The policy and timings the gateway runs with.
function timings(options: SocketServerOptions) {
  const policy = gatewayPolicy({
    ...options.policy,
    ...(options.lookupTimeoutMs === undefined ? {} : { lookupTimeoutMs: options.lookupTimeoutMs }),
  })
  const recheckTimeoutMs = options.recheckTimeoutMs ?? Math.min(options.recheckMs, policy.recheckTimeoutMs)
  const revokeWithinMs = options.revokeWithinMs ?? SOCKET_REVOKE_MS
  // Even with every check answering, a session that ends just after one is found only by the next,
  // which settles within recheckMs + recheckTimeoutMs: timings that can't keep revokeWithinMs are
  // refused at start.
  if (options.recheckMs + recheckTimeoutMs >= revokeWithinMs) {
    throw new Error('the socket re-check interval plus its deadline must be shorter than revokeWithinMs')
  }
  return { policy: { ...policy, recheckTimeoutMs }, recheckTimeoutMs, revokeWithinMs }
}

// The session lookups' slots (M1): at most `max` at once and `waiting` queued. A slot is held until
// release(), which the upgrade calls when the lookup itself settles, however the upgrade was
// answered, so lookups abandoned on a slow database never take more than `max` connections.
class LookupSlots {
  running = 0
  readonly #max: number
  readonly #maxWaiting: number
  readonly #waiting: { start: () => void }[] = []

  constructor(max: number, maxWaiting: number) {
    this.#max = max
    this.#maxWaiting = maxWaiting
  }

  // Resolves true once a slot is taken, false if none came free within ms; undefined at once when
  // the queue is full.
  take(ms: number): Promise<boolean> | undefined {
    if (this.running < this.#max && this.#waiting.length === 0) {
      this.running++
      return Promise.resolve(true)
    }
    if (this.#waiting.length >= this.#maxWaiting) return undefined
    return new Promise(resolve => {
      const waiter = {
        start: () => {
          clearTimeout(timer)
          this.running++
          resolve(true)
        },
      }
      const timer = setTimeout(
        () => {
          const at = this.#waiting.indexOf(waiter)
          if (at >= 0) this.#waiting.splice(at, 1)
          resolve(false)
        },
        Math.max(1, ms),
      )
      this.#waiting.push(waiter)
    })
  }

  release(): void {
    this.running--
    this.#waiting.shift()?.start()
  }

  waiting(): number {
    return this.#waiting.length
  }
}

// A check's view of some sockets, taken when it starts: each socket, and the generation of each
// topic it held, so what the check finds applies only to the entries it asked about (S2).
interface Snapshot {
  conns: { conn: Conn; topics: Map<string, number> }[]
  request: CheckRequest
}

function inner(map: Map<string, Set<string>>, key: string): Set<string> {
  let set = map.get(key)
  if (set === undefined) {
    set = new Set()
    map.set(key, set)
  }
  return set
}

function snapshot(conns: Iterable<Conn>): Snapshot {
  const taken: Snapshot['conns'] = []
  const sessions = new Set<string>()
  const topics = new Map<string, Set<string>>()
  const held = new Map<string, Set<string>>()
  for (const conn of conns) {
    if (!isOpen(conn)) continue
    const person = conn.session.userId
    sessions.add(conn.session.sessionId)
    const gens = new Map<string, number>()
    for (const [topic, entry] of conn.topics) {
      gens.set(topic, entry.gen)
      inner(topics, person).add(topic)
      if (entry.state !== 'deciding') inner(held, person).add(topic)
    }
    taken.push({ conn, topics: gens })
  }
  return { conns: taken, request: { sessions: [...sessions], topics, held } }
}

export function attachSocketServer(app: FastifyInstance, options: SocketServerOptions): SocketServer {
  const { appOrigin, logger } = options
  const { policy, recheckTimeoutMs, revokeWithinMs } = timings(options)
  const now = () => performance.now()
  const latency = options.latency
  // The gateway tracks its own sockets, so ws adds no close listener of its own (P9).
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: policy.maxFrameBytes,
    perMessageDeflate: false,
    clientTracking: false,
  })

  // Every open socket, and the indexes: by session, by `<org>:<person>`, by org, and by org and
  // topic (replaying and live topics only: the reader's dispatch reads it).
  const conns = new Set<Conn>()
  const bySession = new Map<string, Set<Conn>>()
  const byPerson = new Map<string, Set<Conn>>()
  const byOrg = new Map<string, Set<Conn>>()
  const byTopic = new Map<string, Map<string, Set<Conn>>>()
  const add = <K>(index: Map<K, Set<Conn>>, key: K, conn: Conn) => {
    const set = index.get(key)
    if (set === undefined) index.set(key, new Set([conn]))
    else set.add(conn)
  }
  const remove = <K>(index: Map<K, Set<Conn>>, key: K, conn: Conn) => {
    const set = index.get(key)
    set?.delete(conn)
    if (set?.size === 0) index.delete(key)
  }
  const liveOf = (set: Set<Conn> | undefined): Conn[] => [...(set ?? [])].filter(isOpen)

  // The races (T19 item 6): sessions named on either channel or found ended, refused at upgrade for
  // recentlyRevokedMs (insertion order is arrival order, so the oldest go first); and each person
  // whose keys changed, with when the signal arrived and what it was, for keysChangedMs. Each keeps
  // at most recentlyRevokedMax entries.
  const recentlyRevoked = new Map<string, number>()
  const keysChanged = new Map<string, { at: number; label: Label }>()
  function revoked(sessionId: string): void {
    recentlyRevoked.delete(sessionId)
    recentlyRevoked.set(sessionId, now())
    if (recentlyRevoked.size > policy.recentlyRevokedMax) {
      const oldest = recentlyRevoked.keys().next()
      if (!oldest.done) recentlyRevoked.delete(oldest.value)
    }
  }
  function keysChangedNow(key: string, label: Label): void {
    keysChanged.delete(key)
    keysChanged.set(key, { at: now(), label })
    if (keysChanged.size > policy.recentlyRevokedMax) {
      const oldest = keysChanged.keys().next()
      if (!oldest.done) keysChanged.delete(oldest.value)
    }
  }
  function prune(): void {
    const t = now()
    for (const [id, at] of recentlyRevoked) {
      if (t - at <= policy.recentlyRevokedMs) break
      recentlyRevoked.delete(id)
    }
    for (const [key, changed] of keysChanged) {
      if (t - changed.at <= policy.keysChangedMs) break
      keysChanged.delete(key)
    }
  }

  const refused = zero(REFUSAL_NAMES)
  let refusalsLogged = zero(REFUSAL_NAMES)
  let refusalsLoggedAt = Date.now()
  const closes = zero(CLOSES)
  const dropped = zero<RevocationPath>(['push', 'durable', 'recheck'])
  const resume = zero(RESUME_OUTCOMES)
  let shed = 0
  let retried = 0
  let stopping = false
  // Periodic checks in a row that had sockets to check and failed (OD-22).
  let failedChecks = 0

  const slots = new LookupSlots(policy.lookupsRunning, policy.lookupsWaiting)
  const lane = new DecisionLane({ check: options.check, policy, logger })
  const replays = new ReplayQueue(policy)
  // How many times each org's stream has been reset (a replay that spans one answers reset).
  const resets = new Map<string, number>()

  const target: StreamTarget<Conn> = {
    orgsWithSockets: () => byOrg.keys(),
    byTopic: (orgId, topic) => byTopic.get(orgId)?.get(topic) ?? [],
    holdOf: (conn, topic) => conn.topics.get(topic),
    send: (conn, text) => send(conn, text),
    resetOrg,
  }
  const stream = options.stream?.(target) ?? NO_STREAM

  function refuse(socket: Duplex, reason: Refusal): void {
    refused[reason]++
    const { status, error } = REFUSALS[reason]
    logger.debug({ event: 'ws_refused', reason, status })
    if (!socket.writable) {
      socket.destroy()
      return
    }
    const body = JSON.stringify({ error })
    // As ws answers a refused handshake: end() sends the answer, and the socket goes once it has.
    socket.once('finish', () => socket.destroy())
    socket.end(
      `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\n` +
        'Connection: close\r\n' +
        'Cache-Control: no-store\r\n' +
        'Content-Type: application/json\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    )
  }

  // The lookup, within what is left of lookupTimeoutMs from the upgrade's arrival, queue time
  // included. The slot it took is freed only when the lookup itself settles (M1).
  async function lookupWithin(tokenHash: Buffer, arrivedAt: number): Promise<SessionIds | undefined | 'timed out'> {
    const left = () => Math.max(1, arrivedAt + policy.lookupTimeoutMs - now())
    const lookup = Promise.resolve().then(() => options.lookup(tokenHash))
    lookup.then(
      () => slots.release(),
      () => slots.release(),
    )
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<'timed out'>(resolve => {
      timer = setTimeout(() => resolve('timed out'), left())
    })
    try {
      // A lookup that settles after the timer is still handled here, so its rejection is never
      // unhandled.
      return await Promise.race([lookup, timedOut])
    } finally {
      clearTimeout(timer)
    }
  }

  async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const arrivedAt = now()
    // First, before anything can wait: Node takes its own error listener off the socket when it
    // emits 'upgrade', so a client that resets now would raise an uncaught ECONNRESET.
    const onSocketError = () => socket.destroy()
    socket.on('error', onSocketError)
    if (stopping) return refuse(socket, 'error')
    if (pathOf(request.url) !== SOCKET_PATH) return refuse(socket, 'path')
    // A missing Origin, "null", the user-content origin and any other origin are all refused,
    // before anything is looked up.
    if (!isAppOrigin(request.headers.origin, appOrigin)) return refuse(socket, 'origin')
    const token = readCookie(request.headers.cookie, SESSION_COOKIE)
    if (token === undefined) return refuse(socket, 'session')
    // A fast path only: the same cap is checked again in the tick that opens the socket (S3).
    if (conns.size >= policy.maxSocketsPerProcess) return refuse(socket, 'full')

    const slot = slots.take(policy.lookupTimeoutMs)
    if (slot === undefined) return refuse(socket, 'full')
    if (!(await slot)) {
      logger.warn({ event: 'ws_lookup_timed_out', queued: true }, 'session lookup timed out')
      return refuse(socket, 'error')
    }
    let session: SessionIds | undefined | 'timed out'
    try {
      session = await lookupWithin(sha256(token), arrivedAt)
    } catch (error) {
      logger.warn({ event: 'ws_lookup_failed', failure: failureFields(error) }, 'session lookup failed')
      return refuse(socket, 'error')
    }
    // The client went away while the session was looked up.
    if (socket.destroyed) return
    if (session === 'timed out') {
      logger.warn({ event: 'ws_lookup_timed_out' }, 'session lookup timed out')
      return refuse(socket, 'error')
    }
    if (session === undefined) return refuse(socket, 'session')

    // From the lookup's answer to the open, one synchronous block with nothing awaited (S3, m1): a
    // revocation handled during the lookup is seen here, and no other upgrade can pass a cap before
    // this one is counted.
    if (stopping) return refuse(socket, 'error')
    if (recentlyRevoked.has(session.sessionId)) return refuse(socket, 'session')
    if (conns.size >= policy.maxSocketsPerProcess) return refuse(socket, 'full')
    if ((bySession.get(session.sessionId)?.size ?? 0) >= SOCKETS_PER_SESSION) return refuse(socket, 'busySession')
    const person = `${session.orgId}:${session.userId}`
    if ((byPerson.get(person)?.size ?? 0) >= policy.maxSocketsPerPerson) return refuse(socket, 'busyPerson')
    // ws adds its own error listener. handleUpgrade calls back in this same tick (there's no
    // verifyClient, and no permessage-deflate to negotiate).
    socket.removeListener('error', onSocketError)
    const ids = session
    wss.handleUpgrade(request, socket, head, ws => accept(ws, ids, arrivedAt))
  }

  function accept(ws: WebSocket, session: SessionIds, askedAt: number): void {
    const conn = newConn(ws, session, now(), askedAt, policy.frameBurst)
    // A frame over 4 KiB, or any other protocol error: ws has already sent its close (1009, or 1002
    // or 1007) and stopped reading, so the socket is only marked closing and cut after the grace,
    // and the client usually sees the real code (P7). Without a listener the error would be thrown,
    // and end the process.
    ws.on('error', error => {
      const code = (error as { code?: unknown }).code
      logger.debug({ event: 'ws_error', socket: conn.id, code: typeof code === 'string' ? code : undefined })
      if (conn.closing) return
      conn.closing = true
      closes.error++
      cutLater(conn)
    })
    conns.add(conn)
    add(bySession, session.sessionId, conn)
    add(byPerson, conn.person, conn)
    add(byOrg, session.orgId, conn)
    ws.on('message', (data, isBinary) => frames.message(conn, data, isBinary))
    ws.on('pong', () => {
      conn.lastSeen = now()
    })
    // The socket's one close listener: out of every index, and every topic generation ends.
    ws.once('close', () => {
      conn.closing = true
      clearTimeout(conn.closeTimer)
      clearTimeout(conn.helloTimer)
      conns.delete(conn)
      remove(bySession, session.sessionId, conn)
      remove(byPerson, conn.person, conn)
      remove(byOrg, session.orgId, conn)
      for (const topic of conn.topics.keys()) unindex(conn, topic)
      conn.topics.clear()
      conn.closed()
    })
    frames.opened(conn)
    logger.debug({ event: 'ws_open', socket: conn.id, sessionId: session.sessionId })
    stream.watch(session.orgId)
    // A people signal that arrived since the upgrade did, or C0.9's check at accept (§8.2).
    const changed = keysChanged.get(conn.person)
    if (changed !== undefined && changed.at >= askedAt) targeted.queue(session.orgId, session.userId, changed.label)
    else if (options.admission === true) targeted.queue(session.orgId, session.userId, { path: 'recheck' })
  }

  function cutLater(conn: Conn): void {
    clearTimeout(conn.helloTimer)
    clearTimeout(conn.closeTimer)
    conn.closeTimer = setTimeout(() => conn.ws.terminate(), Math.max(1, policy.closeGraceMs))
  }

  // Closes the socket with this close, once (P9): later calls do nothing, so a socket that keeps
  // getting frames is closed and counted once and never gathers listeners. It is cut if the client
  // hasn't finished the closing handshake within closeGraceMs. False if it was already closing.
  function closeConn(conn: Conn, close: GatewayClose, counter: CloseCounter): boolean {
    if (!isOpen(conn)) return false
    conn.closing = true
    closes[counter]++
    const { code, reason } = GATEWAY_CLOSE[close]
    conn.ws.close(code, reason)
    cutLater(conn)
    return true
  }

  function send(conn: Conn, text: string, droppable = false): void {
    const result = sendFrame(conn, text, droppable, policy, now())
    if (result === 'shed') shed++
    else if (result === 'too_slow') closeConn(conn, 'tooSlow', 'slow')
  }

  function index(conn: Conn, topic: string): void {
    let topics = byTopic.get(conn.session.orgId)
    if (topics === undefined) {
      topics = new Map()
      byTopic.set(conn.session.orgId, topics)
    }
    add(topics, topic, conn)
  }

  function unindex(conn: Conn, topic: string): void {
    const topics = byTopic.get(conn.session.orgId)
    if (topics === undefined) return
    remove(topics, topic, conn)
    if (topics.size === 0) byTopic.delete(conn.session.orgId)
  }

  const counterOf = (path: RevocationPath): CloseCounter =>
    path === 'push' ? 'revoked' : path === 'durable' ? 'durable' : 'recheck'
  const sourceOf = (path: RevocationPath, at: number | undefined): StartSource =>
    at === undefined ? 'unknown' : path === 'push' ? 'publisher' : 'database'

  function record(
    handler: 'sockets' | 'topics',
    label: Label,
    cause: string,
    orgId: string,
    count: number,
    startedAt: number | undefined,
    startSource: StartSource,
  ): void {
    latency?.record({ handler, path: label.path, cause, orgId, count, startedAt, startSource, appliedAt: Date.now() })
  }

  // §8.1: the revocation channels' sessions.
  function closeSessions(sessionIds: readonly string[], trigger: Trigger): number {
    const label: Label = { path: trigger.path, cause: trigger.cause }
    const counter = counterOf(trigger.path)
    const closedIn = new Map<string, number>()
    const people = new Map<string, Conn>()
    let sessions = 0
    let sockets = 0
    for (const sessionId of new Set(sessionIds)) {
      revoked(sessionId)
      let any = false
      for (const conn of liveOf(bySession.get(sessionId))) {
        if (!closeConn(conn, 'signedOut', counter)) continue
        any = true
        sockets++
        closedIn.set(conn.session.orgId, (closedIn.get(conn.session.orgId) ?? 0) + 1)
        people.set(conn.person, conn)
      }
      if (any) sessions++
    }
    if (sockets === 0) return 0
    logger.info({ event: 'ws_closed', cause: counter, sessions, sockets })
    for (const [orgId, count] of closedIn) {
      record('sockets', label, trigger.cause, orgId, count, trigger.at, sourceOf(trigger.path, trigger.at))
    }
    // The person's other sessions, and their topics, are re-checked (§8.1 step 3).
    for (const [key, conn] of people) {
      if (liveOf(byPerson.get(key)).length > 0) targeted.queue(conn.session.orgId, conn.session.userId, label)
    }
    return sockets
  }

  function peopleChanged(orgId: string, people: readonly string[], trigger: Trigger): void {
    const label: Label = { path: trigger.path, cause: trigger.cause }
    for (const person of new Set(people)) {
      const key = `${orgId}:${person}`
      keysChangedNow(key, label)
      if (liveOf(byPerson.get(key)).length > 0) targeted.queue(orgId, person, label)
    }
  }

  // Closes the sockets of sessions a check found ended, with 4401, and records each person's
  // closes from the earliest time their sessions ended.
  function closeEnded(orgId: string, ended: ReadonlyMap<string, number | undefined>, label: Label): void {
    const byPersonClosed = new Map<string, { count: number; startedAt: number | undefined; unknown: boolean }>()
    let sessions = 0
    let sockets = 0
    for (const [sessionId, endedAt] of ended) {
      revoked(sessionId)
      let any = false
      for (const conn of liveOf(bySession.get(sessionId))) {
        if (!closeConn(conn, 'signedOut', counterOf(label.path))) continue
        any = true
        sockets++
        const closed = byPersonClosed.get(conn.person) ?? { count: 0, startedAt: undefined, unknown: false }
        closed.count++
        if (endedAt === undefined) closed.unknown = true
        else closed.startedAt = Math.min(closed.startedAt ?? endedAt, endedAt)
        byPersonClosed.set(conn.person, closed)
      }
      if (any) sessions++
    }
    if (sockets === 0) return
    logger.info({ event: 'ws_closed', cause: counterOf(label.path), sessions, sockets })
    const cause = label.cause ?? 'ended'
    for (const closed of byPersonClosed.values()) {
      const source: StartSource = closed.startedAt === undefined ? 'unknown' : 'database'
      record('sockets', label, cause, orgId, closed.count, closed.startedAt, source)
    }
  }

  function closeNotAdmitted(conns: Iterable<Conn>): number {
    let closed = 0
    for (const conn of conns) if (closeConn(conn, 'noticeRequired', 'notAdmitted')) closed++
    if (closed > 0) logger.info({ event: 'ws_closed', cause: 'notAdmitted', sockets: closed })
    return closed
  }

  // Drops these topics from the socket, with one dropped frame (Rule 6). Answers how many had been
  // granted (replaying or live): a deciding topic was never held, so its drop is no revocation.
  function dropTopics(conn: Conn, topics: readonly string[], label: Label): number {
    let granted = 0
    const gone: string[] = []
    for (const topic of topics) {
      const entry = conn.topics.get(topic)
      if (entry === undefined) continue
      conn.topics.delete(topic)
      unindex(conn, topic)
      gone.push(topic)
      if (entry.state !== 'deciding') granted++
    }
    if (gone.length === 0) return 0
    dropped[label.path] += gone.length
    send(conn, JSON.stringify({ v: conn.version ?? GATEWAY_VERSIONS[0], t: 'dropped', topics: gone, reason: 'access' }))
    return granted
  }

  // What a check found, applied to the sockets it asked about (§7.5): ended sessions close with
  // 4401, people not admitted with 4403, lost topics are dropped, and the rest is confirmed as of the
  // check's start.
  function apply(
    orgId: string,
    taken: Snapshot,
    result: CheckResult,
    labelOf: (person: string) => Label,
    startedAt: number,
  ): void {
    // Grouped by label, so each is one ws_closed line.
    const endedBy = new Map<string, { label: Label; ended: Map<string, number | undefined> }>()
    for (const { conn } of taken.conns) {
      const session = result.sessions.get(conn.session.sessionId)
      if (session === undefined || session.live) continue
      const label = labelOf(conn.session.userId)
      const key = `${label.path} ${label.cause ?? ''}`
      let group = endedBy.get(key)
      if (group === undefined) {
        group = { label, ended: new Map() }
        endedBy.set(key, group)
      }
      group.ended.set(conn.session.sessionId, session.endedAt)
    }
    for (const { label, ended } of endedBy.values()) closeEnded(orgId, ended, label)
    closeNotAdmitted(taken.conns.filter(({ conn }) => result.notAdmitted.has(conn.session.userId)).map(t => t.conn))

    const lostByPerson = new Map<string, { count: number; startedAt: number | undefined }>()
    for (const { conn, topics } of taken.conns) {
      if (!isOpen(conn)) continue
      const person = conn.session.userId
      if (result.sessions.get(conn.session.sessionId)?.live === true) {
        conn.sessionConfirmedAt = Math.max(conn.sessionConfirmedAt, startedAt)
      }
      const decided = result.topics.get(person)
      if (decided === undefined) continue
      const lost: string[] = []
      for (const [topic, gen] of topics) {
        const entry = conn.topics.get(topic)
        if (entry === undefined || entry.gen !== gen) continue
        const allowed = decided.get(topic)
        if (allowed === false) lost.push(topic)
        else if (allowed === true && entry.state !== 'deciding') {
          entry.confirmedAt = Math.max(entry.confirmedAt, startedAt)
        }
      }
      if (lost.length === 0) continue
      const lostAt = result.lostAt.get(person)
      const granted = lost.filter(topic => conn.topics.get(topic)?.state !== 'deciding')
      const count = dropTopics(conn, lost, labelOf(person))
      if (count === 0) continue
      const known = granted.map(topic => lostAt?.get(topic)).filter((at): at is number => at !== undefined)
      const sum = lostByPerson.get(person) ?? { count: 0, startedAt: undefined }
      sum.count += count
      if (known.length > 0) sum.startedAt = Math.min(sum.startedAt ?? Number.POSITIVE_INFINITY, ...known)
      lostByPerson.set(person, sum)
    }
    for (const [person, lost] of lostByPerson) {
      const label = labelOf(person)
      const source: StartSource = lost.startedAt === undefined ? 'unknown' : 'database'
      record('topics', label, label.cause ?? 'keys_changed', orgId, lost.count, lost.startedAt, source)
    }
  }

  // Targeted re-checks (§8.3): each org's people, in the lane, labelled with their trigger. One that
  // fails closes nothing: the periodic check is the guarantee.
  const targeted = new TargetedQueue<Label>(
    (orgId, people) => {
      const taken = snapshot([...people.keys()].flatMap(person => liveOf(byPerson.get(`${orgId}:${person}`))))
      if (taken.conns.length === 0) return
      const startedAt = now()
      lane.decide(orgId, taken.request).then(
        result => apply(orgId, taken, result, person => people.get(person) ?? { path: 'recheck' }, startedAt),
        error => {
          logger.warn(
            {
              event: 'ws_recheck_failed',
              scope: 'people',
              org: orgId,
              people: people.size,
              failure: failureFields(error),
            },
            'could not re-check the people a revocation named',
          )
        },
      )
    },
    { delayMs: policy.targetedDelayMs, max: policy.decisionBatchMax },
  )

  // The stream lost continuity (§5.5): every socket of the org that has said hello is told at once.
  function resetOrg(orgId: string, position: Position): void {
    resets.set(orgId, (resets.get(orgId) ?? 0) + 1)
    for (const conn of liveOf(byOrg.get(orgId))) {
      if (conn.version === undefined) continue
      send(conn, JSON.stringify({ v: conn.version, t: 'reset', pos: position }))
    }
  }

  const nudger = new Nudger(
    (orgId, what) => {
      for (const conn of liveOf(byOrg.get(orgId))) {
        if (conn.version === undefined) continue
        send(conn, JSON.stringify({ v: conn.version, t: 'nudge', what }), true)
      }
    },
    policy.nudgeCoalesceMs,
    now,
  )

  const spreadMs = () => reconnectSpreadMs(conns.size, policy)

  const context: FrameContext = {
    policy,
    versions: options.versions ?? GATEWAY_VERSIONS,
    now,
    spreadMs,
    send: (conn, text, o) => send(conn, text, o?.droppable === true),
    close: (conn, close, counter) => {
      closeConn(conn, close, counter)
    },
    index,
    unindex,
    decide: (conn, request) => lane.decide(conn.session.orgId, request),
    sessionEnded: (conn, endedAt) =>
      closeEnded(conn.session.orgId, new Map([[conn.session.sessionId, endedAt]]), { path: 'recheck' }),
    notAdmitted: conn => {
      closeNotAdmitted(liveOf(byPerson.get(conn.person)))
    },
    recheckIfChanged: (conn, askedAt) => {
      const changed = keysChanged.get(conn.person)
      if (changed !== undefined && changed.at >= askedAt) {
        targeted.queue(conn.session.orgId, conn.session.userId, changed.label)
      }
    },
    position: orgId => stream.position(orgId),
    current: orgId => stream.current(orgId),
    resets: orgId => resets.get(orgId) ?? 0,
    replay: (conn, work) => replays.run(conn, work),
    plan: (orgId, request, current) => {
      if (options.resume === undefined) {
        const outcomes = new Map(request.topics.map(topic => [topic, 'reset_epoch' as ResumeOutcome]))
        return Promise.resolve({ outcomes, frames: [] })
      }
      return options.resume(orgId, request, current)
    },
    retried: topics => {
      retried += topics
    },
    resumed: (outcome, topics) => {
      resume[outcome] += topics
    },
    failed: (conn, error) => {
      logger.error({ event: 'ws_frame_failed', failure: failureFields(error) }, 'a frame handler failed')
      closeConn(conn, 'internalError', 'error')
    },
  }
  const frames = new Frames(context)

  // Logs the refusals since the last summary, at most once a minute and only when there were some.
  function logRefusals(): void {
    const t = Date.now()
    if (t - refusalsLoggedAt < REFUSAL_LOG_MS) return
    refusalsLoggedAt = t
    const since = zero(REFUSAL_NAMES)
    for (const reason of REFUSAL_NAMES) since[reason] = refused[reason] - refusalsLogged[reason]
    refusalsLogged = { ...refused }
    if (REFUSAL_NAMES.some(reason => since[reason] > 0)) {
      logger.info({ event: 'ws_refused', ...since }, 'refused WebSocket upgrades in the last minute')
    }
  }

  // The earliest time any socket's session, or a topic it holds granted, was last confirmed.
  function oldestConfirmed(conn: Conn): number {
    let oldest = conn.sessionConfirmedAt
    for (const entry of conn.topics.values()) {
      if (entry.state !== 'deciding') oldest = Math.min(oldest, entry.confirmedAt)
    }
    return oldest
  }

  // After a failed check (§7.5): closes every socket whose session, or one of whose granted topics,
  // would go unconfirmed past revokeWithinMs if the next check failed too. Such a session or topic
  // may have been lost since it was last confirmed, with every message about it lost, and only a
  // check would find out. The next check settles within recheckMs + recheckTimeoutMs from now.
  function closeUnconfirmed(): void {
    const confirmedBy = now() + options.recheckMs + recheckTimeoutMs - revokeWithinMs
    let closed = 0
    for (const conn of conns) {
      if (oldestConfirmed(conn) < confirmedBy && closeConn(conn, 'tryAgain', 'unchecked')) closed++
    }
    if (closed > 0) logger.info({ event: 'ws_closed', cause: 'unchecked', sockets: closed })
  }

  // The periodic check (§7.5): every open socket's session, admission and topics, one org at a time,
  // all within recheckTimeoutMs. One run at a time; a tick that finds the last still going is
  // skipped. A failed check closes nothing as signed out, since Postgres being down isn't a
  // revocation: it closes only what closeUnconfirmed names, and the next tick tries again. An org
  // with no system principal can't be checked: its sockets close with 1013, never 4401, since its
  // sessions may be live (OD-37).
  let checking = false
  async function recheck(): Promise<void> {
    if (checking) return
    checking = true
    let timer: NodeJS.Timeout | undefined
    try {
      const orgs = [...byOrg].map(([orgId, set]) => [orgId, liveOf(set)] as const).filter(([, list]) => list.length > 0)
      if (orgs.length === 0) {
        failedChecks = 0
        return
      }
      const startedAt = now()
      const timedOut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('the re-check timed out')), Math.max(1, recheckTimeoutMs))
      })
      // Handled here even if nothing races it any more.
      timedOut.catch(() => {})
      try {
        for (const [orgId, list] of orgs) {
          const taken = snapshot(list)
          let result: CheckResult
          try {
            // A check that settles after the deadline is still handled, so its rejection is never
            // unhandled.
            result = await Promise.race([Promise.resolve().then(() => options.check(orgId, taken.request)), timedOut])
          } catch (error) {
            if (!(error instanceof NoSystemPrincipal)) throw error
            logger.error({ event: 'ws_recheck_no_system_principal', org: orgId }, 'closing the sockets of an org')
            let closed = 0
            for (const { conn } of taken.conns) if (closeConn(conn, 'tryAgain', 'unchecked')) closed++
            if (closed > 0) logger.info({ event: 'ws_closed', cause: 'unchecked', sockets: closed })
            continue
          }
          apply(orgId, taken, result, () => ({ path: 'recheck' }), startedAt)
        }
        failedChecks = 0
      } catch (error) {
        failedChecks++
        logger.error(
          { event: 'ws_recheck_failed', failures: failedChecks, failure: failureFields(error) },
          'could not re-check the open sockets',
        )
        closeUnconfirmed()
      }
    } finally {
      clearTimeout(timer)
      checking = false
    }
  }

  // The heartbeat sweep (T19 item 12): a protocol ping heartbeatMs after the last, and a socket
  // heard from by neither pong nor frame for deadAfterMs is cut.
  function sweep(): void {
    const t = now()
    for (const conn of conns) {
      if (!isOpen(conn)) continue
      if (t - conn.lastSeen > policy.deadAfterMs) {
        conn.closing = true
        closes.dead++
        logger.debug({ event: 'ws_dead', socket: conn.id })
        conn.ws.terminate()
        continue
      }
      if (t - conn.lastPing >= policy.heartbeatMs) {
        conn.lastPing = t
        conn.ws.ping()
      }
    }
  }

  let gaugesSkipped = false
  // Every metricsMs: the latency summary, and the gauges while there are sockets (once every other
  // time otherwise, so once a minute).
  function metrics(): void {
    latency?.summarise()
    if (conns.size === 0 && !gaugesSkipped) {
      gaugesSkipped = true
      return
    }
    gaugesSkipped = false
    const t = now()
    let topics = 0
    let oldest = Number.POSITIVE_INFINITY
    for (const conn of conns) {
      topics += conn.topics.size
      if (isOpen(conn)) oldest = Math.min(oldest, oldestConfirmed(conn))
    }
    const oldestUnconfirmedMs = Number.isFinite(oldest) ? Math.max(0, Math.round(t - oldest)) : 0
    const level =
      oldestUnconfirmedMs > policy.latencyErrorMs
        ? 'error'
        : oldestUnconfirmedMs > policy.unconfirmedWarnMs
          ? 'warn'
          : 'info'
    const replaysNow = replays.counts()
    logger[level](
      {
        event: 'gateway_gauges',
        sockets: conns.size,
        topics,
        orgs: byOrg.size,
        oldestUnconfirmedMs,
        readerLagMs: Math.round(stream.lagMs()),
        recentlyRevoked: recentlyRevoked.size,
        reconnectSpreadMs: spreadMs(),
        lookupsRunning: slots.running,
        lookupsWaiting: slots.waiting(),
        decisionsWaiting: lane.waiting() + targeted.size(),
        replaysRunning: replaysNow.running,
        replaysWaiting: replaysNow.waiting,
        shed,
        retried,
        refused: { ...refused },
        resume: { ...resume },
        closes: { ...closes },
        dropped: { ...dropped },
        longestLatencyMs: latency?.oldest() ?? null,
      },
      'gateway gauges',
    )
  }

  const timers = [
    setInterval(() => {
      logRefusals()
      prune()
      void recheck()
    }, options.recheckMs),
    setInterval(sweep, policy.heartbeatSweepMs),
    setInterval(metrics, policy.metricsMs),
  ]
  for (const timer of timers) timer.unref()
  stream.start()

  app.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    upgrade(request, socket, head).catch(error => {
      // Nothing above should throw; if something does, this socket goes and the process stays.
      logger.error({ event: 'ws_upgrade_failed', failure: failureFields(error) }, 'WebSocket upgrade failed')
      socket.destroy()
    })
  })

  // The drain (§9), before Fastify closes the HTTP server, which would otherwise wait for every open
  // socket: refuse upgrades, stop the timers, the lane and the reader, flush the metrics, close every
  // socket with 1001 (cut after closeGraceMs), then stop ws.
  app.addHook('preClose', async () => {
    stopping = true
    for (const timer of timers) clearInterval(timer)
    targeted.stop()
    lane.stop()
    nudger.stop()
    // The reader's loop ends after its current XREAD, at most a block; main.ts closes its connection,
    // which ends that at once.
    void stream.stop()
    latency?.summarise()
    latency?.stop()
    const open = [...conns]
    for (const conn of open) closeConn(conn, 'stopping', 'stopping')
    await Promise.race([
      Promise.all(open.map(conn => conn.done)),
      delay(policy.closeGraceMs + 500, undefined, { ref: false }),
    ])
    await Promise.race([
      new Promise<void>(resolve => wss.close(() => resolve())),
      delay(policy.closeGraceMs, undefined, { ref: false }),
    ])
  })

  return {
    closeSessions,
    peopleChanged,
    nudge: (orgId, what) => nudger.nudge(orgId, what),
    counts: () => {
      let topics = 0
      for (const conn of conns) topics += conn.topics.size
      return {
        open: conns.size,
        topics,
        refused: { ...refused },
        closedRevoked: closes.revoked,
        closedDurable: closes.durable,
        closedRecheck: closes.recheck,
        closedNotAdmitted: closes.notAdmitted,
        closedUnchecked: closes.unchecked,
        closedDead: closes.dead,
        closedPolicy: closes.policy,
        closedSlow: closes.slow,
        closedStopping: closes.stopping,
        closedVersionNewer: closes.versionNewer,
        closedOutdated: closes.outdated,
        closedError: closes.error,
        dropped: { ...dropped },
        resume: { ...resume },
        shed,
        retried,
      }
    },
    stopping: () => stopping,
    checksFailing: () => failedChecks >= 2,
    readerStuck: () => stream.stuck(),
  }
}
