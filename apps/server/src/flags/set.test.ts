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
import { NOTHING_CLEARED } from '#src/testing/transfers.ts'

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

// The test registry the route accepts keys from (A5): production's flags and three test ones.
// it.unnotified names security_audit, which isn't pinned, so the purpose gate refuses it until a
// published notice lists it (C0.9 PR 2).
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
  'it.unnotified': {
    ...FLAGS['core.system'],
    class: 'optional',
    default: false,
    locked: false,
    purposes: ['security_audit'],
  },
} as const

// The flag's row as the route reads it: off for the whole org, revision 1, unless a test says.
interface FlagRow {
  enabled: boolean
  audience: 'org' | 'cohort'
  cohort_people: string[]
  cohort_roles: string[]
}

// The org: an Admin and a Member. `revision` is what set_feature_flag() returns (1 is the row's
// own: a change that changed nothing); `fails` makes it raise. `before` is the flag's row.
// issuedUnderPinRule: whether the acting session was issued under the PIN rule (D46); the Admin holds
// a PIN. The registers hold security_audit active on legitimate interests, which no notice lists.
function org(
  options: {
    fresh?: boolean
    issuedUnderPinRule?: boolean
    row?: boolean
    revision?: string
    fails?: Error
    before?: Partial<FlagRow>
  } = {},
) {
  return scriptedPool((statement: Statement) => {
    const { text } = statement
    if (text.includes('from people p')) {
      return [
        { fresh: options.fresh ?? true, pin_set: true, issued_under_pin_rule: options.issuedUnderPinRule ?? true },
      ]
    }
    if (text.startsWith('select "id", "deactivated_at" from "people"')) {
      return [
        { id: ADMIN, deactivated_at: null },
        { id: MEMBER, deactivated_at: null },
      ]
    }
    if (text.startsWith('select "person_id", "role"')) {
      return [{ person_id: ADMIN, role: 'admin', team_id: null, revoked_at: null }]
    }
    if (
      text.startsWith(
        'select "id", "revision", "enabled", "audience", "cohort_people", "cohort_roles" from "feature_flags"',
      )
    ) {
      if (options.row === false) return []
      return [
        {
          id: FLAG_ID,
          revision: '1',
          enabled: false,
          audience: 'org',
          cohort_people: [],
          cohort_roles: [],
          ...options.before,
        },
      ]
    }
    if (text.startsWith('select distinct on (purpose)')) {
      return [
        { purpose: 'accounts', version: 1, status: 'active', basis: null, providers: [] },
        { purpose: 'security_audit', version: 2, status: 'active', basis: 'legitimate_interests', providers: [] },
      ]
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
    passkeys: false,
    transfers: NOTHING_CLEARED,
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

  it('D46 AQ-02: refuses an Admin on a session issued under the code-only rule with reauth_required {method: sign_in}', async () => {
    const pool = org({ issuedUnderPinRule: false })
    const c = context(pool)
    expect(await refusal(setFlag(c.api, body({ key: 'it.optional', enabled: true }), session(), c.info))).toMatchObject(
      {
        status: 403,
        code: 'reauth_required',
        extra: { method: 'sign_in' },
      },
    )
    expect(pool.texts().some(text => text.includes('feature_flags'))).toBe(false)
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

  // The statements of the register read (compliance/registers.ts), in the order made.
  const registerReads = (pool: ReturnType<typeof scriptedPool>) =>
    pool.texts().filter(text => /\bfrom (processing_register|transfer_register|processing_restrictions)\b/.test(text))

  it('PGT-11 C0.9 PD-19 T22 item 11: turning on reads the registers in the route’s transaction, after can() and the row, and refuses a purpose that isn’t allowed', async () => {
    const pool = org()
    const c = context(pool)
    // security_audit is active, but no published notice lists it until C0.9 PR 2 (PGT-04).
    expect(
      await refusal(setFlag(c.api, body({ key: 'it.unnotified', enabled: true }), session(), c.info)),
    ).toMatchObject({ status: 409, code: 'purpose_refused' })
    const texts = pool.texts()
    const row = texts.findIndex(text => text.startsWith('select "id", "revision", "enabled"'))
    const read = texts.findIndex(text => text.startsWith('select distinct on (purpose)'))
    expect(texts.findIndex(text => text.startsWith('select "person_id", "role"'))).toBeLessThan(row)
    expect(row).toBeLessThan(read)
    expect(texts.lastIndexOf('start transaction isolation level read committed')).toBeLessThan(row)
    expect(texts.at(-1)).toBe('rollback')
    // A plain read for the org, with no restrictions (hearth_app has no grant on them).
    expect(registerReads(pool)).toHaveLength(2)
    expect(registerReads(pool).join(' ')).not.toMatch(/processing_restrictions|\bfor (share|update)\b/)
    expect(texts.some(text => text.startsWith('select public.set_feature_flag('))).toBe(false)
    expect(appended(pool.statements)).toEqual([])
    expect(c.published).toEqual([])
    // A pinned purpose is allowed in every state of the registers.
    const pinned = org()
    const d = context(pinned)
    expect(await setFlag(d.api, body({ key: 'it.optional', enabled: true }), session(), d.info)).toMatchObject({
      body: { key: 'it.optional', enabled: true, revision: 2 },
    })
    expect(registerReads(pinned)).toHaveLength(2)
  })

  it('PGT-11 C0.9 PD-19: refuses a change that widens an enabled flag whose purpose is refused: a cohort to the whole org, or a person or role the cohort didn’t name', async () => {
    const cohort = { enabled: true, audience: 'cohort' as const, cohort_people: [MEMBER], cohort_roles: ['dpo'] }
    for (const input of [
      { key: 'it.unnotified', enabled: true },
      { key: 'it.unnotified', enabled: true, audience: 'cohort', people: [MEMBER, ADMIN], roles: ['dpo'] },
      { key: 'it.unnotified', enabled: true, audience: 'cohort', people: [MEMBER], roles: ['dpo', 'admin'] },
      { key: 'it.unnotified', enabled: true, audience: 'cohort', people: [ADMIN] },
    ]) {
      const pool = org({ before: cohort })
      const c = context(pool)
      expect(await refusal(setFlag(c.api, body(input), session(), c.info)), JSON.stringify(input)).toMatchObject({
        status: 409,
        code: 'purpose_refused',
      })
      expect(pool.texts().some(text => text.startsWith('select public.set_feature_flag('))).toBe(false)
    }
  })

  it('PGT-11 C0.9 PD-19: never refuses turning off, narrowing an enabled flag whose purpose is refused, or keeping its audience, and reads no register then', async () => {
    for (const [before, input] of [
      // Turning off, from the whole org or from a cohort.
      [{ enabled: true }, { key: 'it.unnotified', enabled: false }],
      [
        { enabled: true, audience: 'cohort', cohort_people: [MEMBER] },
        { key: 'it.unnotified', enabled: false },
      ],
      // An off flag's audience changed while it stays off.
      [{}, { key: 'it.unnotified', enabled: false, audience: 'cohort', roles: ['dpo'] }],
      // Narrowing: the whole org to a cohort, and a cohort to part of it.
      [{ enabled: true }, { key: 'it.unnotified', enabled: true, audience: 'cohort', people: [MEMBER] }],
      [
        { enabled: true, audience: 'cohort', cohort_people: [MEMBER, ADMIN], cohort_roles: ['dpo', 'admin'] },
        { key: 'it.unnotified', enabled: true, audience: 'cohort', people: [ADMIN.toUpperCase()], roles: ['dpo'] },
      ],
      // The same audience again.
      [{ enabled: true }, { key: 'it.unnotified', enabled: true }],
      [
        { enabled: true, audience: 'cohort', cohort_people: [MEMBER], cohort_roles: ['dpo'] },
        { key: 'it.unnotified', enabled: true, audience: 'cohort', people: [MEMBER], roles: ['dpo'] },
      ],
    ] as const) {
      const pool = org({ before: before as Partial<FlagRow> })
      const c = context(pool)
      expect(await setFlag(c.api, body(input), session(), c.info), JSON.stringify([before, input])).toMatchObject({
        body: { key: 'it.unnotified', revision: 2 },
      })
      expect(registerReads(pool), JSON.stringify([before, input])).toEqual([])
    }
  })

  it('C0.9 PD-19: a change judged to reach nobody new rolls back with 409 try_again when another change committed between the row’s read and set_feature_flag()', async () => {
    // The row read says on for the whole org; meanwhile another admin turned it off (revision 2),
    // so this "same audience again" would turn it back on unchecked: set_feature_flag() returns 3.
    const pool = org({ before: { enabled: true }, revision: '3' })
    const c = context(pool)
    const thrown = await setFlag(c.api, body({ key: 'it.unnotified', enabled: true }), session(), c.info).catch(
      (e: unknown) => e,
    )
    expect(thrown).toMatchObject({ status: 409, code: 'try_again' })
    expect(pool.texts().at(-1)).toBe('rollback')
    expect(appended(pool.statements)).toEqual([])
    expect(c.published).toEqual([])
    // One that changed nothing, or only its own change: no conflict.
    const quiet = org({ before: { enabled: true }, revision: '2' })
    const d = context(quiet)
    expect(await setFlag(d.api, body({ key: 'it.unnotified', enabled: true }), session(), d.info)).toMatchObject({
      body: { revision: 2 },
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
