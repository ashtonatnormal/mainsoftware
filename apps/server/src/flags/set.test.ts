import { FLAGS } from '@hearth/shared'
import type { Redis } from 'ioredis'
import { describe, expect, it, vi } from 'vitest'
import type { Api } from '#src/api.ts'
import { apiErrorOf } from '#src/api.ts'
import { Breaker } from '#src/auth/breaker.ts'
import { deriveKeys } from '#src/auth/crypto.ts'
import { ApiError } from '#src/auth/errors.ts'
import { relyingParty } from '#src/auth/passkeys.ts'
import { OTP } from '#src/auth/policy.ts'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'
import { SetFlagBody, setFlag } from '#src/flags/set.ts'
import { AfterResponse, parse, type ReqInfo } from '#src/http.ts'
import { staticFlags } from '#src/testing/flags.ts'
import { appended, pgError, type Statement, scriptedPool } from '#src/testing/pool.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const ADMIN = 'b0000000-0000-4000-8000-000000000001'
const MEMBER = 'b0000000-0000-4000-8000-000000000003'
const DEVICE = 'd0000000-0000-4000-8000-000000000001'
const FLAG_ID = 'f0000000-0000-4000-8000-0000000000aa'
const session = (userId = ADMIN) => ({
  sessionId: 'e0000000-0000-4000-8000-000000000001',
  orgId: ORG,
  userId,
  deviceId: DEVICE,
})

// The test registry the route accepts keys from (A5): production's flags and two test ones.
const REGISTRY = {
  ...FLAGS,
  'it.optional': {
    ...FLAGS['core.system'],
    class: 'optional',
    default: false,
    locked: false,
    purposes: ['service_operation'],
  },
  'it.ai': { ...FLAGS['core.system'], class: 'optional', default: false, locked: false, purposes: ['org_brain'] },
} as const

// The org: an Admin and a Member. `revision` is what set_feature_flag() returns (1 is the row's
// own: a change that changed nothing); `fails` makes it raise.
function org(options: { fresh?: boolean; row?: boolean; revision?: string; fails?: Error } = {}) {
  return scriptedPool((statement: Statement) => {
    const { text } = statement
    if (text.includes('from people p')) return [{ fresh: options.fresh ?? true }]
    if (text.startsWith('select "id", "deactivated_at" from "people"')) {
      return [
        { id: ADMIN, deactivated_at: null },
        { id: MEMBER, deactivated_at: null },
      ]
    }
    if (text.startsWith('select "person_id", "role"')) {
      return [{ person_id: ADMIN, role: 'admin', team_id: null, revoked_at: null }]
    }
    if (text.startsWith('select "id", "revision" from "feature_flags"')) {
      return options.row === false ? [] : [{ id: FLAG_ID, revision: '1' }]
    }
    if (text.startsWith('select public.set_feature_flag(')) {
      return options.fails ?? [{ revision: options.revision ?? '2' }]
    }
    return []
  })
}

function context(pool: ReturnType<typeof scriptedPool>) {
  const published: { channel: string; message: string; statements: number }[] = []
  const flags = staticFlags(REGISTRY)
  const api: Api = {
    db: pool.db,
    valkey: {
      publish: async (channel: string, message: string) =>
        published.push({ channel, message, statements: pool.statements.length }),
    } as unknown as Redis,
    keys: deriveKeys('unit-test-unit-test-unit-test-unit-test'),
    sms: undefined,
    keyPrefix: 'it:unit:',
    flags,
    afterResponse: new AfterResponse(),
    appOrigin: 'https://hearth.example.com',
    names: valkeyKeys('it:unit:'),
    rp: relyingParty('https://hearth.example.com'),
    otp: { verifyFloorMs: 0, breaker: new Breaker(OTP.breaker) },
  }
  const info: ReqInfo = {
    ip: '198.51.100.7',
    requestId: 'f0000000-0000-4000-8000-000000000001',
    userAgent: undefined,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ReqInfo['log'],
    after: () => {},
  }
  return { api, info, published, flags }
}

