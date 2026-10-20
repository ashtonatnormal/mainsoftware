// The live connection to the realtime gateway (T19 item 10, T21 item 4). It keeps
// the client's side of the protocol in packages/shared/src/gateway.ts, items 1–7 of its header,
// and knows nothing of React, Query or the browser: the socket class, the clock and the random
// source are passed in, so the tests drive every timer, and the session runtime
// (session/runtime.ts) wires what it hears to Query. A frame only ever says that something changed;
// what changed is fetched over REST, which checks access (T19 item 9).
//
// 1. Open: send hello naming every version this build speaks; read each frame leniently
//    (readServerFrame) and skip what doesn't read (P6). welcome fixes the version, and its limits
//    are kept as the smaller of each and this build's own (limitsFrom: welcome can lower them,
//    never raise them past what this build was tested with); every pong updates the spread. Until a
//    welcome the socket keeps this build's limits, a 25 s heartbeat and a 30 s spread (the server's
//    widest). A welcome in a version this build doesn't speak means a newer server: onOutdated. No
//    welcome within 15 s of opening (a proxy that upgraded while realtime hangs) is a failed try,
//    and so is a socket that hasn't opened 30 s after it was made (a connect that hangs).
// 2. Topics: what the views hold (hold(), which returns the release) is compared with what the
//    socket holds 250 ms after the first change, and the difference goes in one unsub, then sub
//    frames of at most 50 topics (and the frame's bytes) each, with at most 100 held. A release
//    lingers 3 s, so going back and forth sends nothing. An ack's ok topics are live and refetched
//    (onTopicStale); refused ones are forgotten and their cached data wiped (onTopicGone); retry
//    ones are sent again after 1–5 s, doubling to 30 s. Every frame takes a token from the
//    client's bucket (live/bucket.ts): a sub or unsub waits for one and is never dropped; a ping
//    that finds none is skipped.
// 3. Reconnect: after every welcome every held topic is subscribed again, and each acked ok is
//    refetched, which is how the client learns what changed while it was away.
// 4. ev: for a live topic, onTopicEvent and a refetch; for one whose sub isn't acked yet, nothing
//    (the fetch after its ack covers it).
// 5. dropped: forget each topic and wipe its cached data, whatever the reason. reset: refetch each
//    named live topic at a random time within the spread; a reset while that waits adds nothing,
//    one after it started asks again. nudge 'flags': onNudge within the spread, coalesced the same
//    way; a nudge this build doesn't know is ignored.
// 6. Heartbeat: a ping every heartbeatMs, and on visible() (the page shown, or back online) at
//    most one every 5 s. No frame within 10 s of a ping means the socket is dead: close it (4000)
//    and reconnect.
// 7. Closes: 4401 signs out (onSignedOut) and never reconnects. 4403 pauses with nothing wiped
//    (onNoticeRequired) until resume(). 4426 pauses (onOutdated: the runtime reloads). 1008 naming
//    abuse waits 30–60 s. Any other close of a socket that opened waits within the spread, once an
//    episode; every later failure, and every socket that never opened, waits full jitter from 1 s
//    to 30 s. 30 s into an episode the status is stalled, and probe() (GET /api/flags) runs at a
//    random point in the next 5 s and every 30 s after while it lasts; signed_out signs out. A
//    welcome ends the episode. While paused there is no socket to hear a 4401, so probe() runs at a
//    random point in the first 30 s and every 30 s after until resume(), and signed_out signs out
//    there too (T21 item 4).
//
// Known limit (T21 item 4): realtime refuses a session's 9th socket at the upgrade with 429, which
// the browser shows as a 1006 close, so a 9th tab retries and reads as stalled while its probe
// answers signed in.
import {
  type ClientFrame,
  GATEWAY_CLOSE,
  GATEWAY_LIMITS,
  GATEWAY_NUDGES,
  GATEWAY_PATH,
  GATEWAY_VERSIONS,
  type GatewayNudge,
  readServerFrame,
  type ServerFrameForClient,
  TOPIC_PATTERN,
} from '@hearth/shared'
import { abuseDelay, fullJitter, retryAckDelay, withinSpread } from './backoff.ts'
import { TokenBucket } from './bucket.ts'

