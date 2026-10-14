// The job runner (INF-QUEUE, TECH-SPEC T15): claims queued jobs per org, keeps their leases alive,
// runs each through its kind's handler, and writes how each attempt ended.
//
//   claims      Per org whose flags the worker has confirmed, while slots are free, as hearth_queue
//               on the control pool: queued, due jobs of kinds this worker knows whose feature and
//               every flag above it are enabled in Postgres (so a stale cache never starts one),
//               oldest first, FOR UPDATE SKIP LOCKED, each given a fresh lease token; their schedule
//               runs become running; the people they are for are read (still at the org, current
//               roles) for the flags' cohorts.
//   attempts    A claimed job whose feature or purpose isn't its kind's is never run (job_mismatch),
//               nor one whose payload its kind refuses (payload_invalid). Otherwise the gate admits
//               it (jobs/gate.ts), after reloading the org's flags if they say the feature is off,
//               and its handler runs with an AbortSignal, a timer for the kind's timeoutMs and the
//               lineage revisions it was admitted under, which every commit's fence compares.
//   heartbeats  Every 10 s from the start of the last, one statement per org, bounded to 10 s,
//               renews every running job's lease. A job whose lease wasn't renewed has lost it
//               (lease_lost), unless its finishing commit is in flight, which then reports for
//               itself, or has committed: nothing aborts a job after that (T15 item 3). A heartbeat
//               that fails is tried again 1 s later (a tenth of the interval), not a whole interval;
//               once 25 s have passed since the start of the last heartbeat that renewed a job's
//               lease (the lease less a margin of half a heartbeat), the watchdog aborts it
//               (lease_lost) before the lease can run out and the sweep give it to another worker.
//   watching    A flag change for an org re-evaluates its running jobs: no longer on for the job's
//               person aborts it (flag_off, not_in_cohort); still on moves the revisions it fences
//               with. Every second, a job whose org's flags have gone unconfirmed (8 s) is aborted,
//               and one whose lease may lapse (above).
//   outcomes    Written by hearth_queue on the control pool, only while the job is still running
//               under the lease this worker holds (no row: the sweep took it, or it finished). See
//               TECH-SPEC T15 items 2 to 6: succeeded (job_finish, in the effect's transaction);
//               cancelled; given back at once, uncounted (the flag changed, an essential feature
//               off, flags unconfirmed or a shutdown, the last two counted in give_backs, which end
//               in dead at 20); retried after a back-off; dead with a reason code. A review run's job
//               is never given back or retried: it is cancelled or dead, and its run interrupted.
//   stop        Stops claiming, gives running jobs 3 s to finish, aborts the rest (shutdown) and
//               gives them back within 1 s more, never past the deadline: whatever is still in
//               flight then is left to lease expiry.
//
// Nothing here logs an error's message: a failure is logged through failureFields() (T15 item 5).
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { performance } from 'node:perf_hooks'
import { COHORT_ROLES } from '@hearth/shared'
import { type RawBuilder, sql } from 'kysely'
import type { Logger } from 'pino'
import { type Database, type InOrg, withOrg } from '#src/db/database.ts'
import { type FailureFields, failureFields, sqlstateOf } from '#src/db/sqlstate.ts'
import type { FlagCache } from '#src/flags/cache.ts'
import type { FlagSubject } from '#src/flags/evaluate.ts'
import { JobAttempt } from '#src/jobs/context.ts'
import { type AbortReason, JobAborted, JobRefused, PermanentJobError } from '#src/jobs/errors.ts'
import { admit, type Gate } from '#src/jobs/gate.ts'
import type { JobKind } from '#src/jobs/kinds.ts'
import { backoffMs, JOB_POLICY, type JobPolicy } from '#src/jobs/policy.ts'
import { Sleeper, settledBy } from '#src/jobs/sleeper.ts'

export type RunnerFlags = Pick<FlagCache, 'verdict' | 'confirmed' | 'revisionsOf' | 'reload' | 'onChange' | 'registry'>

export interface JobRunnerOptions {
  // The worker's control pool (claims, heartbeats, outcomes) and work pool (handlers'
  // transactions), both logged in as hearth_worker (T18 item 8).
  control: Database
  work: Database
  kinds: ReadonlyMap<string, JobKind>
  flags: RunnerFlags
  gate: Gate
  logger: Logger
  // How many jobs run at once (WORKER_CONCURRENCY).
  concurrency: number
  // Who claimed a job (jobs.claimed_by): this process.
  workerId?: string
  policy?: JobPolicy
  // A monotonic clock (performance.now) and the jitter's randomness, for tests.
  now?: () => number
  random?: () => number
}

