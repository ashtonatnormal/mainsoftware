// The org event streams (BUILD-PLAN C0.7, TECH-SPEC T19 item 9): the producer, which numbers each
// entry and trims by age, and the reader that fans entries out to the sockets holding their topics,
// never sends a stream id or an entry's number, and resets an org wherever it can't be sure every
// entry was sent (re-authorise and refetch, the owner's decision).
import { ServerFrame } from '@hearth/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'
import { GATEWAY_POLICY, gatewayPolicy } from '#src/realtime/policy.ts'
import {
  compareIds,
  evFrame,
  PUBLISH_TOPIC_EVENT,
  publishTopicEvent,
  StreamReader,
  type StreamTarget,
} from '#src/realtime/stream.ts'
import { captureLogger } from '#src/testing/logs.ts'
import { fakeStreams } from '#src/testing/streams.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const OTHER_ORG = 'a0000000-0000-4000-8000-000000000002'
const PERSON = 'b0000000-0000-4000-8000-000000000001'
const OTHER_PERSON = 'b0000000-0000-4000-8000-000000000002'
const ITEM = 'd0000000-0000-4000-8000-000000000001'
const EPOCH = 'e0000000-0000-4000-8000-000000000001'
const PREFIX = 'it:unit:'
const keys = valkeyKeys(PREFIX)
const STREAM = keys.stream(ORG)
const EPOCH_KEY = keys.epoch(ORG)
// The clock's start, so the first entry appended at T0 is T0-0.
const T0 = 1_800_000_000_000

const personTopic = `person:${PERSON}`
const otherPersonTopic = `person:${OTHER_PERSON}`
const orgTopic = `org:${ORG}`

const entry = (topic: string, ids: Record<string, unknown> = { item: ITEM }, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, k: 'ev', topic, type: 'inbox.changed', ids, ...extra })

afterEach(() => {
  vi.useRealTimers()
})

// The gateway's side of the reader, as plain sockets: each holds topics in a state, and records
// the evs it was sent (sent), and those with each reset of its org in the order they came (seen:
// 'reset', or the ev's item).
type HoldState = 'deciding' | 'live'
interface Socket {
  org: string
  topics: Map<string, HoldState>
  sent: string[]
  seen: string[]
}

function gateway() {
  const sockets = new Set<Socket>()
  const resets: string[] = []
  const target: StreamTarget<Socket> = {
    orgsWithSockets: () => new Set([...sockets].map(socket => socket.org)),
    // As the gateway's index: live topics only.
    byTopic: (orgId, topic) =>
      [...sockets].filter(socket => socket.org === orgId && socket.topics.get(topic) === 'live'),
    send: (socket, text) => {
      socket.sent.push(text)
      socket.seen.push(String((JSON.parse(text) as { ids: { item?: string } }).ids.item))
    },
    resetOrg: orgId => {
      resets.push(orgId)
      for (const socket of sockets) if (socket.org === orgId) socket.seen.push('reset')
    },
  }
  const open = (org: string, topics: Record<string, HoldState> = {}): Socket => {
    const socket: Socket = { org, topics: new Map(Object.entries(topics)), sent: [], seen: [] }
    sockets.add(socket)
    return socket
  }
  return { target, sockets, resets, open, close: (socket: Socket) => sockets.delete(socket) }
}

// A reader on the fake Valkey (another reader of the same org can share it: valkey).
function setup(o: { policy?: Parameters<typeof gatewayPolicy>[0]; valkey?: ReturnType<typeof fakeStreams> } = {}) {
  if (o.valkey === undefined) vi.useFakeTimers({ now: T0 })
  const valkey = o.valkey ?? fakeStreams()
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

// The ids each ev a socket was sent names (every entry here carries its own item id).
const sentItems = (socket: Socket) => socket.sent.map(text => (JSON.parse(text) as { ids: { item?: string } }).ids.item)
const item = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
// Every script call (EVALSHA or EVAL) the client made.
const scripts = (valkey: ReturnType<typeof fakeStreams>) =>
  valkey.client.evalsha.mock.calls.length + valkey.client.eval.mock.calls.length

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
    expect(() => compareIds('1-0', 'x')).toThrow(/stream id/)
  })
})

