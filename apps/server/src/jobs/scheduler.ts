// The scheduler (INF-SCHED, TECH-SPEC T15 items 2, 13, 15 and 20). Every tick (5 s ±10%), for each
// org in turn, as hearth_queue on the worker's control pool, each step in a transaction of its own
// and every time read from the database's clock (now() in that transaction), never the worker's:
//
//   reconcile  At start, for a new org and every 10 minutes: the registry's schedules that have no
//              row in the org are added, with their first occurrence, and the keys the registry
//              lists as retired are retired. Nothing else: a key's kind, cron, payload and policy
//              never change (the role can't change them) and a retired key never comes back, so two
//              versions of the worker running at once during a deploy can't undo each other.
//   fire       Due schedules of kinds this worker knows, FOR NO KEY UPDATE SKIP LOCKED: one run for
//              the latest occurrence at or before now (one row per occurrence, so of two schedulers
//              firing it, one adds the run and the other adds nothing, and queues no job), then its
//              job, keyed by the run, and the next occurrence. Occurrences missed while no worker
//              ran are counted and logged (schedule_missed), not run. A review schedule whose
//              feature is off gets its run skipped (flag_off) and no job.
//   sweep      Running jobs whose lease ran out (a crashed or stalled worker), FOR NO KEY UPDATE SKIP
//              LOCKED, so one a finishing transaction holds is passed by and looked at next tick:
//              back to the queue after a back-off, the attempt counted, or dead with none left; a
//              review run's job is never retried, and its run is interrupted (crash).
//   cancel     Queued jobs of kinds that drop their work when their feature is off (optional flags,
//              or onFlagOff: 'cancel') whose feature or a flag above it is off: cancelled (flag_off).
//   unknown    Queued jobs of a kind this worker doesn't know, due more than 7 days ago: a version
//              that knew the kind would have claimed them by now, so they go dead (kind_unknown).
//
// A rerun schedule's runs are retried like any job. A review schedule's run cut short waits as
// interrupted for a person (AGT-10). C0.6 has no way to resume one (amendment A2): the step that
// adds the first review schedule (A4 or A5.4) adds the checked decision function and the
// scheduler's handling of a resumed run.
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { sql } from 'kysely'
import type { Logger } from 'pino'
import { type Database, type InOrg, withOrg } from '#src/db/database.ts'
import { failureFields } from '#src/db/sqlstate.ts'
import type { FlagCache } from '#src/flags/cache.ts'
import { type Cron, nextAfter, parseCron, previousAtOrBefore } from '#src/jobs/cron.ts'
import { enqueue } from '#src/jobs/enqueue.ts'
import { isRetired, type JobKind, type RetiredSchedule, type ScheduleDef } from '#src/jobs/kinds.ts'
import { backoffMs, DEFAULT_BACKOFF, jittered, SCHEDULER_POLICY, type SchedulerPolicy } from '#src/jobs/policy.ts'
import { Sleeper, settledBy } from '#src/jobs/sleeper.ts'

export type { RetiredSchedule, ScheduleDef } from '#src/jobs/kinds.ts'

export interface SchedulerOptions {
  // The worker's control pool, as hearth_worker (each step takes hearth_queue).
  db: Database
  schedules: readonly (ScheduleDef | RetiredSchedule)[]
  kinds: ReadonlyMap<string, JobKind>
  flags: Pick<FlagCache, 'verdict' | 'registry'>
  logger: Logger
  policy?: SchedulerPolicy
  now?: () => number
  random?: () => number
}

// The most missed occurrences counted for one firing; schedule_missed then says "at least".
const MISSED_CAP = 1000
// A loop step that has failed this many times in a row logs at error level.
const FAILURES_BEFORE_ERROR = 3

// Whether a kind's queued work is dropped while its feature is off (T15 item 9).
export function cancelsWhenOff(kind: JobKind, flags: Pick<FlagCache, 'registry'>): boolean {
  if (kind.onFlagOff !== undefined) return kind.onFlagOff === 'cancel'
  const spec = Object.hasOwn(flags.registry, kind.feature) ? flags.registry[kind.feature] : undefined
  return spec?.class !== 'essential'
}

