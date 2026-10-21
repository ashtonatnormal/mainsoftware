import { describe, expect, it } from 'vitest'
import { afterCommit, type FocusEnv, type FocusTarget, focusAfter, focusScreenHeading } from './focus.ts'

interface FakeTarget extends FocusTarget {
  name: string
}

function target(name: string, options: { shown?: boolean; connected?: boolean } = {}) {
  const shown = options.shown ?? true
  const element: FakeTarget = {
    name,
    isConnected: options.connected ?? true,
    focus: (focusOptions?: FocusOptions) => focused.push(`${name}${focusOptions?.preventScroll ? '' : ' (scrolled)'}`),
    getClientRects: () => ({ length: shown ? 1 : 0 }),
  }
  return element
}

let focused: string[] = []

// An environment whose microtasks and frames run when the test says, in order.
function fakeEnv(headings: FakeTarget[], main: FakeTarget | null) {
  const steps: string[] = []
  const microtasks: (() => void)[] = []
  const frames: (() => void)[] = []
  const env: FocusEnv = {
    queueMicrotask: task => {
      steps.push('microtask')
      microtasks.push(task)
    },
    requestFrame: task => {
      steps.push('frame')
      frames.push(task)
    },
    headings: () => headings,
    main: () => main,
  }
  const run = () => {
    while (microtasks.length > 0 || frames.length > 0) {
      while (microtasks.length > 0) microtasks.shift()?.()
      frames.shift()?.()
    }
  }
  return { env, steps, run }
}

describe('T21: focusAfter (X6)', () => {
  it('FA-01 X6 SHL-42 SHL-44: after a microtask and a frame, focus the target, else the visible h1, else #main, never scrolling', () => {
    focused = []
    const hiddenH1 = target('h1 (other layout)', { shown: false })
    const h1 = target('h1')
    const main = target('main')
    const fake = fakeEnv([hiddenH1, h1], main)

    focusAfter(() => target('next field'), 'heading', fake.env)
    expect(focused).toEqual([])
    fake.run()
    expect(fake.steps).toEqual(['microtask', 'frame'])
    expect(focused).toEqual(['next field'])

    // The target is gone (removed with what was pressed): the visible h1, never the hidden copy.
    focusAfter(() => target('removed', { connected: false }), 'heading', fake.env)
    focusAfter(() => null, 'heading', fake.env)
    fake.run()
    expect(focused).toEqual(['next field', 'h1', 'h1'])

    // Asked for main, or a screen with no h1.
    focusAfter(() => undefined, 'main', fake.env)
    fake.run()
    const noHeading = fakeEnv([hiddenH1], main)
    focusAfter(() => null, 'heading', noHeading.env)
    noHeading.run()
    expect(focused.slice(-2)).toEqual(['main', 'main'])

    focusScreenHeading(fake.env)
    expect(focused.at(-1)).toBe('h1')
  })

  it('FA-02 X11 T21 item 13: afterCommit runs a task after the same microtask and frame, so a focus move asked for first has happened when it runs', () => {
    focused = []
    const fake = fakeEnv([target('h1')], null)
    const order: string[] = []
    focusAfter(
      () => {
        order.push('focus')
        return target('h1')
      },
      'heading',
      fake.env,
    )
    afterCommit(() => order.push('say'), fake.env)
    expect(order).toEqual([])
    fake.run()
    expect(order).toEqual(['focus', 'say'])
    expect(fake.steps).toEqual(['microtask', 'microtask', 'frame', 'frame'])
  })
})
