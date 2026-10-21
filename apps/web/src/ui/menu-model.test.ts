import { describe, expect, it } from 'vitest'
import { CLOSED, type MenuState, menuKey, openAt, TYPEAHEAD_MS } from './menu-model.ts'

const items = [
  { label: 'Profile', disabled: false },
  { label: 'Settings', disabled: true },
  { label: 'Sign out', disabled: false },
  { label: 'Switch theme', disabled: false },
]

// Presses each key in turn, a millisecond apart unless a time is given, and returns where focus is.
function press(start: MenuState, keys: readonly (string | [string, number])[]) {
  let state = start
  let effect: string | undefined
  let now = 1_000
  for (const entry of keys) {
    const [key, at] = typeof entry === 'string' ? [entry, now + 1] : entry
    now = at
    ;({ state, effect } = menuKey(state, key, items, now))
  }
  return { state, effect }
}

describe('T21: the menu keyboard (menu-model.ts)', () => {
  it('opens from the trigger: Enter, Space or ArrowDown on the first item, ArrowUp on the last', () => {
    for (const key of ['Enter', ' ', 'ArrowDown']) expect(menuKey(CLOSED, key, items, 0).state).toEqual(openAt(0))
    expect(menuKey(CLOSED, 'ArrowUp', items, 0).state).toEqual(openAt(3))
    expect(menuKey(CLOSED, 'a', items, 0).state).toBe(CLOSED)
    expect(menuKey(CLOSED, 'ArrowDown', [], 0).state).toBe(CLOSED)
  })

  it('MN-01 X10 DRV-37: Home and End; arrows wrap', () => {
    expect(press(openAt(0), ['ArrowDown']).state.active).toBe(1)
    expect(press(openAt(3), ['ArrowDown']).state.active).toBe(0)
    expect(press(openAt(0), ['ArrowUp']).state.active).toBe(3)
    expect(press(openAt(2), ['Home']).state.active).toBe(0)
    expect(press(openAt(1), ['End']).state.active).toBe(3)
    expect(press(openAt(0), ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown']).state.active).toBe(1)
    expect(press(openAt(0), ['End']).state.open).toBe(true)
  })

  it('MN-02 X10: typeahead finds by prefix, extending within 500 ms', () => {
    // One letter moves to the next item that starts with it, round from the item after focus.
    expect(press(openAt(0), ['s']).state.active).toBe(1)
    // The same letter again steps on to the next match, and round again.
    expect(press(openAt(0), ['s', 's']).state.active).toBe(2)
    expect(press(openAt(0), ['s', 's', 's', 's']).state.active).toBe(1)
    // A longer prefix within 500 ms narrows from where focus is: "sw" is Switch theme.
    expect(
      press(openAt(0), [
        ['s', 1_000],
        ['w', 1_200],
      ]).state.active,
    ).toBe(3)
    expect(
      press(openAt(0), [
        ['s', 1_000],
        ['i', 1_100],
        ['g', 1_200],
      ]).state.active,
    ).toBe(2)
    // After 500 ms the buffer starts again: "w" alone matches nothing, so focus stays.
    const late = press(openAt(0), [
      ['s', 1_000],
      ['w', 1_000 + TYPEAHEAD_MS],
    ])
    expect(late.state.active).toBe(1)
    expect(late.state.typed).toBe('w')
    // Case doesn't matter, and no match leaves focus where it was.
    expect(press(openAt(0), ['P']).state.active).toBe(0)
    expect(press(openAt(2), ['z']).state.active).toBe(2)
    // Arrows clear the buffer.
    expect(
      press(openAt(0), [
        ['s', 1_000],
        ['ArrowUp', 1_050],
      ]).state.typed,
    ).toBe('')
  })

  it('MN-03 X10 DRV-45: an aria-disabled item takes focus but doesn’t activate', () => {
    expect(press(openAt(0), ['ArrowDown']).state.active).toBe(1)
    for (const key of ['Enter', ' ']) {
      const result = press(openAt(1), [key])
      expect(result.effect).toBeUndefined()
      expect(result.state).toEqual(openAt(1))
    }
    for (const key of ['Enter', ' ']) {
      const result = press(openAt(2), [key])
      expect(result.effect).toBe('activate')
      expect(result.state.open).toBe(false)
    }
  })

  it('MN-04 X10: Escape closes and restores; Tab closes and moves on', () => {
    expect(press(openAt(2), ['Escape'])).toEqual({ state: CLOSED, effect: 'close-restore' })
    expect(press(openAt(2), ['Tab'])).toEqual({ state: CLOSED, effect: 'close-tab' })
    // Keys that mean nothing here change nothing.
    for (const key of ['Shift', 'F5', 'PageDown']) expect(press(openAt(2), [key]).state).toEqual(openAt(2))
  })
})
