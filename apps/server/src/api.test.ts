import { Writable } from 'node:stream'
import type { Redis } from 'ioredis'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { type ApiDeps, registerApi } from '#src/api.ts'
import { buildApp } from '#src/app.ts'
import { ATTACH, OPEN } from '#src/auth/codes.ts'
import { ATTEMPT_COOKIE } from '#src/auth/cookies.ts'
import { deriveKeys, keyName, tag } from '#src/auth/crypto.ts'
import { SLIDING_WINDOW } from '#src/auth/limiter.ts'
import { FakeVerify } from '#src/auth/sms/fake.ts'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'
import { createDatabase, type Database } from '#src/db/database.ts'
import { AfterResponse } from '#src/http.ts'
import { createLogger } from '#src/logger.ts'
import { staticFlags } from '#src/testing/flags.ts'
import { pgError, type Statement, scriptedPool } from '#src/testing/pool.ts'

const APP_ORIGIN = 'https://hearth.example.com'
const ORG = 'a0000000-0000-4000-8000-000000000001'
const PERSON = 'b0000000-0000-4000-8000-000000000001'
const DEVICE = 'b0000000-0000-4000-8000-0000000000d1'
const SESSION = 'b0000000-0000-4000-8000-0000000000e1'
const SYSTEM = 'c0000000-0000-4000-8000-000000000001'
const PHONE_NUMBER = 'b0000000-0000-4000-8000-0000000000f1'
// A well-formed token (43 base64url characters), made of one letter so no scanner takes it for a
// secret.
const TOKEN = 't'.repeat(43)
const KEYS = deriveKeys('unit-test-unit-test-unit-test-unit-test')
const NAMES = valkeyKeys('it:unit:')

// A database the test must never reach: its pool refuses every connection and counts them.
function unreachableDb(): { db: Database; touched: () => number } {
  let touched = 0
  const pool = {
    connect: async () => {
      touched++
      throw new Error('the database was touched')
    },
    end: async () => {},
    options: {},
  } as unknown as Pool
  return { db: createDatabase(pool), touched: () => touched }
}

// The few Valkey commands sign-in uses. The sliding-window script answers `limit` ([1, 0] allows);
// the code challenge's OPEN and ATTACH keep the number's record (owner and ref) in `records`, as
// codes.ts's Lua does on Valkey; every other script answers 1. down makes every command fail as a
// closed connection does. `store`, if given, holds the keys, and `scripts` gets each script's keys
// and arguments, so a test can read what was written.
function fakeValkey(
  options: {
    limit?: [number, number]
    down?: boolean
    store?: Map<string, string>
    scripts?: (string | number)[][]
  } = {},
) {
  const store = options.store ?? new Map<string, string>()
  const records = new Map<string, { owner: string; ref?: string }>()
  const fail = () => {
    if (options.down) throw new Error('Connection is closed.')
  }
  const valkey = {
    evalsha: async (sha: string, _count: number, ...keysAndArgs: (string | number)[]) => {
      fail()
      options.scripts?.push(keysAndArgs)
      const [key, owner, ref] = keysAndArgs.map(String)
      if (sha === OPEN.sha && key !== undefined && owner !== undefined) {
        const replaced = records.get(key)?.ref ?? ''
        records.set(key, { owner })
        return replaced
      }
      if (sha === ATTACH.sha && key !== undefined) {
        const record = records.get(key)
        if (record === undefined || record.owner !== owner || record.ref !== undefined) return 'lost'
        record.ref = ref
        return 'attached'
      }
      return sha === SLIDING_WINDOW.sha ? (options.limit ?? [1, 0]) : 1
    },
    hget: async (key: string, field: string) => {
      fail()
      const record = records.get(key)
      return field === 'owner' || field === 'ref' ? (record?.[field] ?? null) : null
    },
    eval: async () => {
      fail()
      return 1
    },
    // SET with XX writes only a key that exists, as updateAttempt relies on.
    set: async (key: string, value: string, ...flags: unknown[]) => {
      fail()
      if (flags.includes('XX') && !store.has(key)) return null
      store.set(key, value)
      return 'OK'
    },
    get: async (key: string) => {
      fail()
      return store.get(key) ?? null
    },
    getdel: async (key: string) => {
      fail()
      const value = store.get(key) ?? null
      store.delete(key)
      return value
    },
    del: async (key: string) => {
      fail()
      return store.delete(key) ? 1 : 0
    },
    publish: async () => {
      fail()
      return 0
    },
  }
  return valkey as unknown as Redis
}

