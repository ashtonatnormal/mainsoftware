import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerGate } from '#src/compliance/gate.ts'
import type { Gate } from '#src/jobs/gate.ts'
import { BelowFloor, ConsumerRunner, type OutboxConsumer } from '#src/outbox/consumers.ts'
import type { OutboxRow } from '#src/outbox/positions.ts'
import { coreOnlyGate, registerStateOf } from '#src/testing/gates.ts'
import { captureLogger } from '#src/testing/logs.ts'
import { pgError, type Statement, scriptedPool } from '#src/testing/pool.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const SYSTEM = 'c0000000-0000-4000-8000-000000000001'
const PERSON = 'b0000000-0000-4000-8000-000000000001'
const OTHER = 'b0000000-0000-4000-8000-000000000002'
const OTHER_ORG = 'a0000000-0000-4000-8000-000000000002'

// An event row as the floor-and-batch statement returns it.
function eventRow(id: number, type: string, subjects: string[] = [PERSON], floor?: [string, string]) {
  return {
    floor_tx: floor?.[0] ?? null,
    floor_id: floor?.[1] ?? null,
    fell_behind: false,
    id: String(id),
    tx_id: String(1000 + id),
    at: new Date('2026-10-14T00:00:00Z'),
    type,
    version: 1,
    entity_type: 'person',
    entity_id: PERSON,
    container_type: null,
    container_id: null,
    acl_tokens: null,
    acl_more: null,
    index_class: null,
    acl_epoch: null,
    actor_id: SYSTEM,
    actor_kind: 'system',
    subject_ids: subjects,
    purpose: 'accounts',
    tombstone: false,
    ids: {},
  }
}

const noEvents = (floor?: [string, string], fellBehind = false) => [
  { floor_tx: floor?.[0] ?? null, floor_id: floor?.[1] ?? null, fell_behind: fellBehind, id: null },
]

interface Script {
  future?: boolean
  locked?: boolean
  checkpoint?: { last_tx: string; last_id: string } | null
  batch?: unknown[]
  moved?: boolean
  fence?: Error
  belowFloor?: boolean
}

function pool(script: Script = {}) {
  return scriptedPool((statement: Statement) => {
    const { text } = statement
    if (text.includes("from principals where org_id = $1 and kind = 'system'")) return [{ id: SYSTEM }]
    if (text.startsWith('select greatest(')) return [{ future: script.future ?? false }]
    if (text.startsWith('select pg_try_advisory_xact_lock')) return [{ locked: script.locked ?? true }]
    if (text.startsWith('select last_tx, last_id from outbox_checkpoints')) {
      return script.checkpoint === null ? [] : [script.checkpoint ?? { last_tx: '900', last_id: '7' }]
    }
    if (text.startsWith('with f as')) return script.batch ?? noEvents()
    if (text.startsWith('update outbox_checkpoints')) return { affected: script.moved ? 0 : 1 }
    if (text.startsWith('insert into outbox_checkpoints as c')) return { affected: script.belowFloor ? 0 : 1 }
    if (text.startsWith('select public.feature_fence')) return script.fence ?? []
    return []
  })
}

function consumer(change: Partial<OutboxConsumer> = {}) {
  const handled: OutboxRow[][] = []
  const spec: OutboxConsumer = {
    name: 'it_projection',
    role: 'hearth_job_offboarding',
    feature: 'core.system',
    purpose: 'accounts',
    types: ['person.deactivated', 'signin.ended'],
    start: 'oldest',
    lagBudgetMs: 10_000,
    handle: async (_trx, events) => {
      handled.push([...events])
    },
    ...change,
  }
  return { spec, handled }
}

function runner(p: ReturnType<typeof pool>, consumers: OutboxConsumer[], options: { on?: boolean; gate?: Gate } = {}) {
  const log = captureLogger()
  const flags = {
    isOn: vi.fn(() => options.on ?? true),
    revisionsOf: vi.fn(() => [3]),
    reload: vi.fn(async () => {}),
  }
  const run = new ConsumerRunner({
    db: p.db,
    consumers,
    flags,
    gate: options.gate ?? coreOnlyGate,
    logger: log.logger,
    pollMs: 500,
  })
  return { run, flags, log }
}

