// What the suite checks on a screen as it stands (T21; NFR-02, PRD-66, WCAG 2.2 AA, decision 8;
// DESIGN-SHELL §9.4.4). Each reads the page in the browser and answers a list of what is wrong,
// empty when nothing is, so a failure names every offender at once: expect(await check(page)).toEqual([]).
import type { Page } from '@playwright/test'
import { AI_COPY } from '../../src/strings/ai-copy.ts'

// What can be pressed or typed in: links, buttons, form controls and anything else in the tab order.
const INTERACTIVE = [
  'a[href]',
  'button',
  'input:not([type=hidden])',
  'select',
  'textarea',
  'summary',
  '[role=button]',
  '[role=link]',
  '[role=menuitem]',
  '[role=radio]',
  '[role=switch]',
  '[role=tab]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

// NF-01 WCAG 1.4.10: nothing scrolls sideways: not the document, and no shown element reaches past
// the viewport's right edge (a pixel's rounding aside).
export function noSidewaysScroll(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = []
    const root = document.documentElement
    if (root.scrollWidth > root.clientWidth) problems.push(`the document is ${root.scrollWidth} px wide`)
    for (const element of document.body.querySelectorAll<HTMLElement>('*')) {
      if (!element.checkVisibility({ checkVisibilityCSS: true })) continue
      const box = element.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) continue
      if (box.right > window.innerWidth + 1) {
        const text = (element.textContent ?? '').trim().slice(0, 30)
        problems.push(`<${element.tagName.toLowerCase()}> "${text}" ends at ${Math.round(box.right)} px`)
      }
    }
    return problems
  })
}

// NF-02 X7 K-58: every shown interactive element is at least 44 × 44 CSS px. A native input hidden
// visually (a Switch's checkbox) is measured by its label's box; a link inline in a paragraph is
// exempt (WCAG 2.5.8's inline exception).
export function targets44(page: Page): Promise<string[]> {
  return page.evaluate(selector => {
    const problems: string[] = []
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      if (!element.checkVisibility({ checkVisibilityCSS: true })) continue
      if (element.closest('[hidden], [inert]')) continue
      if (element.matches('p a')) continue
      let box = element.getBoundingClientRect()
      const hiddenVisually = box.width <= 1 && box.height <= 1
      if (hiddenVisually) {
        const label = element instanceof HTMLInputElement ? element.labels?.[0] : undefined
        // A skip link or other visually hidden control shows itself when focused (keyboard.spec).
        if (label === undefined || label === null) continue
        box = label.getBoundingClientRect()
      }
      if (box.width + 0.5 < 44 || box.height + 0.5 < 44) {
        const name = element.getAttribute('aria-label') ?? (element.textContent ?? '').trim().slice(0, 30)
        problems.push(
          `<${element.tagName.toLowerCase()}> "${name}" is ${Math.round(box.width)} × ${Math.round(box.height)}`,
        )
      }
    }
    return problems
  }, INTERACTIVE)
}

// NF-03 X7 SHL-28: every shown text input, select and text area is at least 16 px, so iOS doesn't
// zoom in on focus.
export function inputs16(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = []
    const fields = document.querySelectorAll<HTMLElement>(
      'input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea',
    )
    for (const field of fields) {
      if (!field.checkVisibility({ checkVisibilityCSS: true })) continue
      const size = Number.parseFloat(getComputedStyle(field).fontSize)
      if (size < 16) problems.push(`<${field.tagName.toLowerCase()} name=${field.getAttribute('name')}> is ${size} px`)
    }
    return problems
  })
}

// NF-04 PRD-66: the shown "Main" navigation sits in the bottom `fraction` of the viewport.
export function navInBottom(page: Page, fraction = 0.25): Promise<string[]> {
  return page.evaluate(share => {
    const navs = [...document.querySelectorAll<HTMLElement>('nav[aria-label="Main"]')].filter(nav =>
      nav.checkVisibility({ checkVisibilityCSS: true }),
    )
    if (navs.length !== 1) return [`${navs.length} Main navigations are shown`]
    const top = navs[0]?.getBoundingClientRect().top ?? 0
    const line = window.innerHeight * (1 - share)
    return top >= line ? [] : [`the tab bar starts at ${Math.round(top)} px, above ${Math.round(line)} px`]
  }, fraction)
}

// SH-09 D-08 X16: the h1s that are shown (a visually hidden one counts: a screen reader reads it).
export function visibleH1s(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('h1')]
      .filter(heading => heading.checkVisibility({ checkVisibilityCSS: true }))
      .map(heading => (heading.textContent ?? '').trim()),
  )
}

// NF-07 WCAG 2.4.11: Tab through everything focusable; each element focus lands on lies inside the
// viewport, and the point at its centre is the element itself or inside it, so nothing (a toast, a
// bar) covers it. Stops when focus comes back round or leaves the page.
export async function focusNeverObscured(page: Page, maxStops = 40): Promise<string[]> {
  const problems: string[] = []
  const seen: string[] = []
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  for (let stop = 0; stop < maxStops; stop++) {
    await page.keyboard.press('Tab')
    const where = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null
      if (element === null || element === document.body) return undefined
      const box = element.getBoundingClientRect()
      const name = `${element.tagName.toLowerCase()} "${(element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 30)}"`
      const inside = box.top >= 0 && box.left >= 0 && box.bottom <= window.innerHeight && box.right <= window.innerWidth
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      const reached = hit !== null && (hit === element || element.contains(hit))
      const id = `${name}@${Math.round(box.top)},${Math.round(box.left)}`
      return { id, name, inside, reached }
    })
    if (where === undefined) break
    if (seen.includes(where.id)) break
    seen.push(where.id)
    if (!where.inside) problems.push(`${where.name} is focused outside the viewport`)
    else if (!where.reached) problems.push(`${where.name} is focused under something else`)
  }
  if (seen.length === 0) problems.push('Tab focused nothing')
  return problems
}

