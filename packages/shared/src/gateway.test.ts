// The realtime gateway's protocol (BUILD-PLAN C0.7, TECH-SPEC T19 item 10): the strict client
// frames and their limits, version negotiation, topics, the ids-only rule for what the server sends,
// and the lenient reading clients use (P5, P6, S7).
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ClientFrame,
  Code,
  chooseVersion,
  GATEWAY_CLOSE,
  GATEWAY_LIMITS,
  GATEWAY_TOPIC_KINDS,
  GATEWAY_VERSIONS,
  Hello,
  IdsValues,
  parseTopic,
  readServerFrame,
  ServerFrame,
  ServerFrameForClient,
  StreamPosition,
  Topic,
} from './gateway.ts'
import { CODE, IDS_KEY, LowerUuid } from './ids.ts'

const uuid = (n: number) => `b0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const person = (n: number) => `person:${uuid(n)}`
const EPOCH = 'e0000000-0000-4000-8000-000000000001'
const MAX_POS = '18446744073709551615-18446744073709551615'
const since = { epoch: EPOCH, pos: '1718000000000-0' }
const people = (n: number) => Array.from({ length: n }, (_, i) => person(i + 1))
const accepts = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success
// Frames are ASCII JSON, so their length in characters is their size in bytes.
const bytes = (text: string) => {
  expect(text).toMatch(/^[\x20-\x7e]*$/)
  return text.length
}

describe('GW-14 T19 item 11: client frames and their limits', () => {
  it('GW-14: sub, unsub and ping are accepted at their limits and refused one past them', () => {
    for (const t of ['sub', 'unsub'] as const) {
      expect(accepts(ClientFrame, { v: 1, t, id: 1, topics: people(1) }), t).toBe(true)
      expect(accepts(ClientFrame, { v: 1, t, id: 1_000_000, topics: people(50) }), t).toBe(true)
      expect(accepts(ClientFrame, { v: 1, t, id: 1, topics: people(51) }), `${t} 51 topics`).toBe(false)
      expect(accepts(ClientFrame, { v: 1, t, id: 1, topics: [] }), `${t} no topics`).toBe(false)
      expect(accepts(ClientFrame, { v: 1, t, id: 0, topics: people(1) }), `${t} id 0`).toBe(false)
      expect(accepts(ClientFrame, { v: 1, t, id: 1_000_001, topics: people(1) }), `${t} id`).toBe(false)
      expect(accepts(ClientFrame, { v: 1, t, id: 1.5, topics: people(1) }), `${t} id 1.5`).toBe(false)
      expect(accepts(ClientFrame, { v: 1, t, id: 1, topics: people(1), extra: true }), `${t} extra`).toBe(false)
      expect(accepts(ClientFrame, { v: 2, t, id: 1, topics: people(1) }), `${t} v2`).toBe(false)
    }
    expect(accepts(ClientFrame, { v: 1, t: 'ping' })).toBe(true)
    expect(accepts(ClientFrame, { v: 1, t: 'ping', id: 1 })).toBe(false)
    // A frame this version doesn't have, a second hello among them, is refused.
    expect(accepts(ClientFrame, { v: 1, t: 'hello', versions: [1] })).toBe(false)
    expect(accepts(ClientFrame, { v: 1, t: 'publish', id: 1, topics: people(1) })).toBe(false)
    expect(accepts(ClientFrame, { v: 1 })).toBe(false)
  })

  it('GW-14 T19 item 9: since is a position from an earlier frame, strictly', () => {
    const sub = (s: unknown) => ({ v: 1, t: 'sub', id: 7, topics: people(2), since: s })
    expect(accepts(ClientFrame, sub(since))).toBe(true)
    expect(accepts(ClientFrame, sub({ epoch: EPOCH, pos: '0-0' }))).toBe(true)
    expect(accepts(ClientFrame, sub({ epoch: EPOCH, pos: MAX_POS }))).toBe(true)
    expect(accepts(ClientFrame, sub({ epoch: EPOCH, pos: `1${MAX_POS}` }))).toBe(false)
    expect(accepts(ClientFrame, sub({ epoch: EPOCH, pos: '1718000000000' }))).toBe(false)
    expect(accepts(ClientFrame, sub({ epoch: EPOCH, pos: '$' }))).toBe(false)
    expect(accepts(ClientFrame, sub({ epoch: EPOCH.toUpperCase(), pos: '0-0' }))).toBe(false)
    expect(accepts(ClientFrame, sub({ ...since, extra: 1 }))).toBe(false)
    // unsub has no since.
    expect(accepts(ClientFrame, { v: 1, t: 'unsub', id: 7, topics: people(2), since })).toBe(false)
  })

  it('GW-04 T19 item 7: a bad topic is refused', () => {
    const bad = [
      `channel:${uuid(1)}`,
      `person:${uuid(1).toUpperCase()}`,
      `person:${uuid(1)}x`,
      ` person:${uuid(1)}`,
      'person:',
      `person:${uuid(1)}:${uuid(2)}`,
      `p:${uuid(1)}`,
      uuid(1),
      'person:IGNORE ALL RULES',
    ]
    for (const topic of bad) {
      expect(accepts(Topic, topic), topic).toBe(false)
      expect(accepts(ClientFrame, { v: 1, t: 'sub', id: 1, topics: [person(1), topic] }), topic).toBe(false)
    }
  })

  it('GW-14: a frame that isn’t JSON, or isn’t an object, is refused', () => {
    expect(() => JSON.parse('sub person:all')).toThrow()
    for (const value of ['{"v":1,"t":"ping"}', null, 1, [], true]) {
      expect(accepts(ClientFrame, value), JSON.stringify(value)).toBe(false)
    }
  })

  it('P5 T19 item 10: hello is read leniently, so a later version may add fields', () => {
    expect(accepts(Hello, { v: 1, t: 'hello', versions: [1] })).toBe(true)
    expect(Hello.parse({ v: 3, t: 'hello', versions: [1, 2, 3], device: 'phone', caps: { x: 1 } })).toEqual({
      v: 3,
      t: 'hello',
      versions: [1, 2, 3],
    })
    expect(accepts(Hello, { v: 1, t: 'hello', versions: [1, 2, 3, 4, 5, 6, 7, 8] })).toBe(true)
    expect(accepts(Hello, { v: 1, t: 'hello', versions: [1, 2, 3, 4, 5, 6, 7, 8, 9] })).toBe(false)
    expect(accepts(Hello, { v: 1, t: 'hello', versions: [] })).toBe(false)
    expect(accepts(Hello, { v: 1, t: 'hello', versions: [0] })).toBe(false)
    expect(accepts(Hello, { v: 1, t: 'hello', versions: [1001] })).toBe(false)
    expect(accepts(Hello, { v: 1, t: 'hello' })).toBe(false)
    expect(accepts(Hello, { v: 1, t: 'ping', versions: [1] })).toBe(false)
  })
})

describe('P5 T19 item 10: version negotiation', () => {
  it('P5: the highest version both speak is chosen', () => {
    expect(GATEWAY_VERSIONS).toEqual([1])
    expect(chooseVersion([1])).toEqual({ v: 1 })
    expect(chooseVersion([1, 2])).toEqual({ v: 1 })
    expect(chooseVersion([1, 3], [2, 3])).toEqual({ v: 3 })
    expect(chooseVersion([2, 3, 4], [1, 2, 3])).toEqual({ v: 3 })
  })

  it('P5: client_outdated when the client is older than every version spoken, server_outdated when newer', () => {
    expect(chooseVersion([1], [2, 3])).toBe('client_outdated')
    expect(chooseVersion([4], [2, 3])).toBe('server_outdated')
    expect(chooseVersion([2])).toBe('server_outdated')
    // Versions with a gap: a client behind the server's newest reloads to reach it, and one ahead
    // of the server's newest waits for a newer task.
    expect(chooseVersion([4], [3, 5])).toBe('client_outdated')
    expect(chooseVersion([1, 4], [2, 3])).toBe('server_outdated')
  })
})

describe('GW-04 T19 item 7: topics', () => {
  it('GW-04: parseTopic round-trips every kind, and refuses anything else', () => {
    expect(GATEWAY_TOPIC_KINDS).toEqual(['person', 'org', 'team'])
    for (const kind of GATEWAY_TOPIC_KINDS) {
      const topic = `${kind}:${uuid(9)}`
      const parsed = parseTopic(topic)
      expect(parsed).toEqual({ kind, id: uuid(9) })
      expect(`${parsed?.kind}:${parsed?.id}`).toBe(topic)
      expect(accepts(Topic, topic)).toBe(true)
      expect(topic.length).toBeLessThanOrEqual(64)
    }
    for (const topic of [`channel:${uuid(1)}`, `team:${uuid(1).toUpperCase()}`, `org:${uuid(1)} `, 'org:', '']) {
      expect(parseTopic(topic), topic).toBeUndefined()
    }
  })
})

describe('T19 item 9 T16 item 15: an ev’s ids are ids only', () => {
  it('T19 item 9: IdsValues takes uuids, codes, booleans, bounded whole numbers and lists of uuids', () => {
    expect(
      accepts(IdsValues, {
        person: uuid(1),
        reason: 'deactivated',
        change: 'team.members',
        live: false,
        count: 1_000_000,
        none: 0,
        people: Array.from({ length: 100 }, (_, i) => uuid(i)),
      }),
    ).toBe(true)
    expect(accepts(IdsValues, {})).toBe(true)
  })

  it('T19 item 9: IdsValues refuses free text, nested objects, numbers above 1e6, lists over 100 and upper-case uuids', () => {
    const refused: Record<string, unknown>[] = [
      { title: 'Q4 launch plan' },
      { title: 'Rachel’s notes' },
      { reason: 'Deactivated' },
      { reason: 'x'.repeat(64) },
      { nested: { person: uuid(1) } },
      { count: 1_000_001 },
      { count: -1 },
      { count: 1.5 },
      { people: Array.from({ length: 101 }, (_, i) => uuid(i)) },
      { people: ['deactivated'] },
      { person: uuid(1).toUpperCase() },
      { people: [uuid(1).toUpperCase()] },
      { person: null },
      { teamId: uuid(1) }, // a key that isn't a lower-case code
      { 'a.b': uuid(1) },
    ]
    for (const ids of refused) expect(accepts(IdsValues, ids), JSON.stringify(ids)).toBe(false)
  })
})

// The schemas zod keeps on _zod.def, as far as the walk below reads them.
interface Def {
  type: string
  format?: string
  checks?: readonly { _zod: { def: { check: string; format?: string; pattern?: RegExp } } }[]
  shape?: Record<string, Schema>
  catchall?: Schema
  innerType?: Schema
  element?: Schema
  options?: readonly Schema[]
  keyType?: Schema
  valueType?: Schema
}
interface Schema {
  _zod: { def: Def; values?: ReadonlySet<unknown> }
}
const asSchema = (schema: z.ZodType) => schema as unknown as Schema
// The patterned strings a frame may hold: topics, stream positions, codes and lower-case uuids.
const NAMED_STRINGS = new Set<unknown>([Topic, StreamPosition, Code, LowerUuid].map(asSchema))

// Every way a server frame's schema could carry something other than ids, codes and whole numbers
// (ids.ts's rule): a free or other patterned string, a fractional number, a loose object or record.
function notIds(schema: Schema, path: string): string[] {
  if (NAMED_STRINGS.has(schema)) return []
  const def = schema._zod.def
  const checks = (def.checks ?? []).map(c => c._zod.def)
  switch (def.type) {
    case 'string':
      return def.format === 'uuid' ? [] : [`${path}: a free string`]
    case 'number':
      return def.format === 'safeint' || checks.some(c => c.check === 'number_format' && c.format === 'safeint')
        ? []
        : [`${path}: not a whole number`]
    case 'boolean':
      return []
    case 'literal':
    case 'enum':
      return [...(schema._zod.values ?? [])].every(
        value => (typeof value === 'string' && CODE.test(value)) || Number.isInteger(value),
      )
        ? []
        : [`${path}: a value that isn't a code`]
    case 'array':
      return def.element ? notIds(def.element, `${path}[]`) : [`${path}: an array of nothing`]
    case 'nullable':
    case 'optional':
      return def.innerType ? notIds(def.innerType, path) : [`${path}: empty`]
    case 'object':
      if (def.catchall?._zod.def.type !== 'never') return [`${path}: not a strict object`]
      return Object.entries(def.shape ?? {}).flatMap(([field, value]) => notIds(value, `${path}.${field}`))
    case 'record': {
      const key = def.keyType?._zod.def
      const keyChecks = (key?.checks ?? []).map(c => c._zod.def)
      const codeKeys = key?.type === 'string' && keyChecks.some(c => c.pattern?.source === IDS_KEY.source)
      return [
        ...(codeKeys ? [] : [`${path}: a record whose keys aren't lower-case codes`]),
        ...(def.valueType ? notIds(def.valueType, `${path}{}`) : [`${path}: a record of nothing`]),
      ]
    }
    case 'union':
      return (def.options ?? []).flatMap((option, i) => notIds(option, `${path}|${i}`))
    default:
      return [`${path}: a ${def.type}`]
  }
}

