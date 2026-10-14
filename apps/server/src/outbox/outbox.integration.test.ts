// The outbox against the Compose stack's Postgres (TECH-SPEC T16; BUILD-PLAN C0.6's "exactly once
// in effect" and the C0 exit's "rolled-back writes emit nothing; replay rebuilds identical
// projections"): real routes append the events, and a test consumer, run by the ConsumerRunner as
// hearth_job_offboarding on hearth_worker's login, records every delivery in it_deliveries, which
// has no unique constraint, so a duplicate shows up rather than merging. The worker's own loops
// (claims, kill, zombies, the offboarding consumer) are tested with the worker.
//
// Cases that purge the outbox run last, after every case that replays from the oldest event.

import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type InOrg, withOrg } from '#src/db/database.ts'
import type { FlagCache } from '#src/flags/cache.ts'
import { C06_GATE } from '#src/jobs/gate.ts'
import { appendOutbox } from '#src/outbox/append.ts'
import { BelowFloor, ConsumerRunner, type OutboxConsumer, type RoundResult } from '#src/outbox/consumers.ts'
import { readOutboxLag, readQueueDepth } from '#src/outbox/lag.ts'
import { captureLogger } from '#src/testing/logs.ts'
import type { Person, Stack } from '#src/testing/stack.ts'
import { startStack } from '#src/testing/stack.ts'
import { expectEveryWriteCovered } from '#src/testing/writes.ts'

let s: Stack
let flags: FlagCache
const log = captureLogger()

// Every event a round handled, recorded in the round's own transaction.
function consumer(name: string, change: Partial<OutboxConsumer> = {}): OutboxConsumer {
  return {
    name,
    role: 'hearth_job_offboarding',
    feature: 'core.system',
    purpose: 'accounts',
    types: ['signin.started', 'signin.ended', 'account.pin_set', 'person.deactivated', 'acl.changed'],
    start: 'oldest',
    batch: 3,
    lagBudgetMs: 10_000,
    handle: async (trx: InOrg, events, { orgId }) => {
      for (const event of events) {
        await sql`insert into it_deliveries (org_id, consumer, event_id, type)
          values (${orgId}, ${name}, ${event.id}, ${event.type})`.execute(trx)
      }
    },
    ...change,
  }
}

const runner = (consumers: OutboxConsumer[]) =>
  new ConsumerRunner({ db: s.worker, consumers, flags, gate: C06_GATE, logger: log.logger, pollMs: 100 })

// Runs rounds until one finds nothing more to read.
async function drain(run: ConsumerRunner, spec: OutboxConsumer): Promise<RoundResult[]> {
  const results: RoundResult[] = []
  for (let n = 0; n < 200; n++) {
    const result = await run.round(spec, s.org.id)
    results.push(result)
    if (result !== 'full') return results
  }
  throw new Error('the consumer never caught up')
}

// The events a consumer of these types reads, in the order it must read them.
const eventsInOrder = () =>
  s.query<{ id: string; type: string }>(
    `select e.id::text as id, e.type from outbox_events e where e.org_id = $1
       and e.type in ('signin.started', 'signin.ended', 'account.pin_set', 'person.deactivated', 'acl.changed')
     order by e.tx_id, e.id`,
    [s.org.id],
  )
const deliveries = (name: string) =>
  s.query<{ event_id: string; type: string }>(
    'select d.event_id::text as event_id, d.type from it_deliveries d where d.consumer = $1 order by d.round_xid, d.event_id',
    [name],
  )
const checkpoint = async (name: string) =>
  (
    await s.query<{ last_tx: string; last_id: string; processed: string }>(
      'select last_tx::text, last_id::text, processed::text from outbox_checkpoints where org_id = $1 and consumer = $2',
      [s.org.id, name],
    )
  )[0]
const head = async () =>
  (
    await s.query<{ tx_id: string; id: string }>(
      'select e.tx_id::text as tx_id, e.id::text as id from outbox_events e where e.org_id = $1 order by e.tx_id desc, e.id desc limit 1',
      [s.org.id],
    )
  )[0]

