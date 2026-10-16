// The outbox's and the queue's health as log lines (TECH-SPEC T16 item 19), until
// C0.13 turns them into CloudWatch metrics and alarms. The worker writes them every 30 s, per org,
// as hearth_queue, which may read the outbox's positions and times but never an event's envelope:
//   outbox_lag   per consumer: how far behind it is (seconds since the oldest event it hasn't
//                passed, and how many events, counted up to 100,000), how long since its
//                checkpoint moved, and what the horizon holds back from every consumer (events
//                committed behind a transaction still running, and for how long). Warn when the
//                consumer is further behind than its own budget (lagBudgetMs).
//   queue_depth  per org: queued, running and dead jobs, interrupted schedule runs (each waiting
//                for a person), and how long the oldest due job has waited.
import { sql } from 'kysely'
import type { Logger } from 'pino'
import { type Database, withOrg } from '#src/db/database.ts'
import type { OutboxConsumer } from '#src/outbox/consumers.ts'

// Counting stops here, so a consumer far behind costs one bounded read.
export const LAG_COUNT_CAP = 100_000

export interface OutboxLag {
  consumer: string
  org: string
  secondsBehind: number
  eventsBehind: number
  checkpointAgeSeconds: number
  heldBackEvents: number
  heldBackSeconds: number
}

export interface QueueDepth {
  org: string
  queued: number
  running: number
  dead: number
  interrupted: number
  oldestQueuedSeconds: number
}

type LagRow = {
  consumer: string
  seconds_behind: number | string
  events_behind: number | string
  checkpoint_age: number | string
  held_events: number | string
  held_seconds: number | string
}

// Postgres returns counts as bigint and extract() as numeric, both strings in pg.
const num = (value: number | string | null): number => (value === null ? 0 : Number(value))

// One line per consumer that has a checkpoint in the org. One read-only statement, as hearth_queue.
export async function readOutboxLag(db: Database, orgId: string): Promise<OutboxLag[]> {
  const rows = await withOrg(
    db,
    { orgId, system: true, as: 'hearth_queue' },
    async trx =>
      (
        await sql<LagRow>`
          with held as (
            select count(*) as events, coalesce(extract(epoch from now() - min(e.at)), 0) as seconds
            from outbox_events e
            where e.org_id = ${orgId} and e.tx_id >= pg_snapshot_xmin(pg_current_snapshot()))
          select c.consumer,
            coalesce(extract(epoch from now() - (
              select e.at from outbox_events e
              where e.org_id = ${orgId} and (e.tx_id, e.id) > (c.last_tx, c.last_id)
              order by e.tx_id, e.id limit 1)), 0) as seconds_behind,
            (select count(*) from (
              select 1 from outbox_events e
              where e.org_id = ${orgId} and (e.tx_id, e.id) > (c.last_tx, c.last_id)
              limit ${LAG_COUNT_CAP}) behind) as events_behind,
            extract(epoch from now() - c.updated_at) as checkpoint_age,
            held.events as held_events, held.seconds as held_seconds
          from outbox_checkpoints c cross join held
          where c.org_id = ${orgId}
          order by c.consumer`.execute(trx)
      ).rows,
    { readOnly: true },
  )
  return rows.map(row => ({
    consumer: row.consumer,
    org: orgId,
    secondsBehind: num(row.seconds_behind),
    eventsBehind: num(row.events_behind),
    checkpointAgeSeconds: num(row.checkpoint_age),
    heldBackEvents: num(row.held_events),
    heldBackSeconds: num(row.held_seconds),
  }))
}

type DepthRow = {
  queued: number | string
  running: number | string
  dead: number | string
  interrupted: number | string
  oldest_queued: number | string | null
}

export async function readQueueDepth(db: Database, orgId: string): Promise<QueueDepth> {
  const row = await withOrg(
    db,
    { orgId, system: true, as: 'hearth_queue' },
    async trx =>
      (
        await sql<DepthRow>`
          select
            count(*) filter (where j.state = 'queued') as queued,
            count(*) filter (where j.state = 'running') as running,
            count(*) filter (where j.state = 'dead') as dead,
            (select count(*) from schedule_runs r where r.org_id = ${orgId} and r.state = 'interrupted') as interrupted,
            extract(epoch from now() - min(j.run_after) filter (where j.state = 'queued' and j.run_after <= now()))
              as oldest_queued
          from jobs j
          where j.org_id = ${orgId} and j.state in ('queued', 'running', 'dead')`.execute(trx)
      ).rows[0],
    { readOnly: true },
  )
  return {
    org: orgId,
    queued: num(row?.queued ?? 0),
    running: num(row?.running ?? 0),
    dead: num(row?.dead ?? 0),
    interrupted: num(row?.interrupted ?? 0),
    oldestQueuedSeconds: num(row?.oldest_queued ?? null),
  }
}

// Writes the lag lines: info, or warn for a consumer behind by more than its budget. A checkpoint
// no running consumer owns (a consumer since removed) is logged with no budget.
export function logOutboxLag(
  logger: Pick<Logger, 'info' | 'warn'>,
  lags: readonly OutboxLag[],
  consumers: readonly Pick<OutboxConsumer, 'name' | 'lagBudgetMs'>[],
): void {
  for (const lag of lags) {
    const budgetMs = consumers.find(consumer => consumer.name === lag.consumer)?.lagBudgetMs
    const line = { event: 'outbox_lag', ...lag, budgetMs: budgetMs ?? null }
    if (budgetMs !== undefined && lag.secondsBehind * 1000 > budgetMs) {
      logger.warn(line, 'an outbox consumer is behind its budget')
    } else {
      logger.info(line, 'outbox lag')
    }
  }
}

export function logQueueDepth(logger: Pick<Logger, 'info'>, depth: QueueDepth): void {
  logger.info({ event: 'queue_depth', ...depth }, 'queue depth')
}
