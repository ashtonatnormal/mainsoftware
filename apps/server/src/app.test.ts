import { Writable } from 'node:stream'
import type { Redis } from 'ioredis'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import type { ApiDeps } from '#src/api.ts'
import { buildApp } from '#src/app.ts'
import { deriveKeys } from '#src/auth/crypto.ts'
import { FakeVerify } from '#src/auth/sms/fake.ts'
import type { Database } from '#src/db/database.ts'
import { createLogger } from '#src/logger.ts'
import type { Check } from '#src/ready.ts'
import { staticFlags } from '#src/testing/flags.ts'

const APP_ORIGIN = 'https://hearth.example.com'
const USER_CONTENT_ORIGIN = 'https://content.hearth.example.net'
const ok: Check = async () => {}
const down: Check = async () => {
  throw new Error('connection refused')
}

function app(checks: Record<string, Check> = { postgres: ok, valkey: ok, storage: ok }) {
  const instance = buildApp({ appOrigin: APP_ORIGIN, logger: pino({ level: 'silent' }), checks })
  // A state-changing route for the Origin tests; none exist in C0.2 itself.
  instance.post('/echo', async () => ({ echoed: true }))
  return instance
}

describe('C0.2 probes', () => {
  it('/health answers 200 without touching any dependency', async () => {
    const res = await app({ postgres: down, valkey: down, storage: down }).inject('/health')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('/ready answers 200 when Postgres, Valkey and storage all answer', async () => {
    const res = await app().inject('/ready')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ready', checks: { postgres: 'ok', valkey: 'ok', storage: 'ok' } })
  })

  it('/ready answers 503 and names the failed check, without its error detail', async () => {
    const res = await app({ postgres: ok, valkey: down, storage: ok }).inject('/ready')
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ status: 'not ready', checks: { postgres: 'ok', valkey: 'failed', storage: 'ok' } })
    expect(res.body).not.toContain('connection refused')
  })

  it('/ready gives up on a check that hangs, and aborts it', async () => {
    let aborted = false
    const hangs: Check = signal =>
      new Promise(() => {
        signal.addEventListener('abort', () => {
          aborted = true
        })
      })
    const started = Date.now()
    const res = await app({ postgres: hangs, valkey: ok, storage: ok }).inject('/ready')
    expect(res.statusCode).toBe(503)
    expect(res.json().checks.postgres).toBe('timed out')
    expect(aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

describe('C0.7 T19 item 12 P2: the local readiness, for the load balancer', () => {
  it('P2: /ready/local runs only the local checks, so a shared dependency’s outage fails /ready but not it', async () => {
    const instance = buildApp({
      appOrigin: APP_ORIGIN,
      logger: pino({ level: 'silent' }),
      checks: { postgres: down, valkey: down },
      localChecks: { local: ok },
    })
    const local = await instance.inject('/ready/local')
    expect(local.statusCode).toBe(200)
    expect(local.json()).toEqual({ status: 'ready', checks: { local: 'ok' } })
    expect((await instance.inject('/ready')).statusCode).toBe(503)
    const failing = buildApp({
      appOrigin: APP_ORIGIN,
      logger: pino({ level: 'silent' }),
      checks: {},
      localChecks: { local: down },
    })
    expect((await failing.inject('/ready/local')).json()).toEqual({ status: 'not ready', checks: { local: 'failed' } })
  })

  it('P2: /ready/local exists only when local checks are given; the realtime role gets the gateway’s in both, and no storage check of its own (main.ts)', async () => {
    expect((await app().inject('/ready/local')).statusCode).toBe(404)
    const realtime = buildApp({
      appOrigin: APP_ORIGIN,
      logger: pino({ level: 'silent' }),
      checks: { postgres: ok, valkey: ok },
      realtime: { db: {} as Database, keyPrefix: 'it:unit:' },
    })
    expect(Object.keys((await realtime.inject('/ready')).json().checks)).toEqual(['postgres', 'valkey', 'gateway'])
    expect(Object.keys((await realtime.inject('/ready/local')).json().checks)).toEqual(['gateway_local'])
    await realtime.close()
  })
})

describe('C0.2 request logs', () => {
  it('never write a query string, which can carry a token or a phone number', async () => {
    const lines: string[] = []
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk))
        done()
      },
    })
    const instance = buildApp({
      appOrigin: APP_ORIGIN,
      logger: createLogger({ logLevel: 'info', role: 'api' }, stream),
      checks: {},
    })
    const missing = await instance.inject('/nowhere?token=query-secret&phone=%2B6591234567')
    await instance.inject({
      method: 'POST',
      url: '/echo?token=refused-secret',
      headers: { origin: 'https://evil.example' },
    })
    const logs = lines.join('')
    for (const secret of ['query-secret', '6591234567', 'refused-secret']) expect(logs).not.toContain(secret)
    expect(logs).toContain('"url":"/nowhere"')
    expect(missing.statusCode).toBe(404)
    expect(missing.body).not.toContain('query-secret')
  })
})