// What an attempt came to, and what the runner writes for it.
export type Outcome =
  | { type: 'succeeded' }
  // Nothing written: the lease sweep has the job.
  | { type: 'lease_lost' }
  | { type: 'cancel'; reason: string }
  // Back to the queue without counting the attempt.
  | { type: 'requeue'; reason: string; delayMs: number }
  // The same, counted in give_backs, which end in dead at the limit.
  | { type: 'give_back'; reason: 'unconfirmed' | 'shutdown' }
  // Back to the queue after a back-off, the attempt counted.
  | { type: 'retry'; reason: string; delayMs: number; failure?: FailureFields }
  | { type: 'dead'; reason: string; failure?: FailureFields; event?: string }

// A claimed job, as the claim returns it.
export interface ClaimedJob {
  id: string
  kind: string
  feature_key: string
  purpose: string
  subject_id: string | null
  payload: unknown
  attempts: number
  max_attempts: number
  give_backs: number
  lease_token: string
  schedule_run_id: string | null
}

interface Running {
  orgId: string
  row: ClaimedJob
  kind: JobKind
  // Whether its schedule run waits for a person when cut short (AGT-10).
  review: boolean
  subject: FlagSubject | null
  controller: AbortController
  // When the statement that last renewed its lease began (monotonic): the claim that gave it, then
  // each heartbeat that renewed it, recorded once that heartbeat succeeds. The database set the
  // lease from its now(), which is no earlier, so the lease lasts at least until renewedAt plus
  // leaseMs. The watchdog aborts it a margin before that.
  renewedAt: number
  attempt: JobAttempt<object> | undefined
  // The outcome, once decided, and whether its write changed the job.
  outcome: Outcome | undefined
  decision: Promise<void> | undefined
  applied: boolean
  done: Promise<void>
}

// A loop that has failed this many times in a row logs at error level (C0.13 alarms on it).
const FAILURES_BEFORE_ERROR = 3

// Who claimed a job: this host and process, and a few random characters, within claimed_by's check.
export function newWorkerId(): string {
  const host = hostname()
    .replace(/[^A-Za-z0-9_.-]/g, '-')
    .slice(0, 60)
  return `${host || 'worker'}:${process.pid}:${randomBytes(4).toString('hex')}`
}

// The claim (T15 item 1; verified on Postgres 17: a job whose feature is off isn't claimed, and of
// two claimers one claims and the other skips at once).
async function claimJobs(
  trx: InOrg,
  orgId: string,
  kinds: readonly string[],
  limit: number,
  workerId: string,
  leaseMs: number,
): Promise<ClaimedJob[]> {
  const { rows } = await sql<ClaimedJob>`
    with next as (
      select j.id from jobs j
      where j.org_id = ${orgId} and j.state = 'queued' and j.run_after <= now() and j.attempts < j.max_attempts
        and j.kind = any(${[...kinds]}::text[])
        and not exists (select 1 from feature_flags f
                        where f.org_id = j.org_id and not f.enabled
                          and (j.feature_key = f.key or starts_with(j.feature_key, f.key || '.')))
      order by j.run_after, j.id
      for update skip locked
      limit ${limit})
    update jobs j set state = 'running', attempts = j.attempts + 1, lease_token = gen_random_uuid(),
      lease_expires_at = now() + ${leaseMs}::float8 * interval '1 millisecond',
      started_at = coalesce(j.started_at, now()), claimed_by = ${workerId}
    from next where j.id = next.id
    returning j.id, j.kind, j.feature_key, j.purpose, j.subject_id, j.payload, j.attempts, j.max_attempts,
      j.give_backs, j.lease_token, j.schedule_run_id`.execute(trx)
  return rows
}

export class JobRunner {
  readonly #control: Database
  readonly #work: Database
  readonly #kinds: ReadonlyMap<string, JobKind>
  readonly #flags: RunnerFlags
  readonly #gate: Gate
  readonly #logger: Logger
  readonly #concurrency: number
  readonly #workerId: string
  readonly #policy: JobPolicy
  readonly #now: () => number
  readonly #random: () => number
  // The attempts running, by their claim's lease token.
  readonly #running = new Map<string, Running>()
  readonly #failures = new Map<string, number>()
  readonly #claims = new Sleeper()
  readonly #ticks = new Sleeper()
  readonly #loops: Promise<void>[] = []
  #orgs: () => readonly string[] = () => []
  #unlisten: (() => void) | undefined
  #claimLoop: Promise<void> | undefined
  #lastClaim: number | undefined
  #lastBeat: number | undefined
  #stopping = false
  #halted = false
  #heartbeatsPaused = false

