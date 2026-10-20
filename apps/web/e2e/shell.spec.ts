// The signed-in shell (T21; BUILD-PLAN C0.8, DESIGN-SHELL §9.4.5): its navigation at every size,
// real URLs, the not-found and error screens inside the frame, the avatar menu, one h1 per screen,
// no AI copy and no Search bar, and the boot's scroll-cache wipe on the built bundle. Signed in as
// the project's persona (Marcus in Chromium; Farah and Daniel for the @smoke cases in WebKit and
// Firefox).
import type { Page } from '@playwright/test'
import { noAiCopy, visibleH1s } from './support/checks.ts'
import { expect, type Guard, test } from './support/fixtures.ts'
import { hasRail, SCREENS, SIZES } from './support/viewports.ts'

const TABS = ['Today', 'Chats', 'Rooms', 'Tasks', 'More']
const RAIL = ['Today', 'Chats', 'Rooms', 'Tasks', 'Calendar', 'Drive']

const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Main' })
const h1 = (page: Page) => page.getByRole('heading', { level: 1 })

// The names of the shown Main navigation's links, in order.
const navNames = (page: Page) => mainNav(page).getByRole('link').allInnerTexts()

// The page's start time, which a new document changes.
const timeOrigin = (page: Page) => page.evaluate(() => performance.timeOrigin)

// The built More screen's chunk.
const MORE_CHUNK = /\/assets\/MoreScreen-[^/]+\.js$/

// What a screen whose chunk fails to load logs, besides the failed request: the browser's own line,
// and, on the first failure, the router's error for the module the preload helper hands back empty
// while preBoot()'s reload for a gone deploy is under way (main.ts, K-65): the page is replaced a
// moment later, and the reload is what the person sees.
function allowMissingChunk(guard: Guard): void {
  guard.allowFailedRequest(MORE_CHUNK)
  guard.allowConsole(/Failed to fetch dynamically imported module|error loading dynamically imported module/i)
  guard.allowConsole(/Cannot read properties of undefined \(reading 'MoreScreen'\)/)
}

test('SH-01 R-32 OD-02: under the rail breakpoint, five tabs in the bottom quarter with aria-current; at 1440 the rail six entries', {
  tag: '@smoke',
}, async ({ open }) => {
  const phone = await open({ ...SIZES.w390, signedIn: true, phone: true })
  await phone.goto('/chats')
  await expect(h1(phone)).toHaveText('Chats')
  expect((await navNames(phone)).map(name => name.trim())).toEqual(TABS)
  const box = await mainNav(phone).boundingBox()
  expect(box?.y ?? 0).toBeGreaterThanOrEqual(SIZES.w390.height * 0.75)
  await expect(mainNav(phone).getByRole('link', { name: 'Chats' })).toHaveAttribute('aria-current', 'page')
  await expect(mainNav(phone).locator('[aria-current]')).toHaveCount(1)

  const desktop = await open({ ...SIZES.desktop, signedIn: true })
  await desktop.goto('/chats')
  await expect(h1(desktop)).toHaveText('Chats')
  expect((await navNames(desktop)).map(name => name.trim())).toEqual(RAIL)
  await expect(mainNav(desktop).getByRole('link', { name: 'Chats' })).toHaveAttribute('aria-current', 'page')
})

test('SH-02 OD-30: 767 × 1024 tabs, 768 × 1024 rail, 1440 × 900 rail, 667 × 375 (a phone on its side) tabs', async ({
  page,
}) => {
  await page.goto('/today')
  await expect(h1(page)).toHaveText('Today')
  for (const size of [{ width: 767, height: 1024 }, SIZES.tablet, SIZES.desktop, SIZES.landscape]) {
    await page.setViewportSize(size)
    const names = (await navNames(page)).map(name => name.trim())
    expect(names, `${size.width} × ${size.height}`).toEqual(hasRail(size) ? RAIL : TABS)
    await expect(mainNav(page)).toHaveCount(1)
  }
})

test('SH-03 X12 R-40: every tab is a real URL; a deep link to /drive opens Drive; Back and Forward move between screens', async ({
  open,
}) => {
  const page = await open({ ...SIZES.w390, signedIn: true, phone: true })
  await page.goto('/drive')
  await expect(h1(page)).toHaveText('Drive')
  for (const [name, path] of [
    ['Today', '/today'],
    ['Chats', '/chats'],
    ['Rooms', '/rooms'],
    ['Tasks', '/tasks'],
    ['More', '/more'],
  ] as const) {
    await expect(mainNav(page).getByRole('link', { name })).toHaveAttribute('href', path)
  }
  await mainNav(page).getByRole('link', { name: 'Rooms' }).click()
  await expect(page).toHaveURL(/\/rooms$/)
  await expect(h1(page)).toHaveText('Rooms')
  await page.goBack()
  await expect(page).toHaveURL(/\/drive$/)
  await expect(h1(page)).toHaveText('Drive')
  await page.goForward()
  await expect(page).toHaveURL(/\/rooms$/)
  await expect(h1(page)).toHaveText('Rooms')
})

