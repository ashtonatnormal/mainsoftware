// The toasts' state, with its timers injected so the rules are tested without a browser (T21; X4,
// X5, SHL-39, DRV-42, WCAG 2.2.1). The demo's toasts vanished after a few seconds, could only
// navigate, and nobody could reach them. Here:
// - an action toast (Undo, say) and an error toast stay until the person dismisses them: what they
//   say or offer can't time out from under someone (X5);
// - a plain info toast leaves after 5 s, and its clock stops while it is hovered or holds focus,
//   then starts again from 5 s when both end;
// - an action takes a callback, and runAction() runs it once and closes the toast, so a double
//   press can't undo twice (X4);
// - at most 3 show: a fourth pushes out the oldest info toast, or, when none is info, the oldest
//   toast. That is a newer message replacing an older one, never a timer.
// toast.ts holds the app's one store; Toaster.tsx renders it.

export type ToastId = number
export type ToastTone = 'info' | 'error'
export type PauseReason = 'hover' | 'focus'

export interface ToastAction {
  readonly label: string
  run(): void | Promise<void>
}

export interface ToastInput {
  readonly text: string
  readonly tone?: ToastTone
  readonly action?: ToastAction
}

export interface Toast {
  readonly id: ToastId
  readonly text: string
  readonly tone: ToastTone
  readonly action?: ToastAction
}

export interface ToastStore {
  add(input: ToastInput): ToastId
  dismiss(id: ToastId): void
  pause(id: ToastId, reason: PauseReason): void
  resume(id: ToastId, reason: PauseReason): void
  runAction(id: ToastId): void
  subscribe(listener: () => void): () => void
  snapshot(): readonly Toast[]
}

export interface ToastDeps {
  setTimeout(task: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  infoMs?: number
  max?: number
  // An action that throws or rejects is reported here; the toast is closed either way.
  onActionError?(error: unknown): void
}

export const INFO_MS = 5_000
export const MAX_TOASTS = 3

// Only a plain info toast leaves by itself.
export const leavesByItself = (toast: Pick<Toast, 'tone' | 'action'>) => toast.tone === 'info' && !toast.action

export function createToastStore(deps: ToastDeps): ToastStore {
  const infoMs = deps.infoMs ?? INFO_MS
  const max = deps.max ?? MAX_TOASTS
  const report = deps.onActionError ?? ((error: unknown) => console.error(error))
  let toasts: readonly Toast[] = []
  let nextId = 1
  const timers = new Map<ToastId, unknown>()
  const pauses = new Map<ToastId, Set<PauseReason>>()
  const listeners = new Set<() => void>()

  const emit = () => {
    for (const listener of listeners) listener()
  }

  const stopTimer = (id: ToastId) => {
    if (!timers.has(id)) return
    deps.clearTimeout(timers.get(id))
    timers.delete(id)
  }

  const startTimer = (id: ToastId) => {
    stopTimer(id)
    timers.set(
      id,
      deps.setTimeout(() => {
        timers.delete(id)
        remove(id)
      }, infoMs),
    )
  }

  function remove(id: ToastId) {
    if (!toasts.some(toast => toast.id === id)) return
    stopTimer(id)
    pauses.delete(id)
    toasts = toasts.filter(toast => toast.id !== id)
    emit()
  }

  return {
    add(input) {
      const toast: Toast = { id: nextId++, text: input.text, tone: input.tone ?? 'info', action: input.action }
      let kept = [...toasts]
      while (kept.length >= max) {
        const oldestInfo = kept.find(leavesByItself)
        const leaving = oldestInfo ?? kept[0]
        if (!leaving) break
        stopTimer(leaving.id)
        pauses.delete(leaving.id)
        kept = kept.filter(t => t.id !== leaving.id)
      }
      toasts = [...kept, toast]
      if (leavesByItself(toast)) startTimer(toast.id)
      emit()
      return toast.id
    },
    dismiss: remove,
    pause(id, reason) {
      const toast = toasts.find(t => t.id === id)
      if (!toast) return
      const held = pauses.get(id) ?? new Set<PauseReason>()
      held.add(reason)
      pauses.set(id, held)
      stopTimer(id)
    },
    resume(id, reason) {
      const toast = toasts.find(t => t.id === id)
      const held = pauses.get(id)
      if (!toast || !held) return
      held.delete(reason)
      if (held.size > 0) return
      pauses.delete(id)
      if (leavesByItself(toast)) startTimer(id)
    },
    runAction(id) {
      const toast = toasts.find(t => t.id === id)
      if (!toast?.action) return
      // Closed first, so a second press finds nothing to run.
      remove(id)
      try {
        Promise.resolve(toast.action.run()).catch(report)
      } catch (error) {
        report(error)
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot: () => toasts,
  }
}
