// Re-authentication by a texted code and the transfer gate (C0.9 PD-15, PD-59, TECH-SPEC T22 item 8;
// PDPA-10, D46): sendReauthCode() asks the provider's send state in the transaction that decides the
// send, after the acting session and the person's number are read, and calls the provider only once
// that transaction has committed; the person's day counts only a request the gate and the SMS cap
// let through (B-15); and the acknowledgement gate refuses an unacknowledged session before
// anything but the per-session window is counted, giving a code check's day back (C0.9 PD-43,
// NTS-01). The integration suite (sign-in.integration.test.ts XFR-I2) runs
// the same against Postgres.
import type { NoticeStanding } from '@hearth/shared'
import type { Redis } from 'ioredis'
import { describe, expect, it, vi } from 'vitest'
import type { Api } from '#src/api.ts'
import { reauthCodeRequest, reauthCodeVerify } from '#src/auth/account.ts'
import { Breaker } from '#src/auth/breaker.ts'
import { ATTACH, OPEN } from '#src/auth/codes.ts'
import { deriveKeys } from '#src/auth/crypto.ts'
import { ApiError } from '#src/auth/errors.ts'
import { SLIDING_WINDOW } from '#src/auth/limiter.ts'
import { relyingParty } from '#src/auth/passkeys.ts'
import { LIMITS, OTP } from '#src/auth/policy.ts'
import type { SessionIds } from '#src/auth/sessions.ts'
import { FakeVerify } from '#src/auth/sms/fake.ts'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'
import { SEND_STATES } from '#src/compliance/transfers.ts'
import { AfterResponse, type ReqInfo } from '#src/http.ts'
import { staticFlags } from '#src/testing/flags.ts'
import { type Statement, scriptedPool, standingsOf } from '#src/testing/pool.ts'
import { CLEARING, NOTHING_CLEARED, STATE } from '#src/testing/transfers.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const PERSON = 'b0000000-0000-4000-8000-000000000001'
const DEVICE = 'b0000000-0000-4000-8000-0000000000d1'
const SESSION = 'b0000000-0000-4000-8000-0000000000e1'
const NUMBER = 'b0000000-0000-4000-8000-0000000000f1'
const E164 = '+6580000001'
const PREFIX = 'it:unit:'
const names = valkeyKeys(PREFIX)
const session: SessionIds = { orgId: ORG, userId: PERSON, deviceId: DEVICE, sessionId: SESSION }
const PERSON_DAY = names.limit(LIMITS.reauthCodePerPerson.name, PERSON)
const SMS_CAP = names.limit(LIMITS.smsGlobal.name, 'all')
const CHECK_DAY = names.limit(LIMITS.reauthCheckPerPerson.name, PERSON)

// The org as a code-method session's request reads it: the acting session (issued under no PIN
// rule), the person with the roles given (none unless given), their one number, and their standing
// with the notice (acknowledged unless given, the scripted pool's default).
function orgPool(options: { roles?: string[]; standing?: NoticeStanding } = {}) {
  return scriptedPool(({ text, values }: Statement) => {
    if (text.includes('join devices d on')) return [{ fresh: false, pin_set: false, issued_under_pin_rule: false }]
    if (text.startsWith('select id, deactivated_at from people')) return [{ id: PERSON, deactivated_at: null }]
    if (text.startsWith('select person_id, role, team_id, revoked_at from role_assignments')) {
      return (options.roles ?? []).map(role => ({ person_id: PERSON, role, team_id: null, revoked_at: null }))
    }
    if (options.standing !== undefined && text.startsWith('select x.person,')) {
      return standingsOf(values.find(Array.isArray) as string[], options.standing)
    }
    if (text.startsWith('select "id", "e164" from "phone_numbers"')) return [{ id: NUMBER, e164: E164 }]
    return []
  })
}

