// A modal dialog: a sheet from the bottom on phones, centred from sm: up (T21, D-03; fixes SHL-45,
// SHL-25, DRV-48, R-29). Renamed from the demo's Sheet, and rebuilt on the native <dialog> with
// showModal(), so the browser gives the top layer, an inert page behind and the Tab trap, and the
// demo's hand-rolled focus trap is gone.
// - Escape fires `cancel` on the top dialog only. Unless something inside already handled it (a
//   Menu stops its own Escape), the dialog keeps itself open (preventDefault) and asks the caller to
//   close it, so `open` stays the one truth.
// - `close` also calls onClose() while `open` is still true: a close request the page can't stop
//   (Chrome lets only one cancel be refused without a user gesture, and Android's back gesture)
//   closes the element without our say, and the caller's state must follow.
// - It is labelled by its h2 title and has a 44 px Close button.
// - The screen behind stops scrolling (lockScroll(), a class on <html>, never a <style>).
// - The element that opened it is read in the effect, as showModal() runs, not while rendering, and
//   gets focus back on close unless focus has already gone somewhere on purpose (DRV-48).
import { X } from 'lucide-react'
import { type ReactNode, type RefObject, type SyntheticEvent, useEffect, useId, useRef } from 'react'
import { IconButton } from './Button.tsx'
import { cx } from './cx.ts'
import { lockScroll } from './scroll-lock.ts'
import { UI } from './strings.ts'

export interface DialogProps {
  open: boolean
  onClose(): void
  title: string
  presentation?: 'sheet' | 'centred'
  footer?: ReactNode
  // What takes focus when it opens; else the browser's choice, the first focusable element.
  initialFocus?: RefObject<HTMLElement | null>
  children: ReactNode
}

const PRESENTATION = {
  // Below sm: a sheet on the bottom edge, padded above the home indicator; from sm: centred.
  sheet: 'mb-0 mt-auto w-full max-w-none rounded-t-3xl pb-safe sm:m-auto sm:max-w-lg sm:rounded-3xl sm:pb-0',
  centred: 'm-auto w-[calc(100%-2rem)] max-w-lg rounded-3xl',
} as const

export function Dialog({ open, onClose, title, presentation = 'sheet', footer, initialFocus, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  // The latest props, for the event handlers the effect keeps.
  const latest = useRef({ open, onClose })
  latest.current = { open, onClose }

  useEffect(() => {
    const dialog = ref.current
    if (!open || !dialog) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    const unlock = lockScroll()
    initialFocus?.current?.focus()
    return () => {
      if (dialog.open) dialog.close()
      unlock()
      // Back to the opener, unless closing put focus somewhere on purpose (the next screen, a field).
      const now = document.activeElement
      const lost = now === null || now === document.body || dialog.contains(now)
      if (lost && opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [open, initialFocus])

  if (!open) return null

  const onCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    if (event.defaultPrevented) return
    event.preventDefault()
    latest.current.onClose()
  }

  const onNativeClose = () => {
    if (latest.current.open) latest.current.onClose()
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={onCancel}
      onClose={onNativeClose}
      className={cx(
        // The backdrop veils the page in its own ground colour. Browsers before Safari 17.4 and
        // Chrome 122 don't let ::backdrop read the tokens, and show the page unveiled; the dialog is
        // just as modal.
        'anim-in max-h-[88dvh] flex-col bg-surface p-0 text-fg shadow-card open:flex backdrop:bg-bg/75',
        PRESENTATION[presentation],
      )}
    >
      <div className="flex items-center gap-2 border-b border-line py-2 pl-5 pr-2">
        <h2 id={titleId} className="min-w-0 flex-1 font-display text-lg font-semibold">
          {title}
        </h2>
        <IconButton label={UI.close} icon={<X size={20} />} onClick={() => latest.current.onClose()} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
    </dialog>
  )
}
