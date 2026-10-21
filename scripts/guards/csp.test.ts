// The Content Security Policy guard (BUILD-PLAN C0.8, T21 item 7, PRD-70). The
// web app's document headers come from one builder, documentHeaders() in
// packages/shared/src/web-headers.ts. Vite's dev server serves documentHeaders(…, { dev: true })
// and the e2e preview documentHeaders(E2E_ORIGIN); from C0.12, CloudFront's response-headers
// policy will serve documentHeaders(appOrigin) (D-04). This guard reads the policy the builder
// makes, parses it, and holds it to its own allow-list below, so no CDN or model host, wildcard or
// unsafe source can enter connect-src or any other directive unseen. A new source (C0.13's RUM
// endpoint, C2's LiveKit host) changes the builder and this allow-list in the same reviewed PR, or
// the browser blocks it.
//
// CSP-07 and CSP-08 read apps/web/index.html, the page the policy governs: a policy without
// 'unsafe-inline' holds only while the page itself carries nothing inline. CSP-09 reads the two
// servers that serve the page before CloudFront does, Vite's dev server and the e2e preview, so
// neither can serve a policy of its own (D-04).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLOUDFRONT_CSP_MAX,
  CSP_REPORT_PATH,
  contentSecurityPolicy,
  cspDirectives,
  documentHeaders,
} from '@hearth/shared'
import { describe, expect, it } from 'vitest'
import { isModelHost, MODEL_HOST } from './ai-free'
import { codeOf } from './imports'
import { readRepoFile, root } from './repo-files'

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
    "CSP-01 BP C0.8 T21 item 7: connect-src holds only 'self' and the derived ws(s) origin ($name, $origin)",
    ({ origin, dev }) => {
      const connect = served(origin, dev).get('connect-src')
      expect(connect).toEqual(["'self'", socketOf(origin)])
      expect(socketOf(origin)).toMatch(origin.startsWith('https:') ? /^wss:\/\// : /^ws:\/\//)
    },
  )

  it.each(CASES)(
    "CSP-02 T21 item 7: every directive and source is on the allow-list; no MODEL_HOSTS entry, no *, no bare scheme, no data:, blob:, 'unsafe-eval', 'unsafe-hashes' or 'wasm-unsafe-eval'; no 'unsafe-inline' in production ($name, $origin)",
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
    'CSP-04 T21 item 7: report-uri /api/csp-report is present; report-to and Reporting-Endpoints are not ($name, $origin)',
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

  it('CSP-07 T21 item 7 D-02: apps/web/index.html exists and has no inline script, style element, style or event-handler attribute, meta CSP or absolute URL, and exactly one script, the module /src/main.ts', () => {
    expect(existsSync(join(root, INDEX_HTML)), INDEX_HTML).toBe(true)
    const page = readRepoFile(INDEX_HTML)
    const tags = tagsOf(page)
    expect(tags.length).toBeGreaterThan(5)
    // One script, external, the module entry; nothing between its tags.
    const scripts = tags.filter(tag => tag.name === 'script')
    expect(scripts.map(tag => Object.fromEntries(tag.attributes))).toEqual([{ type: 'module', src: '/src/main.ts' }])
    expect(withoutHtmlComments(page)).toMatch(/<script type="module" src="\/src\/main\.ts"><\/script>/)
    // No <style> element, and no style or on* attribute anywhere.
    expect(tags.filter(tag => tag.name === 'style')).toEqual([])
    for (const tag of tags) {
      for (const [name] of tag.attributes) {
        expect(name, `<${tag.name} ${name}>`).not.toBe('style')
        expect(name, `<${tag.name} ${name}>`).not.toMatch(/^on/)
      }
    }
    // The policy comes from the response headers only (T21 item 7): a meta policy would add a
    // second one that the guard above never sees.
    const metaPolicies = tags.filter(
      tag => tag.name === 'meta' && /^content-security-policy/i.test(tag.attributes.get('http-equiv') ?? ''),
    )
    expect(metaPolicies).toEqual([])
    // Every URL the page names is a path on its own origin: no scheme (https:, data:, javascript:)
    // and no host (//cdn.example).
    for (const tag of tags) {
      for (const [name, value] of tag.attributes) {
        if (!URL_ATTRIBUTES.has(name)) continue
        expect(value, `<${tag.name} ${name}>`).toMatch(/^\/(?!\/)/)
      }
    }
    expect(withoutHtmlComments(page)).not.toMatch(/[a-z][a-z0-9+.-]*:\/\/|["'\s=]\/\//i)
  })

  it('CSP-08 WCAG 1.4.4: the viewport meta allows zoom (no maximum-scale, no user-scalable=no)', () => {
    expect(existsSync(join(root, INDEX_HTML)), INDEX_HTML).toBe(true)
    const viewports = tagsOf(readRepoFile(INDEX_HTML)).filter(
      tag => tag.name === 'meta' && tag.attributes.get('name') === 'viewport',
    )
    expect(viewports).toHaveLength(1)
    const content = viewports[0]?.attributes.get('content') ?? ''
    const keys = new Map(
      content.split(',').map(part => {
        const [key = '', value = ''] = part.split('=').map(side => side.trim().toLowerCase())
        return [key, value] as const
      }),
    )
    expect(keys.get('width')).toBe('device-width')
    expect(keys.get('initial-scale')).toBe('1')
    // Both keys are refused whatever their value: a maximum-scale above 1 still caps zoom, and
    // user-scalable has no value that helps.
    expect(keys.has('maximum-scale'), content).toBe(false)
    expect(keys.has('user-scalable'), content).toBe(false)
    expect(keys.has('minimum-scale'), content).toBe(false)
  })

  it('CSP-09 D-04: vite.config.ts and e2e/support/preview.ts exist; the first serves documentHeaders(…, { dev: true }) and the second documentHeaders(E2E_ORIGIN), and neither names a header of its own', () => {
    for (const path of [VITE_CONFIG, E2E_PREVIEW]) expect(existsSync(join(root, path)), path).toBe(true)
    const vite = codeOf(VITE_CONFIG, readRepoFile(VITE_CONFIG))
    const preview = codeOf(E2E_PREVIEW, readRepoFile(E2E_PREVIEW))
    // Dev: the builder, relaxed for dev, as the server's headers, and nothing else there.
    // (TypeScript's printer, which strips the comments, writes strings in double quotes.)
    expect(vite).toMatch(/headers: documentHeaders\(["']http:\/\/localhost:5173["'], \{ dev: true \}\)/)
    expect([...vite.matchAll(/documentHeaders\(/g)]).toHaveLength(1)
    // The preview: production's headers for the e2e origin, plus only the document's cache rule.
    expect(preview).toMatch(
      /headers: \{ \.\.\.documentHeaders\(E2E_ORIGIN\), ["']Cache-Control["']: DOCUMENT_CACHE_CONTROL \}/,
    )
    expect([...preview.matchAll(/documentHeaders\(/g)]).toHaveLength(1)
    expect(preview).not.toMatch(/dev: true/)
    // No other policy anywhere in either: no CSP string, no report-only header.
    for (const [path, text] of [
      [VITE_CONFIG, vite],
      [E2E_PREVIEW, preview],
    ] as const) {
      expect(text, path).not.toMatch(/Content-Security-Policy|default-src|script-src/i)
    }
  })
})

const INDEX_HTML = 'apps/web/index.html'
const VITE_CONFIG = 'apps/web/vite.config.ts'
const E2E_PREVIEW = 'apps/web/e2e/support/preview.ts'

// The attributes that name a URL the browser fetches or navigates to.
const URL_ATTRIBUTES = new Set(['src', 'href', 'action', 'formaction', 'srcset', 'poster', 'data', 'manifest', 'ping'])

const withoutHtmlComments = (page: string) => page.replace(/<!--[\s\S]*?-->/g, '')

interface Tag {
  name: string
  attributes: Map<string, string>
}

// The page's start tags with their attributes, comments removed. index.html is static and written
// by hand, so a tag-and-attribute reader is enough, and it throws on any start tag it can't read
// (a single-quoted or unquoted value, a quoted ">") rather than letting that tag slip past.
function tagsOf(page: string): Tag[] {
  const text = withoutHtmlComments(page)
  const starts = text.match(/<[a-z]/gi)?.length ?? 0
  const tags = [...text.matchAll(/<([a-z][a-z0-9-]*)((?:\s+[^\s=>/]+(?:\s*=\s*"[^"]*")?)*)\s*\/?>/gi)].map(match => ({
    name: (match[1] ?? '').toLowerCase(),
    attributes: new Map(
      [...(match[2] ?? '').matchAll(/([^\s=>/]+)(?:\s*=\s*"([^"]*)")?/g)].map(
        attribute => [(attribute[1] ?? '').toLowerCase(), attribute[2] ?? ''] as const,
      ),
    ),
  }))
  if (tags.length !== starts) throw new Error(`read ${tags.length} of the page's ${starts} start tags`)
  return tags
}
