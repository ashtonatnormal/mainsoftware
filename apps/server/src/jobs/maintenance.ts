// Hearth's own maintenance (TECH-SPEC T15 items 16 and 17): two job kinds and their schedules, both
// under core.system, which is locked on, for the purpose service_operation.
//
//   maintenance.data_access_partitions  daily at 03:17 UTC, as hearth_job_partitions: keeps
//       data_access_events' month partitions 12 months ahead (0005's create_data_access_partitions),
//       in one transaction that waits at most 1 s for its locks (creating a partition takes an
//       ACCESS EXCLUSIVE lock on the busiest log, so it gives up and retries rather than stall it)
//       and holds a database-wide advisory lock (the function serves every org, so with several
//       orgs one run creates and the rest find nothing to do), then finishes the job. Daily rather
//       than monthly: the function is idempotent and a missed run heals the next day.
//   maintenance.purge  daily at 03:47 UTC, as hearth_job_purge: the outbox, then finished jobs,
//       then finished schedule runs, a batch at a time through purge_outbox(), purge_jobs() and
//       purge_schedule_runs(), the only way rows leave them, with the ages fixed in migration 0007
//       and one audit row per batch. Each batch commits on its own (idempotentCommits: a retry
//       starts again from the outbox, and finds less to delete).
//
// Both are rerun schedules: idempotent maintenance goes back to the queue when cut short.
import { sql } from 'kysely'
import { z } from 'zod'
import { defineJob, type ScheduleDef } from '#src/jobs/kinds.ts'

// Rows one clean-up call deletes at most (the functions allow 1 to 10,000).
export const PURGE_BATCH = 5000

const nothing = z.strictObject({})

export const partitionsJob = defineJob({
  kind: 'maintenance.data_access_partitions',
  feature: 'core.system',
  purpose: 'service_operation',
  role: 'hearth_job_partitions',
  payload: nothing,
  maxAttempts: 20,
  backoff: { baseMs: 30_000, capMs: 10 * 60_000 },
  timeoutMs: 30_000,
  async run(ctx) {
    ctx.step('partitions')
    await ctx.commit(
      async trx => {
        await sql`set local lock_timeout = '1s'`.execute(trx)
        await sql`select pg_advisory_xact_lock(hashtextextended('hearth.data_access_partitions', 0))`.execute(trx)
        await sql`select public.create_data_access_partitions(12)`.execute(trx)
      },
      { finish: true },
    )
  },
})

// The clean-up functions, in the order they run.
const PURGES = [
  { table: 'outbox_events', run: sql`select public.purge_outbox(${PURGE_BATCH}) as n` },
  { table: 'jobs', run: sql`select public.purge_jobs(${PURGE_BATCH}) as n` },
  { table: 'schedule_runs', run: sql`select public.purge_schedule_runs(${PURGE_BATCH}) as n` },
] as const

export const purgeJob = defineJob({
  kind: 'maintenance.purge',
  feature: 'core.system',
  purpose: 'service_operation',
  role: 'hearth_job_purge',
  payload: nothing,
  maxAttempts: 5,
  backoff: { baseMs: 60_000, capMs: 10 * 60_000 },
  timeoutMs: 5 * 60_000,
  idempotentCommits: true,
  async run(ctx) {
    for (const purge of PURGES) {
      for (;;) {
        ctx.step(purge.table)
        const rows = await ctx.commit(async trx => {
          const { rows } = await sql<{ n: number }>`${purge.run}`.execute(trx)
          return rows[0]?.n ?? 0
        })
        if (rows > 0) {
          ctx.log.info({ event: 'maintenance_purge', table: purge.table, rows }, 'the clean-up deleted a batch')
        }
        if (rows < PURGE_BATCH) break
      }
    }
    // The runner finishes the job in a transaction of its own.
  },
})

export const MAINTENANCE_KINDS = [partitionsJob, purgeJob] as const

// Hearth's own schedules (T15 items 16 and 17), written to every org by the scheduler. A key never
// changes: to change one, add a new key and list the old one as { key, retired: true }.
export const SCHEDULES: readonly ScheduleDef[] = [
  {
    key: 'maintenance.data_access_partitions',
    kind: partitionsJob.kind,
    cron: '17 3 * * *',
    onInterrupt: 'rerun',
  },
  { key: 'maintenance.purge', kind: purgeJob.kind, cron: '47 3 * * *', onInterrupt: 'rerun' },
]
