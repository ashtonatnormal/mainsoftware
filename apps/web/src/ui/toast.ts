// The app's toasts (T21; X4, X5): one store, and the three calls screens use. toast() shows a
// message, undoToast() a message with Undo, and dismissToast() closes one. An action is a
// callback, never a route, so Undo can put back what the person just did (X4). <Toaster/> renders
// the store. The rules (who stays, who leaves, how many) are in toast-store.ts.

import { UI } from './strings.ts'
import { createToastStore, type ToastAction, type ToastId, type ToastTone } from './toast-store.ts'

export type { ToastId } from './toast-store.ts'

export const toastStore = createToastStore({
  setTimeout: (task, ms) => globalThis.setTimeout(task, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
})

export function toast(input: { text: string; tone?: ToastTone; action?: ToastAction }): ToastId {
  return toastStore.add(input)
}

// "Moved to Trash. Undo": the toast stays until the person presses Undo or closes it, and Undo runs
// once.
export function undoToast(text: string, undo: () => void | Promise<void>): ToastId {
  return toastStore.add({ text, action: { label: UI.undo, run: undo } })
}

export function dismissToast(id: ToastId): void {
  toastStore.dismiss(id)
}