test('SH-04 OD-02: More lists Calendar and Drive on phones, and opening Calendar marks More current', async ({
  open,
}) => {
  const page = await open({ ...SIZES.w320, signedIn: true, phone: true })
  await page.goto('/more')
  await expect(h1(page)).toHaveText('More')
  const list = page.locator('#screen').getByRole('link')
  expect((await list.allInnerTexts()).map(name => name.trim())).toEqual(['Calendar', 'Drive'])
  await page.locator('#screen').getByRole('link', { name: 'Calendar' }).click()
  await expect(h1(page)).toHaveText('Calendar')
  // More holds the page, but isn't it: "true", never "page" (WCAG 4.1.2).
  await expect(mainNav(page).getByRole('link', { name: 'More' })).toHaveAttribute('aria-current', 'true')
  await expect(mainNav(page).locator('[aria-current]')).toHaveCount(1)
})

test('SH-05 OD-03: / lands on /chats', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/chats$/)
  await expect(h1(page)).toHaveText('Chats')
})

test('SH-06 OD-42 R-37: /xyz and /chats/abc show Page not found inside the shell (one h1, the tab bar or rail present) with a way to Chats', async ({
  open,
}) => {
  for (const size of [SIZES.w390, SIZES.desktop]) {
    const page = await open({ ...size, signedIn: true })
    for (const path of ['/xyz', '/chats/abc']) {
      await page.goto(path)
      await expect(h1(page)).toHaveText('Page not found')
      expect(await visibleH1s(page)).toEqual(['Page not found'])
      await expect(mainNav(page)).toHaveCount(1)
      // No entry claims a page that isn't its own.
      await expect(mainNav(page).locator('[aria-current]')).toHaveCount(0)
    }
    await page.locator('#screen').getByRole('link', { name: 'Go to Chats' }).click()
    await expect(page).toHaveURL(/\/chats$/)
    await expect(h1(page)).toHaveText('Chats')
  }
})

test('SH-07 R-34 R-35 OD-04 decision 8: no searchbox in the shell and no AI copy on any screen', async ({ open }) => {
  for (const size of [SIZES.w390, SIZES.desktop]) {
    const page = await open({ ...size, signedIn: true })
    for (const screen of SCREENS) {
      await page.goto(screen.path)
      await expect(h1(page)).toHaveText(screen.title)
      await expect(page.getByRole('searchbox')).toHaveCount(0)
      await expect(page.getByRole('search')).toHaveCount(0)
      expect(await noAiCopy(page), `${screen.path} at ${size.width}`).toEqual([])
    }
    // The avatar menu's items too.
    await page.getByRole('button', { name: /^Account, / }).click()
    await expect(page.getByRole('menu')).toBeVisible()
    expect(await noAiCopy(page), `the avatar menu at ${size.width}`).toEqual([])
  }
})

test('SH-08 OD-05 WCAG 2.4.11: the avatar menu holds Sign out only, and at 320 × 568, 768 × 480 (rail) and 1440 × 900 every item lies inside the viewport, and the point at its centre is the item', async ({
  open,
}) => {
  for (const size of [SIZES.w320, SIZES.short, SIZES.desktop]) {
    const page = await open({ ...size, signedIn: true })
    await page.goto('/chats')
    await expect(h1(page)).toHaveText('Chats')
    const trigger = page.getByRole('button', { name: 'Account, Marcus' })
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await trigger.click()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const items = page.getByRole('menu', { name: 'Account' }).getByRole('menuitem')
    expect((await items.allInnerTexts()).map(name => name.trim())).toEqual(['Sign out'])
    const placed = await items.evaluateAll(elements =>
      elements.map(element => {
        const box = element.getBoundingClientRect()
        const inside = box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return { inside, reached: hit !== null && (hit === element || element.contains(hit)) }
      }),
    )
    expect(placed, `${size.width} × ${size.height}`).toEqual([{ inside: true, reached: true }])
    await page.keyboard.press('Escape')
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await expect(trigger).toBeFocused()
  }
})