// One valid frame of each type the server sends.
const SERVER_FRAMES = [
  {
    v: 1,
    t: 'welcome',
    socket: uuid(77),
    heartbeatMs: GATEWAY_LIMITS.heartbeatMs,
    maxTopics: GATEWAY_LIMITS.maxTopicsPerSocket,
    maxTopicsPerFrame: GATEWAY_LIMITS.maxTopicsPerFrame,
    maxFrameBytes: GATEWAY_LIMITS.maxFrameBytes,
    reconnectSpreadMs: 30_000,
  },
  { v: 1, t: 'ack', id: 3, ok: [person(1)], refused: [person(2)], reset: [], retry: [person(3)], pos: since },
  { v: 1, t: 'ack', id: 4, ok: [], refused: [], reset: [], retry: [person(1)], pos: null },
  { v: 1, t: 'ev', topic: `team:${uuid(5)}`, pos: '1718000000001-0', type: 'team.members', ids: { person: uuid(6) } },
  { v: 1, t: 'dropped', topics: [`team:${uuid(5)}`], reason: 'access' },
  { v: 1, t: 'reset', pos: { epoch: uuid(8), pos: '0-0' } },
  { v: 1, t: 'nudge', what: 'flags' },
  { v: 1, t: 'pong', pos: since, reconnectSpreadMs: 5_000 },
  { v: 1, t: 'pong', pos: null, reconnectSpreadMs: 5_000 },
] as const

