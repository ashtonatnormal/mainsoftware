// The job queue and the scheduler against the Compose stack (BUILD-PLAN C0.6's "Done when":
// exactly once in effect; TECH-SPEC T15): worker instances (testing/stack.ts startWorker) on their
// own pools as hearth_worker, at the test policy's short intervals (leases of 2 s, the sweep every
// 0.5 s, polls every 100 ms). The test kinds run as hearth_job_offboarding and write to the
// harness's test tables (testing/jobs.ts), which never deduplicate, so a job's effect committed
// twice shows as two rows. Durable revocation (T16 item 9, T19 item 4) runs through the real api, the
// production consumers and the production handler jobs.
//
// Each case starts and stops its own instances, which know only the kinds the case gives them (and
// the production ones), so no instance runs another case's jobs. Waits poll every 20 ms up to a
// deadline far above the expected time.
import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { withOrg } from '#src/db/database.ts'
import type { JobContext } from '#src/jobs/context.ts'
import { enqueue } from '#src/jobs/enqueue.ts'
import { defineJob, type JobKind, type ScheduleDef } from '#src/jobs/kinds.ts'
import { offboardingJob, offboardingRegistry } from '#src/offboarding.ts'
import { RevocationPayload, revocationJob, revocationRegistry } from '#src/revocation/registry.ts'
import { installJobTables } from '#src/testing/jobs.ts'
import {
  NO_PERIODIC_RECHECK,
  type Opened,
  type Person,
  type Stack,
  startStack,
  type WorkerInstance,
} from '#src/testing/stack.ts'
import { everyTestPassed, expectEveryWriteCovered } from '#src/testing/writes.ts'
import { createSubscriber } from '#src/valkey.ts'

