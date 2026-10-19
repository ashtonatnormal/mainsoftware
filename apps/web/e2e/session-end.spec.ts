// A session is a document (T21, D-01; R-42, R-43, CHT-60, PRD-74, K-07–K-10, ACC-04, ACC-05,
// T19 item 10 (7); DESIGN-SHELL §9.4.5). These end the storage states' sessions, so they run in the
// chromium-session-end project, after every other project has finished with them (K-21), one at a
// time.
import type { Page } from '@playwright/test'
import { SIGN_IN } from '../src/strings/sign-in.ts'
import { logOffset, readCode } from './support/codes.ts'
import { E2E_ORIGIN, stateFile } from './support/env.ts'
import { expect, SESSION_401, test } from './support/fixtures.ts'
import { PERSONAS, typed } from './support/personas.ts'
import { SIZES } from './support/viewports.ts'

test.describe.configure({ mode: 'serial' })

const h1 = (page: Page) => page.getByRole('heading', { level: 1 })
const timeOrigin = (page: Page) => page.evaluate(() => performance.timeOrigin)
const scrollKeys = (page: Page) =>
  page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('tsr-scroll-restoration')))

async function signOutByMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Account, / }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
}

// Rachel's sign-in through the screen, for SE-02 (her number's second request this run).
async function signInAsRachel(page: Page): Promise<void> {
  const rachel = PERSONAS.rachel
  await page.getByLabel('Mobile number').fill(typed(rachel))
  const from = logOffset()
  await page.getByRole('button', { name: SIGN_IN.sendCode }).click()
  await expect(h1(page)).toHaveText(SIGN_IN.steps.code)
  await page.getByLabel('6-digit code').fill(await readCode(rachel.e164, from))
  await page.getByRole('button', { name: SIGN_IN.signIn, exact: true }).click()
}

test('SE-01 SE-02 R-42 CHT-60 PRD-74 K-07 K-08 K-09: with Marcus on /today → /chats, Sign out loads a new document, the cookie and scroll cache are gone, Back ends on sign-in with no trace of him; signing in as someone else in the same tab shows only them', async ({
  open,
  guard,
}) => {
  guard.expectResponses([SESSION_401])
  const page = await open({ ...SIZES.w390, signedIn: stateFile('chromium') })
  await page.goto('/today')
  await expect(h1(page)).toHaveText('Today')
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Chats' }).click()
  await expect(h1(page)).toHaveText('Chats')
  const before = await timeOrigin(page)

  await signOutByMenu(page)
  await expect(page).toHaveURL(/\/sign-in$/)
  await expect(page.getByRole('status')).toHaveText(SIGN_IN.signedOutHere)
  expect(await timeOrigin(page)).not.toBe(before)
  const cookies = await page.context().cookies(E2E_ORIGIN)
  expect(cookies.map(cookie => cookie.name)).not.toContain('__Host-hearth_session')
  expect(await scrollKeys(page)).toEqual([])

  await page.goBack()
  await expect(page).toHaveURL(/\/sign-in$/)
  await expect(h1(page)).toHaveText(SIGN_IN.steps.phone)
  expect(await page.evaluate(() => document.body.innerText)).not.toContain('Marcus')

  // SE-02: the next person, in the same tab. Back asked for /today, which the signed-out document
  // kept as the path to open after sign-in (a path only, R-44).
  await signInAsRachel(page)
  await expect(page).toHaveURL(/\/today$/)
  await expect(h1(page)).toHaveText('Today')
  await expect(page.getByRole('button', { name: 'Account, Rachel' })).toBeVisible()
  expect(await page.evaluate(() => document.body.innerText)).not.toContain('Marcus')
  expect(JSON.stringify(await page.evaluate(() => ({ ...sessionStorage })))).not.toContain('Marcus')
})

test('SE-03 K-10 CHT-60: with Farah in two tabs of one browser, signing out in one sends the other to sign-in within 5 s', async ({
  open,
  guard,
}) => {
  // The other tab may ask for something in the moment its session is gone.
  guard.expectResponses([SESSION_401, { path: '/api/flags', status: 401 }])
  const first = await open({ ...SIZES.w390, signedIn: stateFile('webkit') })
  await first.goto('/chats')
  await expect(h1(first)).toHaveText('Chats')
  const second = await first.context().newPage()
  await second.goto('/rooms')
  await expect(h1(second)).toHaveText('Rooms')
  await expect(second.getByRole('button', { name: 'Account, Farah' })).toBeAttached()

  await signOutByMenu(first)
  await expect(first).toHaveURL(/\/sign-in$/)
  await expect(second).toHaveURL(/\/sign-in$/, { timeout: 5_000 })
  await expect(h1(second)).toHaveText(SIGN_IN.steps.phone)
})

test("SE-04 R-43 ACC-04 ACC-05 T19 item 10 (7): with Daniel's one session in two browsers, signing out through the api in one closes the other's socket (4401), and it lands on sign-in within 10 s with You've been signed out.", async ({
  open,
  guard,
}) => {
  guard.expectResponses([SESSION_401, { path: '/api/flags', status: 401 }])
  const watcher = await open({ ...SIZES.w390, signedIn: stateFile('firefox') })
  let acked = false
  let closed = false
  watcher.on('websocket', socket => {
    socket.on('framereceived', frame => {
      if (String(frame.payload).includes('"t":"ack"')) acked = true
    })
    socket.on('close', () => {
      closed = true
    })
  })
  await watcher.goto('/chats')
  await expect(h1(watcher)).toHaveText('Chats')
  await expect.poll(() => acked).toBe(true)

  const other = await open({ ...SIZES.w390, signedIn: stateFile('firefox') })
  const answer = await other.request.post('/api/auth/sign-out', { data: {}, headers: { origin: E2E_ORIGIN } })
  expect(answer.status()).toBe(200)

  await expect(watcher).toHaveURL(/\/sign-in$/, { timeout: 10_000 })
  await expect(watcher.getByRole('status')).toHaveText(SIGN_IN.signedOut)
  expect(closed).toBe(true)
})
