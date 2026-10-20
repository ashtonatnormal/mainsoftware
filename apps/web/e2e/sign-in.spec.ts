// Signing in, in a real browser against the real api (T20, T21; D46, AQ-02, OD-01, PRD-53, ACC-03;
// T21 items 11 and 13). Every page starts signed out.
// The api runs the fake provider, so a roster number's code is read from the api's log
// (support/codes.ts); a number off the roster gets the same answer and no text, so any code is wrong
// for it. Each test uses its own number (support/personas.ts), within PRD-53's windows.
import { MESSAGES } from '@hearth/shared'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { SIGN_IN } from '../src/strings/sign-in.ts'
import { expectAxeClean } from './support/axe.ts'
import { noAiCopy, recordAnnouncements } from './support/checks.ts'
import { logOffset, readCode } from './support/codes.ts'
import { expect, type Guard, SESSION_401, test } from './support/fixtures.ts'
import { E2E_PIN, PERSONAS, type Persona, SIGN_IN_PERSONAS, shown, typed, WRONG_PIN } from './support/personas.ts'
import { CHECK_SIZES, SCHEMES } from './support/viewports.ts'

test.use({ storageState: { cookies: [], origins: [] } })

// Every page here boots signed out (GET /api/session answers 401).
test.beforeEach(({ guard }) => guard.expectResponses([SESSION_401]))

const h1 = (page: Page) => page.getByRole('heading', { level: 1 })
const phoneField = (page: Page) => page.getByLabel('Mobile number')
const codeField = (page: Page) => page.getByLabel('6-digit code')
const main = (page: Page) => page.locator('main')
const timeOrigin = (page: Page) => page.evaluate(() => performance.timeOrigin)

// The phone step: types the number and sends it; answers the log's offset from before the send.
async function sendCode(page: Page, persona: Persona): Promise<number> {
  await expect(h1(page)).toHaveText(SIGN_IN.steps.phone)
  await phoneField(page).fill(typed(persona))
  const from = logOffset()
  await page.getByRole('button', { name: SIGN_IN.sendCode }).click()
  await expect(h1(page)).toHaveText(SIGN_IN.steps.code)
  return from
}

// The code step, for a roster number: reads its code from the api's log and signs in with it.
async function enterCode(page: Page, persona: Persona, from: number): Promise<void> {
  await codeField(page).fill(await readCode(persona.e164, from))
  await page.getByRole('button', { name: SIGN_IN.signIn, exact: true }).click()
}

// axe at each check size in both schemes on the step as it stands.
async function axeStep(page: Page, label: string, testInfo: TestInfo): Promise<void> {
  for (const size of CHECK_SIZES) {
    await page.setViewportSize(size)
    for (const scheme of SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme })
      await expectAxeClean(page, `${label} at ${size.width} ${scheme}`, testInfo)
    }
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize(CHECK_SIZES[0] ?? { width: 320, height: 568 })
}

// Signs out through the avatar menu, and waits for the sign-in screen's new document: its h1 has
// focus, the reason shows under it, and the announcer says the reason once (T21 item 13, X11).
async function signOut(page: Page): Promise<void> {
  const said = await recordAnnouncements(page)
  await page.getByRole('button', { name: /^Account, / }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/sign-in$/)
  await expect(main(page).getByText(SIGN_IN.signedOutHere, { exact: true })).toBeVisible()
  await expect(h1(page)).toBeFocused()
  await expect.poll(said).toContain(SIGN_IN.signedOutHere)
  expect((await said()).filter(text => text === SIGN_IN.signedOutHere)).toHaveLength(1)
}

