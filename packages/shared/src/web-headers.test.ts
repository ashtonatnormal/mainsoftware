// The web app's document headers and Content Security Policy (T21 item 7, D-04). The guard in
// scripts/guards/csp.test.ts checks the same output against its own allow-list.
import { describe, expect, test } from 'vitest'
import {
  ASSET_CACHE_CONTROL,
  CLOUDFRONT_CSP_MAX,
  CSP_REPORT_PATH,
  contentSecurityPolicy,
  cspDirectives,
  DOCUMENT_CACHE_CONTROL,
  documentHeaders,
  parseAppOrigin,
} from './web-headers.ts'

describe('T21 item 7: the Content Security Policy', () => {
  test("WH-01 R-59 OD-40: the production policy is exactly T21 item 7's list, in order", () => {
    expect(contentSecurityPolicy('https://hearth.example.com')).toBe(
      [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self'",
        "font-src 'self'",
        "connect-src 'self' wss://hearth.example.com",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        "object-src 'none'",
        'report-uri /api/csp-report',
      ].join('; '),
    )
    expect(CSP_REPORT_PATH).toBe('/api/csp-report')
  })

  test("D-04: dev adds 'unsafe-inline' to script-src and style-src, and nothing else", () => {
    const origin = 'http://localhost:5173'
    const production = new Map(cspDirectives(origin))
    const dev = new Map(cspDirectives(origin, { dev: true }))
    expect([...dev.keys()]).toEqual([...production.keys()])
    for (const [directive, sources] of production) {
      const extra = directive === 'script-src' || directive === 'style-src' ? ["'unsafe-inline'"] : []
      expect(dev.get(directive), directive).toEqual([...sources, ...extra])
    }
    expect(contentSecurityPolicy(origin, { dev: false })).toBe(contentSecurityPolicy(origin))
  })

  test('WH-02 R-60: connect-src names wss://host for https and ws://host:port for loopback http', () => {
    const connect = (origin: string) => new Map(cspDirectives(origin)).get('connect-src')
    expect(connect('https://hearth.example.com')).toEqual(["'self'", 'wss://hearth.example.com'])
    expect(connect('https://hearth.example.com:8443')).toEqual(["'self'", 'wss://hearth.example.com:8443'])
    expect(connect('https://localhost:5180')).toEqual(["'self'", 'wss://localhost:5180'])
    expect(connect('http://localhost:5173')).toEqual(["'self'", 'ws://localhost:5173'])
    expect(connect('http://127.0.0.1:5173')).toEqual(["'self'", 'ws://127.0.0.1:5173'])
    expect(connect('http://[::1]:5173')).toEqual(["'self'", 'ws://[::1]:5173'])
    expect(connect('http://localhost')).toEqual(["'self'", 'ws://localhost'])
  })

  test("OD-11: a policy fits CloudFront's 1,783 characters", () => {
    expect(CLOUDFRONT_CSP_MAX).toBe(1783)
    expect(contentSecurityPolicy('https://hearth.example.com').length).toBeLessThanOrEqual(CLOUDFRONT_CSP_MAX)
  })
})

describe('T21 item 7: the document headers', () => {
  test('WH-03 K-30: no HSTS for localhost, 127.0.0.1 or [::1]; HSTS for https hosts', () => {
    for (const origin of [
      'https://localhost:5180',
      'https://127.0.0.1:5180',
      'https://[::1]:5180',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://[::1]:5173',
    ]) {
      expect(documentHeaders(origin), origin).not.toHaveProperty('Strict-Transport-Security')
      expect(documentHeaders(origin, { dev: true }), origin).not.toHaveProperty('Strict-Transport-Security')
    }
    for (const origin of ['https://hearth.example.com', 'https://hearth.example.com:8443']) {
      expect(documentHeaders(origin)['Strict-Transport-Security'], origin).toBe('max-age=31536000')
    }
  })

  test('T21 item 7: the document is served with the policy and the fixed headers, frozen', () => {
    const headers = documentHeaders('https://hearth.example.com')
    expect(headers).toEqual({
      'Content-Security-Policy': contentSecurityPolicy('https://hearth.example.com'),
      'Cross-Origin-Opener-Policy': 'same-origin',
      // same-origin, not no-referrer: a CSP report then keeps its Origin, which the server's root
      // hook needs (OD-12).
      'Referrer-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Strict-Transport-Security': 'max-age=31536000',
    })
    expect(Object.isFrozen(headers)).toBe(true)
    expect(documentHeaders('http://localhost:5173', { dev: true })['Content-Security-Policy']).toBe(
      contentSecurityPolicy('http://localhost:5173', { dev: true }),
    )
    expect(DOCUMENT_CACHE_CONTROL).toBe('no-cache')
    expect(ASSET_CACHE_CONTROL).toBe('public, max-age=31536000, immutable')
  })
})

