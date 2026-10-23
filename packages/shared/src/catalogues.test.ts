// C0.6's registries (TECH-SPEC T15-T17): the outbox catalogue, the flag registry and the purpose
// keys, and the ids-only rule their schemas follow; from C0.9, the provider keys, the pinned
// purposes and the tripwires G1 and G2 (T22). That the catalogue's names, the registry's defaults
// and the registers' defaults equal the database's lists (migrations 0007 and 0009) is checked
// against the database by apps/server/scripts/check-catalogues.ts.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { EVENTS, type EventSpec, isEmitted, RESERVED_NAMESPACES } from './events.ts'
import {
  COHORT_LIMIT,
  COHORT_ROLES,
  cohortProblem,
  FLAGS,
  type FlagSpec,
  flagLineage,
  isAiFlag,
  isFlagKey,
  isLockedOn,
  isPinnedPurpose,
  PINNED_PURPOSES,
} from './flags.ts'
import { idsLeaves, idsProblems, LowerUuid, UUID_PATTERN } from './ids.ts'
import {
  AI_PROVIDERS,
  isAiProvider,
  isAiPurpose,
  isProviderKey,
  isPurposeKey,
  PROVIDERS,
  PURPOSE_KEYS,
  PURPOSES,
  type PurposeKey,
} from './purposes.ts'
import { ACTIVE_FROM_START } from './registers.ts'

// BUILD-PLAN's order: every C stage, then every A stage.
function stageRank(stage: string): number {
  const match = /^([CA])(\d+)(?:\.(\d+))?$/.exec(stage)
  if (!match) throw new Error(`${stage} is not a BUILD-PLAN stage`)
  return (match[1] === 'A' ? 10_000 : 0) + Number(match[2]) * 100 + Number(match[3] ?? 0)
}

// Past tense, so each name says what happened. task.overdue is the one adjective: a time-based
// event a delayed job appends (BUILD-PLAN C2.1).
const IRREGULAR = new Set(['set', 'reset', 'written', 'overdue'])
function nameProblem(name: string): string | undefined {
  const match = /^([a-z][a-z_]*)\.([a-z][a-z_]*)$/.exec(name)
  if (!match) return 'not <noun>.<verb> in lower case'
  const verb = (match[2] ?? '').split('_').at(-1) ?? ''
  return verb.endsWith('ed') || IRREGULAR.has(verb) ? undefined : `${verb} is not a past tense`
}

// A name in a later stage's namespace that doesn't carry that stage.
function namespaceProblems(events: Readonly<Record<string, Pick<EventSpec, 'stage'>>>): string[] {
  return Object.entries(events).flatMap(([name, spec]) =>
    Object.entries(RESERVED_NAMESPACES)
      .filter(([prefix, stage]) => name.startsWith(prefix) && spec.stage !== stage)
      .map(([prefix, stage]) => `${name} is in ${prefix}*, which ${stage} owns, but says ${spec.stage}`),
  )
}

// A flag that names an AI purpose outside ai.*, where the table's lock doesn't reach it.
function aiPurposeProblems(flags: Readonly<Record<string, Pick<FlagSpec, 'purposes'>>>): string[] {
  return Object.entries(flags)
    .filter(([key, spec]) => !isAiFlag(key) && spec.purposes.some(p => isAiPurpose(p)))
    .map(([key]) => key)
}

// G1 (C0.9 PD-18, TECH-SPEC T22 item 11): a flag outside ai.* that names a purpose that isn't
// pinned. FlagCache.verdict() and GET /api/flags read a flag alone, never the purpose gate, which
// is safe only while every such flag's purposes are allowed in every register state.
const G1 =
  'before a flag outside ai.* names a purpose that isn’t pinned, make FlagCache.verdict() and GET /api/flags ask the purpose gate (TECH-SPEC T22 item 11)'
function unpinnedPurposeProblems(
  flags: Readonly<Record<string, Pick<FlagSpec, 'purposes'>>>,
  pinned: readonly string[],
): string[] {
  return Object.entries(flags)
    .filter(([key]) => !isAiFlag(key))
    .flatMap(([key, spec]) => spec.purposes.filter(p => !pinned.includes(p)).map(p => `${key}: ${p}`))
}

