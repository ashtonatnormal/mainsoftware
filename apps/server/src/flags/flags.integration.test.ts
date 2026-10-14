// Changing a feature flag through the production path, and the change reaching every process
// (BUILD-PLAN C0.6 "Done when": a flag flip within 10 s; the C0 exit's "a flag change reaches every
// process within 10 s"; TECH-SPEC T17). The api app, the realtime app and a worker instance
// (worker/index.ts, its flags read as hearth_queue on hearth_worker's login) each keep their own
// copy of the org's flags, with their own pools and Valkey subscriber: they share only Postgres and
// Valkey, which is what a change crosses. The worker runs test jobs that post through ctx.commit()
// every 50 ms, so a change can be seen to stop them, and a real worker process (node src/main.ts)
// on a database of its own shows the same in production's wiring.
// `npm run test:integration` runs it with the stack up (`docker compose up -d --wait`).
//
// Every bound is a number far above what is expected (10 s against milliseconds by Valkey, or about
// 2 s by the poll; 1 s for copies that poll only every 60 s, so the Valkey path itself is proved), and
// each case prints what it measured. Waits poll every 20 ms up to a deadline. The cancellation cases
// hold one of the job's posts open across the change, so "no post after it" is measured from the
// flag's commit, not the reply (acrossChange()).
// The test flags (it.optional, it.essential, it.ai) are the harness's (testing/stack.ts), which
// the route takes through its injectable registry (A5); the production flags are all locked.
//
// afterAll checks the outbox's contract for the run (every committed write covered; flag.changed
// appended), and, when every test passed, that each of the route's own error codes was answered.
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { sql } from 'kysely'
import { Client as PgClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { withOrg } from '#src/db/database.ts'
import { migrate } from '#src/db/migrations.ts'
import type { FlagCache } from '#src/flags/cache.ts'
import { FLAG_ERRORS } from '#src/flags/set.ts'
import type { JobContext } from '#src/jobs/context.ts'
import { enqueue } from '#src/jobs/enqueue.ts'
import { defineJob, type JobKind } from '#src/jobs/kinds.ts'
import { installJobTables } from '#src/testing/jobs.ts'
import type { Client, Person, Stack, WorkerInstance } from '#src/testing/stack.ts'
import { startStack } from '#src/testing/stack.ts'
import { everyTestPassed, expectEveryWriteCovered } from '#src/testing/writes.ts'

let s: Stack
let admin: Person
let member: Person
let adminClient: Client
let memberClient: Client
// The worker instance, and its copy of the flags.
let worker: WorkerInstance
let workerFlags: FlagCache

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// A job that posts every 50 ms through ctx.commit() until it is stopped (T15 item 9, T17 item 8); run again
// after it was given back (a give-back doesn't count the attempt), it finishes after 3 more posts.
// Its gate is checked at every post, and every commit ends with the fence, so no post can commit
// after its flag changed. Each post records its flag's revision as its own transaction read it
// (READ COMMITTED: as of the insert), after waiting on the job's advisory lock, which a test holds
// to keep a post open across a change (acrossChange()): a post that commits after the change has
// read the new revision.
const posting = (name: string, feature: string): JobKind =>
  defineJob({
    kind: name,
    feature,
    purpose: 'service_operation',
    role: 'hearth_job_offboarding',
    payload: z.strictObject({}),
    idempotentCommits: true,
    timeoutMs: 60_000,
    async run(ctx: JobContext<object>) {
      const before = await ctx.read(async trx => {
        const { rows } = await sql<{
          n: number
        }>`select count(*)::int as n from it_posts where job_id = ${ctx.job.id}`.execute(trx)
        return rows[0]?.n ?? 0
      })
      for (let n = 1; ; n++) {
        ctx.step('post')
        await ctx.commit(async trx => {
          // No lock_timeout for this wait (transaction_timeout's 30 s still bounds it), so a change
          // that takes longer than withOrg()'s 2 s can't turn the held post into a lock timeout,
          // which the runner would retry, rather than a post the fence refuses (R2TESTS-1).
          await sql`set local lock_timeout = 0`.execute(trx)
          await sql`select pg_advisory_xact_lock_shared(hashtextextended(${ctx.job.id}, 0))`.execute(trx)
          await sql`insert into it_posts (org_id, job_id, n, revision) values (${ctx.job.orgId}, ${ctx.job.id}, ${n},
            (select f.revision from feature_flags f where f.org_id = ${ctx.job.orgId} and f.key = ${feature}))`.execute(
            trx,
          )
        })
        if (before > 0 && n >= 3) return
        await sleep(50)
      }
    },
  })
const postsOptional = posting('it.posts', 'it.optional')
const postsEssential = posting('it.posts_essential', 'it.essential')

// A port nothing listens on, for the real worker process.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0))
    })
  })
}

