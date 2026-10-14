import { describe, expect, it } from 'vitest'
import { evaluate, type FlagState } from '#src/flags/evaluate.ts'

const A = 'b0000000-0000-4000-8000-00000000000a'
const B = 'b0000000-0000-4000-8000-00000000000b'

function flag(key: string, change: Partial<FlagState> = {}): FlagState {
  return {
    key,
    enabled: true,
    locked: false,
    revision: 1,
    audience: 'org',
    cohort: { people: [], roles: [] },
    ...change,
  }
}

const rows = (...states: FlagState[]) => new Map(states.map(state => [state.key, state]))
const person = (personId: string, roles: string[] = []) => ({ personId, roles })

describe('C0.6 T17 item 2 a flag is on only when every flag above it is on', () => {
  it('reads the dotted lineage from the top', () => {
    const states = rows(flag('ai'), flag('ai.agents'), flag('ai.agents.x1'))
    expect(evaluate(states, 'ai.agents.x1', null)).toBe('on')
    for (const off of ['ai', 'ai.agents', 'ai.agents.x1']) {
      const changed = new Map(states)
      changed.set(off, flag(off, { enabled: false }))
      expect(evaluate(changed, 'ai.agents.x1', null), off).toBe('off')
      // Turning the bottom one off leaves those above it on.
      if (off === 'ai.agents.x1') expect(evaluate(changed, 'ai.agents', null)).toBe('on')
    }
  })

  it('is unknown when the flag, or a registered flag above it, has no row; a key above that is no flag is skipped', () => {
    expect(evaluate(rows(flag('ai')), 'ai.agents', null)).toBe('unknown')
    // 'core' above 'core.system' is no flag: not registered, no row.
    expect(evaluate(rows(flag('core.system')), 'core.system', null)).toBe('on')
    // A registered key with no row above the flag makes it unknown.
    expect(evaluate(rows(flag('ai.agents')), 'ai.agents', null, key => key === 'ai')).toBe('unknown')
    expect(evaluate(new Map(), 'core.system', null)).toBe('unknown')
  })

  it('reads a row above the flag that the registry does not know, as the fences do', () => {
    expect(evaluate(rows(flag('it', { enabled: false }), flag('it.child')), 'it.child', null)).toBe('off')
    expect(evaluate(rows(flag('it'), flag('it.child')), 'it.child', null)).toBe('on')
  })

  it('does not treat a longer key with the same start as a parent (ai is not above aisle)', () => {
    expect(evaluate(rows(flag('ai', { enabled: false }), flag('aisle')), 'aisle', null)).toBe('on')
  })
})

describe('C0.6 T17 item 3 cohorts: people and org-wide roles, any of which matches (A1)', () => {
  const cohort = (people: string[], roles: string[]) =>
    flag('it.wave', { audience: 'cohort', cohort: { people, roles } })

  it('is on for a person named in the cohort, or holding a role it names, and off for anyone else', () => {
    const states = rows(cohort([A], ['dpo']))
    expect(evaluate(states, 'it.wave', person(A))).toBe('on')
    expect(evaluate(states, 'it.wave', person(B, ['dpo']))).toBe('on')
    expect(evaluate(states, 'it.wave', person(B, ['admin']))).toBe('off')
    expect(evaluate(states, 'it.wave', person(B))).toBe('off')
  })

  it('is off with a cohort for no one (a job for nobody, a consumer for the whole org)', () => {
    expect(evaluate(rows(cohort([A], [])), 'it.wave', null)).toBe('off')
    expect(evaluate(rows(flag('it.wave')), 'it.wave', null)).toBe('on')
  })

  it('applies a cohort above the flag too, and an enabled cohort flag still needs enabled', () => {
    const above = rows(flag('it', { audience: 'cohort', cohort: { people: [A], roles: [] } }), flag('it.child'))
    expect(evaluate(above, 'it.child', person(A))).toBe('on')
    expect(evaluate(above, 'it.child', person(B))).toBe('off')
    expect(evaluate(rows({ ...cohort([A], []), enabled: false }), 'it.wave', person(A))).toBe('off')
  })
})