// G2 (C0.9 PD-18, TECH-SPEC T22 item 11): a flag outside ai.* with a flag under it. The flags route
// checks the purposes of the key it turns on, never those of the flags under it.
const G2 =
  'before a flag outside ai.* has a flag under it, make POST /api/admin/flags/set check the purposes of the flags under it too (TECH-SPEC T22 item 11)'
function nestedFlagProblems(flags: Readonly<Record<string, unknown>>): string[] {
  const keys = Object.keys(flags)
  return keys
    .filter(key => !isAiFlag(key))
    .flatMap(key => keys.filter(below => below.startsWith(`${key}.`)).map(below => `${key} has ${below} under it`))
}

describe('T16 the outbox catalogue', () => {
  const entries = Object.entries(EVENTS) as [string, EventSpec][]

  it('T16 item 11: names every type <noun>.<past tense>', () => {
    for (const [name] of entries) expect(nameProblem(name), name).toBeUndefined()
    expect(nameProblem('person.deactivate')).toMatch(/past tense/)
    expect(nameProblem('Person.added')).toMatch(/lower case/)
    expect(nameProblem('person')).toMatch(/lower case/)
  })

  it('T16 item 11: a later stage’s namespace holds only that stage’s names', () => {
    expect(namespaceProblems(EVENTS)).toEqual([])
    // The rule itself: C0.6 can't take C1.1's or C2.4's names, nor C4.1 file.*.
    expect(namespaceProblems({ 'message.created': { stage: 'C0.6' } })).toHaveLength(1)
    expect(namespaceProblems({ 'session.started': { stage: 'C0.6' } })).toHaveLength(1)
    expect(namespaceProblems({ 'file.created': { stage: 'C4.1' }, 'signin.started': { stage: 'C0.6' } })).toEqual([])
  })

  it('T14 item 17: nothing emitted is session.*, which C2.4 keeps for recorded room sessions', () => {
    const emitted = entries.filter(([, spec]) => spec.status === 'emitted').map(([name]) => name)
    expect(emitted.length).toBeGreaterThan(0)
    expect(emitted.filter(name => name.startsWith('session.'))).toEqual([])
    expect(emitted.some(name => name.startsWith('signin.'))).toBe(true)
  })

  it('T16 T22: every emitted type names the C step that emits it, has ids only and allowed purposes, and carries no snapshot yet', () => {
    for (const [name, spec] of entries.filter(([, s]) => s.status === 'emitted')) {
      // From C0.6, and never the AI layer's before A0 (D41).
      expect(stageRank(spec.stage), name).toBeGreaterThanOrEqual(stageRank('C0.6'))
      expect(spec.stage, name).toMatch(/^C/)
      expect(spec.ids, name).toBeDefined()
      if (spec.ids) expect(idsProblems(spec.ids), name).toEqual([])
      expect(spec.purposes.length, name).toBeGreaterThan(0)
      for (const purpose of spec.purposes) {
        expect(isPurposeKey(purpose), `${name}: ${purpose}`).toBe(true)
        // Nothing in C0.6 processes for the AI layer (D41).
        expect(isAiPurpose(purpose), `${name}: ${purpose}`).toBe(false)
      }
      // Content events come with C1.1; until then none carries a snapshot.
      expect(spec.acl, name).toBe('none')
      expect(isEmitted(name), name).toBe(true)
    }
  })

  it('T16: a reserved type is a later stage’s and carries no ids schema or purposes, so nothing can append it', () => {
    const reserved = entries.filter(([, s]) => s.status === 'reserved')
    expect(reserved.length).toBeGreaterThan(0)
    for (const [name, spec] of reserved) {
      expect(stageRank(spec.stage), name).toBeGreaterThan(stageRank('C0.6'))
      expect(spec.ids, name).toBeUndefined()
      expect(spec.purposes, name).toEqual([])
      expect(isEmitted(name), name).toBe(false)
    }
    expect(isEmitted('no.such_thing_happened')).toBe(false)
  })

  it('T16 item 15: a tombstone marks only a deletion', () => {
    const tombstones = entries.filter(([, s]) => s.tombstone).map(([name]) => name)
    expect(tombstones.sort()).toEqual(['message.deleted', 'task.deleted'])
  })

  it('T16 item 14: acl.changed says which kind of change, and C0.6 emits keys for a deactivation', () => {
    const schema = EVENTS['acl.changed'].ids
    expect(schema.safeParse({ change: 'keys', reason: 'deactivated' }).success).toBe(true)
    expect(schema.safeParse({ change: 'some', reason: 'deactivated' }).success).toBe(false)
    expect(schema.safeParse({ change: 'keys', reason: 'deactivated', extra: 1 }).success).toBe(false)
  })

  it('A9: flag.changed names the flag’s row as its entity and carries no key or revision', () => {
    expect(EVENTS['flag.changed'].entity).toBe('feature_flag')
    expect(Object.keys(EVENTS['flag.changed'].ids.shape)).toEqual(['enabled'])
  })

  it('C0.9 PD-22 T22 item 13: the register events are C0.9’s, carry service_operation, and hold a key and a state only', () => {
    const purpose = EVENTS['register.purpose_changed']
    const transfer = EVENTS['register.transfer_changed']
    expect(purpose).toMatchObject({ status: 'emitted', stage: 'C0.9', entity: 'processing_purpose' })
    expect(transfer).toMatchObject({ status: 'emitted', stage: 'C0.9', entity: 'transfer_entry' })
    for (const spec of [purpose, transfer]) expect(spec.purposes).toEqual(['service_operation'])
    expect(purpose.ids.safeParse({ purpose: 'security_audit', status: 'active' }).success).toBe(true)
    expect(purpose.ids.safeParse({ purpose: 'security_audit', status: 'on' }).success).toBe(false)
    expect(purpose.ids.safeParse({ purpose: 'no_such_purpose', status: 'active' }).success).toBe(false)
    expect(purpose.ids.safeParse({ purpose: 'backups', status: 'active', basis: 'consent' }).success).toBe(false)
    expect(transfer.ids.safeParse({ provider: 'twilio', cleared: true }).success).toBe(true)
    expect(transfer.ids.safeParse({ provider: 'sendgrid', cleared: true }).success).toBe(false)
    expect(transfer.ids.safeParse({ provider: 'twilio', cleared: true, countries: ['US'] }).success).toBe(false)
  })

  it('C0.9 PD-50 T22 item 33: the notice events are emitted from C0.9, carry accounts, and hold the version, never its words', () => {
    const published = EVENTS['notice.published']
    const acknowledged = EVENTS['notice.acknowledged']
    expect(published).toMatchObject({ status: 'emitted', stage: 'C0.9', entity: 'notice' })
    expect(acknowledged).toMatchObject({ status: 'emitted', stage: 'C0.9', entity: 'person' })
    for (const spec of [published, acknowledged]) expect(spec.purposes).toEqual(['accounts'])
    const notice = 'a0000000-0000-4000-8000-0000000000e1'
    expect(published.ids.safeParse({ version: 0 }).success).toBe(true)
    expect(published.ids.safeParse({ version: -1 }).success).toBe(false)
    expect(published.ids.safeParse({ version: 1, body: 'Local stand-in' }).success).toBe(false)
    expect(acknowledged.ids.safeParse({ notice, version: 3 }).success).toBe(true)
    expect(acknowledged.ids.safeParse({ notice: 'v3', version: 3 }).success).toBe(false)
    expect(acknowledged.ids.safeParse({ notice, version: 3, method: 'in_app' }).success).toBe(false)
  })
})