describe('C0.7 T19 item 9 the producer, publishTopicEvent()', () => {
  it('GW-10 T19 item 9: appends one numbered ids-only entry with its epoch, its trims and both expiries in one script, by EVALSHA once Valkey has it', async () => {
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
    expect(args.slice(0, 5)).toEqual([
      STREAM,
      EPOCH_KEY,
      GATEWAY_POLICY.streamMaxAgeMs,
      GATEWAY_POLICY.streamMaxLen,
      GATEWAY_POLICY.streamTtlMs,
    ])
    expect(JSON.parse(String(args[6]))).toEqual({
      v: 1,
      k: 'ev',
      topic: orgTopic,
      type: 'flags.changed',
      ids: { count: 3, items: [ITEM], seen: true },
    })
    // One hash slot for both keys ({<org>}), so the script runs unchanged on a cluster.
    expect(STREAM).toBe(`${PREFIX}rt:{${ORG}}`)
    expect(EPOCH_KEY).toBe(`${PREFIX}rt:{${ORG}}:epoch`)
    // The script itself: SET NX PX; the number from the stream's own entries-added; the age by
    // Valkey's clock; XADD with MINID ~ (by age, never by count) and the number; the count cap only
    // after, as a backstop; then PEXPIRE on both. The gateway (gateway.integration.test.ts) runs it
    // on the Compose stack's Valkey.
    expect(PUBLISH_TOPIC_EVENT.lua).toContain("redis.call('SET', KEYS[2], ARGV[4], 'NX', 'PX', ARGV[3])")
    expect(PUBLISH_TOPIC_EVENT.lua).toContain("redis.call('XINFO', 'STREAM', KEYS[1])")
    expect(PUBLISH_TOPIC_EVENT.lua).toContain("info[i] == 'entries-added'")
    expect(PUBLISH_TOPIC_EVENT.lua).toContain("redis.call('TIME')")
    expect(PUBLISH_TOPIC_EVENT.lua).toContain(
      "redis.call('XADD', KEYS[1], 'MINID', '~', string.format('%.0f-0', oldest), '*', 'n', string.format('%.0f', added + 1), 'f', ARGV[5])",
    )
    expect(PUBLISH_TOPIC_EVENT.lua).not.toMatch(/'XADD'[^\n]*'MAXLEN'/)
    expect(PUBLISH_TOPIC_EVENT.lua).toContain("redis.call('XTRIM', KEYS[1], 'MAXLEN', '~', ARGV[2])")
    expect(PUBLISH_TOPIC_EVENT.lua).toContain("redis.call('PEXPIRE', KEYS[1], ARGV[3])")
    expect(PUBLISH_TOPIC_EVENT.lua).toContain("redis.call('PEXPIRE', KEYS[2], ARGV[3])")
    // Each entry numbered one more than the last: 1, then 2.
    expect(valkey.streams.get(STREAM)?.entries.map(([, fields]) => fields.slice(0, 2))).toEqual([
      ['n', '1'],
      ['n', '2'],
    ])
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
  it('GW-10 T19 item 9: at first reads the epoch (SET NX, keeping one that is there) and the stream’s tail, and is ready; it runs no script and appends nothing, so an org with no stream keeps none', async () => {
    const { valkey, g, reader } = setup()
    valkey.strings.set(EPOCH_KEY, EPOCH)
    valkey.add(STREAM, entry(personTopic, { item: item(1) }), T0 - 5000)
    valkey.add(STREAM, entry(personTopic, { item: item(2) }), T0 - 4000)
    const live = g.open(ORG, { [personTopic]: 'live' })
    expect(await reader.ready(ORG)).toBe(true)
    expect(valkey.strings.get(EPOCH_KEY)).toBe(EPOCH)
    expect(valkey.client.set).toHaveBeenCalledWith(
      EPOCH_KEY,
      expect.any(String),
      'PX',
      GATEWAY_POLICY.streamTtlMs,
      'NX',
    )
    expect(valkey.client.xrevrange).toHaveBeenCalledWith(STREAM, '+', '-', 'COUNT', 1)
    // Asked again, the tail isn't read again.
    const tails = valkey.client.xrevrange.mock.calls.length
    expect(await reader.ready(ORG)).toBe(true)
    expect(valkey.client.xrevrange.mock.calls.length).toBe(tails)
    // The entries up to the tail came before this process followed the org: never sent.
    reader.start()
    await run(GATEWAY_POLICY.readerBlockMs)
    expect(live.sent).toEqual([])
    expect(valkey.streams.get(STREAM)?.entries).toHaveLength(2)

    // An org with no stream and no epoch: an epoch is made, and the stream stays absent.
    g.open(OTHER_ORG, { [`org:${OTHER_ORG}`]: 'live' })
    expect(await reader.ready(OTHER_ORG)).toBe(true)
    await run(GATEWAY_POLICY.readerBlockMs * 2)
    expect(valkey.strings.get(keys.epoch(OTHER_ORG))).toMatch(/^[0-9a-f-]{36}$/)
    expect(valkey.streams.has(keys.stream(OTHER_ORG))).toBe(false)
    expect(scripts(valkey)).toBe(0)
    expect(g.resets).toEqual([])
  })

  it('GW-10 §5.5 T19 item 9: sends each entry to the sockets holding its topic live, as one ev frame of the entry’s topic, type and ids that never carries its stream id; deciding sockets, other topics and other orgs get nothing', async () => {
    const { valkey, g, reader } = setup()
    const live = g.open(ORG, { [personTopic]: 'live', [orgTopic]: 'live' })
    const alsoLive = g.open(ORG, { [personTopic]: 'live' })
    const deciding = g.open(ORG, { [personTopic]: 'deciding' })
    const other = g.open(ORG, { [otherPersonTopic]: 'live' })
    const elsewhere = g.open(OTHER_ORG, { [personTopic]: 'live' })
    reader.start()
    await run()
    const id = valkey.add(STREAM, entry(personTopic, { item: ITEM, count: 2 }))
    await run()
    const frame = { v: 1, t: 'ev', topic: personTopic, type: 'inbox.changed', ids: { item: ITEM, count: 2 } }
    expect(live.sent.map(text => JSON.parse(text))).toEqual([frame])
    // The frame the server sends is a strict ServerFrame, serialised once for every socket.
    expect(ServerFrame.parse(frame)).toEqual(frame)
    expect(live.sent[0]).toBe(evFrame(personTopic, 'inbox.changed', { item: ITEM, count: 2 }))
    expect(alsoLive.sent).toEqual(live.sent)
    // Neither the entry's id nor its time.
    expect(live.sent[0]).not.toContain(id)
    expect(live.sent[0]).not.toContain(String(T0))
    expect(deciding.sent).toEqual([])
    expect(other.sent).toEqual([])
    expect(elsewhere.sent).toEqual([])

    // Many entries on two topics, more than a page: each socket gets its own topic's, in order.
    for (let n = 1; n <= 600; n++) {
      valkey.add(STREAM, entry(n % 2 === 0 ? personTopic : otherPersonTopic, { item: item(n) }))
    }
    await run(1)
    expect(sentItems(alsoLive)).toEqual([ITEM, ...Array.from({ length: 300 }, (_, i) => item(2 * (i + 1)))])
    expect(sentItems(other)).toEqual(Array.from({ length: 300 }, (_, i) => item(2 * i + 1)))
    // Every frame sent is an ev with these fields and no other: nothing read from the org's stream
    // as a whole.
    for (const socket of [live, alsoLive, other]) {
      for (const text of socket.sent) {
        expect(Object.keys(JSON.parse(text)).sort()).toEqual(['ids', 't', 'topic', 'type', 'v'])
        expect(text).not.toMatch(/\d{13}-\d+/)
      }
    }
    expect(g.resets).toEqual([])
  })

  it('§5.3: skips an entry of another version or kind, or one that isn’t JSON, counting it and moving past it', async () => {
    const { valkey, g, reader, log } = setup()
    const live = g.open(ORG, { [personTopic]: 'live' })
    reader.start()
    await run()
    valkey.add(STREAM, entry(personTopic, {}, { v: 2 }))
    valkey.add(STREAM, entry(personTopic, {}, { k: 'other' }))
    valkey.add(STREAM, JSON.stringify({ v: 1, k: 'tick' }))
    valkey.add(STREAM, 'not json')
    await run()
    expect(live.sent).toEqual([])
    expect(reader.stats().skipped).toBe(4)
    // Logged at debug, at most once a minute.
    expect(log.events('stream_entry_skipped').map(line => [line.level, line.skipped])).toEqual([[20, 1]])
    await run(60_000)
    valkey.add(STREAM, 'still not json')
    await run()
    expect(log.events('stream_entry_skipped').map(line => line.skipped)).toEqual([1, 4])
    // A later field it doesn't know is ignored, not refused.
    valkey.add(STREAM, entry(personTopic, { item: ITEM }, { later: 'field' }))
    await run()
    expect(sentItems(live)).toEqual([ITEM])
  })

  it('S6: resets the org when its epoch changes (the key lost, or replaced by another reader), and reads a new stream from its start', async () => {
    const { valkey, g, reader, log } = setup()
    const live = g.open(ORG, { [personTopic]: 'live' })
    reader.start()
    await run()
    valkey.add(STREAM, entry(personTopic, { item: item(1) }))
    await run()
    const before = valkey.strings.get(EPOCH_KEY)
    // A restart without persistence: both keys are gone.
    valkey.del(STREAM, EPOCH_KEY)
    await run(GATEWAY_POLICY.readerEpochCheckMs + GATEWAY_POLICY.readerBlockMs)
    expect(g.resets).toEqual([ORG])
    expect(valkey.strings.get(EPOCH_KEY)).not.toBe(before)
    expect(log.events('stream_reset').map(line => [line.org, line.reason])).toEqual([[ORG, 'epoch']])
    // A producer writes a new stream, whose ids may fall below what the reader had read: its
    // entries are read from the start.
    valkey.add(STREAM, entry(personTopic, { item: item(2) }), T0)
    await run()
    expect(sentItems(live)).toEqual([item(1), item(2)])
    // Another reader that found a lost tail writes a new epoch over this one's: reset again.
    valkey.strings.set(EPOCH_KEY, 'e0000000-0000-4000-8000-0000000000bb')
    await run(GATEWAY_POLICY.readerEpochCheckMs + GATEWAY_POLICY.readerBlockMs)
    expect(g.resets).toEqual([ORG, ORG])
    expect(log.events('stream_reset').map(line => line.reason)).toEqual(['epoch', 'epoch'])
  })

  it('S6 T19 item 9: resets the org when the stream was trimmed past the reader while it couldn’t read, found by the read from the first entry’s number; the reset comes before the entries after the gap, which are sent as usual', async () => {
    const { valkey, g, reader, log } = setup()
    const live = g.open(ORG, { [personTopic]: 'live' })
    valkey.add(STREAM, entry(personTopic, { item: item(0) }))
    reader.start()
    await run()
    // The reader's connection drops; meanwhile entries are added and the head trimmed past it.
    valkey.fail('xread')
    await run(GATEWAY_POLICY.readerBlockMs)
    for (let n = 1; n <= 5; n++) valkey.add(STREAM, entry(personTopic, { item: item(n) }))
    valkey.trim(STREAM, 3)
    await run(GATEWAY_POLICY.readerRetryMs)
    expect(log.events('stream_reset').map(line => line.reason)).toEqual(['trimmed'])
    expect(g.resets).toEqual([ORG])
    // Entries 1 and 2 are gone: the reset covers them, and what came after them follows it.
    expect(live.seen).toEqual(['reset', item(3), item(4), item(5)])
    // It goes on from there.
    valkey.add(STREAM, entry(personTopic, { item: item(9) }))
    await run()
    expect(live.seen).toEqual(['reset', item(3), item(4), item(5), item(9)])
    expect(g.resets).toEqual([ORG])
  })

  it('S6 T19 item 9: finds a trim that lands while its XREAD is in flight (blocked, then answered from the trimmed head past its position), which no check before the read can see', async () => {
    const { valkey, g, reader, log } = setup()
    const live = g.open(ORG, { [personTopic]: 'live' })
    valkey.add(STREAM, entry(personTopic, { item: item(0) }))
    reader.start()
    await run()
    // Its checks pass, and it blocks in XREAD from its position.
    await run(GATEWAY_POLICY.readerEpochCheckMs + 1)
    expect(g.resets).toEqual([])
    // One burst, as a MULTI or a stalled process meeting the backstop: its own entry first, then
    // others, and the head trimmed past both the reader's position and its own entry before the
    // blocked read is answered.
    valkey.add(STREAM, entry(personTopic, { item: item(1) }), undefined, { quiet: true })
    for (let n = 2; n <= 8; n++)
      valkey.add(STREAM, entry(otherPersonTopic, { item: item(n) }), undefined, { quiet: true })
    valkey.trim(STREAM, 3)
    valkey.add(STREAM, entry(personTopic, { item: item(9) }))
    await run()
    expect(log.events('stream_reset').map(line => line.reason)).toEqual(['trimmed'])
    // The lost entry of its own topic is covered by the reset, which comes first.
    expect(live.seen).toEqual(['reset', item(9)])
  })

  it('S6 T19 item 9: finds a trim through the producer’s own script that passes a reader behind on an existing stream between its passing check and its XREAD (cap 20, pages of 5): every entry after its start is sent, or the org is reset', async () => {
    const { valkey, g, reader, log, policy } = setup({ policy: { readerCount: 5, streamMaxLen: 20 } })
    const live = g.open(ORG, { [personTopic]: 'live' })
    const publish = (n: number) =>
      publishTopicEvent(
        valkey.asClient,
        PREFIX,
        ORG,
        { topic: personTopic, type: 'inbox.changed', ids: { item: item(n) } },
        log.logger,
        { policy, rethrow: true },
      )
    await publish(0)
    reader.start()
    await run(10)
    let n = 1
    for (; n <= 12; n++) await publish(n)
    // Right after the next check's reads of the stream (its MULTI), before its XREAD, a burst of 30
    // lands.
    let burst = false
    valkey.between(async command => {
      if (burst || command !== 'multi') return
      burst = true
      for (let k = 0; k < 30; k++) await publish(n++)
    })
    await run(policy.readerEpochCheckMs * 10)
    expect([burst, n]).toEqual([true, 43])
    // Entries 13 to 22 were trimmed before the reader read them (the cap keeps 23 to 42): the reset
    // comes before the first entry after them.
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => item(from + i))
    expect(live.seen).toEqual([...range(1, 12), 'reset', ...range(23, 42)])
    expect(log.events('stream_reset').map(line => line.reason)).toEqual(['trimmed'])
  })

  it('T19 item 9: the reader’s own last entry trimmed (by age, or the backstop) while nothing after it was missed is no gap, though the head is then past its position when a check runs', async () => {
    const { valkey, g, reader, log } = setup()
    const live = g.open(ORG, { [personTopic]: 'live' })
    reader.start()
    await run()
    valkey.add(STREAM, entry(personTopic, { item: item(1) }))
    valkey.add(STREAM, entry(personTopic, { item: item(2) }))
    await run()
    expect(sentItems(live)).toEqual([item(1), item(2)])
    // A quiet org: the next append trims everything older, the reader's own entry included, and a
    // check (after the read the connection lost) runs before the read that gets the new entry.
    valkey.fail('xread')
    await run(GATEWAY_POLICY.readerBlockMs)
    valkey.add(STREAM, entry(personTopic, { item: item(3) }))
    valkey.trim(STREAM, 1)
    await run(GATEWAY_POLICY.readerRetryMs)
    expect(log.events('stream_reader_failed').map(line => line.step)).toEqual(['read'])
    expect(sentItems(live)).toEqual([item(1), item(2), item(3)])
    expect(g.resets).toEqual([])
    expect(log.events('stream_reset')).toEqual([])
  })

  it.each([1, 2, 3, 4])(
    'T19 item 9: an append on a topic a socket doesn’t hold, after a minute of quiet, that trims the reader’s own last entry by age while a check runs, landing after the check’s command %i, resets no socket: the check reads the head, the tail and the entry at its position in one MULTI',
    async landAfter => {
      // The production policy: a 60 s age limit, checks every 2 s.
      const { valkey, g, reader, log, policy } = setup()
      const mine = g.open(ORG, { [personTopic]: 'live' })
      const theirs = g.open(ORG, { [otherPersonTopic]: 'live' })
      const publish = (n: number) =>
        publishTopicEvent(
          valkey.asClient,
          PREFIX,
          ORG,
          { topic: otherPersonTopic, type: 'inbox.changed', ids: { item: item(n) } },
          log.logger,
          { policy, rethrow: true },
        )
      reader.start()
      await run()
      await publish(1)
      await publish(2)
      await run()
      expect(sentItems(theirs)).toEqual([item(1), item(2)])
      // 62 s of quiet: the checks pass, and both entries grow older than the age limit.
      await run(62_000)
      expect(g.resets).toEqual([])
      // The next check's commands are counted from its first, the epoch's GET; the third append
      // lands after the one this case names. Separate reads would see the head at or below the
      // reader's position and then its entry gone, a lost tail.
      let counted = 0
      let landed = false
      valkey.between(async (command, args) => {
        if (landed || (counted === 0 && !(command === 'get' && args[0] === EPOCH_KEY))) return
        counted++
        if (counted < landAfter) return
        landed = true
        await publish(3)
      })
      await run(policy.readerEpochCheckMs * 4)
      expect(landed).toBe(true)
      // The append trimmed both earlier entries, the reader's own last one among them.
      expect(valkey.streams.get(STREAM)?.entries.map(([, fields]) => fields[1])).toEqual(['3'])
      expect(sentItems(theirs)).toEqual([item(1), item(2), item(3)])
      expect(mine.seen).toEqual([])
      expect(g.resets).toEqual([])
      expect(log.events('stream_reset')).toEqual([])
      expect(valkey.strings.get(EPOCH_KEY)).toMatch(/^[0-9a-f-]{36}$/)
    },
  )

  it('S6: resets the org when the tail it read is gone (last < its position), and not for an absent stream under the same epoch', async () => {
    const { valkey, g, reader, log } = setup()
    const live = g.open(ORG, { [personTopic]: 'live' })
    reader.start()
    await run()
    valkey.add(STREAM, entry(personTopic, { item: item(1) }), T0 + 1000)
    valkey.add(STREAM, entry(personTopic, { item: item(2) }), T0 + 2000)
    await run()
    expect(sentItems(live)).toEqual([item(1), item(2)])
    const before = valkey.strings.get(EPOCH_KEY)
    // A failover lost the newest entry.
    valkey.loseTail(STREAM, 1)
    await run(GATEWAY_POLICY.readerEpochCheckMs + GATEWAY_POLICY.readerBlockMs)
    expect(log.events('stream_reset').map(line => line.reason)).toEqual(['tail_lost'])
    expect(g.resets).toEqual([ORG])
    // Lost for every reader: the epoch is replaced, so every other reader of the org resets too.
    expect(valkey.strings.get(EPOCH_KEY)).not.toBe(before)

    // The stream expired, but its epoch is the same: nothing was written after the reader's
    // position, so it isn't a gap.
    valkey.streams.delete(STREAM)
    await run(GATEWAY_POLICY.readerEpochCheckMs * 5)
    expect(g.resets).toHaveLength(1)
  })

  it('S6: finds a failover that lost the tail although the new primary appended first; every reader of the org resets, and none sends the new primary’s entry as though the stream were whole', async () => {
    const a = setup()
    const b = setup({ valkey: a.valkey })
    const { valkey } = a
    const liveA = a.g.open(ORG, { [personTopic]: 'live' })
    const liveB = b.g.open(ORG, { [personTopic]: 'live' })
    a.reader.start()
    b.reader.start()
    await run()
    valkey.add(STREAM, entry(personTopic, { item: item(1) }), T0 + 1000)
    valkey.add(STREAM, entry(personTopic, { item: item(2) }), T0 + 2000)
    await run()
    for (const live of [liveA, liveB]) expect(sentItems(live)).toEqual([item(1), item(2)])
    const before = valkey.strings.get(EPOCH_KEY)
    // The failover: both readers' connections drop, the replica lacked the newest entry, and a
    // producer appends on the new primary before either looks again.
    valkey.fail('xread')
    valkey.fail('xread')
    await run(GATEWAY_POLICY.readerBlockMs)
    valkey.loseTail(STREAM, 1)
    valkey.add(STREAM, entry(personTopic, { item: item(3) }))
    await run(GATEWAY_POLICY.readerRetryMs + GATEWAY_POLICY.readerEpochCheckMs + GATEWAY_POLICY.readerBlockMs)
    const reasons = [...a.log.events('stream_reset'), ...b.log.events('stream_reset')].map(line => line.reason)
    expect(reasons).toContain('tail_lost')
    expect(new Set(reasons).size).toBeLessThanOrEqual(2)
    for (const reason of reasons) expect(['tail_lost', 'epoch']).toContain(reason)
    expect(a.g.resets.length).toBeGreaterThanOrEqual(1)
    expect(b.g.resets.length).toBeGreaterThanOrEqual(1)
    expect(valkey.strings.get(EPOCH_KEY)).not.toBe(before)
    // The new primary's entry is covered by the resets, never sent as a continuation.
    for (const live of [liveA, liveB]) expect(sentItems(live)).toEqual([item(1), item(2)])
    // Both continue from there.
    valkey.add(STREAM, entry(personTopic, { item: item(4) }))
    await run()
    for (const live of [liveA, liveB]) expect(sentItems(live)).toEqual([item(1), item(2), item(4)])
  })

  it('S6: an org whose due gap check failed isn’t read until one passes, so a read can’t carry it past a lost tail unseen', async () => {
    const { valkey, g, reader, log } = setup()
    const live = g.open(ORG, { [personTopic]: 'live' })
    reader.start()
    await run()
    valkey.add(STREAM, entry(personTopic), T0 + 1000)
    valkey.add(STREAM, entry(personTopic), T0 + 2000)
    await run()
    expect(live.sent).toHaveLength(2)
    valkey.fail('xread')
    await run(GATEWAY_POLICY.readerBlockMs)
    valkey.loseTail(STREAM, 1)
    valkey.add(STREAM, entry(personTopic))
    // The reader's connection is back, but the check's first command fails.
    valkey.fail('get')
    await run(GATEWAY_POLICY.readerRetryMs)
    expect(log.events('stream_reader_failed').map(line => line.step)).toEqual(['read', 'check'])
    expect(live.sent).toHaveLength(2)
    expect(g.resets).toEqual([])
    // Then its MULTI of the stream's reads fails.
    valkey.fail('multi')
    await run(GATEWAY_POLICY.readerRetryMs)
    expect(log.events('stream_reader_failed').map(line => line.step)).toEqual(['read', 'check', 'check'])
    expect(live.sent).toHaveLength(2)
    expect(g.resets).toEqual([])
    await run(GATEWAY_POLICY.readerRetryMs)
    expect(log.events('stream_reset').map(line => line.reason)).toEqual(['tail_lost'])
    // The new primary's entry was never sent as though the stream were whole: the reset covers it.
    expect(live.sent).toHaveLength(2)
  })

  it('S6 T19 item 9: a stream absent when the reader started is read from its start, so its first entry must be numbered 1; trimmed before the reader read any of it, it resets (trimmed) before sending what is left', async () => {
    const { valkey, g, reader, log } = setup()
    const live = g.open(ORG, { [personTopic]: 'live' })
    reader.start()
    await run()
    // The reader's connection drops while a producer creates and overfills the stream.
    valkey.fail('xread')
    await run(GATEWAY_POLICY.readerBlockMs)
    for (let n = 1; n <= 5; n++) valkey.add(STREAM, entry(personTopic, { item: item(n) }))
    valkey.trim(STREAM, 3)
    await run(GATEWAY_POLICY.readerRetryMs)
    expect(log.events('stream_reset').map(line => line.reason)).toEqual(['trimmed'])
    expect(live.seen).toEqual(['reset', item(3), item(4), item(5)])
    valkey.add(STREAM, entry(personTopic, { item: item(6) }))
    await run()
    expect(live.seen).toEqual(['reset', item(3), item(4), item(5), item(6)])
  })

  it('S6 T19 item 9: a stream absent when the reader started, trimmed while its first XREAD was in flight although its last check passed, resets before the first entry it sends', async () => {
    const { valkey, g, reader, log } = setup()
    const live = g.open(ORG, { [personTopic]: 'live' })
    reader.start()
    await run()
    // A burst while the reader blocked from 0-0, written before the append that wakes the reader.
    for (let n = 1; n <= 4; n++) valkey.add(STREAM, entry(personTopic, { item: item(n) }), undefined, { quiet: true })
    valkey.trim(STREAM, 2)
    valkey.add(STREAM, entry(personTopic, { item: item(5) }))
    await run()
    expect(live.seen).toEqual(['reset', item(3), item(4), item(5)])
    expect(log.events('stream_reset').map(line => line.reason)).toEqual(['trimmed'])
    expect(g.resets).toEqual([ORG])
  })

  it('S6 T19 item 9: a stream absent when the reader started and read whole needs no more than the checks’ usual commands, and trimming what was read is no gap', async () => {
    const { valkey, g, reader } = setup()
    const live = g.open(ORG, { [personTopic]: 'live' })
    reader.start()
    await run()
    valkey.add(STREAM, entry(personTopic, { item: item(1) }))
    await run()
    valkey.add(STREAM, entry(personTopic, { item: item(2) }))
    await run(GATEWAY_POLICY.readerEpochCheckMs * 3)
    expect(sentItems(live)).toEqual([item(1), item(2)])
    expect(g.resets).toEqual([])
    valkey.trim(STREAM, 1)
    await run(GATEWAY_POLICY.readerEpochCheckMs * 3)
    valkey.add(STREAM, entry(personTopic, { item: item(3) }))
    await run()
    expect(sentItems(live)).toEqual([item(1), item(2), item(3)])
    expect(g.resets).toEqual([])
  })

  it('S6 T19 item 9: an entry numbered at or below the last one read (a failover lost what the reader had read, and the new primary appended above its position) resets the org at the read (tail_lost), and the next check replaces the epoch, so a reader whose numbers still run on resets too', async () => {
    const a = setup()
    const b = setup({ valkey: a.valkey })
    const { valkey } = a
    const liveA = a.g.open(ORG, { [personTopic]: 'live' })
    const liveB = b.g.open(ORG, { [personTopic]: 'live' })
    a.reader.start()
    await run()
    valkey.add(STREAM, entry(personTopic, { item: item(1) }))
    await run()
    // B follows the org from entry 1 and reads nothing more yet; A reads entry 2 as well.
    expect(await b.reader.ready(ORG)).toBe(true)
    valkey.add(STREAM, entry(personTopic, { item: item(2) }))
    await run()
    expect(sentItems(liveA)).toEqual([item(1), item(2)])
    const before = valkey.strings.get(EPOCH_KEY)
    // The failover: the replica lacked entry 2, and the new primary numbers its first entry 2 again,
    // with an id above A's position.
    valkey.loseTail(STREAM, 1)
    valkey.add(STREAM, entry(personTopic, { item: item(3) }))
    await run()
    expect(a.log.events('stream_reset').map(line => line.reason)).toEqual(['tail_lost'])
    // The reset came before the new primary's entry, which is sent after it.
    expect(liveA.seen).toEqual([item(1), item(2), 'reset', item(3)])
    // A replaces the epoch at its next check, which comes before its next read.
    await run(GATEWAY_POLICY.readerRetryMs)
    expect(valkey.strings.get(EPOCH_KEY)).not.toBe(before)
    const replaced = valkey.strings.get(EPOCH_KEY)
    // B's numbers run on (1, then the new 2): only the epoch tells it entry 2 was lost, and it resets
    // at its first check.
    b.reader.start()
    await run(GATEWAY_POLICY.readerEpochCheckMs + GATEWAY_POLICY.readerBlockMs)
    expect(b.log.events('stream_reset').map(line => line.reason)).toEqual(['epoch'])
    expect(liveB.seen).toEqual([item(3), 'reset'])
    // A holds the epoch it wrote: no second reset of its own.
    await run(GATEWAY_POLICY.readerEpochCheckMs * 3)
    expect(valkey.strings.get(EPOCH_KEY)).toBe(replaced)
    expect([a.g.resets, b.g.resets]).toEqual([[ORG], [ORG]])
  })

  it('§5.3 T19 item 9: an entry with no number isn’t the producer’s: it isn’t sent, and the next numbered entry resets the org once, as does the first after a tail with none', async () => {
    const { valkey, g, reader, log } = setup()
    const live = g.open(ORG, { [personTopic]: 'live' })
    valkey.add(STREAM, entry(personTopic, { item: item(0) }), undefined, { unnumbered: true })
    reader.start()
    await run()
    // The tail it started from had no number: the first numbered entry can't be placed after it.
    valkey.add(STREAM, entry(personTopic, { item: item(1) }))
    await run()
    expect(live.seen).toEqual(['reset', item(1)])
    valkey.add(STREAM, entry(personTopic, { item: item(2) }))
    await run()
    // Two with no number, then a numbered one: neither is sent, and one reset comes before it.
    valkey.add(STREAM, entry(personTopic, { item: item(3) }), undefined, { unnumbered: true })
    valkey.add(STREAM, entry(personTopic, { item: item(4) }), undefined, { unnumbered: true })
    valkey.add(STREAM, entry(personTopic, { item: item(5) }))
    await run()
    expect(live.seen).toEqual(['reset', item(1), item(2), 'reset', item(5)])
    expect(log.events('stream_reset').map(line => line.reason)).toEqual(['unnumbered', 'unnumbered'])
    expect(reader.stats().skipped).toBe(2)
  })

  it('S6: after a reconnect of its connection, checks every org for a gap before it reads again', async () => {
    // Periodic checks far apart, so only the reconnect can bring one.
    const { valkey, g, reader } = setup({ policy: { readerEpochCheckMs: 600_000 } })
    g.open(ORG, { [personTopic]: 'live' })
    reader.start()
    await run(GATEWAY_POLICY.readerBlockMs * 3)
    const checks = () => valkey.client.multi.mock.calls.length
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
    valkey.add(STREAM, entry(personTopic, { item: item(1) }))
    await run()
    expect(sentItems(socket)).toEqual([item(1)])
    expect(reader.stats().orgs).toBe(1)
    g.close(socket)
    await run(GATEWAY_POLICY.readerBlockMs + GATEWAY_POLICY.readerIdleMs)
    expect(reader.stats().orgs).toBe(0)
    // Entries written while nobody here held the org aren't sent to its next socket.
    valkey.add(STREAM, entry(personTopic, { item: item(2) }))
    valkey.add(STREAM, entry(personTopic, { item: item(3) }))
    const next = g.open(ORG, { [personTopic]: 'live' })
    reader.watch(ORG)
    await run()
    expect(next.sent).toEqual([])
    valkey.add(STREAM, entry(personTopic, { item: item(4) }))
    await run()
    expect(sentItems(next)).toEqual([item(4)])
    expect(g.resets).toEqual([])
  })

  it('T19 item 9: answers ready false while Valkey can’t be reached, logging the failures (an error from the third in a row); the read that then succeeds resets the org once, since a sub may have been acked meanwhile', async () => {
    const { valkey, g, reader, log } = setup()
    g.open(ORG, { [personTopic]: 'live' })
    valkey.fail('set')
    expect(await reader.ready(ORG)).toBe(false)
    valkey.fail('xrevrange')
    expect(await reader.ready(ORG)).toBe(false)
    valkey.fail('get')
    expect(await reader.ready(ORG)).toBe(false)
    expect(log.events('stream_reader_failed').map(line => [line.level, line.step, line.failures])).toEqual([
      [40, 'init', 1],
      [40, 'init', 2],
      [50, 'init', 3],
    ])
    expect(g.resets).toEqual([])
    expect(await reader.ready(ORG)).toBe(true)
    expect(g.resets).toEqual([ORG])
    expect(log.events('stream_reset').map(line => [line.org, line.reason])).toEqual([[ORG, 'late_start']])
    // Once: asked again, nothing more.
    expect(await reader.ready(ORG)).toBe(true)
    expect(g.resets).toEqual([ORG])
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
    expect(await reader.ready(OTHER_ORG)).toBe(false)
  })
})
