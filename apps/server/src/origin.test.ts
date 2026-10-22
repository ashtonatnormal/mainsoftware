// The Origin hook's one exception, decided as a pure function (TECH-SPEC T21 item 9, OD-12), and
// the kinds its refusal line names. app.test.ts and web/routes.test.ts hold the hook itself to it.
import { CSP_REPORT_PATH } from '@hearth/shared'
import { describe, expect, it } from 'vitest'
import { fetchSiteOf, isSameOriginCspReport, originKind } from '#src/origin.ts'

const APP_ORIGIN = 'https://hearth.example.com'
const USER_CONTENT_ORIGIN = 'https://content.hearth.example.net'

describe('the Origin hook’s exception (T21 item 9)', () => {
  it('OE-01 OD-12 T21 item 9: isSameOriginCspReport takes a POST on CSP_REPORT_PATH with Origin "null" and Sec-Fetch-Site same-origin, and no other combination', () => {
    const methods = ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
    const routes = [CSP_REPORT_PATH, '/api/auth/otp/request', `${CSP_REPORT_PATH}/`, '/API/csp-report', undefined]
    const origins = [
      undefined,
      '',
      'null',
      'NULL',
      ' null',
      ['null'],
      'null, null',
      'https://evil.example',
      USER_CONTENT_ORIGIN,
      `${APP_ORIGIN}/`,
      APP_ORIGIN,
    ]
    const fetchSites = [
      undefined,
      '',
      'same-origin',
      'Same-Origin',
      'same-site',
      'cross-site',
      'none',
      'same-origin, same-origin',
      ['same-origin'],
    ]
    let taken = 0
    for (const method of methods) {
      for (const route of routes) {
        for (const origin of origins) {
          for (const fetchSite of fetchSites) {
            const expected =
              method === 'POST' && route === CSP_REPORT_PATH && origin === 'null' && fetchSite === 'same-origin'
            const request = { method, route, origin, fetchSite }
            expect(isSameOriginCspReport(request), JSON.stringify(request)).toBe(expected)
            if (expected) taken++
          }
        }
      }
    }
    // Exactly one combination of the 2,475 is taken.
    expect(taken).toBe(1)
  })

  it('OE-02 OD-12 CL Security: originKind and fetchSiteOf name kinds, never a value', () => {
    expect(originKind(undefined)).toBe('absent')
    expect(originKind('null')).toBe('null')
    for (const origin of ['https://evil.example', 'moz-extension://0d1b2c3d-fictional', '', 'NULL', ['null']]) {
      expect(originKind(origin), JSON.stringify(origin)).toBe('other')
    }
    for (const site of ['same-origin', 'same-site', 'cross-site', 'none']) expect(fetchSiteOf(site)).toBe(site)
    expect(fetchSiteOf(undefined)).toBe('absent')
    for (const site of ['Same-Origin', 'same-origin, cross-site', 'evil.example', '', ['same-origin']]) {
      expect(fetchSiteOf(site), JSON.stringify(site)).toBe('other')
    }
  })
})