// Polls every 20 ms until check passes on what read gives, for at most `ms`.
async function eventuallyAsync<T>(read: () => Promise<T>, check: (value: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (check(value)) return value
    if (Date.now() > deadline) throw new Error(`still not as expected after ${ms} ms: ${JSON.stringify(value)}`)
    await sleep(20)
  }
}

const set = (client: Client, body: Record<string, unknown>) => client.post('/api/admin/flags/set', body)

interface FlagRow {
  id: string
  enabled: boolean
  audience: string
  cohort_people: string[]
  cohort_roles: string[]
  revision: string
  updated_by: string | null
}
async function flagRow(key: string, orgId = s.org.id): Promise<FlagRow | undefined> {
  const [row] = await s.query<FlagRow>(
    `select id, enabled, audience, cohort_people, cohort_roles, revision::text, updated_by from feature_flags
     where org_id = $1 and key = $2`,
    [orgId, key],
  )
  return row
}

// What a refused request must leave as it was: the row, the audit log and the outbox.
async function unchanged(key: string, work: () => Promise<void>): Promise<void> {
  const counts = async () =>
    (
      await s.query<{ audits: number; events: number }>(
        `select (select count(*)::int from audit_events where action = 'flag.set') as audits,
                (select count(*)::int from outbox_events where type = 'flag.changed') as events`,
      )
    )[0]
  const before = { row: await flagRow(key), counts: await counts() }
  await work()
  expect({ row: await flagRow(key), counts: await counts() }).toEqual(before)
}

