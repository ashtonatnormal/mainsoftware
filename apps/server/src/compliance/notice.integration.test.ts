// The privacy notice on the Compose stack (PDPA-02, PDPA-03, ACC-12; C0.9 PR 2, TECH-SPEC T22 items
// 21 to 37): the real api over migration 0010, the DPO publishing through the routes on a PIN-rule
// session, people acknowledging through theirs, the acknowledgement gate on every signed-in REST
// route and on the gateway, and a worker instance whose copy of the registers reads what the
// latest version lists. Each test that publishes makes its own org (B-08), so `-t` on one test
// works and no publish sends another test's people to /notice. The stack's realtime app, and those
// the tests start, run production's admission (admissionForTests: 'notice'; the other suites run
// none, C-07). `npm run test:integration` runs it with the stack up (`docker compose up -d --wait`).
//
// afterAll checks every reply was no-store and none a 500, that no Node warning fired, the outbox's
// contract for the run (every committed write covered; this suite owns notice.published and
// notice.acknowledged), and, when every test passed, that each of the notice's error codes was
// answered.
import { randomUUID } from 'node:crypto'
import {
  ACTIVE_FROM_START,
  GATEWAY_CLOSE,
  type NoticeAdminJSON,
  NoticeAdminResponse,
  type NoticeJSON,
  NoticeResponse,
  RegistersResponse,
  SessionResponse,
} from '@hearth/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SESSION_COOKIE } from '#src/auth/cookies.ts'
import { NOTICE_ERRORS } from '#src/compliance/notice.ts'
import { purposeAllowed } from '#src/compliance/registers.ts'
import { type Client, type Closed, type Org, type Person, type Stack, startStack } from '#src/testing/stack.ts'
import { everyTestPassed, expectEveryWriteCovered } from '#src/testing/writes.ts'

let s: Stack

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Polls every 20 ms until check passes on what read gives, for at most `ms`.
async function eventually<T>(read: () => T | Promise<T>, check: (value: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (check(value)) return value
    if (Date.now() > deadline) throw new Error(`still not as expected after ${ms} ms: ${JSON.stringify(value)}`)
    await sleep(20)
  }
}

// A socket's close within `ms`, or undefined if it stayed open.
async function closeWithin(closed: Promise<Closed>, ms: number): Promise<Closed | undefined> {
  return Promise.race([closed, sleep(ms).then(() => undefined)])
}

// Your notice, strictly as the server types it.
async function noticeOf(client: Client): Promise<NoticeJSON> {
  const reply = await client.get('/api/notice')
  expect([reply.status, reply.error]).toEqual([200, undefined])
  return NoticeResponse.parse(reply.body)
}

// The DPO's Notice tab, strictly as the server types it.
async function adminNotice(client: Client): Promise<NoticeAdminJSON> {
  const reply = await client.get('/api/admin/notice')
  expect([reply.status, reply.error]).toEqual([200, undefined])
  return NoticeAdminResponse.parse(reply.body)
}

// Acknowledges the current version, as /notice does.
async function acknowledgeCurrent(client: Client): Promise<{ version: number; changed: boolean }> {
  const current = (await noticeOf(client)).current
  if (current === null) throw new Error('no version is published')
  const reply = await client.post('/api/notice/acknowledge', { notice: current.id })
  expect([reply.status, reply.error]).toEqual([200, undefined])
  return reply.json()
}

// The DPO records a basis and a retention for every purpose that starts active with neither (the
// four of A-05), through the registers' route, so a draft can be published.
async function recordActivePurposes(dpoClient: Client): Promise<void> {
  const read = RegistersResponse.parse((await dpoClient.get('/api/admin/registers')).body)
  for (const purpose of read.purposes.filter(row => ACTIVE_FROM_START.includes(row.purpose))) {
    const recorded = await dpoClient.post('/api/admin/registers/purposes/set', {
      purpose: purpose.purpose,
      seen: purpose.version,
      status: 'active',
      basis: 'employment',
      basisReference: null,
      optOutDays: null,
      retention: 'Kept while you work here, then 90 days',
      providers: purpose.providers,
    })
    expect([purpose.purpose, recorded.status, recorded.error]).toEqual([purpose.purpose, 200, undefined])
  }
}

