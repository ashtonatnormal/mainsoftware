import { connect } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { GATEWAY_CLOSE, GATEWAY_LIMITS, type Position } from '@hearth/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { buildApp } from '#src/app.ts'
import { sha256 } from '#src/auth/crypto.ts'
import { SOCKET_RECHECK_MS, SOCKET_REVOKE_MS } from '#src/auth/policy.ts'
import type { SessionIds } from '#src/db/pre-org.ts'
import { createLogger } from '#src/logger.ts'
import type { Conn } from '#src/realtime/frames.ts'
import { gatewayPolicy } from '#src/realtime/policy.ts'
import { attachSocketServer, MAX_FRAME_BYTES, RECHECK_TIMEOUT_MS } from '#src/realtime/socket.ts'
import { grainStart, publishTopicEvent, StreamReader } from '#src/realtime/stream.ts'
import { RevocationLatency } from '#src/revocation/latency.ts'
import {
  APP_ORIGIN,
  connected,
  FakeChecks,
  fakeStream,
  known,
  ORG,
  opened,
  open as openSocket,
  orgTopic,
  personTopic,
  refused,
  signedIn,
  startGateway,
  TEAM,
  teamTopic,
  until,
} from '#src/testing/gateway.ts'
import { captureLogger } from '#src/testing/logs.ts'
import { fakeStreams } from '#src/testing/streams.ts'

const USER_CONTENT_ORIGIN = 'https://content.hearth.example.net'
const A = known(1)
const B = known(2)
const UNKNOWN_TOKEN = 'u'.repeat(43)
const team = (n: number) => `team:c0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

// A client error that reached the process would end the realtime role (main.ts exits on one), and a
// timer with a negative delay or a listener leak prints a plain-text warning, which the JSON-only
// log rule refuses (P9).
const uncaught = vi.fn()
const warnings: Error[] = []
const onWarning = (warning: Error) => warnings.push(warning)
beforeAll(() => {
  process.on('uncaughtException', uncaught)
  process.on('warning', onWarning)
})
afterAll(() => {
  process.off('uncaughtException', uncaught)
  process.off('warning', onWarning)
})

const running: FastifyInstance[] = []
async function start(...args: Parameters<typeof startGateway>) {
  const gateway = await startGateway({
    latency: new RevocationLatency({ logger: createLogger({ logLevel: 'silent', role: 'realtime' }), summaryMs: 0 }),
    ...args[0],
  })
  running.push(gateway.app)
  return gateway
}
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const app of running.splice(0)) await app.close()
  // Cleared each time, so a failure names the test that caused it.
  const errors = uncaught.mock.calls.map(([error]) => error)
  uncaught.mockClear()
  expect(errors).toEqual([])
  expect(warnings.splice(0).map(warning => warning.name)).toEqual([])
})

// A lookup a test answers by hand: each call waits until released.
function heldLookup(answer: (tokenHash: Buffer) => SessionIds | undefined = () => A.session) {
  const waiting: (() => void)[] = []
  let running = 0
  let most = 0
  const lookup = vi.fn(async (tokenHash: Buffer) => {
    running++
    most = Math.max(most, running)
    await new Promise<void>(resolve => waiting.push(resolve))
    running--
    return answer(tokenHash)
  })
  return {
    lookup,
    asked: () => lookup.mock.calls.length,
    most: () => most,
    release: () => {
      for (const resolve of waiting.splice(0)) resolve()
    },
  }
}

describe('C0.5 T5 the WebSocket upgrade: path, Origin, then session (CLAUDE.md, Security and privacy)', () => {
  it('answers an upgrade to any other path 404', async () => {
    const { port, server, lookup } = await start()
    const response = await refused(`ws://127.0.0.1:${port}/elsewhere`, signedIn())
    expect(response.status).toBe(404)
    expect(JSON.parse(response.body)).toEqual({ error: 'not_found' })
    expect(lookup).not.toHaveBeenCalled()
    expect(server.counts().refused.path).toBe(1)
  })

  it('refuses a cross-origin upgrade 403: no Origin, "null", the user-content origin and any other, without a lookup', async () => {
    const { url, server, lookup } = await start()
    const cookie = signedIn().cookie
    const cases: Array<Record<string, string>> = [
      { cookie },
      { cookie, origin: 'null' },
      { cookie, origin: USER_CONTENT_ORIGIN },
      { cookie, origin: 'https://evil.example' },
      { cookie, origin: `${APP_ORIGIN}/` },
    ]
    for (const headers of cases) {
      const response = await refused(url, headers)
      expect(response.status, headers.origin).toBe(403)
      expect(response.headers['content-type']).toBe('application/json')
      expect(JSON.parse(response.body)).toEqual({ error: 'forbidden' })
    }
    expect(lookup).not.toHaveBeenCalled()
    expect(server.counts().refused.origin).toBe(cases.length)
  })

  it('refuses 401 signed_out without a session cookie, and for a token with no live session', async () => {
    const { url, server, lookup } = await start()
    const none = await refused(url, { origin: APP_ORIGIN })
    expect(none.status).toBe(401)
    expect(JSON.parse(none.body)).toEqual({ error: 'signed_out' })
    expect(lookup).not.toHaveBeenCalled()
    const unknown = await refused(url, signedIn(UNKNOWN_TOKEN))
    expect(unknown.status).toBe(401)
    // The lookup gets the token's SHA-256, never the token.
    expect(lookup).toHaveBeenCalledWith(sha256(UNKNOWN_TOKEN))
    expect(server.counts().refused.session).toBe(2)
  })

  it('refuses 503 unavailable when the lookup fails, or takes longer than its time limit', async () => {
    const failing = await start({
      lookup: async () => {
        throw new Error('connection refused')
      },
    })
    const failed = await refused(failing.url, signedIn())
    expect(failed.status).toBe(503)
    expect(JSON.parse(failed.body)).toEqual({ error: 'unavailable' })
    expect(failed.body).not.toContain('connection refused')

    const slow = await start({
      lookup: () => new Promise(() => {}),
      lookupTimeoutMs: 50,
      policy: { lookupReserveMs: 10 },
    })
    const started = Date.now()
    const timedOut = await refused(slow.url, signedIn())
    expect(timedOut.status).toBe(503)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(slow.server.counts().refused.error).toBe(1)
  })

  it('T19 item 14: opens (101) for a live session from the app origin, logging the session id at debug only and never the token', async () => {
    const { url, server, lines } = await start()
    const client = await opened(url)
    expect(client.ws.readyState).toBe(WebSocket.OPEN)
    expect(server.counts().open).toBe(1)
    expect(lines).toContainEqual(
      expect.objectContaining({ event: 'ws_open', level: 20, sessionId: A.session.sessionId }),
    )
    // No line above debug names a session or a person.
    const loud = JSON.stringify(lines.filter(line => (line.level as number) > 20))
    expect(loud).not.toContain(A.session.sessionId)
    expect(loud).not.toContain(A.session.userId)
    expect(JSON.stringify(lines)).not.toContain(A.token)
    client.ws.close()
    await until(() => server.counts().open === 0)
  })

  it('still serves plain HTTP on the same port: the probes, and 404 for a GET to /ws that is no upgrade', async () => {
    const { port } = await start()
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200)
    expect((await fetch(`http://127.0.0.1:${port}/ws`)).status).toBe(404)
  })

  it('T14: refuses a session’s 9th socket 429, and takes another once one closes', async () => {
    const { url, server } = await start()
    const sockets = []
    for (let i = 0; i < 8; i++) sockets.push(await opened(url))
    const ninth = await refused(url, signedIn())
    expect(ninth.status).toBe(429)
    expect(JSON.parse(ninth.body)).toEqual({ error: 'too_many_requests' })
    expect(server.counts().refused.busySession).toBe(1)
    // Another session isn't held to this one's count.
    await opened(url, signedIn(B.token))
    sockets[0]?.ws.close()
    await until(() => server.counts().open === 8)
    await opened(url)
  })
})

