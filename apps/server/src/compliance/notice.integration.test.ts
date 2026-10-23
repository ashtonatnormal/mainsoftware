// The privacy notice on the Compose stack (PDPA-02, PDPA-03, ACC-12; C0.9 PR 2, TECH-SPEC T22 items
// 21 to 37): the real api over migrations 0010 and 0011, the DPO publishing through the routes on a
// PIN-rule session, people acknowledging through theirs, the acknowledgement gate on every
// signed-in REST route and on the gateway, and a worker instance whose copy of the registers reads
// what the latest version lists. From C0.9 PR 3a (PDPA-13; OD-10, OD-11, OD-18, OD-19; T22 items
// 38 to 49): the DPO's business contact, recorded through its route before v0 too and printed by
// every generated version, the acknowledgements the DPO records for someone who acknowledged
// outside Hearth, and deemed consent by conduct held back until its withdrawal can be carried out
// (NTI-03, NTI-08 to NTI-12). Each test that publishes makes its own org (B-08), so `-t` on one
// test works and no publish sends another test's people to /notice. The stack's realtime app, and
// those the tests start, run production's admission (admissionForTests: 'notice'; the other suites
// run none, C-07). `npm run test:integration` runs it with the stack up (`docker compose up -d
// --wait`).
//
// afterAll checks every reply was no-store and none a 500, that no Node warning fired, the outbox's
// contract for the run (every committed write covered; this suite owns notice.published and
// notice.acknowledged), and, when every test passed, that each of the notice's error codes was
// answered.
import { randomUUID } from 'node:crypto'
import {
  ACTIVE_FROM_START,
  AcknowledgeResponse,
  type ContactAdminJSON,
  ContactAdminResponse,
  ContactWriteResponse,
  contactProblems,
  GATEWAY_CLOSE,
  NOTICE_GENERATOR,
  type NoticeAdminJSON,
  NoticeAdminResponse,
  type NoticeJSON,
  NoticePeopleResponse,
  NoticeResponse,
  RegistersResponse,
  SessionResponse,
} from '@hearth/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SESSION_COOKIE } from '#src/auth/cookies.ts'
import { NOTICE_ERRORS } from '#src/compliance/notice.ts'
import { purposeAllowed } from '#src/compliance/registers.ts'
import {
  type Client,
  type Closed,
  HARNESS_CONTACT,
  type Org,
  type Person,
  type Stack,
  startStack,
} from '#src/testing/stack.ts'
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

// The DPO's contact page's answer, strictly as the server types it (C0.9 PD-70).
async function contactOf(client: Client): Promise<ContactAdminJSON> {
  const reply = await client.get('/api/admin/notice/contact')
  expect([reply.status, reply.error]).toEqual([200, undefined])
  return ContactAdminResponse.parse(reply.body)
}

// The DPO records their contact through its route from the version the page shows (C0.9 OD-10):
// HARNESS_CONTACT unless given. Answers the reply.
async function setContact(client: Client, change: Record<string, unknown> = {}) {
  const seen = (await contactOf(client)).contact?.version ?? null
  return client.post('/api/admin/notice/contact/set', { seen, ...HARNESS_CONTACT, ...change })
}

// Publishes the draft the DPO's Notice tab shows, through the route, and answers the new version.
async function publishDraft(client: Client): Promise<{ notice: string; version: number }> {
  const read = await adminNotice(client)
  if (read.draft.body === null || read.draft.digest === null) {
    throw new Error(`the draft has no words (${read.draft.problems.map(problem => problem.code).join(', ')})`)
  }
  const published = await client.post('/api/admin/notice/publish', {
    seen: read.latest?.version ?? null,
    digest: read.draft.digest,
  })
  expect([published.status, published.error]).toEqual([200, undefined])
  return published.json()
}

// Today in the org's own zone, as the recording's day is judged.
async function todayIn(org: Org): Promise<string> {
  const [row] = await s.query<{ today: string }>(
    'select ((now() at time zone time_zone)::date)::text as today from orgs where id = $1',
    [org.id],
  )
  if (row === undefined) throw new Error('no org')
  return row.today
}

