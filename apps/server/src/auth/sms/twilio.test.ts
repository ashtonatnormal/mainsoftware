import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SmsProviderError } from '#src/auth/sms/provider.ts'
import { createTwilioVerify, TWILIO_TIMEOUTS, TwilioVerify } from '#src/auth/sms/twilio.ts'
import { type FakeTwilio, startFakeTwilio } from '#src/testing/fake-twilio.ts'

// Fictional numbers from the seed's +65 8000 range.
const A = '+6580000001'
const B = '+6580000002'

let twilio: FakeTwilio

beforeEach(async () => {
  twilio = await startFakeTwilio()
})

afterEach(async () => {
  await twilio.close()
})

function verify(timeouts?: { startMs?: number; checkMs?: number; cancelMs?: number }): TwilioVerify {
  return new TwilioVerify({
    apiKeySid: twilio.apiKeySid,
    apiKeySecret: twilio.apiKeySecret,
    serviceSid: twilio.serviceSid,
    baseUrl: twilio.baseUrl,
    ...(timeouts === undefined ? {} : { timeouts }),
  })
}

async function refusal(promise: Promise<unknown>): Promise<SmsProviderError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(SmsProviderError)
  return error as SmsProviderError
}

// No error may carry the number, the code, Twilio's message or the key.
function expectClean(error: Error): void {
  const text = `${error.message} ${error.stack ?? ''} ${JSON.stringify(error)}`
  for (const secret of [A, B, twilio.apiKeySecret, 'Max send attempts', 'Authenticate', 'not found']) {
    expect(text).not.toContain(secret)
  }
}

