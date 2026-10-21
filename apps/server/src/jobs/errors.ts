// Why a job stopped short (TECH-SPEC T15 items 4, 6, 9 and 10). The runner turns each into an
// outcome (jobs/runner.ts): JobAborted for something outside the job (its flag, its lease, the
// worker stopping), JobRefused for the gate, PermanentJobError for a failure that trying again
// can't fix. Their messages are fixed text and codes, never a value, so they can be logged.

// A job's signal was aborted, or it was refused before it could start because of its flags:
//   flag_off       its feature (or a flag above it) is off
//   flag_changed   its flags changed since it was admitted, and it is still on for its person
//   not_in_cohort  its feature is on, but a cohort now leaves its person out
//   unconfirmed    the worker hasn't confirmed its org's flags for 8 s (fail closed)
//   lease_lost     its lease went to another worker or the lease sweep
//   shutdown       the worker is stopping
//   timeout        the attempt ran past its kind's timeoutMs
export type AbortReason =
  | 'flag_off'
  | 'flag_changed'
  | 'not_in_cohort'
  | 'unconfirmed'
  | 'lease_lost'
  | 'shutdown'
  | 'timeout'

export class JobAborted extends Error {
  override name = 'JobAborted'
  readonly reason: AbortReason
  constructor(reason: AbortReason) {
    super(`the job was aborted: ${reason}`)
    this.reason = reason
  }
}

// The gate refused the job (BUILD-PLAN 1D, open items: the C0.6 queue-jobs row): its purpose, a
// provider it names (PDPA-10), its person's processing switch (PDPA-04), or its optional feature's
// spend cap (ADM-05).
export type RefusalReason = 'purpose_refused' | 'provider_not_cleared' | 'processing_not_allowed' | 'over_cap'

export class JobRefused extends Error {
  override name = 'JobRefused'
  readonly reason: RefusalReason
  constructor(reason: RefusalReason) {
    super(`the gate refused the job: ${reason}`)
    this.reason = reason
  }
}

// A failure no retry can fix: the job goes dead at once with this code. The code is what the job
// row and the logs keep, so it is a code (lower case, digits and underscores), never text that
// could carry someone's details.
export class PermanentJobError extends Error {
  override name = 'PermanentJobError'
  readonly code: string
  constructor(code: string) {
    super('the job failed for good')
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(code)) throw new Error('PermanentJobError: the code must be a lower-case code')
    this.message = `the job failed for good: ${code}`
    this.code = code
  }
}