function setup(deps: Partial<ApiDeps> = {}) {
  const logs: Record<string, unknown>[] = []
  const stream = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split('\n').filter(Boolean)) logs.push(JSON.parse(line))
      done()
    },
  })
  const logger = createLogger({ logLevel: 'debug', role: 'api' }, stream)
  const app = buildApp({ appOrigin: APP_ORIGIN, logger, checks: {} })
  const afterResponse = new AfterResponse()
  registerApi(app, {
    appOrigin: APP_ORIGIN,
    db: unreachableDb().db,
    valkey: fakeValkey(),
    keys: KEYS,
    sms: new FakeVerify(),
    keyPrefix: 'it:unit:',
    flags: staticFlags(),
    afterResponse,
    ...deps,
  })
  const post = (url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { origin: APP_ORIGIN, ...headers },
      ...(payload === undefined ? {} : { payload: payload as string }),
    })
  return { app, logs, afterResponse, post }
}

// A phone number as a log could hold it: the digits after the country code, in order, with or
// without a space, dash, dot or bracket between any two. Only that shape counts, so digits that
// happen to be in a response time, a timestamp or a request id can't match.
function numberShape(national: string): RegExp {
  return new RegExp(national.split('').join('[\\s().-]?'))
}

// The session lookup finds the session, and then each statement gets `then`'s answer.
function signedInPool(then: (statement: Statement) => unknown[] | Error) {
  return scriptedPool(statement => {
    if (statement.text.includes('public.session_by_token')) {
      return [{ session_id: SESSION, org_id: ORG, user_id: PERSON, device_id: DEVICE }]
    }
    return then(statement)
  })
}

