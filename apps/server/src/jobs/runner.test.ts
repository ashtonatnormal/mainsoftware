import { FLAGS, type FlagSpec } from '@hearth/shared'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { FlagVerdict } from '#src/flags/cache.ts'
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
const SYSTEM = 'c0000000-0000-4000-8000-000000000001'
const PERSON = 'b0000000-0000-4000-8000-000000000001'
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
    expect(flags.verdict).toHaveBeenCalledWith(ORG, 'it.optional', { personId: PERSON, roles: ['admin', 'dpo'] })
    expect(flags.verdict).toHaveBeenCalledWith(ORG, 'it.optional', { personId: SYSTEM, roles: [] })
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
