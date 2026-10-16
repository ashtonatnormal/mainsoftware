import { type Position, ServerFrame } from '@hearth/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'
import { GATEWAY_POLICY, gatewayPolicy } from '#src/realtime/policy.ts'
import {
  compareIds,
  evFrame,
  idTime,
  PUBLISH_TOPIC_EVENT,
  planResume,
  publishTopicEvent,
  ReplayQueue,
  type ResumeRequest,
  StreamReader,
  type StreamTarget,
  type TopicHold,
} from '#src/realtime/stream.ts'
import { captureLogger } from '#src/testing/logs.ts'
import { fakeStreams } from '#src/testing/streams.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const OTHER_ORG = 'a0000000-0000-4000-8000-000000000002'
const PERSON = 'b0000000-0000-4000-8000-000000000001'
const OTHER_PERSON = 'b0000000-0000-4000-8000-000000000002'
const TEAM = 'c0000000-0000-4000-8000-000000000001'
const ITEM = 'd0000000-0000-4000-8000-000000000001'
const EPOCH = 'e0000000-0000-4000-8000-000000000001'
const PREFIX = 'it:unit:'
const keys = valkeyKeys(PREFIX)
const STREAM = keys.stream(ORG)
const EPOCH_KEY = keys.epoch(ORG)
const T0 = 1_800_000_000_000

const personTopic = `person:${PERSON}`
const otherPersonTopic = `person:${OTHER_PERSON}`
const orgTopic = `org:${ORG}`
const teamTopic = `team:${TEAM}`

const entry = (topic: string, ids: Record<string, unknown> = { item: ITEM }, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, k: 'ev', topic, type: 'inbox.changed', ids, ...extra })

afterEach(() => {
  vi.useRealTimers()
})

// The gateway's side of the reader, as plain sockets: each holds topics in a state, and records
// what it was sent.
interface Socket {
  org: string
  topics: Map<string, TopicHold>
  sent: string[]
}

function gateway() {
  const sockets = new Set<Socket>()
  const resets: [string, Position][] = []
  const target: StreamTarget<Socket> = {
    orgsWithSockets: () => new Set([...sockets].map(socket => socket.org)),
    byTopic: (orgId, topic) =>
      [...sockets].filter(
        socket => socket.org === orgId && ['live', 'replaying'].includes(socket.topics.get(topic)?.state ?? ''),
      ),
    holdOf: (socket, topic) => socket.topics.get(topic),
    send: (socket, text) => socket.sent.push(text),
    resetOrg: (orgId, position) => resets.push([orgId, position]),
  }
  const open = (org: string, topics: Record<string, TopicHold['state']> = {}): Socket => {
    const socket: Socket = {
      org,
      topics: new Map(Object.entries(topics).map(([topic, state]) => [topic, { state }])),
      sent: [],
    }
    sockets.add(socket)
    return socket
  }
  return { target, sockets, resets, open, close: (socket: Socket) => sockets.delete(socket) }
}

function setup(o: { policy?: Parameters<typeof gatewayPolicy>[0] } = {}) {
  vi.useFakeTimers({ now: T0 })
  const valkey = fakeStreams()
  const g = gateway()
  const log = captureLogger('realtime')
  const policy = gatewayPolicy(o.policy)
  const reader = new StreamReader({
    valkey: valkey.asClient,
    reader: valkey.asReader,
    keyPrefix: PREFIX,
    target: g.target,
    logger: log.logger,
    policy,
    now: () => Date.now(),
  })
  return { valkey, g, log, reader, policy }
}

// Lets the loop and the fake's promises run, and the clock move by ms.
const run = (ms = 0) => vi.advanceTimersByTimeAsync(ms)

const sentEvs = (socket: Socket) => socket.sent.map(text => JSON.parse(text) as { pos: string; topic: string })

describe('C0.7 T19 item 9 stream ids', () => {
  it('compare as (ms, seq) pairs of 64-bit numbers, never as strings', () => {
    expect(compareIds('10-0', '9-5')).toBe(1)
    expect(compareIds('9-5', '10-0')).toBe(-1)
    expect(compareIds('5-10', '5-9')).toBe(1)
    expect(compareIds('5-1', '5-1')).toBe(0)
    expect(compareIds('0-0', '0-1')).toBe(-1)
    // Past Number's exact range: 2^64 - 1 against 2^64 - 2.
    expect(compareIds('18446744073709551615-0', '18446744073709551614-9')).toBe(1)
    expect(compareIds('1-18446744073709551615', '1-18446744073709551614')).toBe(1)
    expect(idTime('1800000000123-4')).toBe(1_800_000_000_123)
    expect(() => compareIds('1-0', 'x')).toThrow(/stream id/)
  })
})

