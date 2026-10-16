import { FLAGS, type FlagSpec } from '@hearth/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { FlagVerdict } from '#src/flags/cache.ts'
import { defineJob, type JobKind } from '#src/jobs/kinds.ts'
import { SCHEDULER_POLICY } from '#src/jobs/policy.ts'
import { cancelsWhenOff, canonical, type RetiredSchedule, type ScheduleDef, Scheduler } from '#src/jobs/scheduler.ts'
import { captureLogger } from '#src/testing/logs.ts'
import { type Statement, scriptedPool } from '#src/testing/pool.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const SYSTEM = 'c0000000-0000-4000-8000-000000000001'
const SCHEDULE = 'f0000000-0000-4000-8000-000000000001'
const JOB = 'd0000000-0000-4000-8000-000000000001'
const RUN = 'f1000000-0000-4000-8000-000000000001'
// The database's clock in these tests.
const DB_NOW = new Date('2026-10-14T03:17:20Z')

const registry: Readonly<Record<string, FlagSpec>> = {
  ...FLAGS,
  'it.optional': { ...FLAGS['core.system'], class: 'optional', locked: false, purposes: ['service_operation'] },
  'it.essential': { ...FLAGS['core.system'], class: 'essential', locked: false, purposes: ['service_operation'] },
}

const kind = (name: string, change: Partial<JobKind> = {}): JobKind =>
  defineJob({
    kind: name,
    feature: 'it.essential',
    purpose: 'service_operation',
    role: 'hearth_job_offboarding',
    payload: z.strictObject({}),
    backoff: { baseMs: 1000, capMs: 8000 },
    run: async () => {},
    ...change,
  })

const KINDS = [kind('it.daily'), kind('it.optional_work', { feature: 'it.optional' }), kind('it.review')]

interface Script {
  due?: unknown[]
  // The run insert finds one already there (another scheduler fired it).
  conflict?: boolean
  swept?: unknown[]
  existing?: unknown[]
  cancelled?: unknown[]
  unknown?: unknown[]
  runs?: { id: string; state: string }[]
}

function setup(
  script: Script = {},
  options: { verdict?: FlagVerdict; schedules?: (ScheduleDef | RetiredSchedule)[] } = {},
) {
  const p = scriptedPool((statement: Statement) => {
    const { text } = statement
    if (text.includes("from principals where org_id = $1 and kind = 'system'")) return [{ id: SYSTEM }]
    if (text === 'select now() as now') return [{ now: DB_NOW }]
    if (text.startsWith('insert into schedules')) return [{ key: statement.values[1] }]
    if (text.startsWith('select key, kind, cron, on_interrupt, payload from schedules')) return script.existing ?? []
    if (text.startsWith('update schedules set retired_at')) return [{ key: 'it.old' }]
    if (text.startsWith('select id, key, kind, cron, on_interrupt, payload, next_run_at, now() as now')) {
      return script.due ?? []
    }
    if (text.startsWith('insert into schedule_runs')) return script.conflict ? [] : [{ id: statement.values[0] }]
    if (text.startsWith('select j.id, j.kind, j.attempts, j.max_attempts, j.schedule_run_id, r.on_interrupt')) {
      return script.swept ?? []
    }
    if (text.startsWith('with off as')) return script.cancelled ?? []
    if (text.startsWith('with unknown as')) return script.unknown ?? []
    if (text.startsWith('update schedule_runs set state = case')) return script.runs ?? []
    return []
  })
  const log = captureLogger()
  const verdict = vi.fn((_orgId: string, _key: string, _subject: unknown) => options.verdict ?? ('on' as FlagVerdict))
  const scheduler = new Scheduler({
    db: p.db,
    schedules: options.schedules ?? [
      { key: 'it.daily', kind: 'it.daily', cron: '17 3 * * *', onInterrupt: 'rerun' },
      { key: 'it.review', kind: 'it.review', cron: '0 * * * *', onInterrupt: 'review' },
      { key: 'it.old', retired: true },
    ],
    kinds: new Map(KINDS.map(k => [k.kind, k])),
    flags: { verdict, registry },
    logger: log.logger,
    now: () => performance.now(),
    random: () => 0.5,
  })
  return { p, scheduler, log, verdict }
}

