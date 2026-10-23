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

  // A database whose reads for the orgs in `stuck` (all of them while `all` is set) hang for 31 s,
  // the pool's query_timeout, and then fail, as on a silent connection. The cache's clock is `now`.
  function stuckDatabase(now: () => number = () => Date.now()) {
    const state = { stuck: new Set<string>(), all: false, started: [] as string[] }
    const p = scriptedPool(
      (statement: Statement) => {
        if (statement.text.includes("from principals where org_id = $1 and kind = 'system'")) return [{ id: SYSTEM }]
        if (statement.text.startsWith('select "key"')) return [row('it.optional')]
        return []
      },
      async statement => {
        if (!statement.text.startsWith('select "key"')) return
        const org = String(statement.values[0])
        state.started.push(org)
        if (state.all || state.stuck.has(org)) {
          await new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Query read timeout')), 31_000))
        }
      },
    )
    const log = captureLogger('api')
    const flags = new FlagCache({
      db: p.db,
      registry: REGISTRY,
      logger: log.logger,
      now,
      random: () => 0.5,
    })
    return { state, flags, log }
  }
  const FOURTH_ORG = 'a0000000-0000-4000-8000-000000000004'
  const unconfirmedOrgs = (log: ReturnType<typeof captureLogger>) =>
    log.events('flags_unconfirmed').map(line => line.org)

  it('Qodo-18 round 4 #4: an org whose polls the read limit defers logs flags_unconfirmed once when it goes stale, as a failing one does', async () => {
    const { state, flags, log } = stuckDatabase()
    void flags.track(FOURTH_ORG)
    await vi.advanceTimersByTimeAsync(0)
    expect(flags.confirmed(FOURTH_ORG)).toBe(true)
    const confirmedAt = Date.now()
    // Three other orgs' reads hang, so FOURTH_ORG's next poll (at 2 s) waits.
    for (const org of [ORG, OTHER_ORG, THIRD_ORG]) state.stuck.add(org)
    void flags.track(ORG)
    void flags.track(OTHER_ORG)
    void flags.track(THIRD_ORG)
    await vi.advanceTimersByTimeAsync(FLAG_STALE_MS - 10)
    expect(flags.confirmed(FOURTH_ORG)).toBe(true)
    expect(unconfirmedOrgs(log)).not.toContain(FOURTH_ORG)
    await vi.advanceTimersByTimeAsync(confirmedAt + FLAG_STALE_MS + 10 - Date.now())
    expect(flags.confirmed(FOURTH_ORG)).toBe(false)
    expect(unconfirmedOrgs(log).filter(org => org === FOURTH_ORG)).toHaveLength(1)
    // Still deferred, polled and reloaded: never logged again until it is read.
    void flags.reload(FOURTH_ORG)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(unconfirmedOrgs(log).filter(org => org === FOURTH_ORG)).toHaveLength(1)
    expect(log.events('flags_confirmed')).toEqual([])
    // The stuck reads end at 31 s, and the deferred poll then confirms it.
    await vi.advanceTimersByTimeAsync(confirmedAt + 31_000 + 10 - Date.now())
    expect(flags.confirmed(FOURTH_ORG)).toBe(true)
    expect(log.events('flags_confirmed').map(line => line.org)).toEqual([FOURTH_ORG])
    // The other orgs' new reads hang again, so its next poll waits and it goes stale once more: a
    // new episode, logged once more.
    await vi.advanceTimersByTimeAsync(FLAG_STALE_MS + 10)
    expect(flags.confirmed(FOURTH_ORG)).toBe(false)
    expect(unconfirmedOrgs(log).filter(org => org === FOURTH_ORG)).toHaveLength(2)
    flags.stop()
  })

  it('Qodo-18 round 5 #3: an org whose first read the limit defers logs flags_unconfirmed at once, and once only until it is read', async () => {
    // The cache's clock starts at 0, as performance.now() does in a process that has just started.
    const zero = Date.now()
    const { state, flags, log } = stuckDatabase(() => Date.now() - zero)
    for (const org of [ORG, OTHER_ORG, THIRD_ORG]) state.stuck.add(org)
    // Four orgs kept at once: three reads hang, so FOURTH_ORG's first read waits. It has never been
    // read, so it is unconfirmed already, and says so at once, not when a timer finds it stale.
    for (const org of [ORG, OTHER_ORG, THIRD_ORG, FOURTH_ORG]) void flags.track(org)
    await vi.advanceTimersByTimeAsync(0)
    expect(state.started).toEqual([ORG, OTHER_ORG, THIRD_ORG])
    expect(unconfirmedOrgs(log)).toEqual([FOURTH_ORG])
    expect(flags.confirmed(FOURTH_ORG)).toBe(false)
    expect(flags.verdict(FOURTH_ORG, 'it.optional', null)).toBe('unconfirmed')
    // Reloaded, then 20 s more of waiting: still unread, and never logged again.
    void flags.reload(FOURTH_ORG)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(state.started).not.toContain(FOURTH_ORG)
    expect(flags.verdict(FOURTH_ORG, 'it.optional', null)).toBe('unconfirmed')
    expect(unconfirmedOrgs(log).filter(org => org === FOURTH_ORG)).toHaveLength(1)
    // The stuck reads end at 31 s, and its waiting read then confirms it.
    await vi.advanceTimersByTimeAsync(31_000 + 10 - (Date.now() - zero))
    expect(state.started).toContain(FOURTH_ORG)
    expect(flags.confirmed(FOURTH_ORG)).toBe(true)
    expect(flags.verdict(FOURTH_ORG, 'it.optional', null)).toBe('on')
    expect(log.events('flags_confirmed').map(line => line.org)).toEqual([FOURTH_ORG])
    expect(unconfirmedOrgs(log).filter(org => org === FOURTH_ORG)).toHaveLength(1)
    flags.stop()
  })

  it('Qodo-18 round 4 #4: logs flags_reads_limited once an episode, however often the deferred polls run and refill, and again in the next', async () => {
    const { state, flags, log } = stuckDatabase()
    state.all = true
    for (const org of [ORG, OTHER_ORG, THIRD_ORG]) void flags.track(org)
    // Two minutes of an outage: the three orgs' reads hang, each one's next poll waits, and each
    // stuck read ends at 31 s, when the deferred polls run, drain the queue and hang again.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(state.started.length).toBeGreaterThan(2 * FLAG_READS_IN_FLIGHT)
    expect(log.events('flags_reads_limited')).toHaveLength(1)
    // Reads answer again: once every stuck read has ended, nothing is deferred and the episode ends.
    state.all = false
    await vi.advanceTimersByTimeAsync(40_000)
    for (const org of [ORG, OTHER_ORG, THIRD_ORG]) expect(flags.confirmed(org)).toBe(true)
    expect(log.events('flags_reads_limited')).toHaveLength(1)
    // The next outage is a new episode.
    state.all = true
    await vi.advanceTimersByTimeAsync(10_000)
    expect(log.events('flags_reads_limited')).toHaveLength(2)
    flags.stop()
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

// The worker's cache with its registers (C0.9): a database whose register rows can change, whose
// register statements can fail on their own, and whose reads are counted.
interface PurposeRow {
  purpose: string
  version: number
  status: string
  basis: string | null
  providers: string[]
}
interface ProviderRow {
  provider: string
  revision: string
  review_on: string | null
  clearance: string | null
}
const accounts = (version: number): PurposeRow => ({
  purpose: 'accounts',
  version,
  status: 'active',
  basis: null,
  providers: [],
})
const aws = (change: Partial<ProviderRow> = {}): ProviderRow => ({
  provider: 'aws',
  revision: '2',
  review_on: '2026-10-30',
  clearance: null,
  ...change,
})

// The notice statement's row (registers.ts): no version unless a test sets one.
interface NoticeRow {
  id: string | null
  generated: boolean | null
  purposes: { purpose: string; version: number }[] | null
  providers: { provider: string; clearance: string; stated: boolean }[] | null
}
const NO_NOTICE: NoticeRow = { id: null, generated: null, purposes: null, providers: null }
const NOTICE_STATEMENT =
  "select v.id, v.generator is not null as generated, (select json_agg(json_build_object('purpose', l.purpose, 'version', l.register_version)) from notice_version_purposes l where l.org_id = $1 and l.notice_version_id = v.id) as purposes, (select json_agg(json_build_object('provider', s.provider, 'clearance', s.clearance, 'stated', s.stated)) from public.notice_provider_states() s) as providers from (values (1)) as one (n) left join lateral ( select id, generator from notice_versions where org_id = $2 order by version desc limit 1) v on true"

function registerDatabase() {
  const state = {
    purposes: [accounts(1)],
    providers: [aws()],
    restrictions: [] as { id: string; person_id: string; purpose: string; effective_at: Date }[],
    notice: NO_NOTICE,
    failing: false,
  }
  const p = scriptedPool((statement: Statement) => {
    const { text } = statement
    if (text.includes("from principals where org_id = $1 and kind = 'system'")) return [{ id: SYSTEM }]
    if (text.startsWith('select "key", "enabled"')) return [row('core.system', { locked: true }), row('it.optional')]
    if (text.startsWith('select distinct on (purpose)')) {
      return state.failing ? new Error('permission denied for table processing_register') : state.purposes
    }
    if (text.startsWith('select r.provider')) return state.providers
    if (text.startsWith('select id, person_id, purpose')) return state.restrictions
    if (text.startsWith('select v.id, v.generator')) return [state.notice]
    return []
  })
  return { ...p, state }
}

function registerCache(db: ReturnType<typeof registerDatabase>, registers = { restrictions: true }) {
  const log = captureLogger('worker')
  const flags = new FlagCache({
    db: db.db,
    as: 'hearth_queue',
    registry: REGISTRY,
    registers,
    logger: log.logger,
    now: () => Date.now(),
    random: () => 0.5,
  })
  return { flags, log }
}

describe('PGT-07 C0.9 PD-16 T22 item 9 the worker’s cache keeps the registers with its flags', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(new Date('2026-10-22T09:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads them in the flags’ own read-only transaction, as hearth_queue, after the flags, with only the granted columns', async () => {
    const db = registerDatabase()
    const { flags } = registerCache(db)
    await flags.track(ORG)
    const texts = db.texts()
    expect(texts[0]).toBe('start transaction isolation level read committed read only')
    expect(db.statements.find(s => s.text.startsWith("select set_config('role'"))?.values[0]).toBe('hearth_queue')
    const at = (start: string) => texts.findIndex(text => text.startsWith(start))
    expect(at('select "key", "enabled"')).toBeLessThan(at('select distinct on (purpose)'))
    expect(at('select distinct on (purpose)')).toBeLessThan(at('select r.provider'))
    expect(at('select r.provider')).toBeLessThan(at('select id, person_id, purpose'))
    expect(texts.indexOf('commit')).toBe(texts.length - 1)
    expect(texts.filter(text => text.startsWith('start transaction'))).toHaveLength(1)
    // hearth_queue's columns only (0009's grants), each read for the org set.
    expect(texts.slice(at('select distinct on (purpose)'))).toEqual([
      'select distinct on (purpose) purpose, version, status, basis, providers from processing_register where org_id = $1 order by purpose, version desc',
      'select r.provider, r.revision, r.review_on::text as review_on, c.id as clearance from transfer_register r left join transfer_clearances c on c.org_id = r.org_id and c.provider = r.provider and c.withdrawn_at is null where r.org_id = $1',
      'select id, person_id, purpose, effective_at from processing_restrictions where org_id = $1 and lifted_at is null',
      // C0.9 PR 2: the notice, in the same transaction (T22 item 9).
      NOTICE_STATEMENT,
      'commit',
    ])
    expect(flags.register(ORG)?.purposes.get('accounts')).toEqual({
      version: 1,
      status: 'active',
      basis: null,
      providers: [],
    })
    expect(flags.register(ORG)?.providers.get('aws')).toEqual({
      revision: 2,
      reviewOn: '2026-10-30',
      clearance: null,
      stated: false,
    })
    expect(flags.register(ORG)?.restrictions).toEqual(new Map())
    expect(flags.register(ORG)?.notified).toEqual(new Set())
    expect(flags.register(ORG)?.notice).toBeNull()
    expect(flags.register(OTHER_ORG)).toBeUndefined()
    flags.stop()
  })

  it('reads no restrictions unless asked, and no registers at all without the option (the api’s and realtime’s caches)', async () => {
    const without = registerDatabase()
    const plain = registerCache(without, { restrictions: false })
    await plain.flags.track(ORG)
    expect(without.texts().some(text => text.startsWith('select id, person_id, purpose'))).toBe(false)
    expect(plain.flags.register(ORG)?.restrictions).toBeUndefined()
    plain.flags.stop()
    const db = registerDatabase()
    const log = captureLogger('api')
    const flags = new FlagCache({ db: db.db, registry: REGISTRY, logger: log.logger, now: () => Date.now() })
    await flags.track(ORG)
    expect(db.texts().some(text => /processing_register|transfer_register|processing_restrictions/.test(text))).toBe(
      false,
    )
    expect(flags.confirmed(ORG)).toBe(true)
    expect(flags.register(ORG)).toBeUndefined()
    flags.stop()
  })

  it('a register statement that fails fails the whole read: the org goes unconfirmed, flags and registers together', async () => {
    const db = registerDatabase()
    const { flags, log } = registerCache(db)
    await flags.track(ORG)
    expect(flags.register(ORG)).toBeDefined()
    db.state.failing = true
    await vi.advanceTimersByTimeAsync(FLAG_STALE_MS + FLAG_POLL_MS)
    expect(flags.confirmed(ORG)).toBe(false)
    expect(flags.register(ORG)).toBeUndefined()
    expect(flags.verdict(ORG, 'it.optional', null)).toBe('unconfirmed')
    expect(flags.verdict(ORG, 'core.system', null)).toBe('on')
    expect(log.events('flags_poll_failed')[0]).toMatchObject({ org: ORG, failure: { error: 'Error' } })
    expect(log.events('flags_unconfirmed')).toHaveLength(1)
    db.state.failing = false
    await vi.advanceTimersByTimeAsync(FLAG_POLL_MS * 1.1)
    expect(flags.confirmed(ORG)).toBe(true)
    expect(flags.register(ORG)).toBeDefined()
    flags.stop()
  })

  it('logs register_changed when a purpose’s version, a provider’s revision or clearance, or a restriction moves, never for the first read, and tells no flag listener', async () => {
    const db = registerDatabase()
    const { flags, log } = registerCache(db)
    const listener = vi.fn()
    flags.onChange(listener)
    await flags.track(ORG)
    await flags.reload(ORG)
    expect(log.events('register_changed')).toEqual([])
    const restriction = {
      id: 'e1000000-0000-4000-8000-000000000001',
      person_id: PERSON,
      purpose: 'presence_receipts',
      effective_at: new Date(),
    }
    const changes: [string, () => void][] = [
      ['a new version', () => (db.state.purposes = [accounts(2)])],
      // A change of facts alone (no clearance): the revision.
      ['new facts', () => (db.state.providers = [aws({ revision: '3' })])],
      [
        'a clearance',
        () => (db.state.providers = [aws({ revision: '3', clearance: 'c1000000-0000-4000-8000-000000000001' })]),
      ],
      ['a restriction', () => (db.state.restrictions = [restriction])],
      // C0.9 PR 2: a publish (PGT-14).
      [
        'a publish',
        () => (db.state.notice = { ...NO_NOTICE, id: 'd1000000-0000-4000-8000-000000000001', generated: true }),
      ],
    ]
    for (const [what, change] of changes) {
      const before = log.events('register_changed').length
      change()
      await flags.reload(ORG)
      expect(log.events('register_changed'), what).toHaveLength(before + 1)
      expect(log.events('register_changed').at(-1), what).toMatchObject({ level: 30, org: ORG })
      await flags.reload(ORG)
      expect(log.events('register_changed'), `${what}, read again`).toHaveLength(before + 1)
    }
    expect(listener).not.toHaveBeenCalled()
    expect(log.events('flags_changed')).toEqual([])
    flags.stop()
  })

  it('PD-13: logs an open clearance past its review date at warn, once a UTC day for each org and provider, and never one not cleared', async () => {
    const db = registerDatabase()
    db.state.providers = [
      aws({ review_on: '2026-10-21', clearance: 'c1000000-0000-4000-8000-000000000001' }),
      aws({ provider: 'twilio', review_on: '2026-10-22', clearance: 'c1000000-0000-4000-8000-000000000002' }),
      aws({ provider: 'livekit', review_on: '2026-01-01' }),
    ]
    const { flags, log } = registerCache(db)
    await flags.track(ORG)
    await vi.advanceTimersByTimeAsync(FLAG_POLL_MS * 10)
    // aws's date has passed; twilio's is today, not yet; livekit isn't cleared.
    expect(log.events('transfer_review_overdue')).toEqual([
      expect.objectContaining({ level: 40, org: ORG, provider: 'aws', reviewOn: '2026-10-21' }),
    ])
    // The next UTC day: aws again, and twilio now too.
    vi.setSystemTime(new Date('2026-10-23T00:00:01Z'))
    await vi.advanceTimersByTimeAsync(FLAG_POLL_MS * 2)
    expect(log.events('transfer_review_overdue').map(line => line.provider)).toEqual(['aws', 'aws', 'twilio'])
    flags.stop()
  })

  it('PGT-16 C0.9 B-04 C-09 PD-61: logs pinned purposes the published notice no longer describes at warn, once a UTC day per org, at once when they change, and never with no version or a stand-in latest', async () => {
    const db = registerDatabase()
    db.state.purposes = [accounts(3), { ...accounts(2), purpose: 'service_operation' }]
    const VERSION = 'd1000000-0000-4000-8000-000000000001'
    const listing = (generated: boolean, links: { purpose: string; version: number }[]): NoticeRow => ({
      ...NO_NOTICE,
      id: VERSION,
      generated,
      purposes: links,
    })
    const { flags, log } = registerCache(db)
    // No version, then a stand-in that lists neither: nothing is stale, nothing is logged.
    await flags.track(ORG)
    db.state.notice = listing(false, [])
    await flags.reload(ORG)
    expect(flags.register(ORG)?.stale).toEqual(new Set())
    expect(log.events('notice_pinned_out_of_date')).toEqual([])
    // A generated version listing accounts at an older version: accounts is stale.
    db.state.notice = listing(true, [
      { purpose: 'accounts', version: 2 },
      { purpose: 'service_operation', version: 2 },
    ])
    await vi.advanceTimersByTimeAsync(FLAG_POLL_MS * 10)
    expect(log.events('notice_pinned_out_of_date')).toEqual([
      expect.objectContaining({ level: 40, org: ORG, purposes: ['accounts'] }),
    ])
    // The set changes: logged at once.
    db.state.purposes = [accounts(3), { ...accounts(3), purpose: 'service_operation' }]
    await flags.reload(ORG)
    expect(log.events('notice_pinned_out_of_date').map(line => line.purposes)).toEqual([
      ['accounts'],
      ['accounts', 'service_operation'],
    ])
    // The next UTC day: again, once.
    vi.setSystemTime(new Date('2026-10-23T00:00:01Z'))
    await vi.advanceTimersByTimeAsync(FLAG_POLL_MS * 5)
    expect(log.events('notice_pinned_out_of_date')).toHaveLength(3)
    // A new notice describes both: no more lines.
    db.state.notice = listing(true, [
      { purpose: 'accounts', version: 3 },
      { purpose: 'service_operation', version: 3 },
    ])
    await vi.advanceTimersByTimeAsync(FLAG_POLL_MS * 5)
    expect(flags.register(ORG)?.stale).toEqual(new Set())
    expect(log.events('notice_pinned_out_of_date')).toHaveLength(3)
    flags.stop()
  })
})
