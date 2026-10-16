// The gateway on a real port with fakes behind it, for unit tests (test-only; the image leaves
// testing/ out): a session lookup over known tokens, a check function whose answers a test sets
// (FakeChecks), and clients that speak the protocol and keep every frame they get.
import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { type Position, readServerFrame, type ServerFrameForClient } from '@hearth/shared'
import { vi } from 'vitest'
import { WebSocket } from 'ws'
import { buildApp } from '#src/app.ts'
import { sha256 } from '#src/auth/crypto.ts'
import { SOCKET_RECHECK_MS } from '#src/auth/policy.ts'
import type { SessionIds } from '#src/db/pre-org.ts'
import type { CheckOrg, CheckRequest, CheckResult, SessionCheck } from '#src/realtime/checks.ts'
import type { Conn } from '#src/realtime/frames.ts'
import { attachSocketServer, type GatewayStream, type SocketServerOptions } from '#src/realtime/socket.ts'
import { evFrame, holdEntry, type StreamTarget } from '#src/realtime/stream.ts'
import { captureLogger } from '#src/testing/logs.ts'

export const APP_ORIGIN = 'https://hearth.example.com'
export const ORG = 'a0000000-0000-4000-8000-000000000001'
export const OTHER_ORG = 'a0000000-0000-4000-8000-000000000002'
export const TEAM = 'c0000000-0000-4000-8000-000000000001'
export const OTHER_TEAM = 'c0000000-0000-4000-8000-000000000002'

// The nth known session: its token (43 base64url characters, one letter repeated, so no scanner
// takes it for a secret) and its ids. Sessions 1-9 are people 1-9's, in ORG.
export function known(n: number, person = n): { token: string; session: SessionIds } {
  const hex = (prefix: string, value: number) => `${prefix}-0000-4000-8000-${value.toString(16).padStart(12, '0')}`
  return {
    token: String.fromCharCode(96 + n).repeat(43),
    session: {
      sessionId: hex('b0000000', 0xe00 + n),
      orgId: ORG,
      userId: hex('b0000000', person),
      deviceId: hex('b0000000', 0xd00 + n),
    },
  }
}

export const personTopic = (n: number) => `person:${known(1, n).session.userId}`
// A sub's own decision names no held topic; a periodic or targeted check of a socket that already
// holds one names it.
export const isSubDecision = (request: CheckRequest) => (request.held?.size ?? 0) === 0
export const orgTopic = (orgId = ORG) => `org:${orgId}`
export const teamTopic = (team = TEAM) => `team:${team}`

// What the checks answer, as a test sets it: sessions are live unless ended, people admitted unless
// listed, and each person may hold their own person topic, the org topic and the topics added to
// allowed. A test can hold every check until it releases it, or make the next ones fail.
export class FakeChecks {
  readonly ended = new Map<string, number | undefined>()
  readonly notAdmitted = new Set<string>()
  readonly allowed = new Map<string, Set<string>>()
  readonly eras = new Map<string, Map<string, number>>()
  readonly lostAt = new Map<string, Map<string, number>>()
  readonly calls: { orgId: string; request: CheckRequest }[] = []
  // The session ids' people, for the live ones (every known session's is registered).
  readonly people = new Map<string, string>()
  #held: Promise<void> | undefined
  #holds: (request: CheckRequest) => boolean = () => true
  #release: (() => void) | undefined
  #failures: (Error | 'hang')[] = []
  failAlways: Error | 'hang' | undefined

  constructor() {
    for (let n = 1; n <= 9; n++) this.people.set(known(n).session.sessionId, known(n).session.userId)
  }

  allow(person: string, ...topics: string[]): void {
    const set = this.allowed.get(person) ?? new Set()
    for (const topic of topics) set.add(topic)
    this.allowed.set(person, set)
  }

  deny(person: string, ...topics: string[]): void {
    for (const topic of topics) this.allowed.get(person)?.delete(topic)
  }