const due = (change: Record<string, unknown> = {}) => ({
  id: SCHEDULE,
  key: 'it.daily',
  kind: 'it.daily',
  cron: '17 3 * * *',
  on_interrupt: 'rerun',
  payload: {},
  next_run_at: new Date('2026-10-14T03:17:00Z'),
  now: DB_NOW,
  ...change,
})

const find = (p: ReturnType<typeof scriptedPool>, start: string) => p.statements.filter(s => s.text.startsWith(start))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('C0.6 T15 item 20 reconcile: insert and retire, never change a key', () => {
  it('adds each registry schedule with its next occurrence from the database’s clock, and retires listed keys', async () => {
    const { p, scheduler, log } = setup()
    expect(await scheduler.tick(ORG)).toBe(true)
    const inserts = find(p, 'insert into schedules')
    expect(inserts.map(s => s.values.slice(0, 5))).toEqual([
      [ORG, 'it.daily', 'it.daily', '17 3 * * *', 'rerun'],
      [ORG, 'it.review', 'it.review', '0 * * * *', 'review'],
    ])
    // The next occurrence after the database's 03:17:20.
    expect(inserts.map(s => (s.values[6] as Date).toISOString())).toEqual([
      '2026-10-15T03:17:00.000Z',
      '2026-10-14T04:00:00.000Z',
    ])
    expect(inserts[0]?.text).toContain('on conflict (org_id, key) do nothing')
    const retire = find(p, 'update schedules set retired_at')[0]
    expect(retire?.values).toEqual([ORG, ['it.old']])
    expect(retire?.text).toContain('and retired_at is null')
    // Nothing updates a key's kind, cron, payload or policy.
    expect(p.texts().some(t => /update schedules set (kind|cron|payload|on_interrupt)/.test(t))).toBe(false)
    expect(log.events('schedule_retired')).toHaveLength(1)
    // Reconcile again only after 10 minutes.
    await scheduler.tick(ORG)
    expect(find(p, 'insert into schedules')).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(SCHEDULER_POLICY.reconcileMs)
    await scheduler.tick(ORG)
    expect(find(p, 'insert into schedules')).toHaveLength(4)
  })

  it('logs once, and changes nothing, when a row differs from the registry (a change needs a new key)', async () => {
    const { p, scheduler, log } = setup({
      existing: [
        { key: 'it.daily', kind: 'it.daily', cron: '0 4 * * *', on_interrupt: 'rerun', payload: {} },
        { key: 'it.review', kind: 'it.review', cron: '0 * * * *', on_interrupt: 'review', payload: {} },
      ],
    })
    await scheduler.tick(ORG)
    expect(log.events('schedule_differs').map(line => line.schedule)).toEqual(['it.daily'])
    expect(p.texts().some(t => t.startsWith('update schedules set cron'))).toBe(false)
  })

  it('JOBS-4: compares payloads whatever order their keys are in, as Postgres reorders a jsonb object’s keys', async () => {
    const payload = { team: 'x', kind: 'y', nested: { zz: 1, a: [{ b: 2, a: 1 }] } }
    const { scheduler, log } = setup(
      {
        existing: [
          // As pg returns the row: jsonb's order, shortest key first.
          {
            key: 'it.daily',
            kind: 'it.daily',
            cron: '17 3 * * *',
            on_interrupt: 'rerun',
            payload: { kind: 'y', team: 'x', nested: { a: [{ a: 1, b: 2 }], zz: 1 } },
          },
          {
            key: 'it.other',
            kind: 'it.daily',
            cron: '17 3 * * *',
            on_interrupt: 'rerun',
            payload: { kind: 'y', team: 'z', nested: { a: [{ a: 1, b: 2 }], zz: 1 } },
          },
        ],
      },
      {
        schedules: [
          { key: 'it.daily', kind: 'it.daily', cron: '17 3 * * *', onInterrupt: 'rerun', payload },
          { key: 'it.other', kind: 'it.daily', cron: '17 3 * * *', onInterrupt: 'rerun', payload },
        ],
      },
    )
    await scheduler.tick(ORG)
    expect(log.events('schedule_differs').map(line => line.schedule)).toEqual(['it.other'])
    expect(canonical({ b: 1, a: [3, { d: null, c: 'x' }] })).toBe('{"a":[3,{"c":"x","d":null}],"b":1}')
  })
})

