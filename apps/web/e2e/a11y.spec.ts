// axe on every screen (T21; BUILD-PLAN C0.8 Done: "axe finds 0 serious at 320, 390 and 1440 px,
// light and dark"; T21 items 11 and 13, QA-10). One page per screen,
// looping the viewport and the colour scheme, so each screen is loaded once. The PIN steps and the
// locked view are checked where sign-in.spec.ts reaches them (SI-09, SI-11).
import type { Page, TestInfo } from '@playwright/test'
import { expectAxeClean } from './support/axe.ts'
import { noAiCopy } from './support/checks.ts'
import { expect, test } from './support/fixtures.ts'
import { PERSONAS, typed } from './support/personas.ts'
import { CHECK_SIZES, SCHEMES, SCREENS, SIZES } from './support/viewports.ts'

const h1 = (page: Page) => page.getByRole('heading', { level: 1 })

// axe at each check size in both schemes, with `prepare` run after each resize.
async function axeEverywhere(page: Page, label: string, testInfo: TestInfo, prepare?: () => Promise<void>) {
  for (const size of CHECK_SIZES) {
    await page.setViewportSize(size)
    await prepare?.()
    for (const scheme of SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme })
      await expectAxeClean(page, `${label} at ${size.width} ${scheme}`, testInfo)
    }
  }
}

for (const screen of SCREENS) {
  test(`A11Y-01 BP C0.8 Done T21 item 11: axe finds nothing serious or critical on ${screen.path} at 320, 390 and 1440 px, light and dark`, async ({
    open,
  }, testInfo) => {
    const page = await open({ ...SIZES.w320, signedIn: true })
    await page.goto(screen.path)
    await expect(h1(page)).toHaveText(screen.title)
    await axeEverywhere(page, screen.path, testInfo)
  })
}

test('A11Y-02 T21 item 11: the same with the avatar menu open, and with the sign-out error toast showing', async ({
  open,
  guard,
}, testInfo) => {
  // The sign-out is aborted, so the shared session survives and the error toast shows.
  guard.allowFailedRequest('/api/auth/sign-out')
  const page = await open({ ...SIZES.w320, signedIn: true })
  await page.route('**/api/auth/sign-out', route => route.abort())
  await page.goto('/chats')
  await expect(h1(page)).toHaveText('Chats')
  const trigger = page.getByRole('button', { name: 'Account, Marcus' })
  const menu = page.getByRole('menu', { name: 'Account' })
  await axeEverywhere(page, 'the avatar menu', testInfo, async () => {
    if (await menu.isVisible()) await page.keyboard.press('Escape')
    await trigger.click()
    await expect(menu).toBeVisible()
  })
  await page.keyboard.press('Escape')
  await page.setViewportSize(SIZES.w320)
  await trigger.click()
  await menu.getByRole('menuitem', { name: 'Sign out' }).click()
  const toast = page.getByRole('region', { name: 'Notifications' }).getByText("Couldn't sign out")
  await expect(toast).toBeVisible()
  await axeEverywhere(page, 'the sign-out error toast', testInfo)
  // Still signed in: nothing reached the server.
  await expect(h1(page)).toHaveText('Chats')
})

test('A11Y-03 decision 8 T21 item 13: the sign-in phone step, and the code step with an error, pass axe at 320, 390 and 1440 px in both schemes, and noAiCopy', async ({
  open,
  guard,
}, testInfo) => {
  guard.expectResponses([{ path: '/api/auth/otp/verify', status: 401 }])
  const page = await open({ ...SIZES.w320 })
  await page.goto('/sign-in')
  await expect(h1(page)).toHaveText('Sign in to Hearth')
  await axeEverywhere(page, 'the phone step', testInfo)
  expect(await noAiCopy(page)).toEqual([])

  await page.setViewportSize(SIZES.w320)
  await page.getByLabel('Mobile number').fill(typed(PERSONAS.a11y))
  await page.getByRole('button', { name: 'Send code' }).click()
  await expect(h1(page)).toHaveText('Enter your code')
  // A number off the roster gets no text, so any code is wrong (PRD-53).
  await page.getByLabel('6-digit code').fill('000000')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByLabel('6-digit code')).toHaveAttribute('aria-invalid', 'true')
  await axeEverywhere(page, 'the code step with an error', testInfo)
  expect(await noAiCopy(page)).toEqual([])
})
