// Sign-in, devices and socket revocation against the Compose stack (BUILD-PLAN C0.5's "Done
// when"): the real api and realtime apps, Postgres and Valkey, through the routes a
// browser uses. `npm run test:integration` runs it (Vitest's integration mode), with the stack up
// (`docker compose up -d --wait`). The harness (testing/stack.ts) builds a throwaway database and
// Valkey key prefix for the run.
//
// Each test makes its own people and clients and reads no other test's state, so `-t` on one test
// works. PRD-53 allows each number 3 code requests per 10 minutes, and that isn't loosened for
// tests: each test's first comment gives every person's budget, never above 3. No test waits for a
// window or a lock to pass: the harness seeds or moves stored values instead.
//
// afterAll sweeps the whole run: no log line or audit row holds a number, code, PIN, session token
// or attempt id; every /api reply was no-store and held no token or attempt id; no Node warning
// fired (testing/leaks.ts, which the dormant passkey suite runs too); and every write a runtime role
// committed is exempt or had its outbox event naming it (C0.6, T16 item 7; testing/writes.ts). When
// every test ran and passed, it also checks that every error code was answered, every audit action
// written and every event type this suite owns appended, at least once; the exceptions are
// try_again, internal, the flags route's codes (which flags.integration.test.ts sees), and the
// dormant passkey codes and actions (testing/dormant.ts, D46; passkeys.integration.test.ts sees
// them).
import { type AddressInfo, connect } from 'node:net'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuditAction } from '#src/auth/audit.ts'
import { ATTEMPT_COOKIE, SESSION_COOKIE } from '#src/auth/cookies.ts'
import { keyName, tag } from '#src/auth/crypto.ts'
import { MESSAGES } from '#src/auth/errors.ts'
import { limitSubject } from '#src/auth/limiter.ts'
import { LIMITS, OTP } from '#src/auth/policy.ts'
import { FakeVerify } from '#src/auth/sms/fake.ts'
import { withOrg } from '#src/db/database.ts'
import { FLAG_ERRORS } from '#src/flags/set.ts'
import { DORMANT_ACTIONS, DORMANT_ERRORS } from '#src/testing/dormant.ts'
import { expectNothingLeaked } from '#src/testing/leaks.ts'
import { APP_ORIGIN, type Client, type Closed, type Person, type Stack, startStack } from '#src/testing/stack.ts'
import { expectEveryWriteCovered, sweepWrites } from '#src/testing/writes.ts'

// The dormant passkey routes (D46), unregistered while passkeys are off.
const PASSKEY_ROUTES = [
  '/api/auth/passkey/options',
  '/api/auth/passkey/verify',
  '/api/auth/reauth/passkey/options',
  '/api/auth/reauth/passkey/verify',
  '/api/auth/passkeys/register/options',
  '/api/auth/passkeys/register/verify',
  '/api/auth/passkeys/remove',
]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ISSUED_PIN_HASH = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/

// Every audit action, so the sweep can check each was written; the type keeps the list complete.
const AUDIT_ACTIONS = {
  'auth.code_requested': true,
  'auth.code_failed': true,
  'auth.sign_in': true,
  'auth.pin_set': true,
  'auth.pin_failed': true,
  'auth.pin_locked': true,
  'auth.passkey_added': true,
  'auth.passkey_removed': true,
  'auth.passkey_failed': true,
  'auth.reauth': true,
  'auth.sign_out': true,
  'auth.device_sign_out': true,
  'person.deactivate': true,
  'person.reset_pin': true,
  'person.sign_out_devices': true,
} as const satisfies Record<AuditAction, true>

interface AuditRow {
  action: string
  actor_id: string | null
  target_id: string
  device_id: string | null
  ip: string | null
  request_id: string | null
  reason: string | null
  details: Record<string, unknown>
}

interface UserRow {
  pin_hash: string | null
  pin_set_at: Date | null
  pin_failures: number
  pin_last_failed_at: Date | null
  pin_reset_at: Date | null
  pin_reset_by: string | null
}

let s: Stack

const requestCode = (client: Client, phone: string) => client.post('/api/auth/otp/request', { phone })
const verifyCode = (client: Client, code: string) => client.post('/api/auth/otp/verify', { code })
const verifyPin = (client: Client, pin: string) => client.post('/api/auth/pin/verify', { pin })

// A code, or a PIN, that isn't this one.
const another = (digits: string) => String((Number(digits) + 1) % 1_000_000).padStart(6, '0')

const pinOf = (person: Person): string => {
  if (person.pin === undefined) throw new Error('that person has no PIN yet')
  return person.pin
}

async function auditOf(person: Person): Promise<AuditRow[]> {
  return s.query<AuditRow>(
    `select action, actor_id, target_id, device_id, host(ip) as ip, request_id, reason, details
     from audit_events where org_id = $1 and target_id = $2 order by id`,
    [person.orgId, person.id],
  )
}

interface EventRow {
  type: string
  actor_id: string
  actor_kind: string
  entity_id: string
  subject_ids: string[]
  purpose: string
  ids: Record<string, unknown>
}

// The outbox events about a person, in the order consumers read them (C0.6, T16).
async function eventsOf(person: Person): Promise<EventRow[]> {
  return s.query<EventRow>(
    `select type, actor_id, actor_kind, entity_id, subject_ids, purpose, ids from outbox_events
     where org_id = $1 and (entity_id = $2 or $2 = any(subject_ids)) order by tx_id, id`,
    [person.orgId, person.id],
  )
}

// An event about one person, as the sign-in, device and admin routes append them.
const about = (person: Person, type: string, actor: Person, ids: Record<string, unknown> = {}) => ({
  type,
  actor_id: actor.id,
  actor_kind: 'human',
  entity_id: person.id,
  subject_ids: [person.id],
  purpose: 'accounts',
  ids,
})

// An event's ids with its lists sorted, to compare with ids read in another order.
const sortedIds = (ids: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(ids).map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value]))

async function userOf(person: Person): Promise<UserRow | undefined> {
  const [row] = await s.query<UserRow>(
    `select pin_hash, pin_set_at, pin_failures, pin_last_failed_at, pin_reset_at, pin_reset_by
     from users where id = $1`,
    [person.id],
  )
  return row
}

// Moves the last PIN failure back, as though the 15-minute lock had passed (the count stays).
async function lockPassed(person: Person): Promise<void> {
  await s.query("update users set pin_last_failed_at = pin_last_failed_at - interval '16 minutes' where id = $1", [
    person.id,
  ])
}

// Moves a session's start, re-authentication and expiry back 2161 hours, leaving its last-seen
// time: a session past its 90 days that was used today. The stamping trigger is off for the one
// statement, as in the harness's age().
async function pastExpiry(sessionId: string): Promise<void> {
  await s.query('begin')
  try {
    await s.query('set local session_replication_role = replica')
    await s.query(
      `update sessions set created_at = created_at - interval '2161 hours',
         reauthenticated_at = reauthenticated_at - interval '2161 hours', expires_at = expires_at - interval '2161 hours'
       where id = $1`,
      [sessionId],
    )
    await s.query('commit')
  } catch (error) {
    await s.query('rollback')
    throw error
  }
}

// A client that has asked for a code for the person and checked it: at the step after the code.
async function atStepUp(person: Person): Promise<{ client: Client; reply: Awaited<ReturnType<Client['post']>> }> {
  const client = s.client()
  const requested = await requestCode(client, person.e164)
  expect(requested.status).toBe(200)
  const reply = await verifyCode(client, await s.sms.nextCode(person.e164))
  expect(reply.status).toBe(200)
  return { client, reply }
}

async function socket(client: Client, url?: string): Promise<{ closed: Promise<Closed> }> {
  const opened = await s.openSocket(client, url === undefined ? {} : { url })
  if (!('ws' in opened)) throw new Error(`the socket did not open: ${opened.status}`)
  return opened
}

// The close, or a failure if the socket is still open after 5 s.
async function closeOf(closed: Promise<Closed>): Promise<Closed> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), 5000)
  })
  const result = await Promise.race([closed, late])
  clearTimeout(timer)
  if (result === undefined) throw new Error('the socket was still open after 5 s')
  return result
}

// Valkey's own clock, in ms, which the limiter's windows use.
async function valkeyNow(): Promise<number> {
  const [seconds, micros] = await s.valkey.time()
  return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000)
}

// Waits up to 5 s for check to pass, then fails with what it last saw.
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000
  for (;;) {
    const value = await read()
    if (check(value)) return value
    if (Date.now() > deadline) throw new Error(`still not as expected after 5 s: ${JSON.stringify(value)}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

// Waits until at least this many backends on the run's database are waiting on a lock. The
// statistics snapshot is cleared first, since one is kept for the rest of a transaction.
async function lockWaiters(count: number): Promise<void> {
  await eventually(
    async () => {
      await s.query('select pg_stat_clear_snapshot()')
      const [row] = await s.query<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
      )
      return row?.n ?? 0
    },
    n => n >= count,
  )
}

// The api app's port, listening on first use (requests otherwise go through inject).
let apiPort: number | undefined
async function listeningApi(): Promise<number> {
  if (apiPort === undefined) {
    await s.api.listen({ host: '127.0.0.1', port: 0 })
    apiPort = (s.api.server.address() as AddressInfo).port
  }
  return apiPort
}

// Sends a POST as this client over a socket of its own, and closes the connection as soon as the
// request is written: a client that hangs up before the reply. Resolves once the server has
// closed its side too.
async function hangUp(client: Client, path: string, body: unknown): Promise<void> {
  const port = await listeningApi()
  const payload = JSON.stringify(body)
  const cookie = client.cookieHeader()
  const socket = connect(port, '127.0.0.1')
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
  socket.on('error', () => {})
  socket.end(
    [
      `POST ${path} HTTP/1.1`,
      'Host: 127.0.0.1',
      `Origin: ${APP_ORIGIN}`,
      `User-Agent: ${client.userAgent}`,
      `X-Forwarded-For: ${client.ip}`,
      ...(cookie === '' ? [] : [`Cookie: ${cookie}`]),
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(payload)}`,
      '',
      payload,
    ].join('\r\n'),
  )
  await closed
}

// Fills a sliding window with `count` hits at `at` (Valkey ms).
async function seedWindow(key: string, count: number, at: number): Promise<void> {
  const members: (string | number)[] = []
  for (let i = 0; i < count; i++) members.push(at, `seeded-${i}`)
  await s.valkey.zadd(key, ...members)
  await s.valkey.pexpire(key, 86_400_000)
}

// The reauth_wrong_method warn lines logged for this person (D46, I2, AUTH-DESIGN §8.2), as
// [level, route], after checking each holds the person's id and the route and no other personal
// data: no method, number or code.
function wrongMethodLines(personId: string): [unknown, unknown][] {
  const lines = s.logs.filter(line => line.event === 'reauth_wrong_method' && line.personId === personId)
  for (const line of lines) {
    expect(line).toEqual({
      level: 40,
      time: expect.any(Number),
      role: 'api',
      reqId: expect.any(String),
      msg: expect.any(String),
      event: 'reauth_wrong_method',
      personId,
      route: expect.any(String),
    })
  }
  return lines.map(line => [line.level, line.route])
}