describe('Origin check on state changes (CLAUDE.md, Security and privacy)', () => {
  const post = (headers: Record<string, string>) => app().inject({ method: 'POST', url: '/echo', headers })

  it('refuses a cross-origin POST', async () => {
    expect((await post({ origin: 'https://evil.example' })).statusCode).toBe(403)
  })

  it('refuses a POST with no Origin', async () => {
    expect((await post({})).statusCode).toBe(403)
  })

  it('refuses a POST whose Origin is "null"', async () => {
    expect((await post({ origin: 'null' })).statusCode).toBe(403)
  })

  it('refuses a "null" Origin with Sec-Fetch-Site same-origin too, anywhere but the CSP report path (T21 item 9: WebKit\'s report alone)', async () => {
    const webkit = { origin: 'null', 'sec-fetch-site': 'same-origin', 'content-type': 'application/csp-report' }
    expect((await post(webkit)).statusCode).toBe(403)
    // The exemption is the api's report route; a role without it answers that path 404.
    const report = await app().inject({ method: 'POST', url: '/api/csp-report', headers: webkit, payload: '{}' })
    expect(report.statusCode).toBe(404)
  })

  it('refuses a POST from the user-content origin', async () => {
    expect((await post({ origin: USER_CONTENT_ORIGIN })).statusCode).toBe(403)
  })

  it('refuses near misses: another scheme, a trailing slash, a subdomain, other case', async () => {
    for (const origin of [
      'http://hearth.example.com',
      `${APP_ORIGIN}/`,
      'https://evil.hearth.example.com',
      'https://HEARTH.example.com',
    ]) {
      expect((await post({ origin })).statusCode, origin).toBe(403)
    }
  })

  it("refuses other unsafe methods too, and requests to routes that don't exist", async () => {
    const instance = app()
    for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
      const res = await instance.inject({ method, url: '/echo', headers: { origin: 'https://evil.example' } })
      expect(res.statusCode, method).toBe(403)
    }
    const missing = await instance.inject({
      method: 'POST',
      url: '/nowhere',
      headers: { origin: 'https://evil.example' },
    })
    expect(missing.statusCode).toBe(403)
  })

  it('refuses routes registered inside a plugin scope too', async () => {
    const instance = buildApp({ appOrigin: APP_ORIGIN, logger: pino({ level: 'silent' }), checks: {} })
    await instance.register(async scope => {
      scope.post('/scoped', async () => ({ ok: true }))
    })
    const res = await instance.inject({ method: 'POST', url: '/scoped', headers: { origin: 'https://evil.example' } })
    expect(res.statusCode).toBe(403)
  })

  it('lets GET and HEAD through from anywhere, since neither changes state', async () => {
    const instance = app()
    for (const method of ['GET', 'HEAD'] as const) {
      const res = await instance.inject({ method, url: '/health', headers: { origin: 'https://evil.example' } })
      expect(res.statusCode, method).toBe(200)
    }
  })

  it('allows a POST from the app origin, and GETs from anywhere', async () => {
    expect((await post({ origin: APP_ORIGIN })).statusCode).toBe(200)
    const get = await app().inject({ method: 'GET', url: '/health', headers: { origin: 'https://evil.example' } })
    expect(get.statusCode).toBe(200)
  })
})