// Polls every 20 ms until check passes, for at most `within` ms; returns how long it took.
async function within(ms: number, check: () => boolean): Promise<number> {
  const started = Date.now()
  for (;;) {
    if (check()) return Date.now() - started
    if (Date.now() - started > ms) {
      // On a developer's machine another transaction can hold things up; say which.
      const holders = await s.query(
        'select pid, application_name, xact_start from pg_stat_activity where backend_xid is not null or backend_xmin is not null order by xact_start limit 5',
      )
      throw new Error(`still not as expected after ${ms} ms; oldest transactions: ${JSON.stringify(holders)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

// Every process's copy: the api's, realtime's and the worker's.
const caches = (): [string, FlagCache][] => [
  ['api', s.apiFlags],
  ['realtime', s.realtimeFlags],
  ['worker', workerFlags],
]

describe('C0.6 T17 changing a flag and its reach to every process (PRD-65, BUILD-PLAN C0.6)', () => {
  beforeAll(async () => {
    s = await startStack()
    admin = await s.person({ roles: ['admin'], pin: s.newPin() })
    member = await s.person({ pin: s.newPin() })
    // A sign-in counts as a re-authentication, which the route needs from the last 5 minutes.
    adminClient = await s.signIn(admin)
    memberClient = await s.signIn(member)
    await installJobTables(s)
    worker = await s.startWorker({ kinds: [postsOptional, postsEssential] })
    await worker.ready()
    workerFlags = worker.worker.flags
    // The api keeps the org from its first signed-in request, realtime from its first socket.
    expect((await adminClient.get('/api/devices')).status).toBe(200)
    const opened = await s.openSocket(adminClient)
    expect(opened.status).toBe(101)
    await within(5000, () => caches().every(([, cache]) => cache.confirmedAt(s.org.id) !== undefined))
  })

  // biome-ignore lint/correctness/noEmptyPattern: the hook takes no fixtures.
  afterAll(async ({}, suite) => {
    if (s === undefined) return
    try {
      for (const reply of s.replies) {
        expect(reply.cacheControl, `${reply.method} ${reply.url}`).toBe('no-store')
        expect(reply.error, `${reply.method} ${reply.url}`).not.toBe('internal')
      }
      // No Node warning fired (pg's for a query sent to a client already running one included).
      expect(s.warnings.map(warning => `${warning.name}: ${warning.message}`)).toEqual([])
      const all = everyTestPassed(suite)
      await expectEveryWriteCovered(s.superuser, 'flags', { allPassed: all })
      if (all) {
        const answered = new Set(s.replies.map(reply => reply.error))
        expect(FLAG_ERRORS.filter(code => !answered.has(code))).toEqual([])
      }
    } finally {
      await s.stop()
    }
  })

  it('C0.6 Done: an Admin turns a flag off through the route, and every process has it within 10 s (by Valkey)', async () => {
    // Copies that poll only every 60 s, so only the flags channel can bring them the change within
    // 1 s: two subscribed as the harness subscribes the api's and realtime's (main.ts's own wiring
    // is scripts/check-server.sh's), and a worker instance on its own wiring (worker/index.ts).
    const slow = { pollMs: 60_000 }
    const subscribers = async () =>
      Number(((await s.valkey.call('PUBSUB', 'NUMSUB', s.names.flags)) as [string, number])[1])
    const already = await subscribers()
    const slowWorker = await s.startWorker({ flags: slow, productionConsumers: false })
    const listening: [string, FlagCache][] = [
      ['api (60 s poll)', s.flagCache({ ...slow, subscribe: true })],
      ['realtime (60 s poll)', s.flagCache({ ...slow, subscribe: true })],
      ['worker (60 s poll)', slowWorker.worker.flags],
    ]
    try {
      await slowWorker.ready()
      for (const [, cache] of listening.slice(0, 2)) await cache.track(s.org.id)
      await eventuallyAsync(subscribers, n => n >= already + 3)
      await within(5000, () => listening.every(([, cache]) => cache.confirmedAt(s.org.id) !== undefined))

      const before = Number((await flagRow('it.optional'))?.revision)
      for (const [, cache] of [...caches(), ...listening]) expect(cache.isOn(s.org.id, 'it.optional', null)).toBe(true)
      const started = Date.now()
      const reply = await set(adminClient, { key: 'it.optional', enabled: false })
      expect(reply.status).toBe(200)
      expect(reply.body).toEqual({ key: 'it.optional', enabled: false, revision: before + 1 })
      const answeredAt = Date.now() - started
      const times: Record<string, number> = {}
      for (const [name, cache] of listening) {
        times[name] = await within(1000, () => cache.revisionsOf(s.org.id, 'it.optional')?.at(-1) === before + 1)
        expect(cache.isOn(s.org.id, 'it.optional', null), name).toBe(false)
      }
      for (const [name, cache] of caches()) {
        times[name] = await within(10_000, () => cache.revisionsOf(s.org.id, 'it.optional')?.at(-1) === before + 1)
        expect(cache.isOn(s.org.id, 'it.optional', null), name).toBe(false)
      }
      console.info(`flag change: answered in ${answeredAt} ms; reached ${JSON.stringify(times)} ms after the reply`)
      expect(Math.max(...Object.values(times))).toBeLessThan(10_000)
      // Every process logged it (each copy reads the same row).
      expect(
        s.logs.filter(
          line => line.event === 'flags_changed' && line.key === 'it.optional' && line.revision === before + 1,
        ).length,
      ).toBeGreaterThanOrEqual(3)
    } finally {
      await slowWorker.stop()
      for (const [, cache] of listening.slice(0, 2)) cache.stop()
    }
  })

  it('C0.6 Done: with the api’s publish lost, every process still has the change within 10 s, by the poll alone', async () => {
    // An api whose Valkey is unreachable: the change commits, its publish fails, and nothing is told.
    const down = await s.startApi({ valkeyUrl: 'redis://127.0.0.1:1' })
    const viaDown = s.client({ app: down })
    viaDown.setCookie('__Host-hearth_session', adminClient.cookie('__Host-hearth_session') ?? '')
    const before = Number((await flagRow('it.optional'))?.revision)
    const started = Date.now()
    const reply = await set(viaDown, { key: 'it.optional', enabled: true })
    expect([reply.status, reply.body]).toEqual([200, { key: 'it.optional', enabled: true, revision: before + 1 }])
    expect(s.logs.some(line => line.event === 'flags_publish_failed')).toBe(true)
    const times: Record<string, number> = {}
    for (const [name, cache] of caches()) {
      await within(10_000, () => cache.revisionsOf(s.org.id, 'it.optional')?.at(-1) === before + 1)
      times[name] = Date.now() - started
      expect(cache.isOn(s.org.id, 'it.optional', null), name).toBe(true)
    }
    console.info(`flag change with the publish lost: reached ${JSON.stringify(times)} ms after the request`)
    // The poll is every 2 s ±10%, so about 2.2 s at worst, far inside 10 s.
    expect(Math.max(...Object.values(times))).toBeLessThan(10_000)
  })

  it('T17 item 9: refuses a Member, an AI flag, a locked flag, an unknown key and a stale re-authentication, changing nothing', async () => {
    await unchanged('it.optional', async () => {
      const refused = await set(memberClient, { key: 'it.optional', enabled: false })
      expect([refused.status, refused.error]).toEqual([403, 'forbidden'])
    })
    // A0 decides who turns AI on and off (ADM-05, ADM-10): can() refuses every ai.* key.
    for (const key of ['ai', 'ai.ask', 'ai.agents']) {
      await unchanged(key, async () => {
        const refused = await set(adminClient, { key, enabled: true })
        expect([refused.status, refused.error], key).toEqual([403, 'forbidden'])
      })
    }
    // core.system is locked on: only a migration changes it.
    await unchanged('core.system', async () => {
      const locked = await set(adminClient, { key: 'core.system', enabled: false })
      expect([locked.status, locked.error]).toEqual([409, 'flag_locked'])
    })
    const unknown = await set(adminClient, { key: 'it.unknown', enabled: true })
    expect([unknown.status, unknown.error]).toEqual([404, 'not_found'])
    const malformed = await set(adminClient, { key: 'Not A Key', enabled: true })
    expect([malformed.status, malformed.error]).toEqual([400, 'invalid_request'])
    // §9.4: a re-authentication from the last 5 minutes.
    const stale = await s.signIn(admin)
    await s.age((await s.sessionOf(stale)).id, '6 minutes')
    await unchanged('it.optional', async () => {
      const refused = await set(stale, { key: 'it.optional', enabled: false })
      expect([refused.status, refused.error]).toEqual([403, 'reauth_required'])
    })
  })

  it('T17 item 9: refuses to turn on a feature whose purpose the gate refuses (409 purpose_refused)', async () => {
    // it.ai names an AI purpose, which C0.6's purpose gate refuses (D41); C0.9's register fills it.
    await unchanged('it.ai', async () => {
      const refused = await set(adminClient, { key: 'it.ai', enabled: true })
      expect([refused.status, refused.error]).toEqual([409, 'purpose_refused'])
    })
  })

  it('A8: refuses a cohort the table would refuse, or naming anyone outside the org, with 400 invalid_cohort', async () => {
    const outsider = await s.person({ org: 'second' })
    for (const body of [
      { key: 'it.essential', enabled: true, audience: 'cohort' },
      { key: 'it.essential', enabled: true, audience: 'org', roles: ['dpo'] },
      { key: 'it.essential', enabled: true, audience: 'cohort', roles: ['team_admin'] },
      { key: 'it.essential', enabled: true, audience: 'cohort', roles: Array.from({ length: 1001 }, () => 'dpo') },
      // Past the route's checks, set_feature_flag() refuses it (HF004).
      { key: 'it.essential', enabled: true, audience: 'cohort', people: [outsider.id] },
      { key: 'it.essential', enabled: true, audience: 'cohort', people: [s.org.system] },
    ]) {
      await unchanged('it.essential', async () => {
        const refused = await set(adminClient, body)
        expect([refused.status, refused.error], JSON.stringify(body).slice(0, 80)).toEqual([400, 'invalid_cohort'])
      })
    }
  })

  it('T17 items 3 and 9: each change is audited and evented, a no-op is neither, and a narrowed cohort reaches the worker’s copy', async () => {
    const flag = await flagRow('it.essential')
    const before = Number(flag?.revision)
    const audits = () =>
      s.query<{
        actor_id: string
        target_id: string
        device_id: string
        ip: string
        request_id: string
        details: Record<string, unknown>
      }>(
        "select actor_id, target_id, device_id, host(ip) as ip, request_id, details from audit_events where action = 'flag.set' and target_id = 'it.essential' order by id",
      )
    const events = () =>
      s.query<{
        actor_id: string
        actor_kind: string
        entity_type: string
        entity_id: string
        subject_ids: string[]
        purpose: string
        ids: Record<string, unknown>
      }>(
        "select actor_id, actor_kind, entity_type, entity_id, subject_ids, purpose, ids from outbox_events where type = 'flag.changed' and entity_id = $1 order by tx_id, id",
        [flag?.id],
      )

    // A cohort of a person and a role, sent in an order the database doesn't keep.
    const cohort = await set(adminClient, {
      key: 'it.essential',
      enabled: true,
      audience: 'cohort',
      people: [member.id],
      roles: ['leadership', 'dpo'],
    })
    expect(cohort.body).toEqual({ key: 'it.essential', enabled: true, revision: before + 1 })
    const { deviceId } = await s.sessionOf(adminClient)
    expect(await audits()).toEqual([
      {
        actor_id: admin.id,
        target_id: 'it.essential',
        device_id: deviceId,
        ip: adminClient.ip,
        request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        details: {
          enabled: true,
          was_enabled: true,
          audience: 'cohort',
          revision: before + 1,
          people_added: [member.id],
          people_removed: [],
          roles_added: ['dpo', 'leadership'],
          roles_removed: [],
        },
      },
    ])
    expect(await events()).toEqual([
      {
        actor_id: admin.id,
        actor_kind: 'human',
        entity_type: 'feature_flag',
        entity_id: flag?.id,
        subject_ids: [],
        purpose: 'service_operation',
        ids: { enabled: true },
      },
    ])
    expect(await flagRow('it.essential')).toMatchObject({
      audience: 'cohort',
      cohort_people: [member.id],
      cohort_roles: ['dpo', 'leadership'],
      updated_by: admin.id,
    })

    // The same again, in another order: nothing changes, nothing is written or published.
    const again = await set(adminClient, {
      key: 'it.essential',
      enabled: true,
      audience: 'cohort',
      people: [member.id],
      roles: ['dpo', 'leadership', 'dpo'],
    })
    expect(again.body).toEqual({ key: 'it.essential', enabled: true, revision: before + 1 })
    expect(await audits()).toHaveLength(1)
    expect(await events()).toHaveLength(1)

    // The worker's copy evaluates the cohort for each person (T17 item 3).
    await within(10_000, () => workerFlags.revisionsOf(s.org.id, 'it.essential')?.at(-1) === before + 1)
    expect(workerFlags.isOn(s.org.id, 'it.essential', { personId: member.id, active: true, roles: [] })).toBe(true)
    expect(workerFlags.isOn(s.org.id, 'it.essential', { personId: admin.id, active: true, roles: ['dpo'] })).toBe(true)
    expect(workerFlags.isOn(s.org.id, 'it.essential', { personId: admin.id, active: true, roles: ['admin'] })).toBe(
      false,
    )
    expect(workerFlags.isOn(s.org.id, 'it.essential', null)).toBe(false)

    // Narrowed: the member leaves the cohort.
    const narrowed = await set(adminClient, { key: 'it.essential', enabled: true, audience: 'cohort', roles: ['dpo'] })
    expect(narrowed.body).toEqual({ key: 'it.essential', enabled: true, revision: before + 2 })
    expect((await audits()).at(-1)?.details).toMatchObject({
      people_removed: [member.id],
      roles_removed: ['leadership'],
    })
    expect(await events()).toHaveLength(2)
    await within(10_000, () => workerFlags.revisionsOf(s.org.id, 'it.essential')?.at(-1) === before + 2)
    expect(workerFlags.isOn(s.org.id, 'it.essential', { personId: member.id, active: true, roles: [] })).toBe(false)

    // And back to the whole org.
    const whole = await set(adminClient, { key: 'it.essential', enabled: true })
    expect(whole.body).toEqual({ key: 'it.essential', enabled: true, revision: before + 3 })
    expect(await flagRow('it.essential')).toMatchObject({ audience: 'org', cohort_people: [], cohort_roles: [] })
  })
  const posted = async (job: string) =>
    (await s.query<{ n: number }>('select count(*)::int as n from it_posts where job_id = $1', [job]))[0]?.n ?? 0
  // The job's posts that read its flag at this revision or later: committed after the change.
  const postedFrom = async (job: string, revision: number) =>
    (
      await s.query<{ n: number }>('select count(*)::int as n from it_posts where job_id = $1 and revision >= $2', [
        job,
        revision,
      ])
    )[0]?.n ?? 0
  // Makes a change while one of the job's posts is open: holds the job's advisory lock, waits until a
  // post is waiting on it (its insert not yet made), makes the change, then lets the post go on. The
  // post then reads the new revision, so only the fence (job_fence) keeps it from committing; the
  // flag's commit, not the reply, is what "after the change" is measured from (PRD-65).
  async function acrossChange<T>(job: string, change: () => Promise<T>): Promise<T> {
    await s.query('select pg_advisory_lock(hashtextextended($1, 0))', [job])
    try {
      await eventuallyAsync(
        async () =>
          (
            await s.query<{ n: number }>(
              `select count(*)::int as n from pg_locks l join pg_database d on d.oid = l.database
               where l.locktype = 'advisory' and not l.granted and d.datname = current_database()`,
            )
          )[0]?.n ?? 0,
        n => n >= 1,
      )
      return await change()
    } finally {
      await s.query('select pg_advisory_unlock(hashtextextended($1, 0))', [job])
    }
  }
  // The post held across the change went on and the fence refused it: had it failed some other way
  // (a lock timeout, say), the runner would have logged a retry (R2TESTS-1).
  const refusedNotRetried = (job: string) =>
    expect(
      s.logs.filter(line => line.job === job && (line.event === 'job_retry' || line.event === 'job_dead')),
    ).toEqual([])
  const jobOf = async (id: string) =>
    (
      await s.query<{ state: string; reason: string | null; attempts: number }>(
        'select state, reason, attempts from jobs where id = $1',
        [id],
      )
    )[0]
  const queue = (kind: JobKind, subjectId?: string) =>
    withOrg(s.worker, { orgId: s.org.id, system: true, as: 'hearth_job_offboarding' }, trx =>
      enqueue(trx, s.org.id, kind, { payload: {}, ...(subjectId === undefined ? {} : { subjectId }) }),
    )

  it('T15 item 9 T17 item 8: an optional feature turned off through the route cancels its running job within 10 s; no post commits after the change', async () => {
    const job = await queue(postsOptional)
    await eventuallyAsync(
      () => posted(job),
      n => n >= 3,
    )
    const started = Date.now()
    let atChange = 0
    const reply = await acrossChange(job, async () => {
      atChange = await posted(job)
      return set(adminClient, { key: 'it.optional', enabled: false })
    })
    expect(reply.status).toBe(200)
    const off = (reply.body as { revision: number }).revision
    try {
      await eventuallyAsync(
        () => jobOf(job),
        row => row?.state === 'cancelled',
      )
      console.info(`turned off: the job ended ${Date.now() - started} ms after the request`)
      expect(Date.now() - started).toBeLessThan(10_000)
      expect(await jobOf(job)).toMatchObject({ state: 'cancelled', reason: 'flag_off', attempts: 1 })
      await sleep(2000)
      expect(await postedFrom(job, off)).toBe(0)
      expect(await posted(job)).toBe(atChange)
      refusedNotRetried(job)
    } finally {
      expect((await set(adminClient, { key: 'it.optional', enabled: true })).status).toBe(200)
    }
  })

  it('T15 item 9: an essential feature turned off gives its job back uncounted; it isn’t claimed while off and posts again when back on', async () => {
    const job = await queue(postsEssential)
    await eventuallyAsync(
      () => posted(job),
      n => n >= 3,
    )
    let atReply = 0
    const reply = await acrossChange(job, async () => {
      atReply = await posted(job)
      return set(adminClient, { key: 'it.essential', enabled: false })
    })
    expect(reply.status).toBe(200)
    try {
      const back = await eventuallyAsync(
        () => jobOf(job),
        row => row?.state === 'queued',
      )
      expect(back).toMatchObject({ reason: 'flag_off', attempts: 0 })
      await sleep(1500)
      expect(await jobOf(job)).toMatchObject({ state: 'queued', attempts: 0 })
      expect(await postedFrom(job, (reply.body as { revision: number }).revision)).toBe(0)
      expect(await posted(job)).toBe(atReply)
      refusedNotRetried(job)
    } finally {
      expect((await set(adminClient, { key: 'it.essential', enabled: true })).status).toBe(200)
    }
    // Back on: claimed again, it posts again and, on this attempt, finishes.
    await eventuallyAsync(
      () => jobOf(job),
      row => row?.state === 'succeeded',
    )
    expect(await posted(job)).toBeGreaterThan(atReply)
    expect((await jobOf(job))?.attempts).toBe(1)
  })

  it('T15 item 9 T17 item 3: a cohort narrowed to leave a person out cancels their running job within 10 s, and another’s carries on', async () => {
    const [a, b] = [await s.person(), await s.person()]
    const wave = await set(adminClient, { key: 'it.optional', enabled: true, audience: 'cohort', people: [a.id, b.id] })
    expect(wave.status).toBe(200)
    try {
      await within(10_000, () => workerFlags.isOn(s.org.id, 'it.optional', { personId: a.id, active: true, roles: [] }))
      const forA = await queue(postsOptional, a.id)
      const forB = await queue(postsOptional, b.id)
      await eventuallyAsync(
        async () => Math.min(await posted(forA), await posted(forB)),
        n => n >= 3,
      )
      const started = Date.now()
      let atReply = 0
      const narrowed = await acrossChange(forA, async () => {
        atReply = await posted(forA)
        return set(adminClient, { key: 'it.optional', enabled: true, audience: 'cohort', people: [b.id] })
      })
      expect(narrowed.status).toBe(200)
      const bAtReply = await posted(forB)
      await eventuallyAsync(
        () => jobOf(forA),
        row => row?.state === 'cancelled',
      )
      console.info(`narrowed: the job ended ${Date.now() - started} ms after the request`)
      expect(Date.now() - started).toBeLessThan(10_000)
      expect(await jobOf(forA)).toMatchObject({ reason: 'not_in_cohort', attempts: 1 })
      await sleep(1000)
      expect(await postedFrom(forA, (narrowed.body as { revision: number }).revision)).toBe(0)
      expect(await posted(forA)).toBe(atReply)
      refusedNotRetried(forA)
      // B's job carries on: it posts after the reply. (A post whose commit was in flight across the
      // change is refused by the fence and the job given back at once, uncounted, to run on.)
      await eventuallyAsync(
        () => posted(forB),
        n => n > bAtReply,
      )
      expect(['running', 'queued', 'succeeded']).toContain((await jobOf(forB))?.state)
      expect(s.logs.filter(line => line.job === forB && line.event === 'job_cancelled')).toEqual([])
    } finally {
      // Off ends B's job; then the whole org again.
      expect((await set(adminClient, { key: 'it.optional', enabled: false })).status).toBe(200)
      expect((await set(adminClient, { key: 'it.optional', enabled: true })).status).toBe(200)
    }
  })

  it('T17 item 6 T15 item 12: a real worker process, on its own database, has a flag change within 10 s and stops cleanly on SIGTERM', async () => {
    const c = {
      host: process.env.PGHOST ?? '127.0.0.1',
      port: Number(process.env.PGPORT ?? 5432),
      user: process.env.PGUSER ?? 'postgres',
      password: process.env.PGPASSWORD ?? 'postgres',
    }
    const database = `worker_it_${randomBytes(4).toString('hex')}`
    const admin = new PgClient({ ...c, database: 'postgres' })
    await admin.connect()
    let child: ChildProcess | undefined
    try {
      await admin.query(`create database ${database} owner hearth_owner template template0`)
      const url = (user: string, password: string) =>
        `postgres://${user}:${encodeURIComponent(password)}@${c.host}:${c.port}/${database}`
      const { error } = await migrate({ databaseUrl: url(c.user, c.password), role: 'hearth_owner' })
      if (error) throw error
      const db = new PgClient({ ...c, database })
      await db.connect()
      const org = randomUUID()
      const system = randomUUID()
      try {
        await db.query("insert into orgs (id, name) values ($1, 'Worker process test')", [org])
        await db.query("insert into principals (id, org_id, kind, system_key) values ($1, $2, 'system', 'hearth')", [
          system,
          org,
        ])
        await db.query(
          "insert into feature_flags (org_id, key, enabled, locked) values ($1, 'it.optional', true, false)",
          [org],
        )
        const port = await freePort()
        // The process reads .env.example as the server's own npm run dev does; these override it.
        child = spawn(process.execPath, ['--env-file=../../.env.example', 'src/main.ts'], {
          cwd: fileURLToPath(new URL('../../', import.meta.url)),
          env: {
            ...process.env,
            ROLE: 'worker',
            PORT: String(port),
            DEPLOY_ENV: 'test',
            SMS_PROVIDER: '',
            LOG_LEVEL: 'info',
            WORKER_DATABASE_URL: url('hearth_worker', 'hearth-local'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const lines: Record<string, unknown>[] = []
        const text: string[] = []
        let buffer = ''
        child.stdout?.on('data', chunk => {
          buffer += String(chunk)
          const parts = buffer.split('\n')
          buffer = parts.pop() ?? ''
          for (const part of parts) {
            text.push(part)
            try {
              lines.push(JSON.parse(part) as Record<string, unknown>)
            } catch {
              // Kept in `text` for the failure message.
            }
          }
        })
        child.stderr?.on('data', chunk => text.push(String(chunk)))
        const exited = new Promise<number | null>(resolve => child?.once('exit', code => resolve(code)))
        // Ready within 20 s.
        const readyBy = Date.now() + 20_000
        for (;;) {
          const status = await fetch(`http://127.0.0.1:${port}/ready`)
            .then(response => response.status)
            .catch(() => 0)
          if (status === 200) break
          if (Date.now() > readyBy) throw new Error(`the worker never became ready:\n${text.join('\n')}`)
          await sleep(100)
        }
        // A change, told on h:test:flags as the api would.
        const [row] = (
          await db.query<{ revision: string }>(
            `update feature_flags set enabled = false, revision = revision + 1, updated_by = $2, updated_at = now()
             where org_id = $1 and key = 'it.optional' returning revision::text`,
            [org, system],
          )
        ).rows
        const revision = Number(row?.revision)
        const told = Date.now()
        await s.valkey.publish(
          'h:test:flags',
          JSON.stringify({ v: 1, org, key: 'it.optional', revision, at: Date.now() }),
        )
        await within(10_000, () =>
          lines.some(
            line => line.event === 'flags_changed' && line.key === 'it.optional' && line.revision === revision,
          ),
        )
        console.info(`a real worker process had the change ${Date.now() - told} ms after it was told`)
        child.kill('SIGTERM')
        const code = await Promise.race([exited, sleep(15_000).then(() => 'timed out')])
        expect(code, text.join('\n')).toBe(0)
        expect(lines.some(line => line.msg === 'stopped')).toBe(true)
        expect(lines.filter(line => Number(line.level) >= 50)).toEqual([])
      } finally {
        await db.end()
      }
    } finally {
      if (child !== undefined && child.exitCode === null) child.kill('SIGKILL')
      await admin.query(`drop database if exists ${database} with (force)`).catch(() => {})
      await admin.end()
    }
  })
})
