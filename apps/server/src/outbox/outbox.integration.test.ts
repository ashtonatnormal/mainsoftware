// The outbox against the Compose stack's Postgres (TECH-SPEC T16; BUILD-PLAN C0.6's "exactly once
// in effect" and the C0 exit's "rolled-back writes emit nothing; replay rebuilds identical
// projections"): real routes append the events, and a test consumer, run by the ConsumerRunner as
// hearth_job_offboarding on hearth_worker's login, records every delivery in it_deliveries, which
// has no unique constraint, so a duplicate shows up rather than merging. The cases under "with the
// worker" (T16 items 1 to 5) run the consumer in worker instances (testing/stack.ts
// startWorker), which fail mid-round, lose their connection, are killed after a commit, and run
// three at once while writers commit; the job queue's own cases are in jobs/jobs.integration.test.ts.
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
import { lockConsumer, type OutboxRow } from '#src/outbox/positions.ts'
import { installJobTables } from '#src/testing/jobs.ts'
import { captureLogger } from '#src/testing/logs.ts'
import type { Person, Stack } from '#src/testing/stack.ts'
import { startStack } from '#src/testing/stack.ts'
import { everyTestPassed, expectEveryWriteCovered } from '#src/testing/writes.ts'

let s: Stack
let flags: FlagCache
const log = captureLogger()

