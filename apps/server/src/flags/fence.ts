// The fence a transaction ends with when it makes a feature's effect visible (TECH-SPEC T17 item 8;
// PRD-65: "zero posts afterwards"). feature_fence() (migration 0007) locks the feature's flag and
// every flag above it FOR SHARE and refuses unless each is enabled and still at the revision the
// server evaluated: a change in progress makes it wait and then refuse, and one that starts later
// waits for this transaction. So whatever the process's copy of the flags says, nothing commits
// after a flag is turned off, narrowed or relocked. It must be the transaction's last statement.
// A job's transactions use job_fence() or job_finish() instead (jobs/), which fence the job's lease
// as well.
import { sql } from 'kysely'
import type { InOrg } from '#src/db/database.ts'
import { FEATURE_OFF, sqlstateOf } from '#src/db/sqlstate.ts'

// The fence refused: the feature is off, or its flags changed since `seen`. The transaction is
// rolled back; the caller reloads the org's flags and decides again.
export class FeatureOff extends Error {
  override name = 'FeatureOff'
  readonly feature: string
  constructor(feature: string) {
    super(`the ${feature} feature is off, or its flags changed`)
    this.feature = feature
  }
}

// `seen` is FlagCache.revisionsOf(org, feature): the lineage's revisions from the top.
export async function fenceFeature(trx: InOrg, feature: string, seen: readonly number[]): Promise<void> {
  try {
    await sql`select public.feature_fence(${feature}, ${[...seen]}::bigint[])`.execute(trx)
  } catch (error) {
    if (sqlstateOf(error) === FEATURE_OFF) throw new FeatureOff(feature)
    throw error
  }
}