describe('C0.5 T14 the api scope: bodies, errors and no-store', () => {
  it('sends Cache-Control: no-store on every response, errors included', async () => {
    const { post, app } = setup()
    const responses = [
      await post('/api/auth/otp/request', { phone: '+6581234567' }),
      await post('/api/auth/otp/request', { phone: 'abc' }),
      await app.inject({ method: 'GET', url: '/api/devices' }),
      await post('/api/auth/otp/verify', { code: '123456' }),
    ]
    expect(responses.map(r => r.statusCode)).toEqual([200, 400, 401, 401])
    for (const response of responses) expect(response.headers['cache-control']).toBe('no-store')
  })

  it('answers a body that is not the route’s strict JSON object with 400 invalid_request, never echoing it', async () => {
    const { post } = setup()
    const marker = 'echo-marker'
    const refused = [
      await post('/api/auth/otp/request', { phone: '+6581234567', extra: marker }),
      await post('/api/auth/otp/request', [marker]),
      await post('/api/auth/otp/request', `phone=${marker}`, { 'content-type': 'application/x-www-form-urlencoded' }),
      await post('/api/auth/otp/request', marker, { 'content-type': 'text/plain' }),
      await post('/api/auth/otp/request', `{"phone": "${marker}`, { 'content-type': 'application/json' }),
      await post('/api/auth/otp/request', { phone: marker.repeat(2000) }),
      await post('/api/auth/sign-out', { anything: marker }),
    ]
    for (const response of refused) {
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual({ error: 'invalid_request', message: "That request wasn't understood." })
      expect(response.body).not.toContain(marker)
    }
  })

  it('refuses a body over 16 KiB before the route reads it, even one of the right shape', async () => {
    const { post } = setup()
    const registration = (size: number) => ({
      response: {
        id: 'AAAAAAAAAAAAAAAAAAAAAA',
        rawId: 'AAAAAAAAAAAAAAAAAAAAAA',
        type: 'public-key',
        response: { clientDataJSON: 'e30', attestationObject: 'A'.repeat(size) },
        clientExtensionResults: {},
      },
    })
    // Under the limit the body parses, and the route then wants a session.
    const fits = await post('/api/auth/passkeys/register/verify', registration(16_000))
    expect(fits.statusCode).toBe(401)
    expect(fits.json().error).toBe('signed_out')
    const over = await post('/api/auth/passkeys/register/verify', registration(16_384))
    expect(over.statusCode).toBe(400)
    expect(over.json().error).toBe('invalid_request')
  })

  it('gives a malformed phone number, code or PIN its own error', async () => {
    const { post } = setup()
    const phone = await post('/api/auth/otp/request', { phone: 'abc' })
    expect(phone.statusCode).toBe(400)
    expect(phone.json().error).toBe('invalid_phone')
    const code = await post('/api/auth/otp/verify', { code: 'abc' })
    expect(code.statusCode).toBe(400)
    expect(code.json().error).toBe('invalid_code')
  })

  it('answers 503 unavailable to a code request when no SMS provider is configured', async () => {
    const { post } = setup({ sms: undefined })
    const response = await post('/api/auth/otp/request', { phone: '+6581234567' })
    expect(response.statusCode).toBe(503)
    expect(response.json().error).toBe('unavailable')
  })

  it('T14: sign-in fails closed with 503 when Valkey is down', async () => {
    const { post } = setup({ valkey: fakeValkey({ down: true }) })
    const request = await post('/api/auth/otp/request', { phone: '+6581234567' })
    expect(request.statusCode).toBe(503)
    expect(request.json().error).toBe('unavailable')
    const verify = await post('/api/auth/otp/verify', { code: '123456' }, { cookie: `__Host-hearth_attempt=${TOKEN}` })
    expect(verify.statusCode).toBe(503)
  })

  it('PRD-53: a full window answers 429 with Retry-After, both in whole minutes', async () => {
    const { post } = setup({ valkey: fakeValkey({ limit: [0, 61_000] }) })
    const response = await post('/api/auth/otp/request', { phone: '+6581234567' })
    expect(response.statusCode).toBe(429)
    expect(response.headers['retry-after']).toBe('120')
    expect(response.json()).toEqual({
      error: 'too_many_requests',
      message: 'Too many tries. Try again later.',
      retryAfterSeconds: 120,
    })
  })
})