// The description a control's aria-describedby names.
const descriptionOf = (control: Locator) =>
  control.evaluate(element =>
    (element.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .map(id => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim(),
  )

function declareWrongCode(guard: Guard): void {
  guard.expectResponses([{ path: '/api/auth/otp/verify', status: 401 }])
}

test('SI-01 OD-01 SHL-27 decision 8 T21 item 5: signed out, /tasks and /xyz go to /sign-in; the phone step is a real form (label, type tel, autocomplete tel, 16 px, novalidate), Enter submits, and both steps pass noAiCopy', async ({
  page,
}) => {
  for (const path of ['/tasks', '/xyz']) {
    await page.goto(path)
    await expect(page).toHaveURL(/\/sign-in$/)
    await expect(h1(page)).toHaveText(SIGN_IN.steps.phone)
  }
  const field = phoneField(page)
  await expect(field).toHaveAttribute('type', 'tel')
  await expect(field).toHaveAttribute('autocomplete', 'tel')
  expect(await field.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(
    16,
  )
  expect(await field.evaluate(element => (element as HTMLInputElement).form?.noValidate)).toBe(true)
  expect(await field.evaluate(element => (element as HTMLInputElement).form?.method)).toBe('post')
  expect(await noAiCopy(page)).toEqual([])
  await field.fill(typed(PERSONAS.si01))
  await field.press('Enter')
  await expect(h1(page)).toHaveText(SIGN_IN.steps.code)
  expect(await noAiCopy(page)).toEqual([])
})

test(
  'SI-02 OD-01 D-06 T21 item 5: from a signed-out deep link to /drive, a roster number signs in on its code alone and lands on Drive in a fresh document with its h1 focused; the return path came from sessionStorage, no URL carried a query, and a reload stays signed in',
  {
    tag: '@smoke',
  },
  async ({ page }, testInfo) => {
    const persona = SIGN_IN_PERSONAS[testInfo.project.name as keyof typeof SIGN_IN_PERSONAS]
    const urls: string[] = []
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) urls.push(frame.url())
    })
    await page.goto('/drive')
    await expect(page).toHaveURL(/\/sign-in$/)
    expect(await page.evaluate(() => sessionStorage.getItem('hearth:return-to'))).toBe('/drive')
    const before = await timeOrigin(page)
    const from = await sendCode(page, persona)
    // PRD-53: the code step's words are the template, whoever the number is.
    await expect(main(page).getByText(SIGN_IN.codeIntro(shown(persona), 6, 5))).toBeVisible()
    await enterCode(page, persona, from)
    await expect(page).toHaveURL(/\/drive$/)
    await expect(h1(page)).toHaveText('Drive')
    await expect(h1(page)).toBeFocused()
    expect(await timeOrigin(page)).not.toBe(before)
    expect(await page.evaluate(() => sessionStorage.getItem('hearth:return-to'))).toBeNull()
    await page.reload()
    await expect(h1(page)).toHaveText('Drive')
    expect(urls.filter(url => new URL(url).search !== '' || new URL(url).hash !== '')).toEqual([])
  },
)

test('SI-03 SI-05 SI-06 SI-07 WCAG 3.3.1 X6 PRD-53: each step focuses its h1 and sets the title; the code field takes 123 456 as 123456 and asks for one-time-code autofill; a wrong code shows the server message, sets aria-invalid and focuses the field; the copy is the template for any number; Use a different number keeps it', async ({
  page,
  guard,
}) => {
  declareWrongCode(guard)
  const persona = PERSONAS.offRoster
  await page.goto('/sign-in')
  await expect(page).toHaveTitle(`${SIGN_IN.titles.phone} – Hearth`)
  await sendCode(page, persona)
  await expect(h1(page)).toBeFocused()
  await expect(page).toHaveTitle(`${SIGN_IN.steps.code} – Hearth`)
  await expect(main(page).getByText(SIGN_IN.codeIntro(shown(persona), 6, 5))).toBeVisible()

  const field = codeField(page)
  await expect(field).toHaveAttribute('autocomplete', 'one-time-code')
  await expect(field).toHaveAttribute('inputmode', 'numeric')
  await field.fill('123 456')
  await expect(field).toHaveValue('123456')
  await page.getByRole('button', { name: SIGN_IN.signIn, exact: true }).click()
  await expect(field).toHaveAttribute('aria-invalid', 'true')
  await expect(field).toBeFocused()
  expect(await descriptionOf(field)).toContain(MESSAGES.code_wrong)

  await page.getByRole('button', { name: SIGN_IN.differentNumber }).click()
  await expect(h1(page)).toHaveText(SIGN_IN.steps.phone)
  await expect(h1(page)).toBeFocused()
  await expect(phoneField(page)).toHaveValue(typed(persona))
})

