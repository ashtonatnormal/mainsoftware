// The worker role (TECH-SPEC T15-T18): Hearth's job queue, scheduler and outbox consumers, in a
// process that serves no routes but /health and /ready. It logs in as hearth_worker on two pools
// (T18 item 8): a control pool for the loops (claims, heartbeats, outcomes, the scheduler, the flag
// poll, the org list, metrics), each holding at most one connection at a time but the flag reads
// (at most 3), the heartbeats (at most 2) and outcomes (one transaction per job, so up to
// WORKER_CONCURRENCY at once), and a work pool for handlers' transactions and consumer rounds, so
// neither can starve the other: heartbeats and the flag poll never wait behind work.
//
//   orgs       worker_org_ids(), at start and every 60 s (listOrgs); each org's flags are kept from
//              the moment it is listed.
//   flags      every listed org's flags, read as hearth_queue, polled every 2 s and reloaded at once
//              when the flags channel says one changed (T17).
//   runner     jobs/runner.ts; scheduler: jobs/scheduler.ts; consumers: outbox/consumers.ts.
//   metrics    every 30 s, per org: outbox_lag per consumer and queue_depth (outbox/lag.ts), until
//              C0.13 turns them into CloudWatch metrics.
//
// The org list is read first; every other loop then runs its first round at once. Readiness
// (/ready's `worker` check, T18 item 9) asks that every loop has finished a round without an error
// within three of its intervals (and never less than 5 s), that every listed org's flags are
// confirmed, that no outbox consumer is blocked in an org (behind the floor, or positions from the
// future), and that the worker isn't stopping; its error names what fails. stop() stops
// claiming, firing and consuming, gives running jobs 3 s to finish, aborts the rest (shutdown) and
// gives them back, all within a hard 5 s: whatever is still in flight then is left to lease expiry
// (T15 item 12).
import { performance } from 'node:perf_hooks'
import { FLAGS, type FlagSpec } from '@hearth/shared'
import type { Redis } from 'ioredis'
import type { Logger } from 'pino'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'
import { type Database, listOrgs } from '#src/db/database.ts'
import { failureFields } from '#src/db/sqlstate.ts'
import { FlagCache } from '#src/flags/cache.ts'
import { C06_GATE, type Gate } from '#src/jobs/gate.ts'
import { type Registries, validateRegistries } from '#src/jobs/kinds.ts'
import { MAINTENANCE_KINDS, SCHEDULES } from '#src/jobs/maintenance.ts'
import { WORKER_POLICY, type WorkerPolicy } from '#src/jobs/policy.ts'
import { JobRunner } from '#src/jobs/runner.ts'
import { Scheduler } from '#src/jobs/scheduler.ts'
import { Sleeper, settledBy } from '#src/jobs/sleeper.ts'
import { offboardingConsumer, offboardingJob, offboardingRegistry } from '#src/offboarding.ts'
import { ConsumerRunner } from '#src/outbox/consumers.ts'
import { logOutboxLag, logQueueDepth, readOutboxLag, readQueueDepth } from '#src/outbox/lag.ts'
import type { Subscriptions } from '#src/pubsub.ts'
import type { Check } from '#src/ready.ts'

// The control pool's size (T18 item 8): a connection for each loop, and 3 to spare when every flag
// read (3) and renewal (2) is stuck on a silent connection, which claims, outcomes (up to one per
// running job at once), the scheduler, the org list and metrics share, each waiting up to 2 s for one.
export const CONTROL_POOL_SIZE = 8

// The work pool's size: a connection for each job running at once, and one for each consumer.
export function workPoolSize(concurrency: number, registries: Pick<Registries, 'consumers'>): number {
  return concurrency + registries.consumers.length
}

// A loop counts as running if its last good round is within three of its intervals, and never
// less than this, so one slow round of a fast loop doesn't make the worker unready.
const READY_FLOOR_MS = 5000
// While the org list has never been read, it is tried again this often rather than every 60 s.
const ORGS_RETRY_MS = 1000
// A loop that has failed this many times in a row logs at error level.
const FAILURES_BEFORE_ERROR = 3

// What this version of the worker runs: Hearth's maintenance (partitions and the clean-up) and
// durable offboarding (its consumer and handler jobs).
export function productionRegistries(deps: {
  valkey: Pick<Redis, 'publish'>
  keyPrefix: string
  logger: Pick<Logger, 'warn' | 'error'>
}): Registries {
  const offboarding = offboardingRegistry(deps)
  const handler = offboardingJob(offboarding)
  return {
    kinds: [...MAINTENANCE_KINDS, handler],
    schedules: SCHEDULES,
    consumers: [offboardingConsumer(offboarding, handler)],
  }
}