describe('C0.7 T19 item 11 S3 S4 M1: the connection budget', () => {
  it('S4: a person’s 41st socket is refused 429, across their sessions', async () => {
    // Six of one person's sessions, eight sockets each at most.
    const mine = Array.from({ length: 6 }, (_, i) => known(i + 1, 1))
    const byHash = new Map(mine.map(k => [sha256(k.token).toString('hex'), k.session]))
    const { url, server } = await start({ lookup: async hash => byHash.get(hash.toString('hex')) })
    for (let i = 0; i < 40; i++) await opened(url, signedIn(mine[Math.floor(i / 8)]?.token))
    const extra = await refused(url, signedIn(mine[5]?.token))
    expect(extra.status).toBe(429)
    expect(server.counts().refused).toMatchObject({ busyPerson: 1, busySession: 0 })
  })

  it('S3: at the process cap an upgrade is refused 503 before its lookup; six pending at cap − 1 open one, and the rest get 503 full', async () => {
    const held = heldLookup()
    const { url, server } = await start({ lookup: held.lookup, policy: { maxSocketsPerProcess: 3 } })
    const answer = openSocket
    // Two open, one place left.
    const first = answer(url)
    const second = answer(url)
    await until(() => held.asked() === 2)
    held.release()
    await Promise.all([first, second])
    expect(server.counts().open).toBe(2)
    const pending = Array.from({ length: 6 }, () => answer(url))
    // Five lookups run, the sixth waits for a slot.
    await until(() => held.asked() === 7)
    await delay(50)
    expect(held.asked()).toBe(7)
    held.release()
    await until(() => held.asked() === 8)
    held.release()
    const results = await Promise.all(pending)
    expect(results.filter(r => 'client' in r)).toHaveLength(1)
    expect(results.filter(r => 'status' in r && r.status === 503)).toHaveLength(5)
    expect(server.counts()).toMatchObject({ open: 3, refused: expect.objectContaining({ full: 5 }) })
    // Full now: refused before anything is looked up.
    const asked = held.asked()
    expect((await refused(url, signedIn())).status).toBe(503)
    expect(held.asked()).toBe(asked)
  })

  it('M1: a lookup that never answers is refused 503 at its limit and keeps its slot; with five such a sixth waits in the queue and is refused 503, and no more than five ever run', async () => {
    let runningNow = 0
    let most = 0
    const lookup = vi.fn(() => {
      runningNow++
      most = Math.max(most, runningNow)
      return new Promise<SessionIds | undefined>(() => {})
    })
    const { url, server } = await start({ lookup, lookupTimeoutMs: 200, policy: { lookupReserveMs: 50 } })
    const started = Date.now()
    const answers = await Promise.all(Array.from({ length: 5 }, () => refused(url, signedIn())))
    expect(answers.map(a => a.status)).toEqual([503, 503, 503, 503, 503])
    expect(Date.now() - started).toBeLessThan(1500)
    // The five abandoned lookups still hold their slots: the sixth never gets to run.
    const sixth = await refused(url, signedIn())
    expect(sixth.status).toBe(503)
    expect(lookup).toHaveBeenCalledTimes(5)
    expect(most).toBe(5)
    expect(server.counts().refused.error).toBe(6)
  })

  it('M1: an upgrade stops waiting for a slot its reserve before its limit, and its lookup never runs', async () => {
    const held = heldLookup()
    const { url, server } = await start({
      lookup: held.lookup,
      lookupTimeoutMs: 400,
      policy: { lookupsRunning: 1, lookupReserveMs: 200 },
    })
    const first = openSocket(url)
    await until(() => held.asked() === 1)
    const started = Date.now()
    const second = await refused(url, signedIn())
    // Refused when 200 ms were left, not at the 400 ms limit, and without a lookup of its own: one
    // granted then would have had too little time to answer.
    expect(second.status).toBe(503)
    expect(Date.now() - started).toBeLessThan(350)
    held.release()
    expect('client' in (await first)).toBe(true)
    expect(held.asked()).toBe(1)
    expect(server.counts().refused.error).toBe(1)
  })

  it('M1: a slot handed over with less than the reserve left goes straight back, and its lookup never runs', async () => {
    const held = heldLookup()
    const { url, server, events } = await start({
      lookup: held.lookup,
      lookupTimeoutMs: 1000,
      policy: { lookupsRunning: 1, lookupReserveMs: 500 },
    })
    const first = openSocket(url)
    await until(() => held.asked() === 1)
    const second = refused(url, signedIn(B.token))
    // The second waits in the queue, its own timer 500 ms away.
    await delay(50)
    // The gateway's clock moves 700 ms on before that timer runs, as when a busy event loop runs
    // the release first: the slot reaches the waiter with about 250 ms left, under the reserve.
    const real = performance.now.bind(performance)
    vi.spyOn(performance, 'now').mockImplementation(() => real() + 700)
    held.release()
    expect((await second).status).toBe(503)
    expect('client' in (await first)).toBe(true)
    // No lookup of its own, and refused as one that queued past its time.
    expect(held.asked()).toBe(1)
    expect(events('ws_lookup_timed_out')).toMatchObject([{ queued: true }])
    // The slot came back: the next upgrade's lookup runs, and it opens.
    const third = openSocket(url, signedIn(B.token))
    await until(() => held.asked() === 2)
    held.release()
    expect('client' in (await third)).toBe(true)
    expect(server.counts().refused.error).toBe(1)
  })

  it('M1: under sustained overload of a slow database, every lookup that runs ends in an open, and upgrades keep getting through', async () => {
    // One lookup at a time, 25 ms each (40 a second), against upgrades at about twice that for
    // about a second. The queue holds more than the limit's worth, so without the reserve its
    // oldest waiter would get each slot as it ran out of time.
    let n = 0
    const lookup = vi.fn(async () => {
      await delay(25)
      n++
      const hex = (prefix: string) => `${prefix}-0000-4000-8000-${(0x1000 + n).toString(16).padStart(12, '0')}`
      return { sessionId: hex('b0000001'), orgId: ORG, userId: hex('b0000002'), deviceId: hex('b0000003') }
    })
    const { url, server } = await start({
      lookup,
      lookupTimeoutMs: 400,
      policy: { lookupsRunning: 1, lookupsWaiting: 40, lookupReserveMs: 200 },
    })
    const pending: Promise<Awaited<ReturnType<typeof openSocket>>>[] = []
    for (let i = 0; i < 80; i++) {
      pending.push(openSocket(url))
      await delay(12)
    }
    const results = await Promise.all(pending)
    const opened = results.map(result => 'client' in result)
    // No lookup's answer was thrown away.
    expect(opened.filter(Boolean)).toHaveLength(lookup.mock.calls.length)
    expect(opened.filter(Boolean).length).toBeGreaterThanOrEqual(20)
    // And the later half still got through, rather than only the first few.
    expect(opened.slice(40).filter(Boolean).length).toBeGreaterThan(0)
    expect(server.counts().open).toBe(opened.filter(Boolean).length)
  })

  it('M1: with every slot taken and the queue full, an upgrade is refused 503 full at once', async () => {
    const held = heldLookup()
    const { url, server } = await start({ lookup: held.lookup, policy: { lookupsRunning: 1, lookupsWaiting: 1 } })
    const answer = openSocket
    const running = answer(url)
    const waiting = answer(url)
    await until(() => held.asked() === 1)
    await delay(50)
    const third = await refused(url, signedIn())
    expect(third.status).toBe(503)
    expect(server.counts().refused.full).toBe(1)
    held.release()
    await until(() => held.asked() === 2)
    held.release()
    await Promise.all([running, waiting])
  })
})