// An object that records and refuses any use: a dependency the request must never reach.
function untouchable<T extends object>(name: string, touched: string[]): T {
  return new Proxy({} as T, {
    get(_target, property) {
      touched.push(`${name}.${String(property)}`)
      throw new Error(`${name} was touched`)
    },
  })
}

function apiApp(touched: string[]) {
  const logger = pino({ level: 'silent' })
  const api: ApiDeps = {
    db: untouchable<Database>('db', touched),
    valkey: untouchable<Redis>('valkey', touched),
    keys: deriveKeys('unit-test-unit-test-unit-test-unit-test'),
    sms: new FakeVerify(),
    keyPrefix: 'it:unit:',
    flags: staticFlags(),
  }
  return buildApp({ appOrigin: APP_ORIGIN, logger, checks: {}, api })
}

describe('C0.5 the api role through buildApp (CLAUDE.md, Security and privacy)', () => {
  it('refuses a cross-origin code request 403 before anything touches Postgres or Valkey', async () => {
    const touched: string[] = []
    const app = apiApp(touched)
    for (const origin of [undefined, 'null', USER_CONTENT_ORIGIN, 'https://evil.example']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/otp/request',
        headers: origin === undefined ? {} : { origin },
        payload: { phone: '+6581234567' },
      })
      expect(res.statusCode, origin).toBe(403)
    }
    // Same-origin fetch metadata with a "null" Origin passes only a CSP report (T21 item 9).
    const webkit = await app.inject({
      method: 'POST',
      url: '/api/auth/otp/request',
      headers: { origin: 'null', 'sec-fetch-site': 'same-origin' },
      payload: { phone: '+6581234567' },
    })
    expect(webkit.statusCode).toBe(403)
    expect(touched).toEqual([])
  })

  it('answers a malformed number 400 invalid_phone with no-store, never echoing it, before Valkey or Postgres', async () => {
    const touched: string[] = []
    const res = await apiApp(touched).inject({
      method: 'POST',
      url: '/api/auth/otp/request',
      headers: { origin: APP_ORIGIN },
      payload: { phone: 'echo-marker' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_phone')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).not.toContain('echo-marker')
    expect(touched).toEqual([])
  })

  it('serves no /api route in an app built without the api role', async () => {
    const res = await app().inject({
      method: 'POST',
      url: '/api/auth/otp/request',
      headers: { origin: APP_ORIGIN },
      payload: { phone: '+6581234567' },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('C0.5 T14 request ids and the client address', () => {
  function withEcho(trustProxy?: string[] | false) {
    const instance = buildApp({ appOrigin: APP_ORIGIN, logger: pino({ level: 'silent' }), checks: {}, trustProxy })
    instance.get('/whoami', async request => ({ id: request.id, ip: request.ip }))
    return instance
  }
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

  it('gives every request a random uuid, and never takes the client’s X-Request-Id', async () => {
    const instance = withEcho()
    const first = (await instance.inject({ url: '/whoami', headers: { 'x-request-id': 'chosen-by-client' } })).json()
    const second = (await instance.inject({ url: '/whoami' })).json()
    expect(first.id).toMatch(UUID)
    expect(second.id).toMatch(UUID)
    expect(first.id).not.toBe(second.id)
  })

  it('ignores X-Forwarded-For unless the peer is a trusted proxy', async () => {
    const forwarded = { 'x-forwarded-for': '198.51.100.7' }
    const untrusted = withEcho(['127.0.0.1'])
    const fromElsewhere = await untrusted.inject({ url: '/whoami', headers: forwarded, remoteAddress: '203.0.113.9' })
    expect(fromElsewhere.json().ip).toBe('203.0.113.9')
    const fromProxy = await untrusted.inject({ url: '/whoami', headers: forwarded, remoteAddress: '127.0.0.1' })
    expect(fromProxy.json().ip).toBe('198.51.100.7')
    // No proxies (TRUST_PROXY unset or empty): even 127.0.0.1 isn't believed.
    const nothingTrusted: Array<string[] | false | undefined> = [undefined, false, []]
    for (const trustProxy of nothingTrusted) {
      const res = await withEcho(trustProxy).inject({ url: '/whoami', headers: forwarded, remoteAddress: '127.0.0.1' })
      expect(res.json().ip, String(trustProxy)).toBe('127.0.0.1')
    }
  })
})