describe('T7 T20 Twilio Verify adapter, against a loopback fake', () => {
  it('starts with To and Channel=sms as a Basic-authenticated form, and checks with VerificationSid and Code', async () => {
    const sms = verify()
    expect(sms.name).toBe('twilio')
    expect(sms.transfer).toBe('twilio')
    const started = await sms.start(A)
    expect(started).toEqual({ ref: expect.stringMatching(/^VE[0-9a-f]{32}$/), foreign: false })
    const code = twilio.sent[0]?.code ?? ''
    const wrong = code === '000000' ? '111111' : '000000'
    expect(await sms.check(started.ref, wrong)).toBe('wrong')
    expect(await sms.check(started.ref, code)).toBe('approved')
    // Approved is used up: 404 reads as gone.
    expect(await sms.check(started.ref, code)).toBe('gone')
    const [start, check] = twilio.requests
    expect(start).toMatchObject({
      op: 'start',
      method: 'POST',
      path: `/v2/Services/${twilio.serviceSid}/Verifications`,
      contentType: 'application/x-www-form-urlencoded',
      authorised: true,
    })
    // Exactly these fields: never a CustomCode, and nothing but the number and the Service SID
    // (in the path) reaches Twilio (AUTH-DESIGN §12 items 6 and 13).
    expect(start?.form).toEqual({ To: A, Channel: 'sms' })
    expect(check).toMatchObject({ op: 'check', authorised: true })
    expect(check?.form).toEqual({ VerificationSid: started.ref, Code: wrong })
    expect(twilio.requests.every(r => r.authorised)).toBe(true)
  })

  it('reads a second start for the same number as foreign, from send_code_attempts', async () => {
    const sms = verify()
    const first = await sms.start(A)
    expect(await sms.start(A)).toEqual({ ref: first.ref, foreign: true })
    const seeded = twilio.seed(B)
    expect(await sms.start(B)).toEqual({ ref: seeded, foreign: true })
  })

  it('reads a start reply without send_code_attempts, or with null, as not foreign (AUTH-DESIGN §3.1)', async () => {
    const sms = verify()
    const sid = `VE${'a'.repeat(32)}`
    twilio.script('start', { status: 201, body: { sid, status: 'pending' } })
    expect(await sms.start(A)).toEqual({ ref: sid, foreign: false })
    twilio.script('start', { status: 201, body: { sid, status: 'pending', send_code_attempts: null } })
    expect(await sms.start(A)).toEqual({ ref: sid, foreign: false })
  })

  it('counts no send for a first try answered 20429, so a verification it never started still reads as foreign (AUTH-DESIGN §3.1)', async () => {
    const sms = verify()
    const seeded = twilio.seed(B)
    twilio.script('start', { status: 429, body: { code: 20429, status: 429 } })
    expect(await sms.start(B)).toEqual({ ref: seeded, foreign: true })
    expect(twilio.requests.filter(r => r.op === 'start')).toHaveLength(2)
  })

  it('cancels with Status=canceled, and counts an unknown or finished verification as done', async () => {
    const sms = verify()
    const { ref } = await sms.start(A)
    await sms.cancel(ref)
    expect(twilio.requests.at(-1)).toMatchObject({
      op: 'cancel',
      path: `/v2/Services/${twilio.serviceSid}/Verifications/${ref}`,
    })
    expect(twilio.requests.at(-1)?.form).toEqual({ Status: 'canceled' })
    await sms.cancel(ref)
    expect(await sms.check(ref, twilio.sent[0]?.code ?? '')).toBe('gone')
    // A new start after a cancel makes a new verification.
    expect((await sms.start(A)).ref).not.toBe(ref)
  })

  it('maps a 6th check (60202) to gone, and a 6th send (60203) to send_limit', async () => {
    const sms = verify()
    const { ref } = await sms.start(A)
    const code = twilio.sent[0]?.code ?? ''
    const wrong = code === '000000' ? '111111' : '000000'
    for (let i = 0; i < 5; i++) expect(await sms.check(ref, wrong)).toBe('wrong')
    expect(await sms.check(ref, code)).toBe('gone')
    for (let i = 0; i < 4; i++) await sms.start(A)
    const error = await refusal(sms.start(A))
    expect([error.kind, error.providerCode, error.httpStatus]).toEqual(['send_limit', 60203, 429])
    expectClean(error)
  })

  it('maps every error code in the table, without Twilio message', async () => {
    const rows: [number, number, string][] = [
      [400, 60200, 'bug'],
      [429, 60212, 'send_limit'],
      [403, 60205, 'blocked'],
      [403, 60410, 'blocked'],
      [403, 60605, 'blocked'],
      [401, 20003, 'auth'],
      [400, 21211, 'invalid_number'],
      [400, 99999, 'bug'],
    ]
    const sms = verify()
    for (const [status, code, kind] of rows) {
      twilio.script('start', { status, body: { code, message: `about ${A}`, status } })
      const error = await refusal(sms.start(A))
      expect([error.kind, error.providerCode, error.httpStatus], String(code)).toEqual([kind, code, status])
      expectClean(error)
    }
  })

  it('refuses a wrong key as auth', async () => {
    const sms = new TwilioVerify({
      apiKeySid: twilio.apiKeySid,
      apiKeySecret: 'b'.repeat(32),
      serviceSid: twilio.serviceSid,
      baseUrl: twilio.baseUrl,
    })
    const error = await refusal(sms.start(A))
    expect([error.kind, error.providerCode]).toEqual(['auth', 20003])
  })

  it('retries a start once on a 5xx, 20429 or a dropped connection, and counts its own retry as not foreign', async () => {
    const sms = verify()
    twilio.script('start', { status: 503, body: { code: 20500, status: 503 } })
    expect((await sms.start(A)).foreign).toBe(false)
    twilio.script('start', { status: 429, body: { code: 20429, status: 429 } })
    expect((await sms.start(B)).foreign).toBe(false)
    const before = twilio.requests.length
    twilio.script('start', { drop: true })
    twilio.script('start', { status: 503, body: { code: 20500, status: 503 } })
    const error = await refusal(sms.start('+6580000003'))
    expect(error.kind).toBe('unavailable')
    expect(twilio.requests.length - before).toBe(2)
  })

  it('never retries a check: a lost reply is unavailable, after one request', async () => {
    const sms = verify({ checkMs: 300 })
    const { ref } = await sms.start(A)
    const before = twilio.requests.length
    twilio.script('check', { drop: true })
    expect((await refusal(sms.check(ref, '123456'))).kind).toBe('unavailable')
    twilio.script('check', { status: 200, body: { status: 'approved' }, delayMs: 1000 })
    expect((await refusal(sms.check(ref, '123456'))).kind).toBe('unavailable')
    twilio.script('check', { status: 500, body: { code: 20500 } })
    expect((await refusal(sms.check(ref, '123456'))).kind).toBe('unavailable')
    expect(twilio.requests.length - before).toBe(3)
  })

  it('reads a check answered 201 or 200 alike: approved only for status approved, else wrong (T7, T20)', async () => {
    const sms = verify()
    const { ref } = await sms.start(A)
    // Twilio's spec lists 201 first for CreateVerificationCheck, then 200.
    for (const http of [201, 200]) {
      twilio.script('check', { status: http, body: { sid: ref, status: 'approved', valid: true } })
      expect(await sms.check(ref, '123456'), `${http} approved`).toBe('approved')
      twilio.script('check', { status: http, body: { sid: ref, status: 'pending', valid: false } })
      expect(await sms.check(ref, '123456'), `${http} pending`).toBe('wrong')
    }
    // A 2xx is still parsed: one with no status is a bug, not an approval.
    twilio.script('check', { status: 201, body: { sid: ref } })
    expect((await refusal(sms.check(ref, '123456'))).kind).toBe('bug')
    // The fake answers its own checks with 201, as the spec's first response does.
    const code = twilio.sent[0]?.code ?? ''
    expect(await sms.check(ref, code)).toBe('approved')
  })

  it('treats any status but approved as wrong, and an unparseable reply as a bug', async () => {
    const sms = verify()
    const { ref } = await sms.start(A)
    for (const status of ['pending', 'canceled', 'max_attempts_reached', 'deleted', 'failed', 'expired']) {
      twilio.script('check', { status: 200, body: { status } })
      expect(await sms.check(ref, '123456'), status).toBe('wrong')
    }
    twilio.script('check', { status: 200, raw: 'not json' })
    expect((await refusal(sms.check(ref, '123456'))).kind).toBe('bug')
    twilio.script('start', { status: 201, body: { sid: 'XX1', status: 'pending', send_code_attempts: [] } })
    expect((await refusal(sms.start(A))).kind).toBe('bug')
  })

  it('refuses a reply over the size cap before parsing it, whether or not it declares its length', async () => {
    const sms = verify()
    const big = `{"pad":"${'x'.repeat(70 * 1024)}"}`
    twilio.script('start', { status: 201, raw: big })
    expect((await refusal(sms.start(A))).kind).toBe('bug')
    twilio.script('start', { status: 201, raw: big, length: true })
    expect((await refusal(sms.start(A))).kind).toBe('bug')
  })

  it('times out a start or check try at 4 s and a cancel at 3 s unless a test passes its own (AUTH-DESIGN §6.3)', () => {
    expect(TWILIO_TIMEOUTS).toEqual({ startMs: 4000, checkMs: 4000, cancelMs: 3000 })
  })

  it('times out each start try at its limit, retries once, then answers unavailable', async () => {
    const sms = verify({ startMs: 300 })
    const before = twilio.requests.length
    twilio.script('start', { status: 201, body: {}, delayMs: 1000 })
    twilio.script('start', { status: 201, body: {}, delayMs: 1000 })
    const error = await refusal(sms.start(A))
    expect([error.kind, error.providerCode, error.httpStatus]).toEqual(['unavailable', undefined, undefined])
    expect(twilio.requests.length - before).toBe(2)
    // A first try cut off by its timeout and a second that lands: the call's own two tries.
    twilio.script('start', { status: 201, body: {}, delayMs: 1000 })
    expect(await sms.start(B)).toEqual({ ref: expect.stringMatching(/^VE[0-9a-f]{32}$/), foreign: false })
  })

  it('times out a cancel at its limit without retrying it', async () => {
    const sms = verify({ cancelMs: 300 })
    const { ref } = await sms.start(A)
    const before = twilio.requests.length
    twilio.script('cancel', { status: 200, body: {}, delayMs: 1000 })
    expect((await refusal(sms.cancel(ref))).kind).toBe('unavailable')
    expect(twilio.requests.length - before).toBe(1)
  })

  it('never follows a redirect', async () => {
    const sms = verify()
    twilio.script('cancel', { redirect: `${twilio.baseUrl}/elsewhere` })
    expect((await refusal(sms.cancel('VE1'))).kind).toBe('unavailable')
    expect(twilio.requests.filter(r => r.path === '/elsewhere')).toEqual([])
  })

  it('takes only a loopback base URL besides its own', () => {
    for (const baseUrl of [
      'http://localhost:1234',
      'https://example.com',
      'http://127.0.0.1:1/x',
      'http://10.0.0.1:80',
    ]) {
      expect(() => new TwilioVerify({ apiKeySid: 'k', apiKeySecret: 's', serviceSid: 'v', baseUrl }), baseUrl).toThrow(
        /base URL/,
      )
    }
  })

  it('createTwilioVerify refuses this machine: DEPLOY_ENV anything but nonprod or prod, or any localhost APP_ORIGIN', () => {
    const keys = { apiKeySid: 'k', apiKeySecret: 's', serviceSid: 'v' }
    for (const [deployEnv, appOrigin] of [
      ['local', 'https://hearth.example'],
      ['test', 'https://hearth.example'],
      ['production', 'https://hearth.example'],
      ['', 'https://hearth.example'],
      ['nonprod', 'http://localhost:5173'],
      ['prod', 'http://127.0.0.1:3000'],
      // Localhost origins beyond the three common spellings (T20 item 10).
      ['nonprod', 'http://app.localhost:5173'],
      ['prod', 'http://localhost.:5173'],
      ['nonprod', 'http://127.0.0.2:5173'],
      ['prod', 'http://0.0.0.0:3000'],
      ['nonprod', 'http://[::ffff:7f00:1]:3000'],
    ] as const) {
      expect(() => createTwilioVerify({ ...keys, deployEnv, appOrigin }), `${deployEnv} ${appOrigin}`).toThrow(
        /never runs on this machine/,
      )
    }
    expect(createTwilioVerify({ ...keys, deployEnv: 'nonprod', appOrigin: 'https://hearth.example' })).toBeInstanceOf(
      TwilioVerify,
    )
  })
})
