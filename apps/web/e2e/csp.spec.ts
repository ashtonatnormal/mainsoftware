// The document's headers and CSP in a real browser (T21 item 7; BUILD-PLAN C0.8, R-59, R-17, OD-12,
// DESIGN-SHELL §9.4.5). The preview serves documentHeaders(E2E_ORIGIN), the builder C0.12's
// CloudFront policy will use, so these cases hold production's policy to what the app does. Every
// spec's guard already fails on any violation and on any request to another origin; these prove the
// headers themselves, the fonts, and the report path.
import { documentHeaders } from '@hearth/shared'
import type { Page } from '@playwright/test'
import { logOffset, logSince } from './support/codes.ts'
import { E2E_ORIGIN } from './support/env.ts'
import { expect, test } from './support/fixtures.ts'
import { SCREENS } from './support/viewports.ts'

const h1 = (page: Page) => page.getByRole('heading', { level: 1 })

test('CS-01 R-59: the document carries documentHeaders(E2E_ORIGIN) exactly, and Cache-Control no-cache', {
  tag: '@smoke',
}, async ({ page }) => {
  const response = await page.goto('/chats')
  expect(response?.status()).toBe(200)
  const headers = response?.headers() ?? {}
  const expected = documentHeaders(E2E_ORIGIN)
  for (const [name, value] of Object.entries(expected)) expect(headers[name.toLowerCase()], name).toBe(value)
  expect(headers['cache-control']).toBe('no-cache')
  // One policy, enforced: no report-only copy, and no meta policy in the page.
  expect(headers['content-security-policy-report-only']).toBeUndefined()
  expect(await page.locator('meta[http-equiv="Content-Security-Policy" i]').count()).toBe(0)
  // No HSTS for localhost (K-30), which the builder decides.
  expect(headers['strict-transport-security']).toBeUndefined()
  await expect(h1(page)).toHaveText('Chats')
})

test('CS-02 R-17 SHL-69: a tour of every route makes only same-origin requests, both fonts load from the app itself, and no violation fires', {
  tag: '@smoke',
}, async ({ page, guard }) => {
  const fonts: string[] = []
  page.on('response', response => {
    if (/\.woff2$/.test(response.url()) && response.ok()) fonts.push(response.url())
  })
  for (const screen of SCREENS) {
    await page.goto(screen.path)
    await expect(h1(page)).toHaveText(screen.title)
    await page.evaluate(async () => {
      await document.fonts.ready
    })
  }
  expect(fonts.length).toBeGreaterThanOrEqual(2)
  for (const font of fonts) expect(new URL(font).origin).toBe(E2E_ORIGIN)
  expect(fonts.some(font => /figtree/i.test(font))).toBe(true)
  expect(fonts.some(font => /bricolage/i.test(font))).toBe(true)
  // The guard checks each request's origin and every violation; this says it saw none.
  expect(guard.violations).toEqual([])
})

test('CS-03 BP C0.8 Done OD-12: a blocked image raises a violation that reaches /api/csp-report, is answered 204 and is logged reduced', async ({
  page,
  guard,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'the report path was verified on Chromium (DESIGN-SHELL §9.4.5)')
  guard.allowViolation('img-src')
  await page.goto('/chats')
  await expect(h1(page)).toHaveText('Chats')
  const from = logOffset()
  const report = page.waitForRequest(request => new URL(request.url()).pathname === '/api/csp-report', {
    timeout: 10_000,
  })
  // An image from another origin, which img-src 'self' blocks before any request leaves the page.
  await page.evaluate(() => {
    const image = document.createElement('img')
    image.alt = ''
    image.src = 'https://example.invalid/x.png?secret=1'
    document.body.append(image)
  })
  const sent = await report
  expect((await sent.response())?.status()).toBe(204)
  await expect.poll(() => guard.violations.map(violation => violation.directive)).toContain('img-src')
  // The api logged it reduced: the directive and the blocked origin, never the query.
  let line = ''
  await expect
    .poll(() => {
      line =
        logSince(from)
          .split('\n')
          .find(entry => entry.includes('"event":"csp_report"')) ?? ''
      return line
    })
    .not.toBe('')
  expect(line).toContain('img-src')
  expect(line).toContain('https://example.invalid')
  expect(line).not.toContain('secret')
  expect(line).not.toContain('x.png')
})
