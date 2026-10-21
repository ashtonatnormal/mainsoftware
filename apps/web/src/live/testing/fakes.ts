// Fakes for the live connection's tests (Vitest only; nothing in the app imports this folder): a
// clock whose timers run only when a test moves it on, a random source that plays back given
// numbers, and a socket class that records what the client sends and lets the test be the server.
import type { GatewayClock, WebSocketLike } from '../gateway-client.ts'

export class FakeClock implements GatewayClock {
  #now = 0
  #nextId = 1
  readonly #timers = new Map<number, { at: number; fn: () => void }>()

  now(): number {
    return this.#now
  }

  set(fn: () => void, ms: number): number {
    const id = this.#nextId++
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), fn })
    return id
  }

  clear(id: number): void {
    this.#timers.delete(id)
  }

  // How many timers are waiting.
  pending(): number {
    return this.#timers.size
  }

  // When the next timer is due, or undefined.
  nextAt(): number | undefined {
    let at: number | undefined
    for (const timer of this.#timers.values()) if (at === undefined || timer.at < at) at = timer.at
    return at
  }

  // Moves time on by ms, running every timer due by then in time order (and, at the same time, in
  // the order they were set), the ones those set included.
  advance(ms: number): void {
    const end = this.#now + ms
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | undefined
      for (const entry of this.#timers) {
        if (entry[1].at > end) continue
        if (due === undefined || entry[1].at < due[1].at) due = entry
      }
      if (due === undefined) break
      this.#timers.delete(due[0])
      this.#now = due[1].at
      due[1].fn()
    }
    this.#now = end
  }
}

// A random source: the given numbers in turn, then `rest` for ever.
export function randoms(values: readonly number[] = [], rest = 0.5): () => number {
  let at = 0
  return () => (at < values.length ? (values[at++] ?? rest) : rest)
}

export const SOCKET_ID = 'c0000000-0000-4000-8000-000000000001'

export type SentFrame = { v: number; t: string; id?: number; topics?: string[]; versions?: number[] }

export class FakeSocket implements WebSocketLike {
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  readonly url: string
  // Every frame the client sent, parsed, and when (by the clock the class was made with).
  readonly sent: SentFrame[] = []
  readonly sentAt: number[] = []
  // What the client closed it with, if it did.
  closedWith: { code: number | undefined; reason: string | undefined } | undefined
  // Whether the fake server answers each ping with a pong (on the clock, a moment later), and the
  // spread the pong names.
  autoPong = true
  pongSpreadMs = 5_000
  readonly #clock: GatewayClock | undefined

  constructor(url: string, clock?: GatewayClock) {
    this.url = url
    this.#clock = clock
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('InvalidStateError: the socket is not open')
    const frame = JSON.parse(data) as SentFrame
    this.sent.push(frame)
    this.sentAt.push(this.#clock?.now() ?? 0)
    if (frame.t === 'ping' && this.autoPong)
      this.#clock?.set(() => {
        if (this.readyState === 1) this.receive({ v: 1, t: 'pong', reconnectSpreadMs: this.pongSpreadMs })
      }, 0)
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason }
    this.readyState = 3
  }

  // The frames of one type the client sent.
  frames(t: string): SentFrame[] {
    return this.sent.filter(frame => frame.t === t)
  }

  // --- The server's side ---

  open(): void {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }

  receive(frame: unknown): void {
    const data = typeof frame === 'string' ? frame : JSON.stringify(frame)
    this.onmessage?.(new MessageEvent('message', { data }))
  }

  welcome(overrides: Record<string, unknown> = {}): void {
    this.receive({
      v: 1,
      t: 'welcome',
      socket: SOCKET_ID,
      heartbeatMs: 25_000,
      maxTopics: 100,
      maxTopicsPerFrame: 50,
      maxFrameBytes: 4096,
      reconnectSpreadMs: 5_000,
      ...overrides,
    })
  }

  // Opens and welcomes it.
  connect(overrides: Record<string, unknown> = {}): void {
    this.open()
    this.welcome(overrides)
  }

  ack(id: number | undefined, lists: { ok?: string[]; refused?: string[]; retry?: string[] }): void {
    this.receive({ v: 1, t: 'ack', id, ok: lists.ok ?? [], refused: lists.refused ?? [], retry: lists.retry ?? [] })
  }

  // The server (or the network) closes it.
  serverClose(code: number, reason = ''): void {
    this.readyState = 3
    this.onclose?.(new CloseEvent('close', { code, reason }))
  }
}

// A WebSocket class for one test, keeping every socket it made. With refuse set, each socket fails
// to connect (a 1006 close without an open) refuseAfterMs after it is made, as an upgrade the
// server refused, or a network that is down, looks to a browser.
export function socketClass(options: { clock?: FakeClock; refuse?: () => boolean; refuseAfterMs?: number } = {}) {
  const sockets: FakeSocket[] = []
  const { clock, refuse = () => false, refuseAfterMs = 100 } = options
  class TestSocket extends FakeSocket {
    constructor(url: string) {
      super(url, clock)
      sockets.push(this)
      if (clock !== undefined && refuse())
        clock.set(() => {
          if (this.readyState === 0) this.serverClose(1006)
        }, refuseAfterMs)
    }
  }
  return {
    WebSocket: TestSocket,
    sockets,
    last(): FakeSocket {
      const socket = sockets.at(-1)
      if (socket === undefined) throw new Error('no socket was opened')
      return socket
    },
  }
}
