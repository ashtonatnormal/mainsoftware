import { describe, expect, it } from 'vitest'
import { createScrollLock, SCROLL_LOCKED } from './scroll-lock.ts'

describe('T21: the scroll lock', () => {
  it('SL-01 C-22 SHL-45: nested locks count; the class goes only when the last releases; no <style> is created', () => {
    const classes = new Set<string>()
    const calls: string[] = []
    const root = {
      classList: {
        add: (...names: string[]) => {
          calls.push(`add ${names.join()}`)
          for (const name of names) classes.add(name)
        },
        remove: (...names: string[]) => {
          calls.push(`remove ${names.join()}`)
          for (const name of names) classes.delete(name)
        },
      },
    }
    const lockScroll = createScrollLock(() => root)
    const outer = lockScroll()
    const inner = lockScroll()
    expect(classes).toEqual(new Set([SCROLL_LOCKED]))
    inner()
    expect(classes).toEqual(new Set([SCROLL_LOCKED]))
    // A release that runs twice counts once.
    inner()
    expect(classes).toEqual(new Set([SCROLL_LOCKED]))
    outer()
    expect(classes).toEqual(new Set())
    expect(calls).toEqual(['add scroll-locked', 'remove scroll-locked'])
    // The only thing the lock touches is the class list it is given: it has no document to write a
    // <style> into, and the class is the one app.css turns into overflow: hidden on #screen.
    expect(SCROLL_LOCKED).toBe('scroll-locked')
    // With no document (react-dom/server, or a test), locking does nothing and doesn't throw.
    const none = createScrollLock(() => undefined)
    none()()
  })
})