export interface WorkerOptions {
  // Both logged in as hearth_worker (WORKER_DATABASE_URL).
  control: Database
  work: Database
  // The process's pub/sub channels: the worker listens on the flags channel.
  subscriptions: Pick<Subscriptions, 'add'>
  keyPrefix: string
  logger: Logger
  // How many jobs run at once (WORKER_CONCURRENCY).
  concurrency: number
  registries: Registries
  // The flags this process knows (FLAGS unless a test adds its own).
  flagRegistry?: Readonly<Record<string, FlagSpec>>
  gate?: Gate
  policy?: WorkerPolicy
  // The flag cache's poll and staleness, for tests.
  flags?: { pollMs?: number; staleMs?: number }
  workerId?: string
  // A monotonic clock (performance.now), for tests.
  now?: () => number
}

export interface Worker {
  readonly flags: FlagCache
  readonly runner: JobRunner
  readonly scheduler: Scheduler
  readonly consumers: ConsumerRunner
  // /ready's `worker` check.
  readonly check: Check
  // The orgs the worker serves now.
  orgs(): readonly string[]
  // Stops everything within the deadline (on the worker's clock; 5 s from now by default).
  stop(deadline?: number): Promise<void>
  // Stops every loop and timer at once, writing nothing more (a crash, for the integration tests).
  halt(): void
}

