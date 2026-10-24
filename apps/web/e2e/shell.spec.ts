// The signed-in shell (BUILD-PLAN C0.8, T21 item 11): its navigation at every size,
// real URLs, the not-found and error screens inside the frame, the avatar menu, one h1 per screen,
// no AI copy and no Search bar, and the boot's scroll-cache wipe on the built bundle. Signed in as
// the project's persona (Marcus in Chromium; Farah and Daniel for the @smoke cases in WebKit and
// Firefox).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mailtoHref, NoticeResponse, telHref } from '@hearth/shared'
import type { Page } from '@playwright/test'
import { SETTINGS } from '../src/strings/notice.ts'
import { noAiCopy, noSidewaysScroll, targets44, visibleH1s } from './support/checks.ts'
import { REPO_DIR } from './support/env.ts'
import { expect, type Guard, test } from './support/fixtures.ts'
import { CONTACT_PHONE, PERSONAS } from './support/personas.ts'
import { hasRail, SCREENS, SIZES } from './support/viewports.ts'

const TABS = ['Today', 'Chats', 'Rooms', 'Tasks', 'More']
const RAIL = ['Today', 'Chats', 'Rooms', 'Tasks', 'Calendar', 'Drive']

const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Main' })
const h1 = (page: Page) => page.getByRole('heading', { level: 1 })

// The names of the shown Main navigation's links, in order.
const navNames = (page: Page) => mainNav(page).getByRole('link').allInnerTexts()

// The page's start time, which a new document changes.
const timeOrigin = (page: Page) => page.evaluate(() => performance.timeOrigin)

// What the libraries themselves put on window in the browser, never the app (SH-10): TanStack
// Router's router (router-core's router.js, for its devtools) and zod's global config and registry
// (zod/v4/core). Sorted.
const LIBRARY_GLOBALS = ['__TSR_ROUTER__', '__zod_globalConfig', '__zod_globalRegistry']

// The built More screen's chunk.
const MORE_CHUNK = /\/assets\/MoreScreen-[^/]+\.js$/

// What a screen whose chunk fails to load logs, besides the failed request: the browser's own line,
// and, on the first failure, the router's error for the module the preload helper hands back empty
// while preBoot()'s reload for a gone deploy is under way (main.ts, T21 item 2): the page is
// replaced a moment later, and the reload is what the person sees.
function allowMissingChunk(guard: Guard): void {
  guard.allowFailedRequest(MORE_CHUNK)
  guard.allowConsole(/Failed to fetch dynamically imported module|error loading dynamically imported module/i)
  guard.allowConsole(/Cannot read properties of undefined \(reading 'MoreScreen'\)/)
}