describe('T21 item 7: reading the app origin', () => {
  test('parseAppOrigin reads the scheme, host, port and whether the host is this machine', () => {
    expect(parseAppOrigin('https://hearth.example.com')).toEqual({
      scheme: 'https',
      host: 'hearth.example.com',
      loopback: false,
    })
    expect(parseAppOrigin('https://hearth.example.com:8443')).toEqual({
      scheme: 'https',
      host: 'hearth.example.com',
      port: 8443,
      loopback: false,
    })
    expect(parseAppOrigin('http://localhost:5173')).toEqual({
      scheme: 'http',
      host: 'localhost',
      port: 5173,
      loopback: true,
    })
    expect(parseAppOrigin('http://127.0.0.1:5173').loopback).toBe(true)
    expect(parseAppOrigin('http://[::1]:5173')).toEqual({ scheme: 'http', host: '[::1]', port: 5173, loopback: true })
    expect(parseAppOrigin('https://localhost:5180').loopback).toBe(true)
    expect(parseAppOrigin('https://xn--hrth-loa.example').host).toBe('xn--hrth-loa.example')
  })

  test('WH-04: parseAppOrigin refuses http for a non-loopback host, a path, a trailing slash or a userinfo part', () => {
    for (const origin of [
      'http://hearth.example.com',
      'http://10.0.0.5:3000',
      'http://localhost.example.com',
      'https://hearth.example.com/',
      'https://hearth.example.com/app',
      'https://hearth.example.com?x=1',
      'https://hearth.example.com#top',
      'https://user@hearth.example.com',
      'https://user:pass@hearth.example.com',
    ]) {
      expect(() => parseAppOrigin(origin), origin).toThrow()
    }
  })

  // config.ts compares the browser's Origin with APP_ORIGIN exactly, so none of these could ever
  // match: the URL parser rewrites or refuses each, or no page is served from it.
  test('parseAppOrigin refuses what the browser would never send as an Origin (config.ts compares exactly)', () => {
    for (const origin of [
      '',
      'hearth.example.com',
      '//hearth.example.com',
      'ftp://hearth.example.com',
      'wss://hearth.example.com',
      'HTTPS://hearth.example.com',
      'https://Hearth.Example.com',
      'https://hearth.example.com:443',
      'http://localhost:80',
      'https://hearth.example.com:0',
      'https://hearth.example.com:08443',
      'https://hearth.example.com:65536',
      'https://hearth.example.com:',
      'https://10.1',
      'https://0x7f.1',
      'https://hearth.0x1f',
      ' https://hearth.example.com',
      'https://hearth.example.com\n',
    ]) {
      expect(() => parseAppOrigin(origin), JSON.stringify(origin)).toThrow()
    }
    expect(() => parseAppOrigin('https://10.1')).toThrow(/names an IP address/)
    expect(parseAppOrigin('https://hearth.example.com:65535').port).toBe(65_535)
    expect(parseAppOrigin('http://localhost:443').port).toBe(443)
  })

  // The browser would send each of these unchanged, and config.ts's exact comparison would accept
  // it: the refusal is policy. The app's origin is a DNS host name, or this machine.
  test('parseAppOrigin refuses by policy an IP address other than this machine and a host that is not a DNS host name', () => {
    for (const origin of [
      'https://10.0.0.5',
      'https://192.0.2.1:8443',
      'https://[2001:db8::1]',
      'https://[::ffff:a00:5]',
    ]) {
      expect(() => parseAppOrigin(origin), origin).toThrow(/names an IP address: the app's origin is a host name/)
    }
    for (const origin of [
      'https://*.example.com',
      'https://hearth..example.com',
      'https://-hearth.example.com',
      'https://hearth-.example.com',
      'https://hearth_app.example.com',
      'https://hearth.example.com.',
      `https://${'a'.repeat(64)}.example.com`,
      `https://${['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(63)].join('.')}`,
    ]) {
      expect(() => parseAppOrigin(origin), JSON.stringify(origin)).toThrow()
    }
  })

  test('every builder refuses a bad origin rather than emit a policy for it', () => {
    expect(() => cspDirectives('http://hearth.example.com')).toThrow(/http/)
    expect(() => contentSecurityPolicy('https://hearth.example.com/')).toThrow(/not an origin/)
    expect(() => documentHeaders('https://hearth.example.com:443')).toThrow(/port/)
  })
})