describe('C0.7 T19 item 6 S3 m1 P12: the upgrade races', () => {
  it('S3: a session revoked while its upgrade’s lookup is pending is refused 401', async () => {
    const held = heldLookup()
    const { url, server } = await start({ lookup: held.lookup })
    const answer = openSocket(url)
    await until(() => held.asked() === 1)
    expect(server.closeSessions([A.session.sessionId], { path: 'push', cause: 'sessions_ended', at: Date.now() })).toBe(
      0,
    )
    held.release()
    const result = await answer
    expect('status' in result && result.status).toBe(401)
    expect(server.counts().refused.session).toBe(1)
  })

  it('T19 item 6: a people signal that arrives during the lookup re-checks the person once the socket opens', async () => {
    const held = heldLookup()
    const { url, server, checks } = await start({ lookup: held.lookup })
    const answer = openSocket(url)
    await until(() => held.asked() === 1)
    server.peopleChanged(ORG, [A.session.userId], { path: 'push', cause: 'keys_changed', at: Date.now() })
    held.release()
    await answer
    await until(() => checks.calls.some(call => call.request.sessions.includes(A.session.sessionId)))
  })

  it('a socket opened without a signal, and with no admission hook, is checked only by the periodic check', async () => {
    const { url, checks } = await start()
    await connected(url)
    await delay(200)
    expect(checks.calls).toEqual([])
  })
})

describe('C0.7 T19 item 10 GW-14 P5 P7: hello, versions and frames', () => {
  it('GW-14: hello gets welcome with the version, the limits and the spread', async () => {
    const { url } = await start()
    const client = await opened(url)
    const welcome = await client.hello()
    expect(welcome).toEqual({
      v: 1,
      t: 'welcome',
      socket: expect.stringMatching(/^[0-9a-f-]{36}$/),
      heartbeatMs: 25_000,
      maxTopics: 100,
      maxTopicsPerFrame: 50,
      maxFrameBytes: 4096,
      reconnectSpreadMs: 5000,
    })
  })

  it('P7: no hello in time closes with 1008 hello_timeout', async () => {
    const { url, server } = await start({ policy: { helloTimeoutMs: 100 } })
    const client = await opened(url)
    expect(await client.closed).toEqual(GATEWAY_CLOSE.helloTimeout)
    expect(server.counts().closedPolicy).toBe(1)
  })

  it('GW-14: a frame before hello, a binary frame and a frame that isn’t JSON close with 1008 bad_frame', async () => {
    const { url } = await start()
    const early = await opened(url)
    early.send({ v: 1, t: 'ping' })
    expect(await early.closed).toEqual(GATEWAY_CLOSE.badFrame)
    const binary = await opened(url)
    binary.ws.send(Buffer.from('{"v":1,"t":"hello","versions":[1]}'))
    expect(await binary.closed).toEqual(GATEWAY_CLOSE.badFrame)
    const text = await opened(url)
    text.send('not json')
    expect(await text.closed).toEqual(GATEWAY_CLOSE.badFrame)
    // After hello: a second hello, another version, an extra field, an unknown t.
    for (const frame of [
      { v: 1, t: 'hello', versions: [1] },
      { v: 2, t: 'ping' },
      { v: 1, t: 'ping', extra: true },
      { v: 1, t: 'publish' },
    ]) {
      const client = await connected(url)
      client.send(frame)
      expect(await client.closed, JSON.stringify(frame)).toEqual(GATEWAY_CLOSE.badFrame)
    }
  })

  it('P5: with the server speaking [2, 3], a client of [1] gets 4426, one of [4] gets 1013, and one of [1, 3] gets welcome in 3', async () => {
    const { url, server } = await start({ versions: [2, 3] })
    const old = await opened(url)
    old.send({ v: 1, t: 'hello', versions: [1] })
    expect(await old.closed).toEqual(GATEWAY_CLOSE.clientOutdated)
    const newer = await opened(url)
    newer.send({ v: 4, t: 'hello', versions: [4] })
    expect(await newer.closed).toEqual(GATEWAY_CLOSE.tryAgain)
    // A v3 frame: this build's clients read v1 only, so it is read raw here.
    const both = await opened(url)
    both.send({ v: 3, t: 'hello', versions: [1, 3] })
    const raw = (await both.next('unreadable')) as unknown as { text: string }
    expect(JSON.parse(raw.text)).toMatchObject({ v: 3, t: 'welcome' })
    expect(server.counts()).toMatchObject({ closedOutdated: 1, closedVersionNewer: 1 })
  })

  it('P7: the bucket is full at open, so 20 frames at once pass and the 21st closes with 1008 too_many_frames', async () => {
    const { url } = await start()
    const client = await opened(url)
    client.send({ v: 1, t: 'hello', versions: [1] })
    for (let i = 0; i < 19; i++) client.send({ v: 1, t: 'ping' })
    client.send({ v: 1, t: 'ping' })
    expect(await client.closed).toEqual(GATEWAY_CLOSE.tooManyFrames)
    expect(client.all('welcome')).toHaveLength(1)
    expect(client.all('pong')).toHaveLength(19)
  })

  it('S2 T19 item 11: with two subs of 50 still deciding, a third sub of one topic closes with 1008 too_many_topics', async () => {
    const { url, checks } = await start()
    checks.hold()
    const client = await connected(url)
    client.send({ v: 1, t: 'sub', id: 1, topics: Array.from({ length: 50 }, (_, i) => team(i + 1)) })
    client.send({ v: 1, t: 'sub', id: 2, topics: Array.from({ length: 50 }, (_, i) => team(i + 51)) })
    client.send({ v: 1, t: 'sub', id: 3, topics: [team(101)] })
    expect(await client.closed).toEqual(GATEWAY_CLOSE.tooManyTopics)
    checks.release()
  })

  it('a frame of exactly 4 KiB passes ws’s limit and is read: a padded hello gets welcome', async () => {
    const { url, server } = await start()
    const client = await opened(url)
    const base = JSON.stringify({ v: 1, t: 'hello', versions: [1], pad: '' })
    const hello = JSON.stringify({ v: 1, t: 'hello', versions: [1], pad: 'x'.repeat(MAX_FRAME_BYTES - base.length) })
    expect(hello.length).toBe(MAX_FRAME_BYTES)
    client.send(hello)
    await client.next('welcome')
    expect(server.counts().open).toBe(1)
  })
})

