import { setTimeout as delay } from 'node:timers/promises'
import type { Position } from '@hearth/shared'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'
import { createLogger } from '#src/logger.ts'
import { type Conn, sendFrame, takeToken } from '#src/realtime/frames.ts'
import { GATEWAY_POLICY } from '#src/realtime/policy.ts'
import type { SocketServerOptions } from '#src/realtime/socket.ts'
import {
  evFrame,
  grainStart,
  planResume,
  publishTopicEvent,
  type ResumePlan,
  type ResumeRequest,
  StreamReader,
} from '#src/realtime/stream.ts'
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
const EPOCH = 'e0000000-0000-4000-8000-000000000001'
const UNKNOWN_TEAM = teamTopic('c0000000-0000-4000-8000-0000000000ff')
const at = (pos: string): Position => ({ epoch: EPOCH, pos })

const running: FastifyInstance[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const app of running.splice(0)) await app.close()
})
// The positions here are small ids ('100-0'). The fake stream reports each org's position as it is
// unless a test sets a reported one of its own, as the reader sets it at a grain's start (T19 item
// 9); the frames carry whatever it reports.
async function start(options: Partial<SocketServerOptions> = {}) {
  const gateway = await startGateway(options)
  running.push(gateway.app)
  return gateway
}

// A resume a test lets go of by hand: it waits, then answers what plan gives.
function heldResume(plan: (request: ResumeRequest) => ResumePlan) {
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const asked: ResumeRequest[] = []
  const resume = vi.fn(async (_orgId: string, request: ResumeRequest, _current: Position | null) => {
    asked.push(request)
    await gate
    return plan(request)
  })
  return { resume, asked, release }
}

const resumedAll = (request: ResumeRequest, frames: ResumePlan['frames'] = []): ResumePlan => ({
  outcomes: new Map(request.topics.map(topic => [topic, 'resumed'])),
  frames,
})