test('SH-09 D-08 X16: exactly one visible h1 on every screen at 320, 390 and 1440, naming the screen', async ({
  open,
}) => {
  for (const size of [SIZES.w320, SIZES.w390, SIZES.desktop]) {
    const page = await open({ ...size, signedIn: true })
    for (const screen of SCREENS) {
      await page.goto(screen.path)
      await expect(h1(page)).toHaveText(screen.title)
      expect(await visibleH1s(page), `${screen.path} at ${size.width}`).toEqual([screen.title])
      await expect(page).toHaveTitle(`${screen.title} – Hearth`)
    }
  }
})

test('SH-10 SHL-26 R-37: no window.__hearth, and nothing else the app hangs on window for tests', async ({ page }) => {
  await page.goto('/chats')
  await expect(h1(page)).toHaveText('Chats')
  const names = await page.evaluate(() => Object.keys(window).filter(name => /^__hearth|hearth/i.test(name)))
  expect(names).toEqual([])
})

test("SH-11 OD-42: a failed session check shows Can't reach Hearth, and Try again recovers", async ({
  page,
  guard,
}) => {
  guard.expectResponses([{ path: '/api/session', status: 503 }])
  let failed = false
  await page.route('**/api/session', async route => {
    if (failed) return route.continue()
    failed = true
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'unavailable', message: "That isn't available right now." }),
    })
  })
  await page.goto('/chats')
  await expect(h1(page)).toHaveText("Can't reach Hearth")
  await expect(mainNav(page)).toHaveCount(0)
  const before = await timeOrigin(page)
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(h1(page)).toHaveText('Chats')
  expect(await timeOrigin(page)).not.toBe(before)
})

test('SH-12 D-02 K-08 K-61: on the built bundle, a foreign scroll cache seeded before every load is gone after boot, and the router then writes its own with no trace of it', async ({
  open,
}) => {
  const page = await open({ ...SIZES.w390, signedIn: true })
  await page.addInitScript(() => {
    sessionStorage.setItem(
      'tsr-scroll-restoration-v1_3',
      JSON.stringify({ '/foreign-xyz': { window: { scrollX: 0, scrollY: 120 } } }),
    )
  })
  await page.goto('/chats')
  await expect(h1(page)).toHaveText('Chats')
  const cache = () =>
    page.evaluate(() =>
      Object.fromEntries(
        Object.keys(sessionStorage)
          .filter(key => key.startsWith('tsr-scroll-restoration'))
          .map(key => [key, sessionStorage.getItem(key)]),
      ),
    )
  // The boot removed it before the router loaded.
  expect(JSON.stringify(await cache())).not.toContain('foreign-xyz')
  // The router writes its whole cache on pagehide: the foreign entry is in none of it, and the key
  // name still matches what the boot removes.
  await mainNav(page).getByRole('link', { name: 'Tasks' }).click()
  await expect(h1(page)).toHaveText('Tasks')
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
  const written = await cache()
  expect(Object.keys(written).length).toBeGreaterThanOrEqual(1)
  expect(JSON.stringify(written)).not.toContain('foreign-xyz')
})

test('SH-13 OD-42 K-65: a screen whose code failed to load is recovered by Try again in a new document', async ({
  open,
  guard,
}) => {
  allowMissingChunk(guard)
  const page = await open({ ...SIZES.w390, signedIn: true, phone: true })
  await page.route(MORE_CHUNK, route => route.abort())
  await page.goto('/more')
  await expect(page.getByRole('heading', { level: 2, name: 'Something went wrong' })).toBeVisible({ timeout: 15_000 })
  await expect(h1(page)).toHaveText('More')
  await expect(mainNav(page)).toHaveCount(1)
  await page.unroute(MORE_CHUNK)
  const before = await timeOrigin(page)
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.locator('#screen').getByRole('link', { name: 'Calendar' })).toBeVisible()
  await expect(page.locator('#screen').getByRole('link', { name: 'Drive' })).toBeVisible()
  expect(await timeOrigin(page)).not.toBe(before)
})

test('SH-14 X11 WCAG 4.1.3: a screen that fails inside the shell is announced, with focus on its h1', async ({
  open,
  guard,
}) => {
  allowMissingChunk(guard)
  const page = await open({ ...SIZES.w390, signedIn: true, phone: true })
  await page.route(MORE_CHUNK, route => route.abort())
  await page.goto('/more')
  await expect(page.getByRole('heading', { level: 2, name: 'Something went wrong' })).toBeVisible({ timeout: 15_000 })
  await page.locator('#screen').getByRole('link', { name: 'Go to Chats' }).click()
  await expect(h1(page)).toHaveText('Chats')
  await mainNav(page).getByRole('link', { name: 'More' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Something went wrong' })).toBeVisible()
  await expect(h1(page)).toHaveText('More')
  await expect(h1(page)).toBeFocused()
  await expect(page.locator('[aria-live="assertive"]')).toHaveText(/Something went wrong/)
})