type DueRow = {
  id: string
  key: string
  kind: string
  cron: string
  on_interrupt: 'rerun' | 'review'
  payload: Record<string, unknown>
  next_run_at: Date
  now: Date
}

type SweptRow = {
  id: string
  kind: string
  attempts: number
  max_attempts: number
  schedule_run_id: string | null
  on_interrupt: 'rerun' | 'review' | null
}

export class Scheduler {
  readonly #db: Database
  readonly #schedules: readonly (ScheduleDef | RetiredSchedule)[]
  readonly #kinds: ReadonlyMap<string, JobKind>
  readonly #flags: Pick<FlagCache, 'verdict' | 'registry'>
  readonly #logger: Logger
  readonly #policy: SchedulerPolicy
  readonly #now: () => number
  readonly #random: () => number
  readonly #sleeper = new Sleeper()
  readonly #reconciled = new Map<string, number>()
  readonly #failures = new Map<string, number>()
  // Each schedule key whose row differs from the registry, logged once.
  readonly #differs = new Set<string>()
  readonly #unreadable = new Set<string>()
  #orgs: () => readonly string[] = () => []
  #loop: Promise<void> | undefined
  #last: number | undefined
  #stopping = false

  constructor(options: SchedulerOptions) {
    this.#db = options.db
    this.#schedules = options.schedules
    this.#kinds = options.kinds
    this.#flags = options.flags
    this.#logger = options.logger
    this.#policy = options.policy ?? SCHEDULER_POLICY
    this.#now = options.now ?? (() => performance.now())
    this.#random = options.random ?? Math.random
  }

