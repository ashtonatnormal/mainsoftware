// The menu button's keyboard, as a pure function (T21; X10, SHL-17, DRV-37, DRV-45), after the
// WAI-ARIA Authoring Practices' menu button. Menu.tsx feeds it each key and acts on the effect.
// - Closed, on the trigger: Enter, Space or ArrowDown open on the first item, ArrowUp on the last.
// - Open, on an item: arrows move and wrap, Home and End jump, a printable character finds the next
//   item whose label starts with what was typed in the last 500 ms (the same letter again moves on
//   to the next match), Enter or Space activate, Escape closes and puts focus back on the trigger,
//   and Tab closes and lets focus move on.
// - An item with aria-disabled takes focus like any other (so its reason is read) but never
//   activates.

export interface MenuState {
  readonly open: boolean
  // The item that has focus while open; -1 when closed.
  readonly active: number
  readonly typed: string
  readonly typedAt: number
}

export interface MenuKeyItem {
  readonly label: string
  readonly disabled: boolean
}

export type MenuEffect = 'activate' | 'close-restore' | 'close-tab'

export const TYPEAHEAD_MS = 500

export const CLOSED: MenuState = { open: false, active: -1, typed: '', typedAt: 0 }

export const openAt = (active: number): MenuState => ({ open: true, active, typed: '', typedAt: 0 })

const isPrintable = (key: string) => Array.from(key).length === 1 && key !== ' '

const startsWith = (label: string, typed: string) =>
  label.trimStart().toLocaleLowerCase('en-GB').startsWith(typed.toLocaleLowerCase('en-GB'))

// The next item, from `from` round to `from - 1`, whose label starts with `typed`.
function find(items: readonly MenuKeyItem[], typed: string, from: number): number | undefined {
  for (let step = 0; step < items.length; step++) {
    const index = (from + step) % items.length
    const item = items[index]
    if (item && startsWith(item.label, typed)) return index
  }
  return undefined
}

export function menuKey(
  state: MenuState,
  key: string,
  items: readonly MenuKeyItem[],
  now: number,
): { state: MenuState; effect?: MenuEffect } {
  const count = items.length
  if (!state.open) {
    if (count === 0) return { state }
    if (key === 'Enter' || key === ' ' || key === 'ArrowDown') return { state: openAt(0) }
    if (key === 'ArrowUp') return { state: openAt(count - 1) }
    return { state }
  }
  const at = (active: number): MenuState => ({ ...state, active, typed: '', typedAt: 0 })
  switch (key) {
    case 'ArrowDown':
      return { state: at((state.active + 1) % count) }
    case 'ArrowUp':
      return { state: at((state.active - 1 + count) % count) }
    case 'Home':
      return { state: at(0) }
    case 'End':
      return { state: at(count - 1) }
    case 'Escape':
      return { state: CLOSED, effect: 'close-restore' }
    case 'Tab':
      return { state: CLOSED, effect: 'close-tab' }
    case 'Enter':
    case ' ':
      return items[state.active]?.disabled ? { state } : { state: CLOSED, effect: 'activate' }
  }
  if (!isPrintable(key)) return { state }
  const typed = now - state.typedAt < TYPEAHEAD_MS ? state.typed + key : key
  const chars = Array.from(typed.toLocaleLowerCase('en-GB'))
  // One letter, or the same letter again and again, steps on through the items that start with it;
  // a longer prefix is matched from the item that has focus, so it can stay put.
  const stepping = chars.every(char => char === chars[0])
  const match = stepping ? find(items, key, state.active + 1) : find(items, typed, state.active)
  return { state: { ...state, active: match ?? state.active, typed, typedAt: now } }
}
