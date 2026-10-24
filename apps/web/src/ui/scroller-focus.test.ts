import { afterEach, describe, expect, it, vi } from 'vitest'
import { keepReachable, needsOwnTabStop, TABBABLE } from './scroller-focus.ts'

// A stand-in for the browser's observers: each keeps its callback, so a test runs it as the browser
// would after a change, and counts what it watches.
class FakeObserver {
  static made: FakeObserver[] = []
  watched = new Set<unknown>()
  readonly callback: (records: { type: string; target: unknown }[]) => void
  constructor(callback: (records: { type: string; target: unknown }[]) => void) {
    this.callback = callback
    FakeObserver.made.push(this)
  }
  observe(target: unknown) {
    this.watched.add(target)
  }
  disconnect() {
    this.watched.clear()
  }
}

// One element inside the screen: shown (it has boxes) or not, inert or not.
function element({ shown = true, inert = false } = {}) {
  return { getClientRects: () => ({ length: shown ? 1 : 0 }), closest: () => (inert ? {} : null) }
}

function scroller() {
  const attributes = new Map<string, string>()
  const writes: string[] = []
  const box = {
    scrollHeight: 1200,
    clientHeight: 400,
    content: [] as ReturnType<typeof element>[],
    children: [{ child: 1 }],
    hasAttribute: (name: string) => attributes.has(name),
    setAttribute: (name: string, value: string) => {
      writes.push(`set ${name}=${value}`)
      attributes.set(name, value)
    },
    removeAttribute: (name: string) => {
      writes.push(`remove ${name}`)
      attributes.delete(name)
    },
    querySelectorAll: (selector: string) => {
      expect(selector).toBe(TABBABLE)
      return box.content
    },
  }
  return { box, attributes, writes }
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeObserver.made = []
})

describe('D-08, WCAG 2.1.1: the screen stays within a keyboard’s reach', () => {
  it('SF-01 WCAG 2.1.1: the scroller takes a tab stop only while it scrolls and holds nothing in the tab order', () => {
    expect(needsOwnTabStop({ scrollHeight: 1200, clientHeight: 400 }, false)).toBe(true)
    expect(needsOwnTabStop({ scrollHeight: 1200, clientHeight: 400 }, true)).toBe(false)
    expect(needsOwnTabStop({ scrollHeight: 400, clientHeight: 400 }, false)).toBe(false)
    expect(needsOwnTabStop({ scrollHeight: 300, clientHeight: 400 }, false)).toBe(false)
    // Every kind of stop is counted, and none taken out of the tab order.
    for (const kind of ['a[href]', 'button:not(:disabled)', 'select:not(:disabled)', 'textarea:not(:disabled)'])
      expect(TABBABLE).toContain(`${kind}:not([tabindex="-1"])`)
    expect(TABBABLE).toContain('[tabindex]:not([tabindex="-1"])')
  })

  it('SF-02 WCAG 2.1.1 4.1.2 KB-03: keepReachable keeps the tab stop, its role and its name in step with the content and the size, together, writing only changes, and stops when told', () => {
    vi.stubGlobal('ResizeObserver', FakeObserver)
    vi.stubGlobal('MutationObserver', FakeObserver)
    const { box, attributes, writes } = scroller()
    const stop = keepReachable(box as unknown as HTMLElement, 'screen-title')
    const [sizes, changes] = FakeObserver.made
    if (sizes === undefined || changes === undefined) throw new Error('both observers are made')
    // Text that scrolls: the scroller is the stop, a region named by the screen's h1.
    expect(Object.fromEntries(attributes)).toEqual({
      tabindex: '0',
      role: 'region',
      'aria-labelledby': 'screen-title',
    })
    expect(sizes.watched).toEqual(new Set([box, ...box.children]))
    // A link arrives: the tab order is the content's alone, and the container is no region.
    box.content = [element()]
    changes.callback([{ type: 'attributes', target: {} }])
    expect(attributes.size).toBe(0)
    // Only a hidden or inert one is left: it can't be reached, so the scroller is the stop again.
    box.content = [element({ shown: false }), element({ inert: true })]
    changes.callback([{ type: 'childList', target: {} }])
    expect(attributes.get('tabindex')).toBe('0')
    // Another run with nothing changed writes nothing.
    changes.callback([{ type: 'attributes', target: box }])
    // The screen grows tall enough for its content: no stop of its own.
    box.clientHeight = 1200
    sizes.callback([])
    expect(attributes.has('tabindex')).toBe(false)
    // Another screen: the new children are watched for their size.
    box.children = [{ child: 2 }]
    changes.callback([{ type: 'childList', target: box }])
    expect(sizes.watched).toEqual(new Set([box, ...box.children]))
    const on = ['set role=region', 'set aria-labelledby=screen-title', 'set tabindex=0']
    const off = ['remove tabindex', 'remove role', 'remove aria-labelledby']
    expect(writes).toEqual([...on, ...off, ...on, ...off])
    stop()
    expect(sizes.watched.size).toBe(0)
    expect(changes.watched.size).toBe(0)
  })

  it('SF-03: with no observers (react-dom/server, or an old browser) it does nothing and does not throw', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const { box, writes } = scroller()
    keepReachable(box as unknown as HTMLElement, 'screen-title')()
    expect(writes).toEqual([])
  })
})
