// Buttons (T21, D-03; fixes SHL-47, X7, X8, SHL-36). Ported from the demo's kit
// (demo/src/ui/index.tsx) with its faults fixed:
// - a button is type="button" unless the caller says otherwise, so one inside a form never submits
//   it by accident (SHL-47);
// - every button is at least 44×44 CSS px at every width, not only on touch, so the check is the
//   same at 320 and 1440 px (X7);
// - filled variants take their ink from the -fg token, never text-white, which fails on dark mode's
//   lighter fills (X8, SHL-36), and there is no agent variant;
// - a button that can't act says why: `disabledReason` keeps it focusable with aria-disabled and a
//   description, and a press does nothing. It is never `disabled` with a reason, which would take
//   it out of the tab order and hide the reason with it.
import type { LucideIcon } from 'lucide-react'
import { type ButtonHTMLAttributes, type MouseEvent, type ReactNode, type Ref, useId } from 'react'
import { cx } from './cx.ts'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: 'md' | 'lg'
  icon?: LucideIcon
  disabledReason?: string
  ref?: Ref<HTMLButtonElement>
}

// Each variant's fill and ink at rest, under the pointer and pressed (X8, WCAG 1.4.3). The
// primary's hover and press swap the ember fill for accent-ink, which is deeper in light and
// brighter in dark, so its ink gains contrast in both themes (accent-fg on accent-ink, TEXT_PAIRS).
// A brightness() filter dims or brightens the ink with the fill, and the demo's brightness-105
// took white on ember under 4.5:1 in light. Secondary and danger keep a 5 % brightness step, which
// leaves their ink over 4.5:1 in both themes. TK-11 (styles/contrast.test.ts) reads these strings
// and holds every state, filter included, to 4.5:1, so a class changed here is checked.
export const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-ink active:bg-accent-ink',
  secondary: 'bg-surface-2 text-fg hover:brightness-95',
  ghost: 'text-fg hover:bg-surface-2',
  danger: 'bg-rec text-rec-fg hover:brightness-105 active:brightness-95',
}

// How a button that can't act looks, whichever way it can't: muted ink on the control ground (a
// TEXT_PAIRS pair), never opacity (X9). It replaces the variant's classes, so no hover or press
// class is left to change its fill or ink.
export const INERT_BUTTON = 'bg-surface-2 text-muted cursor-not-allowed'

// The props every button shares once a reason may hold it back: aria-disabled and the description
// in place of `disabled`, and a press that does nothing (a click, or Enter in a form, whose implicit
// submission is a click on this button).
function useDisabledReason<E extends HTMLElement>(
  disabledReason: string | undefined,
  describedBy: string | undefined,
  onClick: ((event: MouseEvent<E>) => void) | undefined,
) {
  const reasonId = useId()
  if (disabledReason === undefined) return { props: { 'aria-describedby': describedBy, onClick }, reason: null }
  return {
    props: {
      'aria-disabled': true as const,
      'aria-describedby': [describedBy, reasonId].filter(Boolean).join(' '),
      onClick: (event: MouseEvent<E>) => event.preventDefault(),
    },
    // Hidden, not sr-only: a description may name hidden text, and hidden text isn't read a second
    // time in reading order.
    reason: (
      <span id={reasonId} hidden>
        {disabledReason}
      </span>
    ),
  }
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  disabledReason,
  type = 'button',
  className,
  children,
  disabled,
  onClick,
  'aria-describedby': describedBy,
  ...rest
}: ButtonProps) {
  const held = useDisabledReason(disabledReason, describedBy, onClick)
  const inert = disabledReason !== undefined || disabled === true
  return (
    <>
      <button
        {...rest}
        {...held.props}
        // A reason replaces `disabled`, so the button stays in the tab order.
        disabled={disabledReason === undefined ? disabled : undefined}
        type={type}
        className={cx(
          'inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full font-semibold transition',
          size === 'lg' ? 'px-6 text-base' : 'px-4 text-body',
          inert ? INERT_BUTTON : BUTTON_VARIANTS[variant],
          className,
        )}
      >
        {Icon && <Icon aria-hidden size={size === 'lg' ? 20 : 18} className="shrink-0" />}
        {children}
      </button>
      {held.reason}
    </>
  )
}

export type IconButtonProps = Omit<ButtonProps, 'children' | 'size' | 'icon' | 'aria-label' | 'title'> & {
  label: string
  icon: ReactNode
  pressed?: boolean
}

// A button that shows only an icon: 44×44, named by `label` (never a title tooltip, which touch
// can't reach), the icon hidden from assistive technology, and aria-pressed only when it toggles.
export function IconButton({
  label,
  icon,
  pressed,
  variant = 'ghost',
  disabledReason,
  type = 'button',
  className,
  disabled,
  onClick,
  'aria-describedby': describedBy,
  ...rest
}: IconButtonProps) {
  const held = useDisabledReason(disabledReason, describedBy, onClick)
  const inert = disabledReason !== undefined || disabled === true
  return (
    <>
      <button
        {...rest}
        {...held.props}
        disabled={disabledReason === undefined ? disabled : undefined}
        type={type}
        aria-label={label}
        aria-pressed={pressed}
        className={cx(
          'inline-grid size-11 shrink-0 place-items-center rounded-full transition',
          inert ? INERT_BUTTON : pressed ? 'bg-accent-soft text-accent-ink' : BUTTON_VARIANTS[variant],
          className,
        )}
      >
        <span aria-hidden className="inline-flex">
          {icon}
        </span>
      </button>
      {held.reason}
    </>
  )
}
