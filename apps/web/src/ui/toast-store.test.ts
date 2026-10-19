import { describe, expect, it, vi } from 'vitest'
import { createToastStore, INFO_MS, MAX_TOASTS } from './toast-store.ts'

// A store on Vitest's fake clock.
function fakeStore(onActionError?: (error: unknown) => void) {
  vi.useFakeTimers()
  const store = createToastStore({
    setTimeout: (task, ms) => setTimeout(task, ms),
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    onActionError,
  })
  const texts = () => store.snapshot().map(toast => toast.text)
  return { store, texts }
}

describe('T21: toasts (toast-store.ts)', () => {
  it('TS-01 X5 SHL-39 DRV-42 WCAG 2.2.1: action and error toasts stay until dismissed', () => {
    const { store, texts } = fakeStore()
    const undo = store.add({ text: 'Moved to Trash.', action: { label: 'Undo', run: () => {} } })
    const error = store.add({ text: 'Couldn’t sign out.', tone: 'error' })
    vi.advanceTimersByTime(60 * 60_000)
    expect(texts()).toEqual(['Moved to Trash.', 'Couldn’t sign out.'])
    store.dismiss(error)
    expect(texts()).toEqual(['Moved to Trash.'])
    store.dismiss(undo)
    store.dismiss(undo)
    expect(texts()).toEqual([])
    vi.useRealTimers()
  })

  it('TS-02 X5: an info toast leaves after 5 s, paused while hovered or focused', () => {
    const { store, texts } = fakeStore()
    expect(INFO_MS).toBe(5_000)
    const id = store.add({ text: 'Saved.' })
    vi.advanceTimersByTime(4_999)
    expect(texts()).toEqual(['Saved.'])
    vi.advanceTimersByTime(1)
    expect(texts()).toEqual([])

    const held = store.add({ text: 'Copied.' })
    vi.advanceTimersByTime(4_000)
    store.pause(held, 'hover')
    store.pause(held, 'focus')
    vi.advanceTimersByTime(60_000)
    expect(texts()).toEqual(['Copied.'])
    // Still focused after the pointer leaves: the clock stays stopped.
    store.resume(held, 'hover')
    vi.advanceTimersByTime(60_000)
    expect(texts()).toEqual(['Copied.'])
    // Both ended: 5 s again, from the start.
    store.resume(held, 'focus')
    vi.advanceTimersByTime(4_999)
    expect(texts()).toEqual(['Copied.'])
    vi.advanceTimersByTime(1)
    expect(texts()).toEqual([])
    // Pausing or resuming a toast that's gone does nothing.
    store.pause(id, 'hover')
    store.resume(id, 'hover')
    expect(texts()).toEqual([])
    vi.useRealTimers()
  })

  it('TS-03 X4: undoToast runs its callback once and closes', async () => {
    const errors: unknown[] = []
    const { store, texts } = fakeStore(error => errors.push(error))
    const run = vi.fn()
    const id = store.add({ text: 'Moved to Trash.', action: { label: 'Undo', run } })
    store.runAction(id)
    store.runAction(id)
    expect(run).toHaveBeenCalledTimes(1)
    expect(texts()).toEqual([])
    // An action that fails is reported, and its toast is closed all the same.
    const throws = store.add({ text: 'A', action: { label: 'Undo', run: () => Promise.reject(new Error('gone')) } })
    store.runAction(throws)
    expect(texts()).toEqual([])
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    const sync = store.add({
      text: 'B',
      action: {
        label: 'Undo',
        run: () => {
          throw new Error('gone')
        },
      },
    })
    store.runAction(sync)
    expect(errors).toHaveLength(2)
    // A toast with no action has nothing to run.
    const plain = store.add({ text: 'C' })
    store.runAction(plain)
    expect(texts()).toEqual(['C'])
    vi.useRealTimers()
  })

  it('TS-04: at most 3; the oldest info toast leaves first; action toasts never auto-leave', () => {
    const { store, texts } = fakeStore()
    expect(MAX_TOASTS).toBe(3)
    const action = { label: 'Undo', run: () => {} }
    store.add({ text: 'undo 1', action })
    store.add({ text: 'info 1' })
    store.add({ text: 'info 2' })
    store.add({ text: 'undo 2', action })
    expect(texts()).toEqual(['undo 1', 'info 2', 'undo 2'])
    store.add({ text: 'error 1', tone: 'error' })
    expect(texts()).toEqual(['undo 1', 'undo 2', 'error 1'])
    // With no info toast left, a newer toast replaces the oldest; no timer ever closes one.
    store.add({ text: 'undo 3', action })
    expect(texts()).toEqual(['undo 2', 'error 1', 'undo 3'])
    vi.advanceTimersByTime(60 * 60_000)
    expect(texts()).toEqual(['undo 2', 'error 1', 'undo 3'])
    vi.useRealTimers()
  })

  it('tells subscribers of each change, and stops when they unsubscribe', () => {
    const { store } = fakeStore()
    const listener = vi.fn()
    const stop = store.subscribe(listener)
    const id = store.add({ text: 'A' })
    store.dismiss(id)
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
    store.add({ text: 'B' })
    expect(listener).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})
