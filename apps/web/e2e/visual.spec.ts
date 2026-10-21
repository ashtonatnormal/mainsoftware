// Visual regression (BUILD-PLAN C0.8, T21 item 11, D-07). Every
// screenshot is named in support/visual-matrix.ts, and its baseline is made only on CI's runner and
// adopted from the check job's artifact (support/adopt-baselines.ts). A local run walks the same
// screens and takes no screenshot (ignoreSnapshots), so it can't write or compare a PNG. Each shot
// waits for the self-hosted fonts and runs with reduced motion, and the caret is hidden. Every shot
// is a soft expect: a missing or changed one fails the test but doesn't stop it, so one failing CI
// run writes the actual of every shot that needs adopting (playwright.config.ts, D-07).
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Page } from '@playwright/test'
import { SIGN_IN } from '../src/strings/sign-in.ts'
import { fontsReady } from './support/checks.ts'
import { expect, test } from './support/fixtures.ts'
import { PERSONAS, typed } from './support/personas.ts'
import { SCHEMES } from './support/viewports.ts'
import { MORE_WIDTHS, shotName, VISUAL_WIDTHS } from './support/visual-matrix.ts'

// THROWAWAY PROBE (VS-01 determinism), never merged: after each shot, compare a fresh
// screenshot with the committed baseline at several pixelmatch thresholds and print the counts,
// so CI's log shows how far renders drift from run to run.
type Comparator = (actual: Buffer, expected: Buffer, options: object) => { errorMessage?: string } | null
const comparator = (
  createRequire(import.meta.url)('playwright-core/lib/coreBundle') as {
    utils: { getComparator: (mime: string) => Comparator }
  }
).utils.getComparator('image/png')
const PROBE_THRESHOLDS = [0, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2]

async function probe(page: Page, name: string) {
  const path = test.info().snapshotPath(name, { kind: 'screenshot' })
  if (!existsSync(path)) {
    console.log(`VS-PROBE ${name} no-baseline`)
    return
  }
  const expected = readFileSync(path)
  const actual = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide', scale: 'css' })
  const counts = PROBE_THRESHOLDS.map(threshold => {
    const result = comparator(actual, expected, { threshold, maxDiffPixels: 0 })
    if (result === null) return '0'
    return /^(\d+) pixels/.exec(result.errorMessage ?? '')?.[1] ?? `?${result.errorMessage ?? ''}`
  })
  const bytes = actual.equals(expected) ? 'bytes-equal' : 'bytes-differ'
  console.log(`VS-PROBE ${name} ${bytes} ${PROBE_THRESHOLDS.map((t, i) => `t${t}=${counts[i]}`).join(' ')}`)
}

const h1 = (page: Page) => page.getByRole('heading', { level: 1 })

// The height each width is shot at: a phone's, or the desktop's.
const sizeOf = (width: number) => ({ width, height: width === 1440 ? 900 : width === 390 ? 844 : 568 })

// One screen at every width and scheme in `widths`, each after `prepare`.
async function shoot(page: Page, screen: string, widths: readonly number[], prepare?: () => Promise<void>) {
  for (const width of widths) {
    await page.setViewportSize(sizeOf(width))
    await prepare?.()
    for (const scheme of SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme })
      await fontsReady(page)
      await expect.soft(page).toHaveScreenshot(shotName(screen, width, scheme), { fullPage: true })
      await probe(page, shotName(screen, width, scheme))
    }
  }
}

test('VS-01 BP C0.8 T21 item 11: the sign-in phone step, and the code step with an error, at 320, 390 and 1440 px, light and dark', {
  tag: '@visual',
}, async ({ open, guard }) => {
  guard.expectResponses([{ path: '/api/auth/otp/verify', status: 401 }])
  const page = await open({ ...sizeOf(320) })
  await page.goto('/sign-in')
  await expect(h1(page)).toHaveText(SIGN_IN.steps.phone)
  await shoot(page, 'sign-in-phone', VISUAL_WIDTHS)

  await page.setViewportSize(sizeOf(320))
  await page.getByLabel('Mobile number').fill(typed(PERSONAS.visual))
  await page.getByRole('button', { name: SIGN_IN.sendCode }).click()
  await expect(h1(page)).toHaveText(SIGN_IN.steps.code)
  await page.getByLabel('6-digit code').fill('000000')
  await page.getByRole('button', { name: SIGN_IN.signIn, exact: true }).click()
  await expect(page.getByLabel('6-digit code')).toHaveAttribute('aria-invalid', 'true')
  // The same picture whichever element has focus.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await shoot(page, 'sign-in-code-error', VISUAL_WIDTHS)
})

test('VS-01 BP C0.8 T21 item 11: Chats, the avatar menu open and Page not found at 320, 390 and 1440 px, and More at 320 and 390, light and dark', {
  tag: '@visual',
}, async ({ open }) => {
  const page = await open({ ...sizeOf(320), signedIn: true })
  await page.goto('/chats')
  await expect(h1(page)).toHaveText('Chats')
  await shoot(page, 'chats', VISUAL_WIDTHS)

  const menu = page.getByRole('menu', { name: 'Account' })
  // A new document at each width, so every width opens the menu from the same state. Closing the
  // last width's menu with Escape would leave keyboard modality behind, and the reopened menu's
  // first item would show its focus ring at that width only.
  await shoot(page, 'avatar-menu', VISUAL_WIDTHS, async () => {
    await page.reload()
    await expect(h1(page)).toHaveText('Chats')
    await page.getByRole('button', { name: 'Account, Marcus' }).click()
    await expect(menu).toBeVisible()
    // Opened by the pointer at every width: its first item has focus and shows no ring.
    const first = menu.getByRole('menuitem').first()
    await expect(first).toBeFocused()
    expect(await first.evaluate(item => item.matches(':focus-visible'))).toBe(false)
    await page.mouse.move(0, 0)
  })
  await page.keyboard.press('Escape')

  await page.goto('/xyz')
  await expect(h1(page)).toHaveText('Page not found')
  await shoot(page, 'not-found', VISUAL_WIDTHS)

  await page.goto('/more')
  await expect(h1(page)).toHaveText('More')
  await shoot(page, 'more', MORE_WIDTHS)
})