// Valkey: every limit allows unless its key is in `full`, the send lock is free, OPEN records the
// owner (and replaces no earlier code), ATTACH attaches. Each sliding-window hit is kept (its keys
// and member), and each hit given back.
function valkeyFake(full: string[] = []) {
  let owner: string | null = null
  const hits: { keys: string[]; member: string }[] = []
  const givenBack: { key: string; member: string }[] = []
  const valkey = {
    set: async () => 'OK',
    get: async () => null,
    del: async () => 1,
    hget: async () => owner,
    zrem: async (key: string, member: string) => {
      givenBack.push({ key, member })
      return 1
    },
    evalsha: async (sha: string, n: number, ...args: (string | number)[]) => {
      if (sha === SLIDING_WINDOW.sha) {
        const keys = args.slice(0, n).map(String)
        if (keys.some(key => full.includes(key))) return [0, 60_000]
        hits.push({ keys, member: String(args.at(-1)) })
        return [1, 0]
      }
      if (sha === OPEN.sha) {
        owner = String(args[1])
        return ''
      }
      if (sha === ATTACH.sha) return 'attached'
      return 1
    },
  }
  return { valkey: valkey as unknown as Redis, hits, givenBack }
}

function context(sms: FakeVerify, transfers: Api['transfers'], pool = orgPool(), valkey = valkeyFake()) {
  const api: Api = {
    db: pool.db,
    valkey: valkey.valkey,
    keys: deriveKeys('unit-test-unit-test-unit-test-unit-test'),
    sms,
    keyPrefix: PREFIX,
    flags: staticFlags(),
    afterResponse: new AfterResponse(),
    appOrigin: 'https://hearth.example.com',
    names,
    rp: relyingParty('https://hearth.example.com'),
    otp: { verifyFloorMs: 0, breaker: new Breaker(OTP.breaker) },
    passkeys: false,
    transfers,
  }
  const info: ReqInfo = {
    ip: '198.51.100.7',
    requestId: 'f0000000-0000-4000-8000-000000000001',
    userAgent: undefined,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ReqInfo['log'],
    after: () => {},
  }
  return { api, info, pool, valkey }
}

// The details of the auth.code_requested row a scripted transaction wrote.
const requested = (pool: ReturnType<typeof scriptedPool>) =>
  pool.statements
    .filter(s => s.text.startsWith('insert into "audit_events"'))
    .map(s => s.values.find(value => typeof value === 'object' && value !== null))

// The hits a request spent of the person's day (AQ-09).
const dayHits = (valkey: ReturnType<typeof valkeyFake>) => valkey.hits.filter(hit => hit.keys.includes(PERSON_DAY))

const refusalOf = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  )