describe('C0.6 T15 item 13 firing: one run per occurrence, from the database’s clock', () => {
  it('fires a due schedule: its run for the occurrence, its job keyed by the run, and the next occurrence', async () => {
    const { p, scheduler, log } = setup({ due: [due()] })
    await scheduler.tick(ORG)
    const select = find(p, 'select id, key, kind, cron, on_interrupt, payload, next_run_at, now() as now')[0]
    expect(select?.text).toContain('for no key update skip locked')
    expect(select?.values).toEqual([ORG, ['it.daily', 'it.optional_work', 'it.review'], [], 20])
    const run = find(p, 'insert into schedule_runs')[0]
    expect(run?.values.slice(1)).toEqual([
      ORG,
      SCHEDULE,
      new Date('2026-10-14T03:17:00Z'),
      'rerun',
      'queued',
      null,
      null,
    ])
    expect(run?.text).toContain('on conflict do nothing returning id')
    const job = find(p, 'insert into jobs')[0]
    const runId = run?.values[0]
    expect(job?.text).toContain('schedule_run_id')
    // id, org, kind, feature, purpose, subject, payload, key, attempts, run_after, run.
    expect(job?.values.slice(1)).toEqual([
      ORG,
      'it.daily',
      'it.essential',
      'service_operation',
      null,
      '{}',
      `run:${runId}`,
      5,
      null,
      runId,
    ])
    const next = find(p, 'update schedules set next_run_at')[0]
    expect((next?.values[0] as Date | undefined)?.toISOString()).toBe('2026-10-15T03:17:00.000Z')
    expect(log.events('schedule_fired')).toHaveLength(1)
    expect(log.events('schedule_missed')).toEqual([])
  })

  it('queues no job when the run for the occurrence exists already (another scheduler fired it)', async () => {
    const { p, scheduler, log } = setup({ due: [due()], conflict: true })
    await scheduler.tick(ORG)
    expect(find(p, 'insert into jobs')).toEqual([])
    expect(find(p, 'update schedules set next_run_at')).toHaveLength(1)
    expect(log.events('schedule_fired')).toEqual([])
  })

  it('fires the latest occurrence once and counts the ones missed while no worker ran', async () => {
    const { p, scheduler, log } = setup({
      due: [due({ next_run_at: new Date('2026-10-11T03:17:00Z') })],
    })
    await scheduler.tick(ORG)
    expect(find(p, 'insert into schedule_runs')[0]?.values[3]).toEqual(new Date('2026-10-14T03:17:00Z'))
    expect(find(p, 'insert into jobs')).toHaveLength(1)
    expect(log.events('schedule_missed')[0]).toMatchObject({ missed: 3, atLeast: false })
  })

  it('a review schedule’s run gets one attempt; with its feature off the run is skipped and no job queued', async () => {
    const reviewDue = due({
      key: 'it.review',
      kind: 'it.review',
      cron: '0 * * * *',
      on_interrupt: 'review',
      next_run_at: new Date('2026-10-14T03:00:00Z'),
    })
    const on = setup({ due: [reviewDue] })
    await on.scheduler.tick(ORG)
    expect(find(on.p, 'insert into jobs')[0]?.values[8]).toBe(1)
    expect(on.verdict).toHaveBeenCalledWith(ORG, 'it.essential', null)

    const off = setup({ due: [reviewDue] }, { verdict: 'off' })
    await off.scheduler.tick(ORG)
    expect(find(off.p, 'insert into schedule_runs')[0]?.values.slice(5)).toEqual(['skipped', 'flag_off', DB_NOW])
    expect(find(off.p, 'insert into jobs')).toEqual([])
    expect(off.log.events('schedule_run_skipped')).toHaveLength(1)

    // Unconfirmed flags: it waits for the next tick, the schedule untouched.
    const unconfirmed = setup({ due: [reviewDue] }, { verdict: 'unconfirmed' })
    await unconfirmed.scheduler.tick(ORG)
    expect(find(unconfirmed.p, 'insert into schedule_runs')).toEqual([])
    expect(find(unconfirmed.p, 'update schedules set next_run_at')).toEqual([])
  })
})