test("SI-04 ACC-01: a number the shared normaliser can't read shows invalid_phone's message on the field, and nothing is sent", async ({
  page,
}) => {
  const sent: string[] = []
  page.on('request', request => {
    if (request.url().includes('/api/auth/')) sent.push(request.url())
  })
  await page.goto('/sign-in')
  await expect(h1(page)).toHaveText(SIGN_IN.steps.phone)
  await phoneField(page).fill('12345')
  await phoneField(page).press('Enter')
  await expect(phoneField(page)).toHaveAttribute('aria-invalid', 'true')
  expect(await descriptionOf(phoneField(page))).toContain(MESSAGES.invalid_phone)
  await expect(h1(page)).toHaveText(SIGN_IN.steps.phone)
  expect(sent).toEqual([])
})

test('SI-08 SHL-07 X11 PRD-53 T21 item 13: Send a new code is aria-disabled with its reason for 30 s, then said once, and sends one request, whose new code is shown and said once', async ({
  page,
}) => {
  await page.clock.install()
  const said = await recordAnnouncements(page)
  const requests: string[] = []
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/auth/otp/request') requests.push(request.method())
  })
  await page.goto('/sign-in')
  await sendCode(page, PERSONAS.si08)
  const resend = page.getByRole('button', { name: SIGN_IN.resend })
  await expect(resend).toHaveAttribute('aria-disabled', 'true')
  expect(await descriptionOf(resend)).toContain(SIGN_IN.resendWait)
  // A press while it waits does nothing (force: Playwright would otherwise wait for it to be enabled).
  await resend.click({ force: true })
  await page.waitForTimeout(500)
  expect(requests).toHaveLength(1)

  await page.clock.runFor(31_000)
  await expect(resend).not.toHaveAttribute('aria-disabled', 'true')
  await expect.poll(said).toContain(SIGN_IN.resendReady)
  expect((await said()).filter(text => text === SIGN_IN.resendReady)).toHaveLength(1)
  await resend.click()
  await expect.poll(() => requests.length).toBe(2)
  await expect(h1(page)).toHaveText(SIGN_IN.steps.code)
  // Held again for the next 30 s.
  await expect(resend).toHaveAttribute('aria-disabled', 'true')
  // The new code is shown on the step as well as said, and said once.
  await expect(main(page).getByText(SIGN_IN.newCode, { exact: true })).toBeVisible()
  await expect.poll(said).toContain(SIGN_IN.newCode)
  expect((await said()).filter(text => text === SIGN_IN.newCode)).toHaveLength(1)
})

test(
  'SI-09 AQ-02 D46 ACC-02: a PIN-role holder’s code leads to Choose a PIN, which signs in; after Sign out, the next code leads to Enter your PIN, and the same PIN signs in; axe finds nothing serious on either PIN step',
  {
    tag: '@pin',
  },
  async ({ page }, testInfo) => {
    const priya = PERSONAS.priya
    await page.goto('/sign-in')
    let from = await sendCode(page, priya)
    await enterCode(page, priya, from)
    await expect(h1(page)).toHaveText(SIGN_IN.steps.set_pin)
    await expect(h1(page)).toBeFocused()
    await expect(main(page).getByText(SIGN_IN.setPinWhy)).toBeVisible()
    const newPin = page.getByLabel(SIGN_IN.newPin, { exact: true })
    await expect(newPin).toHaveAttribute('autocomplete', 'new-password')
    await expect(newPin).toHaveAttribute('type', 'password')
    await axeStep(page, 'Choose a PIN', testInfo)
    expect(await noAiCopy(page)).toEqual([])
    await newPin.fill(E2E_PIN)
    await page.getByLabel(SIGN_IN.newPinAgain, { exact: true }).fill(E2E_PIN)
    await page.getByRole('button', { name: SIGN_IN.setPin }).click()
    await expect(page).toHaveURL(/\/chats$/)
    await expect(h1(page)).toHaveText('Chats')
    await expect(page.getByRole('button', { name: 'Account, Priya' })).toBeVisible()

    await signOut(page)
    from = await sendCode(page, priya)
    await enterCode(page, priya, from)
    await expect(h1(page)).toHaveText(SIGN_IN.steps.enter_pin)
    const pin = page.getByLabel(SIGN_IN.pinLabel, { exact: true })
    await expect(pin).toHaveAttribute('autocomplete', 'current-password')
    // Forgotten your PIN? keeps the list-item display that draws its disclosure marker.
    await expect(main(page).locator('summary', { hasText: SIGN_IN.forgotPin })).toHaveCSS('display', 'list-item')
    await axeStep(page, 'Enter your PIN', testInfo)
    expect(await noAiCopy(page)).toEqual([])
    await pin.fill(E2E_PIN)
    await page.getByRole('button', { name: SIGN_IN.signIn, exact: true }).click()
    await expect(page).toHaveURL(/\/chats$/)
    await expect(h1(page)).toHaveText('Chats')
    await expect(page.getByRole('button', { name: 'Account, Priya' })).toBeVisible()
  },
)

