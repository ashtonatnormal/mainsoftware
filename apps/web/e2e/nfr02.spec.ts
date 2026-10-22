// The phone suite (NFR-02, PRD-66, WCAG 2.2 AA; T21 item 11): every screen and both
// sign-in steps on the four phone sizes, by touch, at 44 px targets and 16 px inputs, with the
// navigation in the thumb's reach, nothing sideways, nothing hidden under a toast, and the reflow,
// text-spacing, text-size, reduced-motion and forced-colours checks. Each NFR-02 core flow (read,
// reply, voice note…) adds its cases here with its step (C1 onwards).
import type { Page } from '@playwright/test'
import {
  focusNeverObscured,
  inputs16,
  navInBottom,
  noClippedText,
  noSidewaysScroll,
  reducedMotionHolds,
  targets44,
  withTextSpacing,
  withTextZoom,
} from './support/checks.ts'
import { expect, test } from './support/fixtures.ts'
import { PERSONAS, typed } from './support/personas.ts'
import { PHONES, SCREENS, SIZES, type Size } from './support/viewports.ts'

const h1 = (page: Page) => page.getByRole('heading', { level: 1 })
const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Main' })
const at = (size: Size) => `${size.width} × ${size.height}`

// Every screen at one size, with `check` run on each.
async function eachScreen(page: Page, size: Size, check: (label: string) => Promise<void>) {
  await page.setViewportSize(size)
  for (const screen of SCREENS) {
    await page.goto(screen.path)
    await expect(h1(page)).toHaveText(screen.title)
    await check(`${screen.path} at ${at(size)}`)
  }
}

// The step's primary button lies in the bottom half of the viewport (PRD-66).
async function primaryInBottomHalf(page: Page, name: string, size: Size): Promise<void> {
  const box = await page.getByRole('button', { name, exact: true }).boundingBox()
  expect(box, `${name} at ${at(size)}`).not.toBeNull()
  expect((box?.y ?? 0) + (box?.height ?? 0) / 2, `${name} at ${at(size)}`).toBeGreaterThanOrEqual(size.height / 2)
}

test('NF-01 NFR-02 PRD-66 WCAG 1.4.10: no sideways scroll, document or element, on every screen at each phone size and at 640 × 512', async ({
  open,
}) => {
  const page = await open({ ...SIZES.w320, signedIn: true, phone: true })
  for (const size of [...PHONES, SIZES.w640]) {
    await eachScreen(page, size, async label => expect(await noSidewaysScroll(page), label).toEqual([]))
  }
})

test('NF-01 NF-03 NF-06 NFR-02 PRD-66: both sign-in steps at each phone size: nothing sideways, 44 px targets, 16 px inputs, and the primary button in the bottom half', async ({
  open,
  guard,
}) => {
  guard.expectResponses([{ path: '/api/auth/otp/verify', status: 401 }])
  const page = await open({ ...SIZES.w320, phone: true })
  await page.goto('/sign-in')
  await expect(h1(page)).toHaveText('Sign in to Hearth')
  for (const size of [...PHONES, SIZES.w640]) {
    await page.setViewportSize(size)
    expect(await noSidewaysScroll(page), `phone step at ${at(size)}`).toEqual([])
    expect(await targets44(page), `phone step at ${at(size)}`).toEqual([])
    expect(await inputs16(page), `phone step at ${at(size)}`).toEqual([])
    if (size !== SIZES.w640) await primaryInBottomHalf(page, 'Send code', size)
  }
  await page.setViewportSize(SIZES.w320)
  await page.getByLabel('Mobile number').tap()
  await page.getByLabel('Mobile number').fill(typed(PERSONAS.nfr02))
  await page.getByRole('button', { name: 'Send code' }).tap()
  await expect(h1(page)).toHaveText('Enter your code')
  // With an error showing, the step is at its longest.
  await page.getByLabel('6-digit code').fill('000000')
  await page.getByRole('button', { name: 'Sign in', exact: true }).tap()
  await expect(page.getByLabel('6-digit code')).toHaveAttribute('aria-invalid', 'true')
  for (const size of [...PHONES, SIZES.w640]) {
    await page.setViewportSize(size)
    expect(await noSidewaysScroll(page), `code step at ${at(size)}`).toEqual([])
    expect(await targets44(page), `code step at ${at(size)}`).toEqual([])
    expect(await inputs16(page), `code step at ${at(size)}`).toEqual([])
    if (size !== SIZES.w640) await primaryInBottomHalf(page, 'Sign in', size)
  }
})

test('NF-02 NFR-02 X7 T21 item 11: every visible interactive element is at least 44 × 44 on every screen, menu open included', async ({
  open,
}) => {
  const page = await open({ ...SIZES.w320, signedIn: true, phone: true })
  for (const size of PHONES) {
    await eachScreen(page, size, async label => expect(await targets44(page), label).toEqual([]))
    await page.getByRole('button', { name: 'Account, Marcus' }).tap()
    await expect(page.getByRole('menu', { name: 'Account' })).toBeVisible()
    expect(await targets44(page), `the avatar menu at ${at(size)}`).toEqual([])
  }
})

test('NF-03 NFR-02 X7 SHL-28: every input is at least 16 px, on every screen', async ({ open }) => {
  const page = await open({ ...SIZES.w320, signedIn: true, phone: true })
  for (const size of PHONES) {
    await eachScreen(page, size, async label => expect(await inputs16(page), label).toEqual([]))
  }
})