describe('C0.6 T16 the outbox on the Compose stack: delivered once, in order, replayable', () => {
  let admin: Person

  beforeAll(async () => {
    s = await startStack()
    // The test consumer's projection: org-scoped, under the standard policy, granted to the role
    // the test consumer runs as. Grants are per database, so nothing reaches another run's.
    await s.query(`
      create table it_deliveries (
        org_id uuid not null, consumer text not null, event_id bigint not null, type text not null,
        round_xid xid8 not null default pg_current_xact_id());
      alter table it_deliveries enable row level security;
      create policy org_isolation on it_deliveries
        using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
        with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
      grant select, insert on it_deliveries to hearth_job_offboarding`)
    flags = s.flagCache({ as: 'hearth_queue' })
    await flags.track(s.org.id)
    admin = await s.person({ roles: ['admin'], pin: s.newPin() })
  })

  // biome-ignore lint/correctness/noEmptyPattern: the hook takes no fixtures.
  afterAll(async ({}, suite) => {
    if (s === undefined) return
    try {
      const all = suite.tasks.every(task => task.type !== 'test' || task.result?.state === 'pass')
      await expectEveryWriteCovered(s.superuser, 'outbox', { allPassed: all && suite.tasks.length > 0 })
    } finally {
      await s.stop()
    }
  })

  it('C0 exit: a rolled-back write appends nothing, and a committed one appends its event with it', async () => {
    const person = await s.person()
    const append = (trx: InOrg) =>
      appendOutbox(trx, {
        orgId: s.org.id,
        type: 'person.deactivated',
        entity: { type: 'person', id: person.id },
        subjects: [person.id],
        purpose: 'accounts',
        ids: {},
      })
    await expect(
      withOrg(s.db, { orgId: s.org.id, userId: admin.id }, async trx => {
        await append(trx)
        throw new Error('rolled back')
      }),
    ).rejects.toThrow('rolled back')
    const about = () => s.query('select 1 from outbox_events where entity_id = $1', [person.id])
    expect(await about()).toHaveLength(0)
    await withOrg(s.db, { orgId: s.org.id, userId: admin.id }, append)
    expect(await about()).toHaveLength(1)
  })

  it('T16: delivers every committed event once, in (tx_id, id) order, and moves the checkpoint with its effects', async () => {
    for (let n = 0; n < 3; n++) await s.signIn(await s.person())
    const spec = consumer('it_projection')
    const run = runner([spec])
    // The first round makes the checkpoint at the oldest kept event, and ends there.
    expect(await run.round(spec, s.org.id)).toBe('full')
    expect(await checkpoint('it_projection')).toMatchObject({ last_tx: '0', last_id: '0', processed: '0' })
    const results = await drain(run, spec)
    expect(results.at(-1)).toBe('idle')
    const expected = await eventsInOrder()
    expect(expected.length).toBeGreaterThanOrEqual(7)
    expect(await deliveries('it_projection')).toEqual(expected.map(event => ({ event_id: event.id, type: event.type })))
    const top = await head()
    expect(await checkpoint('it_projection')).toMatchObject({ last_tx: top?.tx_id, last_id: top?.id })
    // Nothing new: a round reads nothing and writes nothing.
    expect(await run.round(spec, s.org.id)).toBe('idle')
    expect(await deliveries('it_projection')).toHaveLength(expected.length)
  })

  it('T16 item 5: a replay from the oldest kept event delivers every event again, once more each, and counts them', async () => {
    const spec = consumer('it_projection')
    const run = runner([spec])
    const before = await checkpoint('it_projection')
    const delivered = (await deliveries('it_projection')).length
    await ConsumerRunner.reset(s.worker, spec, s.org.id, 'oldest')
    expect(await checkpoint('it_projection')).toMatchObject({ last_tx: '0', last_id: '0' })
    await drain(run, spec)
    const events = await eventsInOrder()
    const twice = await deliveries('it_projection')
    expect(twice).toHaveLength(delivered * 2)
    for (const event of events)
      expect(
        twice.filter(d => d.event_id === event.id),
        event.id,
      ).toHaveLength(2)
    const after = await checkpoint('it_projection')
    expect(after).toMatchObject({ last_tx: before?.last_tx, last_id: before?.last_id })
    expect(Number(after?.processed)).toBeGreaterThanOrEqual(Number(before?.processed) + events.length)
  })

  it('T16 items 1 and 2: an event committed behind a transaction still running waits for it, and none is skipped', async () => {
    const spec = consumer('it_projection')
    const run = runner([spec])
    await drain(run, spec)
    const delivered = (await deliveries('it_projection')).length
    const [a, b] = [await s.person(), await s.person()]
    const deactivated = (person: Person) => (trx: InOrg) =>
      appendOutbox(trx, {
        orgId: s.org.id,
        type: 'person.deactivated',
        entity: { type: 'person', id: person.id },
        subjects: [person.id],
        purpose: 'accounts',
        ids: {},
      })
    // A appends first (the lower transaction id) and stays open; B appends and commits.
    let commitA: () => void = () => {}
    const held = new Promise<void>(resolve => {
      commitA = resolve
    })
    let appended: () => void = () => {}
    const aAppended = new Promise<void>(resolve => {
      appended = resolve
    })
    const writerA = withOrg(s.db, { orgId: s.org.id, userId: admin.id }, async trx => {
      await deactivated(a)(trx)
      appended()
      await held
    })
    await aAppended
    await withOrg(s.db, { orgId: s.org.id, userId: admin.id }, deactivated(b))
    // B's event is committed but sits behind A, which is still running: nothing past A is read.
    expect(await run.round(spec, s.org.id)).toBe('idle')
    expect(await deliveries('it_projection')).toHaveLength(delivered)
    commitA()
    await writerA
    await drain(run, spec)
    const late = (await deliveries('it_projection')).slice(delivered)
    const ids = await s.query<{ entity_id: string; id: string }>(
      "select e.entity_id, e.id::text as id from outbox_events e where e.type = 'person.deactivated' and e.entity_id = any($1) order by e.tx_id, e.id",
      [[a.id, b.id]],
    )
    expect(ids.map(row => row.entity_id)).toEqual([a.id, b.id])
    expect(late).toEqual(ids.map(row => ({ event_id: row.id, type: 'person.deactivated' })))
  })

  it('T16 item 19: the lag lines read the outbox as hearth_queue, and the queue depth', async () => {
    const spec = consumer('it_projection')
    await drain(runner([spec]), spec)
    expect((await readOutboxLag(s.worker, s.org.id)).find(line => line.consumer === 'it_projection')).toMatchObject({
      eventsBehind: 0,
      secondsBehind: 0,
      heldBackEvents: 0,
    })
    await s.signIn(await s.person())
    const behind = (await readOutboxLag(s.worker, s.org.id)).find(line => line.consumer === 'it_projection')
    expect(behind?.eventsBehind).toBe(2)
    expect(behind?.secondsBehind).toBeGreaterThanOrEqual(0)
    expect(await readQueueDepth(s.worker, s.org.id)).toEqual({
      org: s.org.id,
      queued: 0,
      running: 0,
      dead: 0,
      interrupted: 0,
      oldestQueuedSeconds: 0,
    })
    await drain(runner([spec]), spec)
  })

  it('A3: a consumer stops for an org whose stored positions are ahead of the cluster, logging it once', async () => {
    await s.query(
      `insert into outbox_checkpoints (org_id, consumer, role_name, last_tx, last_id)
       values ($1, 'it_future', 'hearth_job_offboarding', '999999999999', 1)`,
      [s.org.id],
    )
    try {
      const spec = consumer('it_projection')
      const run = runner([spec])
      expect(await run.round(spec, s.org.id)).toBe('future')
      expect(await run.round(spec, s.org.id)).toBe('future')
      expect(log.events('outbox_future_rows').filter(line => line.org === s.org.id)).toHaveLength(1)
    } finally {
      await s.query("delete from outbox_checkpoints where consumer = 'it_future'")
    }
  })

  it('T16 item 6: after a clean-up, a consumer below the floor stops, and one starting at the oldest kept event misses nothing', async () => {
    const spec = consumer('it_projection')
    const run = runner([spec])
    await drain(run, spec)
    // The consumer back at the beginning, then every event so far 15 days old, and the clean-up.
    await ConsumerRunner.reset(s.worker, spec, s.org.id, 'oldest')
    await s.query("update outbox_events set at = at - interval '15 days' where org_id = $1", [s.org.id])
    const purged = await withOrg(s.worker, { orgId: s.org.id, system: true, as: 'hearth_job_purge' }, async trx => {
      const { rows } = await sql<{ n: number }>`select public.purge_outbox(5000) as n`.execute(trx)
      return rows[0]?.n ?? 0
    })
    expect(purged).toBeGreaterThan(0)
    expect(await s.query('select 1 from outbox_events where org_id = $1', [s.org.id])).toHaveLength(0)
    const [floor] = await s.query<{ last_tx: string; last_id: string }>(
      'select last_tx::text, last_id::text from outbox_floors where org_id = $1',
      [s.org.id],
    )
    expect(floor).toBeDefined()
    expect(
      await s.query(
        "select details from audit_events where action = 'maintenance.purge' and target_type = 'outbox_events'",
      ),
    ).toEqual([{ details: { rows: purged, floor_tx: floor?.last_tx, floor_id: Number(floor?.last_id) } }])

    // Below the floor: it stops, logs an error once, and handles nothing past it.
    const delivered = (await deliveries('it_projection')).length
    expect(await run.round(spec, s.org.id)).toBe('behind')
    expect(await run.round(spec, s.org.id)).toBe('behind')
    expect(log.events('outbox_consumer_fell_behind').filter(line => line.consumer === 'it_projection')).toHaveLength(1)
    await expect(ConsumerRunner.reset(s.worker, spec, s.org.id, { txId: '0', id: '0' })).rejects.toBeInstanceOf(
      BelowFloor,
    )

    // New events, then a new consumer starting at the oldest kept event: the floor.
    await s.signIn(await s.person())
    const fresh = consumer('it_second')
    const second = runner([fresh])
    await drain(second, fresh)
    expect(await checkpoint('it_second')).toBeDefined()
    const remaining = await eventsInOrder()
    expect(remaining).toHaveLength(2)
    expect(await deliveries('it_second')).toEqual(remaining.map(event => ({ event_id: event.id, type: event.type })))
    // The first, reset to the oldest kept event, catches up on the same events once.
    await ConsumerRunner.reset(s.worker, spec, s.org.id, 'oldest')
    expect(await checkpoint('it_projection')).toMatchObject({ last_tx: floor?.last_tx, last_id: floor?.last_id })
    await drain(run, spec)
    expect((await deliveries('it_projection')).slice(delivered)).toEqual(
      remaining.map(event => ({ event_id: event.id, type: event.type })),
    )
  })
})
