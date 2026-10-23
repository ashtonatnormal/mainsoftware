// Keeps the shell's one scroll container, #screen (D-08), within a keyboard's reach (WCAG 2.1.1;
// axe's scrollable-region-focusable). While its content overflows and holds nothing in the tab
// order (a screen of text, such as Settings › Privacy at 320 px before the notice prints a contact),
// the container takes a place in the tab order itself (tabindex 0), so Tab reaches it and the arrow
// keys scroll it. Otherwise it has none, and the tab order is the content's alone (KB-03). Chromium
// does the same for any scroller on its own (keyboard-focusable scrollers); Safari doesn't. It writes
// only the tabindex attribute, never a style, which the CSP refuses (T21 item 7).

// What sits in the tab order: anything that can be tabbed to, unless taken out of it.
export const TABBABLE = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled):not([type=hidden])',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  'summary',
  'iframe',
  '[contenteditable]:not([contenteditable=false])',
  '[tabindex]',
]
  .map(selector => `${selector}:not([tabindex="-1"])`)
  .join(', ')

export interface ScrollBox {
  readonly scrollHeight: number
  readonly clientHeight: number
}

// Whether the container needs its own place in the tab order: only while it scrolls and its
// content offers a keyboard nowhere to stop.
export function needsOwnTabStop(box: ScrollBox, holdsTabbable: boolean): boolean {
  return box.scrollHeight > box.clientHeight && !holdsTabbable
}

// Whether anything shown inside the container is in the tab order. One inside a hidden or inert
// part (display: none has no boxes) can't be reached, so it doesn't count.
function holdsTabbable(scroller: HTMLElement): boolean {
  for (const element of scroller.querySelectorAll(TABBABLE)) {
    if (element.getClientRects().length > 0 && element.closest('[inert]') === null) return true
  }
  return false
}

// Watches the container and its content, and keeps its tabindex in step: the content changing
// (another screen, an answer arriving), the container resizing (the viewport, the toasts) and a
// screen's own size changing (a font loading). Answers the function that stops watching.
export function keepReachable(scroller: HTMLElement): () => void {
  if (typeof ResizeObserver !== 'function' || typeof MutationObserver !== 'function') return () => {}
  const update = () => {
    const own = needsOwnTabStop(scroller, holdsTabbable(scroller))
    // Only a change is written, so the attribute observer below never loops.
    if (own === scroller.hasAttribute('tabindex')) return
    if (own) scroller.setAttribute('tabindex', '0')
    else scroller.removeAttribute('tabindex')
  }
  const sizes = new ResizeObserver(update)
  const watchSizes = () => {
    sizes.disconnect()
    sizes.observe(scroller)
    for (const child of scroller.children) sizes.observe(child)
  }
  const changes = new MutationObserver(records => {
    if (records.some(record => record.type === 'childList' && record.target === scroller)) watchSizes()
    update()
  })
  changes.observe(scroller, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href', 'disabled', 'tabindex', 'hidden', 'inert', 'contenteditable', 'type'],
  })
  watchSizes()
  update()
  return () => {
    changes.disconnect()
    sizes.disconnect()
  }
}
