// The Content Security Policy guard (BUILD-PLAN C0.8, T21 item 7, R-59, R-61, R-65, R-75). The
// web app's document headers come from one builder, documentHeaders() in
// packages/shared/src/web-headers.ts, which Vite's dev server serves, and the e2e preview and
// C0.12's CloudFront policy will (D-04). This guard reads the policy the builder makes, parses it,
// and holds it to its own allow-list below, so no CDN or model host, wildcard or unsafe source can
// enter connect-src or any other directive unseen. A new source (C0.13's RUM endpoint, C2's
// LiveKit host) changes the builder and this allow-list in the same reviewed PR, or the browser
// blocks it.
//
// The cases that read apps/web files (CSP-07 to CSP-09) land with those files.
import {
  CLOUDFRONT_CSP_MAX,
  CSP_REPORT_PATH,
  contentSecurityPolicy,
  cspDirectives,
  documentHeaders,
} from '@hearth/shared'
import { describe, expect, it } from 'vitest'
import { isModelHost, MODEL_HOST } from './ai-free'

// The origins the builder serves: production, the e2e preview over HTTPS on this machine, and the
// dev server on each loopback host.
const ORIGINS = [
  'https://hearth.example.com',
  'https://hearth.example.com:8443',
  'https://localhost:5180',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://[::1]:5173',
]
const MODES = [
  { name: 'production', dev: false },
  { name: 'dev', dev: true },
] as const
const CASES = ORIGINS.flatMap(origin => MODES.map(mode => ({ origin, ...mode })))

// The realtime gateway's origin for an app origin, derived here on its own rather than by the
// builder, so the two must agree: https → wss, http → ws, same host and port.
const socketOf = (origin: string) => origin.replace(/^http/, 'ws')

// Every directive the policy may hold, and every source each may list. Production gets exactly
// these; dev adds only 'unsafe-inline' to script-src and style-src (Vite's React Refresh preamble
// and injected <style> elements).
function allowList(origin: string, dev: boolean): Record<string, string[]> {
  const inline = dev ? ["'unsafe-inline'"] : []
  return {
    'default-src': ["'none'"],
    'script-src': ["'self'", ...inline],
    'style-src': ["'self'", ...inline],
    'img-src': ["'self'"],
    'font-src': ["'self'"],
    'connect-src': ["'self'", socketOf(origin)],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'none'"],
    'object-src': ["'none'"],
    'report-uri': ['/api/csp-report'],
  }
}

// The policy as a browser reads it: directives split on ';', each a lower-case name and its
// sources. A browser ignores a repeated directive after the first, so a repeat fails here.
function parsePolicy(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>()
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name === undefined || name === '') throw new Error(`an empty directive in ${JSON.stringify(policy)}`)
    if (!/^[a-z-]+$/.test(name)) throw new Error(`${JSON.stringify(name)} is not a directive name`)
    if (directives.has(name)) throw new Error(`${name} appears twice`)
    directives.set(name, sources)
  }
  return directives
}

// The policy each case serves, read from the headers the document gets.
function served(origin: string, dev: boolean): Map<string, string[]> {
  const policy = documentHeaders(origin, { dev })['Content-Security-Policy']
  if (policy === undefined) throw new Error(`no Content-Security-Policy header for ${origin}`)
  return parsePolicy(policy)
}

// The host a source names, if it names one: scheme://host[:port][/path], or a bare host[:port].
function hostOf(source: string): string | undefined {
  if (source.startsWith("'") || source.startsWith('/')) return undefined
  return source.match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?(\[[^\]]*\]|[^/:]+)/i)?.[1]
}