let s: Stack
// A string a failing handler throws, which must reach no log line (T15 item 5).
const SENTINEL = 'sentinel-6b1f-not-for-logs'

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}
function deferred(): Deferred {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

// Polls every 20 ms until check passes, for at most `ms`; on a miss, names the oldest transactions.
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (check(value)) return value
    if (Date.now() > deadline) {
      const holders = await s.query(
        'select pid, application_name, xact_start from pg_stat_activity where backend_xid is not null or backend_xmin is not null order by xact_start limit 5',
      )
      throw new Error(
        `still not as expected after ${ms} ms: ${JSON.stringify(value)}; oldest transactions: ${JSON.stringify(holders)}`,
      )
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// The socket a signed-in client opened, which must have opened.
function opened(socket: Opened): Extract<Opened, { ws: unknown }> {
  if (!('closed' in socket)) throw new Error(`the socket did not open: ${socket.status}`)
  return socket
}

interface JobRow {
  state: string
  attempts: number
  give_backs: number
  reason: string | null
  lease_token: string | null
  schedule_run_id: string | null
}
const jobOf = async (id: string) =>
  (
    await s.query<JobRow>(
      'select state, attempts, give_backs, reason, lease_token, schedule_run_id from jobs where id = $1',
      [id],
    )
  )[0]
const effectsOf = (id: string) =>
  s.query<{ n: number }>('select n from it_job_effects where job_id = $1 order by at', [id])
const linesOf = (event: string, job?: string) =>
  s.logs.filter(line => line.event === event && (job === undefined || line.job === job))

// Queues a job as the offboarding role (the worker's own producers in C0.6).
const queue = <P extends object>(kind: JobKind<P>, input: Parameters<typeof enqueue<P>>[3]) =>
  withOrg(s.worker, { orgId: s.org.id, system: true, as: 'hearth_job_offboarding' }, trx =>
    enqueue(trx, s.org.id, kind, input),
  )

// What a handler commits as its effect: one row a time it commits.
const recordEffect = (ctx: JobContext<object>) =>
  ctx.commit(
    async trx => {
      await sql`insert into it_job_effects (org_id, job_id, n) values (${ctx.job.orgId}, ${ctx.job.id}, ${ctx.job.attempt})`.execute(
        trx,
      )
    },
    { finish: true },
  )

const kind = <P extends object = Record<string, never>>(
  name: string,
  run: (ctx: JobContext<P>) => Promise<void>,
  change: Partial<JobKind<P>> = {},
): JobKind<P> =>
  defineJob<P>({
    kind: name,
    feature: 'it.essential',
    purpose: 'service_operation',
    role: 'hearth_job_offboarding',
    payload: z.strictObject({}) as unknown as z.ZodType<P>,
    backoff: { baseMs: 100, capMs: 400 },
    run,
    ...change,
  })

// A job that, on its first attempt, says it has started and then waits to be let go, deaf to its
// signal: the stand-in for a handler a crash or a stall cuts off.
const gates = new Map<string, { started: Deferred; release: Deferred }>()
const gateOf = (id: string) => {
  let gate = gates.get(id)
  if (gate === undefined) {
    gate = { started: deferred(), release: deferred() }
    gates.set(id, gate)
  }
  return gate
}
const waiting = kind('it.wait', async ctx => {
  if (ctx.job.attempt === 1) {
    gateOf(ctx.job.id).started.resolve()
    await gateOf(ctx.job.id).release.promise
  }
  await recordEffect(ctx)
})

// Sets a test flag as the superuser, bumping its revision as set_feature_flag() does, and tells
// every process on the flags channel.
async function setFlag(key: string, enabled: boolean, by: Person): Promise<void> {
  const [row] = await s.query<{ revision: string }>(
    `update feature_flags set enabled = $3, revision = revision + 1, updated_by = $4, updated_at = now()
     where org_id = $1 and key = $2 returning revision::text`,
    [s.org.id, key, enabled, by.id],
  )
  await s.valkey.publish(
    s.names.flags,
    JSON.stringify({ v: 1, org: s.org.id, key, revision: Number(row?.revision), at: Date.now() }),
  )
}

async function withWorker<T>(
  options: Parameters<Stack['startWorker']>[0],
  work: (worker: WorkerInstance) => Promise<T>,
): Promise<T> {
  const worker = await s.startWorker(options)
  try {
    await worker.ready()
    return await work(worker)
  } finally {
    await worker.stop()
  }
}

describe('C0.6 T15 the job queue on the Compose stack: exactly once in effect', () => {
  let admin: Person

  beforeAll(async () => {
    s = await startStack()
    await installJobTables(s)
    admin = await s.person({ roles: ['admin'], pin: s.newPin() })
  })

  // biome-ignore lint/correctness/noEmptyPattern: the hook takes no fixtures.
  afterAll(async ({}, suite) => {
    if (s === undefined) return
    try {
      for (const gate of gates.values()) gate.release.resolve()
      // No Node warning fired (pg's for a query sent to a client already running one included).
      expect(s.warnings.map(warning => `${warning.name}: ${warning.message}`)).toEqual([])
      await expectEveryWriteCovered(s.superuser, 'jobs', { allPassed: everyTestPassed(suite) })
      // No worker loop failed again and again (a statement Postgres refuses would, every tick), and
      // no failure carried the sentinel a handler threw.
      expect(s.logs.filter(line => line.event === 'worker_loop_failed' && Number(line.level) >= 50)).toEqual([])
      expect(JSON.stringify(s.logs)).not.toContain(SENTINEL)
    } finally {
      await s.stop()
    }
  })

  it('C0.6 Done (T15 item 3): a job’s effect and its end commit together, once', async () => {
    const effect = kind('it.effect', recordEffect)
    await withWorker({ kinds: [effect] }, async () => {
      const id = await queue(effect, { payload: {} })
      const job = await eventually(
        () => jobOf(id),
        row => row?.state === 'succeeded',
      )
      expect(job).toMatchObject({ attempts: 1, give_backs: 0, reason: null, lease_token: null })
      expect(await effectsOf(id)).toEqual([{ n: 1 }])
      expect(linesOf('job_succeeded', id)).toHaveLength(1)
    })
  })

  it('T15 item 2: a crash before the finishing commit: after the lease the sweep requeues it, and another worker commits it once', async () => {
    const a = await s.startWorker({ kinds: [waiting] })
    await a.ready()
    const id = await queue(waiting, { payload: {} })
    await gateOf(id).started.promise
    await a.kill()
    await withWorker({ kinds: [waiting] }, async () => {
      const job = await eventually(
        () => jobOf(id),
        row => row?.state === 'succeeded',
        15_000,
      )
      expect(job?.attempts).toBe(2)
      expect(await effectsOf(id)).toEqual([{ n: 2 }])
      expect(linesOf('job_retry', id).map(line => line.reason)).toEqual(['lease_expired'])
      // The crashed attempt, let go now, commits nothing: its worker has stopped.
      gateOf(id).release.resolve()
      await sleep(300)
      expect(await effectsOf(id)).toEqual([{ n: 2 }])
    })
  })

  it('T15 items 2 and 3: a zombie worker’s lease runs out while its handler goes on; another attempt commits; the zombie’s commit gets HF002 and rolls back', async () => {
    const a = await s.startWorker({ kinds: [waiting] })
    a.pauseHeartbeats()
    try {
      await a.ready()
      const id = await queue(waiting, { payload: {} })
      await gateOf(id).started.promise
      await withWorker({ kinds: [waiting] }, async () => {
        const job = await eventually(
          () => jobOf(id),
          row => row?.state === 'succeeded',
          15_000,
        )
        expect(job?.attempts).toBe(2)
        expect(await effectsOf(id)).toEqual([{ n: 2 }])
        // The zombie wakes and commits: its fence finds the lease gone, and its effect rolls back.
        gateOf(id).release.resolve()
        await eventually(
          async () => linesOf('job_lease_lost', id),
          lines => lines.length === 1,
        )
        expect(await effectsOf(id)).toEqual([{ n: 2 }])
        expect(await jobOf(id)).toMatchObject({ state: 'succeeded', attempts: 2 })
      })
    } finally {
      await a.stop()
    }
  })

  it('Qodo-18 #5: a worker the harness can’t start leaves no connection open', async () => {
    // This run's worker instances' subscriber connections, by the name the harness gives them.
    const subscribers = async () =>
      String(await s.valkey.call('CLIENT', 'LIST'))
        .split('\n')
        .filter(line => line.includes(`name=hearth-worker-it-`) && line.includes(`:${s.prefix} `)).length
    const before = await subscribers()
    // An AI purpose before A0: startWorker refuses the registries.
    const ai = kind('it.ai', async () => {}, { feature: 'ai.ask', purpose: 'org_brain' })
    await expect(s.startWorker({ kinds: [ai] })).rejects.toThrow(/until A0/)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(await subscribers()).toBe(before)
  })

  it('T15 item 7: the same key in two transactions adds one job, and an enqueue that rolls back adds none', async () => {
    // A kind no worker here knows, so the rows stay as they were queued.
    const unclaimed = kind('it.unclaimed', async () => {})
    const key = `dup:${randomUUID()}`
    const first = await queue(unclaimed, { payload: {}, idempotencyKey: key })
    const second = await queue(unclaimed, { payload: {}, idempotencyKey: key })
    expect(second).not.toBe(first)
    expect(await s.query('select id from jobs where idempotency_key = $1', [key])).toEqual([{ id: first }])
    expect(await s.query('select created_by from jobs where id = $1', [first])).toEqual([{ created_by: s.org.system }])
    const rolledBack = `gone:${randomUUID()}`
    await expect(
      withOrg(s.worker, { orgId: s.org.id, system: true, as: 'hearth_job_offboarding' }, async trx => {
        await enqueue(trx, s.org.id, unclaimed, { payload: {}, idempotencyKey: rolledBack })
        throw new Error('rolled back')
      }),
    ).rejects.toThrow('rolled back')
    expect(await s.query('select id from jobs where idempotency_key = $1', [rolledBack])).toEqual([])
  })

  it('T15 items 4 and 5: retries after a growing back-off until it works, and the dead letter after the last attempt, its failure logged without its message', async () => {
    const started = new Map<string, number[]>()
    const flaky = kind(
      'it.flaky',
      async ctx => {
        started.set(ctx.job.id, [...(started.get(ctx.job.id) ?? []), Date.now()])
        if (ctx.job.attempt < 3) throw new Error(`flaky ${SENTINEL}`)
        await recordEffect(ctx)
      },
      { backoff: { baseMs: 300, capMs: 2000 } },
    )
    const broken = kind(
      'it.broken',
      async () => {
        throw new Error(`broken ${SENTINEL}`)
      },
      { maxAttempts: 3, backoff: { baseMs: 100, capMs: 200 } },
    )
    await withWorker({ kinds: [flaky, broken] }, async () => {
      const ok = await queue(flaky, { payload: {} })
      const dead = await queue(broken, { payload: {} })
      await eventually(
        () => jobOf(ok),
        row => row?.state === 'succeeded',
        15_000,
      )
      await eventually(
        () => jobOf(dead),
        row => row?.state === 'dead',
        15_000,
      )
      expect(await jobOf(ok)).toMatchObject({ attempts: 3 })
      expect(await effectsOf(ok)).toEqual([{ n: 3 }])
      const [t1 = 0, t2 = 0, t3 = 0] = started.get(ok) ?? []
      console.info(`retries: ${t2 - t1} ms, then ${t3 - t2} ms`)
      // 300 ms, then 600 ms, each ±20%.
      expect(t2 - t1).toBeGreaterThanOrEqual(240)
      expect(t3 - t2).toBeGreaterThanOrEqual(480)
      expect(await jobOf(dead)).toMatchObject({ attempts: 3, reason: 'error', lease_token: null })
      expect(linesOf('job_retry', ok).map(line => line.reason)).toEqual(['error', 'error'])
      const [deadLine] = linesOf('job_dead', dead)
      expect(deadLine).toMatchObject({ level: 50, reason: 'error', attempt: 3 })
      expect(deadLine?.failure).toMatchObject({ error: 'Error', stack: expect.any(Array) })
      expect(JSON.stringify(s.logs)).not.toContain(SENTINEL)
    })
  })

  it('T15 item 6: a job that blocks the event loop past the flag watchdog is given back uncounted each time, then dead at the 20th give-back', async () => {
    const blocks = kind('it.blocks', async ctx => {
      const until = Date.now() + 900
      while (Date.now() < until) {
        // Busy: no timer, poll or heartbeat runs meanwhile.
      }
      ctx.step('after the block')
      await recordEffect(ctx)
    })
    await withWorker({ kinds: [blocks], flags: { pollMs: 100, staleMs: 600 } }, async () => {
      // Given back 17 times already (the superuser writes the count, as 17 earlier deploys would have).
      const id = randomUUID()
      await s.query(
        `insert into jobs (id, org_id, kind, feature_key, purpose, give_backs, created_by)
         values ($1, $2, 'it.blocks', 'it.essential', 'service_operation', 17, $3)`,
        [id, s.org.id, s.org.system],
      )
      const job = await eventually(
        () => jobOf(id),
        row => row?.state === 'dead',
        30_000,
      )
      expect(job).toMatchObject({ reason: 'give_back_limit', give_backs: 20, attempts: 0 })
      expect(linesOf('job_requeued', id).map(line => line.reason)).toEqual(['unconfirmed', 'unconfirmed'])
      expect(linesOf('job_give_back_limit', id)).toHaveLength(1)
      expect(await effectsOf(id)).toEqual([])
    })
  })

  it('T15 item 1: a job whose feature isn’t its kind’s is never run: dead (job_mismatch)', async () => {
    const effect = kind('it.effect', recordEffect)
    await withWorker({ kinds: [effect] }, async () => {
      const id = randomUUID()
      await s.query(
        `insert into jobs (id, org_id, kind, feature_key, purpose, created_by)
         values ($1, $2, 'it.effect', 'it.optional', 'service_operation', $3)`,
        [id, s.org.id, s.org.system],
      )
      const job = await eventually(
        () => jobOf(id),
        row => row?.state === 'dead',
      )
      expect(job?.reason).toBe('job_mismatch')
      expect(await effectsOf(id)).toEqual([])
      expect(linesOf('job_mismatch', id)).toHaveLength(1)
    })
  })

  it('T15 items 9 and 20: queued work of an optional feature switched off is cancelled; a kind nobody knows is dead after 7 days', async () => {
    const optional = kind('it.optional_work', async ctx => recordEffect(ctx), { feature: 'it.optional' })
    await setFlag('it.optional', false, admin)
    try {
      await withWorker({ kinds: [optional] }, async () => {
        const id = await queue(optional, { payload: {} })
        const job = await eventually(
          () => jobOf(id),
          row => row?.state === 'cancelled',
        )
        expect(job).toMatchObject({ reason: 'flag_off', attempts: 0 })
        // Queued 8 days ago, of a kind no version knows.
        const gone = randomUUID()
        await s.query(
          `insert into jobs (id, org_id, kind, feature_key, purpose, created_by, run_after)
           values ($1, $2, 'it.gone', 'it.essential', 'service_operation', $3, now() - interval '8 days')`,
          [gone, s.org.id, s.org.system],
        )
        expect(
          await eventually(
            () => jobOf(gone),
            row => row?.state === 'dead',
          ),
        ).toMatchObject({
          reason: 'kind_unknown',
        })
        expect(linesOf('job_kind_unknown', gone)).toHaveLength(1)
      })
    } finally {
      await setFlag('it.optional', true, admin)
    }
  })

  it('T16 item 9 T19 item 2: a deactivation’s sockets close through the revocation consumer when the api’s publish is off; offboarding’s retired sockets handler finishes as unregistered', async () => {
    await withWorker({}, async () => {
      // The consumer starts at 'now': a deactivation committed before its checkpoint is made is the
      // re-check's alone (m6).
      await s.waitForCheckpoint('revocation', s.org.id)
      const sessionsOf = async (person: Person) =>
        (await s.query<{ id: string }>('select id from sessions where user_id = $1', [person.id])).map(row => row.id)
      const revocationJobs = (person: Person) =>
        s.query<{
          id: string
          state: string
          idempotency_key: string | null
          subject_id: string | null
          payload: { handler: string; cause: string; person?: string; people?: string[]; sessions?: string[] }
        }>(
          `select id, state, idempotency_key, subject_id, payload from jobs
           where kind = 'revocation.handler' and (payload->>'person' = $1 or payload->'people' ? $1)
           order by payload->>'handler'`,
          [person.id],
        )

      // With the api's publish (the push): the socket closes at once, and the worker's revocation
      // jobs run too; offboarding queues nothing, since its sockets handler is retired.
      const first = await s.person({ pin: s.newPin() })
      const firstSocket = opened(await s.openSocket(await s.signIn(first)))
      const adminClient = await s.signIn(admin)
      expect((await adminClient.post('/api/admin/people/deactivate', { person: first.id })).status).toBe(200)
      const closedFirst = await Promise.race([firstSocket.closed, sleep(2000).then(() => undefined)])
      expect(closedFirst).toMatchObject({ code: 4401 })
      expect(
        (
          await eventually(
            () => revocationJobs(first),
            rows => rows.length === 2 && rows.every(row => row.state === 'succeeded'),
          )
        ).map(row => row.payload.handler),
      ).toEqual(['sockets', 'topics'])
      const [deactivated] = await s.query<{ id: string }>(
        "select id::text from outbox_events where type = 'person.deactivated' and entity_id = $1",
        [first.id],
      )
      // The offboarding consumer has read past the event, and queued no job for it.
      await eventually(
        () =>
          s.query<{ last_id: string }>(
            "select last_id::text from outbox_checkpoints where consumer = 'offboarding' and org_id = $1",
            [s.org.id],
          ),
        rows => BigInt(rows[0]?.last_id ?? '0') >= BigInt(deactivated?.id ?? '1'),
      )
      expect(
        await s.query("select id from jobs where kind = 'offboarding.handler' and subject_id = $1", [first.id]),
      ).toEqual([])

      // Without it (A6): only the worker's revocation jobs can close the socket now, on a realtime
      // app of its own whose periodic re-check can't close it first (NO_PERIODIC_RECHECK). The
      // stack's own ticks every 15 s at a phase the tests before this one set.
      const quiet = await s.startApi({ publishRevoked: false })
      const quietAdmin = s.client({ app: quiet })
      quietAdmin.setCookie('__Host-hearth_session', adminClient.cookie('__Host-hearth_session') ?? '')
      const rt = await s.startRealtime({ ...NO_PERIODIC_RECHECK, subscribe: true })
      // Listening on both revocation channels, or the sockets job's message would go unheard.
      await eventually(
        () => rt.readiness('/ready'),
        r => r.status === 200,
      )
      const leaver = await s.person({ pin: s.newPin() })
      const socket = opened(await s.openSocket(await s.signIn(leaver), { url: rt.url }))
      const before = rt.server.counts().closedDurable
      const started = Date.now()
      expect((await quietAdmin.post('/api/admin/people/deactivate', { person: leaver.id })).status).toBe(200)
      const closed = await Promise.race([socket.closed, sleep(10_000).then(() => undefined)])
      expect(closed, 'the socket stayed open for 10 s').toMatchObject({ code: 4401 })
      console.info(`deactivation to socket closed through the revocation consumer: ${(closed?.at ?? 0) - started} ms`)
      // Closed by the durable path, not the push (which is off) or a periodic re-check (none in this
      // app's life).
      expect(rt.server.counts()).toMatchObject({ closedDurable: before + 1 })
      // The sockets job re-read the ended sessions and published them, then finished in a
      // transaction of its own; it names no subject, and is keyed by its first session.
      const ended = await sessionsOf(leaver)
      const [sockets, topics] = await eventually(
        () => revocationJobs(leaver),
        rows => rows.length === 2 && rows.every(row => row.state === 'succeeded'),
      )
      expect(sockets).toMatchObject({
        subject_id: null,
        payload: { handler: 'sockets', cause: 'sessions_ended', person: leaver.id },
      })
      expect(new Set(sockets?.payload.sessions)).toEqual(new Set(ended))
      expect(sockets?.idempotency_key).toBe(`sockets:${sockets?.payload.sessions?.[0]}`)
      expect(topics).toMatchObject({
        subject_id: null,
        idempotency_key: null,
        payload: { handler: 'topics', cause: 'keys_changed', people: [leaver.id] },
      })

      // A job queued for offboarding's sockets handler before C0.7 finds it retired, and finishes
      // with a warning, not an error.
      const retired = await queue(offboardingJob(offboardingRegistry()), {
        payload: { person: leaver.id, handler: 'sockets' },
        subjectId: leaver.id,
        idempotencyKey: `${leaver.id}:sockets`,
      })
      await eventually(
        () => jobOf(retired),
        row => row?.state === 'succeeded',
      )
      expect(linesOf('offboarding_handler_unregistered', retired)).toEqual([
        expect.objectContaining({ level: 40, handler: 'sockets' }),
      ])

      // A re-run of the sockets job publishes the ended sessions again on the access channel;
      // nothing more closes, nothing fails.
      const listener = createSubscriber(s.valkey, s.realtime.app.log as never)
      const messages: string[] = []
      listener.on('message', (_channel: string, text: string) => messages.push(text))
      await listener.subscribe(s.names.access)
      try {
        // Only the kind is used here, to queue the job; the worker runs it with its own registry.
        const registry = revocationRegistry({
          valkey: s.valkey,
          keyPrefix: s.prefix,
          logger: { warn: () => {}, error: () => {} },
        })
        const again = await queue(revocationJob(registry), {
          payload: RevocationPayload.parse(sockets?.payload),
          idempotencyKey: `${sockets?.idempotency_key}:again`,
        })
        await eventually(
          () => jobOf(again),
          row => row?.state === 'succeeded',
        )
        const published = await eventually(
          async () => messages.map(text => JSON.parse(text) as Record<string, unknown>),
          list => list.some(m => Array.isArray(m.sessions) && ended.every(id => (m.sessions as string[]).includes(id))),
        )
        expect(published.find(m => Array.isArray(m.sessions))).toMatchObject({
          v: 1,
          org: s.org.id,
          path: 'durable',
          cause: 'sessions_ended',
          at: expect.any(Number),
        })
        expect(rt.server.counts().closedDurable).toBe(before + 1)
      } finally {
        listener.disconnect()
      }
    })
  })

  it('T16 item 9: a forged person.deactivated for someone still at the org queues no handler, logs an error and closes nothing', async () => {
    await withWorker({}, async () => {
      const stays = await s.person({ pin: s.newPin() })
      const socket = opened(await s.openSocket(await s.signIn(stays)))
      // The superuser, acting as Hearth, appends the claim.
      await s.query('begin')
      try {
        await s.query("select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [
          s.org.id,
          s.org.system,
        ])
        await s.query(
          `insert into outbox_events (org_id, type, entity_type, entity_id, actor_id, actor_kind, subject_ids, purpose, ids)
           values ($1, 'person.deactivated', 'person', $2, $3, 'system', array[$2::uuid], 'accounts', '{}')`,
          [s.org.id, stays.id, s.org.system],
        )
        await s.query('commit')
      } catch (error) {
        await s.query('rollback')
        throw error
      }
      const [event] = await s.query<{ id: string }>(
        "select id::text from outbox_events where type = 'person.deactivated' and entity_id = $1",
        [stays.id],
      )
      await eventually(
        async () => s.logs.filter(line => line.event === 'offboarding_not_deactivated' && line.eventId === event?.id),
        lines => lines.length === 1,
      )
      expect(await s.query('select id from jobs where subject_id = $1', [stays.id])).toEqual([])
      const closed = await Promise.race([socket.closed, sleep(1000).then(() => 'open')])
      expect(closed).toBe('open')
    })
  })

  it('T15 item 15 (resuming comes with A4 or A5.4): a review run cut short waits as interrupted, by a crash or by its flag, and nothing retries it', async () => {
    const reviewed = kind('it.reviewed', ctx => {
      gateOf(ctx.job.id).started.resolve()
      return new Promise<void>((_, reject) => {
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason))
      })
    })
    const schedule: ScheduleDef = { key: 'it.reviewed', kind: 'it.reviewed', cron: '0 0 1 1 *', onInterrupt: 'review' }
    const fireNow = () =>
      s.query(
        "update schedules set next_run_at = now() - interval '1 second' where org_id = $1 and key = 'it.reviewed'",
        [s.org.id],
      )
    const runsOf = () =>
      s.query<{ id: string; state: string; reason: string | null; attempt: number }>(
        `select r.id, r.state, r.reason, r.attempt from schedule_runs r join schedules sc on sc.id = r.schedule_id
         where sc.key = 'it.reviewed' order by r.created_at`,
      )
    const a = await s.startWorker({ kinds: [reviewed], schedules: [schedule] })
    await a.ready()
    await eventually(
      () => s.query("select 1 from schedules where key = 'it.reviewed'"),
      rows => rows.length === 1,
    )
    // (a) A crash mid-run.
    await fireNow()
    const [running] = await eventually(runsOf, runs => runs[0]?.state === 'running')
    const [crashedJob] = await s.query<{ id: string; max_attempts: number }>(
      'select id, max_attempts from jobs where schedule_run_id = $1',
      [running?.id],
    )
    expect(crashedJob?.max_attempts).toBe(1)
    await a.kill()
    await withWorker({ kinds: [reviewed], schedules: [schedule] }, async () => {
      const [crashed] = await eventually(runsOf, runs => runs[0]?.state === 'interrupted', 15_000)
      expect(crashed).toMatchObject({ reason: 'crash', attempt: 1 })
      expect(await jobOf(crashedJob?.id ?? '')).toMatchObject({ state: 'dead', reason: 'lease_expired' })
      // (b) Its flag turned off mid-run.
      await fireNow()
      const runs = await eventually(runsOf, list => list[1]?.state === 'running')
      const [secondJob] = await s.query<{ id: string }>('select id from jobs where schedule_run_id = $1', [runs[1]?.id])
      await gateOf(secondJob?.id ?? '').started.promise
      await setFlag('it.essential', false, admin)
      try {
        const after = await eventually(runsOf, list => list[1]?.state === 'interrupted')
        expect(after[1]).toMatchObject({ reason: 'flag_off', attempt: 1 })
        expect(await jobOf(secondJob?.id ?? '')).toMatchObject({ state: 'cancelled', reason: 'flag_off' })
      } finally {
        await setFlag('it.essential', true, admin)
      }
      // Nothing retries either run on its own.
      await sleep(1500)
      expect((await runsOf()).map(run => run.state)).toEqual(['interrupted', 'interrupted'])
      expect(
        await s.query(
          "select j.id from jobs j join schedule_runs r on r.id = j.schedule_run_id join schedules sc on sc.id = r.schedule_id where sc.key = 'it.reviewed'",
        ),
      ).toHaveLength(2)
      expect(
        s.logs.filter(line => line.event === 'schedule_run_interrupted' && runs.some(run => run.id === line.run)),
      ).toHaveLength(2)
    })
  })

  it('T15 item 12: stop() with a job stuck in the database resolves within 5 s; the job goes back uncounted; its handler commits nothing', async () => {
    const stuck = kind('it.stuck', async ctx => {
      gateOf(ctx.job.id).started.resolve()
      // Deaf to its signal: a statement stuck in the database.
      await ctx.read(trx => sql`select pg_sleep(6)`.execute(trx))
      await recordEffect(ctx)
    })
    const w = await s.startWorker({ kinds: [stuck] })
    try {
      await w.ready()
      const id = await queue(stuck, { payload: {} })
      await gateOf(id).started.promise
      await sleep(100)
      const started = Date.now()
      await w.worker.stop()
      const took = Date.now() - started
      console.info(`stop() with a stuck job took ${took} ms`)
      expect(took).toBeLessThan(5200)
      expect(await jobOf(id)).toMatchObject({ state: 'queued', attempts: 0, give_backs: 1, reason: 'shutdown' })
      // When the sleep ends, the handler's commit is refused: its worker has stopped.
      await eventually(
        () =>
          s.query(
            "select 1 from pg_stat_activity where application_name = $1 and query like '%pg_sleep%' and state = 'active'",
            [w.name],
          ),
        rows => rows.length === 0,
        10_000,
      )
      await sleep(200)
      expect(await effectsOf(id)).toEqual([])
      expect(await jobOf(id)).toMatchObject({ state: 'queued', attempts: 0, give_backs: 1 })
    } finally {
      await w.stop()
    }
  })

  // The clean-up deletes old rows, so it runs last.
  it('T15 items 16 and 17: the partitions and the clean-up run for real from their schedules', async () => {
    // The newest partition gone, and rows past their periods next to young ones.
    const [newest] = await s.query<{ name: string }>(
      `select c.relname as name from pg_inherits i join pg_class c on c.oid = i.inhrelid
       where i.inhparent = 'public.data_access_events'::regclass order by c.relname desc limit 1`,
    )
    await s.query(`drop table ${newest?.name}`)
    const old = randomUUID()
    const young = randomUUID()
    const deadOld = randomUUID()
    const deadYoung = randomUUID()
    await s.query(
      `insert into jobs (id, org_id, kind, feature_key, purpose, created_by, state, attempts, finished_at, reason) values
         ($1, $5, 'it.old', 'it.essential', 'service_operation', $6, 'succeeded', 1, now() - interval '15 days', null),
         ($2, $5, 'it.old', 'it.essential', 'service_operation', $6, 'succeeded', 1, now() - interval '13 days', null),
         ($3, $5, 'it.old', 'it.essential', 'service_operation', $6, 'dead', 1, now() - interval '31 days', 'error'),
         ($4, $5, 'it.old', 'it.essential', 'service_operation', $6, 'dead', 1, now() - interval '15 days', 'error')`,
      [old, young, deadOld, deadYoung, s.org.id, s.org.system],
    )
    await withWorker({ productionSchedules: true }, async () => {
      await eventually(
        () => s.query("select key from schedules where key like 'maintenance.%' order by key"),
        rows => rows.length === 2,
      )
      await s.query("update schedules set next_run_at = now() - interval '1 second' where key like 'maintenance.%'")
      const done = await eventually(
        () =>
          s.query<{ kind: string; state: string }>(
            "select kind, state from jobs where kind like 'maintenance.%' order by kind",
          ),
        rows => rows.length === 2 && rows.every(row => row.state === 'succeeded'),
        20_000,
      ).catch(error => {
        console.info(JSON.stringify(s.logs.filter(line => String(line.kind ?? '').startsWith('maintenance'))))
        throw error
      })
      expect(done.map(row => row.kind)).toEqual(['maintenance.data_access_partitions', 'maintenance.purge'])
      // Each run succeeded with its job (rerun schedules).
      expect(
        await s.query(
          "select r.state from schedule_runs r join schedules sc on sc.id = r.schedule_id where sc.key like 'maintenance.%'",
        ),
      ).toEqual([{ state: 'succeeded' }, { state: 'succeeded' }])
    })
    // The partitions reach 12 months ahead again.
    const [reach] = await s.query<{ ok: boolean }>(
      `select max((regexp_match(pg_get_expr(c.relpartbound, c.oid), $r$TO \\('([^']+)'\\)$r$))[1]::timestamptz)
                >= now() + interval '12 months' as ok
       from pg_inherits i join pg_class c on c.oid = i.inhrelid
       where i.inhparent = 'public.data_access_events'::regclass`,
    )
    expect(reach?.ok).toBe(true)
    expect(await s.query(`select to_regclass('public.${newest?.name}') is not null as back`)).toEqual([{ back: true }])
    // Only rows past their periods went, one audit row per batch.
    const left = await s.query<{ id: string }>('select id from jobs where id = any($1) order by id', [
      [old, young, deadOld, deadYoung],
    ])
    expect(left.map(row => row.id).sort()).toEqual([young, deadYoung].sort())
    const audits = await s.query<{ target_type: string; details: { rows: number } }>(
      "select target_type, details from audit_events where action = 'maintenance.purge' order by id",
    )
    expect(audits).toEqual([{ target_type: 'jobs', details: { rows: 2 } }])
    expect(s.logs.filter(line => line.event === 'maintenance_purge')).toEqual([
      expect.objectContaining({ table: 'jobs', rows: 2 }),
    ])
  })
})