const versionIds = (org: Org) =>
  s.query<{ id: string; version: number; generator: string | null; body: string; published_by: string }>(
    'select id, version, generator, body, published_by from notice_versions where org_id = $1 order by version',
    [org.id],
  )

// How the gate classes each /api route (C0.9 PD-43): the shell's two GETs, your devices and
// sign-out, and the notice's own routes are free; the sign-in steps and the CSP report come before
// any session; every other signed-in route is gated. Each with a request that reaches its
// gate: a body its schema reads, and the path with its parameters filled in.
type RouteClass = 'free' | 'before_session' | 'gated'
interface Sample {
  class: RouteClass
  path?: (target: Person) => string
  body?: (target: Person) => unknown
}
const DIGEST = '0'.repeat(64)
const ROUTES: Readonly<Record<string, Sample>> = {
  'POST /api/auth/otp/request': { class: 'before_session', body: () => ({ phone: '+6580009998' }) },
  'POST /api/auth/otp/verify': { class: 'before_session', body: () => ({ code: '000000' }) },
  'POST /api/auth/pin/set': { class: 'before_session', body: () => ({ pin: '135790' }) },
  'POST /api/auth/pin/verify': { class: 'before_session', body: () => ({ pin: '135790' }) },
  'POST /api/csp-report': { class: 'before_session', body: () => ({}) },
  'GET /api/session': { class: 'free' },
  'GET /api/flags': { class: 'free' },
  'GET /api/devices': { class: 'free' },
  'GET /api/devices/': { class: 'free' },
  'POST /api/devices/sign-out': { class: 'free', body: () => ({ allOthers: true }) },
  'GET /api/notice': { class: 'free' },
  // Both run last: acknowledging opens the gate, and signing out ends the session.
  'POST /api/notice/acknowledge': { class: 'free' },
  'POST /api/auth/sign-out': { class: 'free' },
  'POST /api/auth/reauth/pin': { class: 'gated', body: () => ({ pin: '135790' }) },
  'POST /api/auth/reauth/code/request': { class: 'gated', body: () => ({}) },
  'POST /api/auth/reauth/code/verify': { class: 'gated', body: () => ({ code: '000000' }) },
  'POST /api/admin/people/deactivate': { class: 'gated', body: target => ({ person: target.id }) },
  'POST /api/admin/people/reset-pin': {
    class: 'gated',
    body: target => ({ person: target.id, identityCheck: 'in_person' }),
  },
  'POST /api/admin/people/sign-out-devices': { class: 'gated', body: target => ({ person: target.id }) },
  'GET /api/admin/people/:person/devices': { class: 'gated', path: target => `/api/admin/people/${target.id}/devices` },
  'POST /api/admin/flags/set': { class: 'gated', body: () => ({ key: 'it.optional', enabled: true }) },
  'GET /api/admin/registers': { class: 'gated' },
  'POST /api/admin/registers/purposes/set': {
    class: 'gated',
    body: () => ({
      purpose: 'security_audit',
      seen: 1,
      status: 'active',
      basis: 'employment',
      basisReference: null,
      optOutDays: null,
      retention: '1 year',
      providers: [],
    }),
  },
  'POST /api/admin/registers/transfers/record': {
    class: 'gated',
    body: () => ({
      provider: 'twilio',
      seen: 1,
      services: null,
      dataTypes: null,
      processingCountries: [],
      storageCountries: [],
      countriesConfirmed: null,
      safeguard: null,
      safeguardReference: null,
      certificateVerifiedOn: null,
      dpaTermsConfirmed: false,
      training: null,
      zeroRetention: null,
      providerRetention: null,
      retentionConfirmed: null,
      onwardRecipients: null,
      reviewOn: null,
      keepCleared: false,
    }),
  },
  'POST /api/admin/registers/transfers/clear': { class: 'gated', body: () => ({ provider: 'twilio', seen: 1 }) },
  'POST /api/admin/registers/transfers/withdraw': { class: 'gated', body: () => ({ provider: 'twilio' }) },
  'GET /api/admin/notice': { class: 'gated' },
  'POST /api/admin/notice/publish': { class: 'gated', body: () => ({ seen: 0, digest: DIGEST }) },
}

