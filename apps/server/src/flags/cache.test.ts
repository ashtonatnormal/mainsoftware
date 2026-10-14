import { FLAGS } from '@hearth/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLAG_POLL_MS, FLAG_READ_WAIT_MS, FLAG_READS_IN_FLIGHT, FLAG_STALE_MS, FlagCache } from '#src/flags/cache.ts'
import { Subscriptions } from '#src/pubsub.ts'
import { captureLogger } from '#src/testing/logs.ts'
import { type Statement, scriptedPool } from '#src/testing/pool.ts'
import { fakeSubscriber } from '#src/testing/subscriber.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const OTHER_ORG = 'a0000000-0000-4000-8000-000000000002'
const THIRD_ORG = 'a0000000-0000-4000-8000-000000000003'
const SYSTEM = 'c0000000-0000-4000-8000-000000000001'
const PERSON = 'b0000000-0000-4000-8000-000000000001'

const REGISTRY = {
  ...FLAGS,
  'it.optional': {
    ...FLAGS['core.system'],
    class: 'optional',
    default: false,
    locked: false,
    purposes: ['service_operation'],
  },
  'it.wave': {
    ...FLAGS['core.system'],
    class: 'optional',
    default: false,
    locked: false,
    purposes: ['service_operation'],
  },
} as const

interface Row {
  key: string
  enabled: boolean
  locked: boolean
  audience: 'org' | 'cohort'
  cohort_people: string[]
  cohort_roles: string[]
  revision: string
}
const row = (key: string, change: Partial<Row> = {}): Row => ({
  key,
  enabled: true,
  locked: false,
  audience: 'org',
  cohort_people: [],
  cohort_roles: [],
  revision: '1',
  ...change,
})

// The database the cache reads: its rows can change, its reads can fail or be held.
function database(initial: Row[]) {
  const state = { rows: initial, failing: false, reads: 0 }
  const p = scriptedPool((statement: Statement) => {
    if (statement.text.includes("from principals where org_id = $1 and kind = 'system'")) return [{ id: SYSTEM }]
    if (statement.text.startsWith('select "key", "enabled"')) {
      state.reads++
      return state.failing ? new Error('Connection terminated unexpectedly') : state.rows
    }
    return []
  })
  return { ...p, state }
}

function cache(db: ReturnType<typeof database>, options: { random?: () => number; as?: 'hearth_queue' } = {}) {
  const log = captureLogger('api')
  const flags = new FlagCache({
    db: db.db,
    registry: REGISTRY,
    logger: log.logger,
    now: () => Date.now(),
    random: options.random ?? (() => 0.5),
    ...(options.as === undefined ? {} : { as: options.as }),
  })
  return { flags, log }
}

const reads = (db: ReturnType<typeof database>) => db.state.reads

