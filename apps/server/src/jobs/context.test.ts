import { FLAGS } from '@hearth/shared'
import { sql } from 'kysely'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { FlagVerdict } from '#src/flags/cache.ts'
import { JobAttempt } from '#src/jobs/context.ts'
import { JobAborted, JobRefused, PermanentJobError } from '#src/jobs/errors.ts'
import { C06_GATE, type Gate } from '#src/jobs/gate.ts'
import { defineJob, type JobKind } from '#src/jobs/kinds.ts'
import { captureLogger } from '#src/testing/logs.ts'
import { pgError, type Statement, scriptedPool } from '#src/testing/pool.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const SYSTEM = 'c0000000-0000-4000-8000-000000000001'
const JOB = 'd0000000-0000-4000-8000-000000000001'
const LEASE = 'e0000000-0000-4000-8000-000000000001'
const PERSON = 'b0000000-0000-4000-8000-000000000001'

const registry = { ...FLAGS, 'it.optional': { ...FLAGS['core.system'], class: 'optional', locked: false } } as const

function kindWith(change: Partial<JobKind> = {}): JobKind {
  return defineJob({
    kind: 'it.work',
    feature: 'it.optional',
    purpose: 'service_operation',
    role: 'hearth_job_offboarding',
    payload: z.strictObject({}),
    run: async () => {},
    ...change,
  })
}

function setup(
  options: { answer?: (s: Statement) => unknown[] | Error; verdict?: FlagVerdict; kind?: JobKind; gate?: Gate } = {},
) {
  const p = scriptedPool(statement => {
    if (statement.text.includes("from principals where org_id = $1 and kind = 'system'")) return [{ id: SYSTEM }]
    return options.answer?.(statement) ?? []
  })
  const controller = new AbortController()
  const verdict = { value: options.verdict ?? 'on' }
  const hooks = {
    abort: vi.fn((reason: JobAborted['reason']) => {
      if (!controller.signal.aborted) controller.abort(new JobAborted(reason))
      return controller.signal.reason as JobAborted
    }),
    fenced: vi.fn(async () => {
      controller.abort(new JobAborted('flag_off'))
      return controller.signal.reason as JobAborted
    }),
  }
  const attempt = new JobAttempt({
    db: p.db,
    gate: options.gate ?? C06_GATE,
    flags: { verdict: () => verdict.value as FlagVerdict, registry },
    kind: options.kind ?? kindWith(),
    job: { id: JOB, orgId: ORG, kind: 'it.work', attempt: 1, maxAttempts: 5, subjectId: PERSON, payload: {} },
    lease: LEASE,
    subject: { personId: PERSON, active: true, roles: [] },
    seen: [3, 4],
    signal: controller.signal,
    log: captureLogger().logger,
    hooks,
  })
  return { p, attempt, controller, hooks, verdict }
}

// The statements the work made, without withOrg's own.
const work = (p: ReturnType<typeof scriptedPool>) =>
  p.texts().filter(text => !/^(select set_config|select id from principals)/.test(text))

