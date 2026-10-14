// What a job's handler works through (TECH-SPEC T15 items 3 and 10): its job, an AbortSignal, a
// logger, and transactions that pass the gate first and end with the fence. A JobContext runs its
// transactions one after another, so a job holds at most one connection of the work pool.
//
//   step(name)  the gate again before each step: throws JobAborted or JobRefused (synchronous).
//   read(work)  a read-only transaction as the kind's role, after the gate.
//   commit(work, { finish })
//               a transaction as the kind's role: the gate, the work, then the fence as its last
//               statement: job_fence() with the flag revisions the job was admitted under (and its
//               lease), or with finish, job_finish(), which also ends the job (and its schedule run)
//               in that transaction, so the effect and the job's end commit together, once. A
//               commit without finish is refused unless the kind declares idempotentCommits,
//               because a retry starts a job again from the top. A fence refused with HF001 (its
//               flags changed) or HF002 (its lease has gone) aborts the job.
//
// Effects outside Postgres (a Valkey publish) come after a commit and must be idempotent. The
// runner (runner.ts) decides what each abort means for the job; the handler need only stop.
import { sql } from 'kysely'
import type { Logger } from 'pino'
import { type Database, type InOrg, withOrg } from '#src/db/database.ts'
import { FEATURE_OFF, LEASE_LOST, sqlstateOf } from '#src/db/sqlstate.ts'
import type { FlagCache } from '#src/flags/cache.ts'
import type { FlagSubject } from '#src/flags/evaluate.ts'
import { JobAborted, PermanentJobError } from '#src/jobs/errors.ts'
import { admit, type Gate } from '#src/jobs/gate.ts'
import type { JobKind } from '#src/jobs/kinds.ts'

export { type AbortReason, JobAborted, JobRefused, PermanentJobError, type RefusalReason } from '#src/jobs/errors.ts'

export interface JobInfo<P> {
  id: string
  orgId: string
  kind: string
  // This attempt, counting from 1, and how many the job may have.
  attempt: number
  maxAttempts: number
  // The person the work is for, or null.
  subjectId: string | null
  payload: P
}

export interface JobContext<P> {
  readonly job: Readonly<JobInfo<P>>
  // Aborted when the job's feature stops being on for its person, its flags can't be confirmed,
  // its lease is lost, the worker stops, or the attempt times out. Its reason is the JobAborted.
  // Pass it to everything that takes one.
  readonly signal: AbortSignal
  readonly log: Logger
  step(name: string): void
  read<T>(work: (trx: InOrg) => Promise<T>): Promise<T>
  commit<T>(work: (trx: InOrg) => Promise<T>, options?: { finish?: boolean }): Promise<T>
}

// How an attempt reports to the runner, which decides and writes the job's outcome.
export interface AttemptHooks {
  // Aborts the job for this reason (once: a second call returns the first abort) and returns the
  // error to throw.
  abort(reason: JobAborted['reason']): JobAborted
  // A fence refused with HF001: the runner reloads the org's flags, decides whether the feature is
  // off, out of the cohort or only changed, aborts the job so, and returns the error to throw.
  fenced(): Promise<JobAborted>
}

export interface AttemptOptions<P extends object> {
  // The worker's work pool.
  db: Database
  gate: Gate
  flags: Pick<FlagCache, 'verdict' | 'registry'>
  kind: JobKind<P>
  job: JobInfo<P>
  lease: string
  subject: FlagSubject | null
  // The lineage's revisions the job was admitted under (FlagCache.revisionsOf).
  seen: readonly number[]
  signal: AbortSignal
  log: Logger
  hooks: AttemptHooks
}

// One attempt at a job, as its handler sees it.
export class JobAttempt<P extends object> implements JobContext<P> {
  readonly job: Readonly<JobInfo<P>>
  readonly signal: AbortSignal
  readonly log: Logger
  readonly lease: string
  readonly #db: Database
  readonly #gate: Gate
  readonly #flags: Pick<FlagCache, 'verdict' | 'registry'>
  readonly #kind: JobKind<P>
  readonly #subject: FlagSubject | null
  readonly #hooks: AttemptHooks
  #seen: readonly number[]
  #finished = false
  #finishing = false
  // The transaction before this one: each starts once the last has settled.
  #queue: Promise<unknown> = Promise.resolve()

  constructor(options: AttemptOptions<P>) {
    this.job = Object.freeze({ ...options.job })
    this.signal = options.signal
    this.log = options.log
    this.lease = options.lease
    this.#db = options.db
    this.#gate = options.gate
    this.#flags = options.flags
    this.#kind = options.kind
    this.#subject = options.subject
    this.#hooks = options.hooks
    this.#seen = options.seen
  }

  // The revisions the next fence compares. The runner moves them on when a flag changes but the
  // job's feature is still on for its person (T15 item 9).
  get seen(): readonly number[] {
    return this.#seen
  }
  set seen(revisions: readonly number[]) {
    this.#seen = revisions
  }

  // Whether job_finish() has committed: the job has succeeded.
  get finished(): boolean {
    return this.#finished
  }

  // Whether a finishing commit is in flight: a heartbeat that renews no row then leaves the job to
  // report for itself (T15 item 2).
  get finishing(): boolean {
    return this.#finishing
  }

  step(_name: string): void {
    this.#admit()
  }

  read<T>(work: (trx: InOrg) => Promise<T>): Promise<T> {
    return this.#serially(async () => {
      this.#admit()
      return withOrg(this.#db, this.#acting(), work, { readOnly: true })
    })
  }

  commit<T>(work: (trx: InOrg) => Promise<T>, options: { finish?: boolean } = {}): Promise<T> {
    const finish = options.finish === true
    return this.#serially(async () => {
      this.#admit()
      if (this.#finished) throw new PermanentJobError('commit_after_finish')
      if (!finish && this.#kind.idempotentCommits !== true) throw new PermanentJobError('commit_not_idempotent')
      const seen = [...this.#seen]
      this.#finishing = finish
      try {
        const result = await withOrg(this.#db, this.#acting(), async trx => {
          const value = await work(trx)
          // The last statement: nothing after it in the transaction.
          if (finish) {
            await sql`select public.job_finish(${this.job.id}::uuid, ${this.lease}::uuid, ${seen}::bigint[])`.execute(
              trx,
            )
          } else {
            await sql`select public.job_fence(${this.job.id}::uuid, ${this.lease}::uuid, ${seen}::bigint[])`.execute(
              trx,
            )
          }
          return value
        })
        if (finish) this.#finished = true
        return result
      } catch (error) {
        const state = sqlstateOf(error)
        if (state === FEATURE_OFF) throw await this.#hooks.fenced()
        if (state === LEASE_LOST) throw this.#hooks.abort('lease_lost')
        throw error
      } finally {
        this.#finishing = false
      }
    })
  }

  #acting() {
    return { orgId: this.job.orgId, system: true as const, as: this.#kind.role }
  }

  // The gate. A flag the gate finds off, out of the cohort or unconfirmed aborts the job at once,
  // through the runner, so its signal says so too; a refusal is thrown as it is.
  #admit(): void {
    try {
      admit(this.#gate, this.#flags, this.#kind, this.job, this.#subject, this.signal)
    } catch (error) {
      if (error instanceof JobAborted && !this.signal.aborted) throw this.#hooks.abort(error.reason)
      throw error
    }
  }

  #serially<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work)
    this.#queue = next.catch(() => {})
    return next
  }
}
