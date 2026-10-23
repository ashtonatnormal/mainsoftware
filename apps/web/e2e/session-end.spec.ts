// A session is a document (T21 items 2 and 11, D-01; CHT-60, PRD-74, ACC-04, ACC-05, T19 item 10
// (7)). These end the storage states' sessions, so they run in the chromium-session-end project,
// after every other project has finished with them (T21 item 11), one at a time. Last, SE-05
// publishes a new version of the privacy notice in the seed's org, which every session then has to
// acknowledge before going on (C0.9 PD-39, PD-55): the project runs after chromium, webkit and
// firefox (playwright.config.ts), so no other project meets it.
import type { Page } from '@playwright/test'
import { NOTICE } from '../src/strings/notice.ts'
import { SIGN_IN } from '../src/strings/sign-in.ts'
import { recordAnnouncements } from './support/checks.ts'
import { logOffset, readCode } from './support/codes.ts'
import { E2E_ORIGIN, stateFile } from './support/env.ts'
import { expect, SESSION_401, test } from './support/fixtures.ts'
import { E2E_PIN, PERSONAS, typed } from './support/personas.ts'
import { recordMissingEntries } from './support/registers-api.ts'
import { signInWithPinViaApi } from './support/sign-in-api.ts'
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

// --- SE-05: a new version of the notice forces everyone to acknowledge it -----------------------

// Ashton, the seed's DPO, signed in afresh for SE-05 with his second code this run (personas.ts):
// a new session counts as re-authenticated for its first 5 minutes (§9.4), which the register
// writes and the publish need, and dpo.spec.ts's session is gone when this project runs alone
// (--no-deps).
const DPO_STATE = stateFile('session-end-ashton')
// /notice itself: /dpo/notice ends the same way.
const NOTICE_URL = new RegExp(`^${E2E_ORIGIN}/notice$`)

// Counts the welcome frames a page's sockets receive: one each time the live connection starts.
function countWelcomes(page: Page): () => number {
  let welcomes = 0
  page.on('websocket', socket => {
    socket.on('framereceived', frame => {
      if ((JSON.parse(String(frame.payload)) as { t?: string }).t === 'welcome') welcomes += 1
    })
  })
  return () => welcomes
}

test.describe('the forced re-acknowledgement', () => {
  // Before the timed part (B-13): the sign-in through the api, and the register writes that leave
  // the draft nothing holding it back (the seed's active purposes have no basis or retention).
  test.beforeAll(async () => {
    await signInWithPinViaApi(PERSONAS.ashton, E2E_PIN, DPO_STATE)
    await recordMissingEntries(DPO_STATE)
  })

  test('SE-05 PDPA-03 ACC-12 C0.9 PD-39 PD-45 PD-46 PD-55: the DPO publishes version 1 from the Notice tab at 390 px and lands on /notice; Kelvin’s two tabs both reach /notice within 30 s; the one he acknowledges in goes back to Chats and live, the other leaves /notice within 5 s; and the DPO, acknowledging, is back on the tab, which says the notice is up to date', async ({
    open,
    guard,
  }) => {
    // The budget: up to 30 s for Kelvin's tabs, each meeting its socket's periodic check (4403
    // within one check, at most 25 s; both wait at once), 5 s for the second tab, and the rest for
    // the pages, the publish and the acknowledgements, with room to spare on a slow runner.
    test.setTimeout(150_000)
    // After the publish, a request the DPO's pages make before he has acknowledged version 1 is
    // refused (403 notice_required) and takes the tab to /notice. Kelvin's pages ask only for what
    // the notice never holds back (the session, the flags, the notice itself), and his sockets are
    // closed with 4403, which is no HTTP answer.
    guard.expectResponses([
      { path: '/api/admin/notice', status: 403 },
      { path: '/api/admin/registers', status: 403 },
    ])

    // Kelvin, in two tabs of one browser, both live.
    const kelvin = await open({ ...SIZES.w390, signedIn: stateFile('live') })
    const kelvinLive = countWelcomes(kelvin)
    await kelvin.goto('/chats')
    await expect(h1(kelvin)).toHaveText('Chats')
    await expect.poll(kelvinLive).toBeGreaterThan(0)
    const other = await kelvin.context().newPage()
    const otherLive = countWelcomes(other)
    await other.goto('/rooms')
    await expect(h1(other)).toHaveText('Rooms')
    await expect.poll(otherLive).toBeGreaterThan(0)

    // The DPO publishes version 1 (the seed's version 0 is a placeholder) from his phone.
    const dpo = await open({ ...SIZES.w390, signedIn: DPO_STATE, phone: true })
    await dpo.goto('/dpo/notice')
    await expect(h1(dpo)).toHaveText('Publish the notice')
    await expect(dpo.getByRole('heading', { level: 2, name: 'Preview of version 1' })).toBeVisible()
    await dpo.getByRole('button', { name: 'Publish version 1', exact: true }).click()
    const confirm = dpo.getByRole('dialog', { name: 'Publish version 1?' })
    await expect(confirm).toContainText('Everyone, you included, acknowledges version 1')
    const published = dpo.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/notice/publish')
    await confirm.getByRole('button', { name: 'Publish version 1', exact: true }).click()
    expect((await published).status()).toBe(200)
    await expect(dpo).toHaveURL(NOTICE_URL)
    await expect(h1(dpo)).toHaveText('Privacy notice')
    await expect(dpo.getByText(/^Version 1 · published /)).toBeVisible()

    // Both of Kelvin's tabs are taken to /notice: the gateway admits nobody who hasn't acknowledged
    // the current version, and the next periodic check closes each socket with 4403 (PD-45).
    await Promise.all([
      expect(kelvin).toHaveURL(NOTICE_URL, { timeout: 30_000 }),
      expect(other).toHaveURL(NOTICE_URL, { timeout: 30_000 }),
    ])
    await expect(kelvin.getByText(/^Version 1 · published /)).toBeVisible()

    // He acknowledges in the first: back to Chats, and live again (a new connection, welcomed).
    const welcomed = kelvinLive()
    await kelvin.getByRole('checkbox', { name: NOTICE.confirm('1') }).check()
    await kelvin.getByRole('button', { name: NOTICE.acknowledge, exact: true }).click()
    await expect(kelvin).toHaveURL(/\/chats$/)
    await expect(h1(kelvin)).toHaveText('Chats')
    await expect.poll(kelvinLive).toBeGreaterThan(welcomed)
    // The other tab hears of it on the identity channel, asks GET /api/notice, and goes back to
    // Rooms (PD-46).
    await expect(other).toHaveURL(/\/rooms$/, { timeout: 5_000 })
    await expect(h1(other)).toHaveText('Rooms')

    // The DPO acknowledges too, and /notice takes him back to the Notice tab, which now says the
    // published notice is up to date.
    await dpo.getByRole('checkbox', { name: NOTICE.confirm('1') }).check()
    await dpo.getByRole('button', { name: NOTICE.acknowledge, exact: true }).click()
    await expect(dpo).toHaveURL(/\/dpo\/notice$/)
    await expect(dpo.getByRole('heading', { level: 2, name: 'The published notice' })).toBeVisible()
    await expect(dpo.getByText('It says what the registers say.', { exact: true })).toBeVisible()
    await expect(
      dpo.getByText(/^\d+ of the \d+ people at the organisation have acknowledged version 1\.$/),
    ).toBeVisible()
  })
})