describe('T21 item 7: the CSP guard', () => {
  it('reads the policy as a browser would (the parser itself)', () => {
    expect([...parsePolicy("default-src 'none'; connect-src 'self' wss://a.example").entries()]).toEqual([
      ['default-src', ["'none'"]],
      ['connect-src', ["'self'", 'wss://a.example']],
    ])
    expect(() => parsePolicy("default-src 'none'; default-src *")).toThrow(/twice/)
    expect(() => parsePolicy("default-src 'none';")).toThrow(/empty/)
    expect(() => parsePolicy("Default-Src 'none'")).toThrow(/directive name/)
    expect(hostOf('wss://api.openai.com:443')).toBe('api.openai.com')
    expect(hostOf('https://[::1]:5173')).toBe('[::1]')
    expect(hostOf('*.example.com')).toBe('*.example.com')
    expect(hostOf("'self'")).toBeUndefined()
    expect(hostOf('/api/csp-report')).toBeUndefined()
  })

  it.each(CASES)(
    "CSP-01 BP C0.8 R-59: connect-src holds only 'self' and the derived ws(s) origin ($name, $origin)",
    ({ origin, dev }) => {
      const connect = served(origin, dev).get('connect-src')
      expect(connect).toEqual(["'self'", socketOf(origin)])
      expect(socketOf(origin)).toMatch(origin.startsWith('https:') ? /^wss:\/\// : /^ws:\/\//)
    },
  )

  it.each(CASES)(
    "CSP-02 R-61: every directive and source is on the allow-list; no MODEL_HOSTS entry, no *, no bare scheme, no data:, blob:, 'unsafe-eval', 'unsafe-hashes' or 'wasm-unsafe-eval'; no 'unsafe-inline' in production ($name, $origin)",
    ({ origin, dev }) => {
      const policy = served(origin, dev)
      expect(Object.fromEntries(policy)).toEqual(allowList(origin, dev))
      const text = documentHeaders(origin, { dev })['Content-Security-Policy'] ?? ''
      expect([...text.matchAll(MODEL_HOST)].map(match => match[0])).toEqual([])
      for (const [directive, sources] of policy) {
        for (const source of sources) {
          const where = `${directive} ${source}`
          expect(source, where).not.toContain('*')
          expect(source, where).not.toMatch(/^[a-z][a-z0-9+.-]*:$/i)
          expect(source, where).not.toMatch(/^(?:data|blob|filesystem|mediastream):/i)
          expect(["'unsafe-eval'", "'unsafe-hashes'", "'wasm-unsafe-eval'"], where).not.toContain(source.toLowerCase())
          if (!dev) expect(source.toLowerCase(), where).not.toBe("'unsafe-inline'")
          const host = hostOf(source)
          if (host !== undefined) expect(isModelHost(host), where).toBe(false)
        }
      }
    },
  )

  it.each(ORIGINS)(
    "CSP-03: the dev policy differs from production only in 'unsafe-inline' on script-src and style-src (%s)",
    origin => {
      const production = served(origin, false)
      const dev = served(origin, true)
      expect([...dev.keys()]).toEqual([...production.keys()])
      for (const [directive, sources] of production) {
        const added = (dev.get(directive) ?? []).filter(source => !sources.includes(source))
        const removed = sources.filter(source => !(dev.get(directive) ?? []).includes(source))
        expect(removed, directive).toEqual([])
        expect(added, directive).toEqual(
          directive === 'script-src' || directive === 'style-src' ? ["'unsafe-inline'"] : [],
        )
      }
      // The other document headers don't change with the mode.
      const { 'Content-Security-Policy': _p, ...productionRest } = documentHeaders(origin)
      const { 'Content-Security-Policy': _d, ...devRest } = documentHeaders(origin, { dev: true })
      expect(devRest).toEqual(productionRest)
    },
  )

  it.each(CASES)(
    'CSP-04 C-21 R-59: report-uri /api/csp-report is present; report-to and Reporting-Endpoints are not ($name, $origin)',
    ({ origin, dev }) => {
      expect(CSP_REPORT_PATH).toBe('/api/csp-report')
      const policy = served(origin, dev)
      expect(policy.get('report-uri')).toEqual([CSP_REPORT_PATH])
      expect(policy.has('report-to')).toBe(false)
      const names = Object.keys(documentHeaders(origin, { dev })).map(name => name.toLowerCase())
      expect(names).not.toContain('reporting-endpoints')
      expect(names).not.toContain('report-to')
      // One policy, enforced: a report-only copy would double every report.
      expect(names.filter(name => name.startsWith('content-security-policy'))).toEqual(['content-security-policy'])
    },
  )

  it.each(CASES)(
    "CSP-05: default-src, base-uri, form-action, frame-ancestors and object-src are 'none' ($name, $origin)",
    ({ origin, dev }) => {
      const policy = served(origin, dev)
      for (const directive of ['default-src', 'base-uri', 'form-action', 'frame-ancestors', 'object-src']) {
        expect(policy.get(directive), directive).toEqual(["'none'"])
      }
    },
  )

  it("CSP-06 OD-11: the production policy for a long realistic host fits CloudFront's 1,783 characters", () => {
    expect(CLOUDFRONT_CSP_MAX).toBe(1783)
    const realistic = 'https://hearth-nonprod-ap-southeast-1.internal-tools.organisation-name.example:8443'
    // The longest host an origin can have: 253 characters, in labels of at most 63.
    const longest = `https://${['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.')}:65535`
    for (const origin of [realistic, longest]) {
      expect(contentSecurityPolicy(origin).length, origin).toBeLessThanOrEqual(CLOUDFRONT_CSP_MAX)
      expect(documentHeaders(origin)['Content-Security-Policy'], origin).toBe(contentSecurityPolicy(origin))
    }
    // The builder's directives are what the header carries.
    expect(contentSecurityPolicy(realistic)).toBe(
      cspDirectives(realistic)
        .map(([directive, sources]) => [directive, ...sources].join(' '))
        .join('; '),
    )
  })
})