describe('C0.7 T19 item 9 the producer, publishTopicEvent()', () => {
  it('GW-10: appends one ids-only entry with its epoch and both expiries in one script, by EVALSHA once Valkey has it', async () => {
    vi.useFakeTimers({ now: T0 })
    const valkey = fakeStreams()
    const log = captureLogger('api')
    const first = await publishTopicEvent(
      valkey.asClient,
      PREFIX,
      ORG,
      { topic: personTopic, type: 'inbox.changed', ids: { item: ITEM } },
      log.logger,
    )
    const second = await publishTopicEvent(
      valkey.asClient,
      PREFIX,
      ORG,
      { topic: orgTopic, type: 'flags.changed', ids: { count: 3, items: [ITEM], seen: true } },
      log.logger,
    )
    expect(first).toBe(`${T0}-0`)
    expect(second).toBe(`${T0}-1`)
    // Valkey didn't have the script at first: EVALSHA answered NOSCRIPT, and EVAL ran it once.
    expect(valkey.client.evalsha).toHaveBeenCalledTimes(2)
    expect(valkey.client.eval).toHaveBeenCalledTimes(1)
    const [sha, count, ...args] = valkey.client.evalsha.mock.calls[1] ?? []
    expect([sha, count]).toEqual([PUBLISH_TOPIC_EVENT.sha, 2])
    expect(args.slice(0, 4)).toEqual([STREAM, EPOCH_KEY, GATEWAY_POLICY.streamMaxLen, GATEWAY_POLICY.streamTtlMs])
    expect(JSON.parse(String(args[5]))).toEqual({
      v: 1,
      k: 'ev',
      topic: orgTopic,
      type: 'flags.changed',
      ids: { count: 3, items: [ITEM], seen: true },
    })
    // One hash slot for both keys ({<org>}), so the script runs unchanged on a cluster.
    expect(STREAM).toBe(`${PREFIX}rt:{${ORG}}`)
    expect(EPOCH_KEY).toBe(`${PREFIX}rt:{${ORG}}:epoch`)
    // The script itself: SET NX PX, XADD MAXLEN ~, then PEXPIRE on both.
    expect(PUBLISH_TOPIC_EVENT.lua).toContain("redis.call('SET', KEYS[2], ARGV[3], 'NX', 'PX', ARGV[2])")
    expect(PUBLISH_TOPIC_EVENT.lua).toContain("redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[1], '*', 'f', ARGV[4])")
    expect(PUBLISH_TOPIC_EVENT.lua).toContain("redis.call('PEXPIRE', KEYS[1], ARGV[2])")
    expect(PUBLISH_TOPIC_EVENT.lua).toContain("redis.call('PEXPIRE', KEYS[2], ARGV[2])")
    expect(valkey.ttls.get(STREAM)).toBe(GATEWAY_POLICY.streamTtlMs)
    expect(valkey.ttls.get(EPOCH_KEY)).toBe(GATEWAY_POLICY.streamTtlMs)
    // The epoch was made once, by the first publish.
    const epoch = valkey.strings.get(EPOCH_KEY)
    expect(epoch).toMatch(/^[0-9a-f-]{36}$/)
    expect(log.lines).toEqual([])
  })

  it('T19 item 9: refuses an entry over 2 KiB, or anything not ids, before Valkey is asked, and logs no value', async () => {
    const valkey = fakeStreams()
    const log = captureLogger('api')
    const hundred = Array.from({ length: 100 }, (_, n) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`)
    const refused: [string, { topic: string; type: string; ids: Record<string, unknown> }][] = [
      // 100 ids is ids only, but the entry is over 2048 bytes.
      [ORG, { topic: personTopic, type: 'inbox.changed', ids: { items: hundred } }],
      // Free text, a nested object, a number past 1,000,000, an upper-case uuid, a camelCase key.
      [ORG, { topic: personTopic, type: 'inbox.changed', ids: { note: 'Call Marcus on +65 9123 4567' } }],
      [ORG, { topic: personTopic, type: 'inbox.changed', ids: { item: { id: ITEM } } }],
      [ORG, { topic: personTopic, type: 'inbox.changed', ids: { count: 1_000_001 } }],
      [ORG, { topic: personTopic, type: 'inbox.changed', ids: { item: ITEM.toUpperCase() } }],
      [ORG, { topic: personTopic, type: 'inbox.changed', ids: { itemId: ITEM } }],
      // A topic of no known kind, a type that isn't a code, another org's org topic, an org that
      // isn't an id.
      [ORG, { topic: `channel:${ITEM}`, type: 'inbox.changed', ids: {} }],
      [ORG, { topic: personTopic, type: 'Inbox changed', ids: {} }],
      [ORG, { topic: `org:${OTHER_ORG}`, type: 'inbox.changed', ids: {} }],
      ['not-an-org', { topic: personTopic, type: 'inbox.changed', ids: {} }],
    ]
    for (const [orgId, event] of refused) {
      expect(await publishTopicEvent(valkey.asClient, PREFIX, orgId, event, log.logger)).toBeUndefined()
      await expect(
        publishTopicEvent(valkey.asClient, PREFIX, orgId, event, log.logger, { rethrow: true }),
      ).rejects.toThrow(/ids only/)
    }
    expect(valkey.client.evalsha).not.toHaveBeenCalled()
    expect(valkey.client.eval).not.toHaveBeenCalled()
    expect(log.events('topic_event_invalid').map(line => [line.level, line.reason])).toEqual(
      [
        'too_large',
        'not_ids',
        'not_ids',
        'not_ids',
        'not_ids',
        'not_ids',
        'not_ids',
        'not_ids',
        'other_org',
        'org',
      ].flatMap(reason => [
        [50, reason],
        [50, reason],
      ]),
    )
    const written = JSON.stringify(log.lines)
    for (const value of ['Marcus', '9123', ITEM, ITEM.toUpperCase()]) expect(written).not.toContain(value)
    // At 2 KiB exactly it goes.
    const fits = { topic: personTopic, type: 'inbox.changed', ids: { items: hundred.slice(0, 40) } }
    expect(Buffer.byteLength(entry(fits.topic, fits.ids))).toBeLessThanOrEqual(2048)
    expect(await publishTopicEvent(valkey.asClient, PREFIX, ORG, fits, log.logger)).toBeDefined()
  })

  it('is best effort: a Valkey failure is logged at warn and swallowed, or thrown for a job', async () => {
    const valkey = fakeStreams()
    const log = captureLogger('worker')
    const event = { topic: personTopic, type: 'inbox.changed', ids: {} }
    valkey.fail('evalsha', new Error('Connection is closed.'))
    expect(await publishTopicEvent(valkey.asClient, PREFIX, ORG, event, log.logger)).toBeUndefined()
    valkey.fail('evalsha', new Error('Connection is closed.'))
    await expect(publishTopicEvent(valkey.asClient, PREFIX, ORG, event, log.logger, { rethrow: true })).rejects.toThrow(
      /closed/,
    )
    expect(log.events('topic_event_publish_failed').map(line => [line.level, line.org])).toEqual([
      [40, ORG],
      [40, ORG],
    ])
    expect(valkey.streams.size).toBe(0)
  })
})

describe('C0.7 T19 item 9 the stream reader', () => {
  it('GW-10: reads an org’s tail at first (SET NX, then XREVRANGE), keeping an epoch that is there, and 0-0 for no stream', async () => {
    const { valkey, g, reader } = setup()
    valkey.strings.set(EPOCH_KEY, EPOCH)
    valkey.add(STREAM, entry(personTopic), T0 - 5000)
    const last = valkey.add(STREAM, entry(personTopic), T0 - 4000)
    g.open(ORG)
    expect(reader.current(ORG)).toBeNull()
    expect(await reader.position(ORG)).toEqual({ epoch: EPOCH, pos: last })
    expect(reader.current(ORG)).toEqual({ epoch: EPOCH, pos: last })
    expect(valkey.client.set).toHaveBeenCalledWith(
      EPOCH_KEY,
      expect.any(String),
      'PX',
      GATEWAY_POLICY.streamTtlMs,
      'NX',
    )
    expect(valkey.client.xrevrange).toHaveBeenCalledWith(STREAM, '+', '-', 'COUNT', 1)
    // Asked again, the tail isn't read again.
    await reader.position(ORG)
    expect(valkey.client.xrevrange).toHaveBeenCalledTimes(1)

    // An org with no stream and no epoch: one is made, and the position is 0-0.
    g.open(OTHER_ORG)
    const position = await reader.position(OTHER_ORG)
    expect(position?.pos).toBe('0-0')
    expect(position?.epoch).toBe(valkey.strings.get(keys.epoch(OTHER_ORG)))
    expect(valkey.ttls.get(keys.epoch(OTHER_ORG))).toBe(GATEWAY_POLICY.streamTtlMs)
  })

  it('GW-10 §5.5: dispatches each entry to the sockets holding its topic live, holds it for replaying ones (at most 500), and current() follows', async () => {
    const { valkey, g, reader } = setup()
    const live = g.open(ORG, { [personTopic]: 'live', [orgTopic]: 'live' })
    const replaying = g.open(ORG, { [personTopic]: 'replaying' })
    const deciding = g.open(ORG, { [personTopic]: 'deciding' })
    const other = g.open(ORG, { [otherPersonTopic]: 'live' })
    const elsewhere = g.open(OTHER_ORG, { [personTopic]: 'live' })
    reader.start()
    await run()
    const start = reader.current(ORG)
    expect(start?.pos).toBe('0-0')

    const id = valkey.add(STREAM, entry(personTopic, { item: ITEM, count: 2 }))
    await run()
    const frame = { v: 1, t: 'ev', topic: personTopic, pos: id, type: 'inbox.changed', ids: { item: ITEM, count: 2 } }
    expect(live.sent.map(text => JSON.parse(text))).toEqual([frame])
    // The frame the server sends is a strict ServerFrame, serialised once for every socket.
    expect(ServerFrame.parse(frame)).toEqual(frame)
    expect(live.sent[0]).toBe(evFrame(personTopic, id, 'inbox.changed', { item: ITEM, count: 2 }))
    expect(replaying.topics.get(personTopic)?.held).toEqual([{ id, text: live.sent[0] }])
    expect(replaying.sent).toEqual([])
    expect(deciding.sent).toEqual([])
    expect(deciding.topics.get(personTopic)?.held).toBeUndefined()
    expect(other.sent).toEqual([])
    expect(elsewhere.sent).toEqual([])
    expect(reader.current(ORG)).toEqual({ epoch: start?.epoch, pos: id })

    // Past 500 held entries the replaying topic is marked overflowed and holds none (its replay
    // answers reset); live sockets get every one, in order.
    const ids: string[] = []
    for (let n = 0; n < GATEWAY_POLICY.replayFramesMax; n++) {
      ids.push(valkey.add(STREAM, entry(personTopic)))
      if (n % 100 === 0) await run(1)
    }
    await run(1)
    expect(replaying.topics.get(personTopic)).toMatchObject({ state: 'replaying', overflowed: true, held: [] })
    expect(sentEvs(live).map(ev => ev.pos)).toEqual([id, ...ids])
    expect(reader.current(ORG)?.pos).toBe(ids.at(-1))
  })

  it('§5.3: skips an entry of another version or kind, or one that isn’t JSON, counting it and moving past it', async () => {
    const { valkey, g, reader, log } = setup()
    const live = g.open(ORG, { [personTopic]: 'live' })
    reader.start()
    await run()
    valkey.add(STREAM, entry(personTopic, {}, { v: 2 }))
    valkey.add(STREAM, entry(personTopic, {}, { k: 'other' }))
    const last = valkey.add(STREAM, 'not json')
    await run()
    expect(live.sent).toEqual([])
    expect(reader.current(ORG)?.pos).toBe(last)
    expect(reader.stats().skipped).toBe(3)
    // Logged at debug, at most once a minute.
    expect(log.events('stream_entry_skipped').map(line => [line.level, line.skipped])).toEqual([[20, 1]])
    await run(60_000)
    valkey.add(STREAM, 'still not json')
    await run()
    expect(log.events('stream_entry_skipped').map(line => line.skipped)).toEqual([1, 3])
    // A later field it doesn't know is ignored, not refused.
    const known = valkey.add(STREAM, entry(personTopic, {}, { later: 'field' }))
    await run()
    expect(sentEvs(live).map(ev => ev.pos)).toEqual([known])
  })

  it('S6: resets the org when its epoch changes (the key was lost), and continues from the new stream', async () => {
    const { valkey, g, reader, log } = setup()
    const live = g.open(ORG, { [personTopic]: 'live' })
    reader.start()
    await run()
    valkey.add(STREAM, entry(personTopic))
    await run()
    const before = reader.current(ORG)
    // A restart without persistence: both keys are gone, and a producer writes a new stream.
    valkey.del(STREAM, EPOCH_KEY)
    await run(GATEWAY_POLICY.readerEpochCheckMs + GATEWAY_POLICY.readerBlockMs)
    expect(g.resets).toHaveLength(1)
    const [[orgId, position] = []] = g.resets
    expect(orgId).toBe(ORG)
    expect(position?.epoch).not.toBe(before?.epoch)
    expect(position?.epoch).toBe(valkey.strings.get(EPOCH_KEY))
    expect(position?.pos).toBe('0-0')
    expect(reader.current(ORG)).toEqual(position)
    expect(log.events('stream_reset').map(line => [line.org, line.reason])).toEqual([[ORG, 'epoch']])
    // The new stream's entries are read from the start.
    const id = valkey.add(STREAM, entry(personTopic), T0)
    await run()
    expect(sentEvs(live).at(-1)?.pos).toBe(id)
  })

  it('S6: resets the org when the stream was trimmed past the reader (first > its position) while it couldn’t read', async () => {
    const { valkey, g, reader, log } = setup()
    const live = g.open(ORG, { [personTopic]: 'live' })
    valkey.add(STREAM, entry(personTopic))
    reader.start()
    await run()
    const at = reader.current(ORG)?.pos as string
    // The reader's connection drops; meanwhile entries are added and the head trimmed past it.
    valkey.fail('xread')
    await run(GATEWAY_POLICY.readerBlockMs)
    for (let n = 0; n < 5; n++) valkey.add(STREAM, entry(personTopic))
    valkey.trim(STREAM, 3)
    await run(GATEWAY_POLICY.readerRetryMs)
    expect(log.events('stream_reset').map(line => line.reason)).toEqual(['trimmed'])
    const last = valkey.streams.get(STREAM)?.entries.at(-1)?.[0]
    expect(g.resets.map(([, position]) => position.pos)).toEqual([last])
    expect(compareIds(last as string, at)).toBe(1)
    // Nothing from the trimmed stretch was sent as though it were whole.
    expect(live.sent).toEqual([])
  })

  it('S6: resets the org when the tail it read is gone (last < its position), and not for an absent stream under the same epoch', async () => {
    const { valkey, g, reader, log } = setup()
    g.open(ORG, { [personTopic]: 'live' })
    reader.start()
    await run()
    valkey.add(STREAM, entry(personTopic), T0 - 3000)
    valkey.add(STREAM, entry(personTopic), T0 - 2000)
    await run()
    // A failover lost the newest entry.
    valkey.loseTail(STREAM, 1)
    await run(GATEWAY_POLICY.readerEpochCheckMs + GATEWAY_POLICY.readerBlockMs)
    expect(log.events('stream_reset').map(line => line.reason)).toEqual(['tail_lost'])
    expect(g.resets.map(([, position]) => position.pos)).toEqual([`${T0 - 3000}-0`])

    // The stream expired, but its epoch is the same: nothing was written after the reader's
    // position, so it isn't a gap.
    valkey.streams.delete(STREAM)
    await run(GATEWAY_POLICY.readerEpochCheckMs * 5)
    expect(g.resets).toHaveLength(1)
  })

  it('S6: after a reconnect of its connection, checks every org for a gap before it reads again', async () => {
    // Periodic checks far apart, so only the reconnect can bring one.
    const { valkey, g, reader } = setup({ policy: { readerEpochCheckMs: 600_000 } })
    g.open(ORG, { [personTopic]: 'live' })
    reader.start()
    await run(GATEWAY_POLICY.readerBlockMs * 3)
    const checks = () => valkey.client.xrange.mock.calls.filter(([, start]) => start === '-').length
    expect(checks()).toBe(0)
    valkey.reconnected()
    await run(GATEWAY_POLICY.readerBlockMs)
    expect(checks()).toBe(1)
    await run(GATEWAY_POLICY.readerBlockMs * 3)
    expect(checks()).toBe(1)
  })

  it('S6: refreshes both keys’ expiry every 60 s while the org has sockets here', async () => {
    const { valkey, g, reader } = setup()
    const socket = g.open(ORG, { [personTopic]: 'live' })
    valkey.add(STREAM, entry(personTopic))
    reader.start()
    await run()
    const refreshes = (key: string) => valkey.client.pexpire.mock.calls.filter(([name]) => name === key).length
    // At once, then every 60 s.
    expect([refreshes(STREAM), refreshes(EPOCH_KEY)]).toEqual([1, 1])
    await run(GATEWAY_POLICY.epochRefreshMs)
    expect([refreshes(STREAM), refreshes(EPOCH_KEY)]).toEqual([2, 2])
    await run(GATEWAY_POLICY.epochRefreshMs)
    expect([refreshes(STREAM), refreshes(EPOCH_KEY)]).toEqual([3, 3])
    for (const call of valkey.client.pexpire.mock.calls) expect(call[1]).toBe(GATEWAY_POLICY.streamTtlMs)
    // Its last socket closes: no more refreshes.
    g.close(socket)
    await run(GATEWAY_POLICY.epochRefreshMs * 2)
    expect([refreshes(STREAM), refreshes(EPOCH_KEY)]).toEqual([3, 3])
  })

  it('P1: forgets an org’s position and epoch when its last socket here closes, and reads its tail afresh after', async () => {
    const { valkey, g, reader } = setup()
    const socket = g.open(ORG, { [personTopic]: 'live' })
    reader.start()
    await run()
    valkey.add(STREAM, entry(personTopic))
    await run()
    expect(reader.current(ORG)).not.toBeNull()
    expect(reader.stats().orgs).toBe(1)
    g.close(socket)
    await run(GATEWAY_POLICY.readerBlockMs + GATEWAY_POLICY.readerIdleMs)
    expect(reader.current(ORG)).toBeNull()
    expect(reader.stats().orgs).toBe(0)
    // Entries written while nobody here held the org aren't sent to its next socket.
    valkey.add(STREAM, entry(personTopic))
    const last = valkey.add(STREAM, entry(personTopic))
    const next = g.open(ORG, { [personTopic]: 'live' })
    reader.watch(ORG)
    await run()
    expect(reader.current(ORG)?.pos).toBe(last)
    expect(next.sent).toEqual([])
  })

  it('answers position null while Valkey can’t be reached, logging the failures (an error from the third in a row), and recovers', async () => {
    const { valkey, g, reader, log } = setup()
    g.open(ORG, { [personTopic]: 'live' })
    valkey.fail('set')
    expect(await reader.position(ORG)).toBeNull()
    valkey.fail('xrevrange')
    expect(await reader.position(ORG)).toBeNull()
    valkey.fail('get')
    expect(await reader.position(ORG)).toBeNull()
    expect(log.events('stream_reader_failed').map(line => [line.level, line.step, line.failures])).toEqual([
      [40, 'init', 1],
      [40, 'init', 2],
      [50, 'init', 3],
    ])
    expect((await reader.position(ORG))?.pos).toBe('0-0')
    // No id or value in the lines.
    expect(JSON.stringify(log.lines)).not.toContain(PERSON)
  })

  it('OD-22 §11: is stuck once it has orgs and hasn’t read for 7 s, never while it has none, and reads again when Valkey is back', async () => {
    const { valkey, g, reader, log } = setup()
    reader.start()
    await run(GATEWAY_POLICY.readerStuckMs * 2)
    expect(reader.stuck()).toBe(false)
    g.open(ORG, { [personTopic]: 'live' })
    reader.watch(ORG)
    await run()
    expect(reader.stuck()).toBe(false)
    for (let n = 0; n < 10; n++) valkey.fail('xread')
    await run(GATEWAY_POLICY.readerBlockMs + GATEWAY_POLICY.readerStuckMs + 1)
    expect(reader.stuck()).toBe(true)
    expect(reader.lagMs()).toBeGreaterThan(GATEWAY_POLICY.readerStuckMs)
    expect(log.events('stream_reader_failed').some(line => line.level === 50 && line.step === 'read')).toBe(true)
    await run(GATEWAY_POLICY.readerRetryMs * 5)
    expect(reader.stuck()).toBe(false)
  })

  it('stops after its current read, and dispatches nothing more', async () => {
    const { valkey, g, reader } = setup()
    const live = g.open(ORG, { [personTopic]: 'live' })
    reader.start()
    await run()
    const stopped = reader.stop()
    await run(GATEWAY_POLICY.readerBlockMs)
    await stopped
    valkey.add(STREAM, entry(personTopic))
    await run(GATEWAY_POLICY.readerBlockMs)
    expect(live.sent).toEqual([])
    // A watch after the stop starts nothing.
    reader.watch(OTHER_ORG)
    expect(await reader.position(OTHER_ORG)).toBeNull()
  })
})

describe('C0.7 T19 item 9 GW-09 P1 resume decisions, planResume()', () => {
  const NOW = T0
  // A stream whose entries were made at these times (ms before NOW), each for the topic given.
  function stream(entries: [agoMs: number, topic: string][]) {
    const valkey = fakeStreams()
    const ids = entries.map(([ago, topic]) => valkey.add(STREAM, entry(topic), NOW - ago))
    const current: Position = { epoch: EPOCH, pos: ids.at(-1) ?? '0-0' }
    return { valkey, ids, current }
  }
  const request = (pos: string, topics: string[] = [personTopic], eras: [string, number][] = []): ResumeRequest => ({
    since: { epoch: EPOCH, pos },
    topics,
    eras: new Map(eras),
  })
  const plan = (s: ReturnType<typeof stream>, r: ResumeRequest, current: Position | null = s.current) =>
    planResume(s.valkey.asClient, STREAM, r, current, { now: NOW })

  it('an hour-old since on a quiet stream resumes with nothing to replay', async () => {
    const s = stream([[3_600_000, personTopic]])
    const result = await plan(s, request(s.ids[0] as string))
    expect([...result.outcomes]).toEqual([[personTopic, 'resumed']])
    expect(result.frames).toEqual([])
  })

  it('0-0 on an absent stream resumes; with untrimmed entries it replays them; after trimming it resets', async () => {
    const absent = stream([])
    expect([...(await plan(absent, request('0-0'))).outcomes]).toEqual([[personTopic, 'resumed']])

    const whole = stream([
      [3000, personTopic],
      [2000, orgTopic],
      [1000, personTopic],
    ])
    const replayed = await plan(whole, request('0-0'))
    expect([...replayed.outcomes]).toEqual([[personTopic, 'resumed']])
    expect(replayed.frames.map(frame => frame.id)).toEqual([whole.ids[0], whole.ids[2]])
    expect(JSON.parse(replayed.frames[0]?.text as string)).toEqual({
      v: 1,
      t: 'ev',
      topic: personTopic,
      pos: whole.ids[0],
      type: 'inbox.changed',
      ids: { item: ITEM },
    })

    whole.valkey.trim(STREAM, 2)
    expect([...(await plan(whole, request('0-0'))).outcomes]).toEqual([[personTopic, 'reset_trimmed']])
  })

  it('a real id at or above the stream’s first entry resumes, and one below it resets', async () => {
    const s = stream([
      [4000, personTopic],
      [3000, personTopic],
      [2000, personTopic],
      [1000, personTopic],
    ])
    s.valkey.trim(STREAM, 3)
    const [gone, first, , last] = s.ids as [string, string, string, string]
    const atFirst = await plan(s, request(first))
    expect([...atFirst.outcomes]).toEqual([[personTopic, 'resumed']])
    expect(atFirst.frames.map(frame => frame.id)).toEqual([s.ids[2], last])
    expect([...(await plan(s, request(gone))).outcomes]).toEqual([[personTopic, 'reset_trimmed']])
  })

  it('a missed entry 3 minutes old resets (the window), however recent the rest', async () => {
    const s = stream([
      [200_000, personTopic],
      [180_000, personTopic],
      [1000, personTopic],
    ])
    expect([...(await plan(s, request(s.ids[0] as string))).outcomes]).toEqual([[personTopic, 'reset_window']])
    // Within 2 minutes it replays.
    const recent = stream([
      [200_000, personTopic],
      [119_000, personTopic],
    ])
    expect([...(await plan(recent, request(recent.ids[0] as string))).outcomes]).toEqual([[personTopic, 'resumed']])
  })

  it('1,001 entries scanned, or 501 matching, reset (too long); 1,000 and 500 replay', async () => {
    const scanned = stream(Array.from({ length: 1002 }, (_, n) => [10_000 - n, orgTopic] as [number, string]))
    const from = scanned.ids[0] as string
    expect([...(await plan(scanned, request(from))).outcomes]).toEqual([[personTopic, 'reset_long']])
    const thousand = { ...scanned, current: { epoch: EPOCH, pos: scanned.ids[1000] as string } }
    expect([...(await plan(thousand, request(from))).outcomes]).toEqual([[personTopic, 'resumed']])

    const matching = stream(Array.from({ length: 502 }, (_, n) => [10_000 - n, personTopic] as [number, string]))
    const first = matching.ids[0] as string
    expect([...(await plan(matching, request(first))).outcomes]).toEqual([[personTopic, 'reset_long']])
    const fiveHundred = { ...matching, current: { epoch: EPOCH, pos: matching.ids[500] as string } }
    const replayed = await plan(fiveHundred, request(first))
    expect([...replayed.outcomes]).toEqual([[personTopic, 'resumed']])
    expect(replayed.frames).toHaveLength(500)
  })

  it('since past the position (seen on another task) resumes with nothing replayed', async () => {
    const s = stream([
      [3000, personTopic],
      [2000, personTopic],
    ])
    const behind = { epoch: EPOCH, pos: s.ids[0] as string }
    const result = await plan(s, request(s.ids[1] as string), behind)
    expect([...result.outcomes]).toEqual([[personTopic, 'resumed']])
    expect(result.frames).toEqual([])
    expect(s.valkey.client.xrange.mock.calls.filter(([, start]) => String(start).startsWith('('))).toEqual([])
  })

  it('an epoch mismatch, or no position (Valkey unreachable), resets', async () => {
    const s = stream([[1000, personTopic]])
    const other = { since: { epoch: 'e0000000-0000-4000-8000-000000000009', pos: s.ids[0] as string } }
    expect([...(await plan(s, { ...request('0-0'), ...other })).outcomes]).toEqual([[personTopic, 'reset_epoch']])
    expect([...(await plan(s, request(s.ids[0] as string), null)).outcomes]).toEqual([[personTopic, 'reset_epoch']])
  })

  it('GW-09: a team topic whose current membership began after since, or within 5 s before it, resets; earlier resumes; person and org topics never take the test', async () => {
    const s = stream([
      [30_000, teamTopic],
      [10_000, teamTopic],
      [9000, personTopic],
    ])
    const since = s.ids[0] as string
    const sinceMs = idTime(since)
    const topics = [teamTopic, personTopic, orgTopic]
    const after = await plan(s, request(since, topics, [[teamTopic, sinceMs + 1000]]))
    expect([...after.outcomes]).toEqual([
      [teamTopic, 'reset_era'],
      [personTopic, 'resumed'],
      [orgTopic, 'resumed'],
    ])
    // Nothing of the reset team topic is replayed: only the person topic's entry.
    expect(after.frames.map(frame => frame.topic)).toEqual([personTopic])

    const justBefore = await plan(s, request(since, topics, [[teamTopic, sinceMs - 3000]]))
    expect(justBefore.outcomes.get(teamTopic)).toBe('reset_era')
    // A membership the lane didn't read (removed meanwhile) resets too.
    expect((await plan(s, request(since, topics))).outcomes.get(teamTopic)).toBe('reset_era')

    const earlier = await plan(s, request(since, topics, [[teamTopic, sinceMs - 60_000]]))
    expect(earlier.outcomes.get(teamTopic)).toBe('resumed')
    expect(earlier.frames.map(frame => frame.topic)).toEqual([teamTopic, personTopic])
  })

  it('reads Valkey’s XINFO STREAM reply in its list form, and throws what Valkey can’t answer', async () => {
    const s = stream([[1000, personTopic]])
    s.valkey.fail('xinfo')
    await expect(plan(s, request('0-0'))).rejects.toThrow(/closed/)
    s.valkey.client.xinfo.mockResolvedValueOnce(['length', 'x'] as never)
    await expect(plan(s, request('0-0'))).rejects.toThrow(/XINFO/)
  })
})

describe('C0.7 T19 item 9 S5 the replay caps, ReplayQueue', () => {
  // A replay that runs until the test lets it finish.
  function gate() {
    let open: () => void = () => {}
    const opened = new Promise<void>(resolve => (open = resolve))
    return { open, replay: () => opened.then(() => 'done') }
  }

  it('runs one replay at a time per socket, queues two behind it, and answers busy to a third', async () => {
    vi.useFakeTimers()
    const queue = new ReplayQueue()
    const socket = {}
    const first = gate()
    const results: unknown[] = []
    const track = (p: Promise<unknown>) => p.then(result => results.push(result))
    void track(queue.run(socket, first.replay))
    const second = vi.fn(async () => 'second')
    const third = vi.fn(async () => 'third')
    void track(queue.run(socket, second))
    void track(queue.run(socket, third))
    expect(await queue.run(socket, async () => 'fourth')).toBe('busy')
    expect(queue.counts()).toEqual({ running: 1, waiting: 2 })
    expect(second).not.toHaveBeenCalled()
    first.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(results).toEqual(['done', 'second', 'third'])
    expect(queue.counts()).toEqual({ running: 0, waiting: 0 })
  })

  it('runs at most 8 at once in the process, starts the next as one finishes, and answers busy past 1,000 waiting', async () => {
    vi.useFakeTimers()
    const queue = new ReplayQueue(gatewayPolicy({ replaysWaiting: 3 }))
    const gates = Array.from({ length: 8 }, () => gate())
    for (const g of gates) void queue.run({}, g.replay)
    expect(queue.counts()).toEqual({ running: 8, waiting: 0 })
    const ninth = vi.fn(async () => 'ninth')
    const waiting = queue.run({}, ninth)
    void queue.run({}, async () => 'x')
    void queue.run({}, async () => 'y')
    expect(queue.counts()).toEqual({ running: 8, waiting: 3 })
    expect(await queue.run({}, async () => 'z')).toBe('busy')
    gates[0]?.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(ninth).toHaveBeenCalledOnce()
    expect(await waiting).toBe('ninth')
    expect(GATEWAY_POLICY.replaysRunning).toBe(8)
    expect(GATEWAY_POLICY.replaysWaiting).toBe(1000)
  })

  it('answers busy to a replay that can’t start within 2 s, and never runs it', async () => {
    vi.useFakeTimers()
    const queue = new ReplayQueue(gatewayPolicy({ replaysRunning: 1 }))
    const first = gate()
    void queue.run({}, first.replay)
    const late = vi.fn(async () => 'late')
    const result = queue.run({}, late)
    await vi.advanceTimersByTimeAsync(GATEWAY_POLICY.replayStartMs - 1)
    expect(queue.counts().waiting).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toBe('busy')
    expect(queue.counts()).toEqual({ running: 1, waiting: 0 })
    first.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(late).not.toHaveBeenCalled()
  })

  it('keeps a socket’s replays in order behind another socket’s, and frees the slot when a replay throws', async () => {
    vi.useFakeTimers()
    const queue = new ReplayQueue(gatewayPolicy({ replaysRunning: 1 }))
    const a = {}
    const b = {}
    const order: string[] = []
    const blocker = gate()
    const first = queue.run(a, () => blocker.replay().then(() => order.push('a1')))
    const failing = queue.run(b, async () => {
      order.push('b1')
      throw new Error('replay failed')
    })
    const second = queue.run(a, async () => order.push('a2'))
    blocker.open()
    await first
    await expect(failing).rejects.toThrow(/replay failed/)
    await second
    expect(order).toEqual(['a1', 'b1', 'a2'])
    expect(queue.counts()).toEqual({ running: 0, waiting: 0 })
  })
})