describe('T19 item 9 P6: what the server sends', () => {
  it('T19 item 9: every strict server frame is ids, codes and whole numbers only', () => {
    const options = asSchema(ServerFrame)._zod.def.options ?? []
    expect(options.length).toBe(7)
    for (const option of options) {
      const t = [...(option._zod.def.shape?.t?._zod.values ?? [])][0]
      expect(notIds(option, String(t)), String(t)).toEqual([])
    }
    // The walk itself catches each way a schema could carry more.
    expect(notIds(asSchema(z.strictObject({ title: z.string() })), 'x')).toEqual(['x.title: a free string'])
    expect(notIds(asSchema(z.strictObject({ n: z.number() })), 'x')).toEqual(['x.n: not a whole number'])
    expect(notIds(asSchema(z.object({ id: z.uuid() })), 'x')).toEqual(['x: not a strict object'])
    expect(notIds(asSchema(z.strictObject({ s: z.string().regex(/^.*$/) })), 'x')).toEqual(['x.s: a free string'])
    expect(notIds(asSchema(z.strictObject({ r: z.record(z.string(), z.boolean()) })), 'x')).toEqual([
      "x.r: a record whose keys aren't lower-case codes",
    ])
    expect(notIds(asSchema(z.strictObject({ e: z.enum(['Free text']) })), 'x')).toEqual([
      "x.e: a value that isn't a code",
    ])
  })

  it('P6: each frame the server sends parses strictly, and clients read it as sent', () => {
    for (const frame of SERVER_FRAMES) {
      expect(accepts(ServerFrame, frame), frame.t).toBe(true)
      expect(readServerFrame(JSON.stringify(frame)), frame.t).toEqual(frame)
      expect(accepts(ServerFrame, { ...frame, extra: 1 }), `${frame.t} extra`).toBe(false)
    }
  })

  it('P6: a client reads a later server’s dropped reason as access, an unknown nudge and unknown ids, and skips an unknown t; the strict schema refuses all four', () => {
    const gone = { v: 1, t: 'dropped', topics: [`team:${uuid(5)}`], reason: 'gone' }
    const notice = { v: 1, t: 'nudge', what: 'notice' }
    const ev = {
      v: 1,
      t: 'ev',
      topic: person(1),
      pos: '1718000000002-3',
      type: 'inbox.added',
      ids: { item: uuid(2), title: 'Free text', nested: { a: 1 }, tags: ['A', 'B'] },
    }
    const presence = { v: 1, t: 'presence', topic: person(1), people: [uuid(3)] }
    expect(readServerFrame(JSON.stringify(gone))).toEqual({ ...gone, reason: 'access' })
    expect(readServerFrame(JSON.stringify(notice))).toEqual(notice)
    expect(readServerFrame(JSON.stringify(ev))).toEqual(ev)
    expect(readServerFrame(JSON.stringify(presence))).toBeUndefined()
    for (const frame of [gone, notice, ev, presence]) expect(accepts(ServerFrame, frame), frame.t).toBe(false)
  })

  it('P6 Rule 6: a dropped frame is forgotten even with a malformed or missing reason, or extra fields', () => {
    const topics = [`team:${uuid(5)}`]
    for (const reason of [undefined, 'Gone!', 7, { code: 'gone' }]) {
      expect(readServerFrame(JSON.stringify({ v: 1, t: 'dropped', topics, reason })), String(reason)).toEqual({
        v: 1,
        t: 'dropped',
        topics,
        reason: 'access',
      })
    }
    expect(readServerFrame(JSON.stringify({ v: 1, t: 'dropped', topics, reason: 'access', era: uuid(1) }))).toEqual({
      v: 1,
      t: 'dropped',
      topics,
      reason: 'access',
    })
  })

  it('P6: anything that isn’t a frame is skipped', () => {
    for (const text of ['', 'not json', '[]', 'null', '{"t":"ack"}', '{"v":2,"t":"nudge","what":"flags"}']) {
      expect(readServerFrame(text), text).toBeUndefined()
    }
    expect(ServerFrameForClient.safeParse({ v: 1, t: 'pong', reconnectSpreadMs: 5_000 }).success).toBe(false)
  })
})