// One sample request of a route, by its key.
function send(client: Client, key: string, target: Person) {
  const [method = '', url = ''] = key.split(' ')
  const sample = ROUTES[key]
  const path = sample?.path?.(target) ?? url
  return method === 'GET' ? client.get(path) : client.post(path, sample?.body?.(target) ?? {})
}

describe('C0.9 PR 2 the privacy notice and the acknowledgement gate (PDPA-02, PDPA-03, ACC-12, T22)', () => {
  beforeAll(async () => {
    s = await startStack({ admissionForTests: 'notice' })
  })

  // biome-ignore lint/correctness/noEmptyPattern: the hook takes no fixtures.
  afterAll(async ({}, suite) => {
    if (s === undefined) return
    try {
      for (const reply of s.replies) {
        expect(reply.cacheControl, `${reply.method} ${reply.url}`).toBe('no-store')
        expect(reply.error, `${reply.method} ${reply.url}`).not.toBe('internal')
      }
      expect(s.warnings.map(warning => `${warning.name}: ${warning.message}`)).toEqual([])
      const all = everyTestPassed(suite)
      await expectEveryWriteCovered(s.superuser, 'notice', { allPassed: all })
      if (all) {
        const answered = new Set(s.replies.map(reply => reply.error))
        expect(NOTICE_ERRORS.filter(code => !answered.has(code))).toEqual([])
      }
    } finally {
      await s.stop()
    }
  })

  it('NTI-01 C0.9 Done: no access before ack: every signed-in /api route but the free ones answers 403 notice_required to someone who hasn’t acknowledged the latest version, and lets them through once they have (PD-43)', async () => {
    // Every /api route the api added is in the table, and every route in the table is one it added:
    // a route added later must say how the gate classes it. HEAD answers as its GET. Passkeys are
    // off here, as in production; the dormant passkey routes get the same sweep in the one suite
    // that switches them on (auth/passkeys.integration.test.ts, NTI-01).
    const collected = [
      ...new Set(
        s.routes
          .filter(route => route.url.startsWith('/api/'))
          .map(route => `${route.method === 'HEAD' ? 'GET' : route.method} ${route.url}`),
      ),
    ].sort()
    expect(collected).toEqual(Object.keys(ROUTES).sort())

    // The stack's org has the harness's stand-in v0; this person hasn't acknowledged it.
    const m = await s.person({ acknowledged: false })
    const target = await s.person()
    const mc = await s.signIn(m)
    expect(SessionResponse.parse((await mc.get('/api/session')).body).notice).toBe('required')
    const last = new Set(['POST /api/notice/acknowledge', 'POST /api/auth/sign-out'])
    const keys = Object.keys(ROUTES).filter(key => !last.has(key))
    const sent = s.sms.countTo(m.e164)
    for (const key of keys) {
      const reply = await send(mc, key, target)
      if (ROUTES[key]?.class === 'gated') {
        expect([key, reply.status, reply.error]).toEqual([key, 403, 'notice_required'])
      } else {
        expect([key, reply.error], key).not.toEqual([key, 'notice_required'])
      }
    }
    // Nothing a gated request asked for happened: the target is still here, and no code was sent.
    expect((await s.query('select 1 from people where id = $1 and deactivated_at is null', [target.id])).length).toBe(1)
    await s.settled()
    expect(s.sms.countTo(m.e164)).toBe(sent)

    expect(await acknowledgeCurrent(mc)).toEqual({ version: 0, changed: true })
    for (const key of keys) {
      const reply = await send(mc, key, target)
      expect([key, reply.error], key).not.toEqual([key, 'notice_required'])
    }
    // Sign-out is free in every standing.
    expect((await mc.post('/api/auth/sign-out', {})).status).toBe(200)
  })

  it('NTI-02 C0.9 Done: a new version forces re-ack: REST refuses at once, a socket closes with 4403 within one periodic check, and both are let through again once acknowledged (PD-39, PD-45)', async () => {
    const org = await s.newOrg()
    const dpo = await s.person({ org, roles: ['dpo'] })
    const m = await s.person({ org })
    const mc = await s.signIn(m)
    // A realtime app checking every socket each second, with production's admission.
    const app = await s.startRealtime({ recheckMs: 1000, subscribe: true, admissionForTests: 'notice' })
    const socket = await s.gatewaySocket(mc, { url: app.url })
    expect(await socket.sub([`person:${m.id}`])).toMatchObject({ ok: [`person:${m.id}`] })
    // Before: a Member's admin request is can()'s to refuse.
    expect((await mc.get('/api/admin/registers')).error).toBe('forbidden')

    await s.publishNotice(org, dpo, { acknowledge: [dpo] })
    const published = Date.now()
    // REST: at the commit.
    const refused = await mc.get('/api/admin/registers')
    expect([refused.status, refused.error]).toEqual([403, 'notice_required'])
    // The socket: within one periodic check, with nothing pushed and no session ended.
    const closed = await closeWithin(socket.closed, 5000)
    expect(closed).toMatchObject({ code: GATEWAY_CLOSE.noticeRequired.code, reason: 'notice_required' })
    expect((closed?.at ?? Infinity) - published).toBeLessThan(3000)
    // A new socket is admitted only to be closed the same way.
    const again = await s.openSocket(mc, { url: app.url })
    if (!('ws' in again)) throw new Error(`the upgrade was refused: ${again.status}`)
    expect(await closeWithin(again.closed, 5000)).toMatchObject({ code: GATEWAY_CLOSE.noticeRequired.code })
    expect((await mc.get('/api/session')).status).toBe(200)

    expect(await acknowledgeCurrent(mc)).toEqual({ version: 1, changed: true })
    expect((await mc.get('/api/admin/registers')).error).toBe('forbidden')
    const back = await s.gatewaySocket(mc, { url: app.url })
    expect(await back.sub([`person:${m.id}`])).toMatchObject({ ok: [`person:${m.id}`] })
    // Past two periodic checks it is still open.
    expect(await closeWithin(back.closed, 2500)).toBeUndefined()
  })

  it('NTI-03 OD-01 PD-44: before any version, the DPO reaches the registers, the notice and PIN re-authentication; anyone else only the free routes, a code-method re-authentication sends nothing, and the gateway admits nobody', async () => {
    const org = await s.newOrg({ notice: 'none' })
    const dpo = await s.person({ org, roles: ['dpo'] })
    const owner = await s.person({ org, roles: ['owner'] })
    const member = await s.person({ org })
    // Built with the harness (B-03): the stack's fake provider names no transfer entry.
    const dpoClient = await s.signIn(dpo)
    const ownerClient = await s.signIn(owner)
    const memberClient = await s.signIn(member)

    expect(SessionResponse.parse((await dpoClient.get('/api/session')).body)).toMatchObject({
      notice: 'unpublished',
      capabilities: { registers: true },
    })
    expect((await dpoClient.get('/api/admin/registers')).status).toBe(200)
    expect((await adminNotice(dpoClient)).latest).toBeNull()
    expect((await dpoClient.post('/api/auth/reauth/pin', { pin: dpo.pin })).status).toBe(200)
    await recordActivePurposes(dpoClient)
    // Not a setup action: refused by the gate, whatever can() would say.
    expect((await dpoClient.post('/api/admin/flags/set', { key: 'it.optional', enabled: false })).error).toBe(
      'notice_required',
    )

    expect(SessionResponse.parse((await ownerClient.get('/api/session')).body).notice).toBe('unpublished')
    expect((await ownerClient.get('/api/devices')).status).toBe(200)
    for (const reply of [
      await ownerClient.get('/api/admin/registers'),
      await ownerClient.get('/api/admin/notice'),
      await ownerClient.post('/api/admin/people/deactivate', { person: member.id }),
    ]) {
      expect([reply.status, reply.error]).toEqual([403, 'notice_required'])
    }
    expect((await s.query('select 1 from people where id = $1 and deactivated_at is null', [member.id])).length).toBe(1)
    expect((await noticeOf(ownerClient)).standing).toBe('unpublished')

    const sent = s.sms.countTo(member.e164)
    const asked = await memberClient.post('/api/auth/reauth/code/request', {})
    expect([asked.status, asked.error]).toEqual([403, 'notice_required'])
    await s.settled()
    expect(s.sms.countTo(member.e164)).toBe(sent)

    // The gateway admits nobody, the DPO included.
    for (const client of [dpoClient, memberClient]) {
      const opened = await s.openSocket(client)
      if (!('ws' in opened)) throw new Error(`the upgrade was refused: ${opened.status}`)
      expect(await closeWithin(opened.closed, 5000)).toMatchObject({ code: GATEWAY_CLOSE.noticeRequired.code })
    }
  })

  it('NTI-04 PD-36 PD-37 PD-40 PD-50: the DPO previews, is held back by problems, publishes with a fresh PIN the draft previewed (its words, links, audit row and event), a stale digest is refused, and the worker sees it notified', async () => {
    const org = await s.newOrg({ notice: 'none' })
    const dpo = await s.person({ org, roles: ['dpo'] })
    await s.person({ org })
    await s.person({ org, left: true })
    const dpoClient = await s.signIn(dpo)

    // The defaults' active purposes have no basis or retention: problems, and nothing to show.
    const first = await adminNotice(dpoClient)
    expect(first).toMatchObject({ latest: null, draft: { version: 0, body: null, digest: null }, history: [] })
    expect(first.draft.problems.map(problem => problem.code)).toContain('purpose_basis_missing')
    const held = await dpoClient.post('/api/admin/notice/publish', { seen: null, digest: DIGEST })
    expect([held.status, held.error]).toEqual([400, 'notice_invalid'])

    await recordActivePurposes(dpoClient)
    const ready = await adminNotice(dpoClient)
    expect(ready.draft.problems).toEqual([])
    expect(ready.draft.warnings.map(warning => warning.code)).toEqual([
      'dpo_contact_pending',
      'production_access_pending',
    ])
    const { body, digest } = ready.draft
    if (body === null || digest === null) throw new Error('the draft has no words')
    for (const stale of [
      { seen: null, digest: 'f'.repeat(64) },
      { seen: 0, digest },
    ]) {
      const refused = await dpoClient.post('/api/admin/notice/publish', stale)
      expect([refused.status, refused.error], JSON.stringify(stale)).toEqual([409, 'notice_changed'])
    }

    // A PIN more than 5 minutes old is asked for again (PD-30).
    await s.age((await s.sessionOf(dpoClient)).id, '6 minutes')
    const stalePin = await dpoClient.post('/api/admin/notice/publish', { seen: null, digest })
    expect([stalePin.status, stalePin.error, stalePin.json<{ method?: string }>().method]).toEqual([
      403,
      'reauth_required',
      'pin',
    ])
    await s.reauth(dpoClient, dpo)
    const published = await dpoClient.post('/api/admin/notice/publish', { seen: null, digest })
    expect([published.status, published.error]).toEqual([200, undefined])
    const { notice, version } = published.json<{ notice: string; version: number }>()
    expect(version).toBe(0)

    // The words previewed, the generator that wrote them, the DPO as publisher, and its links: every
    // active purpose at the version it was published from.
    expect(await versionIds(org)).toEqual([{ id: notice, version: 0, generator: 'c09.1', body, published_by: dpo.id }])
    const links = await s.query<{ purpose: string; register_version: number }>(
      'select purpose, register_version from notice_version_purposes where notice_version_id = $1 order by purpose',
      [notice],
    )
    const current = await s.query<{ purpose: string; version: number }>(
      `select distinct on (purpose) purpose, version from processing_register
       where org_id = $1 and status <> 'planned' and not ai order by purpose, version desc`,
      [org.id],
    )
    expect(links.map(link => [link.purpose, link.register_version])).toEqual(
      current.map(row => [row.purpose, row.version]),
    )
    const [audit] = await s.query<{ actor_id: string; target_id: string; details: Record<string, unknown> }>(
      "select actor_id, target_id, details from audit_events where org_id = $1 and action = 'notice.publish'",
      [org.id],
    )
    expect(audit).toMatchObject({
      actor_id: dpo.id,
      target_id: notice,
      details: { version: 0, was_version: null, generator: 'c09.1', clearances: {} },
    })
    const events = await s.query<{ entity_id: string; ids: unknown; subject_ids: string[] }>(
      "select entity_id, ids, subject_ids from outbox_events where org_id = $1 and type = 'notice.published'",
      [org.id],
    )
    expect(events).toEqual([{ entity_id: notice, ids: { version: 0 }, subject_ids: [] }])

    // The DPO acknowledges it too before using Hearth again, then sees the count: one of the two
    // people still here.
    const blocked = await dpoClient.get('/api/admin/notice')
    expect([blocked.status, blocked.error]).toEqual([403, 'notice_required'])
    expect(await acknowledgeCurrent(dpoClient)).toEqual({ version: 0, changed: true })
    const after = await adminNotice(dpoClient)
    expect(after.latest).toMatchObject({ id: notice, version: 0, generated: true, acknowledged: 1, people: 2 })
    expect(after.draft).toMatchObject({ version: 1, upToDate: true, problems: [{ code: 'unchanged' }] })
    expect(after.history.map(row => [row.version, row.generated])).toEqual([[0, true]])
    const registers = RegistersResponse.parse((await dpoClient.get('/api/admin/registers')).body)
    expect(registers.notice).toBe('up_to_date')
    expect(registers.purposes.find(row => row.purpose === 'security_audit')?.notified).toBe(true)
    // The same draft again is refused: the published notice already says it.
    const again = await dpoClient.post('/api/admin/notice/publish', { seen: 0, digest })
    expect([again.status, again.error]).toEqual([400, 'notice_invalid'])

    // The worker's copy reads the purposes the version lists (PD-40, T22 item 9).
    const worker = await s.startWorker({ productionConsumers: false })
    await worker.ready()
    await eventually(
      () => worker.worker.flags.register(org.id),
      state => state?.notified.has('security_audit') === true,
    )
    expect(purposeAllowed(worker.worker.flags.register(org.id), 'security_audit')).toBe(true)
  })

  it('NTI-05 PD-42: acknowledging records the latest version once, on the session’s device; an older version is 409, an unknown one 404, and a second acknowledgement changes nothing', async () => {
    const org = await s.newOrg()
    const dpo = await s.person({ org, roles: ['dpo'] })
    const m = await s.person({ org })
    const [v0] = await versionIds(org)
    if (v0 === undefined) throw new Error('no stand-in')
    const v1 = await s.publishNotice(org, dpo, { acknowledge: [dpo] })
    const mc = await s.signIn(m)
    expect(await noticeOf(mc)).toMatchObject({ standing: 'required', current: { id: v1.id, version: 1 } })

    for (const [notice, status, code] of [
      [v0.id, 409, 'notice_changed'],
      [randomUUID(), 404, 'not_found'],
      ['not-a-version', 400, 'invalid_request'],
    ] as const) {
      const reply = await mc.post('/api/notice/acknowledge', { notice })
      expect([reply.status, reply.error], notice).toEqual([status, code])
    }
    const first = await mc.post('/api/notice/acknowledge', { notice: v1.id })
    expect([first.status, first.body]).toEqual([200, { version: 1, changed: true }])
    const second = await mc.post('/api/notice/acknowledge', { notice: v1.id })
    expect([second.status, second.body]).toEqual([200, { version: 1, changed: false }])

    // One row, in the app, on this session's device; one audit row and one event.
    const { deviceId } = await s.sessionOf(mc)
    expect(
      await s.query(
        'select method, device_id from notice_acknowledgments where person_id = $1 and notice_version_id = $2',
        [m.id, v1.id],
      ),
    ).toEqual([{ method: 'in_app', device_id: deviceId }])
    expect(
      await s.query<{ details: unknown; device_id: string }>(
        "select details, device_id from audit_events where org_id = $1 and action = 'notice.acknowledge' and actor_id = $2",
        [org.id, m.id],
      ),
    ).toEqual([{ details: { notice: v1.id, version: 1 }, device_id: deviceId }])
    expect(
      await s.query(
        "select entity_id, subject_ids, ids from outbox_events where org_id = $1 and type = 'notice.acknowledged' and entity_id = $2",
        [org.id, m.id],
      ),
    ).toEqual([{ entity_id: m.id, subject_ids: [m.id], ids: { notice: v1.id, version: 1 } }])
    expect((await noticeOf(mc)).standing).toBe('acknowledged')
  })

  it('NTI-06 PD-46 B-11: GET /api/notice answers whose it is, the standing, the current version, what changed since the generated version last acknowledged, and your acknowledgements; an ended session is 401 with no Set-Cookie', async () => {
    const org = await s.newOrg({ notice: 'none' })
    const dpo = await s.person({ org, roles: ['dpo'] })
    const m = await s.person({ org })
    const mc = await s.signIn(m)
    expect(await noticeOf(mc)).toEqual({
      person: m.id,
      standing: 'unpublished',
      current: null,
      changes: null,
      mine: [],
    })

    const v0 = await s.publishNotice(org, dpo, { acknowledge: [dpo, m] })
    const read = await noticeOf(mc)
    expect(read).toMatchObject({
      person: m.id,
      standing: 'acknowledged',
      current: { id: v0.id, version: 0 },
      changes: null,
    })
    expect(read.mine.map(row => [row.version, row.method])).toEqual([[0, 'in_app']])

    // The DPO changes a purpose's retention and publishes again: what changed is the purpose.
    const dpoClient = await s.signIn(dpo)
    const audit = RegistersResponse.parse((await dpoClient.get('/api/admin/registers')).body).purposes.find(
      row => row.purpose === 'security_audit',
    )
    if (audit === undefined) throw new Error('no security_audit entry')
    const changed = await dpoClient.post('/api/admin/registers/purposes/set', {
      purpose: 'security_audit',
      seen: audit.version,
      status: 'active',
      basis: audit.basis,
      basisReference: audit.basisReference,
      optOutDays: audit.optOutDays,
      retention: '2 years',
      providers: audit.providers,
    })
    expect(changed.status).toBe(200)
    const v1 = await s.publishNotice(org, dpo, { acknowledge: [dpo] })
    expect(await noticeOf(mc)).toMatchObject({
      standing: 'required',
      current: { id: v1.id, version: 1 },
      changes: {
        since: 0,
        purposes: { added: [], changed: ['security_audit'], removed: [] },
        providers: { added: [], changed: [], removed: [] },
        wording: false,
      },
    })

    // Another tab of the same browser signs out: this one's next poll is 401 and clears nothing.
    const other = s.client()
    other.setCookie(SESSION_COOKIE, mc.cookie(SESSION_COOKIE) ?? '')
    expect((await other.post('/api/auth/sign-out', {})).status).toBe(200)
    const ended = await mc.get('/api/notice')
    expect([ended.status, ended.error, ended.setCookies]).toEqual([401, 'signed_out', []])
  })

  it('NTI-07 B-07 T19 item 8: under production’s admission, a subscribe and then a removal from the team still drop the topic within the re-check’s bound, keeping the socket', async () => {
    const p = await s.person({ pin: s.newPin() })
    const team = await s.team()
    await s.addMember(team, p)
    const lone = await s.startRealtime({ recheckMs: 500, subscribe: false, admissionForTests: 'notice' })
    const socket = await s.gatewaySocket(await s.signIn(p), { url: lone.url })
    const topics = [`team:${team}`, `org:${s.org.id}`]
    expect(await socket.sub(topics)).toMatchObject({ ok: topics })
    await s.removeMember(team, p)
    const started = Date.now()
    expect(await socket.next('dropped', 5000)).toMatchObject({ topics: [`team:${team}`], reason: 'access' })
    expect(Date.now() - started).toBeLessThan(2000)
    // Admitted throughout: the person has acknowledged the latest version.
    expect(await closeWithin(socket.closed, 1200)).toBeUndefined()
    expect(socket.open()).toBe(true)
  })
})