describe('C0.5 sign-in, devices and socket revocation on the Compose stack (ACC-01..06, PRD-53, T5, T14)', () => {
  beforeAll(async () => {
    s = await startStack()
  })

  // Each test starts with the global SMS cap (PRD-53: 100 texts an hour) empty. Every api in the
  // suite shares the run's key prefix, so otherwise each text the whole file sends counts against
  // one hour's cap, and a test that came after the 100th would find its sends skipped_cap and its
  // nextCode waits timing out far from the cause. The cap's own test fills it and clears it.
  beforeEach(async () => {
    if (s !== undefined) await s.valkey.del(s.names.limit('sms-global', 'all'))
  })

  // Vitest needs the first argument destructured; the second is this suite.
  // biome-ignore lint/correctness/noEmptyPattern: the hook takes no fixtures.
  afterAll(async ({}, suite) => {
    if (s === undefined) return
    try {
      // No log line or audit row holds a number, code, PIN, token or attempt id, every /api reply
      // was no-store with no token or attempt id and none a 500, and no Node warning fired.
      await expectNothingLeaked(s)

      // C0.6: every write a runtime role committed is covered by its outbox event, or exempt.
      const all = suite.tasks.every(task => task.type !== 'test' || task.result?.state === 'pass')
      await expectEveryWriteCovered(s.superuser, 'sign-in', { allPassed: all && suite.tasks.length > 0 })

      // When every test ran and passed, every code and every audit action was seen.
      if (all && suite.tasks.length > 0) {
        const answered = new Set(s.replies.map(reply => reply.error))
        // The dormant passkey codes and actions are the passkey suite's (D46, testing/dormant.ts).
        const elsewhere = new Set<string>(['try_again', 'internal', ...FLAG_ERRORS, ...DORMANT_ERRORS])
        const missing = Object.keys(MESSAGES).filter(code => !elsewhere.has(code) && !answered.has(code))
        expect(missing).toEqual([])
        const written = new Set(
          (await s.query<{ action: string }>('select distinct action from audit_events')).map(r => r.action),
        )
        expect(
          (Object.keys(AUDIT_ACTIONS) as (keyof typeof AUDIT_ACTIONS)[]).filter(
            action => !DORMANT_ACTIONS.has(action) && !written.has(action),
          ),
        ).toEqual([])
      }
    } finally {
      await s.stop()
    }
  })

  it('D46 AQ-02: a Member signs in on the SMS code alone, making their account with no PIN (ACC-01, ACC-03, T5)', async () => {
    // Budgets: M 1 code request.
    const m = await s.person()
    const browser = s.client()
    expect((await requestCode(browser, m.e164)).status).toBe(200)
    const verified = await verifyCode(browser, await s.sms.nextCode(m.e164))
    expect(verified.status).toBe(200)
    const token = browser.cookie(SESSION_COOKIE) ?? ''
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(verified.setCookies).toEqual([
      `${SESSION_COOKIE}=${token}; Path=/; Max-Age=7776000; HttpOnly; Secure; SameSite=Lax`,
      `${ATTEMPT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
    ])
    const { id: sessionId, deviceId } = await s.sessionOf(browser)
    expect(verified.body).toEqual({ status: 'signed_in', device: { id: deviceId, label: 'iPhone · Safari' } })
    const user = await userOf(m)
    expect(user).toBeDefined()
    expect(user?.pin_hash).toBeNull()
    const [term] = await s.query<{ full_term: boolean; stamped: boolean }>(
      `select expires_at - created_at = interval '2160 hours' as full_term, reauthenticated_at = created_at as stamped
       from sessions where id = $1`,
      [sessionId],
    )
    expect(term).toEqual({ full_term: true, stamped: true })
    expect((await auditOf(m)).map(row => row.action)).toEqual(['auth.code_requested', 'auth.sign_in'])
    expect((await auditOf(m))[1]).toMatchObject({ actor_id: m.id, details: { method: 'sms', pinRule: false } })
    expect(await eventsOf(m)).toEqual([
      about(m, 'signin.started', m, { device: deviceId, session: sessionId, method: 'sms', pin_rule: false }),
    ])
    // The spent attempt can't be used again, with the right code or any other.
    expect((await verifyCode(browser, '000000')).error).toBe('attempt_expired')
  })

  it('C0.5 Done D46: a PIN-role holder signs in with an SMS code and a new PIN, on a 7-day PIN-rule session (ACC-01, ACC-02, ACC-03, T5, AQ-05)', async () => {
    // Budgets: P 1 code request, Q 2.
    const p = await s.person({ roles: ['leadership'] })
    const q = await s.person({ roles: ['dpo'] })
    const browser = s.client()
    const sentBefore = s.sms.sent.length

    const requested = await requestCode(browser, p.e164)
    expect(requested.status).toBe(200)
    expect(requested.body).toEqual({ status: 'code_sent', expiresInSeconds: 300, codeLength: 6 })
    const attemptId = browser.cookie(ATTEMPT_COOKIE) ?? ''
    expect(attemptId).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(requested.setCookies).toEqual([
      `${ATTEMPT_COOKIE}=${attemptId}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Strict`,
    ])
    // T20: the challenge record is kept 10 minutes (checks are refused after 5, from its born time),
    // and holds the owner, the provider's reference, the tries and born: never a code or number.
    const otpKey = s.names.otp(tag(s.keys, p.e164))
    const otpTtl = await s.valkey.pttl(otpKey)
    expect(otpTtl).toBeGreaterThan(595_000)
    expect(otpTtl).toBeLessThanOrEqual(600_000)
    const record = await s.valkey.hgetall(otpKey)
    expect(Object.keys(record).sort()).toEqual(['born', 'owner', 'ref', 'tries'])
    expect(record).toMatchObject({ owner: keyName(attemptId), ref: s.sms.sent.at(-1)?.ref, tries: '0' })
    const attemptTtl = await s.valkey.pttl(s.names.attempt(keyName(attemptId)))
    expect(attemptTtl).toBeGreaterThan(0)
    expect(attemptTtl).toBeLessThanOrEqual(600_000)

    // Only P's number got a text.
    expect(s.sms.sent.slice(sentBefore).map(sent => sent.to)).toEqual([p.e164])
    const code = await s.sms.nextCode(p.e164)
    const verified = await verifyCode(browser, code)
    expect(verified.status).toBe(200)
    expect(verified.body).toEqual({ status: 'code_verified', next: 'set_pin' })

    const easy = await browser.post('/api/auth/pin/set', { pin: '123456' })
    expect(easy.status).toBe(422)
    expect(easy.error).toBe('pin_too_easy')
    const pin = s.newPin()
    const set = await browser.post('/api/auth/pin/set', { pin })
    expect(set.status).toBe(200)
    p.pin = pin
    const token = browser.cookie(SESSION_COOKIE) ?? ''
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(set.setCookies).toEqual([
      `${SESSION_COOKIE}=${token}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax`,
      `${ATTEMPT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
    ])
    expect(browser.cookie(ATTEMPT_COOKIE)).toBeUndefined()
    const { id: sessionId, deviceId } = await s.sessionOf(browser)
    expect(set.body).toEqual({ status: 'signed_in', device: { id: deviceId, label: 'iPhone · Safari' } })

    // The spent attempt can't be used again.
    const replay = s.client()
    replay.setCookie(ATTEMPT_COOKIE, attemptId)
    const spent = await verifyCode(replay, code)
    expect(spent.status).toBe(401)
    expect(spent.error).toBe('attempt_expired')

    // The account and session.
    const user = await userOf(p)
    expect(user?.pin_hash).toMatch(ISSUED_PIN_HASH)
    expect(user?.pin_set_at).toBeInstanceOf(Date)
    const sessionTimes = () =>
      s.query<{ stamped: boolean; full_term: boolean; session_age: string; device_age: string }>(
        `select s.reauthenticated_at = s.created_at as stamped,
           s.expires_at - s.created_at = interval '168 hours' as full_term,
           extract(epoch from now() - s.last_seen_at)::text as session_age,
           extract(epoch from now() - d.last_seen_at)::text as device_age
         from sessions s join devices d on d.id = s.device_id where s.id = $1`,
        [sessionId],
      )
    expect((await sessionTimes())[0]).toMatchObject({ stamped: true, full_term: true })

    // Two minutes later, one request writes the session's and the device's last-seen times.
    await s.age(sessionId, '2 minutes')
    const devices = await browser.get('/api/devices')
    expect(devices.status).toBe(200)
    expect(devices.body).toMatchObject({
      devices: [{ id: deviceId, label: 'iPhone · Safari', current: true }],
    })
    // Passkeys are switched off (D46), so none are listed.
    expect(devices.body).not.toHaveProperty('passkeys')
    expect(devices.json<{ devices: unknown[] }>().devices).toHaveLength(1)
    const [after] = await sessionTimes()
    expect(after).toMatchObject({ stamped: true, full_term: true })
    expect(Number(after?.session_age)).toBeLessThan(10)
    expect(Number(after?.device_age)).toBeLessThan(10)

    // The audit log, in order.
    const rows = await auditOf(p)
    expect(rows.map(row => row.action)).toEqual(['auth.code_requested', 'auth.sign_in', 'auth.pin_set'])
    expect(rows[0]).toMatchObject({
      actor_id: null,
      target_id: p.id,
      device_id: null,
      ip: browser.ip,
      details: { send: 'attempted' },
    })
    expect(rows[0]?.request_id).toMatch(UUID)
    expect(rows[1]).toMatchObject({
      actor_id: p.id,
      device_id: deviceId,
      ip: browser.ip,
      details: { method: 'sms_new_pin', pinRule: true },
    })
    expect(rows[2]).toMatchObject({ actor_id: p.id, device_id: deviceId })
    // C0.6 T16: the outbox events beside the writes. Before a session exists the transaction acts
    // as Hearth, so they name the person as their actor, as the audit rows do.
    expect(await eventsOf(p)).toEqual([
      about(p, 'signin.started', p, { device: deviceId, session: sessionId, method: 'sms_new_pin', pin_rule: true }),
      about(p, 'account.pin_set', p),
    ])

    // pin_already_set: two browsers reach set_pin; the second to set a PIN is refused.
    const a = s.client()
    expect((await requestCode(a, q.e164)).status).toBe(200)
    expect((await verifyCode(a, await s.sms.nextCode(q.e164))).body).toMatchObject({ next: 'set_pin' })
    const b = s.client()
    expect((await requestCode(b, q.e164)).status).toBe(200)
    const early = await verifyPin(b, '381904')
    expect(early.status).toBe(409)
    expect(early.error).toBe('wrong_step')
    expect((await verifyCode(b, await s.sms.nextCode(q.e164))).body).toMatchObject({ next: 'set_pin' })
    expect((await a.post('/api/auth/pin/set', { pin: s.newPin() })).status).toBe(200)
    const late = await b.post('/api/auth/pin/set', { pin: s.newPin() })
    expect(late.status).toBe(409)
    expect(late.error).toBe('pin_already_set')
    // The refused one rolled back with everything it wrote, events included (T16).
    expect((await eventsOf(q)).map(event => event.type)).toEqual(['signin.started', 'account.pin_set'])

    // Bad input, never echoed.
    const bad = s.client()
    expect((await requestCode(bad, 'abc')).error).toBe('invalid_phone')
    const unknownKey = await bad.post('/api/auth/otp/request', { phone: '1', x: 1 })
    expect([unknownKey.status, unknownKey.error]).toEqual([400, 'invalid_request'])
    const badCode = await verifyCode(bad, 'abc')
    expect([badCode.status, badCode.error]).toEqual([400, 'invalid_code'])
    const badPin = await browser.post('/api/auth/reauth/pin', { pin: '12' })
    expect([badPin.status, badPin.error]).toEqual([400, 'invalid_pin'])
  })

  it('D46 AQ-02 AQ-05: each of the six Owner-only roles sets or enters a PIN after the code and gets a 7-day PIN-rule session; a Member and a Team Admin sign in on the code alone', async () => {
    // Budgets: one code request each.
    // The session a PIN step issues: 7 days on its cookie and its row, and pin_rule (pinRule) on its
    // signin.started event and its auth.sign_in row, with the method of that step.
    const pinRuleSession = async (
      person: Person,
      client: Client,
      finished: Awaited<ReturnType<Client['post']>>,
      method: 'sms_new_pin' | 'sms_pin',
      role: string,
    ) => {
      expect(finished.status, role).toBe(200)
      const { id: sessionId, deviceId } = await s.sessionOf(client)
      expect(finished.body, role).toEqual({ status: 'signed_in', device: { id: deviceId, label: 'iPhone · Safari' } })
      expect(finished.setCookies, role).toEqual([
        `${SESSION_COOKIE}=${client.cookie(SESSION_COOKIE)}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax`,
        `${ATTEMPT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
      ])
      const [term] = await s.query<{ pin_rule: boolean }>(
        "select expires_at - created_at = interval '168 hours' as pin_rule from sessions where id = $1",
        [sessionId],
      )
      expect(term?.pin_rule, role).toBe(true)
      expect(
        (await eventsOf(person)).filter(event => event.type === 'signin.started'),
        role,
      ).toEqual([
        about(person, 'signin.started', person, { device: deviceId, session: sessionId, method, pin_rule: true }),
      ])
      expect(
        (await auditOf(person)).filter(row => row.action === 'auth.sign_in'),
        role,
      ).toEqual([
        expect.objectContaining({ actor_id: person.id, device_id: deviceId, details: { method, pinRule: true } }),
      ])
    }
    for (const role of ['owner', 'admin', 'ai_admin', 'leadership', 'dpo', 'compliance_officer'] as const) {
      const first = await s.person({ roles: [role] })
      const toSet = await atStepUp(first)
      expect(toSet.reply.body, role).toEqual({ status: 'code_verified', next: 'set_pin' })
      const pin = s.newPin()
      await pinRuleSession(
        first,
        toSet.client,
        await toSet.client.post('/api/auth/pin/set', { pin }),
        'sms_new_pin',
        role,
      )
      first.pin = pin
      const again = await s.person({ roles: [role], pin: s.newPin() })
      const toEnter = await atStepUp(again)
      expect(toEnter.reply.body, role).toMatchObject({
        status: 'code_verified',
        next: 'step_up',
        pin: { state: 'ok' },
      })
      await pinRuleSession(again, toEnter.client, await verifyPin(toEnter.client, pinOf(again)), 'sms_pin', role)
    }
    // A Member's leftover PIN is never asked for, and a Team Admin's role is not an Owner-only one.
    for (const codeOnly of [await s.person({ pin: s.newPin() }), await s.person({ roles: ['team_admin'] })]) {
      const { client, reply } = await atStepUp(codeOnly)
      const { id: sessionId, deviceId } = await s.sessionOf(client)
      expect(reply.body).toEqual({ status: 'signed_in', device: { id: deviceId, label: 'iPhone · Safari' } })
      const [term] = await s.query<{ full_term: boolean }>(
        "select expires_at - created_at = interval '2160 hours' as full_term from sessions where id = $1",
        [sessionId],
      )
      expect(term?.full_term).toBe(true)
      expect(await eventsOf(codeOnly)).toEqual([
        about(codeOnly, 'signin.started', codeOnly, {
          device: deviceId,
          session: sessionId,
          method: 'sms',
          pin_rule: false,
        }),
      ])
    }
  })

  it("D46 AQ-05/06: a PIN-rule session ends after 168 hours, while a Member's of the same age carries on", async () => {
    // Budgets: P 1 code request, M 1.
    const p = await s.person({ roles: ['admin'] })
    const m = await s.person()
    const pc = await s.signIn(p)
    const mc = await s.signIn(m)
    const [pTerm] = await s.query<{ pin_rule: boolean }>(
      "select expires_at - created_at = interval '168 hours' as pin_rule from sessions where id = $1",
      [(await s.sessionOf(pc)).id],
    )
    expect(pTerm?.pin_rule).toBe(true)
    expect((await eventsOf(p)).find(event => event.type === 'signin.started')?.ids).toMatchObject({
      method: 'sms_new_pin',
      pin_rule: true,
    })
    await s.age((await s.sessionOf(pc)).id, '168 hours 1 minute')
    await s.age((await s.sessionOf(mc)).id, '168 hours 1 minute')
    const ended = await pc.get('/api/devices')
    expect([ended.status, ended.error]).toEqual([401, 'signed_out'])
    expect((await mc.get('/api/devices')).status).toBe(200)
  })

  it('T20 R1: a finish that waits past its lock timeout answers 409 try_again, and a retry with any 6 digits signs in with no second check', async () => {
    // Budgets: V 1 code request.
    const v = await s.person()
    const browser = s.client()
    expect((await requestCode(browser, v.e164)).status).toBe(200)
    const code = await s.sms.nextCode(v.e164)
    const checksBefore = s.sms.checks.length
    await s.query('begin')
    let blocked: Awaited<ReturnType<typeof verifyCode>>
    try {
      // The superuser holds the person's row, so the finish's FOR SHARE read waits out its 2 s.
      await s.query('select id from people where id = $1 for no key update', [v.id])
      blocked = await verifyCode(browser, code)
    } finally {
      await s.query('commit')
    }
    expect([blocked.status, blocked.error]).toEqual([409, 'try_again'])
    expect(s.sms.checks.length).toBe(checksBefore + 1)
    expect(await s.query('select 1 from sessions where user_id = $1', [v.id])).toEqual([])
    const retried = await verifyCode(browser, '000000')
    expect(retried.status).toBe(200)
    expect(retried.body).toMatchObject({ status: 'signed_in' })
    expect(s.sms.checks.length).toBe(checksBefore + 1)
    expect(await s.query('select 1 from sessions where user_id = $1', [v.id])).toHaveLength(1)
  })

  it('T14 item 3 T20 AQ-04: on the real floor, refused checks for a roster number and one off it both take at least 2 s, and a slow cancel runs after the reply', async () => {
    // Budgets: R 1 code request, N (not on the roster) 1.
    const app = await s.startApi({ realTiming: true })
    const r = await s.person()
    const n = s.number()
    const rc = s.client({ app })
    const nc = s.client({ app })
    expect((await requestCode(rc, r.e164)).status).toBe(200)
    expect((await requestCode(nc, n)).status).toBe(200)
    const wrong = another(await s.sms.nextCode(r.e164))
    const timed = async (client: Client) => {
      const started = Date.now()
      const reply = await verifyCode(client, wrong)
      return { reply, ms: Date.now() - started }
    }
    const first = [await timed(rc), await timed(nc)]
    for (const { reply, ms } of first) {
      expect(reply.body).toMatchObject({ error: 'code_wrong', triesLeft: 4 })
      expect(ms).toBeGreaterThanOrEqual(2_000)
    }
    // Tries 2 to 4, then the 5th with a cancel that takes 6 s, longer than the bound on the reply:
    // the reply doesn't wait for it, so a roster number's dead reply costs one provider round trip
    // (the check), never two, and lands with one off the roster's, just after the floor. A cancel
    // run before the reply would take it past 6 s and finish before it.
    for (let tries = 2; tries <= 4; tries++) await Promise.all([verifyCode(rc, wrong), verifyCode(nc, wrong)])
    const cancel = s.sms.cancel.bind(s.sms)
    let cancelled = false
    const slow = vi.spyOn(s.sms, 'cancel').mockImplementation(async ref => {
      await new Promise(resolve => setTimeout(resolve, 6_000))
      cancelled = true
      return cancel(ref)
    })
    try {
      // Straight through the app, so the time is the reply's alone (the harness's client also waits
      // for the work after the reply).
      for (const client of [rc, nc]) {
        const started = Date.now()
        const reply = await app.inject({
          method: 'POST',
          url: '/api/auth/otp/verify',
          headers: { origin: APP_ORIGIN, cookie: client.cookieHeader(), 'content-type': 'application/json' },
          payload: { code: wrong },
        })
        const ms = Date.now() - started
        expect(reply.json()).toMatchObject({ error: 'code_dead' })
        expect(ms).toBeGreaterThanOrEqual(2_000)
        expect(ms).toBeLessThan(4_500)
        expect(cancelled).toBe(false)
      }
      await s.settled()
      expect(slow).toHaveBeenCalledTimes(1)
      expect(cancelled).toBe(true)
    } finally {
      slow.mockRestore()
    }
  }, 60_000)

  it('T20 AQ-20: three provider failures open the breaker, which refuses every check on that api without asking the provider', async () => {
    // Budgets: B 1 code request, N (not on the roster) 1.
    const app = await s.startApi({})
    const b = await s.person()
    const bc = s.client({ app })
    const nc = s.client({ app })
    expect((await requestCode(bc, b.e164)).status).toBe(200)
    expect((await requestCode(nc, s.number())).status).toBe(200)
    const code = await s.sms.nextCode(b.e164)
    const down = vi.spyOn(s.sms, 'check').mockRejectedValue(new Error('the provider is down'))
    try {
      for (let failures = 1; failures <= 3; failures++) {
        expect((await verifyCode(bc, code)).error).toBe('unavailable')
      }
      expect(down).toHaveBeenCalledTimes(3)
      for (const client of [bc, nc]) {
        const refused = await verifyCode(client, code)
        expect([refused.status, refused.error]).toEqual([503, 'unavailable'])
      }
      expect(down).toHaveBeenCalledTimes(3)
    } finally {
      down.mockRestore()
    }
    // The suite's own api has a breaker of its own, still closed.
    const other = await s.person()
    expect((await s.signIn(other)).cookie(SESSION_COOKIE)).toBeDefined()
  })

  it('T14 item 5 T20 item 3: a check the provider never answered, failing or refused by the open breaker, spends none of the day’s checks', async () => {
    // Budgets: P 1 code request, M 1 (re-authentication codes count against their own windows).
    // Each on an api of its own, whose breaker the test opens; the suite's own api, its breaker
    // closed, then takes the same cookies.
    const p = await s.person()
    const app = await s.startApi({})
    const pc = s.client({ app })
    expect((await requestCode(pc, p.e164)).status).toBe(200)
    const code = await s.sms.nextCode(p.e164)
    // 9 of the number's 10 checks today already spent.
    const day = s.names.limit('otp-v24h', tag(s.keys, p.e164))
    await seedWindow(day, 9, await valkeyNow())
    const down = vi.spyOn(s.sms, 'check').mockRejectedValue(new Error('the provider is down'))
    try {
      // Three failures open the breaker, and seven more presses meet it: each a 503 the person may
      // press again, and none spends the day's 10th check.
      for (let press = 1; press <= 10; press++) {
        const reply = await verifyCode(pc, code)
        expect([press, reply.status, reply.error]).toEqual([press, 503, 'unavailable'])
      }
      expect(down).toHaveBeenCalledTimes(3)
    } finally {
      down.mockRestore()
    }
    expect(await s.valkey.zcard(day)).toBe(9)
    // Once the provider answers, the same code signs in: the day's 10th check.
    const back = s.client()
    back.setCookie(ATTEMPT_COOKIE, pc.cookie(ATTEMPT_COOKIE) ?? '')
    const signedIn = await verifyCode(back, code)
    expect([signedIn.status, signedIn.body]).toMatchObject([200, { status: 'signed_in' }])
    expect(await s.valkey.zcard(day)).toBe(10)

    // Re-authentication by SMS gives the person's day of checks back the same way.
    const m = await s.person()
    const mc = await s.signIn(m)
    const reauthApp = await s.startApi({})
    const rc = s.client({ app: reauthApp })
    rc.setCookie(SESSION_COOKIE, mc.cookie(SESSION_COOKIE) ?? '')
    expect((await rc.post('/api/auth/reauth/code/request', {})).status).toBe(200)
    const reauthCode = await s.sms.nextCode(m.e164)
    const checks = s.names.limit('reauth-check-p24h', m.id)
    await seedWindow(checks, 19, await valkeyNow())
    const failing = vi.spyOn(s.sms, 'check').mockRejectedValue(new Error('the provider is down'))
    try {
      for (let press = 1; press <= 5; press++) {
        const reply = await rc.post('/api/auth/reauth/code/verify', { code: reauthCode })
        expect([press, reply.status, reply.error]).toEqual([press, 503, 'unavailable'])
      }
      expect(failing).toHaveBeenCalledTimes(3)
    } finally {
      failing.mockRestore()
    }
    expect(await s.valkey.zcard(checks)).toBe(19)
    const stamped = await mc.post('/api/auth/reauth/code/verify', { code: reauthCode })
    expect([stamped.status, stamped.body]).toEqual([200, { status: 'reauthenticated', validForSeconds: 300 }])
  })

  it('C0.5 Done: a number not on the roster gets the identical reply and no SMS (ACC-03, PRD-53)', async () => {
    // Budgets: R 3 code requests, N (not on the roster) 3; a refused request doesn't count.
    const r = await s.person()
    const n = s.number()
    const rc = s.client()
    const nc = s.client()
    const sentBefore = s.sms.sent.length

    const forR = await requestCode(rc, r.e164)
    const forN = await requestCode(nc, n)
    expect(forN.status).toBe(forR.status)
    expect(forN.text).toBe(forR.text)
    const shape = (cookies: string[]) => cookies.map(cookie => cookie.replace(/=[^;]*/, '=<value>'))
    expect(shape(forN.setCookies)).toEqual(shape(forR.setCookies))
    expect(forN.setCookies).not.toEqual(forR.setCookies)
    await s.settled()
    expect(s.sms.sent.slice(sentBefore).map(sent => sent.to)).toEqual([r.e164])

    // Five wrong codes each: the same bytes at every step.
    const wrong = another(await s.sms.nextCode(r.e164))
    for (let tries = 1; tries <= 5; tries++) {
      const replyR = await verifyCode(rc, wrong)
      const replyN = await verifyCode(nc, wrong)
      expect(replyR.status).toBe(401)
      expect(replyN.status).toBe(replyR.status)
      expect(replyN.text).toBe(replyR.text)
      if (tries < 5) expect(replyR.body).toMatchObject({ error: 'code_wrong', triesLeft: 5 - tries })
      else expect(replyR.error).toBe('code_dead')
    }
    const rows = await auditOf(r)
    expect(rows.filter(row => row.action === 'auth.code_failed').map(row => row.details.result)).toEqual([
      'wrong',
      'wrong',
      'wrong',
      'wrong',
      'dead',
    ])
    const mentionsN = await s.query<{ n: string }>(
      "select count(*)::text as n from audit_events a where to_jsonb(a)::text like '%' || $1 || '%'",
      [n.slice(3)],
    )
    expect(mentionsN[0]?.n).toBe('0')

    // Valkey's key names hold keyed hashes, never a number.
    const keys: string[] = []
    let cursor = '0'
    do {
      const [next, found] = await s.valkey.scan(cursor, 'MATCH', `${s.prefix}*`, 'COUNT', 1000)
      cursor = next
      keys.push(...found)
    } while (cursor !== '0')
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.filter(key => key.includes(r.local) || key.includes(n.slice(3)))).toEqual([])

    // PRD-53: 3 requests per number per 10 minutes, then the same 429 for both.
    for (let i = 0; i < 2; i++) {
      expect((await requestCode(rc, r.e164)).status).toBe(200)
      expect((await requestCode(nc, n)).status).toBe(200)
    }
    const fourthR = await requestCode(rc, r.e164)
    const fourthN = await requestCode(nc, n)
    expect(fourthR.status).toBe(429)
    expect(fourthR.body).toMatchObject({ error: 'too_many_requests', retryAfterSeconds: 600 })
    expect(fourthR.headers['retry-after']).toBe('600')
    expect(fourthN.status).toBe(429)
    expect(fourthN.text).toBe(fourthR.text)
    expect(fourthN.headers['retry-after']).toBe('600')

    // A refused request costs nothing (limiter.ts): another is still refused, and R's windows and
    // those of R's browser's address hold only what was allowed: 3 code requests, and 5 code
    // checks besides in the address's window for every sign-in request.
    expect((await requestCode(rc, r.e164)).status).toBe(429)
    const rcAddress = tag(s.keys, `ip:${limitSubject(rc.ip)}`)
    const held = (name: string, subject: string) => s.valkey.zcard(s.names.limit(name, subject))
    expect({
      'otp-n10m': await held('otp-n10m', tag(s.keys, r.e164)),
      'otp-n24h': await held('otp-n24h', tag(s.keys, r.e164)),
      'otp-ip': await held('otp-ip', rcAddress),
      'auth-ip': await held('auth-ip', rcAddress),
    }).toEqual({ 'otp-n10m': 3, 'otp-n24h': 3, 'otp-ip': 3, 'auth-ip': 8 })

    const nonRoster = s.logs.filter(line => line.event === 'otp_non_roster')
    expect(nonRoster.length).toBeGreaterThan(0)
    for (const line of nonRoster) expect(JSON.stringify(line)).not.toContain(n.slice(3))
  })

  it('PRD-53: codes expire, die after 5 tries, and are replaced', async () => {
    // Budgets: A 2 code requests, B 2, C 1, D 2. A holds a PIN role, for the step-up's body (D46).
    const a = await s.person({ roles: ['ai_admin'], pin: s.newPin() })
    const b = await s.person({ pin: s.newPin() })
    const c = await s.person({ pin: s.newPin() })

    const ac = s.client()
    expect((await requestCode(ac, a.e164)).status).toBe(200)
    const code = await s.sms.nextCode(a.e164)
    for (let tries = 1; tries <= 5; tries++) {
      const reply = await verifyCode(ac, another(code))
      expect(reply.status).toBe(401)
      expect(reply.error).toBe(tries < 5 ? 'code_wrong' : 'code_dead')
    }
    const dead = await verifyCode(ac, code)
    expect([dead.status, dead.error]).toEqual([401, 'code_expired'])
    // T20: the 5th wrong try's dead code is cancelled at the provider, after the reply.
    await s.settled()
    const aRef = s.sms.sent.filter(sent => sent.to === a.e164).at(-1)?.ref
    expect(s.sms.cancels.map(entry => entry.ref)).toContain(aRef)
    expect((await requestCode(ac, a.e164)).status).toBe(200)
    const fresh = await verifyCode(ac, await s.sms.nextCode(a.e164))
    expect(fresh.status).toBe(200)
    expect(fresh.body).toEqual({
      status: 'code_verified',
      next: 'step_up',
      pin: { state: 'ok', triesBeforeLock: 5, triesBeforeAdminLock: 10 },
    })

    // A second request replaces the first code.
    const bc = s.client()
    expect((await requestCode(bc, b.e164)).status).toBe(200)
    const first = await s.sms.nextCode(b.e164)
    expect((await requestCode(bc, b.e164)).status).toBe(200)
    const second = await s.sms.nextCode(b.e164)
    const replaced = await verifyCode(bc, first)
    expect([replaced.status, replaced.error]).toEqual([401, 'code_wrong'])
    expect((await verifyCode(bc, second)).status).toBe(200)

    // T14: the code is bound to the browser that asked for it. A newer request from another
    // browser replaces it, and the older browser's tries neither count against the new code nor
    // kill it.
    const d = await s.person({ pin: s.newPin() })
    const older = s.client()
    const newer = s.client()
    expect((await requestCode(older, d.e164)).status).toBe(200)
    await s.sms.nextCode(d.e164)
    expect((await requestCode(newer, d.e164)).status).toBe(200)
    const newest = await s.sms.nextCode(d.e164)
    // T20: the newer request cancelled the older code first, so the provider made a new one.
    const [olderText, newerText] = s.sms.sent.filter(sent => sent.to === d.e164).slice(-2)
    expect(newerText?.ref).not.toBe(olderText?.ref)
    expect(s.sms.cancels.map(entry => entry.ref)).toContain(olderText?.ref)
    const checksBefore = s.sms.checks.length
    for (let tries = 1; tries <= 5; tries++) {
      const reply = await verifyCode(older, tries < 5 ? another(newest) : newest)
      expect([reply.status, reply.error]).toEqual([401, 'code_expired'])
    }
    await s.settled()
    // The stale attempt asked the provider nothing and cancelled nothing of the newest code.
    expect(s.sms.checks.length).toBe(checksBefore)
    expect(s.sms.cancels.map(entry => entry.ref)).not.toContain(newerText?.ref)
    expect((await verifyCode(newer, newest)).status).toBe(200)

    // T20 PRD-53: a code past its 5 minutes, on Valkey's clock from the request, is refused, and
    // its provider code is cancelled after the reply; the record goes, as its 10-minute expiry
    // would leave it, and the next check finds nothing.
    const cc = s.client()
    expect((await requestCode(cc, c.e164)).status).toBe(200)
    const late = await s.sms.nextCode(c.e164)
    const cKey = s.names.otp(tag(s.keys, c.e164))
    const [seconds] = await s.valkey.time()
    await s.valkey.hset(cKey, 'born', Number(seconds) * 1000 - OTP.ttlMs - 1)
    const expired = await verifyCode(cc, late)
    expect([expired.status, expired.error]).toEqual([401, 'code_expired'])
    await s.settled()
    const cRef = s.sms.sent.filter(sent => sent.to === c.e164).at(-1)?.ref
    expect(s.sms.cancels.map(entry => entry.ref)).toContain(cRef)
    expect(await s.valkey.exists(cKey)).toBe(0)
    const gone = await verifyCode(cc, late)
    expect([gone.status, gone.error]).toEqual([401, 'code_expired'])
  })

  it('T14 item 3 T20: a code request that lands during a check answers a roster number exactly as one off the roster', async () => {
    // Budgets: R 2 code requests, N (not on the roster) 2.
    const r = await s.person({ pin: s.newPin() })
    const n = s.number()
    const [rOlder, rNewer, nOlder, nNewer] = [s.client(), s.client(), s.client(), s.client()]
    expect((await requestCode(rOlder, r.e164)).status).toBe(200)
    expect((await requestCode(nOlder, n)).status).toBe(200)
    const wrong = another(await s.sms.nextCode(r.e164))

    // R's check waits on the provider: a newer request for R's number lands during that round
    // trip, before the check settles.
    const check = s.sms.check.bind(s.sms)
    let landed = false
    const during = vi.spyOn(s.sms, 'check').mockImplementationOnce(async (ref, code) => {
      landed = (await requestCode(rNewer, r.e164)).status === 200
      return check(ref, code)
    })
    let replyR: Awaited<ReturnType<typeof verifyCode>>
    try {
      replyR = await verifyCode(rOlder, wrong)
    } finally {
      during.mockRestore()
    }
    expect(landed).toBe(true)
    // N's check asks no provider, so its reply is fixed before anything can land; its newer request
    // comes straight after.
    const replyN = await verifyCode(nOlder, wrong)
    expect((await requestCode(nNewer, n)).status).toBe(200)
    expect(replyR.status).toBe(401)
    expect(replyR.body).toMatchObject({ error: 'code_wrong', triesLeft: 4 })
    expect(replyN.status).toBe(replyR.status)
    expect(replyN.text).toBe(replyR.text)
    await s.settled()

    // Each older browser's next check finds another owner's record: code_expired for both.
    const againR = await verifyCode(rOlder, wrong)
    const againN = await verifyCode(nOlder, wrong)
    expect([againR.status, againR.error]).toEqual([401, 'code_expired'])
    expect(againN.status).toBe(againR.status)
    expect(againN.text).toBe(againR.text)
    await s.settled()

    // The newest request still wins: the overtaken check touched nothing of the newer code, which
    // signs R in from the newer browser (R is a Member: the code alone, D46).
    const newest = await s.sms.nextCode(r.e164)
    const ahead = await verifyCode(rNewer, newest)
    expect(ahead.status).toBe(200)
    expect(ahead.body).toMatchObject({ status: 'signed_in' })
    const newerRef = s.sms.sent.filter(sent => sent.to === r.e164).at(-1)?.ref
    expect(s.sms.cancels.map(entry => entry.ref)).not.toContain(newerRef)
    // Audited as the replies went.
    const failed = (await auditOf(r)).filter(row => row.action === 'auth.code_failed').map(row => row.details)
    expect(failed).toEqual([{ result: 'wrong' }, { result: 'expired' }])
  })

  it('BUILD-PLAN C0.5 ADM-06: a wrong code whose sender hangs up before the reply is counted once and still audited', async () => {
    // Budgets: G 1 code request.
    const g = await s.person({ pin: s.newPin() })
    const gc = s.client()
    expect((await requestCode(gc, g.e164)).status).toBe(200)
    const code = await s.sms.nextCode(g.e164)
    await hangUp(gc, '/api/auth/otp/verify', { code: another(code) })
    const failed = await eventually(
      async () => (await auditOf(g)).filter(row => row.action === 'auth.code_failed'),
      rows => rows.length > 0,
    )
    await s.settled()
    expect(failed.map(row => row.details)).toEqual([{ result: 'wrong' }])
    expect(failed[0]).toMatchObject({ actor_id: null, ip: gc.ip })
    expect(await s.valkey.hget(s.names.otp(tag(s.keys, g.e164)), 'tries')).toBe('1')
  })

  it('BUILD-PLAN C0.5 ADM-06: a code request whose sender hangs up before the reply still sends the code and writes its audit row', async () => {
    // Budgets: H 1 code request (hung up).
    const h = await s.person()
    await hangUp(s.client(), '/api/auth/otp/request', { phone: h.e164 })
    await s.sms.nextCode(h.e164)
    const rows = await eventually(
      () => auditOf(h),
      found => found.length > 0,
    )
    await s.settled()
    expect(rows.map(row => [row.action, row.details])).toEqual([['auth.code_requested', { send: 'attempted' }]])
  })

  it('PDPA-10 T20: a provider not cleared in the transfer register is sent nothing, audited skipped_not_cleared, and answers as any request', async () => {
    // Budgets: N 1 code request, on its own api; an off-roster number 1, for the reply to compare.
    const n = await s.person()
    const twilioLike = new FakeVerify({ transfer: 'twilio' })
    const app = await s.startApi({ sms: twilioLike })
    const reply = await requestCode(s.client({ app }), n.e164)
    const offRoster = await requestCode(s.client({ app }), '+6580009999')
    const rows = await eventually(
      () => auditOf(n),
      found => found.length > 0,
    )
    await s.settled()
    expect(reply.status).toBe(200)
    expect([reply.status, reply.body]).toEqual([offRoster.status, offRoster.body])
    expect(rows.map(row => [row.action, row.details])).toEqual([
      ['auth.code_requested', { send: 'skipped_not_cleared' }],
    ])
    expect(twilioLike.sent).toEqual([])
    expect(s.logs.some(line => line.event === 'sms_provider_not_cleared' && line.personId === n.id)).toBe(true)
  })

  it('C0.5 Done: the PIN locks after 5 wrong tries for 15 minutes and after 10 until an admin resets it (PRD-53, ACC-02, ACC-06)', async () => {
    // Budgets: M 3 code requests, E 1, K 1, U 0, C 1, the Owner 1. M, E and K hold PIN roles, so
    // they have PINs (D46), and only an Owner resets a PIN-role holder's PIN.
    const m = await s.person({ roles: ['leadership'], pin: s.newPin() })
    const e = await s.person({ roles: ['compliance_officer'], pin: s.newPin() })
    const k = await s.person({ roles: ['ai_admin'], pin: s.newPin() })
    const u = await s.person()
    const c = await s.person()
    const admin = await s.person({ roles: ['owner'], pin: s.newPin() })

    const mFirst = await s.signIn(m)
    const { client: mc, reply: stepUp } = await atStepUp(m)
    expect(stepUp.body).toMatchObject({ next: 'step_up', pin: { state: 'ok' } })
    const wrongPin = another(pinOf(m))
    for (let failures = 1; failures <= 4; failures++) {
      const reply = await verifyPin(mc, wrongPin)
      expect(reply.status).toBe(401)
      expect(reply.body).toMatchObject({
        error: 'pin_wrong',
        pin: { state: 'ok', triesBeforeLock: 5 - failures, triesBeforeAdminLock: 10 - failures },
      })
    }
    const fifth = await verifyPin(mc, wrongPin)
    expect([fifth.status, fifth.error]).toEqual([423, 'pin_locked'])
    const locked = fifth.json<{ pin: { state: string; until: string } }>().pin
    expect(locked.state).toBe('locked')
    expect(Math.abs(Date.parse(locked.until) - (Date.now() + 15 * 60_000))).toBeLessThan(60_000)
    // While locked, even the right PIN isn't checked.
    const right = await verifyPin(mc, pinOf(m))
    expect(right.status).toBe(423)
    expect((await userOf(m))?.pin_failures).toBe(5)

    // Each failure after the lock passes starts a new one; the 10th needs an admin.
    for (let failures = 6; failures <= 10; failures++) {
      await lockPassed(m)
      const reply = await verifyPin(mc, wrongPin)
      expect(reply.status).toBe(423)
      expect(reply.body).toMatchObject({
        error: 'pin_locked',
        pin: { state: failures < 10 ? 'locked' : 'admin_locked' },
      })
    }
    await lockPassed(m)
    const stillLocked = await verifyPin(mc, pinOf(m))
    expect(stillLocked.status).toBe(423)
    expect(stillLocked.body).toMatchObject({ error: 'pin_locked', pin: { state: 'admin_locked' } })
    // The counts and their audit rows committed, though each request answered with an error.
    const rows = await auditOf(m)
    const failed = rows.filter(row => row.action === 'auth.pin_failed')
    expect(failed).toHaveLength(10)
    for (const row of failed) expect(row).toMatchObject({ actor_id: null, details: { during: 'sign_in' } })
    const locks = rows.filter(row => row.action === 'auth.pin_locked')
    expect(locks.map(row => row.details.failures)).toEqual([5, 6, 7, 8, 9, 10])
    expect(locks.at(-1)?.details.until).toBe('admin_reset')

    // The lock ends: after 15 minutes the right PIN signs in and clears the count.
    const { client: ec } = await atStepUp(e)
    const wrongE = another(pinOf(e))
    for (let failures = 1; failures <= 5; failures++) await verifyPin(ec, wrongE)
    expect((await userOf(e))?.pin_failures).toBe(5)
    await lockPassed(e)
    expect((await verifyPin(ec, pinOf(e))).status).toBe(200)
    expect(await userOf(e)).toMatchObject({ pin_failures: 0, pin_last_failed_at: null })

    // A PIN hashed under another pepper needs an admin reset, and checking it counts nothing.
    await s.query("update users set pin_key_id = 'ffffffffffffffff' where id = $1", [k.id])
    const { client: kc } = await atStepUp(k)
    const otherKey = await verifyPin(kc, pinOf(k))
    expect([otherKey.status, otherKey.error]).toEqual([409, 'pin_reset_needed'])
    expect((await userOf(k))?.pin_failures).toBe(0)

    // ACC-06: an admin resets the PIN after checking who it is.
    const adminC = await s.signIn(admin)
    const noPin = await adminC.post('/api/admin/people/reset-pin', { person: u.id, identityCheck: 'in_person' })
    expect([noPin.status, noPin.error]).toEqual([409, 'no_pin'])
    // D46 AQ-02: C, a Member, signs in on the code alone, so has an account but no PIN: there's
    // nothing to reset either, and the refused reset ends none of C's sessions and writes nothing.
    const cc = await s.signIn(c)
    expect(await userOf(c)).toMatchObject({ pin_hash: null, pin_reset_at: null })
    const codeOnly = await adminC.post('/api/admin/people/reset-pin', { person: c.id, identityCheck: 'in_person' })
    expect([codeOnly.status, codeOnly.error]).toEqual([409, 'no_pin'])
    expect((await cc.get('/api/devices')).status).toBe(200)
    expect(await userOf(c)).toMatchObject({ pin_hash: null, pin_reset_at: null, pin_reset_by: null })
    expect((await auditOf(c)).filter(row => row.actor_id === admin.id)).toEqual([])
    expect((await eventsOf(c)).filter(event => event.actor_id === admin.id)).toEqual([])
    const note = 'Checked against the roster at the front desk'
    const reset = await adminC.post('/api/admin/people/reset-pin', {
      person: m.id,
      identityCheck: 'in_person',
      note,
    })
    expect(reset.status).toBe(200)
    expect(reset.body).toEqual({ status: 'pin_reset', sessionsEnded: 1 })
    // C0.6 T16: the reset and the session it ended, the admin acting.
    const [mFirstSession] = await s.query<{ id: string }>(
      "select id from sessions where user_id = $1 and revoke_reason = 'pin_reset'",
      [m.id],
    )
    expect((await eventsOf(m)).filter(event => event.actor_id === admin.id)).toEqual([
      about(m, 'account.pin_reset', admin),
      about(m, 'signin.ended', admin, { sessions: [mFirstSession?.id], devices: [], reason: 'pin_reset' }),
    ])
    const signedOut = await mFirst.get('/api/devices')
    expect([signedOut.status, signedOut.error]).toEqual([401, 'signed_out'])
    expect(signedOut.setCookies).toEqual([`${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`])

    // M signs in again with the SMS code and sets a new PIN.
    const { client: again, reply: newPin } = await atStepUp(m)
    expect(newPin.body).toEqual({ status: 'code_verified', next: 'set_pin' })
    expect((await again.post('/api/auth/pin/set', { pin: s.newPin() })).status).toBe(200)

    // ACC-04 T14: the reset ended the first device's session but didn't sign the device out, and
    // a device lists only while it holds a live session: M and the admin each see the new one.
    const newDevice = (await s.sessionOf(again)).deviceId
    const listedIds = (reply: Awaited<ReturnType<Client['get']>>) =>
      reply.json<{ devices: { id: string }[] }>().devices.map(device => device.id)
    expect(listedIds(await again.get('/api/devices'))).toEqual([newDevice])
    expect(listedIds(await adminC.get(`/api/admin/people/${m.id}/devices`))).toEqual([newDevice])

    const resetRow = (await auditOf(m)).find(row => row.action === 'person.reset_pin')
    expect(resetRow).toMatchObject({
      actor_id: admin.id,
      target_id: m.id,
      reason: note,
      details: { identityCheck: 'in_person', sessionsEnded: 1 },
    })
    const user = await userOf(m)
    expect(user?.pin_reset_at).toBeInstanceOf(Date)
    expect(user?.pin_reset_by).toBe(admin.id)
    expect(user?.pin_failures).toBe(0)
  })

  it('PRD-53 ACC-02: parallel PIN guesses and parallel finishes stay correct', async () => {
    // Budgets: G 2 code requests. G holds a PIN role, so steps up with the PIN (D46).
    const g = await s.person({ roles: ['dpo'], pin: s.newPin() })
    const { client: gc } = await atStepUp(g)
    const wrongPin = another(pinOf(g))
    const guesses = await Promise.all(Array.from({ length: 8 }, () => verifyPin(gc, wrongPin)))
    for (const reply of guesses) {
      expect([reply.status, reply.error]).toSatisfy(
        ([status, error]: [number, string]) =>
          (status === 401 && error === 'pin_wrong') ||
          (status === 423 && error === 'pin_locked') ||
          (status === 409 && error === 'try_again'),
      )
    }
    const failures = (await userOf(g))?.pin_failures ?? -1
    const failedRows = (await auditOf(g)).filter(row => row.action === 'auth.pin_failed')
    expect(failures).toBe(failedRows.length)
    expect(failures).toBeGreaterThan(0)
    expect(failures).toBeLessThanOrEqual(5)

    // The count reset by hand; then two right PINs at once make exactly one session.
    await s.query('update users set pin_failures = 0 where id = $1', [g.id])
    const { client: gc2 } = await atStepUp(g)
    const sessions = async () =>
      Number(
        (await s.query<{ n: string }>('select count(*)::text as n from sessions where user_id = $1', [g.id]))[0]?.n,
      )
    const before = await sessions()
    const finishes = await Promise.all([verifyPin(gc2, pinOf(g)), verifyPin(gc2, pinOf(g))])
    const statuses = finishes.map(reply => `${reply.status} ${reply.error ?? ''}`.trim()).sort()
    expect(statuses[0]).toBe('200')
    expect(['401 attempt_expired', '409 try_again']).toContain(statuses[1])
    expect(await sessions()).toBe(before + 1)
  })

  it('D46: passkeys are switched off: every passkey route answers 404 no-store, and no reply names passkeys', async () => {
    // Budgets: P 1 code request (a sign-in), Q 1.
    const p = await s.person({ roles: ['leadership'], pin: s.newPin() })
    const signedIn = await s.signIn(p)
    const q = await s.person({ roles: ['leadership'], pin: s.newPin() })
    const { client: atPin, reply: stepUp } = await atStepUp(q)
    expect(stepUp.body).not.toHaveProperty('passkey')
    for (const client of [signedIn, atPin, s.client()]) {
      for (const path of PASSKEY_ROUTES) {
        // The afterAll sweep checks each reply was no-store (the /api scope's own 404).
        const reply = await client.post(path, {})
        expect([reply.status, reply.body], path).toEqual([404, { error: 'Not Found' }])
      }
    }
    const devices = await signedIn.get('/api/devices')
    expect(devices.status).toBe(200)
    expect(devices.body).not.toHaveProperty('passkeys')
    // Nothing was written for any of them.
    expect((await auditOf(p)).map(row => row.action)).toEqual(['auth.code_requested', 'auth.sign_in'])
  })

  it('D46 AQ-01: a Member re-authenticates with an SMS code to their own number, never the PIN', async () => {
    // Budgets: M 2 code requests (a sign-in, then one the re-authentication code replaces), N 1.
    // Re-authentication codes count against their own windows, not the number's sign-in ones.
    const m = await s.person()
    const mc = await s.signIn(m)
    const { id: sessionId } = await s.sessionOf(mc)
    await s.age(sessionId, '6 minutes')
    const signOutMine = () => mc.post('/api/admin/people/sign-out-devices', { person: m.id })

    // A stale session's refusal names its method: a code we text them.
    const stale = await signOutMine()
    expect([stale.status, stale.body]).toEqual([
      403,
      { error: 'reauth_required', message: "Confirm it's you with a code we text you first.", method: 'code' },
    ])

    // The PIN route is refused before any PIN is checked or counted.
    const byPin = await mc.post('/api/auth/reauth/pin', { pin: s.newPin() })
    expect([byPin.status, byPin.body]).toEqual([
      409,
      { error: 'reauth_method', message: "Confirm it's you with a code we text you.", method: 'code' },
    ])
    expect((await userOf(m))?.pin_failures).toBe(0)
    // Logged at warn with the person and the route, and written to no audit row (Q5).
    expect(wrongMethodLines(m.id)).toEqual([[40, '/api/auth/reauth/pin']])

    const sentBefore = s.sms.sent.length
    const asked = await mc.post('/api/auth/reauth/code/request', {})
    expect([asked.status, asked.body]).toEqual([200, { status: 'code_sent', expiresInSeconds: 300, codeLength: 6 }])
    expect(s.sms.sent.length).toBe(sentBefore + 1)
    const code = await s.sms.nextCode(m.e164)
    const wrong = await mc.post('/api/auth/reauth/code/verify', { code: another(code) })
    expect([wrong.status, wrong.body]).toMatchObject([401, { error: 'code_wrong', triesLeft: 4 }])
    const right = await mc.post('/api/auth/reauth/code/verify', { code })
    expect([right.status, right.body]).toEqual([200, { status: 'reauthenticated', validForSeconds: 300 }])
    const [stamp] = await s.query<{ fresh: boolean }>(
      "select reauthenticated_at > now() - interval '1 minute' as fresh from sessions where id = $1",
      [sessionId],
    )
    expect(stamp?.fresh).toBe(true)
    // The SMS stamp counts for an action that needs one.
    expect((await mc.get(`/api/admin/people/${m.id}/devices`)).status).toBe(200)
    // The code is used up.
    expect((await mc.post('/api/auth/reauth/code/verify', { code })).error).toBe('code_expired')
    const reauth = (await auditOf(m)).filter(row => row.details.during === 'reauth' || row.action === 'auth.reauth')
    expect(reauth.map(row => [row.action, row.actor_id, row.details])).toEqual([
      ['auth.code_requested', m.id, { during: 'reauth', send: 'attempted' }],
      ['auth.code_failed', m.id, { during: 'reauth', result: 'wrong' }],
      ['auth.reauth', m.id, { method: 'sms' }],
      ['auth.code_failed', m.id, { during: 'reauth', result: 'expired' }],
    ])

    // A re-authentication code replaces a pending sign-in code for the number, cancelling it. The
    // replaced sign-in attempt's check then asks the provider nothing and cancels nothing of the
    // session's code, which still works (T14 item 3, T20). The session's window (10
    // re-authentications per 10 minutes) starts afresh.
    await s.valkey.del(s.names.limit('reauth', sessionId))
    const latestRef = () => s.sms.sent.filter(sent => sent.to === m.e164).at(-1)?.ref
    const other = s.client()
    expect((await requestCode(other, m.e164)).status).toBe(200)
    const signInCode = await s.sms.nextCode(m.e164)
    const signInRef = latestRef()
    expect((await mc.post('/api/auth/reauth/code/request', {})).status).toBe(200)
    const replacing = await s.sms.nextCode(m.e164)
    const replacingRef = latestRef()
    expect(replacingRef).not.toBe(signInRef)
    expect(s.sms.cancels.map(entry => entry.ref)).toContain(signInRef)
    const checksBefore = s.sms.checks.length
    expect((await verifyCode(other, signInCode)).error).toBe('code_expired')
    await s.settled()
    expect(s.sms.checks.length).toBe(checksBefore)
    expect(s.sms.cancels.map(entry => entry.ref)).not.toContain(replacingRef)
    expect((await mc.post('/api/auth/reauth/code/verify', { code: replacing })).status).toBe(200)

    // A code dies at the 5th wrong try, and its provider code is cancelled after the reply.
    await s.valkey.del(s.names.limit('reauth', sessionId))
    expect((await mc.post('/api/auth/reauth/code/request', {})).status).toBe(200)
    const doomed = await s.sms.nextCode(m.e164)
    const doomedRef = latestRef()
    for (let i = 1; i <= 4; i++) {
      const guess = await mc.post('/api/auth/reauth/code/verify', { code: another(doomed) })
      expect(guess.body).toMatchObject({ error: 'code_wrong', triesLeft: 5 - i })
    }
    const fifth = await mc.post('/api/auth/reauth/code/verify', { code: another(doomed) })
    expect(fifth.error).toBe('code_dead')
    await s.settled()
    expect(s.sms.cancels.map(entry => entry.ref)).toContain(doomedRef)
    expect((await mc.post('/api/auth/reauth/code/verify', { code: doomed })).error).toBe('code_expired')

    // A fresh SMS stamp lets them sign out their own devices, this session included.
    await s.reauth(mc, m)
    expect((await signOutMine()).status).toBe(200)
    expect((await mc.get('/api/devices')).status).toBe(401)

    // AQ-23: no current number, no code.
    const n = await s.person()
    const nc = await s.signIn(n)
    await s.query('update phone_numbers set removed_at = now(), removed_by = $2 where id = $1', [
      n.phoneNumberId,
      s.org.system,
    ])
    const none = await nc.post('/api/auth/reauth/code/request', {})
    expect([none.status, none.error]).toEqual([409, 'no_number'])
    const noneCheck = await nc.post('/api/auth/reauth/code/verify', { code: '000000' })
    expect([noneCheck.status, noneCheck.error]).toEqual([409, 'no_number'])
  })

  it('D46 AQ-01: on the real floor, refused SMS re-authentication checks still answer at once (signed-in traffic, nothing to hide)', async () => {
    // Budgets: F 1 code request.
    const app = await s.startApi({ realTiming: true })
    const f = await s.person()
    const signedIn = await s.signIn(f)
    const fc = s.client({ app })
    fc.setCookie(SESSION_COOKIE, signedIn.cookie(SESSION_COOKIE) ?? '')
    expect((await fc.post('/api/auth/reauth/code/request', {})).status).toBe(200)
    const wrong = another(await s.sms.nextCode(f.e164))
    const replies: { error: string | undefined; ms: number }[] = []
    for (let tries = 1; tries <= 6; tries++) {
      const started = Date.now()
      const reply = await fc.post('/api/auth/reauth/code/verify', { code: wrong })
      replies.push({ error: reply.error, ms: Date.now() - started })
    }
    // Wrong four times, dead at the 5th, then expired: each well inside sign-in's 2 s floor.
    expect(replies.map(reply => reply.error)).toEqual([
      'code_wrong',
      'code_wrong',
      'code_wrong',
      'code_wrong',
      'code_dead',
      'code_expired',
    ])
    for (const { ms } of replies) expect(ms).toBeLessThan(1_500)
  })

  it('D46 AQ-02 I2: a session issued under the PIN rule never re-authenticates by SMS, even after its role is removed and given again', async () => {
    // Budgets: A 1 code request, T 0.
    const a = await s.person({ roles: ['admin'], pin: s.newPin() })
    const t = await s.person()
    const ac = await s.signIn(a)
    const { id: sessionId } = await s.sessionOf(ac)
    const signOutT = () => ac.post('/api/admin/people/sign-out-devices', { person: t.id })
    const sentBefore = s.sms.sent.length
    const bySms = await ac.post('/api/auth/reauth/code/request', {})
    expect([bySms.status, bySms.body]).toEqual([
      409,
      { error: 'reauth_method', message: "Confirm it's you with your PIN.", method: 'pin' },
    ])
    const bySmsCheck = await ac.post('/api/auth/reauth/code/verify', { code: '000000' })
    expect([bySmsCheck.status, bySmsCheck.error]).toEqual([409, 'reauth_method'])
    await s.age(sessionId, '6 minutes')
    const stale = await signOutT()
    expect([stale.status, stale.body]).toEqual([
      403,
      { error: 'reauth_required', message: "Confirm it's you with your PIN first.", method: 'pin' },
    ])

    // The role removed: the session still re-authenticates only with the PIN, keeping its 7 days.
    const former = await s.revokeRole(a, 'admin')
    expect(former.holdsPinRole).toBe(false)
    expect((await ac.post('/api/auth/reauth/code/request', {})).body).toMatchObject({ method: 'pin' })
    expect((await ac.post('/api/auth/reauth/pin', { pin: pinOf(a) })).status).toBe(200)
    const [term] = await s.query<{ pin_rule: boolean }>(
      "select expires_at - created_at = interval '168 hours' as pin_rule from sessions where id = $1",
      [sessionId],
    )
    expect(term?.pin_rule).toBe(true)
    // Given again: no SMS stamp ever landed on the session, and the PIN's stamp counts.
    await s.grantRole(former, 'admin')
    expect((await signOutT()).status).toBe(200)
    expect(s.sms.sent.length).toBe(sentBefore)
    expect((await auditOf(a)).filter(row => row.action === 'auth.reauth').map(row => row.details)).toEqual([
      { method: 'pin' },
    ])
    // Each 409 reauth_method left a warn line naming the person and the route, and nothing else of
    // theirs; none reached the audit log (AUTH-DESIGN §8.2, Q5).
    expect(wrongMethodLines(a.id)).toEqual([
      [40, '/api/auth/reauth/code/request'],
      [40, '/api/auth/reauth/code/verify'],
      [40, '/api/auth/reauth/code/request'],
    ])
    expect((await auditOf(a)).filter(row => row.details.during === 'reauth').map(row => row.action)).toEqual([])
  })

  it('D46 AQ-02: a role granted on a code-only session needs a new sign-in through the PIN step, even inside 5 minutes', async () => {
    // Budgets: M 2 code requests, T 0.
    const m = await s.person()
    const t = await s.person()
    const mc = await s.signIn(m)
    const admin = await s.grantRole(m, 'admin')
    const signOutT = (client: Client) => client.post('/api/admin/people/sign-out-devices', { person: t.id })
    const refused = await signOutT(mc)
    expect([refused.status, refused.body]).toEqual([
      403,
      {
        error: 'reauth_required',
        message: 'Your account has changed. Sign out and sign in again to carry on.',
        method: 'sign_in',
      },
    ])
    const mismatch = s.logs.filter(line => line.event === 'pin_rule_session_mismatch')
    expect(mismatch.some(line => line.personId === m.id)).toBe(true)
    for (const line of mismatch) expect(Object.keys(line)).not.toContain('method')
    for (const [path, body] of [
      ['/api/auth/reauth/pin', { pin: s.newPin() }],
      ['/api/auth/reauth/code/request', {}],
      ['/api/auth/reauth/code/verify', { code: '000000' }],
    ] as const) {
      const reply = await mc.post(path, body)
      expect([reply.status, reply.error, reply.body], path).toMatchObject([409, 'reauth_method', { method: 'sign_in' }])
    }
    // Each is a wrong-method refusal too, logged with its route.
    expect(wrongMethodLines(m.id)).toEqual([
      [40, '/api/auth/reauth/pin'],
      [40, '/api/auth/reauth/code/request'],
      [40, '/api/auth/reauth/code/verify'],
    ])
    // Healed by signing out and in again, through the PIN step, onto a 7-day session.
    expect((await mc.post('/api/auth/sign-out', {})).status).toBe(200)
    const again = await s.signIn(admin)
    expect(admin.pin).toBeDefined()
    expect((await signOutT(again)).status).toBe(200)
  })

  it("§9.4 T13: admin actions need a re-authentication within the last 5 minutes, and an Admin can't act on the Owner", async () => {
    // Budgets: Admin A 1 code request, Owner O 1, member X 1, target T 0.
    const a = await s.person({ roles: ['admin'], pin: s.newPin() })
    const o = await s.person({ roles: ['owner'], pin: s.newPin() })
    const x = await s.person({ pin: s.newPin() })
    const t = await s.person({ pin: s.newPin() })
    const signOutT = (client: Client) => client.post('/api/admin/people/sign-out-devices', { person: t.id })

    const ac = await s.signIn(a)
    const { id: sessionId } = await s.sessionOf(ac)
    await s.age(sessionId, '4 minutes')
    expect((await signOutT(ac)).status).toBe(200)
    await s.age(sessionId, '2 minutes')
    const stale = await signOutT(ac)
    expect([stale.status, stale.body]).toMatchObject([403, { error: 'reauth_required', method: 'pin' }])

    // A wrong PIN at re-authentication counts; the right one clears the count and stamps it.
    const wrong = await ac.post('/api/auth/reauth/pin', { pin: another(pinOf(a)) })
    expect([wrong.status, wrong.error]).toEqual([401, 'pin_wrong'])
    expect((await userOf(a))?.pin_failures).toBe(1)
    const right = await ac.post('/api/auth/reauth/pin', { pin: pinOf(a) })
    expect(right.status).toBe(200)
    expect((await auditOf(a)).filter(row => row.action === 'auth.reauth').map(row => row.details.method)).toEqual([
      'pin',
    ])
    expect((await userOf(a))?.pin_failures).toBe(0)
    expect((await signOutT(ac)).status).toBe(200)

    // 20 re-authentications at once: refused or slowed, never a 500, and other requests carry on.
    const [listed, ...many] = await Promise.all([
      ac.get('/api/devices'),
      ...Array.from({ length: 20 }, () => ac.post('/api/auth/reauth/pin', { pin: pinOf(a) })),
    ])
    expect(listed?.status).toBe(200)
    for (const reply of many) expect([200, 409, 429, 503]).toContain(reply.status)

    // T13 item 5, through the server's own World loader: an Admin can't reset or deactivate the Owner.
    const resetOwner = await ac.post('/api/admin/people/reset-pin', { person: o.id, identityCheck: 'in_person' })
    expect([resetOwner.status, resetOwner.error]).toEqual([403, 'forbidden'])
    const deactivateOwner = await ac.post('/api/admin/people/deactivate', { person: o.id })
    expect([deactivateOwner.status, deactivateOwner.error]).toEqual([403, 'forbidden'])

    // A member can't deactivate anyone.
    const xc = await s.signIn(x)
    const byMember = await xc.post('/api/admin/people/deactivate', { person: t.id })
    expect([byMember.status, byMember.error]).toEqual([403, 'forbidden'])

    // The Owner can reset the Admin's PIN.
    const oc = await s.signIn(o)
    const byOwner = await oc.post('/api/admin/people/reset-pin', { person: a.id, identityCheck: 'video_call' })
    expect(byOwner.status).toBe(200)
  })

  it('ACC-05 ACC-06: a PIN reset that waits on a deactivation in progress decides on what it committed, and is refused', async () => {
    // Budgets: Admin A 1 code request, Admin B 1, target T 1.
    const a = await s.person({ roles: ['admin'], pin: s.newPin() })
    const b = await s.person({ roles: ['admin'], pin: s.newPin() })
    const t = await s.person({ pin: s.newPin() })
    const ac = await s.signIn(a)
    const bc = await s.signIn(b)
    await s.signIn(t)
    const before = await userOf(t)

    // T's device held FOR SHARE keeps A's deactivation waiting in people_end_sessions, holding
    // T's person row, while B's reset is sent.
    let deactivating: Promise<Awaited<ReturnType<Client['post']>>> | undefined
    let resetting: Promise<Awaited<ReturnType<Client['post']>>> | undefined
    await s.query('begin')
    try {
      await s.query('select id from devices where user_id = $1 for share', [t.id])
      deactivating = ac.post('/api/admin/people/deactivate', { person: t.id })
      await lockWaiters(1)
      resetting = bc.post('/api/admin/people/reset-pin', { person: t.id, identityCheck: 'in_person' })
      await lockWaiters(2)
    } finally {
      await s.query('commit')
    }
    const [deactivated, reset] = await Promise.all([deactivating, resetting])
    expect(deactivated?.body).toEqual({ status: 'deactivated', sessionsEnded: 1 })
    expect([reset?.status, reset?.error]).toEqual([403, 'forbidden'])
    const after = await userOf(t)
    expect(after?.pin_hash).toBe(before?.pin_hash)
    expect(after?.pin_reset_at).toBeNull()
    expect((await auditOf(t)).filter(row => row.action.startsWith('person.')).map(row => row.action)).toEqual([
      'person.deactivate',
    ])
  })

  it("ACC-05 T14: a member's refused admin requests naming the admin deactivating them lock nothing of the admin's, so the deactivation ends their sessions", async () => {
    // Budgets: Admin A 1 code request, member M 1.
    const a = await s.person({ roles: ['admin'], pin: s.newPin() })
    const m = await s.person({ pin: s.newPin() })
    const ac = await s.signIn(a)
    const mc = await s.signIn(m)
    // M holds no admin role, and last re-authenticated 10 minutes ago.
    await s.age((await s.sessionOf(mc)).id, '10 minutes')

    // Two loops of requests naming A, taking turns between a PIN reset and a device sign-out, each
    // refused, until M is signed out or the deactivation has answered.
    const answers: string[] = []
    let stop = false
    const loop = async (first: number): Promise<void> => {
      for (let turn = first; !stop; turn++) {
        const reply =
          turn % 2 === 0
            ? await mc.post('/api/admin/people/reset-pin', { person: a.id, identityCheck: 'in_person' })
            : await mc.post('/api/admin/people/sign-out-devices', { person: a.id })
        answers.push(`${reply.status} ${reply.error}`)
        if (reply.status === 401) return
      }
    }
    const loops = [loop(0), loop(1)]
    try {
      await eventually(
        async () => answers.length,
        n => n >= 2,
      )
      const deactivated = await ac.post('/api/admin/people/deactivate', { person: m.id })
      expect([deactivated.status, deactivated.body]).toEqual([200, { status: 'deactivated', sessionsEnded: 1 }])
    } finally {
      stop = true
      await Promise.all(loops)
    }
    const [live] = await s.query<{ n: number }>(
      'select count(*)::int as n from sessions where user_id = $1 and revoked_at is null',
      [m.id],
    )
    expect(live?.n).toBe(0)
    // M was only ever refused, and then signed out.
    expect(answers.filter(answer => answer !== '403 forbidden' && answer !== '401 signed_out')).toEqual([])
  })

  it('C0.5 Done: deactivating a member signs them out everywhere and closes their socket within 2 s through the push (ACC-05, T5)', async () => {
    // Budgets: the Admin 1 code request, D 3, L 1.
    // L holds a PIN role, to reach the step-up (D46), so an Owner deactivates them.
    const admin = await s.person({ roles: ['owner'], pin: s.newPin() })
    const d = await s.person({ pin: s.newPin() })
    const l = await s.person({ roles: ['leadership'], pin: s.newPin() })

    const d1 = await s.signIn(d)
    const d2 = await s.signIn(d)
    const open = await socket(d1)
    const adminC = await s.signIn(admin)
    const before = s.realtime.server.counts().closedRevoked
    const startedAt = Date.now()
    const deactivated = await adminC.post('/api/admin/people/deactivate', { person: d.id })
    expect(deactivated.status).toBe(200)
    expect(deactivated.body).toEqual({ status: 'deactivated', sessionsEnded: 2 })
    const closed = await closeOf(open.closed)
    expect(closed).toMatchObject({ code: 4401, reason: 'signed_out' })
    expect(closed.at - startedAt).toBeLessThan(2000)
    // The push closed it, not the re-check.
    expect(s.realtime.server.counts().closedRevoked).toBe(before + 1)
    const reconnect = await s.openSocket(d1)
    expect(reconnect.status).toBe(401)
    for (const client of [d1, d2]) {
      const reply = await client.get('/api/devices')
      expect([reply.status, reply.error]).toEqual([401, 'signed_out'])
    }

    const ended = await s.query<{ revoke_reason: string; revoked_by: string; signed_out: boolean }>(
      `select s.revoke_reason, s.revoked_by, d.signed_out_at is not null as signed_out
       from sessions s join devices d on d.id = s.device_id where s.user_id = $1`,
      [d.id],
    )
    expect(ended).toHaveLength(2)
    for (const row of ended)
      expect(row).toEqual({ revoke_reason: 'deactivated', revoked_by: admin.id, signed_out: true })
    const [phone] = await s.query<{ removed_at: Date | null }>('select removed_at from phone_numbers where id = $1', [
      d.phoneNumberId,
    ])
    expect(phone?.removed_at).toBeNull()

    // Their number gets the same reply as anyone's, and no text.
    const sentBefore = s.sms.sent.length
    const leaver = await requestCode(s.client(), d.e164)
    expect(leaver.status).toBe(200)
    expect(leaver.body).toEqual({ status: 'code_sent', expiresInSeconds: 300, codeLength: 6 })
    expect(s.sms.sent.slice(sentBefore)).toEqual([])
    const rows = await auditOf(d)
    expect(rows.filter(row => row.action === 'auth.code_requested').at(-1)?.details).toEqual({ send: 'skipped_left' })
    expect(rows.filter(row => row.action === 'person.deactivate')).toEqual([
      expect.objectContaining({ actor_id: admin.id, details: { sessionsEnded: 2 } }),
    ])
    // C0.6 T16: one business event, three events beside it, the admin acting: the worker's
    // offboarding consumer reads person.deactivated; signin.ended names everything that ended.
    const sessionIds = (
      await s.query<{ id: string }>('select id from sessions where user_id = $1 order by id', [d.id])
    ).map(row => row.id)
    const deviceIds = (
      await s.query<{ id: string }>('select id from devices where user_id = $1 order by id', [d.id])
    ).map(row => row.id)
    const deactivation = (await eventsOf(d)).filter(event =>
      ['person.deactivated', 'signin.ended', 'acl.changed'].includes(event.type),
    )
    expect(deactivation.map(event => ({ ...event, ids: sortedIds(event.ids) }))).toEqual([
      about(d, 'person.deactivated', admin),
      about(d, 'signin.ended', admin, { sessions: sessionIds, devices: deviceIds, reason: 'deactivated' }),
      about(d, 'acl.changed', admin, { change: 'keys', reason: 'deactivated' }),
    ])

    // Asking again ends nothing and writes nothing.
    const twice = await adminC.post('/api/admin/people/deactivate', { person: d.id })
    expect(twice.body).toEqual({ status: 'deactivated', sessionsEnded: 0 })
    expect((await auditOf(d)).filter(row => row.action === 'person.deactivate')).toHaveLength(1)
    expect((await eventsOf(d)).filter(event => event.type === 'person.deactivated')).toHaveLength(1)

    // CLAUDE.md: a cross-origin upgrade is refused, even with a live session cookie.
    const crossOrigin = await s.openSocket(adminC, { origin: 'https://evil.example' })
    expect(crossOrigin.status).toBe(403)

    // Someone who leaves part-way through signing in gets no PIN check.
    const { client: lc, reply: lStep } = await atStepUp(l)
    expect(lStep.body).toMatchObject({ next: 'step_up' })
    expect((await adminC.post('/api/admin/people/deactivate', { person: l.id })).status).toBe(200)
    const afterLeaving = await verifyPin(lc, another(pinOf(l)))
    expect([afterLeaving.status, afterLeaving.error]).toEqual([401, 'attempt_expired'])
    expect((await userOf(l))?.pin_failures).toBe(0)
  })

  it('ACC-04: devices are listed and signed out: one, all others, this one, and by an admin', async () => {
    // Budgets: M 3 code requests, N 3, the Admin 1.
    const m = await s.person({ pin: s.newPin() })
    const n = await s.person({ pin: s.newPin() })
    const admin = await s.person({ roles: ['admin'], pin: s.newPin() })

    const a = await s.signIn(m)
    const b = await s.signIn(m, {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0',
    })
    const c = await s.signIn(m)
    const nx = await s.signIn(n)
    const ny = await s.signIn(n)
    const nz = await s.signIn(n)
    const aDevice = (await s.sessionOf(a)).deviceId
    const bDevice = (await s.sessionOf(b)).deviceId
    const cDevice = (await s.sessionOf(c)).deviceId
    const nxDevice = (await s.sessionOf(nx)).deviceId

    // Your own list: every signed-in device, with exact times.
    const listed = await a.get('/api/devices')
    expect(listed.status).toBe(200)
    const stored = await s.query<{ id: string; label: string; created_at: Date; last_seen_at: Date }>(
      'select id, label, created_at, last_seen_at from devices where user_id = $1',
      [m.id],
    )
    const devices = listed.json<{ devices: { id: string }[] }>().devices
    expect(devices).toHaveLength(3)
    expect([...devices].sort((x, y) => x.id.localeCompare(y.id))).toEqual(
      stored
        .map(row => ({
          id: row.id,
          label: row.label,
          createdAt: row.created_at.toISOString(),
          lastSeenAt: row.last_seen_at.toISOString(),
          current: row.id === aDevice,
        }))
        .sort((x, y) => x.id.localeCompare(y.id)),
    )
    expect(stored.find(row => row.id === bDevice)?.label).toBe('Mac · Firefox')

    // One device: its next request is refused and its socket closes through the push.
    const bSocket = await socket(b)
    const before = s.realtime.server.counts().closedRevoked
    const startedAt = Date.now()
    const one = await a.post('/api/devices/sign-out', { device: bDevice })
    expect(one.body).toEqual({ signedOut: 1, current: false })
    const bClosed = await closeOf(bSocket.closed)
    expect(bClosed.code).toBe(4401)
    expect(bClosed.at - startedAt).toBeLessThan(2000)
    expect(s.realtime.server.counts().closedRevoked).toBe(before + 1)
    expect((await b.get('/api/devices')).status).toBe(401)
    const again = await a.post('/api/devices/sign-out', { device: bDevice })
    expect([again.status, again.error]).toEqual([404, 'not_found'])

    // All the others.
    const others = await a.post('/api/devices/sign-out', { allOthers: true })
    expect(others.body).toEqual({ signedOut: 1, current: false })
    expect((await c.get('/api/devices')).status).toBe(401)

    // Someone else's device is not found, as though it didn't exist.
    const notMine = await a.post('/api/devices/sign-out', { device: nxDevice })
    expect([notMine.status, notMine.error]).toEqual([404, 'not_found'])

    // This one.
    const self = await a.post('/api/auth/sign-out', {})
    expect(self.body).toEqual({ status: 'signed_out' })
    expect(self.setCookies).toEqual([`${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`])
    expect(a.cookie(SESSION_COOKIE)).toBeUndefined()
    expect((await s.client().post('/api/auth/sign-out', {})).status).toBe(200)
    const mRows = await auditOf(m)
    expect(mRows.filter(row => row.action === 'auth.sign_out')).toEqual([
      expect.objectContaining({ actor_id: m.id, device_id: aDevice }),
    ])
    expect(mRows.filter(row => row.action === 'auth.device_sign_out').map(row => row.details.devices)).toEqual([
      [bDevice],
      [cDevice],
    ])
    // C0.6 T16: each sign-out appended signin.ended naming what it ended, M acting.
    const sessionOn = async (device: string) =>
      (await s.query<{ id: string }>('select id from sessions where device_id = $1', [device]))[0]?.id
    expect((await eventsOf(m)).filter(event => event.type === 'signin.ended')).toEqual([
      about(m, 'signin.ended', m, {
        sessions: [await sessionOn(bDevice)],
        devices: [bDevice],
        reason: 'device_sign_out',
      }),
      about(m, 'signin.ended', m, {
        sessions: [await sessionOn(cDevice)],
        devices: [cDevice],
        reason: 'device_sign_out',
      }),
      about(m, 'signin.ended', m, {
        sessions: [await sessionOn(aDevice)],
        devices: [aDevice],
        reason: 'device_sign_out',
      }),
    ])

    // A session unused for 31 days has ended, and so has one past its 90 days though used today
    // (T14: a device lists only while it holds a live session); the other device still lists.
    const xSocket = await socket(nx)
    await s.age((await s.sessionOf(ny)).id, '31 days')
    const idle = await ny.get('/api/devices')
    expect([idle.status, idle.error]).toEqual([401, 'signed_out'])
    expect(ny.cookie(SESSION_COOKIE)).toBeUndefined()
    await pastExpiry((await s.sessionOf(nz)).id)
    const expired = await nz.get('/api/devices')
    expect([expired.status, expired.error]).toEqual([401, 'signed_out'])
    expect((await nx.get('/api/devices')).json<{ devices: { id: string }[] }>().devices.map(d => d.id)).toEqual([
      nxDevice,
    ])

    // An admin sees dates, not times, and signs every device out.
    const adminC = await s.signIn(admin)
    const adminView = await adminC.get(`/api/admin/people/${n.id}/devices`)
    expect(adminView.status).toBe(200)
    expect(adminView.body).toEqual({
      devices: [
        {
          id: nxDevice,
          label: 'iPhone · Safari',
          createdOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          lastSeenOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        },
      ],
    })
    const pushedBefore = s.realtime.server.counts().closedRevoked
    const adminStartedAt = Date.now()
    const all = await adminC.post('/api/admin/people/sign-out-devices', { person: n.id })
    expect(all.body).toEqual({ signedOut: 3 })
    const xClosed = await closeOf(xSocket.closed)
    expect(xClosed.code).toBe(4401)
    expect(xClosed.at - adminStartedAt).toBeLessThan(2000)
    expect(s.realtime.server.counts().closedRevoked).toBe(pushedBefore + 1)
    expect((await auditOf(n)).filter(row => row.action === 'person.sign_out_devices')).toEqual([
      expect.objectContaining({ actor_id: admin.id }),
    ])
    // The admin's sign-out ended N's three devices and the session on each (idle or past its 90
    // days, a session is still revoked when its device signs out), the admin acting.
    const nIds = async (table: 'sessions' | 'devices') =>
      (await s.query<{ id: string }>(`select id from ${table} where user_id = $1 order by id`, [n.id])).map(
        row => row.id,
      )
    const byAdmin = (await eventsOf(n)).filter(event => event.type === 'signin.ended')
    expect(byAdmin.map(event => ({ ...event, ids: sortedIds(event.ids) }))).toEqual([
      about(n, 'signin.ended', admin, {
        sessions: await nIds('sessions'),
        devices: await nIds('devices'),
        reason: 'device_sign_out',
      }),
    ])
  })

  it("T5: the re-check alone closes a revoked session's socket", async () => {
    // Budgets: Q 1 code request.
    const other = await s.startRealtime({ recheckMs: 500, subscribe: false })
    const q = await s.person({ pin: s.newPin() })
    const qc = await s.signIn(q)
    const open = await socket(qc, other.url)
    const { deviceId } = await s.sessionOf(qc)
    const startedAt = Date.now()
    const out = await qc.post('/api/devices/sign-out', { device: deviceId })
    expect(out.body).toEqual({ signedOut: 1, current: true })
    const closed = await closeOf(open.closed)
    expect(closed).toMatchObject({ code: 4401, reason: 'signed_out' })
    expect(closed.at - startedAt).toBeLessThan(2000)
    expect(other.server.counts()).toMatchObject({ closedRecheck: 1, closedRevoked: 0 })
  })

  it('T14: with Valkey down, sign-in fails closed and signed-in requests carry on', async () => {
    // Budgets: V 1 code request, W 1.
    // V holds a PIN role, so re-authenticates with the PIN (D46); W, a Member, by SMS code.
    const v = await s.person({ roles: ['admin'], pin: s.newPin() })
    const w = await s.person()
    const signedIn = await s.signIn(v)
    const member = await s.signIn(w)
    // Nothing listens on port 1, so every Valkey command fails at once.
    const down = await s.startApi({ valkeyUrl: 'redis://127.0.0.1:1' })

    const fresh = s.client({ app: down })
    const request = await requestCode(fresh, v.e164)
    expect([request.status, request.error]).toEqual([503, 'unavailable'])
    fresh.setCookie(ATTEMPT_COOKIE, 'a'.repeat(43))
    const verify = await verifyCode(fresh, '000000')
    expect([verify.status, verify.error]).toEqual([503, 'unavailable'])

    const same = s.client({ app: down })
    same.setCookie(SESSION_COOKIE, signedIn.cookie(SESSION_COOKIE) ?? '')
    expect((await same.get('/api/devices')).status).toBe(200)
    expect((await same.post('/api/auth/reauth/pin', { pin: pinOf(v) })).status).toBe(200)
    expect(s.logs.some(line => line.event === 'reauth_limit_unavailable')).toBe(true)
    // AQ-10: SMS re-authentication fails closed.
    const sameMember = s.client({ app: down })
    sameMember.setCookie(SESSION_COOKIE, member.cookie(SESSION_COOKIE) ?? '')
    const byCode = await sameMember.post('/api/auth/reauth/code/request', {})
    expect([byCode.status, byCode.error]).toEqual([503, 'unavailable'])
  })

  it('ACC-03 T14: a number in two orgs, and a number removed before its code is checked, at the step-up, and before the finish', async () => {
    // Budgets: T 1 code request (the second org's person holds the same number), Z 1, O 1, W 1, Y 1.
    const t = await s.person({ pin: s.newPin() })
    const twin = await s.person({ org: 'second', e164: t.e164 })
    const sentBefore = s.sms.sent.length
    const reply = await requestCode(s.client(), t.e164)
    expect(reply.body).toEqual({ status: 'code_sent', expiresInSeconds: 300, codeLength: 6 })
    expect(s.sms.sent.slice(sentBefore)).toEqual([])
    expect(await auditOf(t)).toEqual([])
    expect(await auditOf(twin)).toEqual([])
    const twoOrgs = s.logs.filter(line => line.event === 'phone_in_two_orgs')
    expect(twoOrgs.length).toBeGreaterThan(0)
    for (const line of twoOrgs) expect(JSON.stringify(line)).not.toContain(t.local)

    // The right code, checked after its number was removed, is answered as a wrong one and moves
    // the sign-in no further.
    const z = await s.person({ pin: s.newPin() })
    const zc = s.client()
    expect((await requestCode(zc, z.e164)).status).toBe(200)
    const zCode = await s.sms.nextCode(z.e164)
    await s.query('update phone_numbers set removed_at = now(), removed_by = $2 where id = $1', [
      z.phoneNumberId,
      s.org.system,
    ])
    const checked = await verifyCode(zc, zCode)
    expect(checked.status).toBe(401)
    expect(checked.body).toMatchObject({ error: 'code_wrong', triesLeft: 4 })
    await s.settled()
    expect((await auditOf(z)).map(row => [row.action, row.details])).toEqual([
      ['auth.code_requested', { send: 'attempted' }],
      ['auth.code_failed', { result: 'wrong', numberRemoved: true }],
    ])

    // The same for a PIN-role holder with a PIN (D46), whose finish alone reads the account: the
    // reply shows neither their PIN's state nor whether they have a passkey, and the attempt stays
    // at the code.
    const o = await s.person({ roles: ['owner'], pin: s.newPin() })
    const oc = s.client()
    expect((await requestCode(oc, o.e164)).status).toBe(200)
    const oCode = await s.sms.nextCode(o.e164)
    await s.query('update phone_numbers set removed_at = now(), removed_by = $2 where id = $1', [
      o.phoneNumberId,
      s.org.system,
    ])
    const oChecked = await verifyCode(oc, oCode)
    expect(oChecked.status).toBe(401)
    expect(oChecked.body).toMatchObject({ error: 'code_wrong', triesLeft: 4 })
    expect(oChecked.body).not.toHaveProperty('pin')
    expect(oChecked.body).not.toHaveProperty('passkey')
    const oPin = await verifyPin(oc, pinOf(o))
    expect([oPin.status, oPin.error]).toEqual([409, 'wrong_step'])
    expect(await s.query('select id from sessions where user_id = $1', [o.id])).toEqual([])
    await s.settled()
    expect((await auditOf(o)).map(row => [row.action, row.details])).toEqual([
      ['auth.code_requested', { send: 'attempted' }],
      ['auth.code_failed', { result: 'wrong', numberRemoved: true }],
    ])

    // At the step-up, a PIN for a number removed since is refused right or wrong, uncounted, and
    // the attempt goes.
    // W and Y hold PIN roles, to reach the PIN steps (D46).
    const w = await s.person({ roles: ['admin'], pin: s.newPin() })
    const { client: wc, reply: wStep } = await atStepUp(w)
    expect(wStep.body).toMatchObject({ next: 'step_up' })
    await s.query('update phone_numbers set removed_at = now(), removed_by = $2 where id = $1', [
      w.phoneNumberId,
      s.org.system,
    ])
    const guessed = await wc.post('/api/auth/pin/verify', { pin: s.newPin() })
    expect([guessed.status, guessed.error]).toEqual([401, 'attempt_expired'])
    expect((await userOf(w))?.pin_failures).toBe(0)
    await s.settled()
    expect((await auditOf(w)).map(row => row.action)).toEqual(['auth.code_requested'])

    const y = await s.person({ roles: ['admin'] })
    const { client: yc, reply: step } = await atStepUp(y)
    expect(step.body).toMatchObject({ next: 'set_pin' })
    await s.query('update phone_numbers set removed_at = now(), removed_by = $2 where id = $1', [
      y.phoneNumberId,
      s.org.system,
    ])
    const set = await yc.post('/api/auth/pin/set', { pin: s.newPin() })
    expect([set.status, set.error]).toEqual([401, 'attempt_expired'])
    expect(await s.query('select id from sessions where user_id = $1', [y.id])).toEqual([])
  })

  it('C0.6 T16 item 7: the outbox sweep names a committed write with no event, and sees no rolled-back one', async () => {
    const x = await s.person()
    const rename = (name: string) =>
      withOrg(s.db, { orgId: x.orgId, userId: x.id }, trx =>
        sql`update people set full_name = ${name} where org_id = ${x.orgId} and id = ${x.id}`.execute(trx),
      )
    // A write hearth_app may make, with no event beside it: the sweep must name it.
    await rename('Renamed without an event')
    const [write] = await s.query<{ xid: string; role: string }>(
      "select xid::text as xid, role from it_writes where table_name = 'people' and 'full_name' = any(columns) and row_ref = $1",
      [x.id],
    )
    expect(write?.role).toBe('hearth_app')
    const sweep = await sweepWrites(s.superuser)
    expect(sweep.problems).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^transaction ${write?.xid} wrote people\\.full_name \\(UPDATE\\) of ${x.id} as hearth_app but appended none of person\\.updated, acl\\.changed naming it`,
        ),
      ),
    )
    // A write that rolls back leaves no record, so it can't fail the sweep.
    await expect(
      withOrg(s.db, { orgId: x.orgId, userId: x.id }, async trx => {
        await sql`update people set full_name = 'Rolled back' where org_id = ${x.orgId} and id = ${x.id}`.execute(trx)
        throw new Error('rolled back')
      }),
    ).rejects.toThrow('rolled back')
    expect(await s.query("select 1 from it_writes where row_ref = $1 and role = 'hearth_app'", [x.id])).toHaveLength(1)
    // Taken out again, so the suite's own sweep judges only what the routes wrote.
    await s.query('delete from it_writes where xid = $1::xid8', [write?.xid])
    expect((await sweepWrites(s.superuser)).problems.filter(problem => problem.includes(x.id))).toEqual([])
  })

  it('PRD-53 T14: every limit is wired to the live Valkey', async () => {
    // Budgets: P1 3 code requests, P2 1, P5 1, P6 1, P7 1, P8 1, P9 1, P10 1; the other requests are
    // refused before any.
    // Each window is filled to the number PRD-53 or T14 sets (never policy.ts's own max, which a
    // change there would follow), and a request it covers is then refused.
    const filled = new Set<string>()
    async function fill(name: string, subject: string, count: number, at?: number): Promise<void> {
      filled.add(name)
      await seedWindow(s.names.limit(name, subject), count, at ?? (await valkeyNow()))
    }

    // 3 per number per 10 minutes.
    const fresh = s.number()
    await fill('otp-n10m', tag(s.keys, fresh), 3)
    expect((await requestCode(s.client(), fresh)).status).toBe(429)

    // 10 per number per rolling 24 hours: 7 an hour ago leave room for 3.
    const p1 = await s.person()
    await fill('otp-n24h', tag(s.keys, p1.e164), 7, (await valkeyNow()) - 3_600_000)
    const c1 = s.client()
    for (let i = 0; i < 3; i++) expect((await requestCode(c1, p1.e164)).status).toBe(200)
    const day = await requestCode(c1, p1.e164)
    expect(day.status).toBe(429)
    expect(day.body).toMatchObject({ error: 'too_many_requests', retryAfterSeconds: 82_800 })

    // The global SMS cap: the reply is the same, nothing is sent, and the attempt names nobody.
    const capKey = s.names.limit('sms-global', 'all')
    try {
      const p2 = await s.person()
      await fill('sms-global', 'all', 100)
      const sentBefore = s.sms.sent.length
      const c2 = s.client()
      const capped = await requestCode(c2, p2.e164)
      expect(capped.body).toEqual({ status: 'code_sent', expiresInSeconds: 300, codeLength: 6 })
      expect(s.sms.sent.slice(sentBefore)).toEqual([])
      expect((await auditOf(p2)).map(row => row.details)).toEqual([{ send: 'skipped_cap' }])
      expect(s.logs.some(line => line.event === 'sms_global_cap')).toBe(true)
      const guess = await verifyCode(c2, '000000')
      expect(guess.body).toMatchObject({ error: 'code_wrong', triesLeft: 4 })
    } finally {
      await s.valkey.del(capKey)
    }

    // Code requests per IP, and an IPv6 client by its /64.
    const ip = '192.0.2.77'
    await fill('otp-ip', tag(s.keys, `ip:${limitSubject(ip)}`), 30)
    expect((await requestCode(s.client({ ip }), s.number())).status).toBe(429)
    await fill('otp-ip', tag(s.keys, `ip:${limitSubject('2001:db8:7:7::1')}`), 30)
    expect((await requestCode(s.client({ ip: '2001:db8:7:7::1234' }), s.number())).status).toBe(429)

    // Every sign-in request per IP, 100 per 10 minutes: from the address, each step is refused (a
    // code request, a code check, setting a PIN and a PIN check; the dormant passkey suite checks
    // its own routes, D46).
    const authIp = '192.0.2.78'
    // P7 and P9 hold PIN roles, to reach the PIN steps (D46).
    const p7 = await s.person({ roles: ['leadership'], pin: s.newPin() })
    const p8 = await s.person()
    const p9 = await s.person({ roles: ['leadership'] })
    const atPin = s.client({ ip: authIp })
    expect((await requestCode(atPin, p7.e164)).status).toBe(200)
    expect((await verifyCode(atPin, await s.sms.nextCode(p7.e164))).status).toBe(200)
    const atCode = s.client({ ip: authIp })
    expect((await requestCode(atCode, p8.e164)).status).toBe(200)
    const atSetPin = s.client({ ip: authIp })
    expect((await requestCode(atSetPin, p9.e164)).status).toBe(200)
    const toSetPin = await verifyCode(atSetPin, await s.sms.nextCode(p9.e164))
    expect(toSetPin.body).toMatchObject({ next: 'set_pin' })
    await fill('auth-ip', tag(s.keys, `ip:${limitSubject(authIp)}`), 100)
    const fromAuthIp = {
      codeCheck: await verifyCode(atCode, await s.sms.nextCode(p8.e164)),
      setPin: await atSetPin.post('/api/auth/pin/set', { pin: s.newPin() }),
      pinCheck: await verifyPin(atPin, pinOf(p7)),
      codeRequest: await requestCode(s.client({ ip: authIp }), s.number()),
    }
    for (const [step, reply] of Object.entries(fromAuthIp)) {
      expect([reply.status, reply.error], step).toEqual([429, 'too_many_requests'])
    }

    // Every number together.
    const allKey = s.names.limit('otp-all', 'all')
    try {
      await fill('otp-all', 'all', 600)
      expect((await requestCode(s.client(), s.number())).status).toBe(429)
    } finally {
      await s.valkey.del(allKey)
    }

    // Code checks per number per day.
    const p5 = await s.person()
    const c5 = s.client()
    expect((await requestCode(c5, p5.e164)).status).toBe(200)
    await fill('otp-v24h', tag(s.keys, p5.e164), 10)
    expect((await verifyCode(c5, await s.sms.nextCode(p5.e164))).status).toBe(429)

    // Re-authentications per session (P6 holds a PIN role, so by the PIN, D46).
    const p6 = await s.person({ roles: ['admin'], pin: s.newPin() })
    const c6 = await s.signIn(p6)
    await fill('reauth', (await s.sessionOf(c6)).id, 10)
    const reauth = await c6.post('/api/auth/reauth/pin', { pin: pinOf(p6) })
    expect([reauth.status, reauth.error]).toEqual([429, 'too_many_requests'])

    // SMS re-authentication code requests and checks per person per rolling day (D46, AQ-09).
    const p10 = await s.person()
    const c10 = await s.signIn(p10)
    await fill('reauth-code-p24h', p10.id, 20)
    const codes = await c10.post('/api/auth/reauth/code/request', {})
    expect([codes.status, codes.error]).toEqual([429, 'too_many_requests'])
    await fill('reauth-check-p24h', p10.id, 20)
    const checks = await c10.post('/api/auth/reauth/code/verify', { code: '000000' })
    expect([checks.status, checks.error]).toEqual([429, 'too_many_requests'])

    // Every limit policy.ts names was filled and refused above.
    expect([...filled].sort()).toEqual(
      Object.values(LIMITS)
        .flat()
        .map(limit => limit.name)
        .sort(),
    )
  })
})