  // Every check from now on (or only those `only` picks) waits until release().
  hold(only: (request: CheckRequest) => boolean = () => true): void {
    this.#holds = only
    this.#held = new Promise(resolve => {
      this.#release = resolve
    })
  }

  release(): void {
    this.#release?.()
    this.#held = undefined
  }

  // The next checks fail with these, in order (a 'hang' never answers).
  failNext(...failures: (Error | 'hang')[]): void {
    this.#failures.push(...failures)
  }

  readonly check: CheckOrg = vi.fn(async (orgId: string, request: CheckRequest): Promise<CheckResult> => {
    this.calls.push({ orgId, request })
    const failure = this.#failures.shift() ?? this.failAlways
    if (this.#held !== undefined && this.#holds(request)) await this.#held
    if (failure === 'hang') return new Promise<never>(() => {})
    if (failure !== undefined) throw failure
    return this.answer(orgId, request)
  })

  answer(orgId: string, request: CheckRequest): CheckResult {
    const sessions = new Map<string, SessionCheck>()
    const live = new Set<string>()
    for (const id of request.sessions) {
      const person = this.people.get(id)
      if (this.ended.has(id) || person === undefined) sessions.set(id, { live: false, endedAt: this.ended.get(id) })
      else {
        sessions.set(id, { live: true, person })
        live.add(person)
      }
    }
    const notAdmitted = new Set([...live].filter(person => this.notAdmitted.has(person)))
    const topics = new Map<string, Map<string, boolean>>()
    const lostAt = new Map<string, Map<string, number | undefined>>()
    const eras = new Map<string, Map<string, number>>()
    for (const [person, asked] of request.topics ?? []) {
      if (!live.has(person) || notAdmitted.has(person)) continue
      const own = new Set([`person:${person}`, `org:${orgId}`, ...(this.allowed.get(person) ?? [])])
      const decided = new Map([...asked].map(topic => [topic, own.has(topic)]))
      topics.set(person, decided)
      for (const topic of request.held?.get(person) ?? []) {
        if (decided.get(topic) !== false) continue
        const map = lostAt.get(person) ?? new Map()
        map.set(topic, this.lostAt.get(person)?.get(topic))
        lostAt.set(person, map)
      }
      for (const topic of request.eras?.get(person) ?? []) {
        const began = this.eras.get(person)?.get(topic)
        if (began === undefined || decided.get(topic) !== true) continue
        const map = eras.get(person) ?? new Map()
        map.set(topic, began)
        eras.set(person, map)
      }
    }
    return { sessions, notAdmitted, topics, lostAt, eras }
  }
}

type Frame = ServerFrameForClient & Record<string, unknown>

export interface Closed {
  code: number
  reason: string
}

// A client of the gateway: every frame it gets, parsed (raw, in order), and waits for the next of a
// type.
export class TestClient {
  readonly ws: WebSocket
  readonly frames: Frame[] = []
  readonly closed: Promise<Closed>
  #consumed = new Set<number>()
  #wake: (() => void) | undefined
  #id = 0

  constructor(ws: WebSocket) {
    this.ws = ws
    this.closed = new Promise(resolve => {
      ws.once('close', (code, reason) => {
        this.#wake?.()
        resolve({ code, reason: reason.toString() })
      })
    })
    ws.on('message', data => {
      const frame = readServerFrame(String(data))
      // Every frame the server sends parses (P6); anything else is a bug, kept to fail the test.
      this.frames.push((frame ?? { t: 'unreadable', text: String(data) }) as Frame)
      this.#wake?.()
    })
  }

  send(frame: unknown): void {
    this.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame))
  }

  // The next frame not yet taken, of type t if given.
  async next<T extends string>(t?: T, ms = 3000): Promise<Frame & { t: T }> {
    const deadline = Date.now() + ms
    for (;;) {
      const at = this.frames.findIndex((frame, i) => !this.#consumed.has(i) && (t === undefined || frame.t === t))
      if (at >= 0) {
        this.#consumed.add(at)
        return this.frames[at] as Frame & { t: T }
      }
      if (this.ws.readyState === WebSocket.CLOSED) throw new Error(`the socket closed before a ${t ?? 'frame'} came`)
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`no ${t ?? 'frame'} within ${ms} ms; got ${JSON.stringify(this.frames)}`)
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, left)
        this.#wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
  }

  hello(versions: number[] = [1]): Promise<Frame & { t: 'welcome' }> {
    this.send({ v: Math.max(...versions), t: 'hello', versions })
    return this.next('welcome')
  }

  // Sends a sub and answers its ack.
  async sub(topics: string[], since?: { epoch: string; pos: string }): Promise<Frame & { t: 'ack' }> {
    const id = ++this.#id
    this.send({ v: 1, t: 'sub', id, topics, ...(since === undefined ? {} : { since }) })
    for (;;) {
      const ack = await this.next('ack')
      if (ack.id === id) return ack
    }
  }

  async unsub(topics: string[]): Promise<Frame & { t: 'ack' }> {
    const id = ++this.#id
    this.send({ v: 1, t: 'unsub', id, topics })
    for (;;) {
      const ack = await this.next('ack')
      if (ack.id === id) return ack
    }
  }

  // The frames of type t so far.
  all(t: string): Frame[] {
    return this.frames.filter(frame => frame.t === t)
  }
}

