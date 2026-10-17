// The gateway's protocol on a socket (BUILD-PLAN C0.7, TECH-SPEC T19 items 7-11): sub and unsub,
// generations, re-authorise and refetch (the owner's decision: no replay, no positions; GW-09), the
// reset frame, the flags nudge, and the bucket and marks.
import { setTimeout as delay } from 'node:timers/promises'
import { GATEWAY_CLOSE, ServerFrame } from '@hearth/shared'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { createLogger } from '#src/logger.ts'
import { Coalescer, type Conn, sendFrame, takeToken } from '#src/realtime/frames.ts'
import { GATEWAY_POLICY, gatewayPolicy } from '#src/realtime/policy.ts'
import type { SocketServerOptions } from '#src/realtime/socket.ts'
import { publishTopicEvent, StreamReader } from '#src/realtime/stream.ts'
import {
  connected,
  fakeStream,
  isSubDecision,
  known,
  ORG,
  OTHER_ORG,
  OTHER_TEAM,
  opened,
  orgTopic,
  personTopic,
  startGateway,
  TEAM,
  teamTopic,
  until,
} from '#src/testing/gateway.ts'
import { fakeStreams } from '#src/testing/streams.ts'

const A = known(1)
const ME = A.session.userId
const UNKNOWN_TEAM = teamTopic('c0000000-0000-4000-8000-0000000000ff')

const running: FastifyInstance[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const app of running.splice(0)) await app.close()
})
async function start(options: Partial<SocketServerOptions> = {}) {
  const gateway = await startGateway(options)
  running.push(gateway.app)
  return gateway
}

// A gateway whose stream reader runs on the fake Valkey, as in production, and a publisher of
// entries to its org's stream that answers each entry's stream id.
async function startWithStreams(options: Partial<SocketServerOptions> = {}) {
  const streams = fakeStreams()
  const prefix = 'it:unit:'
  const logger = createLogger({ logLevel: 'silent', role: 'realtime' })
  // Short blocks and checks, so a gap is found within the test's waits.
  const policy = gatewayPolicy({ readerBlockMs: 100, readerEpochCheckMs: 100 })
  const gateway = await start({
    stream: target =>
      new StreamReader({
        valkey: streams.asClient,
        reader: streams.asReader,
        keyPrefix: prefix,
        target,
        logger,
        policy,
      }),
    ...options,
  })
  const publish = async (topic: string, item: string) =>
    String(
      await publishTopicEvent(streams.asClient, prefix, ORG, { topic, type: 'inbox.changed', ids: { item } }, logger, {
        rethrow: true,
      }),
    )
  return { ...gateway, streams, prefix, publish }
}

const item = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const items = (frames: readonly Record<string, unknown>[]) => frames.map(ev => (ev.ids as { item: string }).item)

