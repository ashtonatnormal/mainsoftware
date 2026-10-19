// The shell by keyboard alone (T21; SHL-42, X6, X10, X12, QA-05, WCAG 2.1.1, 2.4.1, 2.4.3, 2.4.7;
// DESIGN-SHELL §9.4.5). Signed in as the project's persona (Marcus). No case here presses Sign out:
// the session is shared with the other specs.
import type { Page } from '@playwright/test'
import { expect, test } from './support/fixtures.ts'
import { SIZES } from './support/viewports.ts'

const h1 = (page: Page) => page.getByRole('heading', { level: 1 })
const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Main' })

// The focused element's name as a person hears it: its aria-label, else its text.
const focusedName = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null
    if (element === null || element === document.body) return '(body)'
    return (element.getAttribute('aria-label') ?? element.innerText ?? '').trim()
  })

// The names focus lands on, one Tab at a time, from the top of the page, until it comes round.
async function tabOrder(page: Page, stops: number): Promise<string[]> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const names: string[] = []
  for (let stop = 0; stop < stops; stop++) {
    await page.keyboard.press('Tab')
    names.push(await focusedName(page))
  }
  return names
}

test('KB-01 SHL-42: the skip link is the first Tab stop, shows on focus and moves focus to main', async ({ open }) => {
  const page = await open({ ...SIZES.w390, signedIn: true })
  await page.goto('/chats')
  await expect(h1(page)).toHaveText('Chats')
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Tab')
  const skip = page.getByRole('link', { name: 'Skip to content' })
  await expect(skip).toBeFocused()
  const box = await skip.boundingBox()
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(box?.width ?? 0).toBeGreaterThan(44)
  await page.keyboard.press('Enter')
  await expect(page.locator('main#main')).toBeFocused()
  // The press moved focus without a fragment navigation.
  await expect(page).toHaveURL(/\/chats$/)
})

test('KB-02 X6 SHL-42: a tab navigation focuses the new h1 and sets the document title', async ({ open }) => {
  const page = await open({ ...SIZES.w390, signedIn: true })
  await page.goto('/chats')
  await expect(h1(page)).toHaveText('Chats')
  await mainNav(page).getByRole('link', { name: 'Rooms' }).focus()
  await page.keyboard.press('Enter')
  await expect(h1(page)).toHaveText('Rooms')
  await expect(h1(page)).toBeFocused()
  await expect(page).toHaveTitle('Rooms – Hearth')
})

test('KB-03 WCAG 2.4.3: focus order is the skip link, the avatar, the screen, the tabs on a phone; the skip link, the rail, the avatar, the screen at 1440', async ({
  open,
}) => {
  const phone = await open({ ...SIZES.w390, signedIn: true })
  await phone.goto('/more')
  await expect(h1(phone)).toHaveText('More')
  expect(await tabOrder(phone, 9)).toEqual([
    'Skip to content',
    'Account, Marcus',
    'Calendar',
    'Drive',
    'Today',
    'Chats',
    'Rooms',
    'Tasks',
    'More',
  ])

  const desktop = await open({ ...SIZES.desktop, signedIn: true })
  await desktop.goto('/more')
  await expect(h1(desktop)).toHaveText('More')
  expect(await tabOrder(desktop, 10)).toEqual([
    'Skip to content',
    'Today',
    'Chats',
    'Rooms',
    'Tasks',
    'Calendar',
    'Drive',
    'Account, Marcus',
    'Calendar',
    'Drive',
  ])
})

test('KB-04 X10: the avatar menu opens with Enter, Space and ArrowDown, moves with arrows, Home, End and typeahead; Escape returns focus; Tab closes it', async ({
  open,
}) => {
  const page = await open({ ...SIZES.w390, signedIn: true })
  await page.goto('/chats')
  await expect(h1(page)).toHaveText('Chats')
  const trigger = page.getByRole('button', { name: 'Account, Marcus' })
  const menu = page.getByRole('menu', { name: 'Account' })
  const signOut = menu.getByRole('menuitem', { name: 'Sign out' })

  for (const key of ['Enter', ' ', 'ArrowDown', 'ArrowUp']) {
    await trigger.focus()
    await page.keyboard.press(key)
    await expect(menu, key).toBeVisible()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await expect(signOut, key).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu, key).toBeHidden()
    await expect(trigger, key).toBeFocused()
  }

  // One item: the arrows wrap to it, Home and End stay on it, and its first letter finds it.
  await trigger.focus()
  await page.keyboard.press('ArrowDown')
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 's']) {
    await page.keyboard.press(key)
    await expect(signOut, key).toBeFocused()
    await expect(menu, key).toBeVisible()
  }
  // Only the active item is in the tab order, so Tab leaves the menu in one step, and it closes.
  await expect(signOut).toHaveAttribute('tabindex', '0')
  await page.keyboard.press('Tab')
  await expect(menu).toBeHidden()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  // Focus went on to what follows the menu: the screen holds nothing focusable, so the first tab.
  await expect(mainNav(page).getByRole('link', { name: 'Today' })).toBeFocused()
})

test('KB-05 QA-05: a tab focus ring lies inside its cell', async ({ open }) => {
  const page = await open({ ...SIZES.w320, signedIn: true })
  await page.goto('/chats')
  await expect(h1(page)).toHaveText('Chats')
  const today = mainNav(page).getByRole('link', { name: 'Today' })
  // Reach it by keyboard, so :focus-visible applies.
  await page.getByRole('button', { name: 'Account, Marcus' }).focus()
  await page.keyboard.press('Tab')
  await expect(today).toBeFocused()
  const ring = await today.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      style: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
      offset: Number.parseFloat(style.outlineOffset),
    }
  })
  expect(ring.style).not.toBe('none')
  expect(ring.width).toBeGreaterThan(0)
  // The ring is drawn from `offset` outside the box outward by its width: inside the box when the
  // two add up to no more than 0.
  expect(ring.offset + ring.width).toBeLessThanOrEqual(0)
})

test('KB-06 X6 X12: after a tab press leaves focus on the h1 (Chats → Rooms), Back focuses a new h1 reading Chats, and Forward one reading Rooms', async ({
  open,
}) => {
  const page = await open({ ...SIZES.w390, signedIn: true })
  await page.goto('/chats')
  await expect(h1(page)).toHaveText('Chats')
  await page.evaluate(() => {
    const seen: string[] = []
    ;(window as unknown as { e2eHeadingFocus: string[] }).e2eHeadingFocus = seen
    document.addEventListener('focusin', event => {
      if (event.target instanceof HTMLHeadingElement && event.target.tagName === 'H1') {
        seen.push((event.target.textContent ?? '').trim())
      }
    })
  })
  const seen = () => page.evaluate(() => (window as unknown as { e2eHeadingFocus: string[] }).e2eHeadingFocus)
  await mainNav(page).getByRole('link', { name: 'Rooms' }).click()
  await expect(h1(page)).toBeFocused()
  await expect(h1(page)).toHaveText('Rooms')
  await page.goBack()
  await expect(h1(page)).toHaveText('Chats')
  await expect(h1(page)).toBeFocused()
  await page.goForward()
  await expect(h1(page)).toHaveText('Rooms')
  await expect(h1(page)).toBeFocused()
  await expect.poll(seen).toEqual(['Rooms', 'Chats', 'Rooms'])
})