describe('C0.6 T15 items 3 and 10 a job’s context: the gate first, the fence last', () => {
  it('commits as the kind’s role, with the work and then job_fence() with its lease and revisions as the last statement', async () => {
    const { p, attempt } = setup({ kind: kindWith({ idempotentCommits: true }) })
    const value = await attempt.commit(async trx => {
      await sql`insert into it_effects (n) values (1)`.execute(trx)
      return 'done'
    })
    expect(value).toBe('done')
    expect(work(p)).toEqual([
      'start transaction isolation level read committed',
      'insert into it_effects (n) values (1)',
      'select public.job_fence($1::uuid, $2::uuid, $3::bigint[])',
      'commit',
    ])
    expect(p.statements.find(s => s.text.startsWith('select public.job_fence'))?.values).toEqual([JOB, LEASE, [3, 4]])
    expect(p.statements.find(s => s.text.startsWith("select set_config('role'"))?.values[0]).toBe(
      'hearth_job_offboarding',
    )
    expect(attempt.finished).toBe(false)
  })

  it('finishes with job_finish() in the effect’s own transaction, and refuses any commit after it', async () => {
    const { p, attempt } = setup()
    await attempt.commit(async trx => sql`insert into it_effects (n) values (1)`.execute(trx), { finish: true })
    expect(work(p)).toEqual([
      'start transaction isolation level read committed',
      'insert into it_effects (n) values (1)',
      'select public.job_finish($1::uuid, $2::uuid, $3::bigint[])',
      'commit',
    ])
    expect(attempt.finished).toBe(true)
    await expect(attempt.commit(async () => {}, { finish: true })).rejects.toMatchObject({
      code: 'commit_after_finish',
    })
  })

  it('refuses a commit that doesn’t finish unless the kind declares idempotentCommits, before any SQL', async () => {
    const { p, attempt } = setup()
    const error = await attempt.commit(async () => 'nothing').catch(e => e)
    expect(error).toBeInstanceOf(PermanentJobError)
    expect(error.code).toBe('commit_not_idempotent')
    expect(p.statements).toEqual([])
  })

  it('reads in a read-only transaction as the kind’s role, after the gate, with no fence', async () => {
    const { p, attempt } = setup({ answer: s => (s.text === 'select 7 as n' ? [{ n: 7 }] : []) })
    const rows = await attempt.read(async trx => (await sql<{ n: number }>`select 7 as n`.execute(trx)).rows)
    expect(rows).toEqual([{ n: 7 }])
    expect(work(p)).toEqual(['start transaction isolation level read committed read only', 'select 7 as n', 'commit'])
  })

  it('checks the gate before each step, each read and each commit, and opens no transaction when it refuses', async () => {
    const { p, attempt, verdict, hooks } = setup()
    expect(() => attempt.step('one')).not.toThrow()
    verdict.value = 'off'
    // A flag the gate finds off aborts the job through the runner, so its signal says so too.
    expect(() => attempt.step('two')).toThrow(JobAborted)
    expect(hooks.abort).toHaveBeenCalledWith('flag_off')
    expect(attempt.signal.aborted).toBe(true)
    await expect(attempt.read(async () => 1)).rejects.toBeInstanceOf(JobAborted)
    await expect(attempt.commit(async () => 1, { finish: true })).rejects.toBeInstanceOf(JobAborted)
    expect(p.statements).toEqual([])
  })

  it('throws a refusal as it is: a kind that never calls step() still makes no effect, since commit() admits too', async () => {
    const { p, attempt, hooks } = setup({ gate: { ...C06_GATE, processingAllowed: () => false } })
    const error = await attempt
      .commit(async trx => sql`insert into it_effects (n) values (1)`.execute(trx), {
        finish: true,
      })
      .catch(e => e)
    expect(error).toBeInstanceOf(JobRefused)
    expect(error.reason).toBe('processing_not_allowed')
    expect(hooks.abort).not.toHaveBeenCalled()
    expect(p.statements).toEqual([])
  })

  it('turns HF001 into the runner’s decision after a reload, and HF002 into lease_lost; the transaction rolls back', async () => {
    const off = setup({ answer: s => (s.text.startsWith('select public.job_finish') ? pgError('HF001') : []) })
    await expect(off.attempt.commit(async () => {}, { finish: true })).rejects.toMatchObject({ reason: 'flag_off' })
    expect(off.hooks.fenced).toHaveBeenCalledTimes(1)
    expect(work(off.p).at(-1)).toBe('rollback')
    expect(off.attempt.finished).toBe(false)

    const lost = setup({ answer: s => (s.text.startsWith('select public.job_finish') ? pgError('HF002') : []) })
    await expect(lost.attempt.commit(async () => {}, { finish: true })).rejects.toMatchObject({ reason: 'lease_lost' })
    expect(lost.hooks.abort).toHaveBeenCalledWith('lease_lost')
    expect(work(lost.p).at(-1)).toBe('rollback')

    const other = setup({ answer: s => (s.text.startsWith('select public.job_finish') ? pgError('40P01') : []) })
    await expect(other.attempt.commit(async () => {}, { finish: true })).rejects.toMatchObject({ code: '40P01' })
    expect(other.hooks.abort).not.toHaveBeenCalled()
  })

  it('fences with the revisions it holds when the commit starts, which the runner moves on', async () => {
    const { p, attempt } = setup()
    attempt.seen = [3, 5]
    await attempt.commit(async () => {}, { finish: true })
    expect(p.statements.find(s => s.text.startsWith('select public.job_finish'))?.values[2]).toEqual([3, 5])
  })

  it('runs its transactions one at a time, so a job holds at most one connection', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const { attempt } = setup({ kind: kindWith({ idempotentCommits: true }) })
    const order: string[] = []
    const first = attempt.commit(async () => {
      order.push('first started')
      await held
      order.push('first ended')
    })
    const second = attempt.read(async () => {
      order.push('second started')
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(order).toEqual(['first started'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['first started', 'first ended', 'second started'])
  })

  it('exposes whether a finishing commit is in flight, for the heartbeat', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const { attempt } = setup()
    const finishing = attempt.commit(async () => held, { finish: true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(attempt.finishing).toBe(true)
    release()
    await finishing
    expect(attempt.finishing).toBe(false)
    expect(attempt.finished).toBe(true)
  })
})
