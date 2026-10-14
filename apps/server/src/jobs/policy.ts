// Every number of the queue, the scheduler and the worker's loops (TECH-SPEC T15, T18), in one
// place, so a change is a reviewed commit with its tests, as T14's are in auth/policy.ts. The clean-up's
// ages are not here: migration 0007 fixes them in purge_outbox(), purge_jobs() and
// purge_schedule_runs(), so no bug in the worker can delete a row early.

// The job runner (jobs/runner.ts).
export interface JobPolicy {
  // How long a claim lasts unless renewed (T15 item 2): another worker's lease sweep requeues a job
  // whose lease has run out.
  leaseMs: number
  // How often the runner renews the leases of its running jobs, one statement per org.
  heartbeatMs: number
  // How many orgs' renewals may be in flight at once, across all orgs, so the heartbeats never hold
  // more than this many of the control pool's connections (T18 item 8).
  renewalsInFlight: number
  // How often an idle runner looks for jobs to claim (T15 item 19).
  pollMs: number
  // How often each running job's org is checked for flags gone unconfirmed (T15 item 11).
  watchdogMs: number
  // At shutdown: how long running jobs get to finish, then how long the give-backs of the rest get
  // (T15 item 12).
  drainMs: number
  giveBackMs: number
  // A job given back this many times without counting an attempt (flags unconfirmed, a shutdown)
  // goes dead, so it can't cycle forever (T15 item 6).
  giveBackLimit: number
  // How long an optional job over its spend cap waits before it is tried again (A0 fills the cap).
  overCapDelayMs: number
}

export const JOB_POLICY: JobPolicy = {
  leaseMs: 30_000,
  heartbeatMs: 10_000,
  renewalsInFlight: 2,
  pollMs: 500,
  watchdogMs: 1000,
  drainMs: 3000,
  giveBackMs: 1000,
  giveBackLimit: 20,
  overCapDelayMs: 5 * 60_000,
}

// The scheduler (jobs/scheduler.ts).
export interface SchedulerPolicy {
  // How often it fires due schedules, sweeps expired leases, cancels off work and retires unknown
  // kinds, each org in turn, with ±10% jitter so workers drift apart.
  tickMs: number
  // At most this many schedules fired, and jobs swept or cancelled, per org and tick.
  fireBatch: number
  sweepBatch: number
  // A queued job of a kind no running version of the worker knows is made dead after this long
  // (T15 item 20).
  unknownKindMs: number
  // How often the registry's schedules are written to each org (also at start and for a new org).
  reconcileMs: number
}

export const SCHEDULER_POLICY: SchedulerPolicy = {
  tickMs: 5000,
  fireBatch: 20,
  sweepBatch: 100,
  unknownKindMs: 7 * 24 * 60 * 60_000,
  reconcileMs: 10 * 60_000,
}

// The worker as a whole (worker/index.ts).
export interface WorkerPolicy {
  jobs: JobPolicy
  scheduler: SchedulerPolicy
  // How often an idle outbox consumer reads again (T15 item 19).
  consumerPollMs: number
  // How often the outbox_lag and queue_depth lines are written (T16 item 19).
  metricsMs: number
  // How often the worker lists the orgs it serves (T18 item 2).
  orgsMs: number
  // SIGTERM's hard deadline: whatever is still in flight then is left to lease expiry (T15 item 12).
  stopMs: number
}

export const WORKER_POLICY: WorkerPolicy = {
  jobs: JOB_POLICY,
  scheduler: SCHEDULER_POLICY,
  consumerPollMs: 500,
  metricsMs: 30_000,
  orgsMs: 60_000,
  stopMs: 5000,
}

// What a job kind gets unless it says otherwise (T15 item 4).
export const DEFAULT_MAX_ATTEMPTS = 5
export const DEFAULT_BACKOFF = { baseMs: 5000, capMs: 10 * 60_000 } as const
export const DEFAULT_TIMEOUT_MS = 5 * 60_000
// Each back-off is moved by up to this share either way, so retries of many jobs spread out.
export const BACKOFF_JITTER = 0.2

export interface Backoff {
  baseMs: number
  capMs: number
}

// How long to wait before the next attempt, after attempt `attempt` (1 for the first) failed: the
// base doubling with each attempt up to the cap, then ±20%.
export function backoffMs(attempt: number, backoff: Backoff, random: () => number = Math.random): number {
  const doubled = backoff.baseMs * 2 ** Math.max(0, Math.min(attempt - 1, 30))
  const plain = Math.min(backoff.capMs, doubled)
  return Math.round(plain * (1 + BACKOFF_JITTER * (2 * random() - 1)))
}

// The scheduler's tick with its ±10% jitter.
export function jittered(ms: number, random: () => number = Math.random): number {
  return Math.round(ms * (0.9 + 0.2 * random()))
}