test('NF-04 NFR-02 PRD-66: the tab bar sits in the bottom quarter and every tab opens its screen by tap()', async ({
  open,
}) => {
  const page = await open({ ...SIZES.w320, signedIn: true, phone: true })
  for (const size of PHONES) {
    await page.setViewportSize(size)
    await page.goto('/chats')
    await expect(h1(page)).toHaveText('Chats')
    expect(await navInBottom(page, 0.25), at(size)).toEqual([])
    for (const tab of ['Today', 'Chats', 'Rooms', 'Tasks', 'More']) {
      await mainNav(page).getByRole('link', { name: tab }).tap()
      await expect(h1(page), `${tab} at ${at(size)}`).toHaveText(tab)
    }
  }
})

test('NF-05 NFR-02 OD-05: the avatar menu opens and offers Sign out by taps alone', async ({ open }) => {
  const page = await open({ ...SIZES.w320, signedIn: true, phone: true })
  for (const size of PHONES) {
    await page.setViewportSize(size)
    await page.goto('/chats')
    await expect(h1(page)).toHaveText('Chats')
    const menu = page.getByRole('menu', { name: 'Account' })
    await page.getByRole('button', { name: 'Account, Marcus' }).tap()
    await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeVisible()
    // A tap anywhere outside closes it (Sign out itself is never pressed: the session is shared).
    await h1(page).tap()
    await expect(menu).toBeHidden()
  }
})

test('NF-07 WCAG 2.4.11: no focused element is hidden, with a persistent toast raised', async ({ open, guard }) => {
  // The sign-out is aborted, so the shared session survives and the error toast stays.
  guard.allowFailedRequest('/api/auth/sign-out')
  const page = await open({ ...SIZES.w320, signedIn: true })
  await page.route('**/api/auth/sign-out', route => route.abort())
  await page.goto('/more')
  await expect(h1(page)).toHaveText('More')
  await page.getByRole('button', { name: 'Account, Marcus' }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText("Couldn't sign out")).toBeVisible()
  for (const size of PHONES) {
    await page.setViewportSize(size)
    expect(await focusNeverObscured(page), at(size)).toEqual([])
  }
})

test('NF-08 WCAG 1.4.12: text spacing clips nothing at 320', async ({ open }) => {
  const page = await open({ ...SIZES.w320, signedIn: true, bypassCSP: true })
  await eachScreen(page, SIZES.w320, async label => {
    await withTextSpacing(page)
    expect(await noClippedText(page), label).toEqual([])
    expect(await noSidewaysScroll(page), label).toEqual([])
  })
})

test('NF-09 WCAG 1.4.4: 200% text loses nothing at 320 and 390; tab labels wrap and the bar grows', async ({
  open,
}) => {
  const page = await open({ ...SIZES.w320, signedIn: true, bypassCSP: true })
  for (const size of [SIZES.w320, SIZES.w390]) {
    await page.setViewportSize(size)
    await page.goto('/chats')
    await expect(h1(page)).toHaveText('Chats')
    // The bar measured before and after on the same page, so nothing between the two can replace it.
    const before = (await mainNav(page).boundingBox())?.height ?? 0
    await withTextZoom(page, 2)
    const after = (await mainNav(page).boundingBox())?.height ?? 0
    expect(after, `the tab bar grows with the text at ${at(size)}`).toBeGreaterThan(before)
    await eachScreen(page, size, async label => {
      await withTextZoom(page, 2)
      expect(await noClippedText(page), label).toEqual([])
      expect(await noSidewaysScroll(page), label).toEqual([])
    })
  }
})

test('NF-10 SHL-46: with reduced motion, no animation runs and no transition is over 0.01 ms', async ({ open }) => {
  const page = await open({ ...SIZES.w320, signedIn: true, reducedMotion: 'reduce' })
  await eachScreen(page, SIZES.w320, async label => expect(await reducedMotionHolds(page), label).toEqual([]))
  await page.getByRole('button', { name: 'Account, Marcus' }).click()
  expect(await reducedMotionHolds(page), 'the avatar menu').toEqual([])
})

test('NF-11 WCAG 1.4.11 forced colours: the current tab has an outline and the focus ring shows', async ({ open }) => {
  const page = await open({ ...SIZES.w320, signedIn: true })
  await page.emulateMedia({ forcedColors: 'active' })
  await page.goto('/chats')
  await expect(h1(page)).toHaveText('Chats')
  // Read once the link's transitions have ended: under reduced motion a focused link's ring eases in
  // from its unfocused outline for a frame or two (KB-05).
  const outline = (name: string) =>
    mainNav(page)
      .getByRole('link', { name })
      .evaluate(async element => {
        await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => undefined)))
        const style = getComputedStyle(element)
        return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) }
      })
  const current = await outline('Chats')
  expect(current.style).not.toBe('none')
  expect(current.width).toBeGreaterThan(0)
  // Reached by keyboard, so :focus-visible applies.
  await page.getByRole('button', { name: 'Account, Marcus' }).focus()
  await page.keyboard.press('Tab')
  await expect(mainNav(page).getByRole('link', { name: 'Today' })).toBeFocused()
  const focused = await outline('Today')
  expect(focused.style).not.toBe('none')
  expect(focused.width).toBeGreaterThan(0)
  // More holding Calendar (aria-current "true", not "page") keeps the outline too.
  await page.goto('/calendar')
  await expect(h1(page)).toHaveText('Calendar')
  await expect(mainNav(page).getByRole('link', { name: 'More' })).toHaveAttribute('aria-current', 'true')
  const holding = await outline('More')
  expect(holding.style).not.toBe('none')
  expect(holding.width).toBeGreaterThan(0)
})