describe('GW-04 GW-05 PRD-108 T19 item 7: sub and unsub', () => {
  it('GW-04: a person subscribes to their person, org and team topics, acked ok with nothing else', async () => {
    const stream = fakeStream()
    const { url, checks, server } = await start({ stream: stream.factory })
    checks.allow(ME, teamTopic())
    const client = await connected(url)
    expect(await client.sub([personTopic(1), orgTopic(), teamTopic()])).toEqual({
      v: 1,
      t: 'ack',
      id: 1,
      ok: [personTopic(1), orgTopic(), teamTopic()],
      refused: [],
      retry: [],
    })
    // The decision was asked about this socket's own session and person only (GW-13).
    expect(checks.calls[0]?.request.sessions).toEqual([A.session.sessionId])
    expect([...(checks.calls[0]?.request.topics?.keys() ?? [])]).toEqual([ME])
    expect(server.counts().topics).toBe(3)
    expect(stream.watched).toEqual([ORG])
  })

  it('GW-05 PRD-108: another person’s topic, another org’s, a team they aren’t in and an unknown team are refused alike, with no reason', async () => {
    const { url } = await start()
    const client = await connected(url)
    const asked = [personTopic(2), orgTopic(OTHER_ORG), teamTopic(OTHER_TEAM), UNKNOWN_TEAM]
    const ack = await client.sub(asked)
    expect(ack).toEqual({ v: 1, t: 'ack', id: 1, ok: [], refused: asked, retry: [] })
  })

  it('a repeated sub acks what is held without deciding it again; unsub acks every topic named, held or not, any number of times', async () => {
    const { url, checks, server } = await start()
    const client = await connected(url)
    await client.sub([personTopic(1), personTopic(1)])
    expect((await client.sub([personTopic(1)])).ok).toEqual([personTopic(1)])
    expect(checks.calls).toHaveLength(1)
    expect(await client.unsub([personTopic(1), orgTopic()])).toEqual({
      v: 1,
      t: 'ack',
      id: 3,
      ok: [personTopic(1), orgTopic()],
      refused: [],
      retry: [],
    })
    expect((await client.unsub([personTopic(1)])).ok).toEqual([personTopic(1)])
    expect(server.counts().topics).toBe(0)
    // Held no longer: a sub decides it again.
    await client.sub([personTopic(1)])
    expect(checks.calls).toHaveLength(2)
  })

  it('GW-09 T19 item 9: a sub naming a since, a position or an epoch closes with 1008 bad_frame: there is nothing to resume from', async () => {
    const { url, checks } = await start()
    for (const extra of [
      { since: { epoch: 'e0000000-0000-4000-8000-000000000001', pos: '1800000000000-0' } },
      { pos: '1800000000000-0' },
      { epoch: 'e0000000-0000-4000-8000-000000000001' },
    ]) {
      const client = await connected(url)
      client.send({ v: 1, t: 'sub', id: 1, topics: [personTopic(1)], ...extra })
      expect(await client.closed, JSON.stringify(extra)).toEqual(GATEWAY_CLOSE.badFrame)
    }
    expect(checks.calls).toEqual([])
  })
})

