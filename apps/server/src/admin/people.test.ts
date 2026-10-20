import type { Redis } from 'ioredis'
import { describe, expect, it, vi } from 'vitest'
import { deactivate, listDevices, resetPin, signOutDevices } from '#src/admin/people.ts'
import type { Api } from '#src/api.ts'
import { Breaker } from '#src/auth/breaker.ts'
import { deriveKeys } from '#src/auth/crypto.ts'
import { ApiError } from '#src/auth/errors.ts'
import { relyingParty } from '#src/auth/passkeys.ts'
import { OTP } from '#src/auth/policy.ts'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'
import { AfterResponse, type ReqInfo } from '#src/http.ts'
import { staticFlags } from '#src/testing/flags.ts'
import { appended, type Statement, scriptedPool } from '#src/testing/pool.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const ADMIN = 'b0000000-0000-4000-8000-000000000001'
const OWNER = 'b0000000-0000-4000-8000-000000000002'
const MEMBER = 'b0000000-0000-4000-8000-000000000003'
const DEVICE = 'd0000000-0000-4000-8000-000000000001'
const SESSION = 'e0000000-0000-4000-8000-000000000001'
const ENDED = ['e0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000003']
const MEMBER_DEVICES = ['d0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000003']
const session = { sessionId: SESSION, orgId: ORG, userId: ADMIN, deviceId: DEVICE }

// The org: an Admin acting, an Owner, and a member who may have left already. `rows` answers the
// action's own statements.
function org(options: {
  fresh?: boolean
  // Whether the acting session was issued under the PIN rule (D46); the Admin holds a PIN.
  issuedUnderPinRule?: boolean
  memberLeft?: boolean
  rows?: (statement: Statement) => unknown[] | undefined
}) {
  return scriptedPool(statement => {
    const answered = options.rows?.(statement)
    if (answered !== undefined) return answered
    const { text } = statement
    if (text.includes('from people p')) {
      return [
        { fresh: options.fresh ?? true, pin_set: true, issued_under_pin_rule: options.issuedUnderPinRule ?? true },
      ]
    }
    if (text.startsWith('select "id", "deactivated_at" from "people"')) {
      return [
        { id: ADMIN, deactivated_at: null },
        { id: OWNER, deactivated_at: null },
        { id: MEMBER, deactivated_at: options.memberLeft ? new Date('2026-10-01T00:00:00Z') : null },
      ]
    }
    if (text.startsWith('select "person_id", "role"')) {
      return [
        { person_id: ADMIN, role: 'admin', team_id: null, revoked_at: null },
        { person_id: OWNER, role: 'owner', team_id: null, revoked_at: null },
      ]
    }
    return []
  })
}

function context(pool: ReturnType<typeof scriptedPool>, options: { publishRevoked?: boolean } = {}) {
  const published: string[] = []
  const api: Api = {
    db: pool.db,
    valkey: { publish: async (_channel: string, message: string) => published.push(message) } as unknown as Redis,
    keys: deriveKeys('unit-test-unit-test-unit-test-unit-test'),
    sms: undefined,
    keyPrefix: 'it:unit:',
    flags: staticFlags(),
    ...options,
    afterResponse: new AfterResponse(),
    appOrigin: 'https://hearth.example.com',
    names: valkeyKeys('it:unit:'),
    rp: relyingParty('https://hearth.example.com'),
    otp: { verifyFloorMs: 0, breaker: new Breaker(OTP.breaker) },
    passkeys: false,
  }
  const info: ReqInfo = {
    ip: '198.51.100.7',
    requestId: 'f0000000-0000-4000-8000-000000000001',
    userAgent: undefined,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ReqInfo['log'],
    after: () => {},
  }
  return { api, info, published }
}