describe('T15 item 8 T16 item 15: ids only', () => {
  const uuid = z.uuid()
  it('accepts uuids, codes, booleans, bounded whole numbers and bounded lists of uuids, optional or not', () => {
    expect(
      idsProblems(
        z.strictObject({
          a: uuid,
          b: z.enum(['keys', 'ai.agents', 'sms_pin']),
          c: z.literal('one'),
          d: z.literal(true),
          e: z.boolean(),
          f: z.int().min(0).max(1_000_000),
          g: z.number().int().min(1).max(10),
          h: z.array(uuid).max(100),
          i: uuid.optional(),
          j: z.int().positive().max(5),
        }),
      ),
    ).toEqual([])
    expect(idsProblems(z.strictObject({}))).toEqual([])
  })

  it('C0.7 m4: accepts LowerUuid itself as an id, alone, optional or in a bounded list, and no other pattern', () => {
    expect(
      idsProblems(z.strictObject({ a: LowerUuid, b: LowerUuid.optional(), c: z.array(LowerUuid).max(100).optional() })),
    ).toEqual([])
    // The same pattern written again is another schema, refused as any pattern on a string is.
    expect(idsProblems(z.strictObject({ x: z.string().regex(UUID_PATTERN) }))).toHaveLength(1)
    expect(idsProblems(z.strictObject({ x: LowerUuid.max(10) }))).toHaveLength(1)
    expect(idsProblems(z.strictObject({ x: z.array(LowerUuid) }))).toHaveLength(1)
    expect(idsProblems(z.strictObject({ x: z.array(LowerUuid).max(101) }))).toHaveLength(1)
  })

  it('refuses anything that could carry someone’s details', () => {
    const refused: [string, z.ZodType][] = [
      ['a free string', z.string()],
      ['a string with a pattern', z.string().regex(/^[a-z]+$/)],
      ['an email', z.email()],
      ['an unbounded number', z.number()],
      ['a whole number with no maximum', z.int().min(0)],
      ['a whole number with no minimum', z.int().max(10)],
      ['a negative minimum', z.int().min(-5).max(10)],
      ['a maximum over a million', z.int().min(0).max(1_000_001)],
      ['a fraction', z.number().min(0).max(10)],
      ['a nested object', z.strictObject({ x: uuid })],
      ['a list of strings', z.array(z.string()).max(10)],
      ['a list of codes', z.array(z.enum(['a'])).max(10)],
      ['an unbounded list', z.array(uuid)],
      ['a list over 100', z.array(uuid).max(101)],
      ['an enum of free text', z.enum(['Ashton Tan'])],
      ['a literal number', z.literal(6580000001)],
      ['a record', z.record(z.string(), uuid)],
      ['a nullable uuid', uuid.nullable()],
      ['a uuid with a default', uuid.default('a0000000-0000-4000-8000-000000000001')],
    ]
    for (const [label, schema] of refused) {
      expect(idsProblems(z.strictObject({ x: schema })), label).toHaveLength(1)
    }
  })

  it('R2DB-2: refuses a field name is_ids_only() would refuse, such as camelCase or free text', () => {
    expect(idsProblems(z.strictObject({ teamId: uuid }))).toEqual([
      '"teamId": a field name that is not a lower-case code',
    ])
    expect(idsProblems(z.strictObject({ 'Mel Member +65 9123 4567': z.boolean() }))).toEqual([
      '"Mel Member +65 9123 4567": a field name that is not a lower-case code',
    ])
    expect(idsProblems(z.strictObject({ [`a${'b'.repeat(63)}`]: uuid }))).toHaveLength(1)
    expect(idsProblems(z.strictObject({ [`a${'b'.repeat(62)}`]: uuid, team_2: uuid }))).toEqual([])
  })

  it('refuses a schema that keeps unknown keys, and one that is not an object', () => {
    expect(idsProblems(z.object({ a: uuid }))).toEqual([expect.stringMatching(/strictObject/)])
    expect(idsProblems(z.looseObject({ a: uuid }))).toEqual([expect.stringMatching(/strictObject/)])
    expect(idsProblems(uuid)).toEqual(['not an object schema'])
  })

  it('idsLeaves throws naming every field that breaks the rule', () => {
    expect(() => idsLeaves(z.strictObject({ ok: uuid }), 'fine')).not.toThrow()
    expect(() => idsLeaves(z.strictObject({ name: z.string(), age: z.number() }), 'person.payload')).toThrow(
      /person\.payload must hold ids only.*name: .*age: /,
    )
  })
})

