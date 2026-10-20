// The gateway client against a fake socket and a fake clock (T19 item 10, T21 item 4). Each case
// names the item of packages/shared/src/gateway.ts's client side it checks. Every timer runs only
// when a case moves the clock, and every random draw is given, so each wait is exact.
import { ClientFrame, GATEWAY_LIMITS, Hello } from '@hearth/shared'
import { describe, expect, it } from 'vitest'
import { GatewayClient, gatewayUrl, type LiveStatus, limitsFrom, type ProbeAnswer } from './gateway-client.ts'
import { FakeClock, type FakeSocket, type SentFrame, socketClass } from './testing/fakes.ts'

const URL = 'wss://hearth.test/ws'
// Team topics, numbered; their ids are fictional.
const topic = (n: number) => `team:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const [A, B, C] = [topic(1), topic(2), topic(3)]
const MESSAGE = 'd0000000-0000-4000-8000-000000000001'

const bytes = (frame: SentFrame) => new TextEncoder().encode(JSON.stringify(frame)).length

// Lets a probe's answer (a promise) land.
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function setup(options: { random?: () => number; refuse?: () => boolean } = {}) {
  const clock = new FakeClock()
  const net = socketClass({ clock, refuse: options.refuse })
  const seen = {
    stale: [] as string[],
    gone: [] as string[],
    events: [] as { topic: string; type: string; ids: unknown }[],
    nudges: [] as string[],
    signedOut: 0,
    notice: 0,
    outdated: 0,
    statuses: [] as LiveStatus[],
    warnings: [] as string[],
    probes: [] as number[],
  }
  let probe: () => Promise<ProbeAnswer> = async () => 'signed_in'
  const client = new GatewayClient({
    url: URL,
    WebSocket: net.WebSocket,
    clock,
    random: options.random ?? (() => 0.5),
    onTopicStale: topic => seen.stale.push(topic),
    onTopicGone: topic => seen.gone.push(topic),
    onTopicEvent: (topic, type, ids) => seen.events.push({ topic, type, ids }),
    onNudge: what => seen.nudges.push(what),
    onSignedOut: () => seen.signedOut++,
    onNoticeRequired: () => seen.notice++,
    onOutdated: () => seen.outdated++,
    probe: () => {
      seen.probes.push(clock.now())
      return probe()
    },
    onStatus: status => seen.statuses.push(status),
    warn: message => seen.warnings.push(message),
  })
  return {
    client,
    clock,
    net,
    seen,
    setProbe(next: () => Promise<ProbeAnswer>) {
      probe = next
    },
  }
}

// A started client whose socket is open and welcomed.
function connected(options: Parameters<typeof setup>[0] = {}, welcome: Record<string, unknown> = {}) {
  const harness = setup(options)
  harness.client.start()
  const socket = harness.net.last()
  socket.connect(welcome)
  return { ...harness, socket }
}

// Holds the topics, lets the debounce pass, and acks the sub ok.
function holdLive(harness: { client: GatewayClient; clock: FakeClock }, socket: FakeSocket, ...topics: string[]) {
  const releases = topics.map(topic => harness.client.hold(topic))
  harness.clock.advance(250)
  const sub = socket.frames('sub').at(-1)
  socket.ack(sub?.id, { ok: sub?.topics ?? [] })
  return releases
}

describe('T21 T19 item 10: the gateway client (live/gateway-client.ts)', () => {
  it("GW-01 T19 item 10 (1) T21 item 4: hello names every version at open; later frames use welcome's v; pong updates the spread", () => {
    const { client, clock, net } = setup({ random: () => 0.99 })
    client.start()
    const socket = net.last()
    expect(socket.url).toBe(URL)
    expect(socket.sent).toEqual([])
    socket.open()
    expect(socket.sent).toEqual([{ v: 1, t: 'hello', versions: [1] }])
    socket.welcome({ heartbeatMs: 20_000, reconnectSpreadMs: 5_000 })
    client.hold(A)
    clock.advance(250)
    expect(socket.frames('sub')).toEqual([{ v: 1, t: 'sub', id: 1, topics: [A] }])
    clock.advance(19_750)
    expect(socket.frames('ping')).toEqual([{ v: 1, t: 'ping' }])
    // The pong says the spread is now 2 s: the next reconnect waits within it, not the welcome's 5 s.
    socket.receive({ v: 1, t: 'pong', reconnectSpreadMs: 2_000 })
    socket.serverClose(1006)
    clock.advance(1_979)
    expect(net.sockets).toHaveLength(1)
    clock.advance(1)
    expect(net.sockets).toHaveLength(2)

    // The URL is this page's own origin, ws or wss by its scheme.
    expect(gatewayUrl({ protocol: 'https:', host: 'hearth.example:8443' })).toBe('wss://hearth.example:8443/ws')
    expect(gatewayUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/ws')
  })

  it("GW-02 (1): a welcome version this build doesn't speak calls onOutdated, and nothing reconnects", () => {
    const { client, clock, net, seen } = setup()
    client.start()
    const socket = net.last()
    socket.open()
    socket.welcome({ v: 2 })
    expect(seen.outdated).toBe(1)
    expect(client.status()).toBe('paused')
    expect(socket.closedWith?.code).toBe(4000)
    clock.advance(600_000)
    expect(net.sockets).toHaveLength(1)
  })

  it('GW-03 (2): subs only after welcome, ≤50 a frame, ≤100 a socket, each frame within maxFrameBytes', () => {
    const { client, clock, net, seen } = setup()
    client.start()
    const topics = Array.from({ length: 100 }, (_, i) => topic(i + 1))
    for (const held of topics) client.hold(held)
    // The 101st, and anything that isn't a topic, is refused with a warning and a release that does
    // nothing.
    const extra = client.hold(topic(101))
    const odd = client.hold('person:NOT-A-UUID')
    expect(seen.warnings).toEqual([expect.stringContaining(topic(101)), expect.stringContaining('NOT-A-UUID')])
    extra()
    odd()

    const socket = net.last()
    socket.open()
    clock.advance(1_000)
    expect(socket.frames('sub')).toEqual([])
    socket.welcome()
    const subs = socket.frames('sub')
    expect(subs.map(frame => frame.topics?.length)).toEqual([50, 50])
    expect(subs.flatMap(frame => frame.topics)).toEqual(topics)
    for (const frame of subs) expect(bytes(frame)).toBeLessThanOrEqual(GATEWAY_LIMITS.maxFrameBytes)
  })

  it('GW-04 (2): ack ok refetches each; refused forgets and wipes; retry resends after 1–5 s doubling to 30 s', () => {
    const { client, clock, socket, seen } = connected({ random: () => 0.5 })
    client.hold(A)
    const releaseB = client.hold(B)
    client.hold(C)
    clock.advance(250)
    const first = socket.frames('sub')[0]
    expect(first?.topics).toEqual([A, B, C])
    socket.ack(first?.id, { ok: [A], refused: [B], retry: [C] })
    expect(seen.stale).toEqual([A])
    expect(seen.gone).toEqual([B])
    // B is forgotten: its release does nothing, and it is never asked for again.
    releaseB()

    // C again after 3 s (1–5 s at 0.5) and the debounce, then 6 s, 12 s, 24 s, and 30 s at most.
    let id = first?.id
    for (const wait of [3_000, 6_000, 12_000, 24_000, 30_000]) {
      if (wait > 3_000) socket.ack(id, { retry: [C] })
      const count = socket.frames('sub').length
      clock.advance(wait + 250 - 1)
      expect(socket.frames('sub'), `${wait} ms`).toHaveLength(count)
      clock.advance(1)
      const again = socket.frames('sub')[count]
      expect(again?.topics).toEqual([C])
      id = again?.id
    }
    socket.ack(id, { ok: [C] })
    expect(seen.stale).toEqual([A, C])
    expect(
      socket
        .frames('sub')
        .slice(1)
        .flatMap(frame => frame.topics),
    ).not.toContain(B)
  })

  it('GW-05 (2)(4): an ev before its ack changes nothing; after it refetches, with its ids passed on whole', () => {
    const { client, clock, socket, seen } = connected()
    client.hold(A)
    clock.advance(250)
    const sub = socket.frames('sub')[0]
    socket.receive({ v: 1, t: 'ev', topic: A, type: 'message.created', ids: { message: MESSAGE } })
    expect(seen.stale).toEqual([])
    expect(seen.events).toEqual([])
    socket.ack(sub?.id, { ok: [A] })
    expect(seen.stale).toEqual([A])
    // A key this build doesn't know passes through untouched (P6).
    const ids = { message: MESSAGE, later_key: [1, 2] }
    socket.receive({ v: 1, t: 'ev', topic: A, type: 'message.created', ids })
    expect(seen.events).toEqual([{ topic: A, type: 'message.created', ids }])
    expect(seen.stale).toEqual([A, A])
    // An ev for a topic it doesn't hold does nothing.
    socket.receive({ v: 1, t: 'ev', topic: B, type: 'message.created', ids: {} })
    expect(seen.stale).toEqual([A, A])
  })

  it('GW-06 (2) T21 item 4: a burst of 30 frames sends ≤18 at once and ≤4 a second after; nothing is dropped', () => {
    const { client, clock, socket } = connected({}, { maxTopicsPerFrame: 1 })
    const topics = Array.from({ length: 30 }, (_, i) => topic(i + 1))
    for (const held of topics) client.hold(held)
    clock.advance(250)
    expect(socket.frames('sub')).toHaveLength(18)
    clock.advance(1_000)
    expect(socket.frames('sub')).toHaveLength(22)
    clock.advance(3_000)
    const subs = socket.frames('sub')
    expect(subs.flatMap(frame => frame.topics)).toEqual(topics)

    // Every frame the server saw, against its own bucket: 20 at open, 5 a second after, and every
    // frame takes one. It never runs dry.
    let tokens: number = GATEWAY_LIMITS.frameBurst
    let at = 0
    for (const time of socket.sentAt) {
      tokens = Math.min(GATEWAY_LIMITS.frameBurst, tokens + ((time - at) * GATEWAY_LIMITS.framesPerSecond) / 1000)
      at = time
      expect(tokens, `at ${time} ms`).toBeGreaterThanOrEqual(1)
      tokens -= 1
    }
    // After the burst, no two subs closer than a quarter second: 4 a second.
    const after = socket.sentAt.slice(1 + 18)
    for (let i = 1; i < after.length; i++) expect((after[i] ?? 0) - (after[i - 1] ?? 0)).toBeGreaterThanOrEqual(250)
  })

  it('GW-07 (2): changes within 250 ms become one unsub and one sub; a release re-held within 3 s sends nothing', () => {
    const { client, clock, socket } = connected()
    const releaseA = client.hold(A)
    clock.advance(100)
    const releaseB = client.hold(B)
    clock.advance(149)
    expect(socket.frames('sub')).toEqual([])
    clock.advance(1)
    expect(socket.frames('sub')).toEqual([{ v: 1, t: 'sub', id: 1, topics: [A, B] }])
    socket.ack(1, { ok: [A, B] })

    // A's release lingers 3 s; C held in the same window: one unsub, then one sub.
    releaseA()
    releaseA()
    clock.advance(3_000)
    client.hold(C)
    clock.advance(250)
    expect(socket.sent.slice(-2)).toEqual([
      { v: 1, t: 'unsub', id: 2, topics: [A] },
      { v: 1, t: 'sub', id: 3, topics: [C] },
    ])

    // B let go and held again within 3 s: nothing goes out.
    const sent = socket.sent.length
    releaseB()
    clock.advance(2_999)
    client.hold(B)
    clock.advance(10_000)
    expect(socket.sent).toHaveLength(sent)
  })

  it('GW-08 (3): after a reconnect every held topic is subscribed again and each acked ok refetched', () => {
    const harness = connected({ random: () => 0.5 })
    const { client, clock, net, seen, socket } = harness
    holdLive(harness, socket, A, B)
    expect(seen.stale).toEqual([A, B])
    socket.serverClose(1006)
    expect(client.status()).toBe('reconnecting')
    clock.advance(2_500)
    const next = net.last()
    expect(next).not.toBe(socket)
    next.open()
    expect(next.sent).toEqual([{ v: 1, t: 'hello', versions: [1] }])
    next.welcome()
    // At once, with no debounce: the socket holds nothing yet.
    const sub = next.frames('sub')[0]
    expect(sub?.topics).toEqual([A, B])
    next.ack(sub?.id, { ok: [A, B] })
    expect(seen.stale).toEqual([A, B, A, B])
    expect(client.status()).toBe('live')
  })

  it('GW-09 (5) T19 item 10: dropped forgets and wipes, whatever the reason', () => {
    const harness = connected()
    const { client, clock, net, seen, socket } = harness
    holdLive(harness, socket, A, B, C)
    socket.receive({ v: 1, t: 'dropped', topics: [A], reason: 'access' })
    // A reason this build doesn't know reads as access; a topic it never held is wiped all the same.
    socket.receive({ v: 1, t: 'dropped', topics: [B, 'space:later-kind'], reason: 'moved' })
    expect(seen.gone).toEqual([A, B, 'space:later-kind'])
    socket.receive({ v: 1, t: 'ev', topic: A, type: 'message.created', ids: {} })
    expect(seen.stale).toEqual([A, B, C])

    // A reconnect asks only for what is still held.
    socket.serverClose(1001, 'server stopping')
    clock.advance(5_000)
    net.last().connect()
    expect(
      net
        .last()
        .frames('sub')
        .map(frame => frame.topics),
    ).toEqual([[C]])
    // Held again later, A is decided again.
    client.hold(A)
    clock.advance(250)
    expect(net.last().frames('sub').at(-1)?.topics).toEqual([A])
  })

  it('GW-10 (5): reset refetches within the spread; another reset while waiting adds nothing; one after the refetch started schedules again', () => {
    const harness = connected({ random: () => 0.5 })
    const { client, clock, seen, socket } = harness
    holdLive(harness, socket, A)
    client.hold(B)
    clock.advance(250)
    // B's sub is out but not acked: a reset doesn't name it for a refetch.
    expect(seen.stale).toEqual([A])
    socket.receive({ v: 1, t: 'reset', topics: [A, B], reason: 'gap' })
    clock.advance(1_000)
    socket.receive({ v: 1, t: 'reset', topics: [A], reason: 'later_reason' })
    clock.advance(1_499)
    expect(seen.stale).toEqual([A])
    clock.advance(1)
    expect(seen.stale).toEqual([A, A])
    clock.advance(10_000)
    expect(seen.stale).toEqual([A, A])
    socket.receive({ v: 1, t: 'reset', topics: [A], reason: 'gap' })
    clock.advance(2_500)
    expect(seen.stale).toEqual([A, A, A])
  })

  it('GW-11 (5) T17 item 11: nudge flags calls onNudge once within the spread; an unknown nudge is ignored', () => {
    const { clock, seen, socket } = connected({ random: () => 0.5 })
    socket.receive({ v: 1, t: 'nudge', what: 'flags' })
    clock.advance(1_000)
    socket.receive({ v: 1, t: 'nudge', what: 'flags' })
    socket.receive({ v: 1, t: 'nudge', what: 'colours' })
    clock.advance(1_499)
    expect(seen.nudges).toEqual([])
    clock.advance(1)
    expect(seen.nudges).toEqual(['flags'])
    clock.advance(10_000)
    expect(seen.nudges).toEqual(['flags'])
    socket.receive({ v: 1, t: 'nudge', what: 'flags' })
    clock.advance(2_500)
    expect(seen.nudges).toEqual(['flags', 'flags'])
  })

  it('GW-12 (6): ping every heartbeatMs and on visible at most every 5 s; silence 10 s after a ping reconnects', () => {
    const { client, clock, net } = setup({ random: () => 0.5 })
    client.start()
    const socket = net.last()
    socket.autoPong = false
    client.visible()
    socket.connect({ heartbeatMs: 20_000 })
    expect(socket.frames('ping')).toHaveLength(0)
    clock.advance(20_000)
    expect(socket.frames('ping')).toHaveLength(1)
    socket.receive({ v: 1, t: 'pong', reconnectSpreadMs: 5_000 })
    clock.advance(20_000)
    expect(socket.frames('ping')).toHaveLength(2)
    socket.receive({ v: 1, t: 'pong', reconnectSpreadMs: 5_000 })
    clock.advance(1_000)
    client.visible()
    expect(socket.frames('ping')).toHaveLength(2)
    clock.advance(4_000)
    client.visible()
    expect(socket.frames('ping')).toHaveLength(3)

    // No frame within 10 s of that ping: the socket is dead.
    clock.advance(9_999)
    expect(socket.closedWith).toBeUndefined()
    clock.advance(1)
    expect(socket.closedWith).toEqual({ code: 4000, reason: 'no_pong' })
    expect(client.status()).toBe('reconnecting')
    clock.advance(2_500)
    expect(net.sockets).toHaveLength(2)
  })

  it('GW-13 (7) T21 item 4: 4401 signs out and never reconnects; 4403 pauses, wipes nothing and waits for resume(); 4426 calls onOutdated', () => {
    const out = connected()
    out.socket.serverClose(4401, 'signed_out')
    expect(out.seen.signedOut).toBe(1)
    expect(out.client.status()).toBe('stopped')
    out.clock.advance(600_000)
    expect(out.net.sockets).toHaveLength(1)
    expect(out.clock.pending()).toBe(0)

    const notice = connected()
    holdLive(notice, notice.socket, A)
    notice.socket.serverClose(4403, 'notice_required')
    expect(notice.seen.notice).toBe(1)
    expect(notice.seen.gone).toEqual([])
    expect(notice.client.status()).toBe('paused')
    notice.clock.advance(600_000)
    expect(notice.net.sockets).toHaveLength(1)
    notice.client.resume()
    expect(notice.client.status()).toBe('connecting')
    const back = notice.net.last()
    back.connect()
    const sub = back.frames('sub')[0]
    expect(sub?.topics).toEqual([A])
    back.ack(sub?.id, { ok: [A] })
    expect(notice.seen.stale).toEqual([A, A])

    const old = connected()
    old.socket.serverClose(4426, 'client_outdated')
    expect(old.seen.outdated).toBe(1)
    expect(old.client.status()).toBe('paused')
    old.clock.advance(600_000)
    expect(old.net.sockets).toHaveLength(1)
  })

  it('GW-14 (7) T21 item 4: abuse 1008 waits ≥30 s; 1006/1001/1013/4408/1011/hello_timeout wait within the spread, then full jitter 1–30 s', () => {
    for (const reason of ['bad_frame', 'too_many_frames', 'too_many_topics']) {
      const soon = connected({ random: () => 0 })
      soon.socket.serverClose(1008, reason)
      soon.clock.advance(29_999)
      expect(soon.net.sockets, reason).toHaveLength(1)
      soon.clock.advance(1)
      expect(soon.net.sockets, reason).toHaveLength(2)
      const late = connected({ random: () => 0.999 })
      late.socket.serverClose(1008, reason)
      late.clock.advance(59_969)
      expect(late.net.sockets, reason).toHaveLength(1)
      late.clock.advance(1)
      expect(late.net.sockets, reason).toHaveLength(2)
    }

    const closes: [number, string][] = [
      [1006, ''],
      [1001, 'server stopping'],
      [1013, 'try again later'],
      [4408, 'too_slow'],
      [1011, 'internal_error'],
      [1008, 'hello_timeout'],
    ]
    for (const [code, reason] of closes) {
      const { clock, net, socket } = connected({ random: () => 0.999 })
      // Within the welcome's 5 s spread: 4,995 ms.
      socket.serverClose(code, reason)
      clock.advance(4_994)
      expect(net.sockets, `${code}`).toHaveLength(1)
      clock.advance(1)
      expect(net.sockets, `${code}`).toHaveLength(2)
      // Then each try that fails waits full jitter, its cap doubling from 1 s to 30 s.
      for (const cap of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
        const count = net.sockets.length
        net.last().serverClose(1006)
        clock.advance(Math.floor(0.999 * cap) - 1)
        expect(net.sockets, `${code} ${cap}`).toHaveLength(count)
        clock.advance(1)
        expect(net.sockets, `${code} ${cap}`).toHaveLength(count + 1)
      }
    }
  })

  it('GW-15 (7) T19 item 11: stalled at 30 s; probes within 5 s, then every 30 s; signed_out signs out', async () => {
    let refusing = false
    const { client, clock, net, seen, setProbe } = setup({ random: () => 0.5, refuse: () => refusing })
    client.start()
    net.last().connect()
    refusing = true
    net.last().serverClose(1006)
    expect(client.status()).toBe('reconnecting')
    clock.advance(29_999)
    expect(client.status()).toBe('reconnecting')
    clock.advance(1)
    expect(client.status()).toBe('stalled')
    clock.advance(2_499)
    expect(seen.probes).toEqual([])
    clock.advance(1)
    expect(seen.probes).toEqual([32_500])
    await flush()
    // signed_in or unknown: keep trying, and ask again in 30 s.
    setProbe(async () => 'unknown')
    clock.advance(30_000)
    await flush()
    expect(seen.probes).toEqual([32_500, 62_500])
    expect(client.status()).toBe('stalled')
    setProbe(async () => 'signed_out')
    clock.advance(30_000)
    await flush()
    expect(seen.signedOut).toBe(1)
    expect(client.status()).toBe('stopped')
    const tried = net.sockets.length
    clock.advance(600_000)
    expect(net.sockets).toHaveLength(tried)
    expect(clock.pending()).toBe(0)
    expect(seen.statuses).toEqual(['live', 'reconnecting', 'stalled', 'stopped'])
  })

  it('GW-15 (7): a welcome ends the episode: live again, and no more probes', async () => {
    let refusing = false
    const { client, clock, net, seen } = setup({ random: () => 0.5, refuse: () => refusing })
    client.start()
    net.last().connect()
    refusing = true
    net.last().serverClose(1006)
    clock.advance(32_500)
    await flush()
    expect(seen.probes).toHaveLength(1)
    refusing = false
    // The next try opens and is welcomed.
    while (net.last().readyState !== 0) clock.advance(1_000)
    net.last().connect()
    expect(client.status()).toBe('live')
    clock.advance(120_000)
    await flush()
    expect(seen.probes).toHaveLength(1)
    expect(seen.statuses).toEqual(['live', 'reconnecting', 'stalled', 'live'])
  })

  it('GW-16 P6: an unknown t or bad JSON is skipped and the socket stays open', () => {
    const { client, clock, socket, seen } = connected()
    client.hold(A)
    clock.advance(250)
    const sub = socket.frames('sub')[0]
    socket.receive('not json')
    socket.receive({ v: 1, t: 'party' })
    socket.receive({ v: 1, t: 'ack', id: 'x', ok: [A], refused: [], retry: [] })
    socket.receive({ v: 9, t: 'ev', topic: A, type: 'message.created', ids: {} })
    socket.onmessage?.(new MessageEvent('message', { data: new ArrayBuffer(4) }))
    expect(socket.closedWith).toBeUndefined()
    expect(client.status()).toBe('live')
    expect(seen.stale).toEqual([])
    socket.ack(sub?.id, { ok: [A] })
    expect(seen.stale).toEqual([A])
  })

  it('GW-17: stop() closes 1000 and leaves no timer', () => {
    const harness = connected({ random: () => 0.5 })
    const { client, clock, net, seen, socket } = harness
    const [releaseA] = holdLive(harness, socket, A)
    // Something of every kind waiting: a reset's refetch, a nudge, a diff, a linger.
    socket.receive({ v: 1, t: 'reset', topics: [A], reason: 'gap' })
    socket.receive({ v: 1, t: 'nudge', what: 'flags' })
    client.hold(B)
    releaseA?.()
    expect(clock.pending()).toBeGreaterThan(0)
    client.stop()
    expect(socket.closedWith).toEqual({ code: 1000, reason: undefined })
    expect(client.status()).toBe('stopped')
    expect(clock.pending()).toBe(0)
    clock.advance(600_000)
    expect(seen.stale).toEqual([A])
    expect(seen.nudges).toEqual([])
    // Stopped for good: the old socket's events, a hold and a start do nothing.
    socket.serverClose(1006)
    client.hold(C)()
    client.start()
    client.resume()
    expect(net.sockets).toHaveLength(1)
    expect(clock.pending()).toBe(0)
  })

  it('GW-18 (1) gateway.ts:192: a welcome with smaller maxTopicsPerFrame, maxTopics or maxFrameBytes changes how subs are split and how many are held; larger values are capped by GATEWAY_LIMITS', () => {
    expect(
      limitsFrom({
        maxTopicsPerFrame: 500,
        maxTopics: 1_000,
        maxFrameBytes: 100_000,
        heartbeatMs: 60_000,
        reconnectSpreadMs: 90_000,
      }),
    ).toEqual({ topicsPerFrame: 50, topicsPerSocket: 100, frameBytes: 4096, heartbeatMs: 25_000, spreadMs: 30_000 })
    expect(
      limitsFrom({
        maxTopicsPerFrame: 3,
        maxTopics: 7,
        maxFrameBytes: 150,
        heartbeatMs: 10_000,
        reconnectSpreadMs: 2_000,
      }),
    ).toEqual({ topicsPerFrame: 3, topicsPerSocket: 7, frameBytes: 150, heartbeatMs: 10_000, spreadMs: 2_000 })
    // Nonsense can't stop every frame or make a ping loop.
    expect(
      limitsFrom({ maxTopicsPerFrame: 0, maxTopics: -1, maxFrameBytes: 0, heartbeatMs: 0, reconnectSpreadMs: -5 }),
    ).toEqual({ topicsPerFrame: 1, topicsPerSocket: 0, frameBytes: 0, heartbeatMs: 1_000, spreadMs: 0 })

    // Held before the welcome, ten topics; the welcome allows 7 a socket and 3 a frame.
    const lower = setup()
    lower.client.start()
    const topics = Array.from({ length: 10 }, (_, i) => topic(i + 1))
    const releases = topics.map(held => lower.client.hold(held))
    const socket = lower.net.last()
    socket.connect({ maxTopicsPerFrame: 3, maxTopics: 7 })
    expect(socket.frames('sub').map(frame => frame.topics)).toEqual([
      topics.slice(0, 3),
      topics.slice(3, 6),
      [topics[6]],
    ])
    // Letting one go makes room for the next held one.
    releases[0]?.()
    lower.clock.advance(3_250)
    expect(socket.sent.slice(-2).map(frame => [frame.t, frame.topics])).toEqual([
      ['unsub', [topics[0]]],
      ['sub', [topics[7]]],
    ])
    // Past the welcome's limit, a new hold is refused.
    expect(lower.client.hold(topic(11))).toBeTypeOf('function')
    expect(lower.seen.warnings).toEqual([expect.stringContaining(topic(11))])

    // A welcome's smaller frame size: every frame fits, and no topic is lost.
    const small = connected({}, { maxFrameBytes: 150 })
    for (const held of topics.slice(0, 5)) small.client.hold(held)
    small.clock.advance(250)
    const subs = small.socket.frames('sub')
    expect(subs.length).toBeGreaterThan(1)
    for (const frame of subs) expect(bytes(frame)).toBeLessThanOrEqual(150)
    expect(subs.flatMap(frame => frame.topics)).toEqual(topics.slice(0, 5))
  })

  it('GW-19 (1)(7): no welcome within 15 s of open closes 4000 and reconnects as a failed attempt', () => {
    const { client, clock, net } = setup({ random: () => 0.999 })
    client.start()
    const socket = net.last()
    // A slow link: the socket opens 20 s after it was made, and the 15 s count from there.
    clock.advance(20_000)
    expect(socket.closedWith).toBeUndefined()
    socket.open()
    expect(socket.frames('hello')).toHaveLength(1)
    clock.advance(14_999)
    expect(socket.closedWith).toBeUndefined()
    clock.advance(1)
    expect(socket.closedWith).toEqual({ code: 4000, reason: 'welcome_timeout' })
    // A failed try waits full jitter from 1 s (999 ms here), not the 30 s spread.
    clock.advance(998)
    expect(net.sockets).toHaveLength(1)
    clock.advance(1)
    expect(net.sockets).toHaveLength(2)
    // The next opens late too, and its welcome arrives in time: live.
    clock.advance(25_000)
    net.last().connect()
    expect(client.status()).toBe('live')
    expect(net.last().closedWith).toBeUndefined()
  })

  it('GW-22 (1)(7) T21 item 4: a socket that hasn’t opened 30 s after it was made closes 4000 and reconnects as a failed attempt', () => {
    const { client, clock, net } = setup({ random: () => 0.999 })
    client.start()
    const socket = net.last()
    clock.advance(29_999)
    expect(socket.closedWith).toBeUndefined()
    clock.advance(1)
    expect(socket.closedWith).toEqual({ code: 4000, reason: 'connect_timeout' })
    // Opening after that changes nothing: the client has let it go.
    socket.open()
    expect(socket.sent).toEqual([])
    // A failed try waits full jitter from 1 s (999 ms here), not the 30 s spread.
    clock.advance(998)
    expect(net.sockets).toHaveLength(1)
    clock.advance(1)
    expect(net.sockets).toHaveLength(2)
    clock.advance(30_000)
    expect(net.sockets[1]?.closedWith).toEqual({ code: 4000, reason: 'connect_timeout' })
  })

  it('GW-20 (6)(7): before any welcome the heartbeat is 25 s and a reconnect waits within a 30 s spread', () => {
    expect(limitsFrom()).toEqual({
      topicsPerFrame: 50,
      topicsPerSocket: 100,
      frameBytes: 4096,
      heartbeatMs: 25_000,
      spreadMs: 30_000,
    })
    const { client, clock, net } = setup({ random: () => 0.999 })
    client.start()
    const socket = net.last()
    socket.open()
    clock.advance(1_000)
    socket.serverClose(1006)
    // 0.999 × 30 s.
    clock.advance(29_969)
    expect(net.sockets).toHaveLength(1)
    clock.advance(1)
    expect(net.sockets).toHaveLength(2)
    // A welcome can't stretch the heartbeat past 25 s.
    const next = net.last()
    next.connect({ heartbeatMs: 60_000 })
    clock.advance(24_999)
    expect(next.frames('ping')).toHaveLength(0)
    clock.advance(1)
    expect(next.frames('ping')).toHaveLength(1)
  })

  it('GW-21 T19 item 10 P5: every frame the client sends reads with the server’s strict schemas: hello first, then sub, unsub and ping as ClientFrame', () => {
    const { client, clock, net } = setup()
    client.start()
    const socket = net.last()
    socket.connect()
    const release = client.hold(A)
    client.hold(B)
    clock.advance(250)
    release()
    clock.advance(3_250)
    clock.advance(25_000)
    client.visible()
    clock.advance(5_000)
    client.visible()
    expect(socket.sent.map(frame => frame.t)).toEqual(['hello', 'sub', 'unsub', 'ping', 'ping'])
    const [hello, ...rest] = socket.sent
    expect(Hello.safeParse(hello).success).toBe(true)
    for (const frame of rest) expect(ClientFrame.safeParse(frame).success, JSON.stringify(frame)).toBe(true)
  })
})
