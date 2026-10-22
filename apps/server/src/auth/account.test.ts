// Re-authentication by a texted code and the transfer gate (C0.9 PD-15, TECH-SPEC T22 item 8;
// PDPA-10, D46): sendReauthCode() asks the provider's clearance in the transaction that decides the
// send, after the acting session and the person's number are read, and calls the provider only once
// that transaction has committed. The integration suite (sign-in.integration.test.ts XFR-I2) runs
// the same against Postgres.
import type { Redis } from 'ioredis'
import { describe, expect, it, vi } from 'vitest'
import type { Api } from '#src/api.ts'
import { reauthCodeRequest } from '#src/auth/account.ts'
import { Breaker } from '#src/auth/breaker.ts'
import { ATTACH, OPEN } from '#src/auth/codes.ts'
import { deriveKeys } from '#src/auth/crypto.ts'
import { ApiError } from '#src/auth/errors.ts'
import { SLIDING_WINDOW } from '#src/auth/limiter.ts'
import { relyingParty } from '#src/auth/passkeys.ts'
import { OTP } from '#src/auth/policy.ts'
import type { SessionIds } from '#src/auth/sessions.ts'
import { FakeVerify } from '#src/auth/sms/fake.ts'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'
import { AfterResponse, type ReqInfo } from '#src/http.ts'
import { staticFlags } from '#src/testing/flags.ts'
import { type Statement, scriptedPool } from '#src/testing/pool.ts'
import { CLEARING, NOTHING_CLEARED } from '#src/testing/transfers.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const PERSON = 'b0000000-0000-4000-8000-000000000001'
const DEVICE = 'b0000000-0000-4000-8000-0000000000d1'
const SESSION = 'b0000000-0000-4000-8000-0000000000e1'
const NUMBER = 'b0000000-0000-4000-8000-0000000000f1'
const E164 = '+6580000001'
const PREFIX = 'it:unit:'
const names = valkeyKeys(PREFIX)
const session: SessionIds = { orgId: ORG, userId: PERSON, deviceId: DEVICE, sessionId: SESSION }

// The org as a code-method session's request reads it: the acting session (issued under no PIN
// rule), the person with no role, and their one number.
function orgPool() {
  return scriptedPool(({ text }: Statement) => {
    if (text.includes('join devices d on')) return [{ fresh: false, pin_set: false, issued_under_pin_rule: false }]
    if (text.startsWith('select id, deactivated_at from people')) return [{ id: PERSON, deactivated_at: null }]
    if (text.startsWith('select "id", "e164" from "phone_numbers"')) return [{ id: NUMBER, e164: E164 }]
    return []
  })
}

// Valkey: every limit allows, the send lock is free, OPEN records the owner (and replaces no
// earlier code), ATTACH attaches.
function valkeyFake() {
  let owner: string | null = null
  const valkey = {
    set: async () => 'OK',
    get: async () => null,
    del: async () => 1,
    hget: async () => owner,
    evalsha: async (sha: string, _n: number, ...args: (string | number)[]) => {
      if (sha === SLIDING_WINDOW.sha) return [1, 0]
      if (sha === OPEN.sha) {
        owner = String(args[1])
        return ''
      }
      if (sha === ATTACH.sha) return 'attached'
      return 1
    },
  }
  return valkey as unknown as Redis
}

function context(sms: FakeVerify, transfers: Api['transfers'], pool = orgPool()) {
  const api: Api = {
    db: pool.db,
    valkey: valkeyFake(),
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
  return { api, info, pool }
}

// The details of the auth.code_requested row a scripted transaction wrote.
const requested = (pool: ReturnType<typeof scriptedPool>) =>
  pool.statements
    .filter(s => s.text.startsWith('insert into "audit_events"'))
    .map(s => s.values.find(value => typeof value === 'object' && value !== null))

describe('XFR-03 PDPA-10 C0.9 PD-15 re-authentication’s code and the transfer gate', () => {
  it('XFR-03 T22 item 8: sends a code-method re-authentication’s code through a provider while its entry is cleared, and nothing, 503, once it isn’t', async () => {
    const twilio = CLEARING('twilio')
    const sms = new FakeVerify({ transfer: 'twilio' })
    const cleared = context(sms, twilio)
    expect(await reauthCodeRequest(cleared.api, session, cleared.info)).toEqual({
      body: { status: 'code_sent', expiresInSeconds: OTP.ttlMs / 1000, codeLength: OTP.length },
    })
    expect(sms.sent.map(entry => entry.to)).toEqual([E164])
    expect(twilio.asked.map(ask => ask.provider)).toEqual(['twilio'])
    expect(requested(cleared.pool)).toEqual([{ during: 'reauth', send: 'attempted' }])

    for (const transfers of [NOTHING_CLEARED, CLEARING('aws')]) {
      const refusedSms = new FakeVerify({ transfer: 'twilio' })
      const refused = context(refusedSms, transfers)
      const error = await reauthCodeRequest(refused.api, session, refused.info).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ApiError)
      expect(error).toMatchObject({ status: 503, code: 'unavailable' })
      expect(refusedSms.sent).toEqual([])
      // The skip is audited and committed.
      expect(requested(refused.pool)).toEqual([{ during: 'reauth', send: 'skipped_not_cleared' }])
      expect(refused.pool.texts().at(-1)).toBe('commit')
      expect(vi.mocked(refused.info.log.error).mock.calls[0]?.[0]).toEqual({
        event: 'sms_provider_not_cleared',
        provider: 'fake',
        personId: PERSON,
      })
    }
  })

  it('XFR-03 T22 item 8: the clearance is asked in the transaction that decides the send, after the acting session and the number are read, and the provider only after it commits', async () => {
    const pool = orgPool()
    // The statements so far when the clearance is asked, and when the provider is asked to send.
    let asked: string[] = []
    let sending: string[] = []
    const sms = new FakeVerify({ transfer: 'twilio', onSend: () => (sending = pool.texts()) })
    const twilio = CLEARING('twilio')
    const transfers: Api['transfers'] = {
      cleared: async (trx, provider) => {
        asked = pool.texts()
        return twilio.cleared(trx, provider)
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