test('SH-01 OD-02: under the rail breakpoint, five tabs in the bottom quarter with aria-current; at 1440 the rail six entries', {
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

test('SH-02 T21 item 5: 767 × 1024 tabs, 768 × 1024 rail, 1440 × 900 rail, 667 × 375 (a phone on its side) tabs', async ({
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

test('SH-03 X12: every tab is a real URL; a deep link to /drive opens Drive; Back and Forward move between screens', async ({
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

test('SH-06 T21 item 5: /xyz and /chats/abc show Page not found inside the shell (one h1, the tab bar or rail present) with a way to Chats', async ({
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

test('SH-07 OD-04 decision 8: no searchbox in the shell and no AI copy on any screen', async ({ open }) => {
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

test('SH-08 OD-05 WCAG 2.4.11 C0.9 PD-47 B-09: the avatar menu holds Settings and Sign out, and at 320 × 568, 768 × 480 (rail) and 1440 × 900 every item lies inside the viewport, and the point at its centre is the item', async ({
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
    expect((await items.allInnerTexts()).map(name => name.trim())).toEqual(['Settings', 'Sign out'])
    const placed = await items.evaluateAll(elements =>
      elements.map(element => {
        const box = element.getBoundingClientRect()
        const inside = box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return { inside, reached: hit !== null && (hit === element || element.contains(hit)) }
      }),
    )
    expect(placed, `${size.width} × ${size.height}`).toEqual([
      { inside: true, reached: true },
      { inside: true, reached: true },
    ])
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

test('SH-10 SHL-26: no window.__hearth, and nothing else the app hangs on window for tests', async ({ page }) => {
  await page.goto('/chats')
  await expect(h1(page)).toHaveText('Chats')
  // The booted page's globals against a blank document's of the same origin in the same browser
  // (an iframe with no src, which inherits the page's origin), so the browser's own are left out,
  // whatever it exposes. Only the libraries' own may be added.
  const added = await page.evaluate(() => {
    const own = Object.keys(window)
    const frame = document.createElement('iframe')
    document.body.append(frame)
    const blank = new Set(Object.keys(frame.contentWindow ?? {}))
    frame.remove()
    return own.filter(name => !blank.has(name))
  })
  expect(added.sort()).toEqual(LIBRARY_GLOBALS)
})

test("SH-11 T21 item 5: a failed session check shows Can't reach Hearth, and Try again recovers", async ({
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

test('SH-12 D-02 T21 item 2: on the built bundle, a foreign scroll cache seeded before every load is gone after boot, and the router then writes its own with no trace of it', async ({
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

test('SH-13 T21 items 2 and 5: a screen whose code failed to load is recovered by Try again in a new document', async ({
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

// A contact a published version printed (C0.9 PD-69), made up: a long mailbox on a reserved domain,
// a business line no one in the seed or the personas holds, and a postal address of three lines.
const PLANTED_CONTACT = {
  title: 'Data Protection Officer',
  email: 'data-protection-officer@tembusu-holdings.example',
  phone: CONTACT_PHONE,
  postal: '1 Example Road\nUnit 01-01\nSingapore 000000',
}

// The seed's phone numbers, as db/seed/tembusu.sql makes them: a persona's prefix and each suffix
// of its phone_numbers insert.
function seedNumbers(): string[] {
  const seed = readFileSync(resolve(REPO_DIR, 'db/seed/tembusu.sql'), 'utf8')
  const insert = seed.slice(seed.indexOf('insert into public.phone_numbers'))
  const suffixes = /unnest\(array\[([^\]]*)\]\)/.exec(insert)?.[1]?.match(/\d+/g) ?? []
  const prefix = PERSONAS.marcus.e164.slice(0, -2)
  return suffixes.map(suffix => `${prefix}${suffix}`)
}

test('NTE-01 PDPA-02 PDPA-03 PDPA-13 C0.9 PD-47 OD-12 PD-69: Settings, from the avatar menu, lists Privacy; Privacy says first how to reach the Data Protection Officer (the seed’s notice gives no contact yet), then the current notice, when Marcus acknowledged it and his acknowledgements; with a contact the notice printed, its email address and phone number are links; at 320 and 1440 px with nothing sideways, 44 px targets and no AI copy', async ({
  open,
}) => {
  // The planted number is no one's: not a persona's, and not one the seed holds.
  const e164 = CONTACT_PHONE.replace(/[ -]/g, '')
  expect(Object.values(PERSONAS).map(persona => persona.e164)).not.toContain(e164)
  expect(seedNumbers().length).toBeGreaterThan(0)
  expect(seedNumbers()).not.toContain(e164)
  for (const size of [SIZES.w320, SIZES.desktop]) {
    const page = await open({ ...size, signedIn: true })
    await page.goto('/chats')
    await expect(h1(page)).toHaveText('Chats')
    await page.getByRole('button', { name: 'Account, Marcus' }).click()
    await page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name: 'Settings' }).click()
    await expect(page).toHaveURL(/\/settings$/)
    await expect(h1(page)).toHaveText('Settings')
    await expect(page).toHaveTitle('Settings – Hearth')
    const sections = page.getByRole('navigation', { name: SETTINGS.sections.label })
    await expect(sections.getByRole('link')).toHaveCount(1)
    expect(await noSidewaysScroll(page), `/settings at ${size.width}`).toEqual([])
    expect(await targets44(page), `/settings at ${size.width}`).toEqual([])
    expect(await noAiCopy(page), `/settings at ${size.width}`).toEqual([])

    await sections.getByRole('link', { name: /^Privacy/ }).click()
    await expect(page).toHaveURL(/\/settings\/privacy$/)
    await expect(h1(page)).toHaveText('Privacy')
    const screen = page.locator('#screen')
    // How to reach the DPO comes first (OD-12): the seed's placeholder gives no contact.
    await expect(screen.getByRole('heading', { level: 2 }).first()).toHaveText(SETTINGS.privacy.contact.title)
    await expect(screen.getByText(SETTINGS.privacy.contact.none, { exact: true })).toBeVisible()
    await expect(screen.getByRole('heading', { level: 2, name: SETTINGS.privacy.noticeTitle })).toBeVisible()
    // The seed's notice v0, which Marcus acknowledged in the app (db/seed/tembusu.sql).
    await expect(screen.getByText(/^Version 0 · published /)).toBeVisible()
    await expect(screen.getByText(/^You acknowledged version 0 on .+ \(in the app\)\.$/)).toBeVisible()
    await expect(screen.getByRole('heading', { level: 2, name: SETTINGS.privacy.historyTitle })).toBeVisible()
    await expect(screen.getByRole('listitem').filter({ hasText: /^Version 0, .+ \(in the app\)$/ })).toHaveCount(1)
    expect(await visibleH1s(page)).toEqual(['Privacy'])
    expect(await noSidewaysScroll(page), `/settings/privacy at ${size.width}`).toEqual([])
    expect(await targets44(page), `/settings/privacy at ${size.width}`).toEqual([])
    expect(await noAiCopy(page), `/settings/privacy at ${size.width}`).toEqual([])
    // Back returns to the list, a real URL each.
    await page.goBack()
    await expect(h1(page)).toHaveText('Settings')

    // A contact the latest version printed, planted in the real answer: the email address and the
    // phone number are links, at least 44 px, and the long address breaks rather than scrolling.
    await page.route('**/api/notice', async route => {
      if (route.request().method() !== 'GET') return route.fallback()
      const response = await route.fetch()
      const answer = NoticeResponse.parse(await response.json())
      return route.fulfill({ response, json: NoticeResponse.parse({ ...answer, contact: PLANTED_CONTACT }) })
    })
    await page.goto('/settings/privacy')
    await expect(screen.getByText(PLANTED_CONTACT.title, { exact: true })).toBeVisible()
    await expect(screen.getByRole('link', { name: PLANTED_CONTACT.email, exact: true })).toHaveAttribute(
      'href',
      mailtoHref(PLANTED_CONTACT.email),
    )
    await expect(screen.getByRole('link', { name: CONTACT_PHONE, exact: true })).toHaveAttribute(
      'href',
      telHref(CONTACT_PHONE),
    )
    await expect(screen.getByText('Singapore 000000')).toBeVisible()
    await expect(screen.getByText(SETTINGS.privacy.contact.leaving, { exact: true })).toBeVisible()
    expect(await noSidewaysScroll(page), `/settings/privacy with a contact at ${size.width}`).toEqual([])
    expect(await targets44(page), `/settings/privacy with a contact at ${size.width}`).toEqual([])
    expect(await noAiCopy(page), `/settings/privacy with a contact at ${size.width}`).toEqual([])
    await page.unroute('**/api/notice')
  }
})