describe('S2 T19 item 8: generations', () => {
  it('S2: with the lane paused, a topic dropped during its decision is in none of the ack’s lists, and its dropped frame comes first', async () => {
    const { url, checks } = await start({ recheckMs: 100 })
    checks.allow(ME, teamTopic())
    const client = await connected(url)
    // A granted topic, so the periodic check's request names what the socket holds.
    await client.sub([personTopic(1)])
    checks.hold(isSubDecision)
    const sub = client.sub([teamTopic()])
    await until(() => checks.calls.length === 2)
    // The periodic check finds the team lost while the decision is still out.
    checks.deny(ME, teamTopic())
    const dropped = await client.next('dropped')
    expect(dropped.topics).toEqual([teamTopic()])
    // The decision read before the removal, and allowed it; the drop came after, and wins.
    checks.allow(ME, teamTopic())
    checks.release()
    const ack = await sub
    expect(ack).toMatchObject({ ok: [], refused: [], retry: [] })
    expect(client.frames.indexOf(dropped)).toBeLessThan(client.frames.indexOf(ack))
  })

  it('S2: an unsub then a sub during a paused decision decides only the new one', async () => {
    const { url, checks, server } = await start()
    const client = await connected(url)
    checks.hold()
    client.send({ v: 1, t: 'sub', id: 1, topics: [orgTopic()] })
    await until(() => checks.calls.length === 1)
    expect((await client.unsub([orgTopic()])).ok).toEqual([orgTopic()])
    client.send({ v: 1, t: 'sub', id: 3, topics: [orgTopic()] })
    await until(() => server.counts().topics === 1)
    checks.release()
    const first = await client.next('ack')
    const second = await client.next('ack')
    expect([first.id, first.ok]).toEqual([1, []])
    expect([second.id, second.ok]).toEqual([3, [orgTopic()]])
    expect(checks.calls).toHaveLength(2)
    expect(server.counts().topics).toBe(1)
  })

  it('S2 T19 item 9: a deciding topic is in no index (the reader sends every socket in its index each entry, unchecked); a socket closed during a paused decision, or while its ack waits for the reader, is in no index afterwards', async () => {
    const stream = fakeStream()
    const { url, checks, server } = await start({ stream: stream.factory })
    checks.allow(ME, teamTopic())
    // Closed while its decision is out.
    const deciding = await connected(url)
    checks.hold()
    deciding.send({ v: 1, t: 'sub', id: 1, topics: [teamTopic()] })
    await until(() => checks.calls.length === 1)
    expect(server.counts().topics).toBe(1)
    expect(stream.holders(ORG, teamTopic())).toEqual([])
    stream.dispatch(ORG, teamTopic(), { item: item(1) })
    await delay(20)
    expect(deciding.all('ev')).toEqual([])
    deciding.ws.close()
    await until(() => server.counts().open === 0)
    checks.release()
    await delay(50)
    expect(stream.holders(ORG, teamTopic())).toEqual([])
    // Closed while its ack waits for the reader's first read of the org.
    const waiting = await connected(url)
    stream.hold()
    waiting.send({ v: 1, t: 'sub', id: 1, topics: [teamTopic()] })
    await until(() => stream.holders(ORG, teamTopic()).length === 1)
    waiting.ws.close()
    await until(() => server.counts().open === 0)
    stream.release()
    await delay(50)
    expect(stream.holders(ORG, teamTopic())).toEqual([])
    expect(server.counts().topics).toBe(0)
  })

  it('S2: a topic dropped while its ack waits for the reader gets no ev after the drop, and is in none of the ack’s lists', async () => {
    const stream = fakeStream()
    const { url, checks } = await start({ stream: stream.factory, recheckMs: 100 })
    checks.allow(ME, teamTopic(TEAM), teamTopic(OTHER_TEAM))
    const client = await connected(url)
    stream.hold()
    const sub = client.sub([teamTopic(TEAM), teamTopic(OTHER_TEAM)])
    await until(() => stream.holders(ORG, teamTopic(OTHER_TEAM)).length === 1)
    // Live before the ack: an entry for each reaches the socket now.
    stream.dispatch(ORG, teamTopic(TEAM), { item: item(1) })
    stream.dispatch(ORG, teamTopic(OTHER_TEAM), { item: item(2) })
    await until(() => client.all('ev').length === 2)
    // The periodic check drops one of them meanwhile.
    checks.deny(ME, teamTopic(OTHER_TEAM))
    expect((await client.next('dropped')).topics).toEqual([teamTopic(OTHER_TEAM)])
    stream.dispatch(ORG, teamTopic(TEAM), { item: item(3) })
    stream.dispatch(ORG, teamTopic(OTHER_TEAM), { item: item(4) })
    stream.release()
    const ack = await sub
    expect(ack).toMatchObject({ ok: [teamTopic(TEAM)], refused: [], retry: [] })
    await delay(20)
    expect(items(client.all('ev'))).toEqual([item(1), item(2), item(3)])
  })

  it('S2: a repeated sub of a topic an earlier sub is still deciding answers it retry, never in no list; once that sub’s ack has come it is ok', async () => {
    const { url, checks, server } = await start()
    checks.allow(ME, teamTopic())
    const client = await connected(url)
    checks.hold()
    client.send({ v: 1, t: 'sub', id: 10, topics: [teamTopic()] })
    await until(() => checks.calls.length === 1)
    // No dropped frame was sent, so the topic can't be in none of the lists.
    expect(await client.sub([teamTopic()])).toMatchObject({ ok: [], refused: [], retry: [teamTopic()] })
    expect(client.all('dropped')).toEqual([])
    checks.release()
    const first = await client.next('ack')
    expect([first.id, first.ok]).toEqual([10, [teamTopic()]])
    expect((await client.sub([teamTopic()])).ok).toEqual([teamTopic()])
    // The one decision was the first sub's.
    expect(checks.calls).toHaveLength(1)
    expect(server.counts().retried).toBe(1)
  })

  it('S2: a repeated sub whose ack is built after its earlier sub answered the topic retry answers it retry too', async () => {
    const stream = fakeStream()
    const { url, checks } = await start({ stream: stream.factory })
    checks.allow(ME, teamTopic())
    const client = await connected(url)
    // The earlier sub's lane fails while the repeat waits for the reader.
    checks.hold()
    checks.failNext(new Error('connection refused'))
    client.send({ v: 1, t: 'sub', id: 10, topics: [teamTopic()] })
    await until(() => checks.calls.length === 1)
    stream.hold()
    client.send({ v: 1, t: 'sub', id: 11, topics: [teamTopic()] })
    // The repeat reaches the server, finds the topic held, and waits for the reader.
    await delay(50)
    checks.release()
    await delay(50)
    stream.release()
    await until(() => client.all('ack').length === 2)
    // In whichever order they come, both say retry: neither lists it nowhere.
    const acks = client.all('ack').sort((a, b) => Number(a.id) - Number(b.id))
    expect(acks.map(ack => [ack.id, ack.ok, ack.retry])).toEqual([
      [10, [], [teamTopic()]],
      [11, [], [teamTopic()]],
    ])
  })

  it('S2: a repeated sub of a topic dropped while it waited lists it in none of its ack’s lists, after the dropped frame', async () => {
    const stream = fakeStream()
    const { url, checks } = await start({ stream: stream.factory, recheckMs: 100 })
    checks.allow(ME, teamTopic())
    const client = await connected(url)
    // A granted topic, so the periodic check's request names what the socket holds.
    await client.sub([personTopic(1)])
    checks.hold(isSubDecision)
    client.send({ v: 1, t: 'sub', id: 10, topics: [teamTopic()] })
    await until(() => checks.calls.some(call => isSubDecision(call.request)))
    stream.hold()
    client.send({ v: 1, t: 'sub', id: 11, topics: [teamTopic()] })
    // The repeat reaches the server and finds the topic held; then the periodic check finds the
    // team lost while both wait.
    await delay(50)
    checks.deny(ME, teamTopic())
    const dropped = await client.next('dropped')
    expect(dropped.topics).toEqual([teamTopic()])
    stream.release()
    checks.release()
    await until(() => client.all('ack').length === 3)
    const later = client.all('ack').slice(1)
    expect(later.map(ack => ack.id).sort()).toEqual([10, 11])
    for (const ack of later) expect(ack).toMatchObject({ ok: [], refused: [], retry: [] })
    expect(client.frames.indexOf(dropped)).toBeLessThan(Math.min(...later.map(ack => client.frames.indexOf(ack))))
  })

  it('S2: a repeated sub of a topic unsubscribed while it waited lists it in none of its ack’s lists, after the unsub’s ack', async () => {
    const stream = fakeStream()
    const { url, checks } = await start({ stream: stream.factory })
    checks.allow(ME, teamTopic())
    const client = await connected(url)
    expect((await client.sub([teamTopic()])).ok).toEqual([teamTopic()])
    stream.hold()
    client.send({ v: 1, t: 'sub', id: 10, topics: [teamTopic()] })
    // The repeat reaches the server, finds the topic held and live, and waits for the reader; then
    // the client lets the topic go.
    await delay(50)
    const unsub = await client.unsub([teamTopic()])
    expect(unsub.ok).toEqual([teamTopic()])
    stream.release()
    await until(() => client.all('ack').length === 3)
    const repeat = client.frames.findIndex(frame => frame.t === 'ack' && frame.id === 10)
    // The client heard of the topic's end from the unsub's ack: a retry would have it subscribe
    // again to a topic it let go.
    expect(client.frames[repeat]).toMatchObject({ ok: [], refused: [], retry: [] })
    expect(client.frames.indexOf(unsub)).toBeLessThan(repeat)
    expect(checks.calls).toHaveLength(1)
  })
})