describe('S7 T19 item 11: frames fit the limits', () => {
  it('S7: a 50-topic sub with since is under 4096 bytes', () => {
    const frame = { v: 1, t: 'sub', id: 1_000_000, topics: people(50), since: { epoch: EPOCH, pos: MAX_POS } }
    expect(accepts(ClientFrame, frame)).toBe(true)
    expect(bytes(JSON.stringify(frame))).toBeLessThan(GATEWAY_LIMITS.maxFrameBytes)
  })

  it('S7: a 100-topic resume is two sub frames plus hello, within the token bucket', () => {
    const held = people(GATEWAY_LIMITS.maxTopicsPerSocket)
    const subs = Array.from({ length: Math.ceil(held.length / GATEWAY_LIMITS.maxTopicsPerFrame) }, (_, i) => ({
      v: 1,
      t: 'sub',
      id: i + 1,
      topics: held.slice(i * GATEWAY_LIMITS.maxTopicsPerFrame, (i + 1) * GATEWAY_LIMITS.maxTopicsPerFrame),
      since,
    }))
    const frames = [{ v: 1, t: 'hello', versions: [...GATEWAY_VERSIONS] }, ...subs]
    expect(subs.length).toBe(2)
    expect(subs.flatMap(s => s.topics)).toEqual(held)
    expect(frames.length).toBeLessThanOrEqual(GATEWAY_LIMITS.frameBurst)
    expect(accepts(Hello, frames[0])).toBe(true)
    for (const sub of subs) {
      expect(accepts(ClientFrame, sub)).toBe(true)
      expect(bytes(JSON.stringify(sub))).toBeLessThan(GATEWAY_LIMITS.maxFrameBytes)
    }
  })
})

describe('GW-12 T19 item 10: close codes', () => {
  it('GW-12: every close reason fits a close frame (123 bytes), and every code is one ws sends', () => {
    // ws's isValidStatusCode (ws/lib/validation.js), RFC 6455 §7.4: 1000-1014 but for the three a
    // close frame may never carry, and the 3000-4999 range for applications.
    const sendable = (code: number) =>
      (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999)
    for (const [name, { code, reason }] of Object.entries(GATEWAY_CLOSE)) {
      expect(sendable(code), name).toBe(true)
      expect(bytes(reason), name).toBeLessThanOrEqual(123)
    }
    // A sign-out, a notice and an outdated client each have a code of their own, so the client can
    // act on them; the 1008 closes differ by reason only.
    expect(GATEWAY_CLOSE.signedOut).toEqual({ code: 4401, reason: 'signed_out' })
    const own = Object.values(GATEWAY_CLOSE)
      .map(close => close.code)
      .filter(code => code >= 4000)
    expect(new Set(own)).toEqual(new Set([4401, 4403, 4408, 4426]))
  })
})