describe('C0.5 ACC-03 PRD-53 a code request answers before anything touches Postgres', () => {
  it('replies the same for any valid number, then looks the number up, and idle() waits for that', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const pool = scriptedPool(
      () => [],
      async statement => {
        if (statement.text.includes('public.person_by_phone')) await held
      },
    )
    const sms = new FakeVerify()
    const { post, logs, afterResponse } = setup({ db: pool.db, sms })
    const first = await post('/api/auth/otp/request', { phone: '+65 8123 4567' })
    const second = await post('/api/auth/otp/request', { phone: '+44 7700 900123' })
    // Both replied while the lookups were still held.
    for (const response of [first, second]) {
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ status: 'code_sent', expiresInSeconds: 300, codeLength: 6 })
      expect(response.headers['set-cookie']).toMatch(
        /^__Host-hearth_attempt=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Strict$/,
      )
    }
    let idle = false
    const waiting = afterResponse.idle().then(() => {
      idle = true
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(idle).toBe(false)
    release()
    await waiting
    // Neither number is on the roster, so nothing was sent and nothing was written.
    expect(sms.sent).toEqual([])
    expect(logs.filter(line => line.event === 'otp_non_roster')).toHaveLength(2)
    expect(pool.texts().filter(text => text.includes('person_by_phone'))).toHaveLength(2)
    expect(pool.texts().some(text => /^insert/.test(text))).toBe(false)
    const logged = JSON.stringify(logs)
    for (const national of ['81234567', '7700900123']) expect(logged).not.toMatch(numberShape(national))
  })

  it("T14: a browser that asks again before its first code is sent gets one text, with its newer attempt's code, and only that attempt names the person", async () => {
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const pool = scriptedPool(
      statement => {
        if (statement.text.includes('public.person_by_phone')) {
          return [{ phone_number_id: PHONE_NUMBER, org_id: ORG, person_id: PERSON }]
        }
        if (statement.text.includes("from principals where org_id = $1 and kind = 'system'")) return [{ id: SYSTEM }]
        if (statement.text.startsWith('select deactivated_at from people')) return [{ deactivated_at: null }]
        if (statement.text.startsWith('select 1 from phone_numbers')) return [{ '?column?': 1 }]
        return []
      },
      async statement => {
        if (statement.text.includes('public.person_by_phone')) await held
      },
    )
    const sms = new FakeVerify()
    const store = new Map<string, string>()
    const scripts: (string | number)[][] = []
    const { post, afterResponse } = setup({ db: pool.db, sms, valkey: fakeValkey({ store, scripts }) })
    // The attempt a reply's cookie names: the cookie, the attempt's key, and where Valkey keeps it.
    const attemptOf = (reply: { headers: Record<string, unknown> }) => {
      const pair = String(reply.headers['set-cookie']).split(';')[0] ?? ''
      expect(pair.startsWith(`${ATTEMPT_COOKIE}=`)).toBe(true)
      const attemptKey = keyName(pair.slice(ATTEMPT_COOKIE.length + 1))
      return { pair, attemptKey, stored: NAMES.attempt(attemptKey) }
    }
    const first = await post('/api/auth/otp/request', { phone: '+65 8123 4567' })
    const firstAttempt = attemptOf(first)
    // The same browser asks again while the first lookup is held: its first attempt goes.
    const second = await post('/api/auth/otp/request', { phone: '+65 8123 4567' }, { cookie: firstAttempt.pair })
    expect(second.statusCode).toBe(200)
    const secondAttempt = attemptOf(second)
    release()
    await afterResponse.idle()
    expect(sms.sent.map(sent => sent.to)).toEqual(['+6581234567'])
    // The code texted is the newer attempt's: the newer attempt owns the number's record (OPEN, then
    // ATTACH: the number's otp key, the attempt key and the provider's reference), and its record
    // holds the one reference sent. The newer attempt names the person, and the replaced one is gone.
    const numberTag = tag(KEYS, '+6581234567')
    const attached = scripts.filter(([key, , ref]) => key === NAMES.otp(numberTag) && typeof ref === 'string')
    expect(attached).toEqual([[NAMES.otp(numberTag), secondAttempt.attemptKey, sms.sent[0]?.ref]])
    expect(store.has(firstAttempt.stored)).toBe(false)
    expect(JSON.parse(store.get(secondAttempt.stored) ?? 'null')).toMatchObject({
      step: 'code_sent',
      orgId: ORG,
      personId: PERSON,
      phoneNumberId: PHONE_NUMBER,
    })
    const audits = pool.statements.filter(statement => statement.text.startsWith('insert into "audit_events"'))
    // One auth.code_requested row, its details last: the replaced attempt sent nothing and wrote nothing.
    expect(audits.map(statement => [statement.values[2], statement.values.at(-1)])).toEqual([
      ['auth.code_requested', { send: 'attempted' }],
    ])
  })

  it('logs work after the response that fails, with the reply already sent', async () => {
    const pool = scriptedPool(statement =>
      statement.text.includes('person_by_phone') ? new Error('connection terminated') : [],
    )
    const { post, logs, afterResponse } = setup({ db: pool.db })
    const response = await post('/api/auth/otp/request', { phone: '+6581234567' })
    expect(response.statusCode).toBe(200)
    await afterResponse.idle()
    expect(logs).toContainEqual(expect.objectContaining({ event: 'after_response_failed', level: 50 }))
  })

  it('lets work queued after a response finish when the server stops', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const pool = scriptedPool(
      () => [],
      async statement => {
        if (statement.text.includes('public.person_by_phone')) await held
      },
    )
    const { post, app, logs } = setup({ db: pool.db })
    await post('/api/auth/otp/request', { phone: '+6581234567' })
    let closed = false
    const closing = app.close().then(() => {
      closed = true
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(closed).toBe(false)
    release()
    await closing
    expect(logs.some(line => line.event === 'otp_non_roster')).toBe(true)
  })
})

