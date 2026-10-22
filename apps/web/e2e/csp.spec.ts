// The document's headers and CSP in a real browser (T21 items 7 and 11; BUILD-PLAN C0.8, SHL-69,
// OD-12). The preview serves documentHeaders(E2E_ORIGIN), the builder C0.12's
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

test('CS-01 T21 item 7: the document carries documentHeaders(E2E_ORIGIN) exactly, and Cache-Control no-cache', {
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
  // No HSTS for localhost (T21 item 7), which the builder decides.
  expect(headers['strict-transport-security']).toBeUndefined()
  await expect(h1(page)).toHaveText('Chats')
})

test('CS-02 SHL-69: a tour of every route makes only same-origin requests, both fonts load from the app itself, and no violation fires', {
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
  expect(fonts.some(font => /inter/i.test(font))).toBe(true)
  expect(fonts.some(font => /newsreader/i.test(font))).toBe(true)
  // The guard checks each request's origin and every violation; this says it saw none.
  expect(guard.violations).toEqual([])
})

// The api's log lines since an offset, as JSON; the fake provider's stderr lines aren't JSON.
function logLinesSince(from: number): Record<string, unknown>[] {
  return logSince(from)
    .split('\n')
    .flatMap(entry => {
      try {
        const line: unknown = JSON.parse(entry)
        return typeof line === 'object' && line !== null ? [line as Record<string, unknown>] : []
      } catch {
        return []
      }
    })
}

test('CS-03 BP C0.8 Done OD-12 T21 item 9: in every engine a blocked image raises a violation whose report reaches /api/csp-report, is answered 204 and is logged reduced', {
  tag: '@smoke',
}, async ({ page, guard, browserName }) => {
  guard.allowViolation('img-src')
  // The status of every answer to a report; WebKit's report carries Origin "null" and Sec-Fetch-Site
  // same-origin, which the root hook takes on this route alone (T21 item 9).
  const answered: number[] = []
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/api/csp-report') answered.push(response.status())
  })
  await page.goto('/chats')
  await expect(h1(page)).toHaveText('Chats')
  const from = logOffset()
  // An image from another origin, which img-src 'self' blocks before any request leaves the page.
  // The host names the engine, so the line found is this test's own: the projects run at once, and
  // WebKit's harness reports (an inline style, when a failed test's context closes) reach the same
  // log.
  const blocked = `https://cs-03-${browserName}.example.invalid`
  await page.evaluate(src => {
    const image = document.createElement('img')
    image.alt = ''
    image.src = src
    document.body.append(image)
  }, `${blocked}/x.png?secret=1`)
  await expect.poll(() => guard.violations.map(violation => violation.directive)).toContain('img-src')
  // The api logs a report only on the path that answers it 204 (CR-07 pins that status through the
  // same hooks), so the line proves delivery. A refusal's line names the kind of Origin and
  // Sec-Fetch-Site the report carried.
  let line: Record<string, unknown> | undefined
  await expect
    .poll(
      () => {
        const lines = logLinesSince(from)
        line = lines.find(entry => entry.event === 'csp_report' && entry.blocked === blocked)
        const refused = lines.filter(entry => entry.event === 'origin_refused' && entry.url === '/api/csp-report')
        return line === undefined ? `no report yet; refused: ${JSON.stringify(refused)}` : 'logged'
      },
      { timeout: 10_000 },
    )
    .toBe('logged')
  // Reduced: the directive, the blocked origin and the page's path, never the query or the file.
  expect(line).toMatchObject({ directive: 'img-src', blocked, path: '/chats' })
  expect(JSON.stringify(line)).not.toContain('secret')
  expect(JSON.stringify(line)).not.toContain('x.png')
  // The route logs before it answers, so the answer is waited for: Playwright shows it in all three
  // engines, and at least one must come, each one 204.
  await expect.poll(() => answered.length, { timeout: 10_000 }).toBeGreaterThan(0)
  expect(
    answered.every(status => status === 204),
    JSON.stringify(answered),
  ).toBe(true)
})