describe('JOBS-2 a due schedule that can’t fire never holds up the others', () => {
  it('passes over a row whose payload its kind refuses, or whose cron never matches, logs it once and fires the rest', async () => {
    const BAD_PAYLOAD = 'f0000000-0000-4000-8000-000000000002'
    const NEVER = 'f0000000-0000-4000-8000-000000000003'
    const { p, scheduler, log } = setup({
      due: [
        due({ id: BAD_PAYLOAD, key: 'it.bad', payload: { extra: 1 } }),
        // 30 February: cron reads it, but it never comes.
        due({ id: NEVER, key: 'it.never', cron: '0 0 30 2 *' }),
        due({ key: 'it.purge', kind: 'it.optional_work' }),
      ],
    })
    expect(await scheduler.tick(ORG)).toBe(true)
    expect(find(p, 'insert into schedule_runs').map(s => s.values[2])).toEqual([SCHEDULE])
    expect(find(p, 'insert into jobs').map(s => s.values[2])).toEqual(['it.optional_work'])
    expect(find(p, 'update schedules set next_run_at').map(s => s.values[2])).toEqual([SCHEDULE])
    expect(log.events('schedule_unreadable')).toEqual([
      expect.objectContaining({ level: 50, schedule: 'it.bad' }),
      expect.objectContaining({ level: 50, schedule: 'it.never' }),
    ])
    expect(JSON.stringify(log.events('schedule_unreadable'))).not.toContain('extra')
    expect(log.events('worker_loop_failed')).toEqual([])
    // From then on they take no place in the batch, and aren't logged again.
    await scheduler.tick(ORG)
    expect(find(p, 'select id, key, kind, cron')[1]?.values[2]).toEqual([BAD_PAYLOAD, NEVER])
    expect(log.events('schedule_unreadable')).toHaveLength(2)
  })
})

describe('C0.6 T15 item 2 the lease sweep', () => {
  it('passes by jobs a finishing transaction holds (skip locked), requeues the rest with a back-off, the attempt counted', async () => {
    const { p, scheduler, log } = setup({
      swept: [{ id: JOB, kind: 'it.daily', attempts: 2, max_attempts: 5, schedule_run_id: RUN, on_interrupt: 'rerun' }],
    })
    await scheduler.tick(ORG)
    const select = find(p, 'select j.id, j.kind, j.attempts, j.max_attempts')[0]
    expect(select?.text).toContain("j.state = 'running' and j.lease_expires_at < now()")
    expect(select?.text).toContain('for no key update of j skip locked')
    const update = p.statements.find(s => s.text.startsWith('update jobs set state = $1'))
    expect(update?.values.slice(0, 4)).toEqual(['queued', false, 2000, false])
    expect(update?.text).toContain("reason = 'lease_expired'")
    expect(update?.text).toContain('lease_token = null, lease_expires_at = null')
    const run = p.statements.find(s => s.text.startsWith('update schedule_runs set state = $1, reason = $2'))
    expect(run?.values.slice(0, 3)).toEqual(['queued', 'lease_expired', 'queued'])
    expect(log.events('job_retry')[0]).toMatchObject({ reason: 'lease_expired', retryInMs: 2000 })
  })

  it('makes a job with no attempts left dead, and a review run’s job dead with its run interrupted (crash)', async () => {
    const { p, scheduler, log } = setup({
      swept: [
        { id: JOB, kind: 'it.daily', attempts: 5, max_attempts: 5, schedule_run_id: null, on_interrupt: null },
        { id: RUN, kind: 'it.review', attempts: 1, max_attempts: 1, schedule_run_id: SCHEDULE, on_interrupt: 'review' },
      ],
    })
    await scheduler.tick(ORG)
    const updates = p.statements.filter(s => s.text.startsWith('update jobs set state = $1'))
    expect(updates.map(s => s.values[0])).toEqual(['dead', 'dead'])
    const run = p.statements.find(s => s.text.startsWith('update schedule_runs set state = $1, reason = $2'))
    expect(run?.values.slice(0, 2)).toEqual(['interrupted', 'crash'])
    expect(log.events('job_dead')).toHaveLength(2)
    expect(log.events('schedule_run_interrupted')[0]).toMatchObject({ reason: 'crash', level: 50 })
  })
})

