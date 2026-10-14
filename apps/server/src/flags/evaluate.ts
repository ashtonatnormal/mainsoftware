// Whether a feature flag is on for someone (TECH-SPEC T17 items 2 and 3): pure, so every process
// decides the same way from the rows it holds. A flag is on when it and every flag above it in its
// dotted lineage (ai above ai.agents above ai.agents.<id>) is enabled and, where one names a
// cohort, the person is in it. The database's fences (feature_fence, job_fence, job_finish) read
// the same lineage, every row whose key is the feature or above it, and compare revisions rather
// than cohorts, so cohorts are evaluated here alone (T17 item 3).
import { flagLineage } from '@hearth/shared'

// A flag's row as the cache holds it (feature_flags, migration 0007).
export interface FlagState {
  key: string
  enabled: boolean
  locked: boolean
  revision: number
  // The whole org, or the people and holders of the org-wide roles named (any of them; A1).
  audience: 'org' | 'cohort'
  cohort: { people: readonly string[]; roles: readonly string[] }
}

// Who a flag is evaluated for: a person, whether they're still at the org, and the org-wide roles
// they hold (unrevoked, while they're still at the org), as read when the caller asked: for a job, at its claim, re-read at every claim,
// so a role revoked or a person deactivated while an attempt runs applies from the next claim, within
// the kind's timeoutMs; the database fence covers flag changes only (TECH-SPEC T15 item 9, T17 item
// 3). The first cohort-gated job kind that touches personal data (A0) re-reads it inside each
// commit. A job for nobody, or an outbox consumer working for the whole org, has no subject, and a
// flag with a cohort is off for it. So is one for someone who has left, even where the cohort names
// them: a cohort counts a person only while they're at the org. A kind whose subject is a leaver by
// design (offboarding, deletion) sits under a whole-org flag, which is on for everyone.
export interface FlagSubject {
  personId: string
  active: boolean
  roles: readonly string[]
}

function inCohort(state: FlagState, subject: FlagSubject | null): boolean {
  if (state.audience === 'org') return true
  if (subject === null || !subject.active) return false
  return state.cohort.people.includes(subject.personId) || subject.roles.some(role => state.cohort.roles.includes(role))
}

// 'on', 'off', or 'unknown' when the flag itself, or a registered flag above it, has no row (the
// caller treats it as off). A key above the flag that isn't registered and has no row isn't a flag
// at all ('core' above 'core.system'). A row the registry doesn't know is still read, as the
// fences read it: one above the flag that is switched off turns the flag off.
export function evaluate(
  states: ReadonlyMap<string, FlagState>,
  key: string,
  subject: FlagSubject | null,
  registered: (key: string) => boolean = () => false,
): 'on' | 'off' | 'unknown' {
  for (const level of flagLineage(key)) {
    const state = states.get(level)
    if (state === undefined) {
      if (level === key || registered(level)) return 'unknown'
      continue
    }
    if (!state.enabled || !inCohort(state, subject)) return 'off'
  }
  return 'on'
}

// Whether the flag and every flag above it is enabled, whoever the cohorts name: so a feature that
// is off for someone only because a cohort leaves them out can be told from one switched off
// (the runner cancels the first as not_in_cohort, T15 item 9). False when a row is missing, as
// evaluate() is 'unknown' then.
export function lineageEnabled(
  states: ReadonlyMap<string, FlagState>,
  key: string,
  registered: (key: string) => boolean = () => false,
): boolean {
  for (const level of flagLineage(key)) {
    const state = states.get(level)
    if (state === undefined) {
      if (level === key || registered(level)) return false
      continue
    }
    if (!state.enabled) return false
  }
  return true
}
