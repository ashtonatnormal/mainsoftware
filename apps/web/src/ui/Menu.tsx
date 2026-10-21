// The one menu primitive (T21, D-03; fixes X10, SHL-17, DRV-37, DRV-45): a menu button after the
// WAI-ARIA Authoring Practices. The caller draws the trigger from the props it is given (the avatar
// menu's is an IconButton); the popup is a <div role="menu"> of <button role="menuitem">s with a
// roving tabIndex, so Tab leaves the menu in one step. The keys are menu-model.ts's. An item that
// can't act stays focusable with aria-disabled and its reason as a description, and does nothing.
// A pointer press outside closes it; activating an item closes it, puts focus back on the trigger,
// then runs the item.
//
// Positioned by CSS alone, absolute in a relative wrapper, with no Popover API (Safari 17; the
// pilot's floor is iOS 16.4). Contract: no ancestor between a Menu and the viewport may clip it
// (overflow other than visible) or become its containing block (transform, filter, contain). The
// rail's layout keeps to this, and the shell's e2e checks every item can be hit at three sizes.
import type { LucideIcon } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, type Ref, useEffect, useId, useRef, useState } from 'react'
import { cx } from './cx.ts'
import { CLOSED, type MenuState, menuKey, openAt } from './menu-model.ts'

export interface MenuItem {
  id: string
  label: string
  icon?: LucideIcon
  onSelect(): void
  disabledReason?: string
}

export interface MenuTriggerProps {
  ref: Ref<HTMLButtonElement>
  id: string
  'aria-haspopup': 'menu'
  'aria-expanded': boolean
  'aria-controls': string
  onClick(): void
  onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void
}

export interface MenuProps {
  label: string
  items: readonly MenuItem[]
  placement?: 'bottom-end' | 'top-start'
  // A line shown above the items (the avatar menu's name). It is decoration, hidden from
  // assistive technology, because the trigger's name already says it, and it sits outside the
  // role="menu" element, whose children must all be menu items.
  heading?: string
  trigger(props: MenuTriggerProps): ReactNode
}

// The popup's box: above <main> (z-30), never wider than the screen less 2rem.
const POPUP =
  'absolute z-30 min-w-48 max-w-[min(18rem,calc(100vw-2rem))] rounded-2xl border border-line bg-surface p-1 text-fg shadow-card'

const PLACEMENT = {
  'bottom-end': 'right-0 top-full mt-1',
  'top-start': 'bottom-full left-0 mb-1',
} as const

export function Menu({ label, items, placement = 'bottom-end', heading, trigger }: MenuProps) {
  const [state, setState] = useState<MenuState>(CLOSED)
  const id = useId()
  const triggerId = `${id}trigger`
  const menuId = `${id}menu`
  const wrapper = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const keyItems = items.map(item => ({ label: item.label, disabled: item.disabledReason !== undefined }))

  // Focus follows the active item while the menu is open.
  useEffect(() => {
    if (state.open) itemRefs.current[state.active]?.focus()
  }, [state.open, state.active])

  // A pointer press anywhere outside closes the menu, and focus goes where the press put it.
  useEffect(() => {
    if (!state.open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !wrapper.current?.contains(event.target)) setState(CLOSED)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [state.open])

  const closeAndRestore = () => {
    setState(CLOSED)
    triggerRef.current?.focus()
  }

  const activate = (index: number) => {
    const item = items[index]
    if (!item || item.disabledReason !== undefined) return
    closeAndRestore()
    item.onSelect()
  }

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    // Enter and Space reach the trigger's click, which opens the menu on its first item.
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    setState(menuKey(CLOSED, event.key, keyItems, event.timeStamp).state)
  }

  const onItemKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    // Enter and Space reach the item's own click, which activates it once (handling Space here
    // would let its keyup click the trigger that focus has just moved to).
    if (event.key === 'Enter' || event.key === ' ') return
    const { state: next, effect } = menuKey(state, event.key, keyItems, event.timeStamp)
    if (effect === 'close-tab') {
      // Tab moves focus on by itself; the menu closes once it has.
      setTimeout(() => setState(CLOSED))
      return
    }
    if (next === state && effect === undefined) return
    // Escape stops here too, so a Dialog under the menu stays open.
    event.preventDefault()
    event.stopPropagation()
    if (effect === 'close-restore') closeAndRestore()
    else setState(next)
  }

  // The disabled items' reasons sit outside the menu, whose children are menu items only; hidden
  // text still describes.
  const reasons = items.map((item, index) =>
    item.disabledReason === undefined ? null : (
      <span key={item.id} id={`${id}reason${index}`} hidden>
        {item.disabledReason}
      </span>
    ),
  )

  const list = (
    <div
      id={menuId}
      role="menu"
      aria-label={label}
      hidden={!state.open}
      className={heading === undefined ? cx(POPUP, PLACEMENT[placement]) : undefined}
    >
      {items.map((item, index) => {
        const Icon = item.icon
        const disabled = item.disabledReason !== undefined
        return (
          <button
            key={item.id}
            ref={element => {
              itemRefs.current[index] = element
            }}
            type="button"
            role="menuitem"
            // Only the active item is in the tab order, so Tab leaves the menu in one step.
            tabIndex={index === state.active ? 0 : -1}
            aria-disabled={disabled || undefined}
            aria-describedby={disabled ? `${id}reason${index}` : undefined}
            onKeyDown={onItemKeyDown}
            onClick={() => activate(index)}
            className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left hover:bg-bg focus-visible:bg-bg aria-disabled:cursor-not-allowed aria-disabled:text-muted"
          >
            {Icon && <Icon aria-hidden size={18} className="shrink-0" />}
            <span className="min-w-0 flex-1">{item.label}</span>
          </button>
        )
      })}
    </div>
  )

  return (
    <div ref={wrapper} className="relative">
      {trigger({
        ref: triggerRef,
        id: triggerId,
        'aria-haspopup': 'menu',
        'aria-expanded': state.open,
        'aria-controls': menuId,
        onClick: () => (state.open ? closeAndRestore() : setState(openAt(0))),
        onKeyDown: onTriggerKeyDown,
      })}
      {heading === undefined ? (
        list
      ) : (
        <div hidden={!state.open} className={cx(POPUP, PLACEMENT[placement])}>
          <p aria-hidden className="break-words px-3 pt-2 pb-1 text-small font-medium text-muted">
            {heading}
          </p>
          {list}
        </div>
      )}
      {reasons}
    </div>
  )
}