describe('C0.5 T5 sessions at the api', () => {
  it('answers a signed-in route with no session cookie 401 signed_out, clearing it, without the database', async () => {
    const { db, touched } = unreachableDb()
    const { app } = setup({ db })
    for (const cookie of [
      undefined,
      '__Host-hearth_session=short',
      `__Host-hearth_session=${TOKEN}; __Host-hearth_session=${TOKEN}`,
    ]) {
      const response = await app.inject({ method: 'GET', url: '/api/devices', headers: cookie ? { cookie } : {} })
      expect(response.statusCode).toBe(401)
      expect(response.json().error).toBe('signed_out')
      expect(response.headers['set-cookie']).toBe(
        '__Host-hearth_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
      )
    }
    expect(touched()).toBe(0)
  })

  it('answers 503 unavailable when the session lookup fails, and 401 when it finds nothing', async () => {
    const down = setup({ db: unreachableDb().db })
    const failed = await down.app.inject({
      method: 'GET',
      url: '/api/devices',
      headers: { cookie: `__Host-hearth_session=${TOKEN}` },
    })
    expect(failed.statusCode).toBe(503)
    expect(failed.json().error).toBe('unavailable')
    const none = setup({ db: scriptedPool().db })
    const ended = await none.app.inject({
      method: 'GET',
      url: '/api/devices',
      headers: { cookie: `__Host-hearth_session=${TOKEN}` },
    })
    expect(ended.statusCode).toBe(401)
    expect(ended.json().error).toBe('signed_out')
  })

  it('signs out with no session as 200, clearing the cookie (idempotent)', async () => {
    const { db, touched } = unreachableDb()
    const { post } = setup({ db })
    const response = await post('/api/auth/sign-out')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'signed_out' })
    expect(response.headers['set-cookie']).toBe(
      '__Host-hearth_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    )
    expect(touched()).toBe(0)
  })

  it('answers a lock not granted in time 409 try_again, and anything unexpected 500 internal with no detail', async () => {
    const cookie = { cookie: `__Host-hearth_session=${TOKEN}` }
    const conflict = setup({ db: signedInPool(s => (s.text.includes('from people p') ? pgError('55P03') : [])).db })
    const busy = await conflict.post('/api/devices/sign-out', { allOthers: true }, cookie)
    expect(busy.statusCode).toBe(409)
    expect(busy.json()).toEqual({
      error: 'try_again',
      message: 'Something else changed this at the same moment. Try again.',
    })

    const broken = setup({
      db: signedInPool(s =>
        s.text.includes('from people p') ? new Error('relation "hidden_detail" does not exist') : [],
      ).db,
    })
    const failed = await broken.post('/api/devices/sign-out', { allOthers: true }, cookie)
    expect(failed.statusCode).toBe(500)
    expect(failed.json()).toEqual({ error: 'internal', message: 'Something went wrong on our side. Try again.' })
    expect(failed.body).not.toContain('hidden_detail')
    expect(broken.logs).toContainEqual(expect.objectContaining({ msg: 'request failed', level: 50 }))
  })

  it('answers 401 signed_out, clearing the cookie, when the acting session ended after the lookup', async () => {
    const { post } = setup({ db: signedInPool(() => []).db })
    const response = await post(
      '/api/devices/sign-out',
      { allOthers: true },
      { cookie: `__Host-hearth_session=${TOKEN}` },
    )
    expect(response.statusCode).toBe(401)
    expect(response.json().error).toBe('signed_out')
    expect(response.headers['set-cookie']).toContain('Max-Age=0')
  })
})