describe('T17 the flag registry', () => {
  const entries = Object.entries(FLAGS) as [string, FlagSpec][]

  it('BUILD-PLAN C0.6 PRD-65: every ai.* flag is registered off, locked and kept from browsers', () => {
    const ai = entries.filter(([key]) => isAiFlag(key))
    expect(ai.map(([key]) => key)).toContain('ai')
    expect(ai.length).toBe(17)
    for (const [key, spec] of ai)
      expect({ key, ...spec }).toMatchObject({ key, default: false, locked: true, client: false })
  })

  it('T17 item 12: every flag with an AI purpose sits under ai., inside the lock', () => {
    expect(aiPurposeProblems(FLAGS)).toEqual([])
    expect(aiPurposeProblems({ 'core.notes': { purposes: ['meeting_notes'] } })).toEqual(['core.notes'])
    expect(aiPurposeProblems({ 'core.mystery': { purposes: ['no_such_purpose' as never] } })).toEqual(['core.mystery'])
    expect(aiPurposeProblems({ 'ai.notes': { purposes: ['meeting_notes'] } })).toEqual([])
  })

  it('T17 items 4, 12: ADM-05 D10: transcription and meeting notes are essential, so a cap never stops them', () => {
    for (const key of [
      'ai.transcription',
      'ai.transcription.sessions',
      'ai.transcription.voice_messages',
      'ai.notes',
    ] as const) {
      expect(FLAGS[key].class, key).toBe('essential')
    }
    for (const key of [
      'ai.brain',
      'ai.ask',
      'ai.quick_replies',
      'ai.assistant',
      'ai.agents',
      'ai.onboarding_buddy',
    ] as const) {
      expect(FLAGS[key].class, key).toBe('optional')
    }
  })

  it('T17: core.system is on and locked; every key is valid, every purpose exists and every parent is registered', () => {
    expect(FLAGS['core.system']).toMatchObject({ default: true, locked: true, class: 'essential' })
    for (const [key, spec] of entries) {
      expect(isFlagKey(key), key).toBe(true)
      for (const purpose of spec.purposes) expect(isPurposeKey(purpose), `${key}: ${purpose}`).toBe(true)
      for (const above of flagLineage(key).slice(0, -1)) {
        // core.system's parent, core, is no flag: only registered flags above count (T17 item 2).
        if (above === 'core') continue
        expect(Object.hasOwn(FLAGS, above), `${key} needs ${above}`).toBe(true)
      }
      stageRank(spec.stage)
    }
  })

  it('T17 item 2: a lineage runs from the top, and ai covers itself and everything under it only', () => {
    expect(flagLineage('ai.agents.x1')).toEqual(['ai', 'ai.agents', 'ai.agents.x1'])
    expect(flagLineage('core.system')).toEqual(['core', 'core.system'])
    expect(flagLineage('ai')).toEqual(['ai'])
    expect(isAiFlag('ai')).toBe(true)
    expect(isAiFlag('ai.agents.x1')).toBe(true)
    expect(isAiFlag('aisle')).toBe(false)
    expect(isAiFlag('core.ai')).toBe(false)
    expect(isFlagKey('Core.system')).toBe(false)
    expect(isFlagKey(`a${'.b'.repeat(50)}`)).toBe(false)
  })

  it('A1 A8 T17 item 3: a cohort is people and the six org-wide roles, at most 1,000 entries, as the table allows', () => {
    expect([...COHORT_ROLES]).toEqual(['owner', 'admin', 'ai_admin', 'leadership', 'dpo', 'compliance_officer'])
    const person = 'a0000000-0000-4000-8000-000000000001'
    expect(cohortProblem('org', { people: [], roles: [] })).toBeUndefined()
    expect(cohortProblem('cohort', { people: [person], roles: ['dpo'] })).toBeUndefined()
    expect(cohortProblem('cohort', { people: [], roles: [] })).toMatch(/at least one/)
    expect(cohortProblem('org', { people: [person], roles: [] })).toMatch(/whole organisation/)
    const full = Array.from({ length: COHORT_LIMIT - 1 }, () => person)
    expect(cohortProblem('cohort', { people: full, roles: ['dpo'] })).toBeUndefined()
    expect(cohortProblem('cohort', { people: full, roles: ['dpo', 'owner'] })).toMatch(/at most 1000/)
  })
})