// The statements of the round itself: the consumer's transaction, without withOrg's own.
const roundTexts = (p: ReturnType<typeof pool>) =>
  p
    .texts()
    .filter(
      text =>
        !/^(start transaction|select set_config|select id from principals|select greatest\(|commit|rollback)/.test(
          text,
        ),
    )

describe('C0.6 T16 one round of an outbox consumer', () => {
  it('admits, locks, reads the checkpoint, the floor and batch in one statement, handles its types, moves the checkpoint by compare-and-set and fences last', async () => {
    const p = pool({
      batch: [eventRow(8, 'person.deactivated'), eventRow(9, 'account.pin_set'), eventRow(10, 'signin.ended')],
    })
    const { spec, handled } = consumer()
    const { run } = runner(p, [spec])
    expect(await run.round(spec, ORG)).toBe('idle')
    const texts = roundTexts(p)
    expect(texts[0]).toBe('select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as locked')
    expect(texts[1]).toBe('select last_tx, last_id from outbox_checkpoints where org_id = $1 and consumer = $2')
    expect(texts[2]).toMatch(/^with f as \(select last_tx, last_id from outbox_floors where org_id = \$1\), b as \(/)
    expect(texts[2]).toContain('and tx_id < pg_snapshot_xmin(pg_current_snapshot()) order by tx_id, id limit $5')
    expect(texts[3]).toMatch(/^update outbox_checkpoints set last_tx = \$1::xid8, last_id = \$2::bigint/)
    expect(texts[4]).toBe('select public.feature_fence($1, $2::bigint[])')
    expect(texts).toHaveLength(5)
    // The org's first round checks for positions from the future as hearth_queue, read only (A3);
    // the round itself runs as the consumer's own role, which alone may move its checkpoint.
    expect(p.statements.filter(s => s.text.startsWith("select set_config('role'")).map(s => s.values[0])).toEqual([
      'hearth_queue',
      'hearth_job_offboarding',
    ])
    const lock = p.statements.find(s => s.text.startsWith('select pg_try_advisory_xact_lock'))
    expect(lock?.values).toEqual([`hearth.outbox:it_projection:${ORG}`])
    const batch = p.statements.find(s => s.text.startsWith('with f as'))
    expect(batch?.values).toEqual([ORG, ORG, '900', '7', 500, '900', '7'])
    // Only its own types reach handle(); the checkpoint passes every event read.
    expect(handled.map(events => events.map(event => event.type))).toEqual([['person.deactivated', 'signin.ended']])
    const move = p.statements.find(s => s.text.startsWith('update outbox_checkpoints'))
    expect(move?.values).toEqual(['1010', '10', 3, ORG, 'it_projection', '900', '7'])
    expect(p.statements.find(s => s.text.startsWith('select public.feature_fence'))?.values).toEqual([
      'core.system',
      [3],
    ])
  })

  it('runs again at once after a full batch', async () => {
    const p = pool({ batch: [eventRow(1, 'person.deactivated'), eventRow(2, 'person.deactivated')] })
    const { spec } = consumer({ batch: 2 })
    expect(await runner(p, [spec]).run.round(spec, ORG)).toBe('full')
  })

  it('stops without reading when another round holds the lock, which takes no transaction id', async () => {
    const p = pool({ locked: false })
    const { spec, handled } = consumer()
    expect(await runner(p, [spec]).run.round(spec, ORG)).toBe('busy')
    expect(roundTexts(p)).toEqual(['select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as locked'])
    expect(handled).toEqual([])
  })

  it('makes a new consumer’s checkpoint at the floor, or the start, in one statement, and ends the round there', async () => {
    const p = pool({ checkpoint: null })
    const { spec, handled } = consumer()
    expect(await runner(p, [spec]).run.round(spec, ORG)).toBe('full')
    const insert = p.statements.find(s => s.text.startsWith('insert into outbox_checkpoints'))
    expect(insert?.text).toContain("coalesce(f.last_tx, '0'::xid8)")
    expect(insert?.text).toContain('on conflict (org_id, consumer) do nothing')
    expect(insert?.values).toEqual([ORG, 'it_projection', 'hearth_job_offboarding', ORG])
    expect(p.texts().some(text => text.startsWith('with f as'))).toBe(false)
    expect(handled).toEqual([])
  })

  it('starts a consumer that bootstraps from enumerators at the current horizon', async () => {
    const p = pool({ checkpoint: null })
    const { spec } = consumer({ start: 'now' })
    await runner(p, [spec]).run.round(spec, ORG)
    const insert = p.statements.find(s => s.text.startsWith('insert into outbox_checkpoints'))
    expect(insert?.text).toContain(
      'e.tx_id < pg_snapshot_xmin(pg_current_snapshot()) order by e.tx_id desc, e.id desc limit 1',
    )
  })

  it('keeps its place while its flag is off or the gate refuses it, opening no transaction, and logs each change once', async () => {
    const p = pool()
    const { spec, handled } = consumer()
    const off = runner(p, [spec], { on: false })
    expect(await off.run.round(spec, ORG)).toBe('refused')
    expect(await off.run.round(spec, ORG)).toBe('refused')
    expect(p.texts().filter(text => text.includes("set_config('role'")).length).toBe(0)
    expect(off.log.events('outbox_consumer_paused')).toHaveLength(1)
    // A consumer with an AI purpose, or naming a provider not cleared, is refused by the purpose gate
    // (here over a register never read, C0.9 PD-07).
    const ai = consumer({ purpose: 'org_brain' })
    const refused = runner(p, [ai.spec])
    expect(await refused.run.round(ai.spec, ORG)).toBe('refused')
    expect(refused.log.events('outbox_consumer_refused')).toEqual([
      expect.objectContaining({ consumer: 'it_projection', reason: 'purpose_refused' }),
    ])
    const sends = consumer({ providers: ['apple_push'] })
    expect(await runner(p, [sends.spec]).run.round(sends.spec, ORG)).toBe('refused')
    expect(handled).toEqual([])
  })

  it('stops, logging an error once, when the clean-up has deleted past its checkpoint', async () => {
    const script: Script = { batch: noEvents(['950', '3'], true) }
    const p = pool(script)
    const { spec, handled } = consumer()
    const { run, log } = runner(p, [spec])
    expect(run.blocked()).toEqual([])
    expect(await run.round(spec, ORG)).toBe('behind')
    expect(await run.round(spec, ORG)).toBe('behind')
    expect(log.events('outbox_consumer_fell_behind')).toHaveLength(1)
    expect(log.events('outbox_consumer_fell_behind')[0]).toMatchObject({
      level: 50,
      consumer: 'it_projection',
      org: ORG,
      reason: 'behind_floor',
    })
    expect(p.texts().some(text => text.startsWith('update outbox_checkpoints'))).toBe(false)
    expect(handled).toEqual([])
    // Qodo-18 #1: blocked, for the worker's readiness, until a round reads again (after a reset or
    // a rebuild); a refused round says nothing either way.
    expect(run.blocked()).toEqual([{ consumer: 'it_projection', org: ORG, reason: 'behind_floor' }])
    script.locked = false
    expect(await run.round(spec, ORG)).toBe('busy')
    expect(run.blocked()).toHaveLength(1)
    script.locked = true
    script.batch = noEvents(['950', '3'])
    expect(await run.round(spec, ORG)).toBe('idle')
    expect(run.blocked()).toEqual([])
    expect(log.events('outbox_consumer_unblocked')).toEqual([
      expect.objectContaining({ level: 30, consumer: 'it_projection', org: ORG }),
    ])
  })

  it('passes over an event whose subject’s processing switch refuses the purpose, logging its id, and still moves past it', async () => {
    const p = pool({ batch: [eventRow(4, 'person.deactivated', [OTHER]), eventRow(5, 'person.deactivated')] })
    const gate: Gate = { ...coreOnlyGate, processingAllowed: (_org, subject) => subject !== OTHER }
    const { spec, handled } = consumer()
    const { run, log } = runner(p, [spec], { gate })
    await run.round(spec, ORG)
    expect(handled.map(events => events.map(event => event.id))).toEqual([['5']])
    expect(log.events('outbox_event_withheld')).toEqual([expect.objectContaining({ eventId: '4' })])
    expect(p.statements.find(s => s.text.startsWith('update outbox_checkpoints'))?.values.slice(0, 3)).toEqual([
      '1005',
      '5',
      2,
    ])
  })

  it('C0.7 S8 T19 item 4: withholds none of a protective consumer’s events for a subject’s switch, while it withholds another’s', async () => {
    const batch = [eventRow(4, 'signin.ended', [OTHER]), eventRow(5, 'person.deactivated', [PERSON, OTHER])]
    const refusing: Gate = { ...coreOnlyGate, processingAllowed: () => false }
    const protective = consumer({ name: 'it_protective', role: 'hearth_job_revocation', protective: true })
    const plain = consumer()
    const p = pool({ batch })
    const { run, log } = runner(p, [protective.spec, plain.spec], { gate: refusing })
    expect(await run.round(protective.spec, ORG)).toBe('idle')
    expect(protective.handled.map(events => events.map(event => event.id))).toEqual([['4', '5']])
    expect(log.events('outbox_event_withheld')).toEqual([])
    expect(await run.round(plain.spec, ORG)).toBe('idle')
    expect(plain.handled).toEqual([])
    expect(log.events('outbox_event_withheld').map(line => line.eventId)).toEqual(['4', '5'])
    // The purpose gate still applies to a protective consumer.
    const ai = consumer({ name: 'it_protective_ai', purpose: 'org_brain', protective: true })
    const refused = runner(pool({ batch }), [ai.spec])
    expect(await refused.run.round(ai.spec, ORG)).toBe('refused')
    expect(refused.log.events('outbox_consumer_refused')).toEqual([
      expect.objectContaining({ consumer: 'it_protective_ai', reason: 'purpose_refused' }),
    ])
    expect(ai.handled).toEqual([])
  })

  it('PGT-10 C0.9 PD-07 T19 item 4: with the registers never read, or stale, revocation’s and offboarding’s consumers (accounts) are admitted and withhold nothing', async () => {
    const batch = [eventRow(4, 'signin.ended', [OTHER]), eventRow(5, 'person.deactivated', [PERSON, OTHER])]
    // Never read and stale read the same to the gate (FlagCache.register() answers undefined for
    // both); a register read whose entries would refuse anything else changes nothing for accounts.
    const unread = registerGate({ register: () => undefined })
    const refusingAllElse = registerGate({
      register: () => registerStateOf({ purposes: { accounts: { status: 'retired', basis: 'consent' } } }),
    })
    for (const gate of [unread, refusingAllElse]) {
      const offboarding = consumer({ name: 'it_offboarding' })
      const revocation = consumer({ name: 'it_revocation', role: 'hearth_job_revocation', protective: true })
      for (const { spec, handled } of [offboarding, revocation]) {
        const { run, log } = runner(pool({ batch }), [spec], { gate })
        expect(await run.round(spec, ORG)).toBe('idle')
        expect(handled.map(events => events.map(event => event.id))).toEqual([['4', '5']])
        expect(log.events('outbox_event_withheld')).toEqual([])
        expect(log.events('outbox_consumer_refused')).toEqual([])
      }
    }
  })

  it('C0.7 m4: moves the checkpoint past a round whose handle() passed over every event', async () => {
    const p = pool({ batch: [eventRow(4, 'signin.ended'), eventRow(5, 'signin.ended')] })
    const { spec } = consumer({ handle: async () => {} })
    expect(await runner(p, [spec]).run.round(spec, ORG)).toBe('idle')
    expect(p.statements.find(s => s.text.startsWith('update outbox_checkpoints'))?.values.slice(0, 3)).toEqual([
      '1005',
      '5',
      2,
    ])
    expect(p.texts().at(-1)).toBe('commit')
  })

  it('rolls back when a reset moved the checkpoint during the round, so the reset stands', async () => {
    const p = pool({ batch: [eventRow(4, 'person.deactivated')], moved: true })
    const { spec } = consumer()
    const { run, log } = runner(p, [spec])
    expect(await run.round(spec, ORG)).toBe('moved')
    expect(p.texts().at(-1)).toBe('rollback')
    expect(p.texts().some(text => text.startsWith('select public.feature_fence'))).toBe(false)
    expect(log.events('outbox_checkpoint_moved')).toHaveLength(1)
  })

  it('admits no round before the org’s flags are read, even for a feature locked on, and reads them', async () => {
    const p = pool()
    const { spec, handled } = consumer()
    const { run, flags } = runner(p, [spec])
    flags.revisionsOf.mockReturnValue(undefined as unknown as number[])
    expect(await run.round(spec, ORG)).toBe('refused')
    expect(flags.reload).toHaveBeenCalledWith(ORG)
    expect(p.statements).toEqual([])
    expect(handled).toEqual([])
  })

  it('rolls back when the fence refuses (a flag changed), and reloads the org’s flags before the next round', async () => {
    const p = pool({ batch: [eventRow(4, 'person.deactivated')], fence: pgError('HF001') })
    const { spec } = consumer()
    const { run, flags } = runner(p, [spec])
    expect(await run.round(spec, ORG)).toBe('fenced')
    expect(p.texts().at(-1)).toBe('rollback')
    expect(flags.reload).toHaveBeenCalledWith(ORG)
  })

  it('rethrows a handler’s failure after rolling back', async () => {
    const p = pool({ batch: [eventRow(4, 'person.deactivated')] })
    const failure = new Error('handler failed')
    const { spec } = consumer({
      handle: async () => {
        throw failure
      },
    })
    await expect(runner(p, [spec]).run.round(spec, ORG)).rejects.toBe(failure)
    expect(p.texts().at(-1)).toBe('rollback')
    expect(p.texts().some(text => text.startsWith('update outbox_checkpoints'))).toBe(false)
  })

  it('A3: checks an org for positions from the future once, at its first round, as hearth_queue, and stops its consumers', async () => {
    const p = pool({ future: true })
    const { spec, handled } = consumer()
    const { run, log } = runner(p, [spec])
    expect(await run.round(spec, ORG)).toBe('future')
    expect(await run.round(spec, ORG)).toBe('future')
    expect(p.texts().filter(text => text.startsWith('select greatest('))).toHaveLength(1)
    const roles = p.statements.filter(s => s.text.startsWith("select set_config('role'")).map(s => s.values[0])
    expect(roles).toEqual(['hearth_queue'])
    expect(p.texts()[0]).toBe('start transaction isolation level read committed read only')
    expect(log.events('outbox_future_rows')).toEqual([expect.objectContaining({ level: 50, org: ORG })])
    expect(handled).toEqual([])
    // Qodo-18 #1: each of the org's consumers is blocked, logged once.
    expect(run.blocked()).toEqual([{ consumer: 'it_projection', org: ORG, reason: 'future_rows' }])
    expect(log.events('outbox_consumer_blocked')).toEqual([
      expect.objectContaining({ level: 50, consumer: 'it_projection', org: ORG, reason: 'future_rows' }),
    ])
  })
})

describe('C0.6 T16 item 5 resetting a consumer (replay)', () => {
  it('waits for a round in progress on the same lock, as the consumer’s role, and moves the checkpoint', async () => {
    const p = pool()
    const { spec } = consumer()
    await ConsumerRunner.reset(p.db, spec, ORG, 'oldest')
    const texts = roundTexts(p)
    // OUTBOX-1: as long as a round's transaction may hold the lock, not withOrg()'s 2 s.
    expect(texts[0]).toBe("set local lock_timeout = '30s'")
    expect(texts[1]).toBe('select pg_advisory_xact_lock(hashtextextended($1, 0))')
    expect(texts[2]).toMatch(/^insert into outbox_checkpoints as c .* on conflict \(org_id, consumer\) do update set/)
    expect(p.statements.find(s => s.text.startsWith("select set_config('role'"))?.values[0]).toBe(
      'hearth_job_offboarding',
    )
  })

  it('refuses a position below the floor', async () => {
    const p = pool({ belowFloor: true })
    const { spec } = consumer()
    await expect(ConsumerRunner.reset(p.db, spec, ORG, { txId: '5', id: '1' })).rejects.toBeInstanceOf(BelowFloor)
    expect(p.texts().at(-1)).toBe('rollback')
    const insert = p.statements.find(s => s.text.startsWith('insert into outbox_checkpoints as c'))
    expect(insert?.text).toContain('where not exists (select 1 from outbox_floors f')
  })
})

describe('C0.6 T16 the consumers’ loop', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs each consumer over every org, polls when idle, logs failures (error after 3 in a row) and stops by the deadline', async () => {
    vi.useFakeTimers()
    let failing = true
    const p = scriptedPool((statement: Statement) => {
      if (statement.text.includes("from principals where org_id = $1 and kind = 'system'")) return [{ id: SYSTEM }]
      if (statement.text.startsWith('select greatest(')) return [{ future: false }]
      if (statement.text.startsWith('select pg_try_advisory_xact_lock')) {
        return failing ? new Error('Connection terminated unexpectedly') : [{ locked: true }]
      }
      if (statement.text.startsWith('select last_tx')) return [{ last_tx: '1', last_id: '1' }]
      if (statement.text.startsWith('with f as')) return noEvents()
      return []
    })
    const { spec } = consumer()
    let now = 0
    const log = captureLogger()
    const run = new ConsumerRunner({
      db: p.db,
      consumers: [spec],
      flags: { isOn: () => true, revisionsOf: () => [1], reload: async () => {} },
      gate: coreOnlyGate,
      logger: log.logger,
      pollMs: 500,
      now: () => now,
    })
    run.start(() => [ORG])
    await vi.advanceTimersByTimeAsync(0)
    expect(run.lastRound()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1100)
    const failures = log.events('worker_loop_failed')
    expect(failures.map(line => line.level)).toEqual([40, 40, 50])
    expect(failures[0]).toMatchObject({ loop: 'outbox:it_projection', org: ORG, failure: { error: 'Error' } })
    expect(JSON.stringify(failures)).not.toContain('terminated')
    failing = false
    now = 2000
    await vi.advanceTimersByTimeAsync(600)
    expect(run.lastRound()).toBe(2000)
    const rounds = p.texts().filter(text => text.startsWith('select pg_try_advisory_xact_lock')).length
    await vi.advanceTimersByTimeAsync(500)
    expect(p.texts().filter(text => text.startsWith('select pg_try_advisory_xact_lock')).length).toBe(rounds + 1)
    await run.stop(now + 100)
    const after = p.texts().length
    await vi.advanceTimersByTimeAsync(5000)
    expect(p.texts().length).toBe(after)
  })

  it('counts a block only in an org it still serves, and forgets an org that has left the list', async () => {
    const p = pool({ batch: noEvents(['950', '3'], true) })
    const { spec } = consumer()
    const { run } = runner(p, [spec])
    let orgs = [ORG, OTHER_ORG]
    expect(await run.round(spec, ORG)).toBe('behind')
    expect(await run.round(spec, OTHER_ORG)).toBe('behind')
    expect(run.blocked()).toHaveLength(2)
    run.start(() => orgs)
    // A round that ends after its org left the list (the worker forgot it first) can't block.
    orgs = [ORG]
    expect(run.blocked()).toEqual([{ consumer: 'it_projection', org: ORG, reason: 'behind_floor' }])
    run.forget(OTHER_ORG)
    orgs = [ORG, OTHER_ORG]
    expect(run.blocked()).toEqual([{ consumer: 'it_projection', org: ORG, reason: 'behind_floor' }])
    run.forget(ORG)
    expect(run.blocked()).toEqual([])
    await run.stop(performance.now() + 1000)
  })

  it('refuses two consumers with one name', () => {
    const { spec } = consumer()
    expect(() => runner(pool(), [spec, spec])).toThrow(/two outbox consumers/)
  })
})