const body = (input: unknown) => parse(SetFlagBody, input)

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!(error instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(error)}`)
  return error
}

describe('C0.6 T17 item 9 POST /api/admin/flags/set', () => {
  it('lets an Admin change a flag through set_feature_flag(), appends flag.changed, and publishes after the commit', async () => {
    const pool = org()
    const c = context(pool)
    expect(await setFlag(c.api, body({ key: 'it.optional', enabled: false }), session(), c.info)).toEqual({
      body: { key: 'it.optional', enabled: false, revision: 2 },
    })
    const call = pool.statements.find(s => s.text.startsWith('select public.set_feature_flag('))
    expect(call?.text).toBe(
      'select public.set_feature_flag($1, $2, $3, $4::uuid[], $5::text[], $6, $7::uuid, $8::inet) as revision',
    )
    // The request's id, the session's device and the client's address for the audit row.
    expect(call?.values).toEqual(['it.optional', false, 'org', [], [], c.info.requestId, DEVICE, c.info.ip])
    // The Admin is the actor (the transaction's); the flag's row is the entity (A9: no key, no revision).
    expect(appended(pool.statements)).toEqual([
      { type: 'flag.changed', entity: FLAG_ID, subjects: [], ids: { enabled: false }, actor: undefined },
    ])
    const commit = pool.texts().lastIndexOf('commit')
    expect(c.published).toHaveLength(1)
    expect(c.published[0]?.statements).toBeGreaterThan(commit)
    expect(c.published[0]?.channel).toBe('it:unit:flags')
    expect(JSON.parse(c.published[0]?.message ?? '{}')).toMatchObject({
      v: 1,
      org: ORG,
      key: 'it.optional',
      revision: 2,
    })
    expect(c.flags.reload).toHaveBeenCalledWith(ORG)
    expect(c.flags.track).toHaveBeenCalledWith(ORG)
  })

  it('appends and publishes nothing when the change changed nothing', async () => {
    const pool = org({ revision: '1' })
    const c = context(pool)
    expect(await setFlag(c.api, body({ key: 'it.optional', enabled: true }), session(), c.info)).toEqual({
      body: { key: 'it.optional', enabled: true, revision: 1 },
    })
    expect(appended(pool.statements)).toEqual([])
    expect(c.published).toEqual([])
  })

  it('sends a cohort of people and org-wide roles as the database stores it', async () => {
    const pool = org()
    const c = context(pool)
    await setFlag(
      c.api,
      body({ key: 'it.optional', enabled: true, audience: 'cohort', people: [MEMBER.toUpperCase()], roles: ['dpo'] }),
      session(),
      c.info,
    )
    expect(pool.statements.find(s => s.text.startsWith('select public.set_feature_flag('))?.values.slice(0, 5)).toEqual(
      ['it.optional', true, 'cohort', [MEMBER], ['dpo']],
    )
  })

  it('refuses a Member, any ai.* flag, and a stale re-authentication through can(), before reading any flag', async () => {
    for (const [who, key, fresh, code] of [
      [MEMBER, 'it.optional', true, 'forbidden'],
      [ADMIN, 'ai.ask', true, 'forbidden'],
      [ADMIN, 'ai', true, 'forbidden'],
      [ADMIN, 'it.optional', false, 'reauth_required'],
    ] as const) {
      const pool = org({ fresh })
      const c = context(pool)
      expect(
        await refusal(setFlag(c.api, body({ key, enabled: true }), session(who), c.info)),
        `${who} ${key}`,
      ).toMatchObject({
        status: 403,
        code,
      })
      expect(pool.texts().some(text => text.includes('feature_flags'))).toBe(false)
      expect(c.published).toEqual([])
    }
  })

  it('answers 404 for a key this process doesn’t know, before reading rows, and for one the org has no row for', async () => {
    const unknown = org()
    const c = context(unknown)
    expect(await refusal(setFlag(c.api, body({ key: 'it.unknown', enabled: true }), session(), c.info))).toMatchObject({
      status: 404,
      code: 'not_found',
    })
    expect(unknown.texts().some(text => text.includes('feature_flags'))).toBe(false)
    const missing = org({ row: false })
    const d = context(missing)
    expect(await refusal(setFlag(d.api, body({ key: 'it.optional', enabled: true }), session(), d.info))).toMatchObject(
      {
        status: 404,
        code: 'not_found',
      },
    )
    expect(missing.texts().some(text => text.startsWith('select public.set_feature_flag('))).toBe(false)
  })

  it('refuses to turn on a feature whose purpose the gate refuses (409 purpose_refused), but lets it be turned off', async () => {
    const pool = org()
    const c = context(pool)
    expect(await refusal(setFlag(c.api, body({ key: 'it.ai', enabled: true }), session(), c.info))).toMatchObject({
      status: 409,
      code: 'purpose_refused',
    })
    expect(pool.texts().some(text => text.startsWith('select public.set_feature_flag('))).toBe(false)
    const off = context(org())
    expect(await setFlag(off.api, body({ key: 'it.ai', enabled: false }), session(), off.info)).toMatchObject({
      body: { key: 'it.ai', enabled: false },
    })
  })

  it('maps set_feature_flag()’s refusals: locked 409, a cohort outside the org 400, unknown 404, refused 403', async () => {
    for (const [code, status, error] of [
      ['HF003', 409, 'flag_locked'],
      ['HF004', 400, 'invalid_cohort'],
      ['22023', 404, 'not_found'],
      ['42501', 403, 'forbidden'],
    ] as const) {
      const pool = org({ fails: pgError(code) })
      const c = context(pool)
      expect(
        await refusal(setFlag(c.api, body({ key: 'it.optional', enabled: false }), session(), c.info)),
        code,
      ).toMatchObject({
        status,
        code: error,
      })
      expect(pool.texts().at(-1)).toBe('rollback')
      expect(appended(pool.statements)).toEqual([])
      expect(c.published).toEqual([])
    }
    // A lock not granted in time reaches the api's error handler, which answers 409 try_again.
    const busy = org({ fails: pgError('55P03') })
    const c = context(busy)
    const thrown = await setFlag(c.api, body({ key: 'it.optional', enabled: false }), session(), c.info).catch(
      (e: unknown) => e,
    )
    expect(apiErrorOf(thrown)).toMatchObject({ status: 409, code: 'try_again' })
  })

  it('A8: refuses a cohort the table would refuse with 400 invalid_cohort, before the database, and a malformed key 400', async () => {
    const tooMany = {
      people: Array.from({ length: 995 }, (_, n) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`),
      roles: ['dpo', 'admin', 'owner', 'leadership', 'ai_admin', 'compliance_officer'],
    }
    for (const input of [
      { key: 'it.optional', enabled: true, audience: 'cohort' },
      { key: 'it.optional', enabled: true, audience: 'org', people: [MEMBER] },
      { key: 'it.optional', enabled: true, audience: 'cohort', roles: ['team_admin'] },
      { key: 'it.optional', enabled: true, audience: 'cohort', roles: ['member'] },
      { key: 'it.optional', enabled: true, audience: 'cohort', ...tooMany },
    ]) {
      const pool = org()
      const c = context(pool)
      expect(
        await refusal(setFlag(c.api, body(input), session(), c.info)),
        JSON.stringify(input).slice(0, 80),
      ).toMatchObject({
        status: 400,
        code: 'invalid_cohort',
      })
      expect(pool.statements).toEqual([])
    }
    for (const input of [
      { key: 'Not.A.Key', enabled: true },
      { key: 'it.optional' },
      { key: 'it.optional', enabled: true, people: ['not-a-uuid'] },
      { key: 'it.optional', enabled: true, colour: 'red' },
    ]) {
      expect(() => body(input), JSON.stringify(input)).toThrow(ApiError)
    }
  })
})