describe('C0.7 T19 item 11 P9: sending, backpressure and the idempotent close', () => {
  it('T19 item 11: past 256 KiB buffered a nudge is shed; past 1 MiB the socket closes with 4408; and so it does after 10 s past the soft mark', async () => {
    const { url, server } = await start({ policy: { softBufferMs: 100 } })
    const buffered = vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get')
    const client = await connected(url)
    buffered.mockReturnValue(300 * 1024)
    server.nudge(ORG, 'flags')
    await delay(50)
    expect(client.all('nudge')).toEqual([])
    expect(server.counts().shed).toBe(1)
    buffered.mockReturnValue(1024 * 1024)
    client.send({ v: 1, t: 'ping' })
    expect(await client.closed).toEqual(GATEWAY_CLOSE.tooSlow)
    expect(server.counts().closedSlow).toBe(1)

    // Soft for too long: the first frame past the soft mark goes, one 100 ms later closes.
    buffered.mockReturnValue(0)
    const slow = await connected(url)
    buffered.mockReturnValue(300 * 1024)
    slow.send({ v: 1, t: 'ping' })
    await slow.next('pong')
    await delay(150)
    slow.send({ v: 1, t: 'ping' })
    expect(await slow.closed).toEqual(GATEWAY_CLOSE.tooSlow)
    expect(server.counts().closedSlow).toBe(2)
  })

  it('P9: 600 sends to a socket past 1 MiB close it once, count it once, and add no listener', async () => {
    const stream = fakeStream()
    const { url, server, checks } = await start({ stream: stream.factory })
    checks.allow(A.session.userId, teamTopic())
    const client = await connected(url)
    expect((await client.sub([teamTopic()])).ok).toEqual([teamTopic()])
    const [conn] = stream.holders(ORG, teamTopic())
    if (conn === undefined) throw new Error('no socket holds the topic')
    const listeners = conn.ws.listenerCount('close')
    expect(listeners).toBe(1)
    vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockReturnValue(2 * 1024 * 1024)
    for (let i = 0; i < 600; i++) stream.target().send(conn, '{}')
    expect(server.counts().closedSlow).toBe(1)
    expect(conn.ws.listenerCount('close')).toBe(listeners)
    expect((await client.closed).code).toBe(4408)
  })

  it('P7: a frame over 4 KiB closes that socket with 1009 (or 1006) and no other, and the server cuts it within 1 s', async () => {
    const { url, server } = await start()
    const sender = await connected(url)
    const bystander = await connected(url, B.token)
    sender.ws.send('x'.repeat(MAX_FRAME_BYTES + 1))
    const closed = await sender.closed
    expect([1006, 1009]).toContain(closed.code)
    await until(() => server.counts().open === 1, 1500)
    expect(server.counts().closedError).toBe(1)
    expect(bystander.ws.readyState).toBe(WebSocket.OPEN)
    bystander.send({ v: 1, t: 'ping' })
    await bystander.next('pong')
  })
})

describe('C0.7 P9: computed delays', () => {
  it('P9: every delay the gateway sets is at least 1 ms, a lookup that queued past its limit and a nudge due at once included', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout')
    let release: () => void = () => {}
    let calls = 0
    const lookup = vi.fn(async () => {
      calls++
      // The first lookup holds the one slot for longer than the second's whole limit.
      if (calls === 1)
        await new Promise<void>(resolve => {
          release = resolve
        })
      return A.session
    })
    const { url, server } = await start({
      lookup,
      lookupTimeoutMs: 100,
      policy: { lookupsRunning: 1, lookupReserveMs: 20, nudgeCoalesceMs: 50 },
    })
    const first = openSocket(url)
    await until(() => calls === 1)
    const second = openSocket(url)
    await delay(120)
    release()
    await Promise.all([first, second])
    const client = await connected(url, B.token)
    for (let i = 0; i < 3; i++) server.nudge(ORG, 'flags')
    await delay(100)
    client.ws.close()
    await until(() => server.counts().open <= 1)
    const delays = spy.mock.calls.map(([, ms]) => ms).filter(ms => ms !== undefined)
    expect(delays.length).toBeGreaterThan(0)
    expect(delays.filter(ms => Number(ms) < 1)).toEqual([])
  })
})

