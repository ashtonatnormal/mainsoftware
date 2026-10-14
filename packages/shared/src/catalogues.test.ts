// C0.6's registries (TECH-SPEC T15-T17): the outbox catalogue, the flag registry and the purpose
// keys, and the ids-only rule their schemas follow. That the catalogue's names and the registry's
// defaults equal migration 0007's lists is checked against the database by
// apps/server/scripts/check-catalogues.ts.
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
} from './flags.ts'
import { idsLeaves, idsProblems } from './ids.ts'
import { isAiPurpose, isPurposeKey, PURPOSES } from './purposes.ts'

// BUILD-PLAN's order: every C stage, then every A stage.
function stageRank(stage: string): number {
  const match = /^([CA])(\d+)(?:\.(\d+))?$/.exec(stage)
  if (!match) throw new Error(`${stage} is not a BUILD-PLAN stage`)
  return (match[1] === 'A' ? 10_000 : 0) + Number(match[2]) * 100 + Number(match[3] ?? 0)
}

// Past tense, so each name says what happened. task.overdue is the one adjective: a time-based
// event a delayed job appends (BUILD-PLAN 230).
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

  it('T16: every emitted type is C0.6’s, has ids only and allowed purposes, and carries no snapshot yet', () => {
    for (const [name, spec] of entries.filter(([, s]) => s.status === 'emitted')) {
      expect(spec.stage, name).toBe('C0.6')
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
  it('marks the AI layer’s purposes, which rest on consent until C0.9 says otherwise', () => {
    for (const [key, spec] of Object.entries(PURPOSES)) {
      expect(/^[a-z][a-z0-9_]{0,62}$/.test(key), key).toBe(true)
      if (spec.ai) expect(spec.consent, key).toBe(true)
    }
    expect(isAiPurpose('accounts')).toBe(false)
    expect(isAiPurpose('org_brain')).toBe(true)
    // An unknown key is treated as AI, so a mistyped purpose is refused rather than let through.
    expect(isAiPurpose('acounts')).toBe(true)
    expect(PURPOSES.service_operation.consent).toBe(false)
  })
})