export interface GatewayClock {
  now(): number
  set(fn: () => void, ms: number): number
  clear(id: number): void
}

// The part of the browser's WebSocket the client uses. The handlers take the DOM's event types,
// so the browser's own class fits as it is; the client reads only data, code and reason.
export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onerror: ((event: Event) => void) | null
}

// WebSocket.OPEN, without reading the global.
const OPEN = 1

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'stalled' | 'paused' | 'stopped'

export type ProbeAnswer = 'signed_in' | 'signed_out' | 'unknown'

export interface GatewayDeps {
  // wss://<this page's host>/ws (gatewayUrl): the same origin, so the session cookie goes with it.
  url: string
  WebSocket: new (url: string) => WebSocketLike
  clock: GatewayClock
  random(): number
  // Refetch the topic's data over REST: acked ok, (re)connected, a reset's or an ev's.
  onTopicStale(topic: string): void
  // Refused or dropped: it is forgotten here; wipe its cached server data.
  onTopicGone(topic: string): void
  onTopicEvent?(topic: string, type: string, ids: Readonly<Record<string, unknown>>): void
  // Already delayed within the spread and coalesced.
  onNudge(what: GatewayNudge): void
  // 4401, or a probe answering signed_out. The client has stopped.
  onSignedOut(): void
  // 4403: C0.9 shows the notice, then calls resume().
  onNoticeRequired(): void
  // 4426, or a welcome in a version this build doesn't speak.
  onOutdated(): void
  // GET /api/flags, to learn whether the session still holds (T19 item 11).
  probe(): Promise<ProbeAnswer>
  onStatus(status: LiveStatus): void
  // Where the client says what it refused to do (a topic past the limit, say); console.warn.
  warn?(message: string): void
}

export const CLIENT_POLICY = {
  // Under GATEWAY_LIMITS' 20 and 5, so the server's bucket never empties (T21 item 4).
  bucketBurst: 18,
  bucketPerSecond: 4,
  debounceMs: 250,
  lingerMs: 3_000,
  visiblePingMinMs: 5_000,
  stalledAfterMs: 30_000,
  probeWindowMs: 5_000,
  probeEveryMs: 30_000,
  // From open: the server's hello limit and 5 s more, for a proxy that upgrades while realtime
  // hangs.
  welcomeTimeoutMs: GATEWAY_LIMITS.helloTimeoutMs + 5_000,
  // From the socket's creation to its open (T21 item 4, a default for the owner): a connect that
  // hangs is let go and tried again, since a browser may take minutes to fail it. 30 s gives a slow
  // link's handshake twice the welcome's 15 s, and is when a first try's episode reads as stalled.
  connectTimeoutMs: 30_000,
  // The server's widest spread (apps/server/src/realtime/policy.ts, spreadMaxMs), used until a
  // welcome names the real one.
  spreadBeforeWelcomeMs: 30_000,
  // The shortest heartbeat a welcome may ask for, so a bad value can't make a ping loop.
  heartbeatMinMs: 1_000,
  // The code and reasons the client closes with itself (4000–4999 are the application's).
  closeCode: 4000,
} as const

// The closes that name abuse, which wait 30–60 s.
const ABUSE = new Set<string>([
  GATEWAY_CLOSE.badFrame.reason,
  GATEWAY_CLOSE.tooManyFrames.reason,
  GATEWAY_CLOSE.tooManyTopics.reason,
])

// The limits one socket keeps (header item 1).
export interface SocketLimits {
  topicsPerFrame: number
  topicsPerSocket: number
  frameBytes: number
  heartbeatMs: number
  spreadMs: number
}

type Welcome = Extract<ServerFrameForClient, { t: 'welcome' }>
type Version = Welcome['v']

const clamp = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : max