test('SI-10 ACC-03: a roster number with no account yet (Nadia) signs in on its code, which makes the account, and reaches Chats', async ({
  page,
}) => {
  const nadia = PERSONAS.nadia
  await page.goto('/sign-in')
  const from = await sendCode(page, nadia)
  await enterCode(page, nadia, from)
  await expect(page).toHaveURL(/\/chats$/)
  await expect(h1(page)).toHaveText('Chats')
  await expect(page.getByRole('button', { name: 'Account, Nadia' })).toBeVisible()
})

test(
  'SI-11 AQ-02 PRD-53 T14 item 9: after a PIN-role holder sets a PIN and signs out, each wrong PIN says how many tries are left, the 5th shows the locked view with its end time, which passes axe, and Start again goes back to the phone step',
  {
    tag: '@pin',
  },
  async ({ page, guard }, testInfo) => {
    guard.expectResponses([
      { path: '/api/auth/pin/verify', status: 401 },
      { path: '/api/auth/pin/verify', status: 423 },
    ])
    const weiLing = PERSONAS.weiLing
    await page.goto('/sign-in')
    let from = await sendCode(page, weiLing)
    await enterCode(page, weiLing, from)
    await expect(h1(page)).toHaveText(SIGN_IN.steps.set_pin)
    await page.getByLabel(SIGN_IN.newPin, { exact: true }).fill(E2E_PIN)
    await page.getByLabel(SIGN_IN.newPinAgain, { exact: true }).fill(E2E_PIN)
    await page.getByRole('button', { name: SIGN_IN.setPin }).click()
    await expect(h1(page)).toHaveText('Chats')

    await signOut(page)
    from = await sendCode(page, weiLing)
    await enterCode(page, weiLing, from)
    await expect(h1(page)).toHaveText(SIGN_IN.steps.enter_pin)
    const pin = page.getByLabel(SIGN_IN.pinLabel, { exact: true })
    for (let left = 4; left >= 1; left--) {
      await pin.fill(WRONG_PIN)
      await page.getByRole('button', { name: SIGN_IN.signIn, exact: true }).click()
      await expect(pin).toHaveAttribute('aria-invalid', 'true')
      await expect.poll(() => descriptionOf(pin)).toContain(MESSAGES.pin_wrong)
      expect(await descriptionOf(pin)).toContain(SIGN_IN.pinTries(left, false))
    }
    await pin.fill(WRONG_PIN)
    await page.getByRole('button', { name: SIGN_IN.signIn, exact: true }).click()
    await expect(h1(page)).toHaveText(SIGN_IN.steps.pin_locked)
    await expect(main(page).getByText(SIGN_IN.lockedTimed)).toBeVisible()
    await expect(main(page).getByText(/^The lock ends at /)).toBeVisible()
    await axeStep(page, 'the locked view', testInfo)
    await page.getByRole('button', { name: SIGN_IN.startAgain }).click()
    await expect(h1(page)).toHaveText(SIGN_IN.steps.phone)
  },
)
