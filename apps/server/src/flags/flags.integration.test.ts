// Changing a feature flag through the production path, and the change reaching every process
// (BUILD-PLAN C0.6 "Done when": a flag flip within 10 s; the C0 exit's "a flag change reaches every
// process within 10 s"; TECH-SPEC T17). The api app, the realtime app and a worker's cache (read as
// hearth_queue on hearth_worker's login) each keep their own copy of the org's flags, with their own
// Valkey subscriber: they share only Postgres and Valkey, which is what a change crosses.
// `npm run test:integration` runs it with the stack up (`docker compose up -d --wait`).
//
// Every bound is a number far above what is expected (10 s against milliseconds by Valkey, or about
// 2 s by the poll), and each case prints what it measured. Waits poll every 20 ms up to a deadline.
// The test flags (it.optional, it.essential, it.ai) are the harness's (testing/stack.ts), which
// the route takes through its injectable registry (A5); the production flags are all locked.
//
// afterAll checks the outbox's contract for the run (every committed write covered; flag.changed
// appended), and, when every test passed, that each of the route's own error codes was answered.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FlagCache } from '#src/flags/cache.ts'
import { FLAG_ERRORS } from '#src/flags/set.ts'
import type { Client, Person, Stack } from '#src/testing/stack.ts'
import { startStack } from '#src/testing/stack.ts'
import { expectEveryWriteCovered } from '#src/testing/writes.ts'

let s: Stack
let admin: Person
let member: Person
let adminClient: Client
let memberClient: Client
// The worker's copy, as the worker reads it.
let workerFlags: FlagCache

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
    workerFlags = s.flagCache({ as: 'hearth_queue', subscribe: true })
    await workerFlags.track(s.org.id)
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
      const all = suite.tasks.every(task => task.type !== 'test' || task.result?.state === 'pass')
      await expectEveryWriteCovered(s.superuser, 'flags', { allPassed: all && suite.tasks.length > 0 })
      if (all && suite.tasks.length > 0) {
        const answered = new Set(s.replies.map(reply => reply.error))
        expect(FLAG_ERRORS.filter(code => !answered.has(code))).toEqual([])
      }
    } finally {
      await s.stop()
    }
  })

  it('C0.6 Done: an Admin turns a flag off through the route, and every process has it within 10 s (by Valkey)', async () => {
    const before = Number((await flagRow('it.optional'))?.revision)
    for (const [, cache] of caches()) expect(cache.isOn(s.org.id, 'it.optional', null)).toBe(true)
    const started = Date.now()
    const reply = await set(adminClient, { key: 'it.optional', enabled: false })
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({ key: 'it.optional', enabled: false, revision: before + 1 })
    const answeredAt = Date.now() - started
    const times: Record<string, number> = {}
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
    expect(workerFlags.isOn(s.org.id, 'it.essential', { personId: member.id, roles: [] })).toBe(true)
    expect(workerFlags.isOn(s.org.id, 'it.essential', { personId: admin.id, roles: ['dpo'] })).toBe(true)
    expect(workerFlags.isOn(s.org.id, 'it.essential', { personId: admin.id, roles: ['admin'] })).toBe(false)
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
    expect(workerFlags.isOn(s.org.id, 'it.essential', { personId: member.id, roles: [] })).toBe(false)

    // And back to the whole org.
    const whole = await set(adminClient, { key: 'it.essential', enabled: true })
    expect(whole.body).toEqual({ key: 'it.essential', enabled: true, revision: before + 3 })
    expect(await flagRow('it.essential')).toMatchObject({ audience: 'org', cohort_people: [], cohort_roles: [] })
  })
})