// This build's limits, or the smaller of each and a welcome's. A frame always carries at least one
// topic, and the heartbeat is never under a second.
export function limitsFrom(
  welcome?: Pick<Welcome, 'maxTopicsPerFrame' | 'maxTopics' | 'maxFrameBytes' | 'heartbeatMs' | 'reconnectSpreadMs'>,
): SocketLimits {
  const own: SocketLimits = {
    topicsPerFrame: GATEWAY_LIMITS.maxTopicsPerFrame,
    topicsPerSocket: GATEWAY_LIMITS.maxTopicsPerSocket,
    frameBytes: GATEWAY_LIMITS.maxFrameBytes,
    heartbeatMs: GATEWAY_LIMITS.heartbeatMs,
    spreadMs: CLIENT_POLICY.spreadBeforeWelcomeMs,
  }
  if (welcome === undefined) return own
  return {
    topicsPerFrame: clamp(welcome.maxTopicsPerFrame, 1, own.topicsPerFrame),
    topicsPerSocket: clamp(welcome.maxTopics, 0, own.topicsPerSocket),
    frameBytes: clamp(welcome.maxFrameBytes, 0, own.frameBytes),
    heartbeatMs: clamp(welcome.heartbeatMs, CLIENT_POLICY.heartbeatMinMs, own.heartbeatMs),
    spreadMs: clamp(welcome.reconnectSpreadMs, 0, own.spreadMs),
  }
}

const clampSpread = (spreadMs: number) => clamp(spreadMs, 0, CLIENT_POLICY.spreadBeforeWelcomeMs)