  start(orgs: () => readonly string[]): void {
    if (this.#loop !== undefined) throw new Error('the scheduler has started already')
    this.#orgs = orgs
    this.#loop = this.#ticks()
  }

  // When the last tick over every org finished without an error (monotonic), or undefined.
  lastRound(): number | undefined {
    return this.#last
  }

  // Stops ticking and waits for a tick in progress, never past `deadline`.
  async stop(deadline: number): Promise<void> {
    this.halt()
    await settledBy(this.#loop ?? Promise.resolve(), deadline, this.#now)
  }

  // Stops ticking at once; a step in progress finishes or fails with its connection.
  halt(): void {
    this.#stopping = true
    this.#sleeper.wake()
  }

  // One tick for one org: every step, each in its own transaction. Returns whether all worked; a
  // failure is logged and the step is tried again at the next tick.
  async tick(orgId: string): Promise<boolean> {
    let clean = true
    const step = async (name: string, work: () => Promise<void>) => {
      if (this.#stopping) return
      try {
        await work()
        this.#failures.delete(`${name}:${orgId}`)
      } catch (error) {
        clean = false
        this.#stepFailed(name, orgId, error)
      }
    }
    const reconciledAt = this.#reconciled.get(orgId)
    if (reconciledAt === undefined || this.#now() - reconciledAt >= this.#policy.reconcileMs) {
      await step('scheduler.reconcile', async () => {
        await this.#reconcile(orgId)
        this.#reconciled.set(orgId, this.#now())
      })
    }
    await step('scheduler.fire', () => this.#fire(orgId))
    await step('scheduler.sweep', () => this.#sweep(orgId))
    await step('scheduler.cancel', () => this.#cancelOff(orgId))
    await step('scheduler.unknown', () => this.#retireUnknown(orgId))
    return clean
  }

  async #ticks(): Promise<void> {
    while (!this.#stopping) {
      let clean = true
      for (const orgId of this.#orgs()) {
        if (this.#stopping) break
        if (!(await this.tick(orgId))) clean = false
      }
      if (clean && !this.#stopping) this.#last = this.#now()
      if (!this.#stopping) await this.#sleeper.sleep(jittered(this.#policy.tickMs, this.#random))
    }
  }

  #queue<T>(orgId: string, work: (trx: InOrg) => Promise<T>): Promise<T> {
    return withOrg(this.#db, { orgId, system: true, as: 'hearth_queue' }, work)
  }

  // --- Reconcile -----------------------------------------------------------------------------

  async #reconcile(orgId: string): Promise<void> {
    await this.#queue(orgId, async trx => {
      const now = (await sql<{ now: Date }>`select now() as now`.execute(trx)).rows[0]?.now ?? new Date()
      const live = this.#schedules.filter((s): s is ScheduleDef => !isRetired(s))
      for (const schedule of live) {
        const next = nextAfter(parseCron(schedule.cron), now)
        const { rows } = await sql<{
          key: string
        }>`insert into schedules (org_id, key, kind, cron, on_interrupt, payload, next_run_at)
          values (${orgId}, ${schedule.key}, ${schedule.kind}, ${schedule.cron}, ${schedule.onInterrupt},
            ${JSON.stringify(schedule.payload ?? {})}::jsonb, ${next})
          on conflict (org_id, key) do nothing
          returning key`.execute(trx)
        if (rows.length > 0) {
          this.#logger.info({ event: 'schedule_added', org: orgId, schedule: schedule.key }, 'a schedule was added')
        }
      }
      if (live.length > 0) {
        // A row the registry no longer matches is a key someone changed in place: never applied
        // (a change is a new key), and logged once.
        const { rows } = await sql<{
          key: string
          kind: string
          cron: string
          on_interrupt: string
          payload: unknown
        }>`select key, kind, cron, on_interrupt, payload from schedules
          where org_id = ${orgId} and key = any(${live.map(s => s.key)}::text[])`.execute(trx)
        for (const row of rows) {
          const schedule = live.find(s => s.key === row.key)
          if (schedule === undefined || this.#differs.has(row.key)) continue
          const same =
            row.kind === schedule.kind &&
            row.cron === schedule.cron &&
            row.on_interrupt === schedule.onInterrupt &&
            JSON.stringify(row.payload) === JSON.stringify(schedule.payload ?? {})
          if (!same) {
            this.#differs.add(row.key)
            this.#logger.warn(
              { event: 'schedule_differs', org: orgId, schedule: row.key },
              'a schedule differs from the registry: a change needs a new key, with the old one retired',
            )
          }
        }
      }
      const retired = this.#schedules.filter(isRetired).map(s => s.key)
      if (retired.length > 0) {
        const { rows } = await sql<{ key: string }>`update schedules set retired_at = now()
          where org_id = ${orgId} and key = any(${retired}::text[]) and retired_at is null
          returning key`.execute(trx)
        for (const row of rows) {
          this.#logger.info({ event: 'schedule_retired', org: orgId, schedule: row.key }, 'a schedule was retired')
        }
      }
    })
  }

  // --- Fire ----------------------------------------------------------------------------------

  async #fire(orgId: string): Promise<void> {
    const known = [...this.#kinds.keys()]
    await this.#queue(orgId, async trx => {
      const { rows } = await sql<DueRow>`
        select id, key, kind, cron, on_interrupt, payload, next_run_at, now() as now from schedules
        where org_id = ${orgId} and retired_at is null and next_run_at <= now() and kind = any(${known}::text[])
        order by next_run_at
        for no key update skip locked
        limit ${this.#policy.fireBatch}`.execute(trx)
      for (const due of rows) await this.#fireOne(trx, orgId, due)
    })
  }

  async #fireOne(trx: InOrg, orgId: string, due: DueRow): Promise<void> {
    const kind = this.#kinds.get(due.kind)
    if (kind === undefined) return
    let cron: Cron
    try {
      cron = parseCron(due.cron)
    } catch {
      // The row's shape passed the table's check, but cron can't read it: nothing can fire it.
      if (!this.#unreadable.has(due.id)) {
        this.#unreadable.add(due.id)
        this.#logger.error({ event: 'schedule_unreadable', org: orgId, schedule: due.key }, 'a schedule cannot fire')
      }
      return
    }
    const review = due.on_interrupt === 'review'
    // A review run whose feature is off is skipped; one whose flags aren't confirmed waits a tick.
    const verdict = review ? this.#flags.verdict(orgId, kind.feature, null) : 'on'
    if (verdict === 'unconfirmed') return
    // The latest occurrence at or before now, from the database's clock; not before the time the
    // row says was due (which an occurrence normally is).
    const latest = previousAtOrBefore(cron, due.now)
    const scheduledFor = latest > due.next_run_at ? latest : due.next_run_at
    let missed = 0
    for (let at = due.next_run_at; at < scheduledFor && missed < MISSED_CAP; at = nextAfter(cron, at)) missed++
    const runId = randomUUID()
    const skipped = verdict !== 'on'
    const { rows } = await sql<{ id: string }>`
      insert into schedule_runs (id, org_id, schedule_id, scheduled_for, on_interrupt, state, reason, finished_at)
      values (${runId}, ${orgId}, ${due.id}, ${scheduledFor}, ${due.on_interrupt}, ${skipped ? 'skipped' : 'queued'},
        ${skipped ? 'flag_off' : null}, ${skipped ? due.now : null})
      on conflict do nothing
      returning id`.execute(trx)
    const fired = rows.length > 0
    if (fired && !skipped) {
      await enqueue(
        trx,
        orgId,
        kind,
        { payload: due.payload, idempotencyKey: `run:${runId}` },
        { scheduleRunId: runId, maxAttempts: review ? 1 : kind.maxAttempts },
      )
    }
    await sql`update schedules set next_run_at = ${nextAfter(cron, due.now)}, last_fired_at = now()
      where org_id = ${orgId} and id = ${due.id}`.execute(trx)
    const line = { org: orgId, schedule: due.key, scheduledFor: scheduledFor.toISOString() }
    if (!fired) return
    if (skipped) {
      this.#logger.info({ event: 'schedule_run_skipped', ...line, run: runId, reason: 'flag_off' }, 'a run was skipped')
    } else {
      this.#logger.info({ event: 'schedule_fired', ...line, run: runId }, 'a schedule fired')
    }
    if (missed > 0) {
      this.#logger.warn(
        { event: 'schedule_missed', ...line, missed, atLeast: missed >= MISSED_CAP },
        'occurrences were missed while no worker ran',
      )
    }
  }

  // --- Sweep ---------------------------------------------------------------------------------

  async #sweep(orgId: string): Promise<void> {
    await this.#queue(orgId, async trx => {
      const { rows } = await sql<SweptRow>`
        select j.id, j.kind, j.attempts, j.max_attempts, j.schedule_run_id, r.on_interrupt
        from jobs j left join schedule_runs r on r.org_id = j.org_id and r.id = j.schedule_run_id
        where j.org_id = ${orgId} and j.state = 'running' and j.lease_expires_at < now()
        order by j.lease_expires_at
        for no key update of j skip locked
        limit ${this.#policy.sweepBatch}`.execute(trx)
      for (const row of rows) {
        const review = row.on_interrupt === 'review'
        const dead = review || row.attempts >= row.max_attempts
        const delayMs = dead
          ? 0
          : backoffMs(row.attempts, this.#kinds.get(row.kind)?.backoff ?? DEFAULT_BACKOFF, this.#random)
        await sql`update jobs set state = ${dead ? 'dead' : 'queued'}, reason = 'lease_expired',
            run_after = case when ${dead} then run_after else now() + ${delayMs}::float8 * interval '1 millisecond' end,
            finished_at = case when ${dead} then now() end, lease_token = null, lease_expires_at = null
          where org_id = ${orgId} and id = ${row.id}`.execute(trx)
        if (row.schedule_run_id !== null) {
          const state = review ? 'interrupted' : dead ? 'failed' : 'queued'
          await sql`update schedule_runs set state = ${state}, reason = ${review ? 'crash' : 'lease_expired'},
              finished_at = case when ${state} = 'queued' then null else now() end
            where org_id = ${orgId} and id = ${row.schedule_run_id} and state = 'running'`.execute(trx)
        }
        const line = { job: row.id, kind: row.kind, org: orgId, attempt: row.attempts, reason: 'lease_expired' }
        if (dead) this.#logger.error({ event: 'job_dead', ...line }, 'a job went dead')
        else this.#logger.warn({ event: 'job_retry', ...line, retryInMs: delayMs }, 'a job lost its worker')
        if (review) {
          this.#logger.error(
            { event: 'schedule_run_interrupted', run: row.schedule_run_id, org: orgId, job: row.id, reason: 'crash' },
            'a review run was cut short and waits for a person',
          )
        }
      }
    })
  }

  // --- Cancel off work, retire unknown kinds ---------------------------------------------------

  async #cancelOff(orgId: string): Promise<void> {
    const kinds = [...this.#kinds.values()].filter(kind => cancelsWhenOff(kind, this.#flags)).map(kind => kind.kind)
    if (kinds.length === 0) return
    await this.#queue(orgId, async trx => {
      const { rows } = await sql<{ id: string; kind: string; schedule_run_id: string | null }>`
        with off as (
          select j.id from jobs j
          where j.org_id = ${orgId} and j.state = 'queued' and j.kind = any(${kinds}::text[])
            and exists (select 1 from feature_flags f
                        where f.org_id = j.org_id and not f.enabled
                          and (j.feature_key = f.key or starts_with(j.feature_key, f.key || '.')))
          order by j.run_after
          for no key update skip locked
          limit ${this.#policy.sweepBatch})
        update jobs j set state = 'cancelled', reason = 'flag_off', finished_at = now()
        from off where j.org_id = ${orgId} and j.id = off.id
        returning j.id, j.kind, j.schedule_run_id`.execute(trx)
      await this.#endRuns(trx, orgId, rows, 'skipped', 'flag_off')
      for (const row of rows) {
        this.#logger.info(
          { event: 'job_cancelled', job: row.id, kind: row.kind, org: orgId, reason: 'flag_off' },
          'a job was cancelled',
        )
      }
    })
  }

  async #retireUnknown(orgId: string): Promise<void> {
    const known = [...this.#kinds.keys()]
    await this.#queue(orgId, async trx => {
      const { rows } = await sql<{ id: string; kind: string; schedule_run_id: string | null }>`
        with unknown as (
          select j.id from jobs j
          where j.org_id = ${orgId} and j.state = 'queued' and not (j.kind = any(${known}::text[]))
            and j.run_after < now() - ${this.#policy.unknownKindMs}::float8 * interval '1 millisecond'
          order by j.run_after
          for no key update skip locked
          limit ${this.#policy.sweepBatch})
        update jobs j set state = 'dead', reason = 'kind_unknown', finished_at = now()
        from unknown where j.org_id = ${orgId} and j.id = unknown.id
        returning j.id, j.kind, j.schedule_run_id`.execute(trx)
      await this.#endRuns(trx, orgId, rows, 'failed', 'kind_unknown')
      for (const row of rows) {
        const line = { job: row.id, kind: row.kind, org: orgId, reason: 'kind_unknown' }
        this.#logger.error({ event: 'job_dead', ...line }, 'a job went dead')
        this.#logger.error({ event: 'job_kind_unknown', ...line }, 'no running worker knows this kind of job')
      }
    })
  }

  // The runs of jobs ended in a step: interrupted for a review run, which waits for a person, or
  // the given state.
  async #endRuns(
    trx: InOrg,
    orgId: string,
    jobs: readonly { id: string; schedule_run_id: string | null }[],
    state: 'skipped' | 'failed',
    reason: string,
  ): Promise<void> {
    const runs = jobs.flatMap(job => (job.schedule_run_id === null ? [] : [job.schedule_run_id]))
    if (runs.length === 0) return
    const { rows } = await sql<{ id: string; state: string }>`update schedule_runs
      set state = case when on_interrupt = 'review' then 'interrupted' else ${state} end, reason = ${reason},
        finished_at = now()
      where org_id = ${orgId} and id = any(${runs}::uuid[]) and state in ('queued', 'running')
      returning id, state`.execute(trx)
    for (const row of rows) {
      if (row.state === 'interrupted') {
        this.#logger.error(
          { event: 'schedule_run_interrupted', run: row.id, org: orgId, reason },
          'a review run was cut short and waits for a person',
        )
      }
    }
  }

  #stepFailed(step: string, orgId: string, error: unknown): void {
    const key = `${step}:${orgId}`
    const failures = (this.#failures.get(key) ?? 0) + 1
    this.#failures.set(key, failures)
    const line = { event: 'worker_loop_failed', loop: step, org: orgId, failures, failure: failureFields(error) }
    if (failures >= FAILURES_BEFORE_ERROR) this.#logger.error(line, 'a scheduler step failed')
    else this.#logger.warn(line, 'a scheduler step failed')
  }
}
