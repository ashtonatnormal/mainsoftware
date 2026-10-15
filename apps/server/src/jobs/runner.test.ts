import { FLAGS, type FlagSpec } from '@hearth/shared'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { FlagVerdict } from '#src/flags/cache.ts'
import { evaluate, type FlagState, type FlagSubject } from '#src/flags/evaluate.ts'
import type { JobContext } from '#src/jobs/context.ts'
import { JobRefused, PermanentJobError } from '#src/jobs/errors.ts'
import { C06_GATE, type Gate } from '#src/jobs/gate.ts'
import { defineJob, type JobKind } from '#src/jobs/kinds.ts'
import { JOB_POLICY } from '#src/jobs/policy.ts'
import { type ClaimedJob, JobRunner } from '#src/jobs/runner.ts'
import { captureLogger } from '#src/testing/logs.ts'
import { pgError, type Statement, scriptedPool } from '#src/testing/pool.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const OTHER_ORG = 'a0000000-0000-4000-8000-000000000002'
const THIRD_ORG = 'a0000000-0000-4000-8000-000000000003'
const SYSTEM = 'c0000000-0000-4000-8000-000000000001'
const PERSON = 'b0000000-0000-4000-8000-000000000001'
const OTHER = 'b0000000-0000-4000-8000-000000000002'
const RUN = 'f0000000-0000-4000-8000-000000000001'

const jobId = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const leaseOf = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function claimed(n: number, change: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: jobId(n),
    kind: 'it.work',
    feature_key: 'it.optional',
    purpose: 'service_operation',
    subject_id: null,
    payload: {},
    attempts: 1,
    max_attempts: 5,
    give_backs: 0,
    lease_token: leaseOf(n),
    schedule_run_id: null,
    ...change,
  }
}

const registry: Readonly<Record<string, FlagSpec>> = {
  ...FLAGS,
  'it.optional': { ...FLAGS['core.system'], class: 'optional', locked: false, purposes: ['service_operation'] },
  'it.essential': { ...FLAGS['core.system'], class: 'essential', locked: false, purposes: ['service_operation'] },
}

function fakeFlags() {
  const state = {
    verdict: 'on' as FlagVerdict,
    confirmed: (_orgId: string) => true,
    revisions: [1] as number[],
    // What a reload changes, before it resolves.
    onReload: () => {},
  }
  const listeners = new Set<(orgId: string, keys: readonly string[]) => void>()
  return {
    state,
    registry,
    verdict: vi.fn((_orgId: string, _key: string, _subject: unknown) => state.verdict),
    confirmed: vi.fn((orgId: string) => state.confirmed(orgId)),
    revisionsOf: vi.fn((_orgId: string, _key: string) => state.revisions as readonly number[]),
    reload: vi.fn(async (_orgId: string) => {
      state.onReload()
    }),
    onChange: (listener: (orgId: string, keys: readonly string[]) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    change: (orgId: string, keys: string[]) => {
      for (const listener of listeners) listener(orgId, keys)
    },
  }
}

interface Script {
  // Each claim's answer, in turn; then none.
  claims: ClaimedJob[][]
  runs?: Record<string, 'rerun' | 'review'>
  subjects?: { id: string; active: boolean; roles: string[] }[]
  // The ids each heartbeat renews (all by default), or its failure; or the leases it renews.
  renew?: (ids: string[]) => string[] | Error
  renewTokens?: (tokens: string[]) => string[]
  // What the job had given back before (for the give-back limit).
  giveBacks?: number
  // An outcome update that finds no row (the sweep took the job).
  lost?: boolean
  // A fence's answer.
  fence?: (statement: Statement) => Error | undefined
  // Holds a statement until the promise resolves.
  hold?: (statement: Statement) => Promise<void> | undefined
}

// The outcome an update makes, as Postgres would answer it.
function outcomeOf(statement: Statement, script: Script): unknown[] {
  if (script.lost) return []
  const { text, values } = statement
  if (text.includes("set state = 'cancelled'")) return [{ state: 'cancelled', reason: values[0] }]
  if (text.includes("set state = 'dead'")) return [{ state: 'dead', reason: values[0] }]
  if (text.includes('give_backs + 1 >=')) {
    const limit = Number(values[0])
    return (script.giveBacks ?? 0) + 1 >= limit
      ? [{ state: 'dead', reason: 'give_back_limit' }]
      : [{ state: 'queued', reason: values[2] }]
  }
  if (text.includes("set state = 'queued'")) return [{ state: 'queued', reason: values[0] }]
  return []
}

function pool(script: Script) {
  return scriptedPool(
    statement => {
      const { text, values } = statement
      if (text.includes("from principals where org_id = $1 and kind = 'system'")) return [{ id: SYSTEM }]
      if (text.startsWith('with next as')) return script.claims.shift() ?? []
      if (text.startsWith('with started as')) {
        const ids = values.find(Array.isArray) as string[]
        return ids.map(id => ({ id, on_interrupt: script.runs?.[id] ?? 'rerun' }))
      }
      if (text.startsWith('select p.id, p.deactivated_at is null as active')) return script.subjects ?? []
      if (text.startsWith('update jobs j set lease_expires_at')) {
        const [ids = [], tokens = []] = values.filter(Array.isArray) as string[][]
        if (script.renewTokens !== undefined) return script.renewTokens(tokens).map(token => ({ token }))
        const renewed = script.renew?.(ids) ?? ids
        return renewed instanceof Error ? renewed : renewed.map(id => ({ token: tokens[ids.indexOf(id)] }))
      }
      if (text.startsWith('update jobs set')) return outcomeOf(statement, script)
      if (text.startsWith('select public.job_finish') || text.startsWith('select public.job_fence')) {
        return script.fence?.(statement) ?? []
      }
      return []
    },
    statement => script.hold?.(statement) ?? Promise.resolve(),
  )
}

function kind(run: (ctx: JobContext<object>) => Promise<void>, change: Partial<JobKind> = {}): JobKind {
  return defineJob({
    kind: 'it.work',
    feature: 'it.optional',
    purpose: 'service_operation',
    role: 'hearth_job_offboarding',
    payload: z.strictObject({}),
    backoff: { baseMs: 1000, capMs: 8000 },
    run,
    ...change,
  })
}

const finishes = kind(async ctx => {
  await ctx.commit(async trx => sql`insert into it_job_effects (n) values (1)`.execute(trx), { finish: true })
})

// A handler that runs until it is let go, or until its signal aborts it (then it throws its reason).
function blocking() {
  const releases = new Map<string, () => void>()
  const run = kind(
    ctx =>
      new Promise<void>((resolve, reject) => {
        releases.set(ctx.job.id, resolve)
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason))
      }),
  )
  return { run, release: (n: number) => releases.get(jobId(n))?.() }
}

function start(
  script: Script,
  options: {
    kinds: JobKind[]
    concurrency?: number
    orgs?: string[]
    gate?: Gate
    flags?: ReturnType<typeof fakeFlags>
  },
) {
  const p = pool(script)
  const flags = options.flags ?? fakeFlags()
  const log = captureLogger()
  const runner = new JobRunner({
    control: p.db,
    work: p.db,
    kinds: new Map(options.kinds.map(k => [k.kind, k])),
    flags,
    gate: options.gate ?? C06_GATE,
    logger: log.logger,
    concurrency: options.concurrency ?? 4,
    workerId: 'it-worker',
    // The global performance, which the fake timers replace (node:perf_hooks' isn't).
    now: () => performance.now(),
    random: () => 0.5,
  })
  runner.start(() => options.orgs ?? [ORG])
  return { p, runner, flags, log }
}

// Moves fake time on in 10 ms steps until the check passes, for at most `ms` of it.
async function until(check: () => boolean, ms = 5000): Promise<void> {
  for (let waited = 0; !check(); waited += 10) {
    if (waited > ms) throw new Error('still not so after the fake time allowed')
    await vi.advanceTimersByTimeAsync(10)
  }
}

