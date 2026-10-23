// The DPO's registers in a real browser against the real api (C0.9 PD-20, PD-26, PD-27, PD-30;
// PDPA-01, PDPA-10, PDPA-13; OD-03; TECH-SPEC T22 item 15). Chromium only (not @smoke), and no
// visual shots: C0.16 moves the pages under /admin.
//
// Ashton, the seed's Owner and DPO (D35), holds PIN roles, so no storage state signs him in. The
// file signs him in once, through the api, before its tests (support/sign-in-api.ts): one code, then
// E2E_PIN set, so his session is issued under the PIN rule and re-authenticates with the PIN. A new
// session counts as re-authenticated for its first 5 minutes (§9.4), so the tests that read and
// write run first, and DPP-E3 confirms the PIN for real part-way. The file runs serially, in one
// worker, so the sign-in happens once and Ashton's one code is the run's only one (personas.ts).
// Marcus, the project's own persona (a Team Admin), is the one who isn't the DPO.
//
// What DPP-E2 records, and DPP-E5 clears and withdraws again, is made up and harmless: nothing in
// C0.9 PR 1 sends to a push service, and the e2e api's fake SMS provider names no transfer, so
// clearing or withdrawing changes no send.
import { REAUTH_METHOD_MESSAGES } from '@hearth/shared'
import type { Page } from '@playwright/test'
import { expectAxeClean } from './support/axe.ts'
import { inputs16, noAiCopy, noSidewaysScroll, targets44 } from './support/checks.ts'
import { stateFile } from './support/env.ts'
import { expect, test } from './support/fixtures.ts'
import { E2E_PIN, PERSONAS } from './support/personas.ts'
import { signInWithPinViaApi } from './support/sign-in-api.ts'
import { CHECK_SIZES, SCHEMES, SIZES } from './support/viewports.ts'

const ASHTON = stateFile('dpo-ashton')

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  await signInWithPinViaApi(PERSONAS.ashton, E2E_PIN, ASHTON)
})

const h1 = (page: Page) => page.getByRole('heading', { level: 1 })
const accountMenu = (page: Page) => page.getByRole('menu', { name: 'Account' })

// A card on a register's page, by its heading.
const card = (page: Page, name: string | RegExp) =>
  page.getByRole('listitem').filter({ has: page.getByRole('heading', { level: 2, name }) })

// The first purpose's card, which shows once the register has been read.
const firstPurpose = (page: Page) => page.getByRole('heading', { level: 2, name: /^Accounts and sign-in/ })

// A review date a year from now: after today in any zone.
const nextYear = () => {
  const date = new Date()
  date.setUTCFullYear(date.getUTCFullYear() + 1)
  return date.toISOString().slice(0, 10)
}

test('DPP-E1 PD-26 PD-27 decision 8: the DPO’s avatar menu holds Data protection, which opens the processing register; both registers pass axe at 320, 390 and 1440 px in both schemes, show no AI copy, and scroll nothing sideways at 320', async ({
  open,
}, testInfo) => {
  const page = await open({ ...SIZES.w390, signedIn: ASHTON })
  await page.goto('/chats')
  await expect(h1(page)).toHaveText('Chats')
  await page.getByRole('button', { name: /^Account, Ashton/ }).click()
  const items = accountMenu(page).getByRole('menuitem')
  expect((await items.allInnerTexts()).map(name => name.trim())).toEqual(['Data protection', 'Sign out'])
  await items.filter({ hasText: 'Data protection' }).click()
  await expect(page).toHaveURL(/\/dpo\/purposes$/)
  await expect(h1(page)).toHaveText('Processing register')
  await expect(firstPurpose(page)).toBeVisible()
  // Thirteen purposes, none of the AI layer's (PD-27).
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(13)
  await expect(page.getByRole('heading', { level: 2, name: 'Transcribing sessions' })).toHaveCount(0)

  for (const [path, title, first] of [
    ['/dpo/purposes', 'Processing register', /^Accounts and sign-in/],
    ['/dpo/transfers', 'Transfer register', 'Amazon Web Services'],
  ] as const) {
    await page.goto(path)
    await expect(h1(page)).toHaveText(title)
    await expect(page.getByRole('heading', { level: 2, name: first })).toBeVisible()
    for (const size of CHECK_SIZES) {
      await page.setViewportSize(size)
      for (const scheme of SCHEMES) {
        await page.emulateMedia({ colorScheme: scheme })
        await expectAxeClean(page, `${path} at ${size.width} ${scheme}`, testInfo)
      }
      expect(await noAiCopy(page), `${path} at ${size.width}`).toEqual([])
    }
    await page.setViewportSize(SIZES.w320)
    expect(await noSidewaysScroll(page), `${path} at 320`).toEqual([])
    await page.setViewportSize(SIZES.w390)
  }
})

