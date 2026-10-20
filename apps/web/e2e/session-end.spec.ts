// A session is a document (T21 items 2 and 11, D-01; CHT-60, PRD-74, ACC-04, ACC-05, T19 item 10
// (7)). These end the storage states' sessions, so they run in the chromium-session-end project,
// after every other project has finished with them (T21 item 11), one at a time.
import type { Page } from '@playwright/test'
import { SIGN_IN } from '../src/strings/sign-in.ts'
import { recordAnnouncements } from './support/checks.ts'
import { logOffset, readCode } from './support/codes.ts'
import { E2E_ORIGIN, stateFile } from './support/env.ts'
import { expect, SESSION_401, test } from './support/fixtures.ts'
import { PERSONAS, typed } from './support/personas.ts'
import { SIZES } from './support/viewports.ts'

test.describe.configure({ mode: 'serial' })

const h1 = (page: Page) => page.getByRole('heading', { level: 1 })
// The sign-in screen's reason line, inside <main>, not the announcer's copy, which sits outside.
const leftLine = (page: Page, text: string) => page.locator('main').getByText(text, { exact: true })
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

test('SE-01 SE-02 CHT-60 PRD-74 D-01 D-02 T21 item 2: with Marcus on /today → /chats, Sign out loads a new document, the cookie and scroll cache are gone, Back ends on sign-in with no trace of him; signing in as someone else in the same tab shows only them', async ({
  open,
  guard,
}) => {
  guard.expectResponses([SESSION_401])
  const page = await open({ ...SIZES.w390, signedIn: stateFile('chromium') })
  const said = await recordAnnouncements(page)
  await page.goto('/today')
  await expect(h1(page)).toHaveText('Today')
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Chats' }).click()
  await expect(h1(page)).toHaveText('Chats')
  const before = await timeOrigin(page)

  await signOutByMenu(page)
  await expect(page).toHaveURL(/\/sign-in$/)
  await expect(leftLine(page, SIGN_IN.signedOutHere)).toBeVisible()
  await expect.poll(said).toContain(SIGN_IN.signedOutHere)
  expect((await said()).filter(text => text === SIGN_IN.signedOutHere)).toHaveLength(1)
  expect(await timeOrigin(page)).not.toBe(before)
  const cookies = await page.context().cookies(E2E_ORIGIN)
  expect(cookies.map(cookie => cookie.name)).not.toContain('__Host-hearth_session')
  expect(await scrollKeys(page)).toEqual([])

  await page.goBack()
  await expect(page).toHaveURL(/\/sign-in$/)
  await expect(h1(page)).toHaveText(SIGN_IN.steps.phone)
  expect(await page.evaluate(() => document.body.innerText)).not.toContain('Marcus')

  // SE-02: the next person, in the same tab. Back asked for /today, which the signed-out document
  // kept as the path to open after sign-in (a path only, T21 item 5).
  await signInAsRachel(page)
  await expect(page).toHaveURL(/\/today$/)
  await expect(h1(page)).toHaveText('Today')
  await expect(page.getByRole('button', { name: 'Account, Rachel' })).toBeVisible()
  expect(await page.evaluate(() => document.body.innerText)).not.toContain('Marcus')
  expect(JSON.stringify(await page.evaluate(() => ({ ...sessionStorage })))).not.toContain('Marcus')
})

test('SE-03 T21 item 2 CHT-60: with Farah in two tabs of one browser, signing out in one sends the other to sign-in within 5 s', async ({
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

test("SE-04 ACC-04 ACC-05 T19 item 10 (7): with Daniel's one session in two browsers, signing out through the api in one closes the other's socket (4401), and it lands on sign-in within 10 s with You've been signed out.", async ({
  open,
  guard,
}) => {
  guard.expectResponses([SESSION_401, { path: '/api/flags', status: 401 }])
  const watcher = await open({ ...SIZES.w390, signedIn: stateFile('firefox') })
  const said = await recordAnnouncements(watcher)
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
  await expect(leftLine(watcher, SIGN_IN.signedOut)).toBeVisible()
  await expect(h1(watcher)).toBeFocused()
  await expect.poll(said).toContain(SIGN_IN.signedOut)
  expect((await said()).filter(text => text === SIGN_IN.signedOut)).toHaveLength(1)
  expect(closed).toBe(true)
})