describe('GW-09 T19 item 9: re-authorise and refetch', () => {
  it('T19 item 9: the ack waits for the reader to follow the org’s stream, and the topic is live before it, so an entry appended before the ack still reaches the socket', async () => {
    const stream = fakeStream()
    const { url } = await start({ stream: stream.factory })
    const client = await connected(url)
    stream.hold()
    const sub = client.sub([personTopic(1)])
    await until(() => stream.holders(ORG, personTopic(1)).length === 1)
    stream.dispatch(ORG, personTopic(1), { item: item(1) })
    await client.next('ev')
    expect(client.all('ack')).toEqual([])
    stream.release()
    expect((await sub).ok).toEqual([personTopic(1)])
    expect(client.frames.map(frame => frame.t)).toEqual(['welcome', 'ev', 'ack'])
  })

  it('T19 item 9: while the reader can’t follow the org’s stream (Valkey down) a sub is still acked, once ready() answers false (within the command client’s 1 s timeout), and the reader resets the org once it can', async () => {
    const stream = fakeStream()
    stream.unready.add(ORG)
    const { url } = await start({ stream: stream.factory })
    const client = await connected(url)
    expect(await client.sub([personTopic(1), orgTopic()])).toMatchObject({ ok: [personTopic(1), orgTopic()] })
    // The reader's late first read resets the org (stream.ts): the socket is told to refetch both.
    stream.target().resetOrg(ORG)
    expect(await client.next('reset')).toEqual({
      v: 1,
      t: 'reset',
      topics: [personTopic(1), orgTopic()],
      reason: 'gap',
    })
  })

  it('GW-09 T19 item 9: a client that comes back resubscribes and every topic is decided again: one lost while away is refused, nothing it missed is replayed, and what follows the ack arrives', async () => {
    const { url, checks, publish } = await startWithStreams()
    checks.allow(ME, teamTopic())
    const first = await connected(url)
    expect((await first.sub([teamTopic(), personTopic(1)])).ok).toEqual([teamTopic(), personTopic(1)])
    await publish(teamTopic(), item(1))
    expect(items([await first.next('ev')])).toEqual([item(1)])
    first.ws.close()
    await first.closed
    // Missed while away, on both topics; and the team is lost meanwhile.
    await publish(teamTopic(), item(2))
    await publish(personTopic(1), item(3))
    checks.deny(ME, teamTopic())
    const decisions = checks.calls.length
    const again = await connected(url)
    expect(await again.sub([teamTopic(), personTopic(1)])).toEqual({
      v: 1,
      t: 'ack',
      id: 1,
      ok: [personTopic(1)],
      refused: [teamTopic()],
      retry: [],
    })
    // Both were decided again, by can(), as on any new socket.
    expect(checks.calls.length).toBe(decisions + 1)
    expect(checks.calls.at(-1)?.request.topics?.get(ME)).toEqual(new Set([teamTopic(), personTopic(1)]))
    await delay(300)
    // Nothing missed is replayed: the client refetches the topic acked ok over REST.
    expect(again.all('ev')).toEqual([])
    await publish(teamTopic(), item(4))
    await publish(personTopic(1), item(5))
    await until(() => again.all('ev').length === 1)
    await delay(150)
    expect(items(again.all('ev'))).toEqual([item(5)])
  })

  it('T19 item 9: no frame the gateway sends carries a stream position: welcome, ack, ev, pong, dropped, nudge and reset each parse strictly, and none holds a stream id the reader read or its time', async () => {
    const { url, checks, server, streams, prefix, publish } = await startWithStreams({ recheckMs: 100 })
    checks.allow(ME, teamTopic())
    const raw: string[] = []
    const client = await opened(url)
    client.ws.on('message', data => raw.push(String(data)))
    await client.hello()
    expect((await client.sub([personTopic(1), teamTopic()])).ok).toEqual([personTopic(1), teamTopic()])
    expect((await client.sub([personTopic(2)])).refused).toEqual([personTopic(2)])
    const ids = [
      await publish(personTopic(1), item(1)),
      await publish(personTopic(2), item(2)),
      await publish(teamTopic(), item(3)),
    ]
    await until(() => client.all('ev').length === 2)
    client.send({ v: 1, t: 'ping' })
    await client.next('pong')
    await client.unsub([orgTopic()])
    server.nudge(ORG, 'flags')
    await client.next('nudge')
    checks.deny(ME, teamTopic())
    await client.next('dropped')
    // A gap: the org's stream and epoch lost (a restart without persistence). The reader resets.
    streams.del(`${prefix}rt:{${ORG}}`, `${prefix}rt:{${ORG}}:epoch`)
    expect(await client.next('reset', 2000)).toEqual({ v: 1, t: 'reset', topics: [personTopic(1)], reason: 'gap' })
    ids.push(await publish(personTopic(1), item(4)))
    await until(() => client.all('ev').length === 3)
    const types = new Set(raw.map(text => (JSON.parse(text) as { t: string }).t))
    expect(types).toEqual(new Set(['welcome', 'ack', 'ev', 'pong', 'nudge', 'dropped', 'reset']))
    const text = raw.join('\n')
    for (const id of ids) {
      expect(text).not.toContain(id)
      expect(text).not.toContain(id.split('-')[0])
    }
    for (const frame of raw) {
      const value = JSON.parse(frame) as Record<string, unknown>
      expect(ServerFrame.safeParse(value).success, frame).toBe(true)
      for (const field of ['pos', 'since', 'epoch', 'position']) expect(Object.keys(value), frame).not.toContain(field)
    }
  })

  it('T19 item 9: a reset names the topics each socket holds live, in one frame to every socket of the org that has said hello and holds one; a topic still being decided isn’t named, and is acked after', async () => {
    const stream = fakeStream()
    const { url, checks, server } = await start({ stream: stream.factory })
    checks.allow(known(3).session.userId, teamTopic())
    const a = await connected(url)
    expect((await a.sub([personTopic(1), orgTopic()])).ok).toHaveLength(2)
    // Holds nothing.
    const b = await connected(url, known(2).token)
    // Holds its person topic live, and its team topic still being decided.
    const c = await connected(url, known(3).token)
    expect((await c.sub([personTopic(3)])).ok).toEqual([personTopic(3)])
    checks.hold(isSubDecision)
    const deciding = c.sub([teamTopic()])
    await until(() => checks.calls.length === 3)
    // Hasn't said hello.
    const silent = await opened(url, {
      origin: 'https://hearth.example.com',
      cookie: `__Host-hearth_session=${known(4).token}`,
    })
    stream.target().resetOrg(ORG)
    expect(await a.next('reset')).toEqual({ v: 1, t: 'reset', topics: [personTopic(1), orgTopic()], reason: 'gap' })
    expect(await c.next('reset')).toEqual({ v: 1, t: 'reset', topics: [personTopic(3)], reason: 'gap' })
    checks.release()
    expect((await deciding).ok).toEqual([teamTopic()])
    await delay(50)
    expect(b.all('reset')).toEqual([])
    expect(silent.frames).toEqual([])
    expect(server.counts().resets).toBe(2)
    // Another org's reset tells this org's sockets nothing.
    stream.target().resetOrg(OTHER_ORG)
    await delay(50)
    expect(a.all('reset')).toHaveLength(1)
  })

  it('T19 item 9 P4: an org’s resets are coalesced on the trailing edge: the first goes at once, and any number asked for within resetCoalesceMs go as one at its end, naming what each socket holds live then', async () => {
    const stream = fakeStream()
    const { url, server } = await start({ stream: stream.factory, policy: { resetCoalesceMs: 300 } })
    const client = await connected(url)
    expect((await client.sub([personTopic(1)])).ok).toEqual([personTopic(1)])
    const times: number[] = []
    client.ws.on('message', data => {
      if (JSON.parse(String(data)).t === 'reset') times.push(Date.now())
    })
    // A reader outrun read after read finds a gap at each: ten in 100 ms.
    stream.target().resetOrg(ORG)
    await until(() => times.length === 1)
    expect((await client.sub([orgTopic()])).ok).toEqual([orgTopic()])
    for (let i = 0; i < 9; i++) {
      stream.target().resetOrg(ORG)
      await delay(10)
    }
    await until(() => times.length === 2, 1000)
    await delay(400)
    expect(times).toHaveLength(2)
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(280)
    expect(client.all('reset')).toEqual([
      { v: 1, t: 'reset', topics: [personTopic(1)], reason: 'gap' },
      { v: 1, t: 'reset', topics: [personTopic(1), orgTopic()], reason: 'gap' },
    ])
    expect(server.counts().resets).toBe(2)
    // Once the window has passed, the next goes at once again.
    stream.target().resetOrg(ORG)
    await until(() => times.length === 3, 100)
  })
})