test('DPP-E3 PD-30 D46 T20 item 6: a read refused for want of a fresh re-authentication shows the PIN step, whose PIN confirms it’s the DPO for real, and the register is read again', async ({
  open,
  guard,
}) => {
  // The first read is answered here with the refusal the api gives a PIN-rule session past its 5
  // minutes; every later request goes to the api.
  guard.expectResponses([{ path: '/api/admin/registers', status: 403 }])
  const page = await open({ ...SIZES.w390, signedIn: ASHTON })
  let refused = false
  await page.route('**/api/admin/registers', async route => {
    if (refused || route.request().method() !== 'GET') return route.fallback()
    refused = true
    return route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'reauth_required',
        message: REAUTH_METHOD_MESSAGES.pin.required,
        method: 'pin',
      }),
    })
  })
  await page.goto('/dpo/purposes')
  await expect(h1(page)).toHaveText('Processing register')
  await expect(page.getByText(REAUTH_METHOD_MESSAGES.pin.method, { exact: true })).toBeVisible()
  const pin = page.getByLabel('Your PIN', { exact: true })
  await expect(pin).toBeFocused()
  await expect(pin).toHaveAttribute('autocomplete', 'current-password')
  await expect(firstPurpose(page)).toHaveCount(0)

  const confirmed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/reauth/pin')
  await pin.fill(E2E_PIN)
  await page.getByRole('button', { name: 'Confirm', exact: true }).click()
  expect((await confirmed).status()).toBe(200)
  await expect(firstPurpose(page)).toBeVisible()
  await expect(pin).toHaveCount(0)
  expect(refused).toBe(true)
})

