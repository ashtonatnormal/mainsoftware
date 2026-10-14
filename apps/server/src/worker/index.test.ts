import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineJob } from '#src/jobs/kinds.ts'
import { WORKER_POLICY } from '#src/jobs/policy.ts'
import { captureLogger } from '#src/testing/logs.ts'
import { type Statement, scriptedPool } from '#src/testing/pool.ts'
import { CONTROL_POOL_SIZE, productionRegistries, startWorker, workPoolSize } from '#src/worker/index.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const OTHER_ORG = 'a0000000-0000-4000-8000-000000000002'
const SYSTEM = 'c0000000-0000-4000-8000-000000000001'

// A database with one org, its flags, and nothing to do. `state` changes what it answers: the
// orgs it lists, whether the flags read fails, whether the consumers' checkpoints are below the floor.
interface DatabaseState {
  orgs: string[]
  flagsFail: boolean
  behind: boolean
  // Behind in this org only.
  behindIn?: string
  // The consumers' rounds fail in this org.
  failIn?: string
}
function database(options: { orgsFail?: boolean } = {}, state: DatabaseState = defaultState()) {
  return scriptedPool((statement: Statement) => {
    const { text } = statement
    if (text.includes("from principals where org_id = $1 and kind = 'system'")) return [{ id: SYSTEM }]
    if (text.startsWith('select id from public.worker_org_ids()')) {
      return options.orgsFail ? new Error('Connection terminated unexpectedly') : state.orgs.map(id => ({ id }))
    }
    if (text.startsWith('select "key", "enabled"')) {
      if (state.flagsFail) return new Error('Connection terminated unexpectedly')
      return [
        {
          key: 'core.system',
          enabled: true,
          locked: true,
          audience: 'org',
          cohort_people: [],
          cohort_roles: [],
          revision: '1',
        },
      ]
    }
    if (text === 'select now() as now') return [{ now: new Date() }]
    if (text.startsWith('with held as')) return []
    if (text.startsWith('select count(*) filter'))
      return [{ queued: 0, running: 0, dead: 0, interrupted: 0, oldest_queued: null }]
    if (text.startsWith('select pg_try_advisory_xact_lock')) return [{ locked: true }]
    if (text.startsWith('select last_tx, last_id from outbox_checkpoints')) return [{ last_tx: '1', last_id: '1' }]
    if (text.startsWith('with f as')) {
      if (state.failIn !== undefined && statement.values.includes(state.failIn)) {
        return new Error('Connection terminated unexpectedly')
      }
      const behind = state.behind || (state.behindIn !== undefined && statement.values.includes(state.behindIn))
      return [{ floor_tx: null, floor_id: null, fell_behind: behind, id: null }]
    }
    if (text.startsWith('select greatest(')) return [{ future: false }]
    return []
  })
}

const registries = () =>
  productionRegistries({
    valkey: { publish: vi.fn(async () => 0) },
    keyPrefix: 'it:unit:',
    logger: { warn: vi.fn(), error: vi.fn() },
  })

const defaultState = (): DatabaseState => ({ orgs: [ORG], flagsFail: false, behind: false })