describe('T19 items 9 and 10 P4: the trailing-edge coalescer', () => {
  it('sends a key’s first signal at once, one more at the end of its window for any number within it, and keeps each key to its own window; stop cancels what is scheduled', async () => {
    vi.useFakeTimers({ now: 0 })
    const sent: string[] = []
    const coalescer = new Coalescer(1000, () => Date.now())
    const signal = (key: string) => coalescer.signal(key, () => sent.push(`${key}@${Date.now()}`))
    signal('a')
    signal('a')
    await vi.advanceTimersByTimeAsync(400)
    signal('a')
    // Another key isn't held back by this one's window.
    signal('b')
    expect(sent).toEqual(['a@0', 'b@400'])
    await vi.advanceTimersByTimeAsync(600)
    expect(sent).toEqual(['a@0', 'b@400', 'a@1000'])
    // A window runs from the last send: 'a' again within it waits for its end.
    await vi.advanceTimersByTimeAsync(500)
    signal('a')
    await vi.advanceTimersByTimeAsync(499)
    expect(sent).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(sent).toEqual(['a@0', 'b@400', 'a@1000', 'a@2000'])
    // Past its window, at once.
    await vi.advanceTimersByTimeAsync(1000)
    signal('a')
    expect(sent.at(-1)).toBe('a@3000')
    signal('a')
    coalescer.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(sent).toHaveLength(5)
  })
})

