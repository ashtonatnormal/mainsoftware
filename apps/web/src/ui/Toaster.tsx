// Where toasts show (T21; X4, X5, SHL-35, SHL-39, WCAG 2.4.11). A labelled region that exists from
// the first render, holding a polite live list, so each new toast is read as it arrives. The shell
// puts it after #screen in reading order and over the bottom of <main>, above the tab bar. Each
// toast is on the inverse ground (text-bg on bg-fg), with its action and its focus ring in the
// inverse accent (.on-inverse) and a 44 px Close. Hovering or focusing one stops its clock
// (toast-store.ts). When a toast that held focus leaves, however it leaves (its Undo or Close, a
// newer toast pushing it out, dismissToast() from code), focus goes to the screen's h1 rather than
// <body> (X6), unless something else has taken focus on purpose by then (an Undo that focuses
// what it put back, a screen that closes its toast and focuses a field). A ResizeObserver keeps
// --toast-h at the region's height, and #screen's scroll-padding-bottom follows it, so a field
// scrolled into view is never under a toast.
import { X } from 'lucide-react'
import { type FocusEvent, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { focusAfter } from '@/lib/focus.ts'
import { UI } from './strings.ts'
import { toastStore } from './toast.ts'
import type { Toast } from './toast-store.ts'

export function Toaster() {
  const toasts = useSyncExternalStore(toastStore.subscribe, toastStore.snapshot, toastStore.snapshot)
  const region = useRef<HTMLElement>(null)

  useEffect(() => {
    const element = region.current
    if (!element || typeof ResizeObserver !== 'function') return
    const root = document.documentElement
    const observer = new ResizeObserver(() => root.style.setProperty('--toast-h', `${element.offsetHeight}px`))
    observer.observe(element)
    return () => {
      observer.disconnect()
      root.style.removeProperty('--toast-h')
    }
  }, [])

  // The list is padded only while it holds a toast, so an empty region is 0 px tall and adds no
  // scroll padding.
  return (
    <section
      ref={region}
      aria-label={UI.notifications}
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-4"
    >
      <ol aria-live="polite" className="mx-auto flex max-w-md flex-col gap-2 not-empty:pb-3">
        {toasts.map(toast => (
          <ToastRow key={toast.id} toast={toast} />
        ))}
      </ol>
    </section>
  )
}

// What has focus once a toast has gone, if anything took it on purpose: anything but <body>.
const focusedOnPurpose = () => {
  const now = document.activeElement
  return now instanceof HTMLElement && now !== document.body ? now : null
}

function ToastRow({ toast }: { toast: Toast }) {
  const row = useRef<HTMLLIElement>(null)

  // The hand-off runs as the row unmounts, so it covers every way a toast leaves. React runs a
  // removed component's layout cleanup before it takes the row out of the document, so focus is
  // still inside the row here. focusAfter() then waits for the commit and a frame, and focuses the
  // screen's h1 unless focus has landed somewhere other than <body> by then.
  useLayoutEffect(() => {
    const element = row.current
    return () => {
      if (element?.contains(document.activeElement)) focusAfter(focusedOnPurpose)
    }
  }, [])

  const onBlur = (event: FocusEvent<HTMLLIElement>) => {
    if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) {
      toastStore.resume(toast.id, 'focus')
    }
  }

  return (
    <li
      ref={row}
      onMouseEnter={() => toastStore.pause(toast.id, 'hover')}
      onMouseLeave={() => toastStore.resume(toast.id, 'hover')}
      onFocus={() => toastStore.pause(toast.id, 'focus')}
      onBlur={onBlur}
      className="anim-in on-inverse pointer-events-auto flex min-h-11 items-center gap-2 rounded-2xl bg-fg py-1 pl-4 pr-1 text-bg shadow-card"
    >
      <span className="min-w-0 flex-1 py-2">{toast.text}</span>
      {toast.action && (
        <button
          type="button"
          onClick={() => toastStore.runAction(toast.id)}
          className="min-h-11 min-w-11 shrink-0 rounded-full px-3 font-semibold text-accent-inverse"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label={UI.close}
        onClick={() => toastStore.dismiss(toast.id)}
        className="inline-grid size-11 shrink-0 place-items-center rounded-full text-bg"
      >
        <X aria-hidden size={18} />
      </button>
    </li>
  )
}
