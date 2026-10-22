import {
  ClearTransferBody,
  PurposeWriteResponse,
  RecordTransferBody,
  RegistersResponse,
  SetPurposeBody,
  TransferWriteResponse,
  WithdrawTransferBody,
} from '@hearth/shared'
import type { Redis } from 'ioredis'
import { describe, expect, it, vi } from 'vitest'
import type { Api } from '#src/api.ts'
import { Breaker } from '#src/auth/breaker.ts'
import { deriveKeys } from '#src/auth/crypto.ts'
import { ApiError } from '#src/auth/errors.ts'
import { relyingParty } from '#src/auth/passkeys.ts'
import { OTP } from '#src/auth/policy.ts'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'
import {
  clearTransfer,
  REGISTER_ERRORS,
  readRegisters,
  recordTransfer,
  setPurpose,
  withdrawTransfer,
} from '#src/compliance/routes.ts'
import { AfterResponse, parse, type ReqInfo } from '#src/http.ts'
import { staticFlags } from '#src/testing/flags.ts'
import { appended, pgError, type Statement, scriptedPool } from '#src/testing/pool.ts'
import { NOTHING_CLEARED } from '#src/testing/transfers.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const DPO = 'b0000000-0000-4000-8000-000000000005'
const OWNER = 'b0000000-0000-4000-8000-000000000001'
const DEVICE = 'd0000000-0000-4000-8000-000000000001'
const ENTRY = 'c0000000-0000-4000-8000-0000000000e1'
const session = (userId = DPO) => ({
  sessionId: 'e0000000-0000-4000-8000-000000000001',
  orgId: ORG,
  userId,
  deviceId: DEVICE,
})

// The org: an Owner who isn't the DPO, and the DPO, on a PIN-rule session re-authenticated in the
// last 5 minutes unless a test says. `call` answers the register function's statement: its row, or
// an error to raise.
function org(options: { fresh?: boolean; call?: unknown[] | Error } = {}) {
  return scriptedPool((statement: Statement) => {
    const { text } = statement
    if (text.includes('from people p join devices d')) {
      return [{ fresh: options.fresh ?? true, pin_set: true, issued_under_pin_rule: true }]
    }
    if (text.startsWith('select "id", "deactivated_at" from "people"')) {
      return [
        { id: OWNER, deactivated_at: null },
        { id: DPO, deactivated_at: null },
      ]
    }
    if (text.startsWith('select "person_id", "role"')) {
      return [
        { person_id: OWNER, role: 'owner', team_id: null, revoked_at: null },
        { person_id: DPO, role: 'dpo', team_id: null, revoked_at: null },
      ]
    }
    if (text.startsWith('select ((now() at time zone time_zone)::date)::text as today'))
      return [{ today: '2026-10-22' }]
    if (text.startsWith('select distinct on (r.purpose)')) return purposeRows
    if (text.startsWith('select t.provider')) return transferRows
    if (/^select entry, (version|revision), /.test(text)) return options.call ?? []
    return []
  })
}

// What the GET's two reads return, AI rows included as though the filter in SQL had let them
// through, so the code's own filter shows (C0.9 PD-27).
const purposeRows = [
  {
    purpose: 'org_brain',
    version: 1,
    status: 'planned',
    basis: null,
    basis_reference: null,
    opt_out_days: null,
    retention: null,
    providers: [],
    pinned: false,
    needs_switch: true,
    recorded_on: '2026-10-01',
    recorded_by: null,
  },
  {
    purpose: 'security_audit',
    version: 2,
    status: 'active',
    basis: 'legitimate_interests',
    basis_reference: 'LIA register, row 4',
    opt_out_days: null,
    retention: '1 year',
    providers: ['aws', 'openai'],
    pinned: false,
    needs_switch: false,
    recorded_on: '2026-10-20',
    recorded_by: 'Ashton Tan',
  },
  {
    purpose: 'accounts',
    version: 1,
    status: 'active',
    basis: null,
    basis_reference: null,
    opt_out_days: null,
    retention: null,
    providers: [],
    pinned: true,
    needs_switch: false,
    recorded_on: '2026-10-01',
    recorded_by: null,
  },
]
const facts = {
  services: null,
  data_types: null,
  processing_countries: [],
  storage_countries: [],
  countries_confirmed: null,
  safeguard: null,
  safeguard_reference: null,
  certificate_verified_on: null,
  dpa_terms_confirmed: false,
  training: null,
  zero_retention: null,
  provider_retention: null,
  retention_confirmed: null,
  onward_recipients: null,
  review_on: null,
}
const noClearance = {
  cleared_on: null,
  cleared_by: null,
  cleared_via: null,
  cleared_revision: null,
  withdrawn_on: null,
  withdrawn_by: null,
  withdraw_reason: null,
}
const transferRows = [
  { provider: 'openai', revision: '1', ...facts, updated_on: '2026-10-01', updated_by: null, ...noClearance },
  {
    provider: 'twilio',
    revision: '2',
    ...facts,
    services: 'Verify',
    processing_countries: ['US'],
    review_on: '2027-10-01',
    updated_on: '2026-10-02',
    updated_by: null,
    cleared_on: '2026-10-02',
    cleared_by: 'Ashton Tan',
    cleared_via: 'bootstrap',
    cleared_revision: '2',
    withdrawn_on: null,
    withdrawn_by: null,
    withdraw_reason: null,
  },
  { provider: 'aws', revision: '1', ...facts, updated_on: '2026-10-01', updated_by: null, ...noClearance },
]