const audits = (pool: ReturnType<typeof scriptedPool>) =>
  pool.statements.filter(s => s.text.startsWith('insert into "audit_events"'))

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!(error instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(error)}`)
  return error
}

describe('C0.5 ACC-05 C0.6 T16 deactivating someone', () => {
  // The member's deactivation ended two sessions and two devices.
  const deactivating = (options: { publishRevoked?: boolean } = {}) => {
    const pool = org({
      rows: ({ text }) => {
        if (text.startsWith('update "people"')) return [{ id: MEMBER }]
        if (text.startsWith('select id from sessions')) return ENDED.map(id => ({ id }))
        if (text.startsWith('select id from devices')) return MEMBER_DEVICES.map(id => ({ id }))
        return undefined
      },
    })
    return { pool, c: context(pool, options) }
  }

  it('deactivates, appends person.deactivated, signin.ended and acl.changed, audits once, then publishes what ended', async () => {
    const { pool, c } = deactivating()
    expect(await deactivate(c.api, { person: MEMBER }, session, c.info)).toEqual({
      body: { status: 'deactivated', sessionsEnded: 2 },
    })
    const update = pool.statements.find(s => s.text.startsWith('update "people"'))
    expect(update?.text).toBe(
      'update "people" set "deactivated_at" = now(), "deactivated_by" = $1 where "org_id" = $2 and "id" = $3 and "deactivated_at" is null returning "id"',
    )
    expect(update?.values).toEqual([ADMIN, ORG, MEMBER])
    // What the deactivation's trigger ended in this transaction (now() is the transaction's start).
    expect(pool.texts()).toContain(
      "select id from sessions where org_id = $1 and user_id = $2 and revoke_reason = 'deactivated' and revoked_at = now()",
    )
    expect(pool.texts()).toContain(
      'select id from devices where org_id = $1 and user_id = $2 and signed_out_at = now()',
    )
    // The admin is the actor (the transaction's), the leaver the subject, beside the write.
    expect(appended(pool.statements)).toEqual([
      { type: 'person.deactivated', entity: MEMBER, subjects: [MEMBER], ids: {}, actor: undefined },
      {
        type: 'signin.ended',
        entity: MEMBER,
        subjects: [MEMBER],
        ids: { sessions: ENDED, devices: MEMBER_DEVICES, reason: 'deactivated' },
        actor: undefined,
      },
      {
        type: 'acl.changed',
        entity: MEMBER,
        subjects: [MEMBER],
        ids: { change: 'keys', reason: 'deactivated' },
        actor: undefined,
      },
    ])
    const texts = pool.texts()
    expect(texts.findLastIndex(text => text.startsWith('insert into outbox_events'))).toBeLessThan(
      texts.findIndex(text => text.startsWith('insert into "audit_events"')),
    )
    expect(audits(pool)).toHaveLength(1)
    expect(audits(pool)[0]?.values).toContain('person.deactivate')
    expect(audits(pool)[0]?.values).toContainEqual({ sessionsEnded: 2 })
    // The api still closes their sockets at once, as before C0.6.
    expect(c.published.flatMap(message => JSON.parse(message).sessions)).toEqual(ENDED)
  })

  it('C0.7 T19 item 4: leaves the publish to the worker when told to (A6), and appends the same events', async () => {
    const { pool, c } = deactivating({ publishRevoked: false })
    await deactivate(c.api, { person: MEMBER }, session, c.info)
    expect(c.published).toEqual([])
    expect(appended(pool.statements).map(event => event.type)).toEqual([
      'person.deactivated',
      'signin.ended',
      'acl.changed',
    ])
  })

  it('appends no signin.ended for someone who had never signed in', async () => {
    const pool = org({ rows: ({ text }) => (text.startsWith('update "people"') ? [{ id: MEMBER }] : undefined) })
    const c = context(pool)
    expect(await deactivate(c.api, { person: MEMBER }, session, c.info)).toEqual({
      body: { status: 'deactivated', sessionsEnded: 0 },
    })
    expect(appended(pool.statements).map(event => event.type)).toEqual(['person.deactivated', 'acl.changed'])
  })

  it('answers a second deactivation 200 with nothing ended, writing, appending and publishing nothing', async () => {
    const pool = org({ memberLeft: true })
    const c = context(pool)
    expect(await deactivate(c.api, { person: MEMBER }, session, c.info)).toEqual({
      body: { status: 'deactivated', sessionsEnded: 0 },
    })
    expect(pool.texts().some(text => text.startsWith('update') || text.startsWith('insert'))).toBe(false)
    expect(c.published).toEqual([])
  })

  it('answers 200 with nothing ended when another admin deactivated them a moment ago', async () => {
    const pool = org({ rows: ({ text }) => (text.startsWith('update "people"') ? [] : undefined) })
    const c = context(pool)
    expect(await deactivate(c.api, { person: MEMBER }, session, c.info)).toEqual({
      body: { status: 'deactivated', sessionsEnded: 0 },
    })
    expect(audits(pool)).toEqual([])
    expect(appended(pool.statements)).toEqual([])
    expect(c.published).toEqual([])
  })

  it('still needs can(): 403 reauth_required without a fresh re-authentication, 403 forbidden for the Owner or yourself', async () => {
    const stale = context(org({ fresh: false, memberLeft: true }))
    expect(await refusal(deactivate(stale.api, { person: MEMBER }, session, stale.info))).toMatchObject({
      status: 403,
      code: 'reauth_required',
    })
    for (const person of [OWNER, ADMIN]) {
      const c = context(org({}))
      expect(await refusal(deactivate(c.api, { person }, session, c.info))).toMatchObject({
        status: 403,
        code: 'forbidden',
      })
    }
  })

  it('D46 AQ-02: an Admin on a session issued under the code-only rule must sign in again, even with a fresh stamp', async () => {
    const c = context(org({ issuedUnderPinRule: false }))
    const error = await refusal(deactivate(c.api, { person: MEMBER }, session, c.info))
    expect(error).toMatchObject({ status: 403, code: 'reauth_required', extra: { method: 'sign_in' }, person: ADMIN })
    const stale = context(org({ fresh: false }))
    expect(await refusal(deactivate(stale.api, { person: MEMBER }, session, stale.info))).toMatchObject({
      status: 403,
      code: 'reauth_required',
      extra: { method: 'pin' },
    })
  })
})

describe('C0.5 ACC-06 resetting a PIN', () => {
  // The Admin resets a Member who holds no Owner-only role, so the PIN is a former holder's
  // leftover one, which an Admin may still clear (D46, AUTH-DESIGN §4.5).
  it('locks the person, then the account, clears the PIN and lock, ends their sessions and publishes them', async () => {
    const pool = org({
      rows: ({ text }) => {
        if (text.startsWith('select pin_hash from users')) return [{ pin_hash: 'hashed' }]
        if (text.startsWith('update sessions')) return ENDED.map(id => ({ id }))
        return undefined
      },
    })
    const c = context(pool)
    expect(
      await resetPin(
        c.api,
        { person: MEMBER, identityCheck: 'video_call', note: 'Checked on a call' },
        session,
        c.info,
      ),
    ).toEqual({ body: { status: 'pin_reset', sessionsEnded: 2 } })
    const work = pool.texts().filter(text => /^(select 1 from people|select pin_hash from users|update)/.test(text))
    expect(work).toEqual([
      'select 1 from people where org_id = $1 and id = $2 for no key update',
      'select pin_hash from users where org_id = $1 and id = $2 for update',
      'update users set pin_hash = null, pin_key_id = null, pin_set_at = null, pin_failures = 0, pin_reset_at = now(), pin_reset_by = $1 where org_id = $2 and id = $3',
      "update sessions set revoked_at = now(), revoked_by = $1, revoke_reason = 'pin_reset' where org_id = $2 and user_id = $3 and revoked_at is null returning id",
    ])
    expect(audits(pool)[0]?.values).toContain('Checked on a call')
    expect(audits(pool)[0]?.values).toContainEqual({ identityCheck: 'video_call', sessionsEnded: 2 })
    // C0.6: the reset and the sessions it ended, with the admin as the actor.
    expect(appended(pool.statements)).toEqual([
      { type: 'account.pin_reset', entity: MEMBER, subjects: [MEMBER], ids: {}, actor: undefined },
      {
        type: 'signin.ended',
        entity: MEMBER,
        subjects: [MEMBER],
        ids: { sessions: ENDED, devices: [], reason: 'pin_reset' },
        actor: undefined,
      },
    ])
    expect(c.published.flatMap(message => JSON.parse(message).sessions)).toEqual(ENDED)
  })

  it('C0.7 T19 item 4: leaves the publish to the worker when told to, and still appends signin.ended', async () => {
    const pool = org({
      rows: ({ text }) => {
        if (text.startsWith('select pin_hash from users')) return [{ pin_hash: 'hashed' }]
        if (text.startsWith('update sessions')) return ENDED.map(id => ({ id }))
        return undefined
      },
    })
    const c = context(pool, { publishRevoked: false })
    await resetPin(c.api, { person: MEMBER, identityCheck: 'in_person' }, session, c.info)
    expect(c.published).toEqual([])
    expect(appended(pool.statements).map(event => event.type)).toEqual(['account.pin_reset', 'signin.ended'])
  })

  it('ACC-06 D46 answers 409 no_pin for someone who has never signed in', async () => {
    const c = context(org({}))
    expect(
      await refusal(resetPin(c.api, { person: MEMBER, identityCheck: 'in_person' }, session, c.info)),
    ).toMatchObject({ status: 409, code: 'no_pin' })
    expect(c.published).toEqual([])
  })

  it('ACC-06 D46 answers 409 no_pin for someone who signs in on the code alone, ending nothing', async () => {
    const pool = org({
      rows: ({ text }) => (text.startsWith('select pin_hash from users') ? [{ pin_hash: null }] : undefined),
    })
    const c = context(pool)
    expect(
      await refusal(resetPin(c.api, { person: MEMBER, identityCheck: 'in_person' }, session, c.info)),
    ).toMatchObject({ status: 409, code: 'no_pin' })
    // It decided after locking the person and the account, and changed, appended and audited nothing.
    expect(pool.texts().filter(text => /^(select 1 from people|select pin_hash from users)/.test(text))).toEqual([
      'select 1 from people where org_id = $1 and id = $2 for no key update',
      'select pin_hash from users where org_id = $1 and id = $2 for update',
    ])
    expect(pool.texts().some(text => text.startsWith('update'))).toBe(false)
    expect(appended(pool.statements)).toEqual([])
    expect(audits(pool)).toEqual([])
    expect(c.published).toEqual([])
  })
})

describe('C0.5 ACC-04 an admin signing devices out and listing them', () => {
  it("locks someone else's person row before signing every device of theirs out, and publishes what ended", async () => {
    const pool = org({
      rows: ({ text }) => {
        if (text.startsWith('update "devices"')) return MEMBER_DEVICES.map(id => ({ id }))
        if (text.startsWith('select id from sessions')) return ENDED.map(id => ({ id }))
        return undefined
      },
    })
    const c = context(pool)
    expect(await signOutDevices(c.api, { person: MEMBER }, session, c.info)).toEqual({
      body: { signedOut: 2 },
      cookies: [],
    })
    const texts = pool.texts()
    const lock = texts.indexOf('select 1 from people where org_id = $1 and id = $2 for no key update')
    expect(lock).toBeGreaterThan(-1)
    expect(lock).toBeLessThan(texts.findIndex(text => text.startsWith('update "devices"')))
    expect(audits(pool)[0]?.values).toContainEqual({ devices: MEMBER_DEVICES })
    expect(appended(pool.statements)).toEqual([
      {
        type: 'signin.ended',
        entity: MEMBER,
        subjects: [MEMBER],
        ids: { sessions: ENDED, devices: MEMBER_DEVICES, reason: 'device_sign_out' },
        actor: undefined,
      },
    ])
    expect(c.published.flatMap(message => JSON.parse(message).sessions)).toEqual(ENDED)
  })

  it('C0.7 T19 item 4: leaves the publish to the worker when told to, and still appends signin.ended', async () => {
    const pool = org({
      rows: ({ text }) => {
        if (text.startsWith('update "devices"')) return MEMBER_DEVICES.map(id => ({ id }))
        if (text.startsWith('select id from sessions')) return ENDED.map(id => ({ id }))
        return undefined
      },
    })
    const c = context(pool, { publishRevoked: false })
    expect(await signOutDevices(c.api, { person: MEMBER }, session, c.info)).toEqual({
      body: { signedOut: 2 },
      cookies: [],
    })
    expect(c.published).toEqual([])
    expect(appended(pool.statements).map(event => event.type)).toEqual(['signin.ended'])
  })

  it('signs out your own devices with your own row taken FOR NO KEY UPDATE, and clears your cookie', async () => {
    const pool = org({ rows: ({ text }) => (text.startsWith('update "devices"') ? [{ id: DEVICE }] : undefined) })
    const c = context(pool)
    const answer = await signOutDevices(c.api, { person: ADMIN }, session, c.info)
    expect(answer.cookies).toEqual(['__Host-hearth_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'])
    expect(pool.statements.find(s => s.text.includes('from people p'))?.text).toMatch(
      /for no key update of p for share of d, s$/,
    )
  })

  it("lists someone's signed-in devices with dates in the org's time zone, not times", async () => {
    const pool = org({
      rows: ({ text }) =>
        text.startsWith('select d.id, d.label,')
          ? [{ id: MEMBER_DEVICES[0], label: 'iPhone · Safari', created_on: '2026-10-01', last_seen_on: '2026-10-13' }]
          : undefined,
    })
    const c = context(pool)
    expect(await listDevices(c.api, MEMBER, session, c.info)).toEqual({
      body: {
        devices: [
          { id: MEMBER_DEVICES[0], label: 'iPhone · Safari', createdOn: '2026-10-01', lastSeenOn: '2026-10-13' },
        ],
      },
    })
    const query = pool.texts().find(text => text.startsWith('select d.id, d.label,'))
    expect(query).toContain('((d.created_at at time zone o.time_zone)::date)::text as created_on')
    expect(query).toContain('d.signed_out_at is null and exists (select 1 from sessions s')
    // A GET takes no lock.
    expect(pool.statements.find(s => s.text.includes('from people p'))?.text).not.toMatch(/for share/)
  })
})