  constructor(options: JobRunnerOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new Error('JobRunner: concurrency is a whole number of at least 1')
    }
    this.#control = options.control
    this.#work = options.work
    this.#kinds = options.kinds
    this.#flags = options.flags
    this.#gate = options.gate
    this.#logger = options.logger
    this.#concurrency = options.concurrency
    this.#workerId = options.workerId ?? newWorkerId()
    this.#policy = options.policy ?? JOB_POLICY
    this.#now = options.now ?? (() => performance.now())
    this.#random = options.random ?? Math.random
  }

  // Starts claiming in the orgs `orgs` lists at each pass, renewing leases and watching flags,
  // each loop's first round at once.
  start(orgs: () => readonly string[]): void {
    if (this.#unlisten !== undefined) throw new Error('the job runner has started already')
    this.#orgs = orgs
    this.#unlisten = this.#flags.onChange(orgId => this.#flagsChanged(orgId))
    this.#claimLoop = this.#claimPasses()
    this.#loops.push(this.#claimLoop, this.#heartbeats(), this.#watchdog())
  }

  // How many jobs are running.
  get active(): number {
    return this.#running.size
  }

  // When the claim loop and the heartbeat loop last finished a pass without an error (monotonic),
  // or undefined if one hasn't yet: the worker's readiness.
  lastRound(): number | undefined {
    return this.#lastClaim
  }
  lastHeartbeat(): number | undefined {
    return this.#lastBeat
  }

  // Stops claiming; gives running jobs drainMs to finish; aborts the rest (shutdown), which gives
  // them back; waits giveBackMs for those writes; never past `deadline` (on the runner's clock).
  // Anything still in flight is then left to lease expiry.
  async stop(deadline: number): Promise<void> {
    this.#stopping = true
    this.#claims.wake()
    const drained = Promise.all([...this.#running.values()].map(r => r.done))
    await settledBy(drained, Math.min(this.#now() + this.#policy.drainMs, deadline), this.#now)
    for (const r of this.#running.values()) this.#abort(r, 'shutdown')
    const givenBack = Promise.all([...this.#running.values()].map(r => r.decision ?? Promise.resolve()))
    await settledBy(givenBack, Math.min(this.#now() + this.#policy.giveBackMs, deadline), this.#now)
    await settledBy(this.#claimLoop ?? Promise.resolve(), deadline, this.#now)
    this.halt()
  }

  // Stops every loop and timer at once and writes nothing more: what stop() ends with, and, for
  // the integration tests, a crash (the harness also ends the worker's connections). Running jobs'
  // signals are aborted so their handlers stop; their leases are left to expire.
  halt(): void {
    this.#halted = true
    this.#stopping = true
    this.#unlisten?.()
    this.#claims.wake()
    this.#ticks.wake()
    for (const r of this.#running.values()) {
      if (!r.controller.signal.aborted) r.controller.abort(new JobAborted('shutdown'))
    }
  }

  // For the integration tests' zombie worker: stops (or restarts) renewing leases while jobs run,
  // and checking them, as a process frozen past its lease would, so only the fences stop what it
  // commits when it wakes.
  pauseHeartbeats(paused = true): void {
    this.#heartbeatsPaused = paused
  }

  // --- Claims --------------------------------------------------------------------------------

  async #claimPasses(): Promise<void> {
    while (!this.#stopping) {
      let clean = true
      for (const orgId of this.#orgs()) {
        if (this.#stopping) break
        const free = this.#concurrency - this.#running.size
        if (free <= 0) break
        // Nothing is claimed for an org whose flags aren't confirmed (T15 item 11).
        if (!this.#flags.confirmed(orgId)) continue
        try {
          await this.#claim(orgId, free)
          this.#failures.delete(`claims:${orgId}`)
        } catch (error) {
          clean = false
          this.#loopFailed('claims', orgId, error)
        }
      }
      if (clean) this.#lastClaim = this.#now()
      if (!this.#stopping) await this.#claims.sleep(this.#policy.pollMs)
    }
  }

  async #claim(orgId: string, limit: number): Promise<void> {
    const kinds = [...this.#kinds.keys()]
    const started = this.#now()
    const claimed = await withOrg(this.#control, { orgId, system: true, as: 'hearth_queue' }, async trx => {
      const jobs = await claimJobs(trx, orgId, kinds, limit, this.#workerId, this.#policy.leaseMs)
      if (jobs.length === 0) return { jobs, runs: new Map<string, string>(), subjects: new Map<string, FlagSubject>() }
      const runIds = [...new Set(jobs.flatMap(job => (job.schedule_run_id === null ? [] : [job.schedule_run_id])))]
      const runs = new Map<string, string>()
      if (runIds.length > 0) {
        // The runs start; each one's policy for when it is cut short (a run already past queued
        // keeps its state).
        const { rows } = await sql<{ id: string; on_interrupt: string }>`
          with started as (
            update schedule_runs r set state = 'running', started_at = coalesce(r.started_at, now())
            where r.org_id = ${orgId} and r.id = any(${runIds}::uuid[]) and r.state = 'queued')
          select r.id, r.on_interrupt from schedule_runs r where r.org_id = ${orgId} and r.id = any(${runIds}::uuid[])`.execute(
          trx,
        )
        for (const row of rows) runs.set(row.id, row.on_interrupt)
      }
      const people = [...new Set(jobs.flatMap(job => (job.subject_id === null ? [] : [job.subject_id])))]
      const subjects = new Map<string, FlagSubject>()
      if (people.length > 0) {
        // Who each job is for, as the flags' cohorts see them: whether they're still at the org and
        // the org-wide roles they hold now, none once they have left (T17 item 3).
        const { rows } = await sql<{ id: string; active: boolean; roles: string[] }>`
          select p.id, p.deactivated_at is null as active,
                 coalesce(array_agg(r.role order by r.role) filter (where r.role is not null), '{}') as roles
          from people p
          left join role_assignments r on r.org_id = p.org_id and r.person_id = p.id and r.revoked_at is null
          where p.org_id = ${orgId} and p.id = any(${people}::uuid[])
          group by p.id, p.deactivated_at`.execute(trx)
        for (const row of rows) {
          const roles = row.active ? row.roles.filter(role => (COHORT_ROLES as readonly string[]).includes(role)) : []
          subjects.set(row.id, { personId: row.id, active: row.active, roles })
        }
      }
      return { jobs, runs, subjects }
    })
    for (const job of claimed.jobs) {
      const kind = this.#kinds.get(job.kind)
      // The claim names only the kinds this worker knows.
      if (kind === undefined) continue
      // A subject with no row in the org is no one at it, so no cohort holds them.
      const subject =
        job.subject_id === null
          ? null
          : (claimed.subjects.get(job.subject_id) ?? { personId: job.subject_id, active: false, roles: [] })
      const review = job.schedule_run_id !== null && claimed.runs.get(job.schedule_run_id) === 'review'
      this.#begin(orgId, job, kind, review, subject, started)
    }
  }

  #begin(
    orgId: string,
    row: ClaimedJob,
    kind: JobKind,
    review: boolean,
    subject: FlagSubject | null,
    claimedAt: number,
  ): void {
    const r: Running = {
      orgId,
      row,
      kind,
      review,
      subject,
      controller: new AbortController(),
      renewedAt: claimedAt,
      attempt: undefined,
      outcome: undefined,
      decision: undefined,
      applied: false,
      done: Promise.resolve(),
    }
    // Keyed by the claim's lease, not the job: a job whose lease ran out while its handler went on
    // (a zombie) can be claimed again by this same worker, and each attempt is its own.
    this.#running.set(row.lease_token, r)
    r.done = this.#runAttempt(r)
      .catch(error => this.#loopFailed('attempts', orgId, error))
      .finally(() => {
        this.#running.delete(row.lease_token)
        this.#claims.wake()
      })
  }

  // --- One attempt ---------------------------------------------------------------------------

  async #runAttempt(r: Running): Promise<void> {
    const { kind, row } = r
    // The kind's registry entry, never the row, decides the gate and the fence (T15 item 1).
    if (row.feature_key !== kind.feature || row.purpose !== kind.purpose) {
      await this.#decide(r, { type: 'dead', reason: 'job_mismatch', event: 'job_mismatch' })
      return
    }
    const payload = kind.payload.safeParse(row.payload)
    if (!payload.success) {
      await this.#decide(r, { type: 'dead', reason: 'payload_invalid', failure: failureFields(payload.error) })
      return
    }
    if (this.#stopping) {
      this.#abort(r, 'shutdown')
      await r.decision
      return
    }
    // A cache a moment behind Postgres mustn't bounce a job between the claim and the queue: a
    // refusal for its flags reloads them and decides again.
    let refusal = this.#refusal(r)
    if (refusal instanceof JobAborted && !r.controller.signal.aborted) {
      await this.#flags.reload(r.orgId)
      refusal = this.#refusal(r)
    }
    const seen = this.#flags.revisionsOf(r.orgId, kind.feature)
    if (refusal === undefined && seen === undefined) refusal = new JobAborted('unconfirmed')
    if (refusal !== undefined || seen === undefined) {
      if (refusal instanceof JobAborted) this.#abort(r, refusal.reason)
      else await this.#decide(r, this.#outcomeOfError(r, refusal))
      await r.decision
      return
    }
    const attempt = new JobAttempt<object>({
      db: this.#work,
      gate: this.#gate,
      flags: this.#flags,
      kind,
      job: {
        id: row.id,
        orgId: r.orgId,
        kind: row.kind,
        attempt: row.attempts,
        maxAttempts: row.max_attempts,
        subjectId: row.subject_id,
        payload: payload.data,
      },
      lease: row.lease_token,
      subject: r.subject,
      seen,
      signal: r.controller.signal,
      log: this.#logger.child({ job: row.id, kind: row.kind, org: r.orgId }),
      hooks: { abort: reason => this.#abort(r, reason), fenced: () => this.#fenced(r) },
    })
    r.attempt = attempt
    const timer = setTimeout(() => this.#abort(r, 'timeout'), kind.timeoutMs)
    try {
      await kind.run(attempt)
      // A handler that returns without its finishing commit is finished here, the gate first.
      if (!attempt.finished) await attempt.commit(async () => undefined, { finish: true })
      await this.#decide(r, { type: 'succeeded' })
    } catch (error) {
      if (attempt.finished) await this.#succeededAnyway(r)
      else if (error instanceof JobAborted) this.#abort(r, error.reason)
      else await this.#decide(r, this.#outcomeOfError(r, error))
    } finally {
      clearTimeout(timer)
    }
    await r.decision
    // A finishing commit that won a race with an abort: the job succeeded whatever was decided.
    if (attempt.finished) await this.#succeededAnyway(r)
  }

  // The gate's answer for the job before it runs.
  #refusal(r: Running): JobAborted | JobRefused | undefined {
    try {
      admit(
        this.#gate,
        this.#flags,
        r.kind,
        { orgId: r.orgId, subjectId: r.row.subject_id },
        r.subject,
        r.controller.signal,
      )
      return undefined
    } catch (error) {
      if (error instanceof JobAborted || error instanceof JobRefused) return error
      throw error
    }
  }

  // Aborts the job for this reason and decides its outcome, once; returns the abort. A job whose
  // finishing commit has committed has succeeded, so nothing aborts it after that: not a heartbeat
  // that renews no row (lease_lost, which it isn't), the watchdog, a flag change, its timeout or a
  // shutdown. What it does after that commit runs once at most (T15 item 3).
  #abort(r: Running, reason: AbortReason): JobAborted {
    if (r.attempt?.finished === true) return new JobAborted(reason)
    if (!r.controller.signal.aborted) {
      r.controller.abort(new JobAborted(reason))
      void this.#decide(r, this.#outcomeFor(r, reason))
    }
    const aborted = r.controller.signal.reason
    return aborted instanceof JobAborted ? aborted : new JobAborted(reason)
  }

  // A fence refused with HF001: the flags changed since the job was admitted. Off, or out of the
  // cohort, after a reload ends the job so; still on gives it back at once (T15 item 9).
  async #fenced(r: Running): Promise<JobAborted> {
    if (!r.controller.signal.aborted) {
      await this.#flags.reload(r.orgId)
      const verdict = this.#flags.verdict(r.orgId, r.kind.feature, r.subject)
      return this.#abort(r, verdict === 'on' ? 'flag_changed' : verdict === 'off' ? 'flag_off' : verdict)
    }
    return this.#abort(r, 'flag_changed')
  }

  #cancelsWhenOff(kind: JobKind): boolean {
    if (kind.onFlagOff !== undefined) return kind.onFlagOff === 'cancel'
    const spec = Object.hasOwn(this.#flags.registry, kind.feature) ? this.#flags.registry[kind.feature] : undefined
    return spec?.class !== 'essential'
  }

  #retryOrDead(r: Running, reason: string, failure?: FailureFields): Outcome {
    if (r.row.attempts >= r.row.max_attempts) return { type: 'dead', reason, ...(failure ? { failure } : {}) }
    const delayMs = backoffMs(r.row.attempts, r.kind.backoff, this.#random)
    return { type: 'retry', reason, delayMs, ...(failure ? { failure } : {}) }
  }

  // A review run's job never goes back to the queue on its own: what would requeue or give it back
  // cancels it, and what would retry it makes it dead; either way its run is interrupted.
  #forRun(r: Running, outcome: Outcome): Outcome {
    if (!r.review) return outcome
    if (outcome.type === 'requeue' || outcome.type === 'give_back') return { type: 'cancel', reason: outcome.reason }
    if (outcome.type === 'retry') {
      return { type: 'dead', reason: outcome.reason, ...(outcome.failure ? { failure: outcome.failure } : {}) }
    }
    return outcome
  }

  #outcomeFor(r: Running, reason: AbortReason): Outcome {
    switch (reason) {
      case 'lease_lost':
        return { type: 'lease_lost' }
      case 'shutdown':
      case 'unconfirmed':
        return this.#forRun(r, { type: 'give_back', reason })
      case 'timeout':
        return this.#forRun(r, this.#retryOrDead(r, 'timeout'))
      case 'flag_changed':
        return this.#forRun(r, { type: 'requeue', reason, delayMs: 0 })
      case 'not_in_cohort':
        return { type: 'cancel', reason }
      case 'flag_off':
        return this.#cancelsWhenOff(r.kind)
          ? { type: 'cancel', reason }
          : this.#forRun(r, { type: 'requeue', reason, delayMs: 0 })
    }
  }

  #outcomeOfError(r: Running, error: unknown): Outcome {
    if (error instanceof JobAborted) return this.#outcomeFor(r, error.reason)
    if (error instanceof JobRefused) {
      return error.reason === 'over_cap'
        ? this.#forRun(r, { type: 'requeue', reason: 'over_cap', delayMs: this.#policy.overCapDelayMs })
        : { type: 'cancel', reason: error.reason }
    }
    const failure = failureFields(error)
    if (error instanceof PermanentJobError) return { type: 'dead', reason: error.code, failure }
    // A constraint failure won't go away on a retry (T15 item 4).
    if (sqlstateOf(error)?.startsWith('23')) return { type: 'dead', reason: 'constraint_failed', failure }
    return this.#forRun(r, this.#retryOrDead(r, 'error', failure))
  }

  // --- Outcomes ------------------------------------------------------------------------------

  #decide(r: Running, outcome: Outcome): Promise<void> {
    r.decision ??= this.#apply(r, outcome)
    return r.decision
  }

  async #apply(r: Running, outcome: Outcome): Promise<void> {
    r.outcome = outcome
    if (this.#halted) return
    const line = { job: r.row.id, kind: r.row.kind, org: r.orgId, attempt: r.row.attempts }
    if (outcome.type === 'succeeded') {
      r.applied = true
      this.#logger.info({ event: 'job_succeeded', ...line }, 'a job succeeded')
      return
    }
    if (outcome.type === 'lease_lost') {
      this.#logger.warn({ event: 'job_lease_lost', ...line }, 'a job lost its lease; the lease sweep has it')
      return
    }
    let written: { state: string; reason: string | null } | undefined
    try {
      written = await this.#write(r, outcome)
    } catch (error) {
      // The lease runs out and the sweep takes the job.
      this.#loopFailed('outcomes', r.orgId, error)
      return
    }
    // No row: the sweep took the job, or it finished.
    if (written === undefined) return
    r.applied = true
    this.#logOutcome(r, outcome, written, line)
  }

  #logOutcome(
    r: Running,
    outcome: Exclude<Outcome, { type: 'succeeded' | 'lease_lost' }>,
    written: { state: string; reason: string | null },
    line: Record<string, unknown>,
  ): void {
    const reason = written.reason
    const failure = 'failure' in outcome && outcome.failure !== undefined ? { failure: outcome.failure } : {}
    if (written.state === 'dead') {
      this.#logger.error({ event: 'job_dead', ...line, reason, ...failure }, 'a job went dead')
      const named =
        reason === 'give_back_limit' ? 'job_give_back_limit' : outcome.type === 'dead' ? outcome.event : undefined
      for (const event of [named, r.kind.deadEvent]) {
        if (event !== undefined) this.#logger.error({ event, ...line, reason }, 'a job went dead')
      }
    } else if (written.state === 'cancelled') {
      this.#logger.info({ event: 'job_cancelled', ...line, reason }, 'a job was cancelled')
    } else if (outcome.type === 'retry') {
      this.#logger.warn({ event: 'job_retry', ...line, reason, retryInMs: outcome.delayMs, ...failure }, 'a job failed')
    } else {
      this.#logger.info({ event: 'job_requeued', ...line, reason }, 'a job went back to the queue')
    }
    if (r.review && written.state !== 'queued') {
      this.#logger.error(
        { event: 'schedule_run_interrupted', run: r.row.schedule_run_id, ...line, reason },
        'a review run was cut short and waits for a person',
      )
    }
  }

  async #succeededAnyway(r: Running): Promise<void> {
    if (r.outcome?.type === 'succeeded' || (r.decision !== undefined && r.applied)) return
    if (r.decision === undefined) {
      await this.#decide(r, { type: 'succeeded' })
      return
    }
    r.applied = true
    this.#logger.info(
      { event: 'job_succeeded', job: r.row.id, kind: r.row.kind, org: r.orgId, attempt: r.row.attempts },
      'a job succeeded',
    )
  }

  // The job's new state, only while it is still running under this worker's lease, and its run's
  // with it, in one transaction as hearth_queue.
  #write(r: Running, outcome: Exclude<Outcome, { type: 'succeeded' | 'lease_lost' }>) {
    const { orgId, row } = r
    return withOrg(this.#control, { orgId, system: true, as: 'hearth_queue' }, async trx => {
      const mine = sql`org_id = ${orgId} and id = ${row.id} and lease_token = ${row.lease_token} and state = 'running'`
      const released = sql`lease_token = null, lease_expires_at = null`
      let statement: RawBuilder<{ state: string; reason: string | null }>
      switch (outcome.type) {
        case 'cancel':
          statement = sql<{
            state: string
            reason: string | null
          }>`update jobs set state = 'cancelled', reason = ${outcome.reason}, finished_at = now(), ${released}
            where ${mine} returning state, reason`
          break
        case 'requeue':
          statement = sql<{
            state: string
            reason: string | null
          }>`update jobs set state = 'queued', attempts = attempts - 1, reason = ${outcome.reason},
              run_after = now() + ${outcome.delayMs}::float8 * interval '1 millisecond', ${released}
            where ${mine} returning state, reason`
          break
        case 'give_back': {
          const limit = this.#policy.giveBackLimit
          statement = sql<{ state: string; reason: string | null }>`update jobs set
              state = case when give_backs + 1 >= ${limit} then 'dead' else 'queued' end,
              reason = case when give_backs + 1 >= ${limit} then 'give_back_limit' else ${outcome.reason} end,
              finished_at = case when give_backs + 1 >= ${limit} then now() end,
              attempts = attempts - 1, give_backs = give_backs + 1, run_after = now(), ${released}
            where ${mine} returning state, reason`
          break
        }
        case 'retry':
          statement = sql<{
            state: string
            reason: string | null
          }>`update jobs set state = 'queued', reason = ${outcome.reason},
              run_after = now() + ${outcome.delayMs}::float8 * interval '1 millisecond', ${released}
            where ${mine} returning state, reason`
          break
        case 'dead':
          statement = sql<{
            state: string
            reason: string | null
          }>`update jobs set state = 'dead', reason = ${outcome.reason}, finished_at = now(), ${released}
            where ${mine} returning state, reason`
          break
      }
      const job = (await statement.execute(trx)).rows[0]
      if (job === undefined || row.schedule_run_id === null) return job
      const state =
        job.state === 'queued' ? 'queued' : r.review ? 'interrupted' : job.state === 'cancelled' ? 'skipped' : 'failed'
      await sql`update schedule_runs set state = ${state}, reason = ${job.reason},
          finished_at = case when ${state} = 'queued' then null else now() end
        where org_id = ${orgId} and id = ${row.schedule_run_id} and state = 'running'`.execute(trx)
      return job
    })
  }

  // --- Leases and flags ------------------------------------------------------------------------

  // Heartbeats run heartbeatMs apart, start to start, so a slow one doesn't push the next later. One
  // that fails for any org is tried again after a tenth of that, while the lease still has time.
  async #heartbeats(): Promise<void> {
    while (!this.#halted) {
      const began = this.#now()
      const clean = await this.#beat()
      if (this.#halted) break
      const wait = clean ? this.#policy.heartbeatMs - (this.#now() - began) : this.#policy.heartbeatMs / 10
      await this.#ticks.sleep(wait)
    }
  }

  // One statement per org renews every running job of this worker's there (T15 item 2). Answers
  // whether every org's statement succeeded.
  async #beat(): Promise<boolean> {
    let clean = true
    if (!this.#heartbeatsPaused) {
      const byOrg = new Map<string, Running[]>()
      for (const r of this.#running.values()) {
        if (r.decision !== undefined) continue
        byOrg.set(r.orgId, [...(byOrg.get(r.orgId) ?? []), r])
      }
      for (const [orgId, jobs] of byOrg) {
        if (this.#halted) return clean
        try {
          const started = this.#now()
          const renewed = await withOrg(this.#control, { orgId, system: true, as: 'hearth_queue' }, async trx => {
            // Bounded well inside the lease, so a heartbeat Postgres can't answer ends rather than
            // holding the loop while leases run out (the watchdog stops the jobs either way).
            await sql`set local statement_timeout = ${sql.lit(`${this.#heartbeatTimeoutMs()}ms`)}`.execute(trx)
            const { rows } = await sql<{ token: string }>`
              update jobs j set lease_expires_at = now() + ${this.#policy.leaseMs}::float8 * interval '1 millisecond'
              from unnest(${jobs.map(r => r.row.id)}::uuid[], ${jobs.map(r => r.row.lease_token)}::uuid[]) as t (id, token)
              where j.org_id = ${orgId} and j.id = t.id and j.lease_token = t.token and j.state = 'running'
              returning j.lease_token as token`.execute(trx)
            return new Set(rows.map(row => row.token))
          })
          this.#failures.delete(`heartbeats:${orgId}`)
          for (const r of jobs) {
            // Each attempt by its own lease (a zombie and the attempt that replaced it share a job).
            // A finishing commit in flight reports for itself (it may have succeeded already).
            if (renewed.has(r.row.lease_token)) r.renewedAt = Math.max(r.renewedAt, started)
            else if (r.decision === undefined && r.attempt?.finishing !== true) this.#abort(r, 'lease_lost')
          }
        } catch (error) {
          clean = false
          this.#loopFailed('heartbeats', orgId, error)
        }
      }
    }
    if (clean) this.#lastBeat = this.#now()
    return clean
  }

  // How long before a lease runs out the watchdog stops its job: half a heartbeat (5 s by default),
  // several watchdog ticks, which leaves the abort time to land before the sweep, every few
  // seconds, could requeue the job.
  #marginMs(): number {
    return this.#policy.heartbeatMs / 2
  }

  // A heartbeat statement's bound: a third of the lease, never more than the heartbeat interval,
  // and short enough that a heartbeat begun on time (heartbeatMs after the last that renewed a
  // lease) ends before the watchdog would stop that lease's job: 10 s by default, of the 15 s left.
  #heartbeatTimeoutMs(): number {
    const { heartbeatMs, leaseMs } = this.#policy
    const left = leaseMs - this.#marginMs() - heartbeatMs
    return Math.max(1, Math.floor(Math.min(heartbeatMs, leaseMs / 3, left)))
  }

  // Every watchdogMs (T15 item 2 and 11):
  //   - a job whose lease was last renewed by a statement begun more than leaseMs less the margin
  //     ago (25 s by default) may lose it soon, after which the sweep can hand it to another
  //     worker: it stops now (lease_lost), so two workers never run it at once, whatever made the
  //     renewals fail or hang. A finishing commit in flight reports for itself, and one that has
  //     committed is never aborted (JOBS-1);
  //   - a job whose org's flags have gone unconfirmed stops. A feature locked on stays on.
  async #watchdog(): Promise<void> {
    while (!this.#halted) {
      const lapsing = this.#policy.leaseMs - this.#marginMs()
      for (const r of this.#running.values()) {
        if (r.decision !== undefined) continue
        if (!this.#heartbeatsPaused && this.#now() - r.renewedAt > lapsing && r.attempt?.finishing !== true) {
          this.#abort(r, 'lease_lost')
        } else if (this.#flags.verdict(r.orgId, r.kind.feature, r.subject) === 'unconfirmed') {
          this.#abort(r, 'unconfirmed')
        }
      }
      await this.#ticks.sleep(this.#policy.watchdogMs)
    }
  }

  // A flag of the org changed: each of its running jobs is evaluated again for its person.
  #flagsChanged(orgId: string): void {
    for (const r of this.#running.values()) {
      if (r.orgId !== orgId || r.decision !== undefined) continue
      const verdict = this.#flags.verdict(orgId, r.kind.feature, r.subject)
      if (verdict === 'on') {
        const seen = this.#flags.revisionsOf(orgId, r.kind.feature)
        if (r.attempt !== undefined && seen !== undefined) r.attempt.seen = seen
      } else {
        this.#abort(r, verdict === 'off' ? 'flag_off' : verdict)
      }
    }
  }

  #loopFailed(loop: string, orgId: string, error: unknown): void {
    const key = `${loop}:${orgId}`
    const failures = (this.#failures.get(key) ?? 0) + 1
    this.#failures.set(key, failures)
    const line = { event: 'worker_loop_failed', loop, org: orgId, failures, failure: failureFields(error) }
    if (failures >= FAILURES_BEFORE_ERROR) this.#logger.error(line, 'a worker loop failed')
    else this.#logger.warn(line, 'a worker loop failed')
  }
}
