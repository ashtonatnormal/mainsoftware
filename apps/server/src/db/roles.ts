// The worker's job roles (TECH-SPEC T18; migrations 0007 and 0008). The worker logs in as
// hearth_worker, which holds nothing itself and may SET (never INHERIT) each of these, and takes
// one for each transaction through withOrg()'s `as` (database.ts, the only code that sets a role).
// Each is NOLOGIN, owns nothing and is held to row level security, so a handler can touch only
// what its role was granted:
//   hearth_queue            claims, heartbeats, outcomes, the scheduler, the flag cache, metrics
//                           and the worker's org list (worker_org_ids())
//   hearth_job_offboarding  the offboarding consumer and its jobs
//   hearth_job_partitions   create_data_access_partitions()
//   hearth_job_purge        the clean-up functions
//   hearth_job_revocation   the revocation consumer and its jobs (C0.7, T19)
// apps/server/scripts/check-catalogues.ts checks that this list equals the roles hearth_worker
// may SET in the database, and pool.ts's workerRolesCheck that the worker's login can take each.
export const JOB_ROLES = [
  'hearth_queue',
  'hearth_job_offboarding',
  'hearth_job_partitions',
  'hearth_job_purge',
  'hearth_job_revocation',
] as const
export type JobRole = (typeof JOB_ROLES)[number]

export function isJobRole(role: string): role is JobRole {
  return (JOB_ROLES as readonly string[]).includes(role)
}