describe('C0.6 T15 items 9 and 20 cancelling off work, and kinds nobody knows', () => {
  it('cancels queued jobs of kinds that drop their work while off, and only those, with their runs', async () => {
    const { p, scheduler, log } = setup({
      cancelled: [{ id: JOB, kind: 'it.optional_work', schedule_run_id: RUN }],
      runs: [{ id: RUN, state: 'skipped' }],
    })
    await scheduler.tick(ORG)
    const cancel = find(p, 'with off as')[0]
    expect(cancel?.values.slice(0, 2)).toEqual([ORG, ['it.optional_work']])
    expect(cancel?.text).toContain('for no key update skip locked')
    expect(cancel?.text).toContain("set state = 'cancelled', reason = 'flag_off', finished_at = now()")
    const runs = find(p, 'update schedule_runs set state = case')[0]
    expect(runs?.text).toContain("case when on_interrupt = 'review' then 'interrupted' else $1 end")
    expect(runs?.values.slice(0, 2)).toEqual(['skipped', 'flag_off'])
    expect(log.events('job_cancelled')).toHaveLength(1)
    expect(cancelsWhenOff(KINDS[0] as JobKind, { registry })).toBe(false)
    expect(cancelsWhenOff(KINDS[1] as JobKind, { registry })).toBe(true)
    expect(cancelsWhenOff(kind('it.x', { onFlagOff: 'cancel' }), { registry })).toBe(true)
    expect(cancelsWhenOff(kind('it.y', { feature: 'it.optional', onFlagOff: 'requeue' }), { registry })).toBe(false)
  })

  it('makes queued jobs of a kind it doesn’t know dead after 7 days, at error level, with their runs', async () => {
    const { p, scheduler, log } = setup({
      unknown: [{ id: JOB, kind: 'it.gone', schedule_run_id: RUN }],
      runs: [{ id: RUN, state: 'interrupted' }],
    })
    await scheduler.tick(ORG)
    const unknown = find(p, 'with unknown as')[0]
    expect(unknown?.values.slice(0, 3)).toEqual([
      ORG,
      ['it.daily', 'it.optional_work', 'it.review'],
      SCHEDULER_POLICY.unknownKindMs,
    ])
    expect(unknown?.text).toContain('not (j.kind = any($2::text[]))')
    expect(unknown?.text).toContain("set state = 'dead', reason = 'kind_unknown'")
    expect(find(p, 'update schedule_runs set state = case')[0]?.values.slice(0, 2)).toEqual(['failed', 'kind_unknown'])
    expect(log.events('job_kind_unknown')[0]).toMatchObject({ level: 50, kind: 'it.gone' })
    expect(log.events('schedule_run_interrupted')).toHaveLength(1)
  })
})

describe('C0.6 T15 the scheduler’s loop', () => {
  it('ticks every org at once and then every 5 s ±10%, each step as hearth_queue, and records its last clean tick', async () => {
    const { p, scheduler } = setup()
    scheduler.start(() => [ORG])
    await vi.advanceTimersByTimeAsync(10)
    expect(find(p, 'select id, key, kind, cron')).toHaveLength(1)
    expect(scheduler.lastRound()).toBeDefined()
    await vi.advanceTimersByTimeAsync(SCHEDULER_POLICY.tickMs)
    expect(find(p, 'select id, key, kind, cron')).toHaveLength(2)
    expect(
      new Set(p.statements.filter(s => s.text.startsWith("select set_config('role'")).map(s => s.values[0])),
    ).toEqual(new Set(['hearth_queue']))
    const stopping = scheduler.stop(performance.now() + 1000)
    await vi.advanceTimersByTimeAsync(1000)
    await stopping
    await vi.advanceTimersByTimeAsync(SCHEDULER_POLICY.tickMs * 2)
    expect(find(p, 'select id, key, kind, cron')).toHaveLength(2)
  })

  it('logs a failing step, tries it again at the next tick, and goes on to the other steps', async () => {
    const { scheduler, log } = setup({ due: [due({ cron: '99 3 * * *' })] })
    expect(await scheduler.tick(ORG)).toBe(true)
    // A cron the evaluator can't read can't fire: logged once.
    expect(log.events('schedule_unreadable')).toHaveLength(1)
    await scheduler.tick(ORG)
    expect(log.events('schedule_unreadable')).toHaveLength(1)
  })
})