describe('XFR-03 PDPA-10 C0.9 PD-15 PD-59 re-authentication’s code and the transfer gate', () => {
  it('XFR-03 T22 item 8: sends a code-method re-authentication’s code while the notice states the clearance, and nothing, 503, otherwise, auditing each skip', async () => {
    const twilio = CLEARING('twilio')
    const sms = new FakeVerify({ transfer: 'twilio' })
    const cleared = context(sms, twilio)
    expect(await reauthCodeRequest(cleared.api, session, cleared.info)).toEqual({
      body: { status: 'code_sent', expiresInSeconds: OTP.ttlMs / 1000, codeLength: OTP.length },
    })
    expect(sms.sent.map(entry => entry.to)).toEqual([E164])
    expect(twilio.asked.map(ask => ask.provider)).toEqual(['twilio'])
    expect(requested(cleared.pool)).toEqual([{ during: 'reauth', send: 'attempted' }])

    for (const [transfers, send, level, event] of [
      [NOTHING_CLEARED, 'skipped_not_cleared', 'error', 'sms_provider_not_cleared'],
      [CLEARING('aws'), 'skipped_not_cleared', 'error', 'sms_provider_not_cleared'],
      // PD-59: before any version, and once the notice no longer states the clearance, only a holder
      // of dpo gets a code, and a code-method session never holds it (dpo is a PIN role).
      [STATE('twilio', 'no_notice'), 'skipped_no_notice', 'info', 'sms_provider_no_notice'],
      [STATE('twilio', 'unstated'), 'skipped_unstated', 'error', 'sms_provider_unstated'],
    ] as const) {
      const refusedSms = new FakeVerify({ transfer: 'twilio' })
      const refused = context(refusedSms, transfers)
      const error = await refusalOf(reauthCodeRequest(refused.api, session, refused.info))
      expect(error, send).toBeInstanceOf(ApiError)
      expect(error, send).toMatchObject({ status: 503, code: 'unavailable' })
      expect(refusedSms.sent).toEqual([])
      // The skip is audited and committed.
      expect(requested(refused.pool), send).toEqual([{ during: 'reauth', send }])
      expect(refused.pool.texts().at(-1)).toBe('commit')
      expect(vi.mocked(refused.info.log[level]).mock.calls[0]?.[0], send).toEqual({
        event,
        provider: 'fake',
        personId: PERSON,
      })
    }
  })

  it('XFR-03 C0.9 PD-59: a holder of dpo never re-authenticates by code, so the send state is never asked for one (409 reauth_method)', async () => {
    for (const state of SEND_STATES) {
      const transfers = STATE('twilio', state)
      const sms = new FakeVerify({ transfer: 'twilio' })
      const { api, info, pool } = context(sms, transfers, orgPool({ roles: ['dpo'] }))
      expect(await refusalOf(reauthCodeRequest(api, session, info)), state).toMatchObject({
        status: 409,
        code: 'reauth_method',
        extra: { method: 'sign_in' },
      })
      expect(transfers.asked).toEqual([])
      expect(sms.sent).toEqual([])
      expect(requested(pool)).toEqual([])
    }
  })

  it('XFR-03 T22 item 8: the send state is asked in the transaction that decides the send, after the acting session and the number are read, and the provider only after it commits', async () => {
    const pool = orgPool()
    // The statements so far when the state is asked, and when the provider is asked to send.
    let asked: string[] = []
    let sending: string[] = []
    const sms = new FakeVerify({ transfer: 'twilio', onSend: () => (sending = pool.texts()) })
    const twilio = CLEARING('twilio')
    const transfers: Api['transfers'] = {
      ...twilio,
      state: async (trx, provider) => {
        asked = pool.texts()
        return twilio.state(trx, provider)
      },
    }
    const { api, info } = context(sms, transfers, pool)
    expect((await reauthCodeRequest(api, session, info)).body).toMatchObject({ status: 'code_sent' })
    // Inside the send's transaction, after the acting session (FOR SHARE) and the number are read.
    const begun = asked.lastIndexOf('start transaction isolation level read committed')
    expect(begun).toBeGreaterThan(-1)
    expect(asked.lastIndexOf('commit')).toBeLessThan(begun)
    expect(
      asked.findLastIndex(text => text.includes('join devices d on') && text.endsWith('for share of p, d, s')),
    ).toBeGreaterThan(begun)
    expect(asked.findLastIndex(text => text.startsWith('select "id", "e164" from "phone_numbers"'))).toBeGreaterThan(
      begun,
    )
    // That transaction commits before the provider is asked.
    expect(sending.slice(asked.length)).toContain('commit')
    expect(twilio.asked.map(ask => ask.provider)).toEqual(['twilio'])
    expect(sms.sent.map(entry => entry.to)).toEqual([E164])
  })
})