describe('PDPA-01 T16 item 16: the purpose keys', () => {
  it('C0.9 PD-28: each key marks only the AI layer and the switch it needs; the register’s basis says whether it rests on consent', () => {
    for (const [key, spec] of Object.entries(PURPOSES)) {
      expect(/^[a-z][a-z0-9_]{0,62}$/.test(key), key).toBe(true)
      expect(Object.keys(spec).sort(), key).toEqual(['ai', 'needsSwitch', 'register'])
    }
    expect(isAiPurpose('accounts')).toBe(false)
    expect(isAiPurpose('org_brain')).toBe(true)
    // An unknown key is treated as AI, so a mistyped purpose is refused rather than let through.
    expect(isAiPurpose('acounts')).toBe(true)
  })

  it('RGS-15 PDPA-04 C0.9 PD-11: a purpose needs a per-person switch exactly when PDPA-04 lists it (recording, transcription, notes, voice-message transcription, Org Brain or AI use), the test set apart', () => {
    const needing = PURPOSE_KEYS.filter(key => PURPOSES[key].needsSwitch)
    expect(needing).toEqual([
      'recording_meetings',
      'recording_drop_in',
      'transcription',
      'voice_message_transcription',
      'meeting_notes',
      'org_brain',
      'ai_writing',
      'people_inference',
      'assistant',
      'agents',
      'ai_cost_figures',
    ])
    // Every AI purpose but the transcription test set, whose withdrawal is carried out by deleting
    // the person's clips (§9.5).
    for (const key of PURPOSE_KEYS.filter(k => PURPOSES[k].ai)) {
      expect(PURPOSES[key].needsSwitch, key).toBe(key !== 'transcription_test_set')
    }
  })
})

