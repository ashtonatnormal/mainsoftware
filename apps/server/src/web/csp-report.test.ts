// What a CSP report's log line keeps (reduceReport) and the per-process cap on those lines
// (createLogCap), both pure (OD-12). The route itself, its parser, the Origin hook and the cap at
// work are tested at the api in routes.test.ts.
import { describe, expect, it } from 'vitest'
import { CSP_LOG_PER_MINUTE, type CspReport, createLogCap, reduceReport } from '#src/web/csp-report.ts'

const APP_ORIGIN = 'https://hearth.example.com'
const PERSON = '0f9c2c4e-1b7a-4c1e-9f55-3d2a1b0c9e8d'
// Put in every field a line must not keep, so a test can look for it anywhere in the result.
const MARKER = 'csp-marker'

const report = (fields: CspReport['csp-report']): CspReport => ({ 'csp-report': fields })
const blocked = (blockedUri: string | undefined) =>
  reduceReport(report({ 'blocked-uri': blockedUri }), APP_ORIGIN).blocked
const path = (documentUri: string | undefined) => reduceReport(report({ 'document-uri': documentUri }), APP_ORIGIN).path
const directive = (fields: CspReport['csp-report']) => reduceReport(report(fields), APP_ORIGIN).directive

describe('C0.8 OD-12 reduceReport', () => {
  it('RR-01 OD-12: keeps scheme and host only for http and https, the scheme alone for any other (chrome-extension://abc, moz-extension://<uuid>, safari-web-extension://… → the scheme), and maps inline, eval, data, blob and self', () => {
    const cases: [string | undefined, string][] = [
      // An http(s) URL keeps its origin: no user name, path, query or fragment, and no default port.
      [`https://example.invalid/x.png?${MARKER}=1`, 'https://example.invalid'],
      [`https://someone@cdn.example.com:443/a/${MARKER}#${MARKER}`, 'https://cdn.example.com'],
      ['https://cdn.example.com:8443/x.js', 'https://cdn.example.com:8443'],
      ['HTTPS://CDN.Example.COM/X', 'https://cdn.example.com'],
      ['http://127.0.0.1:8080/a', 'http://127.0.0.1:8080'],
      ['http://[::1]:5173/', 'http://[::1]:5173'],
      // Any other scheme alone: an extension's host is its id, a per-install one in Firefox.
      ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/content.js', 'chrome-extension'],
      [`moz-extension://${PERSON}/content.js`, 'moz-extension'],
      ['safari-web-extension://ABCDEF01-2345-6789-ABCD-EF0123456789/content.js', 'safari-web-extension'],
      ['wss://socket.example.com/ws', 'wss'],
      ['data:image/png;base64,AAAA', 'data'],
      [`blob:${APP_ORIGIN}/${PERSON}`, 'blob'],
      ['about:blank', 'about'],
      // The keywords browsers send for what has no URL.
      ['inline', 'inline'],
      ['eval', 'eval'],
      ['wasm-eval', 'wasm-eval'],
      ['data', 'data'],
      ['blob', 'blob'],
      ['self', 'self'],
      ['INLINE', 'inline'],
      // Anything else.
      [undefined, 'other'],
      ['', 'other'],
      ['trusted-types-policy', 'other'],
      [`no scheme ${MARKER}`, 'other'],
      ['1http://example.invalid/', 'other'],
      ['https://', 'other'],
      [`${'a'.repeat(33)}://example.invalid/`, 'other'],
    ]
    for (const [input, expected] of cases) expect([input, blocked(input)]).toEqual([input, expected])
  })

  it('RR-02 OD-12: id-like path segments become :id; queries go; overlong paths are cut; another origin’s page is other-origin', () => {
    const cases: [string | undefined, string][] = [
      [`${APP_ORIGIN}/chats/${PERSON}?invite=${MARKER}#${MARKER}`, '/chats/:id'],
      [`${APP_ORIGIN}/`, '/'],
      [APP_ORIGIN, '/'],
      [`${APP_ORIGIN}/sign-in`, '/sign-in'],
      [`${APP_ORIGIN}/today/`, '/today/'],
      // Digits, upper case, other punctuation, percent-encoded names and long words are ids.
      [`${APP_ORIGIN}/drive/folder/12345/Report%20Q3`, '/drive/folder/:id/:id'],
      [`${APP_ORIGIN}/People/Ahmad`, '/:id/:id'],
      [`${APP_ORIGIN}/a_b/c.d/-e/f-/g--h`, '/:id/:id/:id/:id/:id'],
      [`${APP_ORIGIN}/${'a'.repeat(33)}/${'b'.repeat(32)}`, `/:id/${'b'.repeat(32)}`],
      [`${APP_ORIGIN}/caf%C3%A9`, '/:id'],
      // Another origin, a different scheme or port of the same host, or no page at all.
      [`https://other.example.com/chats?${MARKER}`, 'other-origin'],
      ['http://hearth.example.com/chats', 'other-origin'],
      ['https://hearth.example.com:8443/chats', 'other-origin'],
      ['about:blank', 'other-origin'],
      [`not a url ${MARKER}`, 'other-origin'],
      ['', 'other-origin'],
      [undefined, 'other-origin'],
    ]
    for (const [input, expected] of cases) expect([input, path(input)]).toEqual([input, expected])
    const long = path(`${APP_ORIGIN}/${'abc/'.repeat(100)}`)
    expect(long).toHaveLength(200)
    expect(long.startsWith('/abc/abc/')).toBe(true)
  })

  it('RR-03 OD-12: script-sample, original-policy and referrer never appear in the result', () => {
    // As a browser sends it: reduceReport is given the whole report, extra fields and all (the
    // route's schema drops them first; this checks reduceReport adds none back).
    const raw = {
      'csp-report': {
        'document-uri': `${APP_ORIGIN}/chats/${PERSON}?q=${MARKER}`,
        referrer: `${APP_ORIGIN}/today?from=${MARKER}`,
        'violated-directive': 'script-src-elem',
        'effective-directive': 'script-src-elem',
        'original-policy': `default-src 'none'; script-src 'self' ${MARKER}`,
        disposition: 'enforce',
        'blocked-uri': 'inline',
        'line-number': 12,
        'column-number': 34,
        'source-file': `${APP_ORIGIN}/assets/index.js?${MARKER}`,
        'status-code': 200,
        'script-sample': `alert("${MARKER}")`,
      },
    } as unknown as CspReport
    const reduced = reduceReport(raw, APP_ORIGIN)
    expect(reduced).toEqual({
      directive: 'script-src-elem',
      blocked: 'inline',
      path: '/chats/:id',
      disposition: 'enforce',
    })
    expect(Object.keys(reduced).sort()).toEqual(['blocked', 'directive', 'disposition', 'path'])
    expect(JSON.stringify(reduced)).not.toContain(MARKER)
  })

  it('RR-04 OD-12: an unknown directive reads unknown, and so does an unknown disposition', () => {
    expect(directive({ 'effective-directive': 'img-src' })).toBe('img-src')
    expect(directive({ 'effective-directive': 'IMG-SRC' })).toBe('img-src')
    // Older browsers send violated-directive with the directive's sources; its first word is kept.
    expect(directive({ 'violated-directive': "img-src 'self'" })).toBe('img-src')
    expect(directive({ 'effective-directive': 'img_src', 'violated-directive': 'img-src' })).toBe('img-src')
    for (const fields of [
      {},
      { 'effective-directive': '' },
      { 'effective-directive': 'img_src' },
      { 'effective-directive': `img-src ${MARKER}` },
      { 'effective-directive': 'a'.repeat(41) },
      { 'violated-directive': `${MARKER}1 img-src` },
    ]) {
      expect(directive(fields)).toBe('unknown')
    }
    const disposition = (value: string | undefined) =>
      reduceReport(report({ disposition: value }), APP_ORIGIN).disposition
    expect([disposition('enforce'), disposition('report')]).toEqual(['enforce', 'report'])
    for (const value of [undefined, '', 'ENFORCE', MARKER]) expect(disposition(value)).toBe('unknown')
  })
})