function context(pool: ReturnType<typeof scriptedPool>) {
  const api: Api = {
    db: pool.db,
    valkey: { publish: vi.fn() } as unknown as Redis,
    keys: deriveKeys('unit-test-unit-test-unit-test-unit-test'),
    sms: undefined,
    keyPrefix: 'it:unit:',
    flags: staticFlags(),
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
  return { api, info }
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!(error instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(error)}`)
  return error
}

const purposeBody = (input: Record<string, unknown> = {}) =>
  parse(SetPurposeBody, {
    purpose: 'security_audit',
    seen: 1,
    status: 'active',
    basis: 'legitimate_interests',
    basisReference: ' LIA register, row 4 ',
    optOutDays: null,
    retention: '1 year',
    providers: ['twilio', 'aws', 'aws'],
    ...input,
  })

const transferBody = (input: Record<string, unknown> = {}) =>
  parse(RecordTransferBody, {
    provider: 'apple_push',
    seen: 1,
    services: 'Push to Safari',
    dataTypes: 'A device token',
    processingCountries: ['us', 'IE', 'US'],
    storageCountries: ['US'],
    countriesConfirmed: 'DPA annex 2, 1 Oct 2026',
    safeguard: 'dpa',
    safeguardReference: 'Apple DPA',
    certificateVerifiedOn: null,
    dpaTermsConfirmed: true,
    training: 'not_applicable',
    zeroRetention: 'not_applicable',
    providerRetention: 'Until delivered',
    retentionConfirmed: 'DPA annex 3, 1 Oct 2026',
    onwardRecipients: '',
    reviewOn: '2027-10-01',
    keepCleared: false,
    ...input,
  })

// The register function's statement, as the route sent it.
const callOf = (pool: ReturnType<typeof scriptedPool>, name: string) =>
  pool.statements.find(statement => statement.text.includes(`from public.${name}(`))

describe('RGS-17 C0.9 PD-20 PD-21 the registers’ bodies', () => {
  it('reads each body strictly, giving typed text trimmed and blank as null, and countries upper case once each', () => {
    expect(purposeBody()).toMatchObject({ basisReference: 'LIA register, row 4', providers: ['twilio', 'aws', 'aws'] })
    expect(transferBody()).toMatchObject({ processingCountries: ['IE', 'US'], onwardRecipients: null })
    for (const [schema, input] of [
      [SetPurposeBody, { ...purposeBody(), extra: 1 }],
      [SetPurposeBody, { ...purposeBody(), purpose: 'unknown' }],
      [RecordTransferBody, { ...transferBody(), processingCountries: ['USA'] }],
      [RecordTransferBody, { ...transferBody(), reviewOn: '1 Oct 2027' }],
      [ClearTransferBody, { provider: 'twilio' }],
      [ClearTransferBody, { provider: 'twilio', seen: 0 }],
      [WithdrawTransferBody, { provider: 'twilio', seen: 1 }],
    ] as const) {
      expect(() => parse(schema, input), JSON.stringify(input)).toThrow(ApiError)
    }
  })
})

describe('RGS-17 C0.9 PD-20 PD-27 GET /api/admin/registers', () => {
  it('lets the DPO read both registers in a read-only transaction, today in the org’s zone, and never an AI row', async () => {
    const pool = org()
    const c = context(pool)
    const { body } = await readRegisters(c.api, session(), c.info)
    // The strict answer, which refuses an AI purpose or provider.
    const answer = RegistersResponse.parse(body)
    expect(answer.today).toBe('2026-10-22')
    // In PURPOSES and PROVIDERS order, AI rows left out, and an AI provider left off a purpose.
    expect(answer.purposes.map(row => row.purpose)).toEqual(['accounts', 'security_audit'])
    expect(answer.purposes[1]).toEqual({
      purpose: 'security_audit',
      version: 2,
      status: 'active',
      basis: 'legitimate_interests',
      basisReference: 'LIA register, row 4',
      optOutDays: null,
      retention: '1 year',
      providers: ['aws'],
      pinned: false,
      needsSwitch: false,
      recordedOn: '2026-10-20',
      recordedBy: 'Ashton Tan',
    })
    expect(answer.transfers.map(row => row.provider)).toEqual(['aws', 'twilio'])
    expect(answer.transfers[0]?.clearance).toBeNull()
    expect(answer.transfers[1]).toMatchObject({
      revision: 2,
      services: 'Verify',
      reviewOn: '2027-10-01',
      clearance: {
        clearedOn: '2026-10-02',
        clearedBy: 'Ashton Tan',
        clearedVia: 'bootstrap',
        revision: 2,
        withdrawnOn: null,
        withdrawReason: null,
      },
    })
    const texts = pool.texts()
    expect(texts[0]).toBe('start transaction isolation level read committed read only')
    // can() first, then the reads, which filter AI rows in SQL too and lock nothing.
    const roles = texts.findIndex(text => text.startsWith('select "person_id", "role"'))
    const reads = texts.filter(text => /\bfrom (processing_register|transfer_register)\b/.test(text))
    expect(roles).toBeLessThan(texts.findIndex(text => text.startsWith('select distinct on (r.purpose)')))
    expect(reads).toHaveLength(2)
    for (const text of reads) expect(text).toMatch(/ and not [rt]\.ai\b/)
    expect(texts.join(' ')).not.toMatch(/\bfor (share|update|no key update)\b|processing_restrictions/)
  })

  it('refuses everyone but the DPO, and a DPO whose PIN is more than 5 minutes old, before reading a register', async () => {
    for (const [who, fresh, status, code] of [
      [OWNER, true, 403, 'forbidden'],
      [DPO, false, 403, 'reauth_required'],
    ] as const) {
      const pool = org({ fresh })
      const c = context(pool)
      expect(await refusal(readRegisters(c.api, session(who), c.info)), who).toMatchObject({ status, code })
      expect(pool.texts().some(text => /processing_register|transfer_register/.test(text))).toBe(false)
    }
    // A DPO's PIN-rule session re-authenticates with the PIN (D46, C0.9 PD-30).
    const stale = context(org({ fresh: false }))
    expect(await refusal(readRegisters(stale.api, session(), stale.info))).toMatchObject({ extra: { method: 'pin' } })
  })
})

describe('RGS-17 C0.9 PD-21 PD-22 PD-25 POST /api/admin/registers/purposes/set', () => {
  it('records the next version through set_register_purpose() and appends register.purpose_changed naming the new version', async () => {
    const pool = org({ call: [{ entry: ENTRY, version: 2, changed: true }] })
    const c = context(pool)
    const { body } = await setPurpose(c.api, purposeBody(), session(), c.info)
    expect(PurposeWriteResponse.parse(body)).toEqual({ entry: ENTRY, version: 2, changed: true })
    const call = callOf(pool, 'set_register_purpose')
    expect(call?.text).toBe(
      'select entry, version, changed from public.set_register_purpose($1, $2::integer, $3, $4, $5, $6::integer, $7, $8::text[], $9, $10::uuid, $11::inet)',
    )
    expect(call?.values).toEqual([
      'security_audit',
      1,
      'active',
      'legitimate_interests',
      'LIA register, row 4',
      null,
      '1 year',
      ['twilio', 'aws', 'aws'],
      c.info.requestId,
      DEVICE,
      c.info.ip,
    ])
    expect(appended(pool.statements)).toEqual([
      {
        type: 'register.purpose_changed',
        entity: ENTRY,
        subjects: [],
        ids: { purpose: 'security_audit', status: 'active' },
        actor: undefined,
      },
    ])
    expect(pool.texts().at(-1)).toBe('commit')
  })

  it('appends nothing when the save changed nothing', async () => {
    const pool = org({ call: [{ entry: ENTRY, version: 1, changed: false }] })
    const c = context(pool)
    expect((await setPurpose(c.api, purposeBody(), session(), c.info)).body).toEqual({
      entry: ENTRY,
      version: 1,
      changed: false,
    })
    expect(appended(pool.statements)).toEqual([])
  })

  it('answers 400 register_invalid for what the shared rules refuse, after can() and before the database is asked', async () => {
    for (const input of [
      // C0.9 PD-07: a pinned purpose stays active, never on consent.
      { purpose: 'accounts', status: 'retired', basis: 'employment', basisReference: null },
      { purpose: 'accounts', basis: 'deemed_consent_conduct', basisReference: null },
      // PD-11: no consent-type basis, deemed consent by conduct included, for a purpose that needs a switch.
      { purpose: 'recording_meetings', basis: 'deemed_consent_conduct', basisReference: null },
      // The attachments, the window's range, and an AI provider.
      { basisReference: null },
      { basis: 'employment' },
      { basis: 'deemed_consent_notification', optOutDays: 400 },
      { providers: ['openai'] },
      { status: 'active', retention: '' },
    ]) {
      const pool = org({ call: [{ entry: ENTRY, version: 2, changed: true }] })
      const c = context(pool)
      expect(
        await refusal(setPurpose(c.api, purposeBody(input), session(), c.info)),
        JSON.stringify(input),
      ).toMatchObject({ status: 400, code: 'register_invalid' })
      expect(pool.texts().some(text => text.startsWith('select "person_id", "role"'))).toBe(true)
      expect(callOf(pool, 'set_register_purpose')).toBeUndefined()
      expect(pool.texts().at(-1)).toBe('rollback')
    }
  })

  it('refuses an AI purpose, someone who isn’t the DPO and a stale re-authentication through can(), before the database is asked', async () => {
    for (const [who, input, fresh, code] of [
      [
        DPO,
        { purpose: 'org_brain', status: 'planned', basis: null, basisReference: null, retention: null },
        true,
        'forbidden',
      ],
      [OWNER, {}, true, 'forbidden'],
      [DPO, {}, false, 'reauth_required'],
    ] as const) {
      const pool = org({ fresh })
      const c = context(pool)
      expect(await refusal(setPurpose(c.api, purposeBody(input), session(who), c.info))).toMatchObject({
        status: 403,
        code,
      })
      expect(callOf(pool, 'set_register_purpose')).toBeUndefined()
    }
  })

  it('PD-25: answers the function’s refusals: HF005 409 register_changed, HF006 and a register table’s check 400 register_invalid, 22023 404, 42501 403', async () => {
    for (const [sqlstate, status, code, constraint] of [
      ['HF005', 409, 'register_changed', undefined],
      ['HF006', 400, 'register_invalid', undefined],
      ['23514', 400, 'register_invalid', 'transfer_register_certificate'],
      ['23514', 400, 'register_invalid', 'processing_register_retention_check'],
      ['23514', 400, 'register_invalid', 'transfer_clearances_withdrawn'],
      ['22023', 404, 'not_found', undefined],
      ['42501', 403, 'forbidden', undefined],
    ] as const) {
      const pool = org({ call: pgError(sqlstate, constraint) })
      const c = context(pool)
      expect(await refusal(setPurpose(c.api, purposeBody(), session(), c.info)), sqlstate).toMatchObject({
        status,
        code,
      })
      expect(appended(pool.statements)).toEqual([])
      expect(pool.texts().at(-1)).toBe('rollback')
    }
    // Every code only these routes answer is one of them.
    expect([...REGISTER_ERRORS]).toEqual(['register_changed', 'register_invalid'])
  })

  it('leaves a conflict to the api’s 409 try_again, and anything else unanswered: a check of another table the function writes, or one with no constraint named, is a fault (500, logged)', async () => {
    for (const [sqlstate, constraint] of [
      ['40P01', undefined],
      ['23514', 'audit_events_reason_check'],
      ['23514', 'outbox_events_type'],
      ['23514', 'processing_restrictions_lifted'],
      ['23514', undefined],
    ] as const) {
      const pool = org({ call: pgError(sqlstate, constraint) })
      const c = context(pool)
      const error = await setPurpose(c.api, purposeBody(), session(), c.info).then(
        () => undefined,
        (e: unknown) => e,
      )
      expect(error, `${sqlstate} ${constraint}`).not.toBeInstanceOf(ApiError)
      expect(error).toMatchObject({ code: sqlstate, constraint })
      expect(pool.texts().at(-1)).toBe('rollback')
    }
  })
})

describe('RGS-17 C0.9 PD-05 PD-21 PD-22 POST /api/admin/registers/transfers/*', () => {
  it('records the facts through record_transfer_entry() and appends register.transfer_changed naming the entry', async () => {
    const pool = org({ call: [{ entry: ENTRY, revision: '2', cleared: false, changed: true }] })
    const c = context(pool)
    const { body } = await recordTransfer(c.api, transferBody({ keepCleared: true }), session(), c.info)
    expect(TransferWriteResponse.parse(body)).toEqual({ entry: ENTRY, revision: 2, cleared: false, changed: true })
    const call = callOf(pool, 'record_transfer_entry')
    expect(call?.text).toBe(
      'select entry, revision, cleared, changed from public.record_transfer_entry($1, $2::bigint, $3, $4, $5::text[], $6::text[], $7, $8, $9, $10::date, $11::boolean, $12, $13, $14, $15, $16, $17::date, $18::boolean, $19, $20::uuid, $21::inet)',
    )
    expect(call?.values).toEqual([
      'apple_push',
      1,
      'Push to Safari',
      'A device token',
      ['IE', 'US'],
      ['US'],
      'DPA annex 2, 1 Oct 2026',
      'dpa',
      'Apple DPA',
      null,
      true,
      'not_applicable',
      'not_applicable',
      'Until delivered',
      'DPA annex 3, 1 Oct 2026',
      null,
      '2027-10-01',
      true,
      c.info.requestId,
      DEVICE,
      c.info.ip,
    ])
    expect(appended(pool.statements)).toEqual([
      {
        type: 'register.transfer_changed',
        entity: ENTRY,
        subjects: [],
        ids: { provider: 'apple_push', cleared: false },
        actor: undefined,
      },
    ])
  })

  it('refuses a certification with no verification date before the database (400 register_invalid)', async () => {
    const pool = org({ call: [{ entry: ENTRY, revision: '2', cleared: false, changed: true }] })
    const c = context(pool)
    expect(
      await refusal(recordTransfer(c.api, transferBody({ safeguard: 'certification' }), session(), c.info)),
    ).toMatchObject({ status: 400, code: 'register_invalid' })
    expect(callOf(pool, 'record_transfer_entry')).toBeUndefined()
  })

  it('clears and withdraws through their functions, each appending its event only when something changed', async () => {
    for (const [name, run, op, changed, cleared] of [
      ['clear_transfer_entry', clearTransfer, { provider: 'twilio', seen: 2 }, true, true],
      ['clear_transfer_entry', clearTransfer, { provider: 'twilio', seen: 2 }, false, true],
      ['withdraw_transfer_clearance', withdrawTransfer, { provider: 'twilio' }, true, false],
      ['withdraw_transfer_clearance', withdrawTransfer, { provider: 'twilio' }, false, false],
    ] as const) {
      const pool = org({ call: [{ entry: ENTRY, revision: '2', cleared, changed }] })
      const c = context(pool)
      const body = 'seen' in op ? parse(ClearTransferBody, op) : parse(WithdrawTransferBody, op)
      const answer = await (run as typeof clearTransfer)(c.api, body as never, session(), c.info)
      expect(answer.body).toEqual({ entry: ENTRY, revision: 2, cleared, changed })
      const call = callOf(pool, name)
      expect(call?.values).toEqual(['twilio', ...('seen' in op ? [2] : []), c.info.requestId, DEVICE, c.info.ip])
      expect(appended(pool.statements)).toEqual(
        changed
          ? [
              {
                type: 'register.transfer_changed',
                entity: ENTRY,
                subjects: [],
                ids: { provider: 'twilio', cleared },
                actor: undefined,
              },
            ]
          : [],
      )
    }
  })

  it('refuses an AI provider and someone who isn’t the DPO through can(), and answers the functions’ refusals', async () => {
    for (const [who, provider] of [
      [DPO, 'openai'],
      [OWNER, 'twilio'],
    ] as const) {
      const pool = org({ call: [{ entry: ENTRY, revision: '2', cleared: true, changed: true }] })
      const c = context(pool)
      expect(
        await refusal(clearTransfer(c.api, parse(ClearTransferBody, { provider, seen: 1 }), session(who), c.info)),
      ).toMatchObject({ status: 403, code: 'forbidden' })
      expect(
        await refusal(withdrawTransfer(c.api, parse(WithdrawTransferBody, { provider }), session(who), c.info)),
      ).toMatchObject({ status: 403, code: 'forbidden' })
      expect(await refusal(recordTransfer(c.api, transferBody({ provider }), session(who), c.info))).toMatchObject({
        status: 403,
        code: 'forbidden',
      })
      expect(pool.texts().some(text => text.includes('from public.'))).toBe(false)
    }
    for (const [sqlstate, status, code] of [
      ['HF005', 409, 'register_changed'],
      ['HF006', 400, 'register_invalid'],
    ] as const) {
      const pool = org({ call: pgError(sqlstate) })
      const c = context(pool)
      expect(
        await refusal(
          clearTransfer(c.api, parse(ClearTransferBody, { provider: 'twilio', seen: 1 }), session(), c.info),
        ),
      ).toMatchObject({ status, code })
      expect(appended(pool.statements)).toEqual([])
    }
  })
})
