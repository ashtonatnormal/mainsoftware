// The gate work passes before it touches anyone's personal data (BUILD-PLAN 842; TECH-SPEC T15 item
// 10): a job before it runs, at every step and before every commit, and an outbox consumer before
// each round and for each event's subjects. Each check takes the work's registry entry (its
// purpose, the providers it names), never what a producer wrote into a row. The flags route asks
// it too before turning a feature on (T17 item 9).
//
// C0.6 has no processing register, transfer register or spend caps yet, so its stand-ins fail
// closed: C0.9 replaces the first three with the registers and isProcessingAllowed, and A0 the
// fourth with spend caps.
import { isAiPurpose, type ProviderKey, PURPOSES, type PurposeKey } from '@hearth/shared'
import type { FlagCache } from '#src/flags/cache.ts'
import type { FlagSubject } from '#src/flags/evaluate.ts'
import { JobAborted, JobRefused } from '#src/jobs/errors.ts'
import type { JobKind } from '#src/jobs/kinds.ts'

export interface Gate {
  // Whether the org may process personal data for this purpose at all. C0.6: never for an AI
  // purpose (D41: nothing calls a model before A0); C0.9's purpose gate is the second lock.
  purposeAllowed(orgId: string, purpose: PurposeKey): boolean
  // Whether an outside provider is cleared to receive personal data (PDPA-10). C0.6: none is, and
  // no C0.6 job or consumer names one.
  providerCleared(orgId: string, provider: ProviderKey): boolean
  // Whether this person's processing switch allows the purpose (PDPA-04, PDPA-04a). C0.6: only a
  // purpose that rests on something other than consent, until C0.9's isProcessingAllowed.
  processingAllowed(orgId: string, subjectId: string, purpose: PurposeKey): boolean
  // Whether an optional feature is over its spend cap (ADM-05). C0.6: nothing is. A cap can only
  // ever pause an optional feature, never an essential one (D10); the caller applies that rule.
  overCap(orgId: string, feature: string): boolean
}

export const C06_GATE: Gate = {
  purposeAllowed: (_orgId, purpose) => !isAiPurpose(purpose),
  providerCleared: () => false,
  processingAllowed: (_orgId, _subjectId, purpose) => PURPOSES[purpose]?.consent === false,
  overCap: () => false,
}

// Admits a job, or throws why not, in T15 item 10's order, judging the kind's registry entry (never
// the job row) for the job's person: the job isn't aborted (its signal says why); its feature is on
// for its person (JobAborted: flag_off, not_in_cohort, or unconfirmed when the org's flags are
// unconfirmed); the purpose gate allows its purpose and every provider it names is cleared, its
// person's processing switch allows its purpose, and an optional feature isn't over its spend cap
// (JobRefused). The runner calls it before run(), and JobContext again at every step(), read() and
// commit(). Synchronous: every check reads memory.
export function admit(
  gate: Gate,
  flags: Pick<FlagCache, 'verdict' | 'registry'>,
  kind: Pick<JobKind, 'feature' | 'purpose' | 'providers'>,
  job: { orgId: string; subjectId: string | null },
  subject: FlagSubject | null,
  signal?: AbortSignal,
): void {
  if (signal?.aborted) throw signal.reason instanceof JobAborted ? signal.reason : new JobAborted('shutdown')
  const verdict = flags.verdict(job.orgId, kind.feature, subject)
  if (verdict !== 'on') throw new JobAborted(verdict === 'off' ? 'flag_off' : verdict)
  if (!gate.purposeAllowed(job.orgId, kind.purpose)) throw new JobRefused('purpose_refused')
  if ((kind.providers ?? []).some(provider => !gate.providerCleared(job.orgId, provider))) {
    throw new JobRefused('provider_not_cleared')
  }
  if (job.subjectId !== null && !gate.processingAllowed(job.orgId, job.subjectId, kind.purpose)) {
    throw new JobRefused('processing_not_allowed')
  }
  // A cap can only ever pause an optional feature (D10).
  const spec = Object.hasOwn(flags.registry, kind.feature) ? flags.registry[kind.feature] : undefined
  if (spec?.class === 'optional' && gate.overCap(job.orgId, kind.feature)) throw new JobRefused('over_cap')
}
