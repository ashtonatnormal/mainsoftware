import type { Facts } from '@hearth/access'
import { fixtureFacts, fixtureWorld, P } from '@hearth/access/testing'
import { COHORT_ROLES, FLAGS, type FlagSpec } from '@hearth/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FlagVerdict } from '#src/flags/cache.ts'
import type { FlagSubject } from '#src/flags/evaluate.ts'
import { clientFlagKeys, clientFlagValues, flagSubjectOf, waitAtMost } from '#src/web/flags.ts'

const spec = (client: boolean): FlagSpec => ({
  description: 'A test flag',
  class: 'optional',
  default: true,
  locked: false,
  purposes: ['service_operation'],
  client,
  stage: 'C0.8',
})

// The job runner's subject for a job's person (jobs/runner.ts), restated over the same facts: the
// person's row, whether they're still at the org, and their unrevoked role rows that a cohort can
// name, none once they've left, in role order.
function runnerSubject(facts: Facts, personId: string): FlagSubject | undefined {
  const person = facts.people.find(p => p.id === personId)
  if (person === undefined) return undefined
  const active = person.deactivatedAt === null
  const roles = facts.roles
    .filter(r => r.personId === personId && r.revokedAt === null)
    .map(r => r.role as string)
    .sort()
  return {
    personId,
    active,
    roles: active ? roles.filter(role => (COHORT_ROLES as readonly string[]).includes(role)) : [],
  }
}

describe('C0.8 T17 item 11 the client flags, decided per person (web/flags.ts)', () => {
  it('FU-01 T17 item 11 OD-13: clientFlagKeys picks only client: true keys, sorted, and FLAGS has none', () => {
    expect(clientFlagKeys(FLAGS)).toEqual([])
    const registry = { ...FLAGS, 'it.zeta': spec(true), 'it.server': spec(false), 'it.alpha': spec(true) }
    expect(clientFlagKeys(registry)).toEqual(['it.alpha', 'it.zeta'])
  })

  it('FU-02 T17 item 3: flagSubjectOf keeps cohort roles only and matches the runner’s subject for the same facts', () => {
    const world = fixtureWorld()
    // An Owner and DPO; an Admin and AI Admin; a Team Admin only (not a cohort role); someone who
    // left with a role never revoked; someone whose Admin role was revoked.
    expect(flagSubjectOf(world, P.ashton)).toEqual({ personId: P.ashton, active: true, roles: ['dpo', 'owner'] })
    expect(flagSubjectOf(world, P.arjun)).toEqual({ personId: P.arjun, active: true, roles: ['admin', 'ai_admin'] })
    expect(flagSubjectOf(world, P.marcus)).toEqual({ personId: P.marcus, active: true, roles: [] })
    expect(flagSubjectOf(world, P.formerDpo)).toEqual({ personId: P.formerDpo, active: false, roles: [] })
    expect(flagSubjectOf(world, P.formerAdmin)).toEqual({ personId: P.formerAdmin, active: true, roles: [] })
    const facts = fixtureFacts()
    for (const person of facts.people) {
      expect(flagSubjectOf(world, person.id), person.id).toEqual(runnerSubject(facts, person.id))
    }
  })

  it('FU-03 T17 item 11: clientFlagValues maps each verdict, and any unconfirmed key makes the whole answer unconfirmed', () => {
    const verdicts: Record<string, FlagVerdict> = { 'it.on': 'on', 'it.off': 'off', 'it.cohort': 'not_in_cohort' }
    const asked: string[] = []
    const verdictOf = (key: string): FlagVerdict => {
      asked.push(key)
      return verdicts[key] ?? 'unconfirmed'
    }
    expect(clientFlagValues(['it.cohort', 'it.off', 'it.on'], verdictOf)).toEqual({
      flags: { 'it.cohort': false, 'it.off': false, 'it.on': true },
    })
    expect(asked).toEqual(['it.cohort', 'it.off', 'it.on'])
    expect(clientFlagValues(['it.on', 'it.unread', 'it.off'], verdictOf)).toBe('unconfirmed')
    expect(clientFlagValues([], verdictOf)).toEqual({ flags: {} })
  })
})

describe('C0.8 R-52 waiting for the org’s first flag read', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('R-52: waitAtMost resolves at the bound when the promise never settles, and at once when it does, clearing its timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let ended = false
    void waitAtMost(new Promise<void>(() => {}), 2500).then(() => {
      ended = true
    })
    await vi.advanceTimersByTimeAsync(2499)
    expect(ended).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(ended).toBe(true)

    let release: () => void = () => {}
    const loaded = new Promise<void>(resolve => {
      release = resolve
    })
    const waiting = waitAtMost(loaded, 2500)
    expect(vi.getTimerCount()).toBe(1)
    release()
    await waiting
    expect(vi.getTimerCount()).toBe(0)
  })
})