describe('GW-11 P4 T19 item 10: the flags nudge', () => {
  it('P4: two changes 200 ms apart give exactly two nudges, at least 1 s apart, to every socket of the org that has said hello', async () => {
    const { url, server } = await start()
    const client = await connected(url)
    const silent = await opened(url)
    const times: number[] = []
    client.ws.on('message', data => {
      if (JSON.parse(String(data)).t === 'nudge') times.push(Date.now())
    })
    server.nudge(ORG, 'flags')
    await delay(200)
    server.nudge(ORG, 'flags')
    await until(() => times.length === 2, 2500)
    await delay(200)
    expect(times).toHaveLength(2)
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(950)
    expect(client.all('nudge')).toEqual([
      { v: 1, t: 'nudge', what: 'flags' },
      { v: 1, t: 'nudge', what: 'flags' },
    ])
    expect(silent.frames).toEqual([])
    // Another org's sockets are told nothing.
    server.nudge(OTHER_ORG, 'flags')
    await delay(50)
    expect(client.all('nudge')).toHaveLength(2)
  })
})

describe('P7 P9 T19 item 11: the bucket and the marks', () => {
  const conn = (bufferedAmount = 0) =>
    ({
      closing: false,
      tokens: GATEWAY_POLICY.frameBurst,
      refilledAt: 0,
      softSince: undefined,
      ws: { readyState: WebSocket.OPEN, bufferedAmount, send: vi.fn() },
    }) as unknown as Conn & { ws: { send: ReturnType<typeof vi.fn>; bufferedAmount: number } }

  it('P7: the bucket refills at 5 a second up to 20', () => {
    const c = conn()
    for (let i = 0; i < 20; i++) expect(takeToken(c, GATEWAY_POLICY, 0)).toBe(true)
    expect(takeToken(c, GATEWAY_POLICY, 0)).toBe(false)
    expect(takeToken(c, GATEWAY_POLICY, 199)).toBe(false)
    expect(takeToken(c, GATEWAY_POLICY, 400)).toBe(true)
    expect(takeToken(c, GATEWAY_POLICY, 60_000)).toBe(true)
    expect(c.tokens).toBe(19)
  })

  it('T19 item 11: sends below the soft mark, sheds a droppable frame above it, and is too slow past the hard mark or the soft clock', () => {
    const c = conn()
    expect(sendFrame(c, 'a', true, GATEWAY_POLICY, 0)).toBe('sent')
    c.ws.bufferedAmount = GATEWAY_POLICY.softBufferBytes
    expect(sendFrame(c, 'b', true, GATEWAY_POLICY, 1000)).toBe('shed')
    expect(sendFrame(c, 'c', false, GATEWAY_POLICY, 1000)).toBe('sent')
    expect(sendFrame(c, 'd', false, GATEWAY_POLICY, 1000 + GATEWAY_POLICY.softBufferMs + 1)).toBe('too_slow')
    c.ws.bufferedAmount = 0
    expect(sendFrame(c, 'e', false, GATEWAY_POLICY, 20_000)).toBe('sent')
    expect(c.softSince).toBeUndefined()
    c.ws.bufferedAmount = GATEWAY_POLICY.hardBufferBytes
    expect(sendFrame(c, 'f', false, GATEWAY_POLICY, 20_000)).toBe('too_slow')
    c.closing = true
    c.ws.bufferedAmount = 0
    expect(sendFrame(c, 'g', false, GATEWAY_POLICY, 20_000)).toBe('closed')
    expect(c.ws.send.mock.calls.map(([text]) => text)).toEqual(['a', 'c', 'e'])
  })
})
