// Stops the screen scrolling under an open Dialog (T21 item 7, SHL-45). It toggles one class on
// <html>, `scroll-locked`, which app.css turns into `#screen { overflow: hidden }`; it never writes
// a <style> element or an inline style, which the CSP refuses. Locks are counted, so a dialog
// opened over another keeps the lock until the last one closes. Each release works once.

export interface LockRoot {
  readonly classList: Pick<DOMTokenList, 'add' | 'remove'>
}

export const SCROLL_LOCKED = 'scroll-locked'

export function createScrollLock(root: () => LockRoot | null | undefined) {
  let held = 0
  return function lockScroll(): () => void {
    held++
    if (held === 1) root()?.classList.add(SCROLL_LOCKED)
    let released = false
    return () => {
      if (released) return
      released = true
      held--
      if (held === 0) root()?.classList.remove(SCROLL_LOCKED)
    }
  }
}

// The app's one lock, on this document's <html>.
export const lockScroll = createScrollLock(() =>
  typeof document === 'undefined' ? undefined : document.documentElement,
)