export function startWorker(options: WorkerOptions): Worker {
  const flagRegistry = options.flagRegistry ?? FLAGS
  validateRegistries(options.registries, flagRegistry)
  const policy = options.policy ?? WORKER_POLICY
  const now = options.now ?? (() => performance.now())
  const { control, work, logger } = options
  const gate = options.gate ?? C06_GATE

  const flags = new FlagCache({
    db: control,
    as: 'hearth_queue',
    registry: flagRegistry,
    logger,
    now,
    ...(options.flags?.pollMs === undefined ? {} : { pollMs: options.flags.pollMs }),
    ...(options.flags?.staleMs === undefined ? {} : { staleMs: options.flags.staleMs }),
  })
  void flags.listen(options.subscriptions, valkeyKeys(options.keyPrefix).flags)

  const kinds = new Map(options.registries.kinds.map(kind => [kind.kind, kind]))
  const runner = new JobRunner({
    control,
    work,
    kinds,
    flags,
    gate,
    logger,
    concurrency: options.concurrency,
    ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
    policy: policy.jobs,
    now,
  })
  const scheduler = new Scheduler({
    db: control,
    schedules: options.registries.schedules,
    kinds,
    flags,
    logger,
    policy: policy.scheduler,
    now,
  })
  const consumers = new ConsumerRunner({
    db: work,
    consumers: options.registries.consumers,
    flags,
    gate,
    logger,
    pollMs: policy.consumerPollMs,
    now,
  })

  let orgList: readonly string[] = []
  const orgs = () => orgList
  let lastOrgs: number | undefined
  let lastMetrics: number | undefined
  let stopping = false
  let halted = false
  let stopped: Promise<void> | undefined
  const sleeper = new Sleeper()
  const failures = new Map<string, number>()
  const loopFailed = (loop: string, error: unknown, org?: string) => {
    const key = `${loop}:${org ?? ''}`
    const count = (failures.get(key) ?? 0) + 1
    failures.set(key, count)
    const line = {
      event: 'worker_loop_failed',
      loop,
      ...(org ? { org } : {}),
      failures: count,
      failure: failureFields(error),
    }
    if (count >= FAILURES_BEFORE_ERROR) logger.error(line, 'a worker loop failed')
    else logger.warn(line, 'a worker loop failed')
  }

  // The other loops start once the org list has first been read, so their first rounds work in the
  // orgs at once rather than a whole interval later.
  const background: Promise<void>[] = []
  let started = false
  function startLoops(): void {
    if (started || stopping) return
    started = true
    runner.start(orgs)
    scheduler.start(orgs)
    consumers.start(orgs)
    background.push(metricsLoop())
  }

  async function orgLoop(): Promise<void> {
    while (!stopping) {
      try {
        const listed = await listOrgs(control)
        for (const org of listed) if (!orgList.includes(org)) void flags.track(org)
        // An org that has left the list is no longer polled (its running jobs then read its flags as
        // unconfirmed, and stop), and its consumers' blocks no longer count against readiness.
        for (const org of orgList) {
          if (listed.includes(org)) continue
          flags.untrack(org)
          consumers.forget(org)
        }
        orgList = listed
        lastOrgs = now()
        failures.delete('orgs:')
        startLoops()
      } catch (error) {
        loopFailed('orgs', error)
      }
      if (!stopping) await sleeper.sleep(lastOrgs === undefined ? ORGS_RETRY_MS : policy.orgsMs)
    }
  }

  async function metricsLoop(): Promise<void> {
    while (!stopping) {
      let clean = true
      for (const org of orgList) {
        if (stopping) break
        try {
          logOutboxLag(logger, await readOutboxLag(control, org), options.registries.consumers)
          logQueueDepth(logger, await readQueueDepth(control, org))
          failures.delete(`metrics:${org}`)
        } catch (error) {
          clean = false
          loopFailed('metrics', error, org)
        }
      }
      if (clean) lastMetrics = now()
      if (!stopping) await sleeper.sleep(policy.metricsMs)
    }
  }

  const loops = [
    { name: 'orgs', last: () => lastOrgs, intervalMs: policy.orgsMs },
    { name: 'claims', last: () => runner.lastRound(), intervalMs: policy.jobs.pollMs },
    { name: 'heartbeats', last: () => runner.lastHeartbeat(), intervalMs: policy.jobs.heartbeatMs },
    { name: 'scheduler', last: () => scheduler.lastRound(), intervalMs: policy.scheduler.tickMs * 1.1 },
    { name: 'consumers', last: () => consumers.lastRound(), intervalMs: policy.consumerPollMs },
    { name: 'metrics', last: () => lastMetrics, intervalMs: policy.metricsMs },
  ]
  const lagging = (): string[] =>
    loops
      .filter(loop => {
        const last = loop.last()
        return last === undefined || now() - last > Math.max(3 * loop.intervalMs, READY_FLOOR_MS)
      })
      .map(loop => loop.name)
  // Why the worker can't do its work now, beyond a loop that has stopped: an org whose flags it
  // hasn't confirmed (it claims nothing there, T15 item 11), and a consumer blocked in an org (it
  // can't move until a person acts, T16 items 6 and 18).
  const problems = (): string[] => {
    const late = lagging()
    const unconfirmed = orgList.filter(org => !flags.confirmed(org))
    const blocked = consumers.blocked()
    return [
      ...(late.length > 0 ? [`the worker's loops have not run lately: ${late.join(', ')}`] : []),
      ...(unconfirmed.length > 0
        ? [`the flags are unconfirmed for org${unconfirmed.length > 1 ? 's' : ''} ${unconfirmed.join(', ')}`]
        : []),
      ...blocked.map(block => `the outbox consumer ${block.consumer} is blocked in org ${block.org}: ${block.reason}`),
    ]
  }
  const check: Check = async () => {
    if (stopping) throw new Error('the worker is stopping')
    const found = problems()
    if (found.length > 0) throw new Error(found.join('; '))
  }

  // The org list first; each other loop then runs its first round at once (startLoops).
  background.push(orgLoop())
  logger.info(
    {
      event: 'worker_started',
      concurrency: options.concurrency,
      kinds: [...kinds.keys()],
      consumers: options.registries.consumers.map(consumer => consumer.name),
    },
    'the worker started',
  )
  // worker_ready once every loop has run a round and readiness finds nothing else wrong.
  const announce = setInterval(() => {
    if (stopping || problems().length > 0) return
    clearInterval(announce)
    logger.info({ event: 'worker_ready' }, 'the worker is ready')
  }, 100)
  announce.unref()

  return {
    flags,
    runner,
    scheduler,
    consumers,
    check,
    orgs,
    stop(deadline = now() + policy.stopMs) {
      // A halted worker has nothing left to stop.
      if (halted) return Promise.resolve()
      stopped ??= (async () => {
        stopping = true
        clearInterval(announce)
        sleeper.wake()
        logger.info({ event: 'worker_stopping' }, 'the worker is stopping')
        // Nothing new is fired or consumed; the runner stops claiming, drains and gives back.
        scheduler.halt()
        const quiet = Promise.all([consumers.stop(deadline), scheduler.stop(deadline), ...background])
        // A runner that never started (no org list yet) has nothing to drain.
        if (started) await runner.stop(deadline)
        else runner.halt()
        await settledBy(quiet, deadline, now)
        flags.stop()
      })()
      return stopped
    },
    halt() {
      if (halted) return
      halted = true
      stopping = true
      clearInterval(announce)
      sleeper.wake()
      runner.halt()
      scheduler.halt()
      void consumers.stop(now())
      flags.stop()
    },
  }
}