const updates = (p: ReturnType<typeof pool>) => p.statements.filter(s => s.text.startsWith('update jobs set'))
const runUpdates = (p: ReturnType<typeof pool>) =>
  p.statements.filter(s => s.text.startsWith('update schedule_runs set'))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('C0.6 T15 items 1 and 11 claims', () => {
  it('claims as hearth_queue for confirmed orgs only, up to the free slots, oldest first, with a lease and this worker’s id', async () => {
    const { run, release } = blocking()
    const flags = fakeFlags()
    flags.state.confirmed = orgId => orgId === ORG
    const { p, runner } = start(
      { claims: [[claimed(1), claimed(2)], [claimed(3)]] },
      { kinds: [run], concurrency: 2, orgs: [OTHER_ORG, ORG], flags },
    )
    await until(() => runner.active === 2)
    const claims = p.statements.filter(s => s.text.startsWith('with next as'))
    expect(claims).toHaveLength(1)
    expect(claims[0]?.values).toEqual([ORG, ['it.work'], 2, JOB_POLICY.leaseMs, 'it-worker'])
    expect(claims[0]?.text).toContain('for update skip locked')
    expect(claims[0]?.text).toContain('order by j.run_after, j.id')
    expect(claims[0]?.text).toContain('and not exists (select 1 from feature_flags f')
    expect(p.statements.filter(s => s.text.startsWith("select set_config('role'")).map(s => s.values[0])).toContain(
      'hearth_queue',
    )
    // Full: no claim while every slot is taken.
    await vi.advanceTimersByTimeAsync(2000)
    expect(p.statements.filter(s => s.text.startsWith('with next as'))).toHaveLength(1)
    // A slot frees: the next claim asks for one.
    release(1)
    await until(() => p.statements.filter(s => s.text.startsWith('with next as')).length === 2)
    expect(p.statements.filter(s => s.text.startsWith('with next as'))[1]?.values[2]).toBe(1)
    expect(runner.lastRound()).toBeDefined()
    runner.halt()
  })

  it('reads the job’s person once for the attempt: their roles while they are at the org, none once they have left', async () => {
    const seen: unknown[] = []
    const record = kind(async ctx => {
      seen.push(ctx.job.subjectId)
    })
    const flags = fakeFlags()
    const { runner } = start(
      {
        claims: [[claimed(1, { subject_id: PERSON }), claimed(2, { subject_id: SYSTEM })]],
        subjects: [
          { id: PERSON, active: true, roles: ['admin', 'dpo', 'team_admin'] },
          { id: SYSTEM, active: false, roles: ['owner'] },
        ],
      },
      { kinds: [record], flags },
    )
    await until(() => seen.length === 2)
    expect(flags.verdict).toHaveBeenCalledWith(ORG, 'it.optional', {
      personId: PERSON,
      active: true,
      roles: ['admin', 'dpo'],
    })
    expect(flags.verdict).toHaveBeenCalledWith(ORG, 'it.optional', { personId: SYSTEM, active: false, roles: [] })
    runner.halt()
  })

  it('R2E2E-2: a leaver named by id in a cohort is out of it from the next claim, and a subject with no row is no one at the org', async () => {
    const seen: unknown[] = []
    const record = kind(async ctx => {
      seen.push(ctx.job.subjectId)
    })
    const flags = fakeFlags()
    // The cache's verdict for one enabled flag whose cohort names both (cache.ts).
    const cohort: FlagState = {
      key: 'it.optional',
      enabled: true,
      locked: false,
      revision: 1,
      audience: 'cohort',
      cohort: { people: [PERSON, OTHER], roles: [] },
    }
    flags.verdict.mockImplementation((_orgId: string, key: string, subject: unknown) =>
      evaluate(new Map([[key, cohort]]), key, subject as FlagSubject | null) === 'on' ? 'on' : 'not_in_cohort',
    )
    const { p, runner } = start(
      {
        claims: [[claimed(1, { subject_id: PERSON }), claimed(2, { subject_id: OTHER })]],
        subjects: [{ id: PERSON, active: false, roles: [] }],
      },
      { kinds: [record], flags },
    )
    await until(() => updates(p).length === 2)
    expect(flags.verdict).toHaveBeenCalledWith(ORG, 'it.optional', { personId: PERSON, active: false, roles: [] })
    expect(flags.verdict).toHaveBeenCalledWith(ORG, 'it.optional', { personId: OTHER, active: false, roles: [] })
    for (const update of updates(p)) {
      expect(update.text).toContain("set state = 'cancelled'")
      expect(update.values[0]).toBe('not_in_cohort')
    }
    expect(seen).toEqual([])
    runner.halt()
  })
})

