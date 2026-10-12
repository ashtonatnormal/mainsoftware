import { Writable } from 'node:stream'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { buildApp } from '#src/app.ts'
import { createLogger } from '#src/logger.ts'
import type { Check } from '#src/ready.ts'

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