// Polls every 20 ms until check passes, for at most `ms`.
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (check(value)) return value
    if (Date.now() > deadline) throw new Error(`still not as expected after ${ms} ms: ${JSON.stringify(value)}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

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
    'select d.event_id::text as event_id, d.type from it_deliveries d where d.consumer = $1 order by d.seq',
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
    // The test consumers' tables (it_deliveries, it_effects, it_projection, it_fail_next):
    // org-scoped, under the standard policy, granted to the role the test consumers run as. Grants
    // are per database, so nothing reaches another run's.
    await installJobTables(s)
    flags = s.flagCache({ as: 'hearth_queue' })
    await flags.track(s.org.id)
    admin = await s.person({ roles: ['admin'], pin: s.newPin() })
  })

  // biome-ignore lint/correctness/noEmptyPattern: the hook takes no fixtures.
  afterAll(async ({}, suite) => {
    if (s === undefined) return
    try {
      // No Node warning fired (pg's for a query sent to a client already running one included).
      expect(s.warnings.map(warning => `${warning.name}: ${warning.message}`)).toEqual([])
      await expectEveryWriteCovered(s.superuser, 'outbox', { allPassed: everyTestPassed(suite) })
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

  it('OUTBOX-1 T16 item 5: a reset waits for a round that holds the consumer’s lock longer than 2 s', async () => {
    const spec = consumer('it_reset_wait')
    let held: () => void = () => {}
    const holding = new Promise<void>(resolve => {
      held = resolve
    })
    // A round's lock, held for 3 s.
    const round = withOrg(s.worker, { orgId: s.org.id, system: true, as: spec.role }, async trx => {
      await lockConsumer(trx, spec.name, s.org.id)
      held()
      await sleep(3000)
    })
    await holding
    const started = Date.now()
    await ConsumerRunner.reset(s.worker, spec, s.org.id, 'now')
    expect(Date.now() - started).toBeGreaterThanOrEqual(2500)
    await round
    expect(await checkpoint('it_reset_wait')).toBeDefined()
    await s.query("delete from outbox_checkpoints where consumer = 'it_reset_wait'")
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

  it('C0 exit T16 item 4: a real route whose transaction fails after all its writes leaves no account, session or event; the next sign-in emits each once', async () => {
    const person = await s.person()
    // The set-PIN request writes the account, the PIN, the device, the session and their events,
    // then fails at its last audit row.
    await s.query("insert into it_fail_next (action) values ('auth.pin_set')")
    try {
      const browser = s.client()
      expect((await browser.post('/api/auth/otp/request', { phone: person.e164 })).status).toBe(200)
      const verified = await browser.post('/api/auth/otp/verify', { code: await s.sms.nextCode(person.e164) })
      expect(verified.json<{ next: string }>().next).toBe('set_pin')
      const failed = await browser.post('/api/auth/pin/set', { pin: s.newPin() })
      expect([failed.status, failed.error]).toEqual([500, 'internal'])
    } finally {
      await s.query("delete from it_fail_next where action = 'auth.pin_set'")
    }
    const about = () =>
      s.query<{ type: string }>(
        'select type from outbox_events where entity_id = $1 or $1 = any(subject_ids) order by tx_id, id',
        [person.id],
      )
    expect(await s.query('select 1 from users where id = $1', [person.id])).toEqual([])
    expect(await s.query('select 1 from sessions where user_id = $1', [person.id])).toEqual([])
    expect(await s.query('select 1 from devices where user_id = $1', [person.id])).toEqual([])
    expect(await about()).toEqual([])
    // A fresh sign-in (the first consumed its attempt) commits each once.
    await s.signIn(person)
    expect((await about()).map(row => row.type).sort()).toEqual(['account.pin_set', 'signin.started'])
  })

  describe('with the worker (T16 items 1 to 5)', () => {
    // The worker's test consumer: for each event it re-reads the person's state and
    // upserts their projection row (convergent), records a one-off effect per event in it_effects
    // (deduplicated, as a push would be) and every delivery in it_deliveries (never deduplicated,
    // so a duplicate shows), all in the round's transaction. `hook` runs after a batch's effects.
    let hook: ((trx: InOrg, events: readonly OutboxRow[]) => Promise<void>) | undefined
    const PROJECTED = [
      'signin.started',
      'signin.ended',
      'account.pin_set',
      'account.pin_reset',
      'account.passkey_added',
      'account.passkey_removed',
      'person.deactivated',
    ] as const
    const projection = (name: string, batch = 50): OutboxConsumer => ({
      name,
      role: 'hearth_job_offboarding',
      feature: 'core.system',
      purpose: 'accounts',
      types: PROJECTED,
      start: 'oldest',
      batch,
      lagBudgetMs: 10_000,
      handle: async (trx, events, { orgId }) => {
        for (const event of events) {
          await sql`insert into it_projection (org_id, person_id, deactivated, live_sessions, passkeys)
            select ${orgId}, p.id, p.deactivated_at is not null,
              (select count(*) from sessions x
               where x.org_id = p.org_id and x.user_id = p.id and x.revoked_at is null and x.expires_at > now()),
              (select count(*) from passkeys k where k.org_id = p.org_id and k.user_id = p.id and k.removed_at is null)
            from people p where p.org_id = ${orgId} and p.id = ${event.entity.id}
            on conflict (person_id) do update set deactivated = excluded.deactivated,
              live_sessions = excluded.live_sessions, passkeys = excluded.passkeys`.execute(trx)
          await sql`insert into it_effects (org_id, consumer, event_id, type)
            values (${orgId}, ${name}, ${event.id}, ${event.type}) on conflict do nothing`.execute(trx)
          await sql`insert into it_deliveries (org_id, consumer, event_id, type)
            values (${orgId}, ${name}, ${event.id}, ${event.type})`.execute(trx)
        }
        await hook?.(trx, events)
      },
    })
    const worker = (consumers: OutboxConsumer[]) => s.startWorker({ consumers, productionConsumers: false })

    // Every committed event of the projected types, and how often the consumer delivered each.
    const deliveryCounts = (name: string) =>
      s.query<{ id: string; n: number }>(
        `select e.id::text as id, count(d.event_id)::int as n from outbox_events e
         left join it_deliveries d on d.event_id = e.id and d.consumer = $1
         where e.org_id = $2 and e.type = any($3) group by e.id order by e.id`,
        [name, s.org.id, [...PROJECTED]],
      )
    const atHead = async (name: string) => {
      const [top, at] = [await head(), await checkpoint(name)]
      return top !== undefined && at?.last_tx === top.tx_id && at.last_id === top.id
    }
    const caughtUp = (name: string, ms = 15_000) =>
      eventually(
        () => atHead(name),
        done => done,
        ms,
      )
    const expectDeliveredOnce = async (name: string) => {
      const counts = await deliveryCounts(name)
      expect(counts.length).toBeGreaterThan(0)
      expect(counts.filter(row => row.n !== 1)).toEqual([])
    }
    const projectionHash = async () =>
      (
        await s.query<{ hash: string }>(
          `select md5(coalesce(string_agg(format('%s:%s:%s:%s', person_id, deactivated, live_sessions, passkeys), ','
                    order by person_id), '')) as hash from it_projection where org_id = $1`,
          [s.org.id],
        )
      )[0]?.hash
    // Events no route need make: a PIN set, as the person (ids only, no write).
    const pinSet = (person: Person) => (trx: InOrg) =>
      appendOutbox(trx, {
        orgId: s.org.id,
        type: 'account.pin_set',
        entity: { type: 'person', id: person.id },
        subjects: [person.id],
        purpose: 'accounts',
        ids: {},
      })
    const appendPinSets = async (count: number) => {
      for (let n = 0; n < count; n++) {
        const person = await s.person()
        await withOrg(s.db, { orgId: s.org.id, userId: admin.id }, pinSet(person))
      }
    }

    it('T16 item 4: a round that fails after writing its effects commits none of them, and the next round applies the batch once', async () => {
      await appendPinSets(4)
      let failed = false
      hook = async () => {
        if (failed) return
        failed = true
        throw new Error('the round fails after its effects')
      }
      const w = await worker([projection('it_w')])
      try {
        await caughtUp('it_w')
        expect(failed).toBe(true)
        await expectDeliveredOnce('it_w')
        expect(s.logs.filter(line => line.event === 'worker_loop_failed' && line.loop === 'outbox:it_w')).toHaveLength(
          1,
        )
      } finally {
        hook = undefined
        await w.stop()
      }
    })

    it('T16 item 4: a round whose connection dies between its effects and its checkpoint commits nothing, and the next applies it once', async () => {
      await appendPinSets(3)
      let pid: number | undefined
      let release: () => void = () => {}
      const held = new Promise<void>(resolve => {
        release = resolve
      })
      hook = async trx => {
        if (pid !== undefined) return
        pid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx)).rows[0]?.pid ?? 0
        await held
      }
      const w = await worker([projection('it_w')])
      try {
        await eventually(
          async () => pid,
          value => value !== undefined,
        )
        await s.query('select pg_terminate_backend($1)', [pid])
        release()
        await caughtUp('it_w')
        await expectDeliveredOnce('it_w')
      } finally {
        hook = undefined
        await w.stop()
      }
    })

    it('T16 items 3 and 4: a worker killed right after a batch commits; another resumes from the stored checkpoint, delivering each event once', async () => {
      await appendPinSets(12)
      let committedUpTo: string | undefined
      hook = async (_trx, events) => {
        committedUpTo ??= events.at(-1)?.id
      }
      const a = await worker([projection('it_w', 3)])
      try {
        // The batch's checkpoint has committed: kill the worker before it knows any more.
        await eventually(
          async () =>
            committedUpTo !== undefined &&
            (
              await s.query('select 1 from it_deliveries where consumer = $1 and event_id = $2', [
                'it_w',
                committedUpTo,
              ])
            ).length === 1,
          done => done,
        )
      } finally {
        await a.kill()
      }
      hook = undefined
      const b = await worker([projection('it_w', 3)])
      try {
        await caughtUp('it_w')
        await expectDeliveredOnce('it_w')
      } finally {
        await b.stop()
      }
    })

    it('T16 items 1, 3 and 4: three workers run one consumer while 8 writers commit 200 events, 10% rolled back: each committed event is delivered once, in order', async () => {
      // One after another: the harness sends every query through one client (R2TESTS-2).
      const people: Awaited<ReturnType<typeof s.person>>[] = []
      for (let i = 0; i < 40; i++) people.push(await s.person())
      const workers = await Promise.all([1, 2, 3].map(() => worker([projection('it_w6', 10)])))
      try {
        let rolledBack = 0
        const writers = Array.from({ length: 8 }, async (_, w) => {
          for (let i = 0; i < 25; i++) {
            const person = people[(w * 25 + i) % people.length] as Person
            const rollBack = (w * 25 + i) % 10 === 3
            try {
              await withOrg(s.db, { orgId: s.org.id, userId: admin.id }, async trx => {
                // The first of a third of the people leaves for real; every other event is a PIN set.
                const left =
                  people.indexOf(person) % 3 === 0
                    ? await trx
                        .updateTable('people')
                        .set({ deactivated_at: sql<Date>`now()`, deactivated_by: admin.id })
                        .where('org_id', '=', s.org.id)
                        .where('id', '=', person.id)
                        .where('deactivated_at', 'is', null)
                        .returning('id')
                        .execute()
                    : []
                if (left.length > 0) {
                  await appendOutbox(trx, {
                    orgId: s.org.id,
                    type: 'person.deactivated',
                    entity: { type: 'person', id: person.id },
                    subjects: [person.id],
                    purpose: 'accounts',
                    ids: {},
                  })
                } else {
                  await pinSet(person)(trx)
                }
                if (rollBack) throw new Error('rolled back')
              })
            } catch (error) {
              if ((error as Error).message !== 'rolled back') throw error
              rolledBack++
            }
          }
        })
        await Promise.all(writers)
        expect(rolledBack).toBe(20)
        await caughtUp('it_w6', 30_000)
        await expectDeliveredOnce('it_w6')
        // Nothing delivered that didn't commit, and the deliveries, round by round, only move forward.
        const order = await s.query<{ tx_id: string; id: string; known: boolean }>(
          `select e.tx_id::text, d.event_id::text as id, e.id is not null as known from it_deliveries d
           left join outbox_events e on e.id = d.event_id
           where d.consumer = 'it_w6' order by d.seq`,
        )
        expect(order.every(row => row.known)).toBe(true)
        for (let n = 1; n < order.length; n++) {
          const [before, after] = [order[n - 1], order[n]]
          const forward =
            BigInt(after?.tx_id ?? 0) > BigInt(before?.tx_id ?? 0) ||
            (after?.tx_id === before?.tx_id && BigInt(after?.id ?? 0) > BigInt(before?.id ?? 0))
          expect(forward, `delivery ${n} went back`).toBe(true)
        }
        // Three instances, one consumer: the others' rounds found it busy, never failed.
        expect(s.logs.filter(line => line.event === 'worker_loop_failed' && line.loop === 'outbox:it_w6')).toEqual([])
        const [{ left } = { left: 0 }] = await s.query<{ left: number }>(
          'select count(*)::int as left from it_projection where org_id = $1 and deactivated',
          [s.org.id],
        )
        expect(left).toBeGreaterThan(0)
      } finally {
        await Promise.all(workers.map(w => w.stop()))
      }
    })

    it('C0 exit T16 item 5: a replay rebuilds the identical projection, whole or in two parts', async () => {
      const incremental = await projectionHash()
      const spec = projection('it_w6', 10)
      const rebuild = async (twoParts: boolean) => {
        await s.query('delete from it_projection; delete from it_effects')
        await ConsumerRunner.reset(s.worker, spec, s.org.id, 'oldest')
        if (twoParts) {
          // Part of the way, then killed, then another worker tails from the stored checkpoint.
          const total = (await s.query('select 1 from outbox_events where org_id = $1', [s.org.id])).length
          const first = await worker([spec])
          await eventually(
            async () => Number((await checkpoint('it_w6'))?.processed ?? 0),
            n => n >= total / 2,
            15_000,
          ).finally(() => first.kill())
        }
        const rest = await worker([spec])
        try {
          await caughtUp('it_w6')
        } finally {
          await rest.stop()
        }
        return projectionHash()
      }
      expect(await rebuild(false)).toBe(incremental)
      expect(await rebuild(true)).toBe(incremental)
    })

    it('T16 items 4 and 5: a duplicate delivery (a replay from the oldest event) changes neither the projection nor the one-off effects', async () => {
      const spec = projection('it_w6', 10)
      const [hash, effects, before, processed] = [
        await projectionHash(),
        await s.query('select consumer, event_id from it_effects order by consumer, event_id'),
        await deliveryCounts('it_w6'),
        Number((await checkpoint('it_w6'))?.processed),
      ]
      await ConsumerRunner.reset(s.worker, spec, s.org.id, 'oldest')
      const w = await worker([spec])
      try {
        await caughtUp('it_w6')
      } finally {
        await w.stop()
      }
      expect(await projectionHash()).toBe(hash)
      expect(await s.query('select consumer, event_id from it_effects order by consumer, event_id')).toEqual(effects)
      // Every event was delivered once more, and counted.
      const after = await deliveryCounts('it_w6')
      expect(after.map(row => ({ id: row.id, n: row.n - 1 }))).toEqual(before)
      const all = (await s.query('select 1 from outbox_events where org_id = $1', [s.org.id])).length
      expect(Number((await checkpoint('it_w6'))?.processed)).toBe(processed + all)
    })

    it('T16 item 1: two writes to one person, the lower transaction id committing second: the projection ends at the final state', async () => {
      const person = await s.person()
      let commitFirst: () => void = () => {}
      const held = new Promise<void>(resolve => {
        commitFirst = resolve
      })
      let appended: () => void = () => {}
      const firstAppended = new Promise<void>(resolve => {
        appended = resolve
      })
      // The first transaction (lower xid) sets nothing but appends, and stays open.
      const first = withOrg(s.db, { orgId: s.org.id, userId: admin.id }, async trx => {
        await pinSet(person)(trx)
        appended()
        await held
      })
      await firstAppended
      // The second deactivates the person and commits first.
      await withOrg(s.db, { orgId: s.org.id, userId: admin.id }, async trx => {
        await trx
          .updateTable('people')
          .set({ deactivated_at: sql<Date>`now()`, deactivated_by: admin.id })
          .where('org_id', '=', s.org.id)
          .where('id', '=', person.id)
          .execute()
        await appendOutbox(trx, {
          orgId: s.org.id,
          type: 'person.deactivated',
          entity: { type: 'person', id: person.id },
          subjects: [person.id],
          purpose: 'accounts',
          ids: {},
        })
      })
      const w = await worker([projection('it_w')])
      try {
        await sleep(300)
        commitFirst()
        await first
        await caughtUp('it_w')
        expect(await s.query('select deactivated from it_projection where person_id = $1', [person.id])).toEqual([
          { deactivated: true },
        ])
        await expectDeliveredOnce('it_w')
      } finally {
        await w.stop()
      }
    })

    it('T16 items 2 and 19: a long transaction holds consumers back without anything skipped; outbox_lag shows what it holds', async () => {
      const w = await worker([projection('it_w')])
      try {
        await caughtUp('it_w')
        const person = await s.person()
        let commitLong: () => void = () => {}
        const held = new Promise<void>(resolve => {
          commitLong = resolve
        })
        let appended: () => void = () => {}
        const longAppended = new Promise<void>(resolve => {
          appended = resolve
        })
        const long = withOrg(s.db, { orgId: s.org.id, userId: admin.id }, async trx => {
          await pinSet(person)(trx)
          appended()
          await held
        })
        await longAppended
        for (let i = 0; i < 3; i++) {
          await withOrg(s.db, { orgId: s.org.id, userId: admin.id }, pinSet(await s.person()))
        }
        const linesBefore = s.logs.length
        // 3 s held: nothing past the open transaction is delivered, and the lag line says so.
        await sleep(3000)
        const delivered = await s.query<{ n: number }>(
          "select count(*)::int as n from it_deliveries d join outbox_events e on e.id = d.event_id where d.consumer = 'it_w' and e.entity_id = any($1)",
          [[person.id]],
        )
        expect(delivered).toEqual([{ n: 0 }])
        const lag = s.logs
          .slice(linesBefore)
          .filter(line => line.event === 'outbox_lag' && line.consumer === 'it_w' && Number(line.heldBackEvents) > 0)
        expect(lag.length).toBeGreaterThan(0)
        expect(Number(lag.at(-1)?.heldBackSeconds)).toBeGreaterThan(1)
        commitLong()
        await long
        await caughtUp('it_w')
        await expectDeliveredOnce('it_w')
      } finally {
        await w.stop()
      }
    })
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

    // Qodo-18 #1: a worker running it is not ready, and says which consumer, org and why, until a
    // reset moves it; its loops run on all the while.
    const w = await s.startWorker({ consumers: [spec], productionConsumers: false })
    try {
      const readiness = () =>
        w.worker.check(new AbortController().signal).then(
          () => 'ready',
          (error: Error) => error.message,
        )
      expect(
        await eventually(readiness, message => message.includes('blocked')),
      ).toContain(`the outbox consumer it_projection is blocked in org ${s.org.id}: behind_floor`)
      expect(w.worker.consumers.lastRound()).toBeDefined()
      await ConsumerRunner.reset(s.worker, spec, s.org.id, 'oldest')
      await eventually(readiness, message => message === 'ready')
    } finally {
      await w.stop()
    }

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
