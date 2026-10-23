import { FLAGS } from '@hearth/shared'
import { describe, expect, it, vi } from 'vitest'
import type { FlagVerdict } from '#src/flags/cache.ts'
import type { FlagSubject } from '#src/flags/evaluate.ts'
import { JobAborted, type JobRefused } from '#src/jobs/errors.ts'
import { admit, type Gate } from '#src/jobs/gate.ts'
import { coreOnlyGate } from '#src/testing/gates.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const PERSON = 'b0000000-0000-4000-8000-000000000001'

// The gate itself, over each state of the registers, is compliance/gate.test.ts's (C0.9). Here it
// is coreOnlyGate (a register never read: only the pinned purposes pass, no provider is cleared),
// and failing() replaces one check at a time.
// A flag cache that answers what the test says, and the registry the cap check reads.
function flagsSaying(verdict: FlagVerdict, flagClass: 'essential' | 'optional' = 'optional') {
  return {
    verdict: vi.fn((_orgId: string, _key: string, _subject: FlagSubject | null) => verdict),
    registry: { 'it.feature': { ...FLAGS['core.system'], class: flagClass, locked: false } },
  }
}
const kind = { feature: 'it.feature', purpose: 'service_operation', providers: [] } as const
const job = { orgId: ORG, subjectId: PERSON }
const subject = { personId: PERSON, active: true, roles: [] }
const failing = (overrides: Partial<Gate>): Gate => ({ ...coreOnlyGate, ...overrides })

function refusalOf(run: () => void): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

describe('C0.6 T15 item 10 admit(): the checks in order, from the kind’s registry entry', () => {
  it('admits a job whose feature is on for its person and whose purpose the gate allows', () => {
    const flags = flagsSaying('on')
    expect(() => admit(coreOnlyGate, flags, kind, job, subject)).not.toThrow()
    expect(flags.verdict).toHaveBeenCalledWith(ORG, 'it.feature', subject)
  })

  it('answers why the feature isn’t on: off, out of the cohort, or unconfirmed', () => {
    for (const [verdict, reason] of [
      ['off', 'flag_off'],
      ['not_in_cohort', 'not_in_cohort'],
      ['unconfirmed', 'unconfirmed'],
    ] as const) {
      const error = refusalOf(() => admit(coreOnlyGate, flagsSaying(verdict), kind, job, subject))
      expect(error, verdict).toBeInstanceOf(JobAborted)
      expect((error as JobAborted).reason).toBe(reason)
    }
  })

  it('throws the abort that stopped the job before anything else', () => {
    const controller = new AbortController()
    const stopped = new JobAborted('lease_lost')
    controller.abort(stopped)
    expect(refusalOf(() => admit(coreOnlyGate, flagsSaying('on'), kind, job, subject, controller.signal))).toBe(stopped)
    // An abort without a JobAborted (it can't be the runner's) still stops it.
    const other = new AbortController()
    other.abort()
    expect(refusalOf(() => admit(coreOnlyGate, flagsSaying('on'), kind, job, subject, other.signal))).toBeInstanceOf(
      JobAborted,
    )
  })

  it('refuses an AI purpose, a provider not cleared, a refused processing switch and a cap, in that order', () => {
    const reasonOf = (gate: Gate, k = kind as Parameters<typeof admit>[2], flagClass?: 'essential' | 'optional') =>
      (refusalOf(() => admit(gate, flagsSaying('on', flagClass), k, job, subject)) as JobRefused | undefined)?.reason
    // An AI purpose, even with its flag on in a test cache: the C0 exit's "any ai.* flag is refused
    // by the purpose gate". And a purpose not pinned, while the register is unread (C0.9 PD-07).
    expect(reasonOf(coreOnlyGate, { ...kind, purpose: 'org_brain' })).toBe('purpose_refused')
    expect(reasonOf(coreOnlyGate, { ...kind, purpose: 'presence_receipts' })).toBe('purpose_refused')
    expect(reasonOf(coreOnlyGate, { ...kind, providers: ['openai'] })).toBe('provider_not_cleared')
    expect(reasonOf(coreOnlyGate, { ...kind, providers: ['aws'] })).toBe('provider_not_cleared')
    expect(reasonOf(failing({ processingAllowed: () => false }))).toBe('processing_not_allowed')
    expect(reasonOf(failing({ overCap: () => true }))).toBe('over_cap')
    // The order: everything refuses, and the purpose comes first.
    const everything = failing({
      purposeAllowed: () => false,
      providerCleared: () => false,
      processingAllowed: () => false,
      overCap: () => true,
    })
    expect(reasonOf(everything, { ...kind, providers: ['aws'] })).toBe('purpose_refused')
    expect(
      reasonOf(failing({ providerCleared: () => false, processingAllowed: () => false }), {
        ...kind,
        providers: ['aws'],
      }),
    ).toBe('provider_not_cleared')
    expect(reasonOf(failing({ processingAllowed: () => false, overCap: () => true }))).toBe('processing_not_allowed')
  })

  it('never lets a cap pause an essential feature (D10), and checks no switch for a job for nobody', () => {
    expect(() =>
      admit(failing({ overCap: () => true }), flagsSaying('on', 'essential'), kind, job, subject),
    ).not.toThrow()
    const processingAllowed = vi.fn(() => false)
    expect(() =>
      admit(failing({ processingAllowed }), flagsSaying('on'), kind, { orgId: ORG, subjectId: null }, null),
    ).not.toThrow()
    expect(processingAllowed).not.toHaveBeenCalled()
  })
})