test('DPP-E2 PDPA-01 PDPA-10 PD-04 PD-05 PD-11 PD-12: the DPO records security_audit on legitimate interests and sees version 2; recording_meetings offers no consent-type basis; apple_push’s made-up facts leave nothing still needed, and it is cleared for use, then withdrawn', async ({
  open,
}) => {
  const page = await open({ ...SIZES.desktop, signedIn: ASHTON })
  await page.goto('/dpo/purposes')
  await expect(h1(page)).toHaveText('Processing register')

  // security_audit starts active with nothing recorded (PD-06): a basis, its assessment and a
  // retention save it as version 2.
  await page.getByRole('button', { name: 'Edit Security audit and monitoring' }).click()
  let dialog = page.getByRole('dialog', { name: 'Edit Security audit and monitoring' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Legal basis', { exact: true }).selectOption('legitimate_interests')
  await dialog
    .getByLabel('Where the legitimate interests assessment is kept', { exact: true })
    .fill('Assessment 3, in the DPO’s file')
  await dialog.getByLabel('How long it’s kept', { exact: true }).fill('13 months')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toBeHidden()
  const audit = card(page, 'Security audit and monitoring')
  await expect(audit).toContainText('Legitimate interests')
  await expect(audit).toContainText('13 months')
  await expect(audit).toContainText(/Version\s*2/)
  await expect(audit).toContainText(/by Ashton/)

  // A purpose that needs a per-person switch rests on no consent-type basis until C2.11 (PD-11).
  await page.getByRole('button', { name: 'Edit Recording scheduled meetings and calls' }).click()
  dialog = page.getByRole('dialog', { name: 'Edit Recording scheduled meetings and calls' })
  const bases = (await dialog.getByLabel('Legal basis', { exact: true }).locator('option').allInnerTexts()).map(text =>
    text.trim(),
  )
  expect(bases).toContain('Legitimate interests')
  for (const consent of ['Consent', 'Deemed consent by conduct or contract', 'Deemed consent by notification']) {
    expect(bases, consent).not.toContain(consent)
  }
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toBeHidden()

  // The transfer register: a push service's facts, made up, then cleared and withdrawn.
  await page.getByRole('navigation', { name: 'Registers' }).getByRole('link', { name: 'Transfers' }).click()
  await expect(h1(page)).toHaveText('Transfer register')
  const apple = card(page, 'Apple Push Notification service')
  await expect(apple).toContainText('Not cleared')
  await apple.getByRole('button', { name: 'Edit Apple Push Notification service' }).click()
  dialog = page.getByRole('dialog', { name: 'Edit Apple Push Notification service' })
  await expect(dialog).toContainText('Still needed before clearing')
  const field = (label: string) => dialog.getByLabel(label, { exact: true })
  await field('What it’s used for').fill('Notifications to Apple devices')
  await field('The personal data it receives').fill('A device token, and that something changed')
  await field('Countries it processes the data in').fill('us')
  await field('Countries it stores the data in').fill('US')
  await field('Where and when it confirmed the countries in writing').fill('Developer agreement, 1 Oct 2026')
  await field('Transfer safeguard').selectOption('dpa')
  await field('The safeguard’s reference').fill('Developer agreement, schedule 2')
  await dialog.getByRole('checkbox', { name: /^The agreement binds protection comparable to the PDPA/ }).check()
  await field('Training on the data').selectOption('not_applicable')
  await field('Zero-retention result').selectOption('not_offered')
  await field('How long it keeps the data').fill('Until delivered, at most 30 days')
  await field('Where and when it confirmed its retention in writing').fill('Developer documentation, 1 Oct 2026')
  await field('Who it passes the data on to').fill('None')
  await field('Review by').fill(nextYear())
  await expect(dialog).toContainText('Nothing more is needed to clear it.')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toBeHidden()

  await apple.getByRole('button', { name: 'Clear for use', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Clear Apple Push Notification service for use?' })
  await dialog.getByRole('button', { name: 'Clear for use', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(apple).toContainText(/Cleared on .* by Ashton/)

  await apple.getByRole('button', { name: 'Withdraw clearance', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Withdraw Apple Push Notification service’s clearance?' })
  await expect(dialog).toContainText('Nothing in Hearth sends to it yet')
  await dialog.getByRole('button', { name: 'Withdraw clearance', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(apple).toContainText('Clearance withdrawn on')
  await expect(apple.getByRole('button', { name: 'Clear for use', exact: true })).toBeVisible()
})

test('DPP-E5 NFR-02 PRD-66 WCAG 2.2 AA T22 item 15: on a phone, the DPO’s two-item avatar menu fits at 320 × 568 and 768 × 480; and at 320 and 390 both pages and every dialog of the edit, clear and withdraw flows have 44 px targets and 16 px inputs, scroll nothing sideways and pass axe', async ({
  open,
}, testInfo) => {
  // SH-08's placement check, with the DPO's menu: every item inside the viewport, and the point at
  // its centre is the item.
  for (const size of [SIZES.w320, SIZES.short]) {
    const page = await open({ ...size, signedIn: ASHTON, phone: true })
    await page.goto('/chats')
    await expect(h1(page)).toHaveText('Chats')
    await page.getByRole('button', { name: /^Account, Ashton/ }).click()
    const items = accountMenu(page).getByRole('menuitem')
    expect((await items.allInnerTexts()).map(name => name.trim())).toEqual(['Data protection', 'Sign out'])
    const placed = await items.evaluateAll(elements =>
      elements.map(element => {
        const box = element.getBoundingClientRect()
        const inside = box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return { inside, reached: hit !== null && (hit === element || element.contains(hit)) }
      }),
    )
    const every = { inside: true, reached: true }
    expect(placed, `${size.width} × ${size.height}`).toEqual([every, every])
    expect(await targets44(page), `the avatar menu at ${size.width} × ${size.height}`).toEqual([])
  }

  for (const size of [SIZES.w320, SIZES.w390]) {
    const page = await open({ ...size, signedIn: ASHTON, phone: true })
    // What NFR-02 asks of every screen, on the page or dialog as it stands.
    const checked = async (what: string) => {
      const label = `${what} at ${size.width}`
      expect(await targets44(page), label).toEqual([])
      expect(await inputs16(page), label).toEqual([])
      expect(await noSidewaysScroll(page), label).toEqual([])
      await expectAxeClean(page, label, testInfo)
    }

    await page.goto('/dpo/purposes')
    await expect(firstPurpose(page)).toBeVisible()
    await checked('/dpo/purposes')
    await page.getByRole('button', { name: 'Edit Security audit and monitoring' }).click()
    let dialog = page.getByRole('dialog', { name: 'Edit Security audit and monitoring' })
    await expect(dialog).toBeVisible()
    await checked('the purpose dialog')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toBeHidden()

    await page.goto('/dpo/transfers')
    const apple = card(page, 'Apple Push Notification service')
    await expect(apple).toContainText('Not cleared')
    await checked('/dpo/transfers')
    await apple.getByRole('button', { name: 'Edit Apple Push Notification service' }).click()
    dialog = page.getByRole('dialog', { name: 'Edit Apple Push Notification service' })
    await expect(dialog).toContainText('Nothing more is needed to clear it.')
    await checked('the transfer dialog')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toBeHidden()

    // On the facts DPP-E2 recorded: cleared, then withdrawn, each through its confirmation.
    await apple.getByRole('button', { name: 'Clear for use', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'Clear Apple Push Notification service for use?' })
    await expect(dialog).toBeVisible()
    await checked('the clear confirmation')
    await dialog.getByRole('button', { name: 'Clear for use', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(apple).toContainText(/Cleared on .* by Ashton/)
    await apple.getByRole('button', { name: 'Withdraw clearance', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'Withdraw Apple Push Notification service’s clearance?' })
    await expect(dialog).toBeVisible()
    await checked('the withdraw confirmation')
    await dialog.getByRole('button', { name: 'Withdraw clearance', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(apple).toContainText('Clearance withdrawn on')
  }
})

test('DPP-E4 PD-20 PDPA-13: someone who isn’t the DPO (Marcus) has no Data protection entry, and his deep link to a register is refused by the api and says the page is the DPO’s', async ({
  open,
  guard,
}) => {
  guard.expectResponses([{ path: '/api/admin/registers', status: 403 }])
  const page = await open({ ...SIZES.w390, signedIn: true })
  await page.goto('/chats')
  await expect(h1(page)).toHaveText('Chats')
  await page.getByRole('button', { name: 'Account, Marcus' }).click()
  const items = accountMenu(page).getByRole('menuitem')
  expect((await items.allInnerTexts()).map(name => name.trim())).toEqual(['Sign out'])
  await page.keyboard.press('Escape')

  const refusal = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/registers')
  await page.goto('/dpo/transfers')
  expect((await refusal).status()).toBe(403)
  await expect(h1(page)).toHaveText('Transfer register')
  await expect(
    page.getByRole('heading', { level: 2, name: 'This page is for the Data Protection Officer.' }),
  ).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Registers' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0)
})