// The gateway's URL on this page's own origin (OD-11: CloudFront sends /ws to the ALB on the same
// host), never a host of its own (WS-03).
export function gatewayUrl(location: Pick<Location, 'protocol' | 'host'>): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${location.host}${GATEWAY_PATH}`
}

// A frame's size on the wire: topics and codes are ASCII, but count bytes anyway.
const encoder = new TextEncoder()
const bytes = (text: string) => encoder.encode(text).length

// The largest frame id (gateway.ts: 1 to 1,000,000), which also sizes a frame before its id is known.
const ID_MAX = 1_000_000

// The welcome's version, when the frame is a welcome in a version this build doesn't speak.
function foreignWelcome(text: string): boolean {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return false
  }
  if (typeof value !== 'object' || value === null) return false
  const { t, v } = value as { t?: unknown; v?: unknown }
  return t === 'welcome' && typeof v === 'number' && !(GATEWAY_VERSIONS as readonly number[]).includes(v)
}

// Timers the client can clear all at once, so stop() and a dropped socket leave none behind.
class Timers {
  readonly #clock: GatewayClock
  readonly #ids = new Set<number>()

  constructor(clock: GatewayClock) {
    this.#clock = clock
  }

  set(fn: () => void, ms: number): number {
    const id = this.#clock.set(
      () => {
        this.#ids.delete(id)
        fn()
      },
      Math.max(0, ms),
    )
    this.#ids.add(id)
    return id
  }

  clear(id: number | undefined): void {
    if (id === undefined || !this.#ids.delete(id)) return
    this.#clock.clear(id)
  }

  clearAll(): void {
    for (const id of this.#ids) this.#clock.clear(id)
    this.#ids.clear()
  }
}

// A topic the socket has asked for: queued or sent and not yet acked (pending), held (live), or
// coming back in ack.retry (retry, until the timer asks again). subId is the sub that asked, whose
// ack alone decides it.
interface TopicState {
  phase: 'pending' | 'live' | 'retry'
  subId: number
  resetTimer?: number
}

interface Hold {
  count: number
  linger?: number
}

interface Socket {
  readonly ws: WebSocketLike
  readonly timers: Timers
  readonly bucket: TokenBucket
  // sub and unsub frames waiting for a token, in order.
  readonly queue: ClientFrame[]
  // Frames sent and not yet acked, by id.
  readonly sent: Map<number, { t: 'sub' | 'unsub'; topics: readonly string[] }>
  // The topics this socket has asked for and not unsubscribed.
  readonly topics: Map<string, TopicState>
  opened: boolean
  welcomed: boolean
  version: Version
  limits: SocketLimits
  nextId: number
  lastPingAt: number
  // Until open, the connect timeout; from open until the welcome, the welcome timeout.
  deadline?: number
  pumpTimer?: number
  pongTimer?: number
}

export class GatewayClient {
  readonly #deps: GatewayDeps
  readonly #timers: Timers
  #status: LiveStatus = 'connecting'
  #started = false
  #stopped = false
  #paused = false
  // What the views hold: topic → how many holds, and the linger timer once none is left.
  readonly #holds = new Map<string, Hold>()
  // Topics whose retries come back in a row, for the doubling.
  readonly #retries = new Map<string, number>()
  #socket: Socket | undefined
  #diffTimer: number | undefined
  #reconnectTimer: number | undefined
  readonly #nudgeTimers = new Map<GatewayNudge, number>()
  // The failure episode: since when, how many tries have failed, whether its one wait within the
  // spread is spent, and the stalled and probe timers.
  #failingSince: number | undefined
  #failures = 0
  #spreadUsed = false
  #stalled = false
  #stalledTimer: number | undefined
  #probeTimer: number | undefined
  #probing = false
  // Whether the client has ever had a welcome since start() or resume(): until then it's connecting.
  #everLive = false

  constructor(deps: GatewayDeps) {
    this.#deps = deps
    this.#timers = new Timers(deps.clock)
  }

  status(): LiveStatus {
    return this.#status
  }

  start(): void {
    if (this.#started || this.#stopped) return
    this.#started = true
    this.#open()
  }

  // Closes 1000, clears every timer, and never reconnects.
  stop(): void {
    if (this.#stopped) return
    this.#halt()
    this.#setStatus('stopped')
  }

  // After 4403's notice is acknowledged (C0.9), or to try again after 4426.
  resume(): void {
    if (!this.#paused || this.#stopped) return
    this.#paused = false
    this.#open()
  }

  // The page became visible or came back online: one ping, at most one every 5 s.
  visible(): void {
    const socket = this.#socket
    if (socket === undefined || !socket.welcomed) return
    if (this.#now() - socket.lastPingAt < CLIENT_POLICY.visiblePingMinMs) return
    this.#ping(socket)
  }

  // Wants a topic's events while the returned release hasn't been called. A topic past the
  // socket's limit, or one that isn't a topic, is refused with a warning and a release that does
  // nothing.
  hold(topic: string): () => void {
    const noop = () => {}
    if (this.#stopped) return noop
    if (!TOPIC_PATTERN.test(topic)) {
      this.#warn(`the live connection can't hold ${JSON.stringify(topic)}: not a topic`)
      return noop
    }
    let hold = this.#holds.get(topic)
    if (hold === undefined) {
      if (this.#holds.size >= this.#limits().topicsPerSocket) {
        this.#warn(`the live connection holds ${this.#holds.size} topics, its limit; ${topic} isn't held`)
        return noop
      }
      hold = { count: 0 }
      this.#holds.set(topic, hold)
      this.#scheduleDiff()
    }
    this.#timers.clear(hold.linger)
    hold.linger = undefined
    hold.count += 1
    const held = hold
    let released = false
    return () => {
      if (released) return
      released = true
      // Forgotten meanwhile (refused or dropped): nothing of this hold is left.
      if (this.#holds.get(topic) !== held) return
      held.count -= 1
      if (held.count > 0) return
      held.linger = this.#timers.set(() => {
        held.linger = undefined
        if (this.#holds.get(topic) !== held || held.count > 0) return
        this.#holds.delete(topic)
        this.#scheduleDiff()
      }, CLIENT_POLICY.lingerMs)
    }
  }

  // --- The socket ---

  #now(): number {
    return this.#deps.clock.now()
  }

  #warn(message: string): void {
    ;(this.#deps.warn ?? console.warn)(message)
  }

  #setStatus(status: LiveStatus): void {
    if (status === this.#status) return
    this.#status = status
    this.#deps.onStatus(status)
  }

  #limits(): SocketLimits {
    return this.#socket?.welcomed ? this.#socket.limits : limitsFrom()
  }

  // The first socket after start() or resume(): an episode begins, and the status is connecting
  // until the first welcome.
  #open(): void {
    this.#everLive = false
    this.#endEpisode()
    this.#beginEpisode()
    this.#setStatus('connecting')
    this.#connect()
  }

  #connect(): void {
    this.#reconnectTimer = undefined
    if (this.#stopped || this.#paused) return
    let ws: WebSocketLike
    try {
      ws = new this.#deps.WebSocket(this.#deps.url)
    } catch {
      this.#retry(undefined, 'failed')
      return
    }
    const now = this.#now()
    const socket: Socket = {
      ws,
      timers: new Timers(this.#deps.clock),
      bucket: new TokenBucket(CLIENT_POLICY.bucketBurst, CLIENT_POLICY.bucketPerSecond, now),
      queue: [],
      sent: new Map(),
      topics: new Map(),
      opened: false,
      welcomed: false,
      version: GATEWAY_VERSIONS[GATEWAY_VERSIONS.length - 1] ?? 1,
      limits: limitsFrom(),
      nextId: 1,
      lastPingAt: Number.NEGATIVE_INFINITY,
    }
    this.#socket = socket
    socket.deadline = socket.timers.set(() => this.#abandon(socket, 'connect_timeout'), CLIENT_POLICY.connectTimeoutMs)
    ws.onopen = () => {
      if (this.#socket !== socket) return
      socket.opened = true
      socket.timers.clear(socket.deadline)
      socket.deadline = socket.timers.set(
        () => this.#abandon(socket, 'welcome_timeout'),
        CLIENT_POLICY.welcomeTimeoutMs,
      )
      const versions = [...GATEWAY_VERSIONS]
      this.#send(socket, JSON.stringify({ v: Math.max(...versions), t: 'hello', versions }))
    }
    ws.onmessage = event => {
      if (this.#socket === socket) this.#receive(socket, event.data)
    }
    ws.onclose = event => {
      if (this.#socket === socket) this.#closed(socket, event.code, event.reason)
    }
    ws.onerror = () => {
      // A close follows; it decides what happens.
    }
  }

  // Sends one frame, taking a token; says whether it went.
  #send(socket: Socket, text: string): boolean {
    if (socket.ws.readyState !== OPEN || !socket.bucket.take(this.#now())) return false
    try {
      socket.ws.send(text)
      return true
    } catch {
      return false
    }
  }

  // Lets go of the socket: its handlers, its timers and what it held. Holds stay.
  #detach(socket: Socket): void {
    socket.ws.onopen = null
    socket.ws.onmessage = null
    socket.ws.onclose = null
    socket.ws.onerror = null
    socket.timers.clearAll()
    socket.queue.length = 0
    socket.sent.clear()
    socket.topics.clear()
    if (this.#socket === socket) this.#socket = undefined
  }

  // The client closes the socket itself: no open or no welcome in time, or silence after a ping.
  #abandon(socket: Socket, why: 'connect_timeout' | 'welcome_timeout' | 'no_pong'): void {
    if (this.#socket !== socket) return
    this.#detach(socket)
    try {
      socket.ws.close(CLIENT_POLICY.closeCode, why)
    } catch {
      // Closed either way.
    }
    this.#retry(socket, why === 'no_pong' ? 'closed' : 'failed')
  }

  // The server or the network closed it (header item 7).
  #closed(socket: Socket, code: number, reason: string): void {
    this.#detach(socket)
    if (code === GATEWAY_CLOSE.signedOut.code) this.#signedOut()
    else if (code === GATEWAY_CLOSE.noticeRequired.code) {
      this.#pause()
      this.#deps.onNoticeRequired()
    } else if (code === GATEWAY_CLOSE.clientOutdated.code) this.#outdated()
    else if (code === GATEWAY_CLOSE.badFrame.code && ABUSE.has(reason)) this.#retry(socket, 'abuse')
    else this.#retry(socket, socket.opened ? 'closed' : 'failed')
  }

  // Schedules the next socket. closed: an open socket closed, which waits within its spread once an
  // episode; failed: a try that never opened or never got its welcome, which waits full jitter, as
  // does any close after the episode's spread is spent; abuse: 30–60 s.
  #retry(socket: Socket | undefined, how: 'closed' | 'failed' | 'abuse'): void {
    if (this.#stopped || this.#paused) return
    const random = () => this.#deps.random()
    let wait: number
    if (how === 'abuse') {
      wait = abuseDelay(random)
      this.#spreadUsed = true
      this.#failures += 1
    } else if (how === 'closed' && !this.#spreadUsed) {
      wait = withinSpread(socket?.limits.spreadMs ?? CLIENT_POLICY.spreadBeforeWelcomeMs, random)
      this.#spreadUsed = true
    } else {
      wait = fullJitter(this.#failures, random)
      this.#spreadUsed = true
      this.#failures += 1
    }
    this.#beginEpisode()
    if (!this.#stalled) this.#setStatus(this.#everLive ? 'reconnecting' : 'connecting')
    this.#timers.clear(this.#reconnectTimer)
    this.#reconnectTimer = this.#timers.set(() => this.#connect(), wait)
  }

  #beginEpisode(): void {
    if (this.#failingSince !== undefined) return
    this.#failingSince = this.#now()
    this.#stalledTimer = this.#timers.set(() => this.#stall(), CLIENT_POLICY.stalledAfterMs)
  }

  #endEpisode(): void {
    this.#failingSince = undefined
    this.#failures = 0
    this.#spreadUsed = false
    this.#stalled = false
    this.#timers.clear(this.#stalledTimer)
    this.#timers.clear(this.#probeTimer)
    this.#stalledTimer = undefined
    this.#probeTimer = undefined
  }

  // 30 s without a welcome: stalled, and a probe at a random point in the next 5 s.
  #stall(): void {
    this.#stalledTimer = undefined
    this.#stalled = true
    this.#setStatus('stalled')
    this.#probeTimer = this.#timers.set(
      () => this.#probe(),
      withinSpread(CLIENT_POLICY.probeWindowMs, () => this.#deps.random()),
    )
  }

  // Asks whether the session still holds, then again every 30 s while the episode or the pause
  // lasts. One probe at a time: one still waiting skips the next. An answer counts only in the
  // episode or pause that asked: a welcome or resume() since then has ended it.
  #probe(): void {
    this.#probeTimer = this.#timers.set(() => this.#probe(), CLIENT_POLICY.probeEveryMs)
    if (this.#probing) return
    this.#probing = true
    const episode = this.#failingSince
    const paused = this.#paused
    let answer: Promise<ProbeAnswer>
    try {
      answer = this.#deps.probe()
    } catch {
      answer = Promise.resolve('unknown')
    }
    answer
      .catch((): ProbeAnswer => 'unknown')
      .then(said => {
        this.#probing = false
        if (said !== 'signed_out' || this.#stopped) return
        if (this.#failingSince === episode && this.#paused === paused) this.#signedOut()
      })
  }

  #signedOut(): void {
    this.#halt()
    this.#setStatus('stopped')
    this.#deps.onSignedOut()
  }

  #outdated(): void {
    this.#pause()
    this.#deps.onOutdated()
  }

  // 4403 and 4426: no reconnect until resume(); the holds and every cached topic stay
  // (T19 item 10). With no socket, nothing would hear a 4401, so the probe keeps asking whether
  // the session holds (header item 7), first at a random point in the next 30 s, so the tabs one
  // 4403 paused together don't ask together.
  #pause(): void {
    if (this.#socket !== undefined) this.#detach(this.#socket)
    this.#paused = true
    this.#timers.clear(this.#reconnectTimer)
    this.#reconnectTimer = undefined
    this.#endEpisode()
    this.#setStatus('paused')
    this.#probeTimer = this.#timers.set(
      () => this.#probe(),
      withinSpread(CLIENT_POLICY.probeEveryMs, () => this.#deps.random()),
    )
  }

  // Everything off for good: the socket closed 1000, every timer cleared, nothing held.
  #halt(): void {
    this.#stopped = true
    const socket = this.#socket
    if (socket !== undefined) {
      this.#detach(socket)
      try {
        socket.ws.close(1000)
      } catch {
        // Closed either way.
      }
    }
    this.#timers.clearAll()
    this.#holds.clear()
    this.#retries.clear()
    this.#nudgeTimers.clear()
    this.#diffTimer = undefined
    this.#reconnectTimer = undefined
    this.#stalledTimer = undefined
    this.#probeTimer = undefined
  }

  // --- Frames in ---

  #receive(socket: Socket, data: unknown): void {
    if (typeof data !== 'string') return
    // Any frame shows the socket is alive.
    socket.timers.clear(socket.pongTimer)
    socket.pongTimer = undefined
    const frame = readServerFrame(data)
    if (frame === undefined) {
      if (!socket.welcomed && foreignWelcome(data)) {
        this.#detach(socket)
        try {
          socket.ws.close(CLIENT_POLICY.closeCode, 'version')
        } catch {
          // Closed either way.
        }
        this.#outdated()
      }
      return
    }
    switch (frame.t) {
      case 'welcome':
        this.#welcome(socket, frame)
        return
      case 'ack':
        this.#ack(socket, frame)
        return
      case 'ev': {
        if (socket.topics.get(frame.topic)?.phase !== 'live') return
        this.#deps.onTopicEvent?.(frame.topic, frame.type, frame.ids)
        this.#deps.onTopicStale(frame.topic)
        return
      }
      case 'dropped':
        for (const topic of new Set(frame.topics)) this.#gone(topic)
        return
      case 'reset':
        for (const topic of new Set(frame.topics)) this.#reset(socket, topic)
        return
      case 'nudge':
        this.#nudge(socket, frame.what)
        return
      case 'pong':
        socket.limits = { ...socket.limits, spreadMs: clampSpread(frame.reconnectSpreadMs) }
        return
    }
  }

  #welcome(socket: Socket, welcome: Welcome): void {
    if (socket.welcomed) return
    socket.welcomed = true
    socket.version = welcome.v
    socket.limits = limitsFrom(welcome)
    socket.timers.clearAll()
    this.#everLive = true
    this.#endEpisode()
    this.#setStatus('live')
    this.#scheduleHeartbeat(socket)
    // Item 3: every held topic again, at once.
    this.#timers.clear(this.#diffTimer)
    this.#diffTimer = undefined
    this.#diff()
  }

  #ack(socket: Socket, ack: Extract<ServerFrameForClient, { t: 'ack' }>): void {
    const sent = socket.sent.get(ack.id)
    if (sent === undefined) return
    socket.sent.delete(ack.id)
    if (sent.t === 'unsub') return
    // A topic's state from this sub, not from one sent after it.
    const asked = (topic: string) => {
      const state = socket.topics.get(topic)
      return state?.subId === ack.id ? state : undefined
    }
    for (const topic of ack.ok) {
      const state = asked(topic)
      if (state === undefined) continue
      state.phase = 'live'
      this.#retries.delete(topic)
      // Released meanwhile: its unsub follows; nothing to fetch.
      if (this.#holds.has(topic)) this.#deps.onTopicStale(topic)
    }
    for (const topic of ack.refused) if (asked(topic) !== undefined) this.#gone(topic)
    for (const topic of ack.retry) {
      const state = asked(topic)
      if (state === undefined) continue
      if (!this.#holds.has(topic)) {
        socket.topics.delete(topic)
        continue
      }
      state.phase = 'retry'
      const retries = this.#retries.get(topic) ?? 0
      this.#retries.set(topic, retries + 1)
      socket.timers.set(
        () => {
          // Asked for again by the next diff, as a new sub.
          if (socket.topics.get(topic) === state) socket.topics.delete(topic)
          this.#scheduleDiff()
        },
        retryAckDelay(retries, () => this.#deps.random()),
      )
    }
  }

  // Refused or dropped: forget it, and wipe what's cached for it.
  #gone(topic: string): void {
    const hold = this.#holds.get(topic)
    if (hold !== undefined) this.#timers.clear(hold.linger)
    this.#holds.delete(topic)
    this.#retries.delete(topic)
    const state = this.#socket?.topics.get(topic)
    if (state !== undefined) {
      this.#socket?.timers.clear(state.resetTimer)
      this.#socket?.topics.delete(topic)
    }
    this.#deps.onTopicGone(topic)
  }

  #reset(socket: Socket, topic: string): void {
    const state = socket.topics.get(topic)
    if (state?.phase !== 'live' || state.resetTimer !== undefined) return
    state.resetTimer = socket.timers.set(
      () => {
        state.resetTimer = undefined
        if (socket.topics.get(topic) === state && state.phase === 'live') this.#deps.onTopicStale(topic)
      },
      withinSpread(socket.limits.spreadMs, () => this.#deps.random()),
    )
  }

  #nudge(socket: Socket, what: string): void {
    const known = GATEWAY_NUDGES.find(nudge => nudge === what)
    if (known === undefined || this.#nudgeTimers.has(known)) return
    const id = this.#timers.set(
      () => {
        this.#nudgeTimers.delete(known)
        this.#deps.onNudge(known)
      },
      withinSpread(socket.limits.spreadMs, () => this.#deps.random()),
    )
    this.#nudgeTimers.set(known, id)
  }

  // --- Frames out ---

  #scheduleHeartbeat(socket: Socket): void {
    socket.timers.set(() => {
      this.#ping(socket)
      this.#scheduleHeartbeat(socket)
    }, socket.limits.heartbeatMs)
  }

  // A ping when a token is free and no sub or unsub waits for one; then a frame within 10 s, or
  // the socket is dead.
  #ping(socket: Socket): void {
    if (this.#socket !== socket || socket.queue.length > 0) return
    if (!this.#send(socket, JSON.stringify({ v: socket.version, t: 'ping' } satisfies ClientFrame))) return
    socket.lastPingAt = this.#now()
    if (socket.pongTimer === undefined)
      socket.pongTimer = socket.timers.set(() => this.#abandon(socket, 'no_pong'), GATEWAY_LIMITS.pongTimeoutMs)
  }

  #scheduleDiff(): void {
    if (this.#diffTimer !== undefined) return
    this.#diffTimer = this.#timers.set(() => {
      this.#diffTimer = undefined
      this.#diff()
    }, CLIENT_POLICY.debounceMs)
  }

  // What the views hold against what the socket holds: one unsub, then the subs (header item 2).
  #diff(): void {
    const socket = this.#socket
    if (socket === undefined || !socket.welcomed) return
    const drop = [...socket.topics.keys()].filter(topic => !this.#holds.has(topic))
    for (const topic of drop) {
      socket.timers.clear(socket.topics.get(topic)?.resetTimer)
      socket.topics.delete(topic)
    }
    this.#queue(socket, 'unsub', drop)
    const room = Math.max(0, socket.limits.topicsPerSocket - socket.topics.size)
    const add = [...this.#holds.keys()].filter(topic => !socket.topics.has(topic)).slice(0, room)
    for (const [subId, topics] of this.#queue(socket, 'sub', add))
      for (const topic of topics) socket.topics.set(topic, { phase: 'pending', subId })
    this.#pump(socket)
  }

  // Splits topics into frames of at most the socket's per-frame topics and bytes, and queues them.
  // Returns each frame's id and topics: a topic too big for any frame alone is left out, with a
  // warning.
  #queue(socket: Socket, t: 'sub' | 'unsub', topics: readonly string[]): Map<number, readonly string[]> {
    const { topicsPerFrame, frameBytes } = socket.limits
    const fits = (list: readonly string[]) =>
      list.length <= topicsPerFrame &&
      bytes(JSON.stringify({ v: socket.version, t, id: ID_MAX, topics: list })) <= frameBytes
    const batches: string[][] = []
    let batch: string[] = []
    for (const topic of topics) {
      if (fits([...batch, topic])) {
        batch.push(topic)
        continue
      }
      if (batch.length > 0) batches.push(batch)
      batch = []
      if (fits([topic])) batch.push(topic)
      else this.#warn(`the live connection can't send ${topic}: a frame of it alone is over the limit`)
    }
    if (batch.length > 0) batches.push(batch)
    const queued = new Map<number, readonly string[]>()
    for (const list of batches) {
      const id = socket.nextId
      socket.nextId = id >= ID_MAX ? 1 : id + 1
      socket.sent.set(id, { t, topics: list })
      socket.queue.push({ v: socket.version, t, id, topics: list })
      queued.set(id, list)
    }
    return queued
  }

  // Sends queued frames while tokens last, and comes back when the next one is due. Nothing is
  // dropped: a frame waits for its token.
  #pump(socket: Socket): void {
    socket.timers.clear(socket.pumpTimer)
    socket.pumpTimer = undefined
    while (socket.queue.length > 0) {
      const frame = socket.queue[0]
      if (frame === undefined) break
      const now = this.#now()
      if (!socket.bucket.take(now)) {
        socket.pumpTimer = socket.timers.set(() => this.#pump(socket), socket.bucket.waitMs(now))
        return
      }
      socket.queue.shift()
      try {
        socket.ws.send(JSON.stringify(frame))
      } catch {
        // The socket is closing; its close decides what happens next.
        return
      }
    }
  }
}