export type Opened = { status: number; body: string; headers: IncomingHttpHeaders } | { client: TestClient }

export async function startGateway(options: Partial<SocketServerOptions> = {}) {
  const { logger, lines, events } = captureLogger('realtime')
  const app = buildApp({ appOrigin: APP_ORIGIN, logger, checks: {} })
  const sessions = new Map<string, SessionIds>()
  for (let n = 1; n <= 9; n++) sessions.set(sha256(known(n).token).toString('hex'), known(n).session)
  const lookup = vi.fn<SocketServerOptions['lookup']>(async tokenHash => sessions.get(tokenHash.toString('hex')))
  const checks = new FakeChecks()
  const server = attachSocketServer(app, {
    appOrigin: APP_ORIGIN,
    logger,
    lookup,
    check: checks.check,
    recheckMs: SOCKET_RECHECK_MS,
    ...options,
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const { port } = app.server.address() as AddressInfo
  const url = `ws://127.0.0.1:${port}/ws`
  return { app, server, port, url, lines, events, lookup, checks, sessions }
}

export const signedIn = (token = known(1).token) => ({ origin: APP_ORIGIN, cookie: `__Host-hearth_session=${token}` })

// Opens a socket as a browser would, with these headers: the client once open, or the refusal.
export function open(url: string, headers: Record<string, string> = signedIn()): Promise<Opened> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers, perMessageDeflate: false })
    const client = new TestClient(ws)
    ws.on('error', reject)
    ws.once('open', () => resolve({ client }))
    ws.once('unexpected-response', (_request, response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        body += chunk
      })
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, body, headers: response.headers })
        ws.terminate()
      })
    })
  })
}

export async function opened(url: string, headers: Record<string, string> = signedIn()): Promise<TestClient> {
  const result = await open(url, headers)
  if (!('client' in result)) throw new Error(`expected the socket to open, got ${result.status}`)
  return result.client
}

// Opens a socket and says hello.
export async function connected(url: string, token = known(1).token): Promise<TestClient> {
  const client = await opened(url, signedIn(token))
  await client.hello()
  return client
}

export async function refused(url: string, headers: Record<string, string> = {}) {
  const result = await open(url, headers)
  if ('client' in result) throw new Error('expected the upgrade to be refused')
  return result
}

export async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await delay(10)
  }
}

export type GatewayUnderTest = Awaited<ReturnType<typeof startGateway>>

// A stand-in for the stream reader: positions a test sets (none until it does), and a dispatch that
// does what the reader's does with an entry: sends it to the sockets holding its topic live, and
// holds it for those still replaying. The gateway hands it its target.
export function fakeStream() {
  let target: StreamTarget<Conn> | undefined
  const positions = new Map<string, Position>()
  const watched: string[] = []
  // A test can hold position() until it releases it.
  let held: Promise<void> | undefined
  let release: (() => void) | undefined
  const stream: GatewayStream = {
    start: () => {},
    stop: async () => {},
    watch: orgId => {
      watched.push(orgId)
    },
    position: async orgId => {
      if (held !== undefined) await held
      return positions.get(orgId) ?? null
    },
    current: orgId => positions.get(orgId) ?? null,
    lagMs: () => 0,
    stuck: () => false,
  }
  return {
    factory: (given: StreamTarget<Conn>) => {
      target = given
      return stream
    },
    target: (): StreamTarget<Conn> => {
      if (target === undefined) throw new Error('the gateway has no stream yet')
      return target
    },
    positions,
    watched,
    hold(): void {
      held = new Promise(resolve => {
        release = resolve
      })
    },
    release(): void {
      release?.()
      held = undefined
    },
    // The reader dispatching an entry at id (and moving the org's position to it).
    dispatch(orgId: string, topic: string, id: string, ids: Record<string, string> = {}): void {
      const t = target
      if (t === undefined) throw new Error('the gateway has no stream yet')
      const epoch = positions.get(orgId)?.epoch ?? 'e0000000-0000-4000-8000-000000000001'
      positions.set(orgId, { epoch, pos: id })
      const text = evFrame(topic, id, 'inbox.changed', ids)
      for (const socket of t.byTopic(orgId, topic)) {
        const hold = t.holdOf(socket, topic)
        if (hold === undefined || hold.state === 'deciding') continue
        if (hold.state === 'live') t.send(socket, text)
        else holdEntry(hold, { id, text }, 500)
      }
    },
    // The sockets holding the topic, replaying or live (the index dispatch reads).
    holders(orgId: string, topic: string): Conn[] {
      return [...(target?.byTopic(orgId, topic) ?? [])]
    },
  }
}
