import type { Redis } from 'ioredis'
import { describe, expect, it, vi } from 'vitest'
import { deactivate, listDevices, resetPin, signOutDevices } from '#src/admin/people.ts'
import type { Api } from '#src/api.ts'
import { deriveKeys } from '#src/auth/crypto.ts'
import { ApiError } from '#src/auth/errors.ts'
import { relyingParty } from '#src/auth/passkeys.ts'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'
import { AfterResponse, type ReqInfo } from '#src/http.ts'
import { OffboardingRegistry } from '#src/offboarding.ts'
import { type Statement, scriptedPool } from '#src/testing/pool.ts'

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
  memberLeft?: boolean
  rows?: (statement: Statement) => unknown[] | undefined
}) {
  return scriptedPool(statement => {
    const answered = options.rows?.(statement)
    if (answered !== undefined) return answered
    const { text } = statement
    if (text.includes('from people p')) return [{ fresh: options.fresh ?? true }]
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

function context(pool: ReturnType<typeof scriptedPool>) {
  const published: string[] = []
  const offboarding = new OffboardingRegistry({ info: vi.fn(), error: vi.fn() })
  const run = vi.spyOn(offboarding, 'run')
  const api: Api = {
    db: pool.db,
    valkey: { publish: async (_channel: string, message: string) => published.push(message) } as unknown as Redis,
    keys: deriveKeys('unit-test-unit-test-unit-test-unit-test'),
    sms: undefined,
    keyPrefix: 'it:unit:',
    offboarding,
    afterResponse: new AfterResponse(),
    appOrigin: 'https://hearth.example.com',
    names: valkeyKeys('it:unit:'),
    rp: relyingParty('https://hearth.example.com'),
  }
  const info: ReqInfo = {
    ip: '198.51.100.7',
    requestId: 'f0000000-0000-4000-8000-000000000001',
    userAgent: undefined,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ReqInfo['log'],
    after: () => {},
  }
  return { api, info, published, run }
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

describe('C0.5 ACC-05 deactivating someone', () => {
  it('deactivates, counts the sessions the trigger ended, audits once, then runs the offboarding handlers', async () => {
    const pool = org({
      rows: ({ text }) => {
        if (text.startsWith('update "people"')) return [{ id: MEMBER }]
        if (text.startsWith('select count(*) as n from sessions')) return [{ n: '2' }]
        return undefined
      },
    })
    const c = context(pool)
    expect(await deactivate(c.api, { person: MEMBER }, session, c.info)).toEqual({
      body: { status: 'deactivated', sessionsEnded: 2 },
    })
    const update = pool.statements.find(s => s.text.startsWith('update "people"'))
    expect(update?.text).toBe(
      'update "people" set "deactivated_at" = now(), "deactivated_by" = $1 where "org_id" = $2 and "id" = $3 and "deactivated_at" is null returning "id"',
    )
    expect(update?.values).toEqual([ADMIN, ORG, MEMBER])
    expect(audits(pool)).toHaveLength(1)
    expect(audits(pool)[0]?.values).toContain('person.deactivate')
    expect(audits(pool)[0]?.values).toContainEqual({ sessionsEnded: 2 })
    expect(c.run).toHaveBeenCalledWith({ orgId: ORG, personId: MEMBER, actorId: ADMIN })
  })

  it('answers a second deactivation 200 with nothing ended, writing nothing and running no handler', async () => {
    const pool = org({ memberLeft: true })
    const c = context(pool)
    expect(await deactivate(c.api, { person: MEMBER }, session, c.info)).toEqual({
      body: { status: 'deactivated', sessionsEnded: 0 },
    })
    expect(pool.texts().some(text => text.startsWith('update'))).toBe(false)
    expect(audits(pool)).toEqual([])
    expect(c.run).not.toHaveBeenCalled()
  })

  it('answers 200 with nothing ended when another admin deactivated them a moment ago', async () => {
    const pool = org({ rows: ({ text }) => (text.startsWith('update "people"') ? [] : undefined) })
    const c = context(pool)
    expect(await deactivate(c.api, { person: MEMBER }, session, c.info)).toEqual({
      body: { status: 'deactivated', sessionsEnded: 0 },
    })
    expect(audits(pool)).toEqual([])
    expect(c.run).not.toHaveBeenCalled()
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
})

describe('C0.5 ACC-06 resetting a PIN', () => {
  it('locks the person, then the account, clears the PIN and lock, ends their sessions and publishes them', async () => {
    const pool = org({
      rows: ({ text }) => {
        if (text.startsWith('select id from users')) return [{ id: MEMBER }]
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
    const work = pool.texts().filter(text => /^(select 1 from people|select id from users|update)/.test(text))
    expect(work).toEqual([
      'select 1 from people where org_id = $1 and id = $2 for no key update',
      'select id from users where org_id = $1 and id = $2 for update',
      'update users set pin_hash = null, pin_key_id = null, pin_set_at = null, pin_failures = 0, pin_reset_at = now(), pin_reset_by = $1 where org_id = $2 and id = $3',
      "update sessions set revoked_at = now(), revoked_by = $1, revoke_reason = 'pin_reset' where org_id = $2 and user_id = $3 and revoked_at is null returning id",
    ])
    expect(audits(pool)[0]?.values).toContain('Checked on a call')
    expect(audits(pool)[0]?.values).toContainEqual({ identityCheck: 'video_call', sessionsEnded: 2 })
    expect(c.published.flatMap(message => JSON.parse(message).sessions)).toEqual(ENDED)
  })

  it('answers 409 no_account for someone who has never signed in', async () => {
    const c = context(org({}))
    expect(
      await refusal(resetPin(c.api, { person: MEMBER, identityCheck: 'in_person' }, session, c.info)),
    ).toMatchObject({
      status: 409,
      code: 'no_account',
    })
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
    expect(c.published.flatMap(message => JSON.parse(message).sessions)).toEqual(ENDED)
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
