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

// Who a flag is evaluated for: a person and the org-wide roles they hold now (unrevoked, while
// they're still at the org). A job for nobody, or an outbox consumer working for the whole org,
// has no subject, and a flag with a cohort is off for it.
export interface FlagSubject {
  personId: string
  roles: readonly string[]
}

function inCohort(state: FlagState, subject: FlagSubject | null): boolean {
  if (state.audience === 'org') return true
  if (subject === null) return false
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
