// Queuing a job (INF-QUEUE, TECH-SPEC T15 items 7, 8 and 18): a row added in the caller's own
// transaction, so it commits or rolls back with the change that asked for it. The database records
// the acting principal as created_by, which no producer chooses. The job's feature and purpose are
// its kind's, and its payload must pass the kind's schema (ids only) before any SQL.
//
// In C0.6 only the worker's own roles queue jobs: hearth_queue for scheduled runs and
// hearth_job_offboarding for offboarding. hearth_app has no INSERT on jobs until C0.14 gives the
// api its first producer, with a database check of which role may queue which kind.
//
// Producers may insert but not read the queue, so this is a plain INSERT with the id chosen here,
// and ON CONFLICT DO NOTHING without a target, which needs only INSERT (0007): adding the same
// idempotency key again for the same kind in the org adds nothing.
import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import type { InOrg } from '#src/db/database.ts'
import type { JobKind } from '#src/jobs/kinds.ts'

export interface EnqueueInput<P> {
  payload: P
  // The person the work is for: cohorts and processing switches are checked against them.
  subjectId?: string
  // The same key for the same (org, kind) again adds nothing while the first job's row lasts (14
  // days after it finishes, 30 if it died).
  idempotencyKey?: string
  // A delayed job: not before this instant (a reminder's UTC time, say).
  runAfter?: Date
}

// The scheduler's own: the run the job is for, and a review run's single attempt.
export interface ScheduledInput {
  scheduleRunId: string
  maxAttempts: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// A job the input refuses. Its message names the rule, never a value.
export class EnqueueRefused extends Error {
  override name = 'EnqueueRefused'
}

// Adds the job and returns the id it gave it; with a key already used, nothing is added and that id
// names no row.
export async function enqueue<P extends object>(
  trx: InOrg,
  orgId: string,
  kind: JobKind<P>,
  input: EnqueueInput<P>,
  scheduled?: ScheduledInput,
): Promise<string> {
  const parsed = kind.payload.safeParse(input.payload)
  // zod's message would echo the payload.
  if (!parsed.success) throw new EnqueueRefused(`a ${kind.kind} payload must match its kind's schema`)
  if (input.subjectId !== undefined && !UUID.test(input.subjectId)) {
    throw new EnqueueRefused('a subject is a lower-case uuid')
  }
  const key = input.idempotencyKey
  if (key !== undefined && (key.length < 1 || key.length > 200)) {
    throw new EnqueueRefused('an idempotency key is 1 to 200 characters')
  }
  const id = randomUUID()
  const values = sql`${id}::uuid, ${orgId}::uuid, ${kind.kind}, ${kind.feature}, ${kind.purpose},
    ${input.subjectId ?? null}::uuid, ${JSON.stringify(parsed.data)}::jsonb, ${key ?? null},
    ${scheduled?.maxAttempts ?? kind.maxAttempts}, coalesce(${input.runAfter ?? null}::timestamptz, now())`
  // Only hearth_queue may name a schedule run, and a column named at all needs the grant, so the
  // column is left out unless the scheduler gives one.
  if (scheduled === undefined) {
    await sql`insert into jobs (id, org_id, kind, feature_key, purpose, subject_id, payload, idempotency_key,
        max_attempts, run_after)
      values (${values}) on conflict do nothing`.execute(trx)
  } else {
    await sql`insert into jobs (id, org_id, kind, feature_key, purpose, subject_id, payload, idempotency_key,
        max_attempts, run_after, schedule_run_id)
      values (${values}, ${scheduled.scheduleRunId}::uuid) on conflict do nothing`.execute(trx)
  }
  return id
}