describe('PDPA-10 C0.9 PD-14: the provider keys', () => {
  it('RGS-15 D41: the AI providers are OpenAI and Bedrock, both registered; an unknown key counts as AI', () => {
    expect([...AI_PROVIDERS]).toEqual(['openai', 'bedrock'])
    for (const key of AI_PROVIDERS) expect(isProviderKey(key), key).toBe(true)
    expect(PROVIDERS.filter(key => isAiProvider(key))).toEqual(['openai', 'bedrock'])
    for (const key of PROVIDERS) expect(/^[a-z][a-z0-9_]{0,62}$/.test(key), key).toBe(true)
    expect(new Set(PROVIDERS).size).toBe(PROVIDERS.length)
    expect(isProviderKey('twilio')).toBe(true)
    expect(isAiProvider('twilio')).toBe(false)
    // A mistyped or unknown provider is refused rather than cleared.
    expect(isProviderKey('sendgrid')).toBe(false)
    expect(isAiProvider('sendgrid')).toBe(true)
    expect(isProviderKey('constructor')).toBe(false)
  })
})

describe('C0.9 PD-07 PD-18: the pinned purposes, and the tripwires that keep PR 1’s runtime safe', () => {
  // The flags locked on, read from the registry here rather than through isLockedOn, so the test
  // doesn't take the rule it checks on trust.
  const lockedOnHere = (Object.entries(FLAGS) as [string, FlagSpec][]).filter(([key]) =>
    flagLineage(key).every(level => {
      const spec = (FLAGS as Readonly<Record<string, FlagSpec>>)[level]
      return spec === undefined ? level !== key : spec.locked && spec.default
    }),
  )

  it('RGS-15 T22 item 5: PINNED_PURPOSES are the purposes of every flag locked on, today core.system’s accounts and service_operation', () => {
    expect(lockedOnHere.map(([key]) => key)).toEqual(['core.system'])
    const purposes = new Set(lockedOnHere.flatMap(([, spec]) => spec.purposes))
    expect([...PINNED_PURPOSES].sort()).toEqual([...purposes].sort())
    expect([...PINNED_PURPOSES]).toEqual(['accounts', 'service_operation'])
    for (const key of PURPOSE_KEYS) expect(isPinnedPurpose(key), key).toBe(PINNED_PURPOSES.includes(key))
    expect(isPinnedPurpose('acounts')).toBe(false)
    // Hearth runs on them, so none is AI or could rest on consent through a switch it needs.
    for (const key of PINNED_PURPOSES) expect(PURPOSES[key]).toMatchObject({ ai: false, needsSwitch: false })
  })

  it('T17 item 2: a flag is locked on when it and every flag above it is locked and on; a level that isn’t a flag doesn’t count', () => {
    const on = { locked: true, default: true }
    const registry = {
      'core.a': { ...FLAGS['core.system'], ...on },
      'core.a.b': { ...FLAGS['core.system'], ...on },
      'core.c': { ...FLAGS['core.system'], locked: false },
      'core.c.d': { ...FLAGS['core.system'], ...on },
      'core.e': { ...FLAGS['core.system'], default: false },
    } satisfies Record<string, FlagSpec>
    expect(isLockedOn('core.system')).toBe(true)
    expect(isLockedOn('ai')).toBe(false)
    expect(isLockedOn('ai.notes')).toBe(false)
    expect(isLockedOn('core.a', registry)).toBe(true)
    expect(isLockedOn('core.a.b', registry)).toBe(true)
    expect(isLockedOn('core.c', registry)).toBe(false)
    expect(isLockedOn('core.c.d', registry)).toBe(false)
    expect(isLockedOn('core.e', registry)).toBe(false)
    // A key that isn't a flag is never locked on, though nothing above it is a flag either.
    expect(isLockedOn('core.missing', registry)).toBe(false)
  })

  it('RGS-15 C0.9 PD-06 T22 item 4: a new org starts with the pinned purposes, security_audit and backups active, and nothing AI', () => {
    expect([...ACTIVE_FROM_START]).toEqual(['accounts', 'service_operation', 'security_audit', 'backups'])
    for (const key of PINNED_PURPOSES) expect(ACTIVE_FROM_START, key).toContain(key)
    for (const key of ACTIVE_FROM_START) expect(isAiPurpose(key), key).toBe(false)
    // security_audit and backups start active without being pinned: the gate passes them only once
    // a published notice lists them (PR 2).
    expect(isPinnedPurpose('security_audit')).toBe(false)
    expect(isPinnedPurpose('backups')).toBe(false)
  })

  it(`PGT-01 G1 C0.9 PD-18: every flag outside ai.* names only pinned purposes, so a flag can't read on while its purpose is refused`, () => {
    expect(unpinnedPurposeProblems(FLAGS, PINNED_PURPOSES), G1).toEqual([])
    // The rule itself: a core flag naming presence_receipts trips it; an ai.* flag doesn't, since
    // its own lock keeps it off until A0.
    const planted: Record<string, { purposes: readonly PurposeKey[] }> = {
      'core.system': { purposes: ['service_operation', 'accounts'] },
      'core.receipts': { purposes: ['presence_receipts', 'accounts'] },
      'ai.notes': { purposes: ['meeting_notes'] },
    }
    expect(unpinnedPurposeProblems(planted, PINNED_PURPOSES)).toEqual(['core.receipts: presence_receipts'])
  })

  it(`PGT-02 G2 C0.9 PD-18: no flag outside ai.* has a flag under it, so a flag's own purposes are the whole check`, () => {
    expect(nestedFlagProblems(FLAGS), G2).toEqual([])
    expect(nestedFlagProblems({ 'core.chat': {}, 'core.chat.wave_2': {}, ai: {}, 'ai.agents': {} })).toEqual([
      'core.chat has core.chat.wave_2 under it',
    ])
    // core.system's parent, core, is no flag, so it has nothing under it.
    expect(nestedFlagProblems({ 'core.system': {}, 'core.chat': {} })).toEqual([])
  })
})