describe('C0.6 T17 items 6 and 7 the flags a process keeps', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads an org at once when first kept, resolves at that first read, and then polls every 2 s ±10%', async () => {
    const db = database([row('core.system', { locked: true }), row('it.optional')])
    let random = 0
    const { flags } = cache(db, { random: () => random })
    let confirmed = false
    void flags.track(ORG).then(() => {
      confirmed = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(confirmed).toBe(true)
    expect(reads(db)).toBe(1)
    // random 0: the shortest wait, 1.8 s.
    await vi.advanceTimersByTimeAsync(FLAG_POLL_MS * 0.9 - 1)
    expect(reads(db)).toBe(1)
    random = 1
    await vi.advanceTimersByTimeAsync(1)
    expect(reads(db)).toBe(2)
    // random 1: the longest, 2.2 s.
    await vi.advanceTimersByTimeAsync(FLAG_POLL_MS * 1.1 - 1)
    expect(reads(db)).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(reads(db)).toBe(3)
    // Keeping it again reads nothing more.
    await flags.track(ORG)
    expect(reads(db)).toBe(3)
    flags.stop()
    await vi.advanceTimersByTimeAsync(FLAG_POLL_MS * 5)
    expect(reads(db)).toBe(3)
  })

  it('Qodo-18 #6: forgets an org it no longer keeps: no more polls, a read in progress changes nothing, and it reads as unconfirmed', async () => {
    const db = database([row('it.optional')])
    let release: () => void = () => {}
    let holding = false
    const held = scriptedPool(
      (statement: Statement) => {
        if (statement.text.includes("from principals where org_id = $1 and kind = 'system'")) return [{ id: SYSTEM }]
        if (statement.text.startsWith('select "key"')) {
          db.state.reads++
          return db.state.rows
        }
        return []
      },
      async statement => {
        if (statement.text.startsWith('select "key"') && holding) {
          await new Promise<void>(resolve => {
            release = resolve
          })
        }
      },
    )
    const log = captureLogger('api')
    const flags = new FlagCache({
      db: held.db,
      registry: REGISTRY,
      logger: log.logger,
      now: () => Date.now(),
      random: () => 0.5,
    })
    await flags.track(ORG)
    await flags.track(OTHER_ORG)
    expect(flags.confirmed(ORG)).toBe(true)
    flags.untrack(ORG)
    expect(flags.confirmed(ORG)).toBe(false)
    expect(flags.isOn(ORG, 'it.optional', null)).toBe(false)
    const before = reads(db)
    await vi.advanceTimersByTimeAsync(FLAG_POLL_MS * 5)
    // Only the org still kept is polled.
    expect(reads(db) - before).toBe(5)
    // Untracked while a read is in progress: the read ends, and nothing is kept or polled after it.
    holding = true
    await vi.advanceTimersByTimeAsync(FLAG_POLL_MS * 1.1)
    flags.untrack(OTHER_ORG)
    holding = false
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(flags.confirmed(OTHER_ORG)).toBe(false)
    const after = reads(db)
    await vi.advanceTimersByTimeAsync(FLAG_POLL_MS * 5)
    expect(reads(db)).toBe(after)
    // Kept again, it is read at once.
    await flags.track(ORG)
    expect(flags.confirmed(ORG)).toBe(true)
    flags.stop()
  })

  it('leaves an org it doesn’t keep alone on reload(), so a job still running there can’t keep it again', async () => {
    const db = database([row('it.optional')])
    const { flags } = cache(db)
    await flags.track(ORG)
    flags.untrack(ORG)
    const before = reads(db)
    // A job's fence refusal (HF001) or a gate's second look, after the worker untracked the org.
    await flags.reload(ORG)
    await flags.reload(OTHER_ORG)
    expect(reads(db)).toBe(before)
    expect(flags.confirmed(ORG)).toBe(false)
    expect(flags.confirmed(OTHER_ORG)).toBe(false)
    await vi.advanceTimersByTimeAsync(FLAG_POLL_MS * 5)
    expect(reads(db)).toBe(before)
    flags.stop()
  })

  it('reads as the org’s system principal, read only and bounded to 2 s, and as hearth_queue in the worker', async () => {
    const db = database([row('core.system', { locked: true })])
    const { flags } = cache(db, { as: 'hearth_queue' })
    await flags.track(ORG)
    expect(db.texts()[0]).toBe('start transaction isolation level read committed read only')
    expect(db.statements.find(s => s.text.startsWith("select set_config('role'"))?.values[0]).toBe('hearth_queue')
    expect(db.texts()).toContain("set local statement_timeout = '2s'")
    expect(db.texts().find(text => text.startsWith('select "key"'))).toBe(
      'select "key", "enabled", "locked", "audience", "cohort_people", "cohort_roles", "revision" from "feature_flags" where "org_id" = $1',
    )
    flags.stop()
  })

  it('says whether a feature is on for someone: the lineage, cohorts, and off for a key it doesn’t know', async () => {
    const db = database([
      row('core.system', { locked: true }),
      row('it.optional'),
      row('it.wave', { audience: 'cohort', cohort_people: [PERSON], cohort_roles: ['dpo'] }),
      row('ai', { enabled: false, locked: true }),
      row('ai.ask', { enabled: false, locked: true }),
    ])
    const { flags } = cache(db)
    await flags.track(ORG)
    expect(flags.isOn(ORG, 'it.optional', null)).toBe(true)
    expect(flags.isOn(ORG, 'it.wave', { personId: PERSON, active: true, roles: [] })).toBe(true)
    expect(flags.isOn(ORG, 'it.wave', { personId: SYSTEM, active: true, roles: ['dpo'] })).toBe(true)
    expect(flags.isOn(ORG, 'it.wave', { personId: SYSTEM, active: true, roles: ['admin'] })).toBe(false)
    expect(flags.isOn(ORG, 'it.wave', null)).toBe(false)
    expect(flags.isOn(ORG, 'ai.ask', null)).toBe(false)
    expect(flags.isOn(ORG, 'it.unknown', null)).toBe(false)
    flags.stop()
  })

  it('reads every flag not locked on as off while an org is unconfirmed: never read, or not read for 8 s', async () => {
    const db = database([row('core.system', { locked: true }), row('it.optional')])
    const { flags, log } = cache(db)
    // Not kept yet: only what the registry has locked on.
    expect(flags.isOn(ORG, 'core.system', null)).toBe(true)
    expect(flags.isOn(ORG, 'it.optional', null)).toBe(false)
    await flags.track(ORG)
    expect(flags.isOn(ORG, 'it.optional', null)).toBe(true)
    db.state.failing = true
    await vi.advanceTimersByTimeAsync(FLAG_STALE_MS - 100)
    // Still within 8 s of the last good read.
    expect(flags.isOn(ORG, 'it.optional', null)).toBe(true)
    expect(log.events('flags_unconfirmed')).toEqual([])
    await vi.advanceTimersByTimeAsync(2500)
    expect(flags.isOn(ORG, 'it.optional', null)).toBe(false)
    expect(flags.isOn(ORG, 'core.system', null)).toBe(true)
    expect(log.events('flags_unconfirmed')).toHaveLength(1)
    // Each failed read is logged, at error from the third in a row (C0.13 alarms on it).
    const levels = log.events('flags_poll_failed').map(line => line.level)
    expect(levels.slice(0, 3)).toEqual([40, 40, 50])
    expect(JSON.stringify(log.events('flags_poll_failed'))).not.toContain('terminated')
    // Recovery.
    db.state.failing = false
    await vi.advanceTimersByTimeAsync(FLAG_POLL_MS * 1.1)
    expect(flags.isOn(ORG, 'it.optional', null)).toBe(true)
    expect(log.events('flags_confirmed')).toHaveLength(1)
    flags.stop()
  })

  it('C0.6 T15 items 9 and 11: says why a feature isn’t on, and whether an org’s flags are confirmed', async () => {
    const db = database([
      row('core.system', { locked: true }),
      row('it.optional'),
      row('it.wave', { audience: 'cohort', cohort_people: [PERSON], cohort_roles: [] }),
      row('ai', { enabled: false, locked: true }),
      row('ai.ask', { enabled: false, locked: true }),
    ])
    const { flags } = cache(db)
    // Never read: unconfirmed, unless locked on.
    expect(flags.confirmed(ORG)).toBe(false)
    expect(flags.verdict(ORG, 'it.optional', null)).toBe('unconfirmed')
    expect(flags.verdict(ORG, 'core.system', null)).toBe('on')
    await flags.track(ORG)
    expect(flags.confirmed(ORG)).toBe(true)
    expect(flags.confirmed(OTHER_ORG)).toBe(false)
    expect(flags.verdict(ORG, 'it.optional', null)).toBe('on')
    expect(flags.verdict(ORG, 'it.wave', { personId: PERSON, active: true, roles: [] })).toBe('on')
    expect(flags.verdict(ORG, 'it.wave', { personId: SYSTEM, active: true, roles: [] })).toBe('not_in_cohort')
    expect(flags.verdict(ORG, 'it.wave', null)).toBe('not_in_cohort')
    expect(flags.verdict(ORG, 'ai.ask', null)).toBe('off')
    expect(flags.verdict(ORG, 'it.unknown', null)).toBe('off')
    // Not read for 8 s: unconfirmed again.
    db.state.failing = true
    await vi.advanceTimersByTimeAsync(FLAG_STALE_MS + FLAG_POLL_MS)
    expect(flags.confirmed(ORG)).toBe(false)
    expect(flags.verdict(ORG, 'it.optional', null)).toBe('unconfirmed')
    expect(flags.verdict(ORG, 'core.system', null)).toBe('on')
    flags.stop()
  })

  it('gives the lineage’s revisions from the top, as the fences read them, and nothing for a feature with no row', async () => {
    const db = database([
      row('ai', { revision: '4', enabled: false, locked: true }),
      row('ai.agents', { revision: '7', enabled: false, locked: true }),
      row('ai.agents.x1', { revision: '2', enabled: false }),
    ])
    const { flags } = cache(db)
    expect(flags.revisionsOf(ORG, 'ai.agents.x1')).toBeUndefined()
    await flags.track(ORG)
    expect(flags.revisionsOf(ORG, 'ai.agents.x1')).toEqual([4, 7, 2])
    expect(flags.revisionsOf(ORG, 'ai.agents')).toEqual([4, 7])
    expect(flags.revisionsOf(ORG, 'ai.brain')).toBeUndefined()
    expect(flags.confirmedAt(ORG)).toBe(Date.now())
    flags.stop()
  })

  it('tells listeners and the log which flags changed, never for the first read, and logs a row it doesn’t know once', async () => {
    const db = database([row('it.optional'), row('it.extra')])
    const { flags, log } = cache(db)
    const changes: [string, readonly string[]][] = []
    flags.onChange((orgId, keys) => changes.push([orgId, keys]))
    await flags.track(ORG)
    expect(changes).toEqual([])
    expect(log.events('flag_unregistered')).toEqual([expect.objectContaining({ org: ORG, key: 'it.extra' })])
    expect(flags.isOn(ORG, 'it.extra', null)).toBe(false)
    db.state.rows = [row('it.optional', { enabled: false, revision: '2' }), row('it.extra'), row('it.wave')]
    await flags.reload(ORG)
    expect(changes).toEqual([[ORG, ['it.optional', 'it.wave']]])
    expect(log.events('flags_changed')).toEqual([
      expect.objectContaining({ org: ORG, key: 'it.optional', revision: 2 }),
      expect.objectContaining({ org: ORG, key: 'it.wave', revision: 1 }),
    ])
    expect(log.events('flag_unregistered')).toHaveLength(1)
    flags.stop()
  })

  it('reloads an org at once when the flags channel says it changed, and ignores another org’s message', async () => {
    const db = database([row('it.optional')])
    const { flags, log } = cache(db)
    const sub = fakeSubscriber()
    const subscriptions = new Subscriptions(sub.asRedis, log.logger)
    await flags.listen(subscriptions, 'it:unit:flags')
    await flags.track(ORG)
    expect(reads(db)).toBe(1)
    const message = { v: 1, org: ORG, key: 'it.optional', revision: 2, at: Date.now() }
    sub.events.emit('message', 'it:unit:flags', JSON.stringify(message))
    await vi.advanceTimersByTimeAsync(0)
    expect(reads(db)).toBe(2)
    sub.events.emit('message', 'it:unit:flags', JSON.stringify({ ...message, org: OTHER_ORG }))
    sub.events.emit('message', 'it:unit:flags', 'not json')
    await vi.advanceTimersByTimeAsync(0)
    expect(reads(db)).toBe(2)
    expect(log.events('flags_message_unreadable')).toHaveLength(1)
    flags.stop()
  })

  it('coalesces reloads asked for during a read into one more read, which starts after they asked', async () => {
    const db = database([row('it.optional')])
    let release: () => void = () => {}
    const held = scriptedPool(
      (statement: Statement) => {
        if (statement.text.includes("from principals where org_id = $1 and kind = 'system'")) return [{ id: SYSTEM }]
        if (statement.text.startsWith('select "key"')) {
          db.state.reads++
          return db.state.rows
        }
        return []
      },
      async statement => {
        if (statement.text.startsWith('select "key"') && db.state.reads === 0) {
          await new Promise<void>(resolve => {
            release = resolve
          })
        }
      },
    )
    const log = captureLogger('api')
    const flags = new FlagCache({
      db: held.db,
      registry: REGISTRY,
      logger: log.logger,
      now: () => Date.now(),
      random: () => 0.5,
    })
    void flags.track(ORG)
    await vi.advanceTimersByTimeAsync(0)
    const first = flags.reload(ORG)
    const second = flags.reload(ORG)
    let done = false
    void Promise.all([first, second]).then(() => {
      done = true
    })
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
    expect(db.state.reads).toBe(2)
    flags.stop()
  })
  // A database whose reads hang (a silent connection) while `silent` is set, until released.
  function silentDatabase() {
    const state = { silent: true, started: [] as string[], releases: [] as Array<() => void> }
    const p = scriptedPool(
      (statement: Statement) => {
        if (statement.text.includes("from principals where org_id = $1 and kind = 'system'")) return [{ id: SYSTEM }]
        if (statement.text.startsWith('select "key"')) return [row('it.optional')]
        return []
      },
      async statement => {
        if (!statement.text.startsWith('select "key"')) return
        state.started.push(String(statement.values[0]))
        if (state.silent) await new Promise<void>(resolve => state.releases.push(resolve))
      },
    )
    const log = captureLogger('api')
    const flags = new FlagCache({
      db: p.db,
      registry: REGISTRY,
      logger: log.logger,
      now: () => Date.now(),
      random: () => 0.5,
    })
    const release = () => {
      state.silent = false
      for (const resolve of state.releases.splice(0)) resolve()
    }
    return { state, flags, log, release }
  }

  it('CodeRabbit-18: keeps at most 3 reads in flight, however long silent connections hold them, and runs the deferred polls once one ends', async () => {
    const { state, flags, log, release } = silentDatabase()
    void flags.track(ORG)
    void flags.track(OTHER_ORG)
    void flags.track(THIRD_ORG)
    await vi.advanceTimersByTimeAsync(60_000)
    // Without the limit each org would start a read every 4.5 s (the wait, then a poll).
    expect(state.started).toHaveLength(FLAG_READS_IN_FLIGHT)
    expect(log.events('flags_reads_limited')).toHaveLength(1)
    expect(flags.confirmed(ORG) || flags.confirmed(OTHER_ORG) || flags.confirmed(THIRD_ORG)).toBe(false)
    // A deferred org that is untracked meanwhile isn't read again.
    flags.untrack(THIRD_ORG)
    const before = state.started.length
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(flags.confirmed(ORG)).toBe(true)
    expect(flags.confirmed(OTHER_ORG)).toBe(true)
    expect(state.started.slice(before)).not.toContain(THIRD_ORG)
    await vi.advanceTimersByTimeAsync(FLAG_POLL_MS * 5)
    expect(state.started.slice(before)).not.toContain(THIRD_ORG)
    expect(flags.confirmed(THIRD_ORG)).toBe(false)
    flags.stop()
  })

  it('CodeRabbit-18: still retries at once beside a read it stopped waiting for, and starts no deferred poll after stop()', async () => {
    const { state, flags, release } = silentDatabase()
    void flags.track(ORG)
    await vi.advanceTimersByTimeAsync(0)
    expect(state.started).toEqual([ORG])
    // The stuck read counts as failed after 2.5 s, and a reload then reads again at once.
    await vi.advanceTimersByTimeAsync(FLAG_READ_WAIT_MS)
    void flags.reload(ORG)
    await vi.advanceTimersByTimeAsync(0)
    expect(state.started).toEqual([ORG, ORG])
    void flags.track(OTHER_ORG)
    await vi.advanceTimersByTimeAsync(0)
    expect(state.started).toHaveLength(FLAG_READS_IN_FLIGHT)
    // A reload of a deferred org resolves at once, as after a failed read.
    await vi.advanceTimersByTimeAsync(FLAG_READ_WAIT_MS + FLAG_POLL_MS * 1.1)
    let reloaded = false
    void flags.reload(OTHER_ORG).then(() => {
      reloaded = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(reloaded).toBe(true)
    const before = state.started.length
    flags.stop()
    release()
    await vi.advanceTimersByTimeAsync(FLAG_POLL_MS * 5)
    expect(state.started).toHaveLength(before)
  })

  it('FLAGS-1: stops waiting for a read that never ends, counts it as failed, polls again, and drops its late result', async () => {
    // A connection whose peer went silent: the first read's select never answers until released.
    const db = database([row('it.optional')])
    let release: () => void = () => {}
    let held = true
    const silent = scriptedPool(
      (statement: Statement) => {
        if (statement.text.includes("from principals where org_id = $1 and kind = 'system'")) return [{ id: SYSTEM }]
        if (statement.text.startsWith('select "key"')) {
          db.state.reads++
          return db.state.rows
        }
        return []
      },
      async statement => {
        if (statement.text.startsWith('select "key"') && held) {
          held = false
          await new Promise<void>(resolve => {
            release = resolve
          })
        }
      },
    )
    const log = captureLogger('api')
    const flags = new FlagCache({
      db: silent.db,
      registry: REGISTRY,
      logger: log.logger,
      now: () => Date.now(),
      random: () => 0.5,
    })
    void flags.track(ORG)
    await vi.advanceTimersByTimeAsync(0)
    let reloaded = false
    void flags.reload(ORG).then(() => {
      reloaded = true
    })
    await vi.advanceTimersByTimeAsync(FLAG_READ_WAIT_MS - 1)
    expect(log.events('flags_poll_failed')).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    // The stuck read counts as a failed poll, and the reload asked for during it runs at once.
    expect(log.events('flags_poll_failed')).toEqual([
      expect.objectContaining({
        org: ORG,
        failures: 1,
        failure: expect.objectContaining({ error: 'FlagReadTimeout' }),
      }),
    ])
    expect(log.events('flags_unconfirmed')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(reloaded).toBe(true)
    expect(db.state.reads).toBe(1)
    expect(flags.isOn(ORG, 'it.optional', null)).toBe(true)
    // The stuck read ends at last with rows older than what has been read since: dropped.
    db.state.rows = [row('it.optional', { enabled: false, revision: '2' })]
    await vi.advanceTimersByTimeAsync(FLAG_POLL_MS * 1.1)
    expect(flags.isOn(ORG, 'it.optional', null)).toBe(false)
    db.state.rows = [row('it.optional')]
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(flags.isOn(ORG, 'it.optional', null)).toBe(false)
    flags.stop()
  })
})