// NF-08 WCAG 1.4.12: the text spacing a reader's own style sheet may set. Needs a bypassCSP context:
// the app's CSP blocks an injected <style>.
export async function withTextSpacing(page: Page): Promise<void> {
  await page.addStyleTag({
    content:
      '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }',
  })
}

// NF-09 WCAG 1.4.4: text at `factor` times its size (rem-based, as the kit is). bypassCSP, as above.
export async function withTextZoom(page: Page, factor: number): Promise<void> {
  await page.addStyleTag({ content: `html { font-size: ${factor * 100}% !important; }` })
}

// NF-08 NF-09: no shown text is cut off by a box that hides its overflow (a visually hidden element,
// clipped on purpose, aside).
export function noClippedText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = []
    for (const element of document.body.querySelectorAll<HTMLElement>('*')) {
      if (!element.checkVisibility({ checkVisibilityCSS: true })) continue
      if ((element.textContent ?? '').trim() === '') continue
      const style = getComputedStyle(element)
      const clips = (value: string) => value === 'hidden' || value === 'clip'
      if (!clips(style.overflowX) && !clips(style.overflowY)) continue
      const box = element.getBoundingClientRect()
      if (box.width <= 1 && box.height <= 1) continue
      const wide = clips(style.overflowX) && element.scrollWidth > element.clientWidth + 1
      const tall = clips(style.overflowY) && element.scrollHeight > element.clientHeight + 1
      if (wide || tall) {
        problems.push(
          `<${element.tagName.toLowerCase()}> "${(element.textContent ?? '').trim().slice(0, 30)}" is cut off`,
        )
      }
    }
    return problems
  })
}

// NF-10 SHL-46 R-15: with reduced motion, no animation is running and no transition lasts over
// 0.01 ms.
export function reducedMotionHolds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = []
    for (const animation of document.getAnimations()) {
      const timing = animation.effect?.getComputedTiming()
      const long = typeof timing?.duration === 'number' && timing.duration > 0.01
      if (animation.playState === 'running' && long) problems.push(`an animation of ${timing?.duration} ms runs`)
    }
    for (const element of document.querySelectorAll<HTMLElement>('*')) {
      const durations = getComputedStyle(element)
        .transitionDuration.split(',')
        .map(value => Number.parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000))
      if (durations.some(ms => ms > 0.01)) {
        problems.push(
          `<${element.tagName.toLowerCase()} class="${element.className}"> has a transition of ${durations}`,
        )
      }
    }
    return problems
  })
}

// R-35 decision 8 OD-06: no text a person can see or hear reads as AI: the visible text (visually
// hidden text and both announcer regions included) and every aria-label, title and alt, against
// AI_COPY, the list strings/strings.test.ts (ST-02) holds the string tables to. "Search" is the
// Search bar's label, never "Search & Ask".
export function noAiCopy(page: Page): Promise<string[]> {
  const patterns = AI_COPY.map(pattern => ({ source: pattern.source, flags: pattern.flags }))
  return page.evaluate(list => {
    const regexes = list.map(entry => new RegExp(entry.source, entry.flags))
    const problems: string[] = []
    const texts: string[] = [document.body.innerText, document.title]
    for (const element of document.querySelectorAll('[aria-live], .sr-only')) texts.push(element.textContent ?? '')
    for (const element of document.querySelectorAll('[aria-label], [title], [alt]')) {
      for (const name of ['aria-label', 'title', 'alt']) texts.push(element.getAttribute(name) ?? '')
    }
    for (const text of texts) {
      for (const regex of regexes) {
        const found = regex.exec(text)
        if (found) problems.push(`"${found[0]}" in "${text.trim().slice(0, 60)}"`)
      }
    }
    return problems
  }, patterns)
}

// Waits for the fonts the screen uses, so measurements and screenshots see the real faces.
export async function fontsReady(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready
  })
}

// X11: records every non-empty text the page's live regions take, in order, in every document the
// page loads from now on; the answer reads the current document's list.
export async function recordAnnouncements(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const said: string[] = []
    ;(window as unknown as { e2eSaid: string[] }).e2eSaid = said
    const last = new WeakMap<Element, string>()
    new MutationObserver(() => {
      for (const region of document.querySelectorAll('[aria-live]')) {
        const text = (region.textContent ?? '').trim()
        if (text === (last.get(region) ?? '')) continue
        last.set(region, text)
        if (text !== '') said.push(text)
      }
    }).observe(document, { subtree: true, childList: true, characterData: true })
  })
  return () => page.evaluate(() => (window as unknown as { e2eSaid?: string[] }).e2eSaid ?? [])
}