const dayAfter = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

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
  // C0.9 PR 3a (OD-10, OD-19).
  'GET /api/admin/notice/contact': { class: 'gated' },
  'POST /api/admin/notice/contact/set': {
    class: 'gated',
    body: () => ({
      seen: null,
      title: 'Data Protection Officer',
      email: 'dpo@harness.example',
      phone: null,
      postal: null,
    }),
  },
  'GET /api/admin/notice/people': { class: 'gated' },
  'POST /api/admin/notice/acknowledgements/record': {
    class: 'gated',
    body: target => ({
      person: target.id,
      notice: '00000000-0000-4000-8000-000000000000',
      acknowledgedOn: new Date().toISOString().slice(0, 10),
      note: 'Signed a printed copy',
    }),
  },
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

  it('NTI-03 OD-01 C0.9 OD-10 PD-68 G-CONTACT-BEFORE-V0: before any version, the DPO records their contact with a fresh PIN, which the first publish needs; listing the people and recording an acknowledgement wait for a version, and an Owner reaches none of it', async () => {
    const org = await s.newOrg({ notice: 'none' })
    const dpo = await s.person({ org, roles: ['dpo'] })
    const owner = await s.person({ org, roles: ['owner'] })
    const member = await s.person({ org })
    const dpoClient = await s.signIn(dpo)
    const ownerClient = await s.signIn(owner)
    // The registers made ready, but no contact: the only problem, and no words to preview.
    await recordActivePurposes(dpoClient)
    const draft = await adminNotice(dpoClient)
    expect(draft.draft).toMatchObject({
      version: 0,
      body: null,
      digest: null,
      problems: [{ code: 'dpo_contact_pending' }],
    })
    const held = await dpoClient.post('/api/admin/notice/publish', { seen: null, digest: DIGEST })
    expect([held.status, held.error]).toEqual([400, 'notice_invalid'])
    expect(await contactOf(dpoClient)).toEqual({ notice: 'none', contact: null, stated: 'unpublished' })

    // Not setup uses (PD-44): nothing to record before v0, whatever can() would say.
    const people = await dpoClient.get('/api/admin/notice/people')
    expect([people.status, people.error]).toEqual([403, 'notice_required'])
    const recorded = await dpoClient.post('/api/admin/notice/acknowledgements/record', {
      person: member.id,
      notice: '00000000-0000-4000-8000-000000000000',
      acknowledgedOn: await todayIn(org),
      note: 'Signed a printed copy',
    })
    expect([recorded.status, recorded.error]).toEqual([403, 'notice_required'])

    // An Owner is sent to the notice on all four routes, before can() is asked.
    for (const reply of [
      await ownerClient.get('/api/admin/notice/contact'),
      await ownerClient.post('/api/admin/notice/contact/set', { seen: null, ...HARNESS_CONTACT }),
      await ownerClient.get('/api/admin/notice/people'),
      await ownerClient.post('/api/admin/notice/acknowledgements/record', {
        person: member.id,
        notice: '00000000-0000-4000-8000-000000000000',
        acknowledgedOn: await todayIn(org),
        note: 'Signed a printed copy',
      }),
    ]) {
      expect([reply.status, reply.error]).toEqual([403, 'notice_required'])
    }
    expect(await s.query('select 1 from dpo_settings where org_id = $1', [org.id])).toEqual([])

    // A PIN more than 5 minutes old is asked for again (PD-30), inline, then the contact records.
    await s.age((await s.sessionOf(dpoClient)).id, '6 minutes')
    const stale = await dpoClient.post('/api/admin/notice/contact/set', { seen: null, ...HARNESS_CONTACT })
    expect([stale.status, stale.error, stale.json<{ method?: string }>().method]).toEqual([
      403,
      'reauth_required',
      'pin',
    ])
    await s.reauth(dpoClient, dpo)
    const set = await dpoClient.post('/api/admin/notice/contact/set', { seen: null, ...HARNESS_CONTACT })
    expect([set.status, ContactWriteResponse.parse(set.body)]).toEqual([200, { version: 1, changed: true }])

    // Production's first publish can't deadlock: it goes through, and links the settings version.
    const { notice, version } = await publishDraft(dpoClient)
    expect(version).toBe(0)
    expect(
      await s.query('select dpo_settings_version from notice_versions where org_id = $1 and id = $2', [org.id, notice]),
    ).toEqual([{ dpo_settings_version: 1 }])
  })

  it('NTI-04 PD-36 PD-37 PD-40 PD-50: the DPO previews, is held back by problems, publishes with a fresh PIN the draft previewed (its words, links, audit row and event), a stale digest is refused, and the worker sees it notified', async () => {
    const org = await s.newOrg({ notice: 'none' })
    const dpo = await s.person({ org, roles: ['dpo'] })
    await s.person({ org })
    await s.person({ org, left: true })
    const dpoClient = await s.signIn(dpo)

    // The defaults' active purposes have no basis or retention, and no contact for the DPO is
    // recorded (C0.9 PD-68): problems, and nothing to show.
    const first = await adminNotice(dpoClient)
    expect(first).toMatchObject({ latest: null, draft: { version: 0, body: null, digest: null }, history: [] })
    expect(first.draft.problems.map(problem => problem.code)).toContain('purpose_basis_missing')
    expect(first.draft.problems.map(problem => problem.code)).toContain('dpo_contact_pending')
    const held = await dpoClient.post('/api/admin/notice/publish', { seen: null, digest: DIGEST })
    expect([held.status, held.error]).toEqual([400, 'notice_invalid'])

    await recordActivePurposes(dpoClient)
    expect((await setContact(dpoClient)).status).toBe(200)
    const ready = await adminNotice(dpoClient)
    expect(ready.draft.problems).toEqual([])
    expect(ready.draft.warnings.map(warning => warning.code)).toEqual(['production_access_pending'])
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
    expect(await versionIds(org)).toEqual([
      { id: notice, version: 0, generator: NOTICE_GENERATOR, body, published_by: dpo.id },
    ])
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
      details: { version: 0, was_version: null, generator: NOTICE_GENERATOR, clearances: {}, contact_version: 1 },
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
      contact: null,
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
        contact: 'same',
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

  it('NTI-08 C0.9 Done: the notice gives the DPO’s contact (OD-10, OD-12, PD-63 to PD-65, PD-72): recorded with a fresh PIN, once per change, held to its rules and AI_COPY before the database, audited by field name, printed under “Your rights” and answered to everyone', async () => {
    const org = await s.newOrg({ notice: 'none' })
    const dpo = await s.person({ org, roles: ['dpo'] })
    const owner = await s.person({ org, roles: ['owner'] })
    const m = await s.person({ org })
    const dpoClient = await s.signIn(dpo)
    await recordActivePurposes(dpoClient)

    const body = {
      seen: null,
      title: 'Data Protection Officer',
      email: 'dpo@harness.example',
      phone: null,
      postal: null,
    }
    const first = await dpoClient.post('/api/admin/notice/contact/set', body)
    expect([first.status, first.body]).toEqual([200, { version: 1, changed: true }])
    const same = await dpoClient.post('/api/admin/notice/contact/set', {
      ...body,
      seen: 1,
      title: ' Data Protection Officer ',
    })
    expect([same.status, same.body]).toEqual([200, { version: 1, changed: false }])
    const stale = await dpoClient.post('/api/admin/notice/contact/set', body)
    expect([stale.status, stale.error]).toEqual([409, 'register_changed'])
    for (const change of [
      { email: null },
      { title: 'Privacy agent' },
      { email: 'dpo at harness.example' },
      { postal: 'Ask at reception' },
    ]) {
      const refused = await dpoClient.post('/api/admin/notice/contact/set', { ...body, seen: 1, ...change })
      expect([refused.status, refused.error], JSON.stringify(change)).toEqual([400, 'register_invalid'])
    }
    // One version, one audit row: the fields that changed, never their values.
    expect(await s.query('select version from dpo_settings where org_id = $1', [org.id])).toEqual([{ version: 1 }])
    const audit = await s.query<{ actor_id: string; target_type: string; details: unknown }>(
      "select actor_id, target_type, details from audit_events where org_id = $1 and action = 'notice.contact_set'",
      [org.id],
    )
    expect(audit).toEqual([
      {
        actor_id: dpo.id,
        target_type: 'dpo_settings',
        details: { version: 1, was_version: null, changed: ['title', 'email'] },
      },
    ])
    expect(JSON.stringify(audit)).not.toContain('harness.example')
    // No outbox event for a contact (PD-72): nothing acts on it before the next published version.
    const [settings] = await s.query<{ id: string }>('select id from dpo_settings where org_id = $1', [org.id])
    expect(
      await s.query("select type from outbox_events where org_id = $1 and (entity_id = $2 or type like 'notice.%')", [
        org.id,
        settings?.id,
      ]),
    ).toEqual([])

    // The draft prints it under "Your rights", and the version publishes what was previewed.
    const draft = await adminNotice(dpoClient)
    expect(draft.draft.body).toMatch(
      /## Your rights\n[\s\S]*\n- Role: Data Protection Officer\n- Email: dpo@harness\.example$/,
    )
    expect(await contactOf(dpoClient)).toMatchObject({ notice: 'none', contact: { version: 1 }, stated: 'unpublished' })
    const { notice } = await publishDraft(dpoClient)
    const [stored] = await versionIds(org)
    expect(stored?.body).toBe(draft.draft.body)
    expect(await s.query('select dpo_settings_version from notice_versions where id = $1', [notice])).toEqual([
      { dpo_settings_version: 1 },
    ])
    expect(await acknowledgeCurrent(dpoClient)).toEqual({ version: 0, changed: true })
    expect(await contactOf(dpoClient)).toMatchObject({
      notice: 'up_to_date',
      contact: {
        version: 1,
        title: 'Data Protection Officer',
        email: 'dpo@harness.example',
        recordedOn: await todayIn(org),
        recordedBy: `Person ${dpo.id.slice(0, 8)}`,
      },
      stated: 'stated',
    })

    // Everyone reads the contact the latest version printed, before acknowledging it too.
    const mc = await s.signIn(m)
    expect((await noticeOf(mc)).contact).toEqual({
      title: 'Data Protection Officer',
      email: 'dpo@harness.example',
      phone: null,
      postal: null,
    })
    // An Owner, once past the gate, is can()'s to refuse.
    const ownerClient = await s.signIn(owner)
    await acknowledgeCurrent(ownerClient)
    const refused = await ownerClient.post('/api/admin/notice/contact/set', {
      ...body,
      seen: 1,
      email: 'x@harness.example',
    })
    expect([refused.status, refused.error]).toEqual([403, 'forbidden'])
    expect((await ownerClient.get('/api/admin/notice/contact')).error).toBe('forbidden')
  })

  it('NTI-09 C0.9 OD-11 PD-39 PD-67: a contact change makes the notice out of date, the printed contact stands until the next publish, which everyone acknowledges; the same details again read out of date and warn same_text', async () => {
    const org = await s.newOrg({ notice: 'none' })
    const dpo = await s.person({ org, roles: ['dpo'] })
    const m = await s.person({ org })
    const dpoClient = await s.signIn(dpo)
    await recordActivePurposes(dpoClient)
    expect((await setContact(dpoClient)).status).toBe(200)
    await publishDraft(dpoClient)
    await acknowledgeCurrent(dpoClient)
    const mc = await s.signIn(m)
    await acknowledgeCurrent(mc)

    const moved = await setContact(dpoClient, { email: 'privacy@harness.example' })
    expect([moved.status, moved.body]).toEqual([200, { version: 2, changed: true }])
    expect(RegistersResponse.parse((await dpoClient.get('/api/admin/registers')).body).notice).toBe('out_of_date')
    const changedDraft = await adminNotice(dpoClient)
    expect(changedDraft.draft.upToDate).toBe(false)
    expect(changedDraft.draft.changes).toMatchObject({ contact: 'changed', wording: false })
    expect((await contactOf(dpoClient)).stated).toBe('not_stated')
    // The member still reads what the published version printed.
    expect((await noticeOf(mc)).contact?.email).toBe('dpo@harness.example')

    await publishDraft(dpoClient)
    const refused = await mc.get('/api/admin/registers')
    expect([refused.status, refused.error]).toEqual([403, 'notice_required'])
    const read = await noticeOf(mc)
    expect(read).toMatchObject({ standing: 'required', contact: { email: 'privacy@harness.example' } })
    expect(read.changes).toMatchObject({ since: 0, contact: 'changed', wording: false })
    expect(await acknowledgeCurrent(mc)).toEqual({ version: 1, changed: true })
    expect((await mc.get('/api/admin/registers')).error).toBe('forbidden')

    // Away and back to the published details: a new settings version with the same words.
    await acknowledgeCurrent(dpoClient)
    expect((await setContact(dpoClient, { email: 'other@harness.example' })).status).toBe(200)
    const back = await setContact(dpoClient, { email: 'privacy@harness.example' })
    expect([back.status, back.body]).toEqual([200, { version: 4, changed: true }])
    expect(RegistersResponse.parse((await dpoClient.get('/api/admin/registers')).body).notice).toBe('out_of_date')
    const again = await adminNotice(dpoClient)
    expect(again.draft.warnings.map(warning => warning.code)).toContain('same_text')
    expect(again.draft.changes).toMatchObject({ contact: 'same' })
    expect((await publishDraft(dpoClient)).version).toBe(2)
  })

  it('NTI-10 C0.9 OD-19 PD-75 PD-76: the DPO lists the people still here and records someone’s acknowledgement made outside Hearth, which lets them in at once, appends notice.acknowledged and names nobody’s note in the audit; every other case is refused', async () => {
    const org = await s.newOrg({ notice: 'none' })
    const dpo = await s.person({ org, roles: ['dpo'] })
    const owner = await s.person({ org, roles: ['owner'] })
    const m = await s.person({ org })
    const leaver = await s.person({ org, left: true })
    const elsewhere = await s.person()
    const v0 = await s.publishNotice(org, dpo, { acknowledge: [dpo, owner] })
    const today = await todayIn(org)
    const mc = await s.signIn(m)
    const blocked = await mc.get('/api/admin/registers')
    expect([blocked.status, blocked.error]).toEqual([403, 'notice_required'])
    // A realtime app checking each socket every second, with production's admission.
    const app = await s.startRealtime({ recheckMs: 1000, subscribe: true, admissionForTests: 'notice' })

    const dpoClient = await s.signIn(dpo)
    const listed = await dpoClient.get('/api/admin/notice/people')
    expect([listed.status, listed.error]).toEqual([200, undefined])
    const people = NoticePeopleResponse.parse(listed.body)
    expect(people).toMatchObject({ today, latest: { notice: v0.id, version: 0, publishedOn: today }, more: false })
    // Everyone still here but the DPO, by name: roster facts only, never a number or a standing.
    expect(people.people.map(row => row.id).sort()).toEqual([owner.id, m.id].sort())
    for (const row of people.people) {
      expect(Object.keys(row).sort()).toEqual(['addedOn', 'department', 'id', 'manager', 'name'])
    }
    expect(JSON.stringify(listed.body)).not.toContain(m.e164)
    const before = (await adminNotice(dpoClient)).latest?.acknowledged

    const record = (change: Record<string, unknown> = {}) =>
      dpoClient.post('/api/admin/notice/acknowledgements/record', {
        person: m.id,
        notice: v0.id,
        acknowledgedOn: today,
        note: 'Signed a printed copy at induction',
        ...change,
      })
    const first = await record()
    expect([first.status, AcknowledgeResponse.parse(first.body)]).toEqual([200, { version: 0, changed: true }])
    // The event names the member, the DPO acting; the audit row names the day, never the note.
    expect(
      await s.query(
        "select entity_id, subject_ids, ids, actor_id from outbox_events where org_id = $1 and type = 'notice.acknowledged' and entity_id = $2",
        [org.id, m.id],
      ),
    ).toEqual([{ entity_id: m.id, subject_ids: [m.id], ids: { notice: v0.id, version: 0 }, actor_id: dpo.id }])
    const audit = await s.query<{ actor_id: string; target_id: string; details: unknown }>(
      "select actor_id, target_id, details from audit_events where org_id = $1 and action = 'notice.acknowledgement_recorded'",
      [org.id],
    )
    expect(audit).toEqual([
      { actor_id: dpo.id, target_id: m.id, details: { notice: v0.id, version: 0, acknowledged_on: today } },
    ])
    expect(JSON.stringify(audit)).not.toMatch(/printed/i)

    // The member is let through at once, over REST and on a socket.
    expect((await mc.get('/api/admin/registers')).error).toBe('forbidden')
    const socket = await s.gatewaySocket(mc, { url: app.url })
    expect(await socket.sub([`person:${m.id}`])).toMatchObject({ ok: [`person:${m.id}`] })
    expect(await closeWithin(socket.closed, 1500)).toBeUndefined()
    const mine = await noticeOf(mc)
    expect(mine.standing).toBe('acknowledged')
    expect(mine.mine).toEqual([
      expect.objectContaining({
        version: 0,
        method: 'recorded_by_dpo',
        acknowledgedOn: today,
        note: 'Signed a printed copy at induction',
      }),
    ])
    expect((await adminNotice(dpoClient)).latest?.acknowledged).toBe((before ?? 0) + 1)
    // Once per person and version: nothing more is recorded or appended.
    const second = await record()
    expect([second.status, second.body]).toEqual([200, { version: 0, changed: false }])
    expect(
      await s.query(
        "select 1 from outbox_events where org_id = $1 and type = 'notice.acknowledged' and entity_id = $2",
        [org.id, m.id],
      ),
    ).toHaveLength(1)

    // Refused: yourself, a leaver, another org's person and an unknown id (can()'s, before the
    // function), an unknown version, tomorrow and an AI_COPY word in the note.
    const recordedBefore = await s.query('select 1 from notice_acknowledgments where org_id = $1', [org.id])
    for (const [change, status, code] of [
      [{ person: dpo.id }, 403, 'forbidden'],
      [{ person: leaver.id }, 403, 'forbidden'],
      [{ person: elsewhere.id }, 403, 'forbidden'],
      [{ person: randomUUID() }, 403, 'forbidden'],
      [{ person: owner.id, notice: randomUUID() }, 404, 'not_found'],
      [{ person: owner.id, acknowledgedOn: dayAfter(today) }, 400, 'notice_invalid'],
      [{ person: owner.id, note: 'Signed with an agent present' }, 400, 'notice_invalid'],
      [{ person: owner.id, note: '   ' }, 400, 'notice_invalid'],
    ] as const) {
      const refused = await record(change)
      expect([refused.status, refused.error], JSON.stringify(change)).toEqual([status, code])
    }
    expect(await s.query('select 1 from notice_acknowledgments where org_id = $1', [org.id])).toHaveLength(
      recordedBefore.length,
    )
    // An Owner is refused the list and the record.
    const ownerClient = await s.signIn(owner)
    expect((await ownerClient.get('/api/admin/notice/people')).error).toBe('forbidden')
    expect(
      (
        await ownerClient.post('/api/admin/notice/acknowledgements/record', {
          person: m.id,
          notice: v0.id,
          acknowledgedOn: today,
          note: 'Signed a printed copy',
        })
      ).error,
    ).toBe('forbidden')

    // A newer version, after a contact change: recording one that is no longer the latest is 409.
    await s.recordContact(org, dpo, { ...HARNESS_CONTACT, email: 'privacy@harness.example' })
    await s.publishNotice(org, dpo, { acknowledge: [dpo] })
    const older = await record({ person: owner.id })
    expect([older.status, older.error]).toEqual([409, 'notice_changed'])
    // A PIN more than 5 minutes old is asked for again (PD-30).
    await s.age((await s.sessionOf(dpoClient)).id, '6 minutes')
    const stalePin = await record({ person: owner.id })
    expect([stalePin.status, stalePin.error, stalePin.json<{ method?: string }>().method]).toEqual([
      403,
      'reauth_required',
      'pin',
    ])
  })

  it('NTI-11 C0.9 OD-18 PD-73 PD-86: deemed consent by conduct is written and previewed, and held back until its withdrawal can be carried out for one person; consent and deemed consent by notification hold publishing back', async () => {
    const org = await s.newOrg({ notice: 'none' })
    const dpo = await s.person({ org, roles: ['dpo'] })
    const dpoClient = await s.signIn(dpo)
    await recordActivePurposes(dpoClient)
    expect((await setContact(dpoClient)).status).toBe(200)
    const entry = async () => {
      const read = RegistersResponse.parse((await dpoClient.get('/api/admin/registers')).body)
      const row = read.purposes.find(purpose => purpose.purpose === 'access_logs')
      if (row === undefined) throw new Error('no access_logs entry')
      return row
    }
    const setAccessLogs = async (basis: string, change: Record<string, unknown> = {}) => {
      const set = await dpoClient.post('/api/admin/registers/purposes/set', {
        purpose: 'access_logs',
        seen: (await entry()).version,
        status: 'active',
        basis,
        basisReference: null,
        optOutDays: null,
        retention: '1 year',
        providers: [],
        ...change,
      })
      expect([basis, set.status, set.error]).toEqual([basis, 200, undefined])
    }

    await setAccessLogs('deemed_consent_conduct')
    const conduct = await adminNotice(dpoClient)
    expect(conduct.draft.problems).toEqual([{ code: 'purpose_conduct_unstoppable', purpose: 'access_logs' }])
    const body = conduct.draft.body ?? ''
    expect(body).toContain('Legal basis: your deemed consent.')
    expect(body).toContain(
      'These purposes rest on your deemed consent, so they stop for you if you withdraw it:\n\n- Access logs and “viewed by” lists',
    )
    expect(body).toContain(
      "The other purposes under “Why your data is processed” don't rest on consent, so they continue",
    )
    const held = await dpoClient.post('/api/admin/notice/publish', { seen: null, digest: conduct.draft.digest })
    expect([held.status, held.error]).toEqual([400, 'notice_invalid'])
    expect(await versionIds(org)).toEqual([])

    for (const [basis, change] of [
      ['consent', {}],
      ['deemed_consent_notification', { basisReference: 'Notified on 1 October 2026', optOutDays: 30 }],
    ] as const) {
      await setAccessLogs(basis, change)
      const draft = await adminNotice(dpoClient)
      expect(draft.draft.problems, basis).toEqual([{ code: 'purpose_consent_basis', purpose: 'access_logs' }])
      const refused = await dpoClient.post('/api/admin/notice/publish', { seen: null, digest: DIGEST })
      expect([refused.status, refused.error], basis).toEqual([400, 'notice_invalid'])
    }
    expect(await versionIds(org)).toEqual([])
  })

  it('NTI-12 C0.9 PD-64 PD-65: contactProblems() and set_dpo_contact() refuse the same samples, first problem first; a contact with AI_COPY wording written past the route holds publishing back, naming its field', async () => {
    const org = await s.newOrg({ notice: 'none' })
    const dpo = await s.person({ org, roles: ['dpo'] })
    // set_dpo_contact()'s refusals, by their words (0011), as contactProblems() codes them.
    const CODES: ReadonlyArray<[RegExp, string]> = [
      [/^Give the role title/, 'title_missing'],
      [/^Keep the role title/, 'title_long'],
      [/^Give at least one way to reach you/, 'channel_missing'],
      [/^Enter an email address/, 'email_shape'],
      [/^Enter the phone number/, 'phone_shape'],
      [/^Keep the postal address/, 'postal_long'],
    ]
    const title = 'Data Protection Officer'
    const samples: Array<{ title: string | null; email: string | null; phone: string | null; postal: string | null }> =
      [
        { title, email: 'dpo@harness.example', phone: null, postal: null },
        { title: ` ${title}　`, email: ' dpo@harness.example ', phone: null, postal: null },
        { title: '', email: 'dpo@harness.example', phone: null, postal: null },
        { title: ' \t ', email: null, phone: null, postal: null },
        { title: null, email: 'not an address', phone: null, postal: null },
        { title: 'x'.repeat(120), email: 'dpo@harness.example', phone: null, postal: null },
        { title: 'x'.repeat(121), email: 'dpo@harness.example', phone: null, postal: null },
        { title: '\u{1F600}'.repeat(120), email: 'dpo@harness.example', phone: null, postal: null },
        { title: '\u{1F600}'.repeat(121), email: 'dpo@harness.example', phone: null, postal: null },
        { title: 'Data\nProtection Officer', email: 'dpo@harness.example', phone: null, postal: null },
        { title: 'Data​Protection', email: 'dpo@harness.example', phone: null, postal: null },
        { title, email: null, phone: null, postal: null },
        { title, email: '   ', phone: '', postal: ' \n ' },
        { title, email: 'dpo@harness', phone: null, postal: null },
        { title, email: 'dpo@@harness.example', phone: null, postal: null },
        { title, email: 'd p@harness.example', phone: null, postal: null },
        { title, email: 'dpo@harness.example?cc=x', phone: null, postal: null },
        { title, email: 'dpo%40@harness.example', phone: null, postal: null },
        {
          title,
          email: `${'x'.repeat(64)}@${'y'.repeat(63)}.${'z'.repeat(63)}.${'w'.repeat(57)}.ex`,
          phone: null,
          postal: null,
        },
        { title, email: `${'x'.repeat(65)}@harness.example`, phone: null, postal: null },
        { title, email: 'not an address', phone: 'not a number', postal: null },
        { title, email: null, phone: '+65 8000 0196', postal: null },
        { title, email: null, phone: '+65-8000-0197', postal: null },
        { title, email: null, phone: '+6580000198', postal: null },
        { title, email: null, phone: '6580000196', postal: null },
        { title, email: null, phone: '+65  8000 0196', postal: null },
        { title, email: null, phone: '+0 8000 0196', postal: null },
        { title, email: null, phone: '+123456', postal: null },
        { title, email: null, phone: `+1${'2'.repeat(14)}`, postal: null },
        { title, email: null, phone: `+1${'2'.repeat(15)}`, postal: null },
        { title, email: null, phone: null, postal: '1 Fictional Road\nSingapore 000000' },
        { title, email: null, phone: null, postal: '  1 Fictional Road\n  Unit 2  ' },
        { title, email: null, phone: null, postal: '1 Fictional Road\n\nSingapore' },
        { title, email: null, phone: null, postal: '1 Fictional Road\n \t\nSingapore' },
        { title, email: null, phone: null, postal: '1 Fictional Road\n \nSingapore' },
        { title, email: null, phone: null, postal: '1 Fictional Road\r\nSingapore' },
        { title, email: null, phone: null, postal: '1 Fictional\tRoad' },
        { title, email: null, phone: null, postal: 'x'.repeat(500) },
        { title, email: null, phone: null, postal: 'x'.repeat(501) },
        { title, email: 'bad', phone: null, postal: 'x'.repeat(501) },
      ]
    for (const sample of samples) {
      const expected = contactProblems(sample).find(problem => problem.code !== 'ai_copy')?.code ?? 'saved'
      await s.query('begin')
      let got: string
      try {
        await s.query("select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [
          org.id,
          dpo.id,
        ])
        await s.query('select version from public.set_dpo_contact(null, $1, $2, $3, $4, $5, null, null)', [
          sample.title,
          sample.email,
          sample.phone,
          sample.postal,
          randomUUID(),
        ])
        got = 'saved'
      } catch (error) {
        const { code, message } = error as { code?: string; message?: string }
        got =
          code === 'HF006'
            ? (CODES.find(([words]) => words.test(message ?? ''))?.[1] ?? `HF006: ${message}`)
            : `${code}`
      } finally {
        await s.query('rollback')
      }
      expect(got, JSON.stringify(sample)).toBe(expected)
    }

    // AI_COPY is the route's alone: a contact written straight through the function holds
    // publishing back at the next draft, naming the field (PD-65).
    await s.recordContact(org, dpo, { title: 'Privacy agent', email: 'dpo@harness.example', phone: null, postal: null })
    const dpoClient = await s.signIn(dpo)
    await recordActivePurposes(dpoClient)
    const draft = await adminNotice(dpoClient)
    expect(draft.draft.problems).toEqual([{ code: 'free_text_ai_copy', field: 'contact_title' }])
    expect(draft.draft.body).toBeNull()
    const held = await dpoClient.post('/api/admin/notice/publish', { seen: null, digest: DIGEST })
    expect([held.status, held.error]).toEqual([400, 'notice_invalid'])
  })
})