describe('GW-04 GW-05 PRD-108 T19 item 7: sub and unsub', () => {
  it('GW-04: a person subscribes to their person, org and team topics, acked ok with the org’s position', async () => {
    const stream = fakeStream()
    stream.positions.set(ORG, at('1800000000000-0'))
    const { url, checks, server } = await start({ stream: stream.factory })
    checks.allow(ME, teamTopic())
    const client = await connected(url)
    expect(await client.sub([personTopic(1), orgTopic(), teamTopic()])).toEqual({
      v: 1,
      t: 'ack',
      id: 1,
      ok: [personTopic(1), orgTopic(), teamTopic()],
      refused: [],
      reset: [],
      retry: [],
      pos: at('1800000000000-0'),
    })
    // The decision was asked about this socket's own session and person only (GW-13).
    expect(checks.calls[0]?.request.sessions).toEqual([A.session.sessionId])
    expect([...(checks.calls[0]?.request.topics?.keys() ?? [])]).toEqual([ME])
    expect(server.counts()).toMatchObject({ topics: 3, resume: expect.objectContaining({ fresh: 3 }) })
    expect(stream.watched).toEqual([ORG])
  })

  it('GW-05 PRD-108: another person’s topic, another org’s, a team they aren’t in and an unknown team are refused alike, with no reason', async () => {
    const { url } = await start()
    const client = await connected(url)
    const asked = [personTopic(2), orgTopic(OTHER_ORG), teamTopic(OTHER_TEAM), UNKNOWN_TEAM]
    const ack = await client.sub(asked)
    expect(ack).toEqual({ v: 1, t: 'ack', id: 1, ok: [], refused: asked, reset: [], retry: [], pos: null })
  })

  it('a repeated sub acks what is held without deciding it again; unsub acks every topic named, held or not, any number of times', async () => {
    const { url, checks, server } = await start()
    const client = await connected(url)
    await client.sub([personTopic(1), personTopic(1)])
    expect((await client.sub([personTopic(1)])).ok).toEqual([personTopic(1)])
    expect(checks.calls).toHaveLength(1)
    expect((await client.unsub([personTopic(1), orgTopic()])).ok).toEqual([personTopic(1), orgTopic()])
    expect((await client.unsub([personTopic(1)])).ok).toEqual([personTopic(1)])
    expect(server.counts().topics).toBe(0)
    // Held no longer: a sub decides it again.
    await client.sub([personTopic(1)])
    expect(checks.calls).toHaveLength(2)
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
    expect(ack).toMatchObject({ ok: [], refused: [], reset: [], retry: [] })
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

  it('S2: a socket closed during a paused decision or replay is in no index afterwards', async () => {
    const stream = fakeStream()
    stream.positions.set(ORG, at('100-0'))
    const held = heldResume(request => resumedAll(request))
    const { url, checks, server } = await start({ stream: stream.factory, resume: held.resume })
    checks.allow(ME, teamTopic())
    checks.eras.set(ME, new Map([[teamTopic(), 1]]))
    // Closed while its decision is out.
    const deciding = await connected(url)
    checks.hold()
    deciding.send({ v: 1, t: 'sub', id: 1, topics: [teamTopic()] })
    await until(() => checks.calls.length === 1)
    deciding.ws.close()
    await until(() => server.counts().open === 0)
    checks.release()
    await delay(50)
    expect(stream.holders(ORG, teamTopic())).toEqual([])
    // Closed while its replay is out.
    const replaying = await connected(url)
    replaying.send({ v: 1, t: 'sub', id: 1, topics: [teamTopic()], since: at('50-0') })
    await until(() => held.asked.length === 1)
    expect(stream.holders(ORG, teamTopic())).toHaveLength(1)
    replaying.ws.close()
    await until(() => server.counts().open === 0)
    held.release()
    await delay(50)
    expect(stream.holders(ORG, teamTopic())).toEqual([])
    expect(server.counts().topics).toBe(0)
  })

  it('S2 GW-09: a topic dropped during a paused replay gets no ev, is in none of the ack’s lists, and its held entries go', async () => {
    const stream = fakeStream()
    stream.positions.set(ORG, at('100-0'))
    const missed = (topic: string) => ({ id: '60-0', topic, text: evFrame(topic, '60-0', 'inbox.changed', {}) })
    const held = heldResume(request => resumedAll(request, request.topics.map(missed)))
    const { url, checks } = await start({ stream: stream.factory, resume: held.resume, recheckMs: 100 })
    checks.allow(ME, teamTopic(TEAM), teamTopic(OTHER_TEAM))
    checks.eras.set(
      ME,
      new Map([
        [teamTopic(TEAM), 1],
        [teamTopic(OTHER_TEAM), 1],
      ]),
    )
    const client = await connected(url)
    const sub = client.sub([teamTopic(TEAM), teamTopic(OTHER_TEAM)], at('50-0'))
    await until(() => held.asked.length === 1)
    expect(held.asked[0]?.topics).toEqual([teamTopic(TEAM), teamTopic(OTHER_TEAM)])
    // An entry for each arrives while they replay, and is held.
    stream.dispatch(ORG, teamTopic(TEAM), '101-0')
    stream.dispatch(ORG, teamTopic(OTHER_TEAM), '102-0')
    // The periodic check drops one of them meanwhile.
    checks.deny(ME, teamTopic(OTHER_TEAM))
    expect((await client.next('dropped')).topics).toEqual([teamTopic(OTHER_TEAM)])
    held.release()
    const ack = await sub
    expect(ack).toMatchObject({ ok: [teamTopic(TEAM)], refused: [], reset: [], retry: [] })
    await until(() => client.all('ev').length === 2)
    // The kept topic: its missed entry before the ack, its held one after; the dropped one: nothing.
    expect(client.all('ev').map(ev => [ev.topic, ev.pos])).toEqual([
      [teamTopic(TEAM), '60-0'],
      [teamTopic(TEAM), '101-0'],
    ])
    expect(client.frames.findIndex(frame => frame.t === 'ack')).toBeGreaterThan(
      client.frames.findIndex(frame => frame.t === 'ev'),
    )
    // Live now.
    stream.dispatch(ORG, teamTopic(TEAM), '103-0')
    stream.dispatch(ORG, teamTopic(OTHER_TEAM), '104-0')
    await until(() => client.all('ev').length === 3)
    await delay(20)
    expect(client.all('ev').map(ev => ev.pos)).toEqual(['60-0', '101-0', '103-0'])
  })

  it('S2 GW-09: a repeated sub of a topic an earlier sub is still deciding answers it retry, never in no list; once that sub’s ack has come it is ok', async () => {
    const { url, checks, server } = await start()
    checks.allow(ME, teamTopic())
    const client = await connected(url)
    checks.hold()
    client.send({ v: 1, t: 'sub', id: 10, topics: [teamTopic()] })
    await until(() => checks.calls.length === 1)
    // No dropped frame was sent, so the topic can't be in none of the lists.
    expect(await client.sub([teamTopic()])).toMatchObject({ ok: [], refused: [], reset: [], retry: [teamTopic()] })
    expect(client.all('dropped')).toEqual([])
    checks.release()
    const first = await client.next('ack')
    expect([first.id, first.ok]).toEqual([10, [teamTopic()]])
    expect((await client.sub([teamTopic()])).ok).toEqual([teamTopic()])
    // The one decision was the first sub's.
    expect(checks.calls).toHaveLength(1)
    expect(server.counts().retried).toBe(1)
  })

  it('S2 GW-09: a repeated sub during a paused replay is answered retry, never ok before the replay’s entries and its ack', async () => {
    const stream = fakeStream()
    stream.positions.set(ORG, at('100-0'))
    const missed = (topic: string) => ({ id: '60-0', topic, text: evFrame(topic, '60-0', 'inbox.changed', {}) })
    const held = heldResume(request => resumedAll(request, request.topics.map(missed)))
    const { url, checks } = await start({ stream: stream.factory, resume: held.resume })
    checks.allow(ME, teamTopic())
    checks.eras.set(ME, new Map([[teamTopic(), 1]]))
    const client = await connected(url)
    client.send({ v: 1, t: 'sub', id: 10, topics: [teamTopic()], since: at('50-0') })
    await until(() => held.asked.length === 1)
    // The same since, sent again while the first replays: an ok here would move the topic to 100-0,
    // and the client would drop the replayed 60-0 as seen.
    const repeat = await client.sub([teamTopic()], at('50-0'))
    expect(repeat).toMatchObject({ ok: [], reset: [], retry: [teamTopic()] })
    held.release()
    await until(() => client.all('ack').length === 2)
    const order = client.frames.map(frame => (frame.t === 'ack' ? `ack ${frame.id} ${frame.ok}` : `${frame.t}`))
    expect(order).toEqual(['welcome', `ack 1 `, 'ev', `ack 10 ${teamTopic()}`])
    expect(client.all('ev').map(ev => ev.pos)).toEqual(['60-0'])
    // Live now: a repeat is ok, with nothing replayed again.
    expect((await client.sub([teamTopic()], at('50-0'))).ok).toEqual([teamTopic()])
    expect(held.asked).toHaveLength(1)
  })

  it('S2: a repeated sub whose ack is built after its earlier sub answered the topic retry answers it retry too', async () => {
    const stream = fakeStream()
    stream.positions.set(ORG, at('100-0'))
    const { url, checks } = await start({ stream: stream.factory })
    checks.allow(ME, teamTopic())
    const client = await connected(url)
    // The earlier sub's lane fails while the repeat waits for the stream's position.
    checks.hold()
    checks.failNext(new Error('connection refused'))
    client.send({ v: 1, t: 'sub', id: 10, topics: [teamTopic()] })
    await until(() => checks.calls.length === 1)
    stream.hold()
    client.send({ v: 1, t: 'sub', id: 11, topics: [teamTopic()] })
    // The repeat reaches the server, finds the topic held, and waits for the position.
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
    stream.positions.set(ORG, at('100-0'))
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
    for (const ack of later) expect(ack).toMatchObject({ ok: [], refused: [], reset: [], retry: [] })
    expect(client.frames.indexOf(dropped)).toBeLessThan(Math.min(...later.map(ack => client.frames.indexOf(ack))))
  })

  it('S2: a repeated sub of a topic unsubscribed while it waited lists it in none of its ack’s lists, after the unsub’s ack', async () => {
    const stream = fakeStream()
    stream.positions.set(ORG, at('100-0'))
    const { url, checks } = await start({ stream: stream.factory })
    checks.allow(ME, teamTopic())
    const client = await connected(url)
    expect((await client.sub([teamTopic()])).ok).toEqual([teamTopic()])
    stream.hold()
    client.send({ v: 1, t: 'sub', id: 10, topics: [teamTopic()] })
    // The repeat reaches the server, finds the topic held and live, and waits for the position;
    // then the client lets the topic go.
    await delay(50)
    const unsub = await client.unsub([teamTopic()])
    expect(unsub.ok).toEqual([teamTopic()])
    stream.release()
    await until(() => client.all('ack').length === 3)
    const repeat = client.frames.findIndex(frame => frame.t === 'ack' && frame.id === 10)
    // The client heard of the topic's end from the unsub's ack: a retry would have it subscribe
    // again to a topic it let go.
    expect(client.frames[repeat]).toMatchObject({ ok: [], refused: [], reset: [], retry: [] })
    expect(client.frames.indexOf(unsub)).toBeLessThan(repeat)
    expect(checks.calls).toHaveLength(1)
  })
})

describe('T19 item 9: the reported position', () => {
  it('T19 item 9: ack, pong and an unsub’s ack carry the position the stream reports, never its current one, so another topic’s event moves none of them; an ev of the socket’s own topic carries its exact id; a reset carries what the reader gives it', async () => {
    const stream = fakeStream()
    const T = 1_800_000_000_000
    stream.positions.set(ORG, at(`${T + 3000}-0`))
    stream.reported.set(ORG, at(`${T - 25_000}-0`))
    const { url, server } = await start({ stream: stream.factory })
    const client = await connected(url)
    expect((await client.sub([personTopic(1)])).pos).toEqual(at(`${T - 25_000}-0`))
    const pong = async () => {
      client.send({ v: 1, t: 'ping' })
      return (await client.next('pong')).pos
    }
    // Someone else's person topic, which this socket can't hold: the reader's position moves.
    stream.dispatch(ORG, personTopic(2), `${T + 7000}-2`)
    expect(await pong()).toEqual(at(`${T - 25_000}-0`))
    expect((await client.unsub([orgTopic()])).pos).toEqual(at(`${T - 25_000}-0`))
    stream.dispatch(ORG, personTopic(1), `${T + 8000}-0`)
    expect((await client.next('ev')).pos).toBe(`${T + 8000}-0`)
    // At a grain's start the reader moves its reported position: the frames carry the new one.
    stream.reported.set(ORG, at(`${T}-0`))
    expect(await pong()).toEqual(at(`${T}-0`))
    expect((await client.unsub([orgTopic()])).pos).toEqual(at(`${T}-0`))
    // A reset carries the position the reader gives it, as it is.
    stream.target().resetOrg(ORG, at(`${T}-0`))
    expect((await client.next('reset')).pos).toEqual(at(`${T}-0`))
    for (const exact of [T + 3000, T + 7000]) expect(JSON.stringify(client.frames)).not.toContain(`${exact}`)
    expect(server.counts().open).toBe(1)
  })

  it('T19 item 9: a resume’s ack carries the reported position read with the replay’s exact one; what the reader held meanwhile follows from the exact one', async () => {
    const stream = fakeStream()
    const T = 1_800_000_000_000
    stream.positions.set(ORG, at(`${T + 5000}-0`))
    stream.reported.set(ORG, at(`${T - 25_000}-0`))
    const missed = `${T + 4000}-0`
    const held = heldResume(request =>
      resumedAll(request, [
        { id: missed, topic: personTopic(1), text: evFrame(personTopic(1), missed, 'inbox.changed', {}) },
      ]),
    )
    const { url } = await start({ stream: stream.factory, resume: held.resume })
    const client = await connected(url)
    const acked = client.sub([personTopic(1)], at(`${T}-0`))
    await until(() => held.asked.length === 1)
    // While the replay is planned, the reader holds an entry past the exact position it read.
    stream.dispatch(ORG, personTopic(1), `${T + 6000}-0`)
    held.release()
    expect((await acked).pos).toEqual(at(`${T - 25_000}-0`))
    await until(() => client.all('ev').length === 2)
    expect(client.frames.map(frame => [frame.t, frame.t === 'ev' ? frame.pos : undefined])).toEqual([
      ['welcome', undefined],
      ['ev', missed],
      ['ack', undefined],
      ['ev', `${T + 6000}-0`],
    ])
  })
})

describe('GW-09 T19 item 9 P1 S5: resume', () => {
  it('GW-09 P1: a client that comes back with since gets the missed events in order, then the ack, then live ones', async () => {
    const streams = fakeStreams()
    const prefix = 'it:unit:'
    const logger = createLogger({ logLevel: 'silent', role: 'realtime' })
    const { url, checks } = await start({
      stream: target =>
        new StreamReader({ valkey: streams.asClient, reader: streams.asReader, keyPrefix: prefix, target, logger }),
      resume: (orgId, request, current) =>
        planResume(streams.asClient, valkeyKeys(prefix).stream(orgId), request, current),
    })
    checks.allow(ME, teamTopic())
    checks.eras.set(ME, new Map([[teamTopic(), Date.now() - 60_000]]))
    const publish = (topic: string, item: string) =>
      publishTopicEvent(streams.asClient, prefix, ORG, { topic, type: 'inbox.changed', ids: { item } }, logger, {
        rethrow: true,
      })
    const item = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    const first = await connected(url)
    const ack = await first.sub([teamTopic(), personTopic(1)])
    expect(ack.ok).toEqual([teamTopic(), personTopic(1)])
    // The stream was empty: the reader's first read wrote this grain's tick, and the ack carries the
    // grain before's start (T19 item 9).
    const grain = GATEWAY_POLICY.positionGrainMs
    const reported = Number(String(ack.pos?.pos).replace(/-0$/, ''))
    expect(ack.pos).toEqual({ epoch: expect.any(String), pos: `${reported}-0` })
    expect(reported % grain).toBe(0)
    expect(grainStart(Date.now(), grain) - reported).toBeGreaterThanOrEqual(grain)
    expect(grainStart(Date.now(), grain) - reported).toBeLessThanOrEqual(2 * grain)
    await publish(teamTopic(), item(1))
    const seen = await first.next('ev')
    expect(seen).toMatchObject({ topic: teamTopic(), ids: { item: item(1) } })
    first.ws.close()
    await first.closed
    await publish(teamTopic(), item(2))
    await publish(personTopic(2), item(3))
    await publish(teamTopic(), item(4))
    const again = await connected(url)
    const since = { epoch: (ack.pos as Position).epoch, pos: String(seen.pos) }
    const resumed = await again.sub([teamTopic()], since)
    expect(resumed).toMatchObject({ ok: [teamTopic()], reset: [] })
    // Only its own topic's missed entries, in order, before the ack.
    expect(again.all('ev').map(ev => (ev.ids as { item: string }).item)).toEqual([item(2), item(4)])
    await publish(teamTopic(), item(5))
    await until(() => again.all('ev').length === 3)
    expect(again.all('ev')[2]?.ids).toEqual({ item: item(5) })
  })

  it('GW-09: a since in another epoch answers reset for those topics, which are still held and get live events', async () => {
    const stream = fakeStream()
    stream.positions.set(ORG, at('100-0'))
    const { url, checks, server } = await start({
      stream: stream.factory,
      resume: async (_orgId, request, current) =>
        planResume({ xrange: async () => [], xinfo: async () => [] } as never, 'unused', request, current),
    })
    const client = await connected(url)
    const ack = await client.sub([orgTopic()], { epoch: 'e0000000-0000-4000-8000-0000000000aa', pos: '90-0' })
    expect(ack).toMatchObject({ ok: [], reset: [orgTopic()], pos: at('100-0') })
    stream.dispatch(ORG, orgTopic(), '101-0')
    expect((await client.next('ev')).pos).toBe('101-0')
    expect(server.counts().resume).toMatchObject({ reset_epoch: 1 })
    expect(checks.calls).toHaveLength(1)
  })

  it('S5: a replay that can’t start in time answers reset (reset_busy)', async () => {
    const stream = fakeStream()
    stream.positions.set(ORG, at('100-0'))
    const { url, server } = await start({
      stream: stream.factory,
      resume: async (_orgId, request) => resumedAll(request),
      policy: { replaysRunning: 0, replayStartMs: 50 },
    })
    const client = await connected(url)
    expect(await client.sub([orgTopic()], at('90-0'))).toMatchObject({ ok: [], reset: [orgTopic()] })
    expect(server.counts().resume).toMatchObject({ reset_busy: 1 })
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
