// Where focus goes when the control that had it goes away (T21; X6, SHL-42, SHL-44). Removing the
// focused element drops focus to <body>, and a keyboard or screen reader user starts again from the
// top. The convention, for any action that removes or replaces the control that was pressed (a
// toast's button, a step that changes, C0.15's onboarding): call focusAfter() with the element that
// should have focus next. It waits for React to commit (a microtask, then a frame), then focuses
// that element, or else the screen's visible h1, or else #main. Focus never scrolls the page.
//
// RouteFocus (router/) does the same for every route change; the kit's toasts use it when a toast
// that held focus closes.

export interface FocusEnv {
  queueMicrotask(task: () => void): void
  requestFrame(task: () => void): void
  // The screen's titles (h1[data-screen-title]) in document order, and #main.
  headings(): readonly FocusTarget[]
  main(): FocusTarget | null
}

export interface FocusTarget {
  readonly isConnected: boolean
  focus(options?: FocusOptions): void
  // An element with no boxes is display: none (one of the two layouts' copies), so it can't take focus.
  getClientRects(): { readonly length: number }
}

export type FocusFallback = 'heading' | 'main'

const browserEnv = (): FocusEnv => ({
  queueMicrotask: task => queueMicrotask(task),
  requestFrame: task => {
    requestAnimationFrame(() => task())
  },
  headings: () => [...document.querySelectorAll<HTMLElement>('h1[data-screen-title]')],
  main: () => document.getElementById('main'),
})

const visible = (target: FocusTarget) => target.isConnected && target.getClientRects().length > 0

function focusFallback(fallback: FocusFallback, env: FocusEnv): void {
  const heading = fallback === 'heading' ? env.headings().find(visible) : undefined
  ;(heading ?? env.main())?.focus({ preventScroll: true })
}

export function focusAfter(
  target: () => FocusTarget | null | undefined,
  fallback: FocusFallback = 'heading',
  env: FocusEnv = browserEnv(),
): void {
  afterCommit(() => {
    const next = target()
    if (next && visible(next)) next.focus({ preventScroll: true })
    else focusFallback(fallback, env)
  }, env)
}

// Runs the task when focusAfter() moves focus: once React has committed (a microtask, then a
// frame). The sign-in screen says its messages this way, so the text reaches the announcer's region
// a frame after any focus move the same commit asked for, and the screen reader reads the newly
// focused element first instead of cutting the message short.
export function afterCommit(
  task: () => void,
  env: Pick<FocusEnv, 'queueMicrotask' | 'requestFrame'> = browserEnv(),
): void {
  env.queueMicrotask(() => env.requestFrame(task))
}

// Focus the screen's visible h1 now, or #main when the screen has none.
export function focusScreenHeading(env: FocusEnv = browserEnv()): void {
  focusFallback('heading', env)
}
