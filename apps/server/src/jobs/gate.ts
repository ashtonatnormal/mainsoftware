// The gate work passes before it touches anyone's personal data (BUILD-PLAN 1D, open items: the
// C0.6 queue-jobs row; TECH-SPEC T15 item 10): a job before it runs, at every step and before every
// commit, and an outbox consumer before each round and for each event's subjects. Each check takes
// the work's registry entry (its purpose, the providers it names), never what a producer wrote into
// a row.
//
// C0.9 fills the first three checks from the registers: the worker's gate is registerGate()
// (compliance/gate.ts) over the register copy its flag cache keeps (TECH-SPEC T22 items 6, 7 and 9).
// A0 fills the fourth with spend caps. The flags route asks the same predicates of the register it
// reads in its own transaction before a change lets a feature reach anyone new (T22 item 11), and
// the api's code sends ask transfer_send_state() instead, and any other sender transfer_cleared()
// (compliance/transfers.ts, T22 item 8, C0.9 PD-59).
import type { ProviderKey, PurposeKey } from '@hearth/shared'
import type { FlagCache } from '#src/flags/cache.ts'
import type { FlagSubject } from '#src/flags/evaluate.ts'
import { JobAborted, JobRefused } from '#src/jobs/errors.ts'
import type { JobKind } from '#src/jobs/kinds.ts'

export interface Gate {
  // Whether the org may process personal data for this purpose at all: never for an AI purpose
  // (D41: nothing calls a model before A0), always for a pinned one (C0.9 PD-07), and otherwise as
  // the processing register and the published notice say (PD-09).
  purposeAllowed(orgId: string, purpose: PurposeKey): boolean
  // Whether an outside provider is cleared to receive personal data (PDPA-10): its transfer-register
  // entry has an open clearance, and it isn't an AI provider (D41).
  providerCleared(orgId: string, provider: ProviderKey): boolean
  // Whether this person's processing switch allows the purpose (PDPA-04, PDPA-04a; C0.9 PD-10).
  processingAllowed(orgId: string, subjectId: string, purpose: PurposeKey): boolean
  // Whether an optional feature is over its spend cap (ADM-05). Until A0 nothing is. A cap can only
  // ever pause an optional feature, never an essential one (D10); the caller applies that rule.
  overCap(orgId: string, feature: string): boolean
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