describe('C0.8 OD-12 createLogCap', () => {
  it('LC-01 OD-12: lets 60 a minute through and counts the rest, which dropped() answers once the minute has ended, and once only', () => {
    let now = 1_000
    const cap = createLogCap(() => now)
    expect(CSP_LOG_PER_MINUTE).toBe(60)
    const takes = Array.from({ length: 63 }, () => cap.take())
    expect(takes.filter(Boolean)).toHaveLength(60)
    expect(takes.slice(60)).toEqual([false, false, false])
    // The minute hasn't ended, so nothing is reported yet.
    now += 59_999
    expect(cap.dropped()).toBeUndefined()
    expect(cap.take()).toBe(false)
    now += 1
    expect(cap.dropped()).toBe(4)
    expect(cap.dropped()).toBeUndefined()
    expect(cap.take()).toBe(true)
  })

  it('LC-02 OD-12: drops from minutes not yet asked about add up; a minute with none reports nothing', () => {
    let now = 0
    const cap = createLogCap(() => now, 2)
    for (let i = 0; i < 4; i++) cap.take()
    now += 60_000
    for (let i = 0; i < 5; i++) cap.take()
    now += 60_000
    expect(cap.dropped()).toBe(2 + 3)
    expect([cap.take(), cap.take()]).toEqual([true, true])
    now += 60_000
    expect(cap.dropped()).toBeUndefined()
  })

  it('LC-03 OD-12: a clock that goes back starts a new minute, so the cap can’t stay shut', () => {
    let now = 120_000
    const cap = createLogCap(() => now, 1)
    expect([cap.take(), cap.take()]).toEqual([true, false])
    now = 5_000
    expect(cap.take()).toBe(true)
    // The minute the clock left ended with one refused.
    expect(cap.dropped()).toBe(1)
    now = 65_000
    expect(cap.dropped()).toBeUndefined()
  })
})