describe('C0.7 T19 item 12 GW-08: the heartbeat', () => {
  it('GW-08: the server pings after the heartbeat, cuts a socket silent past the dead limit, and an app ping keeps one alive', async () => {
    const { url, server } = await start({ policy: { heartbeatMs: 100, deadAfterMs: 250, heartbeatSweepMs: 20 } })
    const quiet = new WebSocket(url, { headers: signedIn(), perMessageDeflate: false, autoPong: false })
    const pinged = new Promise(resolve => quiet.once('ping', resolve))
    const quietClosed = new Promise<number>(resolve => quiet.once('close', code => resolve(code)))
    await new Promise(resolve => quiet.once('open', resolve))
    quiet.send(JSON.stringify({ v: 1, t: 'hello', versions: [1] }))
    const live = await connected(url, B.token)
    const started = Date.now()
    await pinged
    expect(Date.now() - started).toBeLessThan(250)
    // Nothing heard from the quiet one: no pong (autoPong is off), no frame.
    expect(await quietClosed).toBe(1006)
    expect(Date.now() - started).toBeLessThan(600)
    expect(server.counts().closedDead).toBe(1)
    // The other answers pings itself (ws's autoPong), and app pings reset its clock too.
    for (let i = 0; i < 4; i++) {
      live.send({ v: 1, t: 'ping' })
      await live.next('pong')
      await delay(120)
    }
    expect(live.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('GW-08 T19 item 9: pong carries the position the stream reports (null before it has one), never its current one, and the spread', async () => {
    const stream = fakeStream()
    const { url } = await start({ stream: stream.factory })
    const client = await connected(url)
    client.send({ v: 1, t: 'ping' })
    expect(await client.next('pong')).toEqual({ v: 1, t: 'pong', pos: null, reconnectSpreadMs: 5000 })
    const epoch = 'e0000000-0000-4000-8000-000000000001'
    stream.positions.set(ORG, { epoch, pos: '1800000012345-3' })
    stream.reported.set(ORG, { epoch, pos: '1799999975000-0' })
    client.send({ v: 1, t: 'ping' })
    expect(await client.next('pong')).toEqual({
      v: 1,
      t: 'pong',
      pos: { epoch, pos: '1799999975000-0' },
      reconnectSpreadMs: 5000,
    })
  })

  it('T19 item 9: an event on a person topic the socket was refused, published mid-grain, moves neither pong’s nor an unsub’s ack’s position; at the next grain’s start both move to the grain before’s start, as with no event', async () => {
    // A 1 s grain, so the test waits for at most two of them; the reader runs on the fake Valkey.
    const grain = 1000
    const policy = gatewayPolicy({ positionGrainMs: grain })
    const streams = fakeStreams()
    const prefix = 'it:unit:'
    const logger = createLogger({ logLevel: 'silent', role: 'realtime' })
    let reader: StreamReader<Conn> | undefined
    const { url } = await start({
      policy: { positionGrainMs: grain },
      stream: target => {
        reader = new StreamReader({
          valkey: streams.asClient,
          reader: streams.asReader,
          keyPrefix: prefix,
          target,
          logger,
          policy,
        })
        return reader
      },
    })
    const client = await connected(url)
    expect((await client.sub([personTopic(1)])).ok).toEqual([personTopic(1)])
    expect((await client.sub([personTopic(2)])).refused).toEqual([personTopic(2)])
    const told = async () => {
      client.send({ v: 1, t: 'ping' })
      const pong = (await client.next('pong')).pos
      const ack = (await client.unsub([orgTopic()])).pos
      expect(ack).toEqual(pong)
      return (pong as Position).pos
    }
    // A moment into a grain.
    await delay(grain - (Date.now() % grain) + 100)
    const begun = grainStart(Date.now(), grain)
    expect(await told()).toBe(`${begun - grain}-0`)
    const id = await publishTopicEvent(
      streams.asClient,
      prefix,
      ORG,
      { topic: personTopic(2), type: 'inbox.changed', ids: {} },
      logger,
      { rethrow: true },
    )
    await until(() => reader?.current(ORG)?.pos === id)
    expect(await told()).toBe(`${begun - grain}-0`)
    // Still the same grain, so the event's arrival is the only thing that happened in between.
    expect(grainStart(Date.now(), grain)).toBe(begun)
    await delay(begun + grain - Date.now() + 100)
    expect(await told()).toBe(`${begun}-0`)
    expect(client.all('ev')).toEqual([])
    expect(JSON.stringify(client.frames)).not.toContain(String(id))
  })

  it('T19 item 11: a protocol ping is answered with its data, and one past the bucket closes the socket with 1008 too_many_frames, so a client that floods pings gets at most the burst’s pongs', async () => {
    const { url, server } = await start()
    const client = await connected(url)
    const pongs: string[] = []
    client.ws.on('pong', data => pongs.push(data.toString()))
    client.ws.ping(Buffer.from('first'))
    await until(() => pongs.length === 1)
    expect(pongs).toEqual(['first'])
    // 125 bytes each, the most a control frame may carry, sent without waiting.
    for (let i = 0; i < 100; i++) client.ws.ping(Buffer.alloc(125, 'p'))
    expect(await client.closed).toEqual(GATEWAY_CLOSE.tooManyFrames)
    // The burst of 20 (hello took one), and what refilled meanwhile: never one a ping.
    expect(pongs.length).toBeLessThanOrEqual(GATEWAY_LIMITS.frameBurst)
    expect(server.counts().closedPolicy).toBe(1)
  })

  it('T19 item 11: a pong the server didn’t ask for takes a token, so a flood of them closes the socket; the one answering its ping is free', async () => {
    // A bucket of 5 refilled at 1 a second, and a ping every 100 ms.
    const { url } = await start({
      policy: { heartbeatMs: 100, deadAfterMs: 250, heartbeatSweepMs: 20, frameBurst: 5, framesPerSecond: 1 },
    })
    const answering = await connected(url)
    // ws answers each of the server's pings itself: about 12 pongs, past what the bucket holds, and
    // all free.
    await delay(1200)
    expect(answering.ws.readyState).toBe(WebSocket.OPEN)
    const flooding = await connected(url, B.token)
    for (let i = 0; i < 30; i++) flooding.ws.pong()
    expect(await flooding.closed).toEqual(GATEWAY_CLOSE.tooManyFrames)
  })

  it('T19 item 11: the heartbeat sweep holds every socket to the send-buffer marks, so one past 1 MiB closes with 4408 though nothing is sent to it; and pings and pongs go through the marks', async () => {
    const { url, server } = await start({
      policy: { heartbeatMs: 59_000, deadAfterMs: 3_600_000, heartbeatSweepMs: 20 },
    })
    const buffered = vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get')
    const client = await connected(url)
    // Past the soft mark a client's ping goes unanswered (a pong is droppable), and is counted.
    buffered.mockReturnValue(300 * 1024)
    const pongs: Buffer[] = []
    client.ws.on('pong', data => pongs.push(data))
    client.ws.ping()
    await until(() => server.counts().shed === 1)
    expect(pongs).toEqual([])
    buffered.mockReturnValue(2 * 1024 * 1024)
    expect(await client.closed).toEqual(GATEWAY_CLOSE.tooSlow)
    expect(server.counts().closedSlow).toBe(1)
  })
})

describe('C0.5 T5 ACC-05 C0.7 T19 item 8: closing a session’s sockets', () => {
  it('closes every socket of a revoked session with 4401 signed_out, and no other, and records its latency', async () => {
    const { url, server, lines } = await start()
    const first = await connected(url)
    const second = await connected(url)
    const other = await connected(url, B.token)
    expect(server.closeSessions([A.session.sessionId], { path: 'push', cause: 'sessions_ended', at: Date.now() })).toBe(
      2,
    )
    expect(await first.closed).toEqual({ code: 4401, reason: 'signed_out' })
    expect(await second.closed).toEqual({ code: 4401, reason: 'signed_out' })
    expect(other.ws.readyState).toBe(WebSocket.OPEN)
    await until(() => server.counts().open === 1)
    expect(server.counts()).toMatchObject({ closedRevoked: 2, closedRecheck: 0 })
    expect(lines).toContainEqual(expect.objectContaining({ event: 'ws_closed', cause: 'revoked', sockets: 2 }))
    // Telling it again, or naming a session with no socket here, closes nothing.
    expect(
      server.closeSessions([A.session.sessionId, 'b0000000-0000-4000-8000-0000000000ff'], {
        path: 'push',
        cause: 'sessions_ended',
      }),
    ).toBe(0)
  })

  it('REG-04 T19 item 13: each close logs revocation_applied with its handler, path, cause and latency, and no person or session id', async () => {
    const { logger, ...capture } = captureLogger('realtime')
    const { url, server } = await start({ latency: new RevocationLatency({ logger, summaryMs: 0 }) })
    await connected(url)
    await connected(url, B.token)
    server.closeSessions([A.session.sessionId], { path: 'push', cause: 'sessions_ended', at: Date.now() - 1500 })
    server.closeSessions([B.session.sessionId], { path: 'durable', cause: 'sessions_ended', at: Date.now() - 2500 })
    expect(capture.events('revocation_applied')).toEqual([
      expect.objectContaining({
        handler: 'sockets',
        path: 'push',
        cause: 'sessions_ended',
        org: ORG,
        count: 1,
        startSource: 'publisher',
        latencyMs: expect.any(Number),
      }),
      // The durable message's at is its signin.ended event's (revocation/registry.ts).
      expect.objectContaining({ handler: 'sockets', path: 'durable', startSource: 'outbox', count: 1 }),
    ])
    expect(capture.events('revocation_applied')[0]?.latencyMs).toBeGreaterThanOrEqual(1500)
    const text = JSON.stringify(capture.lines)
    for (const id of [A.session.sessionId, A.session.userId, B.session.sessionId]) expect(text).not.toContain(id)
    expect(server.counts()).toMatchObject({ closedRevoked: 1, closedDurable: 1 })
  })

  it('REG-04 T19 item 13: gateway_gauges carries the longest revocation latency since its last line, the summary’s exact max, a skipped line’s included', async () => {
    // Only the intervals are fake, so each metrics tick lands when the test says.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { logger, ...capture } = captureLogger('realtime')
    const { url, server, events } = await start({
      latency: new RevocationLatency({ logger, summaryMs: 0 }),
      policy: { metricsMs: 1000 },
    })
    const gauges = () => events('gateway_gauges').map(line => line.longestLatencyMs)
    await connected(url)
    await connected(url, B.token)
    server.closeSessions([A.session.sessionId], { path: 'push', cause: 'sessions_ended', at: Date.now() - 45_000 })
    // The tick reads the window's longest before its summary starts a new window.
    await vi.advanceTimersByTimeAsync(1000)
    const pushed = capture.events('revocation_latency')[0]?.max
    expect(pushed).toBeGreaterThanOrEqual(45_000)
    expect(gauges()).toEqual([pushed])
    // The next window recorded nothing.
    await vi.advanceTimersByTimeAsync(1000)
    expect(gauges()).toEqual([pushed, null])
    // A revocation that closes the last socket: the tick after it writes no gauges, there being no
    // sockets, and the line one tick later still carries its latency.
    server.closeSessions([B.session.sessionId], { path: 'durable', cause: 'sessions_ended', at: Date.now() - 20_000 })
    await until(() => server.counts().open === 0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(gauges()).toHaveLength(2)
    const durable = capture.events('revocation_latency')[1]?.max
    expect(durable).toBeGreaterThanOrEqual(20_000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(gauges()).toEqual([pushed, null, durable])
  })

  it('T19 item 13: the re-check a session message queues records what it finds as its own (recheck, ended), and a people signal’s re-check records the sessions it finds ended under its path with cause ended', async () => {
    const { logger, ...capture } = captureLogger('realtime')
    // Person 1 on two devices, and person 3.
    const [first, second] = [known(1, 1), known(2, 1)]
    const third = known(3)
    const byHash = new Map([first, second, third].map(k => [sha256(k.token).toString('hex'), k.session]))
    const { url, server, checks } = await start({
      lookup: async hash => byHash.get(hash.toString('hex')),
      latency: new RevocationLatency({ logger, summaryMs: 0 }),
    })
    checks.people.set(second.session.sessionId, first.session.userId)
    const a = await connected(url, first.token)
    const b = await connected(url, second.token)
    // The second device's session expired 10 s ago, and nothing named it; the push names the first.
    checks.ended.set(second.session.sessionId, Date.now() - 10_000)
    server.closeSessions([first.session.sessionId], { path: 'push', cause: 'sessions_ended', at: Date.now() })
    expect(await a.closed).toEqual(GATEWAY_CLOSE.signedOut)
    expect(await b.closed).toEqual(GATEWAY_CLOSE.signedOut)
    expect(server.counts()).toMatchObject({ closedRevoked: 1, closedRecheck: 1 })
    const applied = () => capture.events('revocation_applied').map(l => [l.handler, l.path, l.cause, l.startSource])
    expect(applied()).toEqual([
      ['sockets', 'push', 'sessions_ended', 'publisher'],
      ['sockets', 'recheck', 'ended', 'database'],
    ])
    // A people signal (a deactivation's keys change) whose re-check finds the person's session
    // ended: closed under the signal's path, as a session end.
    const c = await connected(url, third.token)
    checks.ended.set(third.session.sessionId, Date.now() - 2000)
    server.peopleChanged(ORG, [third.session.userId], { path: 'durable', cause: 'keys_changed' })
    expect(await c.closed).toEqual(GATEWAY_CLOSE.signedOut)
    expect(server.counts()).toMatchObject({ closedRevoked: 1, closedRecheck: 1, closedDurable: 1 })
    expect(applied().at(-1)).toEqual(['sockets', 'durable', 'ended', 'database'])
  })

  it('§8.3 T19 item 13: a people signal coalesced with a session message’s re-check of the same person gives that re-check the signal’s path', async () => {
    const [first, second] = [known(1, 1), known(2, 1)]
    const byHash = new Map([first, second].map(k => [sha256(k.token).toString('hex'), k.session]))
    const { url, server, checks } = await start({ lookup: async hash => byHash.get(hash.toString('hex')) })
    const person = first.session.userId
    checks.people.set(second.session.sessionId, person)
    checks.allow(person, teamTopic())
    await connected(url, first.token)
    const b = await connected(url, second.token)
    expect((await b.sub([teamTopic()])).ok).toEqual([teamTopic()])
    // Within the 100 ms the queue coalesces for: the first device signed out, then a removal.
    server.closeSessions([first.session.sessionId], { path: 'push', cause: 'sessions_ended', at: Date.now() })
    checks.deny(person, teamTopic())
    server.peopleChanged(ORG, [person], { path: 'push', cause: 'keys_changed', at: Date.now() })
    expect(await b.next('dropped')).toMatchObject({ topics: [teamTopic()] })
    expect(server.counts().dropped).toEqual({ push: 1, durable: 0, recheck: 0 })
  })

  it('the re-check closes a socket whose session has ended, counted as closedRecheck', async () => {
    const { url, server, checks } = await start({ recheckMs: 50 })
    const ending = await connected(url)
    const staying = await connected(url, B.token)
    // Both sessions live: the re-check runs and closes nothing.
    await until(() => checks.calls.length >= 2)
    expect(ending.ws.readyState).toBe(WebSocket.OPEN)
    checks.ended.set(A.session.sessionId, Date.now() - 1000)
    expect(await ending.closed).toEqual({ code: 4401, reason: 'signed_out' })
    expect(staying.ws.readyState).toBe(WebSocket.OPEN)
    await until(() => server.counts().open === 1)
    expect(server.counts()).toMatchObject({ closedRevoked: 0, closedRecheck: 1 })
  })

  it('a re-check that fails closes no socket while it can still be confirmed in time: Postgres being down is no revocation', async () => {
    const { url, server, checks, lines } = await start({ recheckMs: 50 })
    checks.failAlways = new Error('connection refused')
    const client = await connected(url)
    await until(() => checks.calls.length >= 3)
    expect(client.ws.readyState).toBe(WebSocket.OPEN)
    expect(server.counts()).toMatchObject({ open: 1, closedRecheck: 0, closedUnchecked: 0 })
    expect(lines).toContainEqual(expect.objectContaining({ event: 'ws_recheck_failed', level: 50 }))
  })

  it('T5 ACC-05: refuses re-check timings that could not close an ended session within revokeWithinMs', () => {
    const logger = createLogger({ logLevel: 'silent', role: 'realtime' })
    const app = buildApp({ appOrigin: APP_ORIGIN, logger, checks: {} })
    const base = { appOrigin: APP_ORIGIN, logger, lookup: async () => undefined, check: new FakeChecks().check }
    // 50 s plus the 10 s deadline reaches the 60 s limit; 49 s plus 10 s doesn't.
    expect(() => attachSocketServer(app, { ...base, recheckMs: 50_000 })).toThrow(/shorter than revokeWithinMs/)
    expect(() => attachSocketServer(app, { ...base, recheckMs: 100, revokeWithinMs: 200 })).toThrow(
      /shorter than revokeWithinMs/,
    )
    expect(() => attachSocketServer(app, { ...base, recheckMs: 49_000 })).not.toThrow()
    void app.close()
  })

  it('T5 ACC-05: while re-checks keep failing, a socket closes with 1013 at the first failure the next could leave past revokeWithinMs', async () => {
    // A revocation whose message was lost, with Postgres down: only the deadline closes the socket.
    // The ticks and the clock are fake, so each re-check lands at an exact time; the sockets, and
    // each re-check's own deadline timer, stay real.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date', 'performance'] })
    // A re-check every 1 s with a 2 s deadline, against a 10 s limit: a failure at t only keeps the
    // limit if the next re-check settles by t + 3 s, so the socket (confirmed at 0) closes at the
    // first failure after 7 s.
    const { url, server, checks, lines } = await start({
      recheckMs: 1000,
      recheckTimeoutMs: 2000,
      revokeWithinMs: 10_000,
      policy: { heartbeatMs: 59_000, deadAfterMs: 3_600_000 },
    })
    checks.failAlways = new Error('connection refused')
    const client = await connected(url)
    // The host's clock jumping an hour moves no deadline: they run on the monotonic clock.
    vi.setSystemTime(Date.now() + 3_600_000)
    await vi.advanceTimersByTimeAsync(7000)
    expect(checks.calls).toHaveLength(7)
    expect(client.ws.readyState).toBe(WebSocket.OPEN)
    expect(server.counts()).toMatchObject({ closedUnchecked: 0 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(checks.calls).toHaveLength(8)
    expect(await client.closed).toEqual({ code: 1013, reason: 'try again later' })
    await until(() => server.counts().open === 0)
    expect(server.counts()).toMatchObject({ closedUnchecked: 1, closedRecheck: 0, closedRevoked: 0 })
    expect(lines).toContainEqual(expect.objectContaining({ event: 'ws_closed', cause: 'unchecked', sockets: 1 }))
  })

  it('T5 ACC-05 T14: at the production timings one failed re-check closes nothing, even one that hangs to its deadline, and failures in a row close within 60 s', async () => {
    // Every timer and the clock are fake, so a re-check can hang for its full 10 s deadline.
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'],
    })
    // No timing overrides but the heartbeat's, which a fake clock would otherwise run ahead of the
    // real sockets' pongs: SOCKET_RECHECK_MS, RECHECK_TIMEOUT_MS and SOCKET_REVOKE_MS.
    const { url, server, checks } = await start({ policy: { heartbeatMs: 59_000, deadAfterMs: 3_600_000 } })
    const client = await connected(url)
    // The first re-check confirms the session.
    await vi.advanceTimersByTimeAsync(SOCKET_RECHECK_MS)
    const confirmed = SOCKET_RECHECK_MS
    expect(checks.calls).toHaveLength(1)
    // The next hangs until its deadline, the latest a failure can come: nothing closes.
    checks.failNext('hang')
    await vi.advanceTimersByTimeAsync(SOCKET_RECHECK_MS + RECHECK_TIMEOUT_MS)
    expect(checks.calls).toHaveLength(2)
    expect(client.ws.readyState).toBe(WebSocket.OPEN)
    expect(server.counts()).toMatchObject({ closedUnchecked: 0 })
    // With every re-check failing from then on, it closes no later than 60 s after the confirmation.
    checks.failAlways = new Error('connection refused')
    const now = confirmed + SOCKET_RECHECK_MS + RECHECK_TIMEOUT_MS
    await vi.advanceTimersByTimeAsync(confirmed + SOCKET_REVOKE_MS - now)
    expect(await client.closed).toEqual({ code: 1013, reason: 'try again later' })
    expect(server.counts()).toMatchObject({ closedUnchecked: 1 })
  })

  it('T19 item 8: a granted topic confirmed earlier than its session closes its socket with 1013 by the topic’s 60 s, at the production timings', async () => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'],
    })
    const { url, server, checks } = await start({ policy: { heartbeatMs: 59_000, deadAfterMs: 3_600_000 } })
    checks.allow(A.session.userId, teamTopic())
    const withTopic = await connected(url)
    const sub = withTopic.sub([teamTopic()])
    // The lane collects for 20 ms (on the fake clock) once the sub has arrived.
    await until(() => server.counts().topics === 1)
    await vi.advanceTimersByTimeAsync(GATEWAY_DECISION_MS)
    expect((await sub).ok).toEqual([teamTopic()])
    const without = await connected(url, B.token)
    // The first check confirms the sessions but decides no topic (as for a person whose topics the
    // check couldn't load), so the topic stays confirmed only as of its decision, at 0.
    const answer = checks.answer.bind(checks)
    checks.answer = (orgId, request) => ({ ...answer(orgId, request), topics: new Map() })
    await vi.advanceTimersByTimeAsync(SOCKET_RECHECK_MS)
    // Then every check fails: at 30 s the topic could still be confirmed by 60 s; at 45 s it can't.
    checks.failAlways = new Error('connection refused')
    await vi.advanceTimersByTimeAsync(SOCKET_RECHECK_MS)
    expect(withTopic.ws.readyState).toBe(WebSocket.OPEN)
    await vi.advanceTimersByTimeAsync(SOCKET_RECHECK_MS)
    expect(await withTopic.closed).toEqual({ code: 1013, reason: 'try again later' })
    // The socket with only its session, confirmed at 15 s, is still in time.
    expect(without.ws.readyState).toBe(WebSocket.OPEN)
    expect(server.counts()).toMatchObject({ closedUnchecked: 1 })
  })

  it('T5 ACC-05: a re-check that succeeds between failures confirms the session again, so its socket stays', async () => {
    const { url, server, checks } = await start({ recheckMs: 50, revokeWithinMs: 600 })
    // Every third re-check answers; the two in between fail.
    const answer = checks.answer.bind(checks)
    let calls = 0
    checks.answer = (orgId, request) => {
      calls++
      if (calls % 3 !== 0) throw new Error('connection refused')
      return answer(orgId, request)
    }
    const client = await connected(url)
    // Well past 600 ms since the upgrade: only the successful re-checks keep it open.
    await until(() => checks.calls.length >= 24, 5000)
    expect(client.ws.readyState).toBe(WebSocket.OPEN)
    expect(server.counts()).toMatchObject({ open: 1, closedUnchecked: 0 })
  })

  it('T5 ACC-05: a re-check that never answers counts as failed, and the next one still runs and closes an ended session', async () => {
    const { url, server, checks, lines } = await start({ recheckMs: 50 })
    // The first query never answers, as on a connection that died without closing; by the next,
    // the session has ended.
    checks.failNext('hang')
    const client = await connected(url)
    await until(() => checks.calls.length >= 1)
    checks.ended.set(A.session.sessionId, undefined)
    expect(await client.closed).toEqual({ code: 4401, reason: 'signed_out' })
    expect(checks.calls.length).toBeGreaterThanOrEqual(2)
    expect(server.counts()).toMatchObject({ closedRecheck: 1 })
    expect(lines).toContainEqual(expect.objectContaining({ event: 'ws_recheck_failed' }))
  })

  it('T19 item 12 P3: stopping the server refuses upgrades, closes its sockets with 1001 within 1 s, and returns promptly', async () => {
    const { app, url, server } = await start()
    const first = await connected(url)
    const second = await connected(url, B.token)
    const started = Date.now()
    await app.close()
    expect(server.stopping()).toBe(true)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(await first.closed).toEqual({ code: 1001, reason: 'server stopping' })
    expect(await second.closed).toEqual({ code: 1001, reason: 'server stopping' })
    expect(server.counts().closedStopping).toBe(2)
    running.splice(running.indexOf(app), 1)
  })

  it('stopping the server cuts a socket whose client never finishes the closing handshake', async () => {
    const { app, port } = await start()
    // A raw client that completes the upgrade, then never reads or answers anything.
    const socket = connect(port, '127.0.0.1')
    socket.on('error', () => {})
    await new Promise(resolve => socket.once('connect', resolve))
    socket.write(upgradeRequest(A.token))
    const answer = await new Promise<Buffer>(resolve => socket.once('data', resolve))
    expect(answer.toString('latin1')).toMatch(/^HTTP\/1\.1 101 /)
    socket.pause()
    const started = Date.now()
    await app.close()
    expect(Date.now() - started).toBeLessThan(2500)
    running.splice(running.indexOf(app), 1)
    socket.destroy()
  })
})

// How long the decision lane collects asks before it decides (realtime/policy.ts).
const GATEWAY_DECISION_MS = 20

function upgradeRequest(token: string): string {
  return [
    'GET /ws HTTP/1.1',
    'Host: 127.0.0.1',
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    // 16 zero bytes: a valid key that no secret scanner takes for one.
    'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==',
    `Origin: ${APP_ORIGIN}`,
    `Cookie: __Host-hearth_session=${token}`,
    '',
    '',
  ].join('\r\n')
}

describe('C0.5 T14 item 14: no client can end the realtime process', () => {
  it.each([
    ['refuses', undefined],
    ['accepts', A.session],
  ] as const)(
    'a client that resets during a slow lookup, which then %s, leaves the process running',
    async (_outcome, answer) => {
      const held = heldLookup(() => answer)
      const { server, port } = await start({ lookup: held.lookup })
      const socket = connect(port, '127.0.0.1')
      await new Promise(resolve => socket.once('connect', resolve))
      socket.write(upgradeRequest(A.token))
      await until(() => held.asked() === 1)
      socket.resetAndDestroy()
      await delay(50)
      held.release()
      await delay(50)
      await until(() => server.counts().open === 0)
      expect(uncaught).not.toHaveBeenCalled()
    },
  )

  it('T19 item 7: the topics a socket held go with it from every index when it closes', async () => {
    const stream = fakeStream()
    const { url, server, checks } = await start({ stream: stream.factory })
    checks.allow(A.session.userId, teamTopic(TEAM))
    const client = await connected(url)
    await client.sub([teamTopic(TEAM)])
    expect(stream.holders(ORG, teamTopic(TEAM))).toHaveLength(1)
    expect(server.counts().topics).toBe(1)
    client.ws.close()
    await until(() => server.counts().open === 0)
    expect(stream.holders(ORG, teamTopic(TEAM))).toEqual([])
    expect(server.counts().topics).toBe(0)
  })
})