describe('B-15 AQ-09 the person’s day counts only a code request the transfer gate and the SMS cap let through', () => {
  it('B-15: a request held back by the transfer state or the SMS cap leaves the person’s day unspent', async () => {
    for (const [what, transfers, full] of [
      ['not_cleared', NOTHING_CLEARED, []],
      ['no_notice', STATE('twilio', 'no_notice'), []],
      ['unstated', STATE('twilio', 'unstated'), []],
      ['capped', CLEARING('twilio'), [SMS_CAP]],
    ] as const) {
      const valkey = valkeyFake([...full])
      const sms = new FakeVerify({ transfer: 'twilio' })
      const { api, info } = context(sms, transfers, orgPool(), valkey)
      expect(await refusalOf(reauthCodeRequest(api, session, info)), what).toMatchObject({ status: 503 })
      expect(dayHits(valkey), what).toEqual([])
      expect(sms.sent).toEqual([])
    }
  })

  it('B-15: a request that goes spends the day after the cap; a full day answers 429, sends nothing and gives the cap’s hit back', async () => {
    const valkey = valkeyFake()
    const { api, info } = context(new FakeVerify({ transfer: 'twilio' }), CLEARING('twilio'), orgPool(), valkey)
    await reauthCodeRequest(api, session, info)
    const order = valkey.hits.map(hit => hit.keys)
    expect(order.findIndex(keys => keys.includes(SMS_CAP))).toBeLessThan(
      order.findIndex(keys => keys.includes(PERSON_DAY)),
    )
    expect(dayHits(valkey)).toHaveLength(1)

    const full = valkeyFake([PERSON_DAY])
    const sms = new FakeVerify({ transfer: 'twilio' })
    const busy = context(sms, CLEARING('twilio'), orgPool(), full)
    expect(await refusalOf(reauthCodeRequest(busy.api, session, busy.info))).toMatchObject({
      status: 429,
      code: 'too_many_requests',
    })
    expect(sms.sent).toEqual([])
    const capHit = full.hits.find(hit => hit.keys.includes(SMS_CAP))
    expect(full.givenBack).toEqual([{ key: SMS_CAP, member: capHit?.member }])
    // Nothing was written: the 429 rolled the transaction back.
    expect(busy.pool.texts().at(-1)).toBe('rollback')
  })
})

describe('NTS-01 C0.9 PD-43 PD-44 re-authentication and the acknowledgement gate (PDPA-03)', () => {
  it('NTS-01: refuses an unacknowledged code-method session 403 notice_required once the per-session window has counted it, before anything else is counted, asked or sent', async () => {
    for (const standing of ['required', 'unpublished'] as const) {
      const valkey = valkeyFake()
      const transfers = CLEARING('twilio')
      const sms = new FakeVerify({ transfer: 'twilio' })
      const { api, info, pool } = context(sms, transfers, orgPool({ standing }), valkey)
      expect(await refusalOf(reauthCodeRequest(api, session, info)), standing).toMatchObject({
        status: 403,
        code: 'notice_required',
      })
      expect(transfers.asked).toEqual([])
      expect(sms.sent).toEqual([])
      expect(requested(pool)).toEqual([])
      expect(dayHits(valkey)).toEqual([])
      // Read after the acting session and the person's roles, before the number.
      const texts = pool.texts()
      const read = texts.findIndex(text => text.startsWith('select x.person,'))
      expect(read).toBeGreaterThan(texts.findIndex(text => text.includes('join devices d on')))
      expect(texts.some(text => text.startsWith('select "id", "e164" from "phone_numbers"'))).toBe(false)
    }
  })

  it('NTS-01 B-15: a code check the gate refuses gives the person’s day of checks back, and asks no provider', async () => {
    for (const standing of ['required', 'unpublished'] as const) {
      const valkey = valkeyFake()
      const sms = new FakeVerify({ transfer: 'twilio' })
      const check = vi.spyOn(sms, 'check')
      const { api, info } = context(sms, CLEARING('twilio'), orgPool({ standing }), valkey)
      expect(await refusalOf(reauthCodeVerify(api, { code: '000000' }, session, info)), standing).toMatchObject({
        status: 403,
        code: 'notice_required',
      })
      expect(check).not.toHaveBeenCalled()
      const spent = valkey.hits.find(hit => hit.keys.includes(CHECK_DAY))
      expect(spent).toBeDefined()
      expect(valkey.givenBack).toEqual([{ key: CHECK_DAY, member: spent?.member }])
    }
  })
})
