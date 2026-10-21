// Keeps Dialog's native <dialog> in step with its `open` prop however often React runs the effect
// (T21; SHL-45, DRV-48, D-03). React runs it again while `open` stays true: StrictMode's
// development double-run, Fast Refresh, an <Activity> hidden and shown again. Each cleanup closes
// the element (a hidden modal would leave the page behind it inert), and each close queues a native
// `close` event, which arrives after the next run has shown the element again, or while it stays
// hidden.
// - A `close` is the browser's own (a cancel it wouldn't let the page refuse, Android's back
//   gesture) only while the run that showed the element still holds it and the element is shut. A
//   close a cleanup caused is never passed on, so `open` stays the one truth.
// - The element that opened the dialog is read once per opening, at its first run, and only from
//   outside the dialog; later runs keep it, since by then focus may be inside the dialog, or
//   wherever it went while an <Activity> hid it (DRV-48).
// - Each cleanup gives focus back to it, unless closing put focus somewhere on purpose (the next
//   screen, a field).
// Plain code with no React and no DOM, so the tests can stand in for the browser.

export interface Focusable {
  readonly isConnected: boolean
  focus(options?: FocusOptions): void
}

// The parts of HTMLDialogElement the model uses.
export interface NativeDialog<E extends Focusable> {
  readonly open: boolean
  showModal(): void
  close(): void
  contains(other: E | null): boolean
}

export interface DialogModel<E extends Focusable> {
  // A run of the effect while `open` is true: shows the element and returns the run's cleanup.
  show(dialog: NativeDialog<E>): () => void
  // The element's native `close` event: true when the browser shut it and the caller must follow.
  closedByBrowser(dialog: NativeDialog<E>): boolean
  // `open` has turned false: the next opening reads its opener afresh.
  end(): void
}

// `focused` answers what has focus now, or null for nothing or <body>.
export function createDialogModel<E extends Focusable>(focused: () => E | null): DialogModel<E> {
  // undefined until this opening's first run has read it; null when nothing outside had focus.
  let opener: E | null | undefined
  // The element the current run showed, until its cleanup.
  let shown: NativeDialog<E> | null = null
  return {
    show(dialog) {
      if (opener === undefined) {
        const now = focused()
        opener = now !== null && !dialog.contains(now) ? now : null
      }
      if (!dialog.open) dialog.showModal()
      shown = dialog
      return () => {
        if (shown === dialog) shown = null
        if (dialog.open) dialog.close()
        const now = focused()
        const lost = now === null || dialog.contains(now)
        if (lost && opener?.isConnected) opener.focus({ preventScroll: true })
      }
    },
    closedByBrowser: dialog => shown === dialog && !dialog.open,
    end() {
      opener = undefined
    },
  }
}