describe('C0.6 T15 item 2 heartbeats', () => {
  it('renews every running job of an org in one statement every 10 s, under each job’s own lease', async () => {
    const { run } = blocking()
    const { p, runner } = start({ claims: [[claimed(1), claimed(2)]] }, { kinds: [run] })
    await until(() => runner.active === 2)
    const beats = () => p.statements.filter(s => s.text.startsWith('update jobs j set lease_expires_at'))
    expect(beats()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(JOB_POLICY.heartbeatMs)
    expect(beats()).toHaveLength(1)
    expect(beats()[0]?.values).toEqual([JOB_POLICY.leaseMs, [jobId(1), jobId(2)], [leaseOf(1), leaseOf(2)], ORG])
    expect(beats()[0]?.text).toContain("j.lease_token = t.token and j.state = 'running'")
    await vi.advanceTimersByTimeAsync(JOB_POLICY.heartbeatMs)
    expect(beats()).toHaveLength(2)
    expect(runner.lastHeartbeat()).toBeDefined()
    runner.halt()
  })

  it('aborts a job whose lease wasn’t renewed (lease_lost, nothing written), and tries a failed heartbeat again', async () => {
    const { run } = blocking()
    let answer: (ids: string[]) => string[] | Error = () => new Error('Connection terminated unexpectedly')
    const { p, runner, log } = start(
      { claims: [[claimed(1), claimed(2)]], renew: ids => answer(ids) },
      { kinds: [run] },
    )
    await until(() => runner.active === 2)
    await vi.advanceTimersByTimeAsync(JOB_POLICY.heartbeatMs)
    // A failed heartbeat aborts nothing.
    expect(runner.active).toBe(2)
    expect(log.events('worker_loop_failed').map(line => line.loop)).toEqual(['heartbeats'])
    answer = ids => ids.filter(id => id === jobId(1))
    await vi.advanceTimersByTimeAsync(JOB_POLICY.heartbeatMs)
    await until(() => runner.active === 1)
    expect(log.events('job_lease_lost').map(line => line.job)).toEqual([jobId(2)])
    expect(updates(p)).toEqual([])
    runner.halt()
  })

  it('tells two attempts at one job apart by their leases: a zombie this worker still runs, and its replacement', async () => {
    const { run } = blocking()
    const { runner, log } = start(
      {
        claims: [[claimed(1)], [claimed(1, { lease_token: leaseOf(9), attempts: 2 })]],
        // The job's lease is now the replacement's.
        renewTokens: tokens => tokens.filter(token => token === leaseOf(9)),
      },
      { kinds: [run] },
    )
    await until(() => runner.active === 2)
    await vi.advanceTimersByTimeAsync(JOB_POLICY.heartbeatMs)
    await until(() => runner.active === 1)
    expect(log.events('job_lease_lost')).toEqual([expect.objectContaining({ job: jobId(1), attempt: 1 })])
    runner.halt()
  })

  it('leaves a job whose finishing commit is in flight to report for itself', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const finishing = kind(async ctx => {
      await ctx.commit(async () => held, { finish: true })
    })
    const { runner, log } = start({ claims: [[claimed(1)]], renew: () => [] }, { kinds: [finishing] })
    await until(() => runner.active === 1)
    await vi.advanceTimersByTimeAsync(JOB_POLICY.heartbeatMs)
    expect(log.events('job_lease_lost')).toEqual([])
    release()
    await until(() => runner.active === 0)
    expect(log.events('job_succeeded')).toHaveLength(1)
    runner.halt()
  })

  it('Qodo-18 #4: a job whose renewals keep failing is aborted (lease_lost) before its lease could run out', async () => {
    const { run } = blocking()
    const { p, runner, log } = start(
      { claims: [[claimed(1)]], renew: () => new Error('Connection terminated unexpectedly') },
      { kinds: [run] },
    )
    await until(() => runner.active === 1)
    const claimedAt = performance.now()
    // The heartbeats fail from 10 s on, each tried again a second later: the job runs on while a
    // retry could still renew its lease.
    const margin = JOB_POLICY.heartbeatMs / 2
    await vi.advanceTimersByTimeAsync(JOB_POLICY.leaseMs - margin - 50)
    expect(runner.active).toBe(1)
    const tries = p.statements.filter(s => s.text.startsWith('update jobs j set lease_expires_at')).length
    expect(tries).toBeGreaterThanOrEqual(10)
    // Within a watchdog tick of the lease less the margin since the claim (its last renewal), it
    // stops, well before the lease ends.
    await until(() => runner.active === 0, JOB_POLICY.watchdogMs + 100)
    expect(performance.now() - claimedAt).toBeLessThan(JOB_POLICY.leaseMs - margin / 2)
    expect(log.events('job_lease_lost').map(line => line.job)).toEqual([jobId(1)])
    // Nothing written: the sweep has it once the lease runs out.
    expect(updates(p)).toEqual([])
    // Each heartbeat is bounded well inside the lease.
    expect(p.texts()).toContain(`set local statement_timeout = '${JOB_POLICY.heartbeatMs}ms'`)
    runner.halt()
  })

  it('a job whose heartbeats all succeed but take 6 s each is never aborted for its lease', async () => {
    const { run, release } = blocking()
    const slow = (statement: Statement) =>
      statement.text.startsWith('update jobs j set lease_expires_at')
        ? new Promise<void>(resolve => setTimeout(resolve, 6000))
        : undefined
    const { p, runner, log } = start({ claims: [[claimed(1)]], hold: slow }, { kinds: [run] })
    await until(() => runner.active === 1)
    await vi.advanceTimersByTimeAsync(JOB_POLICY.leaseMs * 5)
    expect(runner.active).toBe(1)
    expect(log.events('job_lease_lost')).toEqual([])
    // They run 10 s apart, start to start, however long each takes.
    const beats = p.statements.filter(s => s.text.startsWith('update jobs j set lease_expires_at')).length
    expect(beats).toBeGreaterThanOrEqual(14)
    release(1)
    await until(() => runner.active === 0)
    expect(log.events('job_succeeded')).toHaveLength(1)
    runner.halt()
  })

  it('tries a failed heartbeat again within a second, so one failure that took 1.5 s costs no job', async () => {
    const { run, release } = blocking()
    let beats = 0
    const { p, runner, log } = start(
      {
        claims: [[claimed(1)]],
        // The second heartbeat fails, after 1.5 s; every other succeeds at once.
        hold: statement =>
          statement.text.startsWith('update jobs j set lease_expires_at') && ++beats === 2
            ? new Promise<void>(resolve => setTimeout(resolve, 1500))
            : undefined,
        renew: ids => (beats === 2 ? new Error('Connection terminated unexpectedly') : ids),
      },
      { kinds: [run] },
    )
    await until(() => runner.active === 1)
    // Heartbeats at 10 s (renewed) and 20 s (failed at 21.5 s).
    await vi.advanceTimersByTimeAsync(2 * JOB_POLICY.heartbeatMs + 1500 + 10)
    expect(log.events('worker_loop_failed').map(line => line.loop)).toEqual(['heartbeats'])
    // Tried again a tenth of a heartbeat later, not a whole one.
    await vi.advanceTimersByTimeAsync(JOB_POLICY.heartbeatMs / 10)
    expect(beats).toBe(3)
    await vi.advanceTimersByTimeAsync(JOB_POLICY.leaseMs * 3)
    expect(runner.active).toBe(1)
    expect(log.events('job_lease_lost')).toEqual([])
    expect(p.statements.some(s => s.text.startsWith('update jobs set'))).toBe(false)
    release(1)
    await until(() => runner.active === 0)
    runner.halt()
  })

  it('a heartbeat that fails at its 10 s bound, then a prompt retry that renews, costs no job', async () => {
    const { run, release } = blocking()
    let beats = 0
    // Its statement timeout and a little for the transaction around it.
    const timeout = JOB_POLICY.heartbeatMs + 200
    const { runner, log } = start(
      {
        claims: [[claimed(1)]],
        // The first heartbeat (at 10 s) runs to its statement timeout and fails just after 20 s from
        // the claim that last set the lease; every other succeeds at once.
        hold: statement =>
          statement.text.startsWith('update jobs j set lease_expires_at') && ++beats === 1
            ? new Promise<void>(resolve => setTimeout(resolve, timeout))
            : undefined,
        renew: ids => (beats === 1 ? pgError('57014') : ids),
      },
      { kinds: [run] },
    )
    await until(() => runner.active === 1)
    await vi.advanceTimersByTimeAsync(JOB_POLICY.heartbeatMs + timeout + JOB_POLICY.heartbeatMs / 10 + 10)
    expect(beats).toBe(2)
    await vi.advanceTimersByTimeAsync(JOB_POLICY.leaseMs * 3)
    expect(runner.active).toBe(1)
    expect(log.events('job_lease_lost')).toEqual([])
    release(1)
    await until(() => runner.active === 0)
    runner.halt()
  })

  it('Qodo-18 #4: a heartbeat that hangs leaves the watchdog to abort the job before its lease could run out', async () => {
    const { run } = blocking()
    const { runner, log } = start(
      {
        claims: [[claimed(1)]],
        hold: statement =>
          statement.text.startsWith('update jobs j set lease_expires_at') ? new Promise<void>(() => {}) : undefined,
      },
      { kinds: [run] },
    )
    await until(() => runner.active === 1)
    await vi.advanceTimersByTimeAsync(JOB_POLICY.leaseMs - JOB_POLICY.heartbeatMs / 2 - 50)
    expect(runner.active).toBe(1)
    await vi.advanceTimersByTimeAsync(JOB_POLICY.watchdogMs + 60)
    expect(runner.active).toBe(0)
    expect(log.events('job_lease_lost').map(line => line.job)).toEqual([jobId(1)])
    runner.halt()
  })

  it('Qodo-18 #4: a job whose renewals succeed is never aborted for its lease, however long it runs', async () => {
    const { run, release } = blocking()
    const { runner, log } = start({ claims: [[claimed(1)]] }, { kinds: [run] })
    await until(() => runner.active === 1)
    await vi.advanceTimersByTimeAsync(JOB_POLICY.leaseMs * 5)
    expect(runner.active).toBe(1)
    expect(log.events('job_lease_lost')).toEqual([])
    release(1)
    await until(() => runner.active === 0)
    expect(log.events('job_succeeded')).toHaveLength(1)
    runner.halt()
  })

  const isRenewal = (statement: Statement) => statement.text.startsWith('update jobs j set lease_expires_at')
  const renewals = (p: ReturnType<typeof pool>) => p.statements.filter(isRenewal)

  it('Qodo-18 round 3 #1: a claim that takes over 20 s renews its job’s lease before the job starts, so it isn’t aborted while renewals succeed', async () => {
    const { run, release } = blocking()
    let claims = 0
    // The first claim's transaction takes 20.5 s: its lease, from that transaction's now(), has
    // under 10 s left, and the heartbeat at 20 s has begun without the job.
    const { p, runner, log } = start(
      {
        claims: [[claimed(1)]],
        hold: statement =>
          statement.text.startsWith('with next as') && ++claims === 1
            ? new Promise<void>(resolve => setTimeout(resolve, 20_500))
            : undefined,
      },
      { kinds: [run] },
    )
    await until(() => runner.active === 1, 25_000)
    // Renewed once before it started, by the claim.
    expect(renewals(p)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(JOB_POLICY.leaseMs * 3)
    expect(runner.active).toBe(1)
    expect(log.events('job_lease_lost')).toEqual([])
    release(1)
    await until(() => runner.active === 0)
    expect(log.events('job_succeeded')).toHaveLength(1)
    runner.halt()
  })

  it('Qodo-18 round 3 #1: a slow claim whose renewal fails, or finds the lease gone, never starts the handler', async () => {
    for (const renew of [() => new Error('Connection terminated unexpectedly'), () => []]) {
      const ran = vi.fn(async () => {})
      let claims = 0
      const { p, runner, log } = start(
        {
          claims: [[claimed(1)]],
          renew,
          hold: statement =>
            statement.text.startsWith('with next as') && ++claims === 1
              ? new Promise<void>(resolve => setTimeout(resolve, 20_500))
              : undefined,
        },
        { kinds: [kind(ran)] },
      )
      await vi.advanceTimersByTimeAsync(20_500 + JOB_POLICY.leaseMs)
      expect(renewals(p).length).toBeGreaterThanOrEqual(1)
      expect(ran).not.toHaveBeenCalled()
      expect(runner.active).toBe(0)
      // Nothing written: the lease runs out and the sweep has the job.
      expect(updates(p)).toEqual([])
      const failed = renew() instanceof Error
      expect(log.events('worker_loop_failed').map(line => line.loop)).toEqual(failed ? ['claims'] : [])
      expect(log.events('job_lease_lost').map(line => line.job)).toEqual(failed ? [] : [jobId(1)])
      runner.halt()
    }
  })

  it('Qodo-18 round 4 #2: a slow claim’s jobs count from when its renewal began, not when it ended', async () => {
    const { run } = blocking()
    let claims = 0
    let beats = 0
    // The claim takes 20.5 s; the renewal before the job starts takes 9.9 s and renews it; every
    // heartbeat after fails. Its lease runs from 20.5 s, so the watchdog must stop it by 45.5 s and
    // a tick, not 25 s after the renewal ended (55.4 s, past the lease's end at 50.5 s).
    const { runner, log } = start(
      {
        claims: [[claimed(1)]],
        hold: statement =>
          statement.text.startsWith('with next as') && ++claims === 1
            ? new Promise<void>(resolve => setTimeout(resolve, 20_500))
            : isRenewal(statement) && ++beats === 1
              ? new Promise<void>(resolve => setTimeout(resolve, 9900))
              : undefined,
        renew: ids => (beats === 1 ? ids : new Error('Connection terminated unexpectedly')),
      },
      { kinds: [run] },
    )
    const began = performance.now()
    const renewalBegan = began + 20_500
    const margin = JOB_POLICY.heartbeatMs / 2
    await until(() => runner.active === 1, 35_000)
    await until(() => runner.active === 0, JOB_POLICY.leaseMs * 2)
    expect(log.events('job_lease_lost').map(line => line.job)).toEqual([jobId(1)])
    expect(performance.now()).toBeGreaterThan(renewalBegan + JOB_POLICY.leaseMs - margin)
    expect(performance.now()).toBeLessThan(renewalBegan + JOB_POLICY.leaseMs - margin / 2)
    runner.halt()
  })

  it('Qodo-18 round 4 #2: a claim under the slack counts its jobs from before its transaction began', async () => {
    const { run } = blocking()
    let claims = 0
    // The claim takes 4.9 s, inside the 5 s slack, so no renewal before the job starts; every
    // heartbeat fails. The lease runs from the claim's now(), no earlier than its start, so the
    // watchdog must stop the job by 25 s and a tick from then, not from when the claim ended.
    const { p, runner, log } = start(
      {
        claims: [[claimed(1)]],
        hold: statement =>
          statement.text.startsWith('with next as') && ++claims === 1
            ? new Promise<void>(resolve => setTimeout(resolve, 4900))
            : undefined,
        renew: () => new Error('Connection terminated unexpectedly'),
      },
      { kinds: [run] },
    )
    const began = performance.now()
    const margin = JOB_POLICY.heartbeatMs / 2
    await until(() => runner.active === 1, 10_000)
    // No renewal before it started.
    expect(renewals(p)).toHaveLength(0)
    await until(() => runner.active === 0, JOB_POLICY.leaseMs * 2)
    expect(log.events('job_lease_lost').map(line => line.job)).toEqual([jobId(1)])
    expect(performance.now()).toBeGreaterThan(began + JOB_POLICY.leaseMs - margin)
    expect(performance.now()).toBeLessThan(began + JOB_POLICY.leaseMs - margin / 2)
    runner.halt()
  })

  // Holds each renewal statement for as long as `ms` says (none: answered at once), counting how
  // many are in flight, in all and per org (the org is the statement's last value).
  function heldRenewals(ms: (orgId: string, n: number) => number | undefined) {
    const inFlight = new Map<string, number>()
    const seen = { most: 0, mostPerOrg: 0, started: [] as { org: string; at: number }[] }
    const total = () => [...inFlight.values()].reduce((a, b) => a + b, 0)
    const hold = (statement: Statement): Promise<void> | undefined => {
      if (!isRenewal(statement)) return undefined
      const org = String(statement.values.at(-1))
      seen.started.push({ org, at: performance.now() })
      const wait = ms(org, seen.started.filter(start => start.org === org).length)
      if (wait === undefined) return undefined
      inFlight.set(org, (inFlight.get(org) ?? 0) + 1)
      seen.most = Math.max(seen.most, total())
      seen.mostPerOrg = Math.max(seen.mostPerOrg, inFlight.get(org) ?? 0)
      return new Promise<void>(resolve =>
        setTimeout(() => {
          inFlight.set(org, (inFlight.get(org) ?? 1) - 1)
          resolve()
        }, wait),
      )
    }
    return { hold, seen }
  }

  it('Qodo-18 round 3 #2: renews two orgs’ leases at once, so two orgs whose renewals take 9 s each lose no job', async () => {
    const { run } = blocking()
    const held = heldRenewals(() => 9000)
    const { p, runner, log } = start(
      { claims: [[claimed(1)], [claimed(2)]], hold: held.hold },
      { kinds: [run], orgs: [ORG, OTHER_ORG] },
    )
    await until(() => runner.active === 2)
    await vi.advanceTimersByTimeAsync(JOB_POLICY.leaseMs * 5)
    expect(runner.active).toBe(2)
    expect(log.events('job_lease_lost')).toEqual([])
    // Both at once, each org's its own statement and transaction.
    expect(held.seen.most).toBe(2)
    const orgs = renewals(p).map(s => s.values.at(-1))
    expect(new Set(orgs)).toEqual(new Set([ORG, OTHER_ORG]))
    runner.halt()
  })

  it('Qodo-18 round 4 #1: an org whose renewal hangs for 31 s loses only its own jobs; another’s renew on time', async () => {
    const { run } = blocking()
    // ORG's first renewal hangs until the pool's query_timeout; OTHER_ORG's are answered at once.
    const held = heldRenewals((org, n) => (org === ORG && n === 1 ? 31_000 : undefined))
    const { runner, log } = start(
      { claims: [[claimed(1)], [claimed(2)]], hold: held.hold },
      { kinds: [run], orgs: [ORG, OTHER_ORG] },
    )
    await until(() => runner.active === 2)
    await vi.advanceTimersByTimeAsync(JOB_POLICY.leaseMs * 3)
    expect(log.events('job_lease_lost').map(line => line.job)).toEqual([jobId(1)])
    expect(runner.active).toBe(1)
    // OTHER_ORG's renewals kept their cadence while ORG's hung: 10 s apart, start to start.
    const others = held.seen.started.filter(start => start.org === OTHER_ORG).map(start => start.at)
    expect(others.length).toBeGreaterThanOrEqual(8)
    for (const [i, at] of others.entries()) {
      if (i > 0) expect(at - (others[i - 1] ?? 0)).toBeLessThanOrEqual(JOB_POLICY.heartbeatMs + 20)
    }
    runner.halt()
  })

  it('Qodo-18 round 4 #1: with six orgs’ renewals slow, never more than renewalsInFlight run at once, and never two for one org', async () => {
    const { run } = blocking()
    const orgs = [ORG, OTHER_ORG, THIRD_ORG, ...[4, 5, 6].map(n => `a0000000-0000-4000-8000-00000000000${n}`)]
    // Every renewal takes 15 s, longer than the interval.
    const held = heldRenewals(() => 15_000)
    const { runner } = start(
      { claims: orgs.map((_, i) => [claimed(i + 1)]), hold: held.hold },
      { kinds: [run], orgs, concurrency: orgs.length },
    )
    await until(() => runner.active === orgs.length)
    await vi.advanceTimersByTimeAsync(JOB_POLICY.leaseMs * 3)
    expect(held.seen.started.length).toBeGreaterThanOrEqual(JOB_POLICY.renewalsInFlight * 2)
    expect(held.seen.most).toBe(JOB_POLICY.renewalsInFlight)
    expect(held.seen.mostPerOrg).toBe(1)
    runner.halt()
  })

  it('Qodo-18 round 4 #1: an org whose renewal outlasts the interval isn’t renewed again until it ends, then at once', async () => {
    const { run } = blocking()
    // The first renewal (at 10 s) takes 15 s; every later one is answered at once.
    const held = heldRenewals((_, n) => (n === 1 ? 15_000 : undefined))
    const { runner, log } = start({ claims: [[claimed(1)]], hold: held.hold }, { kinds: [run] })
    await until(() => runner.active === 1)
    const claimedAt = performance.now()
    await vi.advanceTimersByTimeAsync(JOB_POLICY.heartbeatMs + 15_000 + 50)
    const starts = held.seen.started.map(start => start.at - claimedAt)
    expect(held.seen.mostPerOrg).toBe(1)
    // The second began when the first ended (25 s), not at 20 s beside it.
    expect(starts).toHaveLength(2)
    expect(starts[1]).toBeGreaterThanOrEqual(JOB_POLICY.heartbeatMs + 15_000 - 20)
    await vi.advanceTimersByTimeAsync(JOB_POLICY.leaseMs * 2)
    expect(runner.active).toBe(1)
    expect(log.events('job_lease_lost')).toEqual([])
    runner.halt()
  })

  it('Qodo-18 round 5 #1: a job that joins an org already renewing is renewed a heartbeat after its own lease was set, so a slow claim’s job isn’t lost', async () => {
    // The reviewer's probe. Job 1 runs from 0 s. Job 2's claim begins at 4.5 s and takes 6 s, so
    // its renewal before it starts runs from 10.5 s to 20.4 s, and it counts from 10.5 s. The
    // org's heartbeats take 6.5 s: in the first case every one, so the one begun at 20 s without
    // job 2 is still in flight when it starts; in the second only those from 20.2 s on, so none is.
    // On the org's own cadence its next would begin at 30 s and end at 36.5 s, after the watchdog
    // stops job 2 (25 s after 10.5 s); it must begin at 20.5 s, or once the one in flight ends.
    for (const renewalInFlight of [true, false]) {
      const { run } = blocking()
      const began = performance.now()
      const script: Script = { claims: [[claimed(1)]] }
      // When each renewal began, from the start, and which jobs it named.
      const renewalsBegun: { at: number; ids: string[] }[] = []
      let slowClaim = false
      script.hold = statement => {
        const at = performance.now() - began
        if (statement.text.startsWith('with next as') && at >= 4500 && !slowClaim) {
          slowClaim = true
          script.claims.push([claimed(2)])
          return new Promise<void>(resolve => setTimeout(resolve, 6000))
        }
        if (!isRenewal(statement)) return undefined
        const ids = statement.values[1] as string[]
        renewalsBegun.push({ at, ids })
        if (ids.join() === jobId(2)) return new Promise<void>(resolve => setTimeout(resolve, 9900))
        if (!renewalInFlight && at < 20_200) return undefined
        return new Promise<void>(resolve => setTimeout(resolve, 6500))
      }
      const { runner, log } = start(script, { kinds: [run] })
      await vi.advanceTimersByTimeAsync(JOB_POLICY.leaseMs * 3)
      expect(log.events('job_lease_lost')).toEqual([])
      expect(runner.active).toBe(2)
      // Renewed before it started, from 10.5 s; then its first heartbeat, with job 1's, began when
      // the one in flight ended (26.5 s), or at 20.5 s.
      expect(renewalsBegun.find(renewal => renewal.ids.length === 1 && renewal.ids[0] === jobId(2))?.at).toBe(10_500)
      expect(renewalsBegun.find(renewal => renewal.ids.length === 2)?.at).toBe(renewalInFlight ? 26_500 : 20_500)
      runner.halt()
    }
  })

  it('Qodo-18 round 5 #2: a new org’s first heartbeat is due 10 s after its job’s lease was set, and the job starting wakes the heartbeats for it', async () => {
    // A fresh org: the claim takes 10.2 s from 0 s, its renewal runs from 10.2 s to 20.1 s, and the
    // job, counting from 10.2 s, starts at 20.1 s, just after the idle heartbeat loop's round at
    // 20 s. Heartbeats take 6.5 s. Its first must begin at 20.2 s: one due 10 s after the job
    // started (30.1 s), or one the loop first sees at its next round (30 s), would end after the
    // watchdog stops the job (25 s after 10.2 s).
    const { run } = blocking()
    const began = performance.now()
    let claims = 0
    const renewalsBegun: { at: number; ids: string[] }[] = []
    const { runner, log } = start(
      {
        claims: [[claimed(1)]],
        hold: statement => {
          const at = performance.now() - began
          if (statement.text.startsWith('with next as') && ++claims === 1) {
            return new Promise<void>(resolve => setTimeout(resolve, 10_200))
          }
          if (!isRenewal(statement)) return undefined
          renewalsBegun.push({ at, ids: statement.values[1] as string[] })
          return new Promise<void>(resolve => setTimeout(resolve, renewalsBegun.length === 1 ? 9900 : 6500))
        },
      },
      { kinds: [run] },
    )
    await vi.advanceTimersByTimeAsync(JOB_POLICY.leaseMs * 3)
    expect(log.events('job_lease_lost')).toEqual([])
    expect(runner.active).toBe(1)
    expect(renewalsBegun.slice(0, 3).map(renewal => renewal.at)).toEqual([10_200, 20_200, 30_200])
    runner.halt()
  })

  it('Qodo-18 round 6: an org whose running jobs all ended counts its next heartbeat failures from the first', async () => {
    const { run, release } = blocking()
    const script: Script = { claims: [[claimed(1)]], renew: () => new Error('Connection terminated unexpectedly') }
    const { runner, log } = start(script, { kinds: [run] })
    await until(() => runner.active === 1)
    // Its renewal fails at 10 s, and again when tried a tenth of an interval later.
    await vi.advanceTimersByTimeAsync(JOB_POLICY.heartbeatMs + JOB_POLICY.heartbeatMs / 10)
    expect(log.events('worker_loop_failed').map(line => line.failures)).toEqual([1, 2])
    release(1)
    await until(() => runner.active === 0)
    // With no job left, the org's heartbeat ends.
    await vi.advanceTimersByTimeAsync(JOB_POLICY.heartbeatMs)
    script.claims.push([claimed(3)])
    await until(() => runner.active === 1)
    await vi.advanceTimersByTimeAsync(JOB_POLICY.heartbeatMs)
    const failed = log.events('worker_loop_failed')
    expect(failed.map(line => line.failures)).toEqual([1, 2, 1])
    expect(failed.at(-1)).toMatchObject({ level: 40 })
    runner.halt()
  })

  it('Qodo-18 round 5 #2: halt() and stop() leave no timer behind, the heartbeat loop’s included', async () => {
    for (const end of ['halt', 'stop'] as const) {
      const { run } = blocking()
      const { runner } = start({ claims: [[claimed(1)]] }, { kinds: [run] })
      await until(() => runner.active === 1)
      // Past a heartbeat, so the heartbeat loop sleeps until the org's next is due.
      await vi.advanceTimersByTimeAsync(JOB_POLICY.heartbeatMs + 100)
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      if (end === 'halt') {
        runner.halt()
        await vi.advanceTimersByTimeAsync(0)
      } else {
        // Well short of the org's next heartbeat (20 s), so only a wake ends that loop's sleep.
        const stopping = runner.stop(performance.now() + 5000)
        await vi.advanceTimersByTimeAsync(5000)
        await stopping
      }
      expect(runner.active).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  })

  it('Qodo-18 round 3 #3a: a renewal counts from when its statement began, not when it ended', async () => {
    const { run } = blocking()
    let beats = 0
    // The first heartbeat (at 10 s) renews, but takes 9.9 s; every later one fails. Its lease runs
    // from 10 s (the transaction's now()), so to 40 s, and the watchdog must stop the job by 35 s
    // and a tick, not 25 s after the heartbeat ended (past the lease's end).
    const { runner, log } = start(
      {
        claims: [[claimed(1)]],
        hold: statement =>
          isRenewal(statement) && ++beats === 1 ? new Promise<void>(resolve => setTimeout(resolve, 9900)) : undefined,
        renew: ids => (beats === 1 ? ids : new Error('Connection terminated unexpectedly')),
      },
      { kinds: [run] },
    )
    await until(() => runner.active === 1)
    const claimedAt = performance.now()
    const renewalBegan = claimedAt + JOB_POLICY.heartbeatMs
    const margin = JOB_POLICY.heartbeatMs / 2
    await until(() => runner.active === 0, JOB_POLICY.leaseMs * 2)
    expect(log.events('job_lease_lost').map(line => line.job)).toEqual([jobId(1)])
    expect(performance.now()).toBeGreaterThan(renewalBegan + JOB_POLICY.leaseMs - margin)
    expect(performance.now()).toBeLessThan(renewalBegan + JOB_POLICY.leaseMs - margin / 2)
    runner.halt()
  })

  it('Qodo-18 round 3 #3b: the watchdog leaves a job whose finishing commit is in flight to report for itself', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const finishing = kind(async ctx => {
      await ctx.commit(async () => held, { finish: true })
    })
    // Every heartbeat fails, so only the watchdog could abort it.
    const { runner, log } = start(
      { claims: [[claimed(1)]], renew: () => new Error('Connection terminated unexpectedly') },
      { kinds: [finishing] },
    )
    await until(() => runner.active === 1)
    await vi.advanceTimersByTimeAsync(JOB_POLICY.leaseMs * 2)
    expect(log.events('job_lease_lost')).toEqual([])
    release()
    await until(() => runner.active === 0)
    expect(log.events('job_succeeded')).toHaveLength(1)
    runner.halt()
  })

  it('JOBS-1: never aborts a job once its finishing commit has committed, whatever a heartbeat, the watchdog or a flag change says', async () => {
    let release: () => void = () => {}
    const effect = new Promise<void>(resolve => {
      release = resolve
    })
    let aborted: unknown
    let effectRan = false
    const after = kind(async ctx => {
      await ctx.commit(async () => undefined, { finish: true })
      // The effect after the finish (T15 item 3), cut short only if the signal aborts.
      ctx.signal.addEventListener('abort', () => {
        aborted = ctx.signal.reason
      })
      await effect
      effectRan = !ctx.signal.aborted
    })
    const flags = fakeFlags()
    // The job's row is succeeded now, so no heartbeat renews it.
    const { p, runner, log } = start({ claims: [[claimed(1)]], renew: () => [] }, { kinds: [after], flags })
    await until(() => p.statements.some(s => s.text.startsWith('select public.job_finish')))
    await vi.advanceTimersByTimeAsync(JOB_POLICY.heartbeatMs)
    flags.state.verdict = 'unconfirmed'
    await vi.advanceTimersByTimeAsync(JOB_POLICY.watchdogMs + 10)
    flags.state.verdict = 'off'
    flags.change(ORG, ['it.optional'])
    await vi.advanceTimersByTimeAsync(0)
    release()
    await until(() => runner.active === 0)
    expect(aborted).toBeUndefined()
    expect(effectRan).toBe(true)
    expect(log.events('job_lease_lost')).toEqual([])
    expect(log.events('job_succeeded')).toHaveLength(1)
    expect(updates(p)).toEqual([])
    runner.halt()
  })
})

describe('C0.6 T15 items 2 to 6, 9 and 12: the outcome of each attempt', () => {
  it('succeeded: the job_finish of its last effect ends it; a handler that returns without one is finished for it', async () => {
    const quiet = kind(async () => {}, { kind: 'it.quiet' })
    const { p, runner, log } = start(
      { claims: [[claimed(1), claimed(2, { kind: 'it.quiet' })]] },
      { kinds: [finishes, quiet] },
    )
    await until(() => log.events('job_succeeded').length === 2)
    const finishesOf = p.statements.filter(s => s.text.startsWith('select public.job_finish'))
    expect(finishesOf.map(s => s.values[0]).sort()).toEqual([jobId(1), jobId(2)])
    expect(updates(p)).toEqual([])
    runner.halt()
  })

  it('cancelled when an optional feature is off, or the cohort leaves the person out; queued uncounted when an essential one is off', async () => {
    const flags = fakeFlags()
    flags.state.verdict = 'off'
    const essential = kind(async () => {}, { kind: 'it.essential_work', feature: 'it.essential' })
    const { p, runner } = start(
      { claims: [[claimed(1), claimed(2, { kind: 'it.essential_work', feature_key: 'it.essential' })]] },
      { kinds: [finishes, essential], flags },
    )
    await until(() => updates(p).length === 2)
    const byJob = (n: number) => updates(p).find(s => s.values.includes(jobId(n)))
    expect(byJob(1)?.text).toContain("set state = 'cancelled', reason = $1, finished_at = now(), lease_token = null")
    expect(byJob(1)?.values.slice(0, 1)).toEqual(['flag_off'])
    expect(byJob(1)?.text).toContain("where org_id = $2 and id = $3 and lease_token = $4 and state = 'running'")
    expect(byJob(1)?.values.slice(1)).toEqual([ORG, jobId(1), leaseOf(1)])
    expect(byJob(2)?.text).toContain("set state = 'queued', attempts = attempts - 1, reason = $1")
    expect(byJob(2)?.values.slice(0, 2)).toEqual(['flag_off', 0])
    // The flags were reloaded before deciding (a cache a moment behind can't bounce a job).
    expect(flags.reload).toHaveBeenCalledWith(ORG)
    runner.halt()

    const cohort = fakeFlags()
    cohort.state.verdict = 'not_in_cohort'
    const second = start(
      { claims: [[claimed(3, { kind: 'it.essential_work', feature_key: 'it.essential' })]] },
      {
        kinds: [essential],
        flags: cohort,
      },
    )
    await until(() => updates(second.p).length === 1)
    expect(updates(second.p)[0]?.text).toContain("set state = 'cancelled'")
    expect(updates(second.p)[0]?.values[0]).toBe('not_in_cohort')
    second.runner.halt()
  })

  it('a fence refused with HF001 reloads the flags first: still on gives the job back at once, uncounted; off cancels it', async () => {
    const flags = fakeFlags()
    const order: string[] = []
    flags.state.onReload = () => order.push('reloaded')
    const { p, runner, log } = start(
      { claims: [[claimed(1)]], fence: () => pgError('HF001') },
      { kinds: [finishes], flags },
    )
    await until(() => updates(p).length === 1)
    expect(order).toEqual(['reloaded'])
    expect(updates(p)[0]?.text).toContain("set state = 'queued', attempts = attempts - 1")
    expect(updates(p)[0]?.values.slice(0, 2)).toEqual(['flag_changed', 0])
    expect(log.events('job_requeued').map(line => line.reason)).toEqual(['flag_changed'])
    runner.halt()

    const turnedOff = fakeFlags()
    turnedOff.state.onReload = () => {
      turnedOff.state.verdict = 'off'
    }
    const second = start(
      { claims: [[claimed(2)]], fence: () => pgError('HF001') },
      {
        kinds: [finishes],
        flags: turnedOff,
      },
    )
    await until(() => updates(second.p).length === 1)
    expect(updates(second.p)[0]?.values[0]).toBe('flag_off')
    expect(updates(second.p)[0]?.text).toContain("set state = 'cancelled'")
    second.runner.halt()
  })

  it('retried after a back-off for an error worth retrying or a timeout, the attempt counted; dead with none left', async () => {
    const failing = kind(async () => {
      throw new Error('Connection terminated unexpectedly')
    })
    const { p, runner, log } = start(
      { claims: [[claimed(1, { attempts: 2 }), claimed(2, { attempts: 5 })]] },
      {
        kinds: [failing],
      },
    )
    await until(() => updates(p).length === 2)
    const retry = updates(p).find(s => s.values.includes(jobId(1)))
    expect(retry?.text).toContain(
      "set state = 'queued', reason = $1, run_after = now() + $2::float8 * interval '1 millisecond'",
    )
    // Attempt 2 failed: 1 s doubled, the jitter at its middle.
    expect(retry?.values.slice(0, 2)).toEqual(['error', 2000])
    const dead = updates(p).find(s => s.values.includes(jobId(2)))
    expect(dead?.text).toContain("set state = 'dead', reason = $1, finished_at = now()")
    expect(dead?.values[0]).toBe('error')
    expect(log.events('job_retry')[0]).toMatchObject({ reason: 'error', retryInMs: 2000, failure: { error: 'Error' } })
    expect(log.events('job_dead')[0]).toMatchObject({ level: 50, reason: 'error', failure: { error: 'Error' } })
    // The failure's message is in no line (it can echo a value).
    expect(JSON.stringify(log.lines)).not.toContain('terminated')
    runner.halt()
  })

  it('a timeout aborts the attempt and retries it', async () => {
    const { run } = blocking()
    const slow = { ...run, timeoutMs: 3000 }
    const { p, runner } = start({ claims: [[claimed(1)]] }, { kinds: [slow] })
    await until(() => runner.active === 1)
    await vi.advanceTimersByTimeAsync(2900)
    expect(updates(p)).toEqual([])
    await until(() => updates(p).length === 1)
    expect(updates(p)[0]?.values.slice(0, 2)).toEqual(['timeout', 1000])
    runner.halt()
  })

  it('dead at once for a constraint failure, a PermanentJobError, a payload its kind refuses and a job that isn’t its kind’s', async () => {
    const constraint = kind(
      async () => {
        throw pgError('23505', 'jobs_idempotency')
      },
      { kind: 'it.constraint' },
    )
    const permanent = kind(
      async () => {
        throw new PermanentJobError('not_deactivated')
      },
      { kind: 'it.permanent' },
    )
    const strict = kind(async () => {}, { kind: 'it.strict', payload: z.strictObject({ person: z.uuid() }) })
    const ran: string[] = []
    const mismatched = kind(
      async ctx => {
        ran.push(ctx.job.id)
      },
      { kind: 'it.mismatched' },
    )
    const { p, runner, log } = start(
      {
        claims: [
          [
            claimed(1, { kind: 'it.constraint', attempts: 1 }),
            claimed(2, { kind: 'it.permanent' }),
            claimed(3, { kind: 'it.strict', payload: { person: 'Ann' } }),
            claimed(4, { kind: 'it.mismatched', feature_key: 'core.system' }),
          ],
        ],
      },
      { kinds: [constraint, permanent, strict, mismatched] },
    )
    await until(() => updates(p).length === 4)
    const reasons = Object.fromEntries(
      updates(p).map(s => [s.values.find(v => String(v).startsWith('d0000000')), s.values[0]]),
    )
    expect(reasons).toEqual({
      [jobId(1)]: 'constraint_failed',
      [jobId(2)]: 'not_deactivated',
      [jobId(3)]: 'payload_invalid',
      [jobId(4)]: 'job_mismatch',
    })
    for (const update of updates(p)) expect(update.text).toContain("set state = 'dead'")
    expect(ran).toEqual([])
    expect(log.events('job_mismatch')).toHaveLength(1)
    expect(log.events('job_dead')).toHaveLength(4)
    // The payload's value is in no line.
    expect(JSON.stringify(log.lines)).not.toContain('Ann')
    runner.halt()
  })

  it('cancelled when the gate refuses (purpose, provider, processing); an optional job over its cap waits 5 minutes, uncounted', async () => {
    const refusing = (reason: JobRefused['reason']) =>
      kind(
        async () => {
          throw new JobRefused(reason)
        },
        { kind: `it.${reason}` },
      )
    const { p, runner } = start(
      { claims: [[claimed(1, { kind: 'it.processing_not_allowed' }), claimed(2, { kind: 'it.over_cap' })]] },
      { kinds: [refusing('processing_not_allowed'), refusing('over_cap')] },
    )
    await until(() => updates(p).length === 2)
    const byJob = (n: number) => updates(p).find(s => s.values.includes(jobId(n)))
    expect(byJob(1)?.text).toContain("set state = 'cancelled'")
    expect(byJob(1)?.values[0]).toBe('processing_not_allowed')
    expect(byJob(2)?.text).toContain("set state = 'queued', attempts = attempts - 1")
    expect(byJob(2)?.values.slice(0, 2)).toEqual(['over_cap', JOB_POLICY.overCapDelayMs])
    runner.halt()
  })

  it('a refused gate before the run: the job never runs (a kind with an AI purpose, whatever its flag says)', async () => {
    const ran: string[] = []
    const ai = kind(
      async ctx => {
        ran.push(ctx.job.id)
      },
      { kind: 'it.ai_work', purpose: 'org_brain' },
    )
    const { p, runner } = start(
      { claims: [[claimed(1, { kind: 'it.ai_work', purpose: 'org_brain' })]] },
      {
        kinds: [ai],
      },
    )
    await until(() => updates(p).length === 1)
    expect(updates(p)[0]?.values[0]).toBe('purpose_refused')
    expect(ran).toEqual([])
    runner.halt()
  })

  it('C0.6 T15 item 6: flags unconfirmed give the job back uncounted, counted in give_backs, dead at the 20th', async () => {
    const flags = fakeFlags()
    const { run } = blocking()
    const { p, runner, log } = start({ claims: [[claimed(1)]], giveBacks: 19 }, { kinds: [run], flags })
    await until(() => runner.active === 1)
    flags.state.verdict = 'unconfirmed'
    await until(() => updates(p).length === 1)
    const giveBack = updates(p)[0]
    expect(giveBack?.text).toContain("state = case when give_backs + 1 >= $1 then 'dead' else 'queued' end")
    expect(giveBack?.text).toContain('attempts = attempts - 1, give_backs = give_backs + 1, run_after = now()')
    expect(giveBack?.values.slice(0, 4)).toEqual([20, 20, 'unconfirmed', 20])
    expect(log.events('job_give_back_limit')).toHaveLength(1)
    expect(log.events('job_dead')[0]).toMatchObject({ reason: 'give_back_limit', level: 50 })
    runner.halt()
  })

  it('writes nothing more when the sweep already took the job (no row), and logs no outcome', async () => {
    const failing = kind(async () => {
      throw new Error('boom')
    })
    const { p, runner, log } = start({ claims: [[claimed(1)]], lost: true }, { kinds: [failing] })
    await until(() => updates(p).length === 1)
    await until(() => runner.active === 0)
    expect(log.events('job_retry')).toEqual([])
    runner.halt()
  })
})

describe('C0.6 T15 item 15 a review run’s job is never given back or retried', () => {
  it('cancels instead of giving back, goes dead instead of retrying, and interrupts its run, logged at error', async () => {
    const failing = kind(async () => {
      throw new Error('boom')
    })
    const { run } = blocking()
    const both = [failing, { ...run, kind: 'it.blocks' }]
    const { p, runner, log } = start(
      {
        claims: [
          [
            claimed(1, { schedule_run_id: RUN, max_attempts: 1 }),
            claimed(2, { kind: 'it.blocks', schedule_run_id: jobId(9) }),
          ],
        ],
        runs: { [RUN]: 'review', [jobId(9)]: 'review' },
      },
      { kinds: both },
    )
    await until(() => updates(p).length === 1)
    await until(() => runner.active === 1)
    const stopping = runner.stop(performance.now() + 5000)
    await vi.advanceTimersByTimeAsync(5000)
    await stopping
    const byJob = (n: number) => updates(p).find(s => s.values.includes(jobId(n)))
    expect(byJob(1)?.text).toContain("set state = 'dead'")
    expect(byJob(2)?.text).toContain("set state = 'cancelled'")
    expect(byJob(2)?.values[0]).toBe('shutdown')
    expect(runUpdates(p).map(s => s.values.slice(0, 2))).toEqual([
      ['interrupted', 'error'],
      ['interrupted', 'shutdown'],
    ])
    expect(log.events('schedule_run_interrupted').map(line => line.reason)).toEqual(['error', 'shutdown'])
    expect(log.events('schedule_run_interrupted')[0]?.level).toBe(50)
  })

  it('a rerun run follows its job: queued again, skipped when cancelled, failed when dead', async () => {
    const failing = kind(async () => {
      throw new Error('boom')
    })
    const flags = fakeFlags()
    const { p, runner } = start(
      {
        claims: [[claimed(1, { schedule_run_id: RUN }), claimed(2, { schedule_run_id: jobId(8), attempts: 5 })]],
      },
      { kinds: [failing], flags },
    )
    await until(() => runUpdates(p).length === 2)
    const byRun = (id: string) => runUpdates(p).find(s => s.values.includes(id))
    expect(byRun(RUN)?.values.slice(0, 2)).toEqual(['queued', 'error'])
    expect(byRun(RUN)?.text).toContain("finished_at = case when $3 = 'queued' then null else now() end")
    expect(byRun(jobId(8))?.values.slice(0, 2)).toEqual(['failed', 'error'])
    expect(byRun(RUN)?.text).toContain("and state = 'running'")
    runner.halt()
  })
})

describe('C0.6 T15 item 9 flag changes reach running jobs', () => {
  it('aborts a running job no longer on for its person, and moves the revisions of one still on', async () => {
    const flags = fakeFlags()
    const seen: (readonly number[])[] = []
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const watching = kind(
      async ctx => {
        await held
        await ctx.commit(async () => {}, { finish: true })
      },
      { kind: 'it.watching' },
    )
    const { run } = blocking()
    const { p, runner } = start(
      { claims: [[claimed(1, { kind: 'it.watching' }), claimed(2)]] },
      { kinds: [watching, run], flags },
    )
    await until(() => runner.active === 2)
    // Still on: the revisions move on.
    flags.state.revisions = [2]
    flags.change(ORG, ['it.optional'])
    // Another org's change touches nothing here.
    flags.state.verdict = 'not_in_cohort'
    flags.change(OTHER_ORG, ['it.optional'])
    expect(runner.active).toBe(2)
    flags.state.verdict = 'on'
    release()
    await until(() => p.statements.some(s => s.text.startsWith('select public.job_finish')))
    seen.push(p.statements.find(s => s.text.startsWith('select public.job_finish'))?.values[2] as number[])
    expect(seen).toEqual([[2]])
    // Off for its person: job 2 is cancelled at once (its feature is optional).
    flags.state.verdict = 'not_in_cohort'
    flags.change(ORG, ['it.optional'])
    await until(() => updates(p).length === 1)
    expect(updates(p)[0]?.values[0]).toBe('not_in_cohort')
    runner.halt()
  })

  it('the watchdog aborts a job whose org’s flags have gone unconfirmed within a second', async () => {
    const flags = fakeFlags()
    const { run } = blocking()
    const { p, runner } = start({ claims: [[claimed(1)]] }, { kinds: [run], flags })
    await until(() => runner.active === 1)
    flags.state.verdict = 'unconfirmed'
    await vi.advanceTimersByTimeAsync(JOB_POLICY.watchdogMs + 10)
    await until(() => updates(p).length === 1)
    expect(updates(p)[0]?.values[2]).toBe('unconfirmed')
    runner.halt()
  })
})

describe('C0.6 T15 item 12 shutdown', () => {
  it('stops claiming, gives running jobs 3 s, aborts the rest (shutdown) and gives them back uncounted', async () => {
    const { run, release } = blocking()
    const deaf = kind(() => new Promise<void>(() => {}), { kind: 'it.deaf' })
    const { p, runner, log } = start(
      { claims: [[claimed(1), claimed(2), claimed(3, { kind: 'it.deaf' })]] },
      { kinds: [run, deaf] },
    )
    await until(() => runner.active === 3)
    const started = performance.now()
    const stopping = runner.stop(started + 5000)
    await vi.advanceTimersByTimeAsync(1000)
    release(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(updates(p)).toEqual([])
    await vi.advanceTimersByTimeAsync(JOB_POLICY.drainMs)
    await stopping
    // Job 1 finished in the drain; 2 and 3 were given back, the deaf one too, without waiting for it.
    expect(log.events('job_succeeded').map(line => line.job)).toEqual([jobId(1)])
    expect(
      updates(p)
        .map(s => s.values[2])
        .sort(),
    ).toEqual(['shutdown', 'shutdown'])
    expect(
      updates(p)
        .map(s => s.values.find(v => String(v).startsWith('d0000000')))
        .sort(),
    ).toEqual([jobId(2), jobId(3)])
    expect(performance.now() - started).toBeLessThanOrEqual(5000)
    const claims = p.statements.filter(s => s.text.startsWith('with next as')).length
    await vi.advanceTimersByTimeAsync(5000)
    expect(p.statements.filter(s => s.text.startsWith('with next as'))).toHaveLength(claims)
  })

  it('never runs past the hard deadline, even when a give-back hangs', async () => {
    const { run } = blocking()
    const hang = new Promise<void>(() => {})
    const script: Script = { claims: [[claimed(1)]] }
    const { runner } = start(script, { kinds: [run] })
    await until(() => runner.active === 1)
    script.hold = statement => (statement.text.includes('give_backs + 1') ? hang : undefined)
    const started = performance.now()
    let done = false
    void runner.stop(started + 5000).then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(JOB_POLICY.drainMs + JOB_POLICY.giveBackMs + 10)
    expect(done).toBe(true)
    expect(performance.now() - started).toBeLessThanOrEqual(5000)
  })

  it('gives back a job claimed while stopping without running it', async () => {
    const ran: string[] = []
    const record = kind(async ctx => {
      ran.push(ctx.job.id)
    })
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const script: Script = {
      claims: [[claimed(1)]],
      hold: statement => (statement.text.startsWith('with next as') ? held : undefined),
    }
    const { p, runner } = start(script, { kinds: [record] })
    await vi.advanceTimersByTimeAsync(10)
    const stopping = runner.stop(performance.now() + 5000)
    release()
    await vi.advanceTimersByTimeAsync(JOB_POLICY.drainMs + JOB_POLICY.giveBackMs)
    await stopping
    expect(ran).toEqual([])
    expect(updates(p)[0]?.values[2]).toBe('shutdown')
  })
})