function start(options: { orgsFail?: boolean } = {}, state: DatabaseState = defaultState()) {
  const control = database(options, state)
  const work = database(options, state)
  const log = captureLogger()
  const subscriptions = { add: vi.fn(async () => {}) }
  const worker = startWorker({
    control: control.db,
    work: work.db,
    subscriptions,
    keyPrefix: 'it:unit:',
    logger: log.logger,
    concurrency: 2,
    registries: registries(),
    now: () => performance.now(),
  })
  return { worker, control, work, log, subscriptions }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('C0.6 T18 the worker role', () => {
  it('sizes its pools: 8 for the control loops, and a connection per job and per consumer for work', () => {
    expect(CONTROL_POOL_SIZE).toBe(8)
    expect(workPoolSize(4, registries())).toBe(5)
  })

  it('refuses to start with registries that break the rules', () => {
    const ai = defineJob({
      kind: 'it.ai',
      feature: 'ai.ask',
      purpose: 'org_brain',
      role: 'hearth_job_offboarding',
      payload: z.strictObject({}),
      run: async () => {},
    })
    const r = registries()
    expect(() =>
      startWorker({
        control: database().db,
        work: database().db,
        subscriptions: { add: vi.fn(async () => {}) },
        keyPrefix: 'it:unit:',
        logger: captureLogger().logger,
        concurrency: 1,
        registries: { ...r, kinds: [...r.kinds, ai] },
      }),
    ).toThrow(/until A0/)
  })

  it('lists its orgs, keeps their flags as hearth_queue, listens on the flags channel, and is ready once every loop has run', async () => {
    const { worker, control, log, subscriptions } = start()
    expect(subscriptions.add).toHaveBeenCalledWith('it:unit:flags', 'flags', expect.any(Function))
    await expect(worker.check(new AbortController().signal)).rejects.toThrow(/have not run lately/)
    await vi.advanceTimersByTimeAsync(300)
    await worker.check(new AbortController().signal)
    expect(worker.orgs()).toEqual([ORG])
    expect(worker.flags.confirmed(ORG)).toBe(true)
    // listOrgs names its role in the statement; withOrg passes it as a parameter.
    const roles = new Set(
      control.statements
        .filter(s => s.text.startsWith("select set_config('role'"))
        .map(s => s.values[0] ?? /set_config\('role', '([a-z_]+)'/.exec(s.text)?.[1]),
    )
    expect(roles).toEqual(new Set(['hearth_queue']))
    expect(log.events('worker_started')).toHaveLength(1)
    expect(log.events('worker_ready')).toHaveLength(1)
    // The metrics: a queue_depth line per org once the org list is read, then every 30 s.
    expect(log.events('queue_depth')).toEqual([expect.objectContaining({ org: ORG, queued: 0, dead: 0 })])
    await vi.advanceTimersByTimeAsync(WORKER_POLICY.metricsMs)
    expect(log.events('queue_depth')).toHaveLength(2)
    // Every loop's first round came after the org list: the scheduler wrote the org's schedules.
    expect(control.statements.filter(s => s.text.startsWith('insert into schedules')).map(s => s.values[1])).toEqual(
      expect.arrayContaining(['maintenance.data_access_partitions', 'maintenance.purge']),
    )
    const stopping = worker.stop()
    await vi.advanceTimersByTimeAsync(WORKER_POLICY.stopMs)
    await stopping
  })

  it('is not ready while a loop keeps failing, and says which', async () => {
    const { worker, log } = start({ orgsFail: true })
    await vi.advanceTimersByTimeAsync(5000)
    await expect(worker.check(new AbortController().signal)).rejects.toThrow(/orgs/)
    // Tried again every second while the list has never been read; at error from the third.
    const failures = log.events('worker_loop_failed').filter(line => line.loop === 'orgs')
    expect(failures.length).toBeGreaterThanOrEqual(4)
    expect(failures.map(line => line.level).slice(0, 3)).toEqual([40, 40, 50])
    worker.halt()
  })

  it('Qodo-18 #1: is not ready while an outbox consumer is blocked in an org, naming it, the org and why, and is again once it moves', async () => {
    const state = defaultState()
    state.behind = true
    const { worker, log } = start({}, state)
    await vi.advanceTimersByTimeAsync(WORKER_POLICY.consumerPollMs * 4)
    // The consumers' loop still runs (its rounds end without an error); readiness names the block.
    expect(worker.consumers.lastRound()).toBeDefined()
    await expect(worker.check(new AbortController().signal)).rejects.toThrow(
      `the outbox consumer offboarding is blocked in org ${ORG}: behind_floor`,
    )
    expect(log.events('outbox_consumer_fell_behind')).toHaveLength(1)
    // A reset or a rebuild: the next round reads, and the worker is ready.
    state.behind = false
    await vi.advanceTimersByTimeAsync(WORKER_POLICY.consumerPollMs * 2)
    await worker.check(new AbortController().signal)
    worker.halt()
  })

  it('Qodo-18 #2: is not ready while a listed org’s flags are unconfirmed, naming the org', async () => {
    const state = defaultState()
    const { worker } = start({}, state)
    await vi.advanceTimersByTimeAsync(300)
    await worker.check(new AbortController().signal)
    state.flagsFail = true
    // 8 s without a good read: unconfirmed.
    await vi.advanceTimersByTimeAsync(9000)
    expect(worker.flags.confirmed(ORG)).toBe(false)
    await expect(worker.check(new AbortController().signal)).rejects.toThrow(`the flags are unconfirmed for org ${ORG}`)
    state.flagsFail = false
    await vi.advanceTimersByTimeAsync(3000)
    await worker.check(new AbortController().signal)
    worker.halt()
  })

  it('Qodo-18 #6: stops polling the flags of an org that leaves its org list', async () => {
    const state = defaultState()
    state.orgs = [ORG, OTHER_ORG]
    const { worker, control } = start({}, state)
    await vi.advanceTimersByTimeAsync(300)
    expect(worker.flags.confirmed(OTHER_ORG)).toBe(true)
    state.orgs = [ORG]
    await vi.advanceTimersByTimeAsync(WORKER_POLICY.orgsMs)
    expect(worker.orgs()).toEqual([ORG])
    expect(worker.flags.confirmed(OTHER_ORG)).toBe(false)
    const reads = (org: string) =>
      control.statements.filter(s => s.text.startsWith('select "key", "enabled"') && s.values.includes(org)).length
    const before = reads(OTHER_ORG)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(reads(OTHER_ORG)).toBe(before)
    expect(reads(ORG)).toBeGreaterThan(0)
    // Ready, though the org it dropped is unconfirmed now.
    await worker.check(new AbortController().signal)
    worker.halt()
  })

  it('forgets a blocked consumer’s org once the org leaves its org list, is ready again, and doesn’t report the old block if the org comes back', async () => {
    const state = defaultState()
    state.orgs = [ORG, OTHER_ORG]
    state.behindIn = OTHER_ORG
    const { worker } = start({}, state)
    await vi.advanceTimersByTimeAsync(WORKER_POLICY.consumerPollMs * 4)
    await expect(worker.check(new AbortController().signal)).rejects.toThrow(
      `the outbox consumer offboarding is blocked in org ${OTHER_ORG}: behind_floor`,
    )
    state.orgs = [ORG]
    await vi.advanceTimersByTimeAsync(WORKER_POLICY.orgsMs)
    expect(worker.orgs()).toEqual([ORG])
    expect(worker.consumers.blocked()).toEqual([])
    await worker.check(new AbortController().signal)
    // Round 3: it comes back, and its rounds fail, so none decides whether it is blocked: the block
    // it had before it left is forgotten, not reported again.
    delete state.behindIn
    state.failIn = OTHER_ORG
    state.orgs = [ORG, OTHER_ORG]
    await vi.advanceTimersByTimeAsync(WORKER_POLICY.orgsMs)
    expect(worker.orgs()).toEqual([ORG, OTHER_ORG])
    await vi.advanceTimersByTimeAsync(WORKER_POLICY.consumerPollMs * 4)
    expect(worker.consumers.blocked()).toEqual([])
    worker.halt()
  })

  it('stops within its deadline, logs it, is unready while stopping, and polls no flags after', async () => {
    const { worker, control, log } = start()
    await vi.advanceTimersByTimeAsync(300)
    const started = performance.now()
    const stopping = worker.stop(started + 5000)
    await expect(worker.check(new AbortController().signal)).rejects.toThrow(/stopping/)
    await vi.advanceTimersByTimeAsync(5000)
    await stopping
    expect(performance.now() - started).toBeLessThanOrEqual(5000)
    expect(log.events('worker_stopping')).toHaveLength(1)
    const reads = control.statements.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(control.statements.length).toBe(reads)
  })
})
