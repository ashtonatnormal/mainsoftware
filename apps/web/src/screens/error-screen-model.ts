// What the router's error screen does (T21; OD-42, X11, K-65, WCAG 4.1.3), kept apart from React so
// Node tests it (screens/error-screen-model.test.ts).
//
// Try again depends on what failed:
// - A screen's code that failed to load (a lazy chunk, or the stylesheet Vite preloads for it) can't
//   be fetched again in this document: Chromium keeps a failed dynamic import in the document's
//   module map, so the same import() fails at once with no request, and the router's own one reload
//   (its tanstack_router_reload:<message> marker) is already spent. Only a new document fetches it,
//   so Try again reloads the page. This is one reload per press, never a loop, so it doesn't go
//   through reloadForUpdate: that limit is for the automatic reloads (a gone deploy's
//   vite:preloadError, the gateway's 4426), and a press counted against it would hold back the
//   next document's automatic reload for a minute.
// - Anything else (a loader that failed, from C1) loads the route again (router.invalidate()).
//
// Inside the shell the screen's h1 still names the place (the route's title, so the person knows
// where they are) and focus lands on it, so the failure itself is said through the app's announcer.
// Above the shell the screen's own h1 says it, so nothing more is announced.
import { SHELL } from '@/strings/shell.ts'
import type { Politeness } from '@/ui/announce.ts'

// The messages a failed dynamic import has in each engine (Chromium, Firefox, WebKit), as
// router-core's isModuleNotFoundError knows them, and Vite's when a chunk's stylesheet failed.
const LOAD_FAILURES = [
  'Failed to fetch dynamically imported module',
  'error loading dynamically imported module',
  'Importing a module script failed',
  'Unable to preload CSS for',
] as const

export function isLoadFailure(error: unknown): boolean {
  const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined
  return typeof message === 'string' && LOAD_FAILURES.some(start => message.startsWith(start))
}

export type Retry = 'reload' | 'invalidate'

export const retryFor = (error: unknown): Retry => (isLoadFailure(error) ? 'reload' : 'invalidate')

// What the screen announces when it appears, if anything.
export function failureAnnouncement(inShell: boolean): { text: string; politeness: Politeness } | undefined {
  return inShell ? { text: SHELL.error.title, politeness: 'assertive' } : undefined
}
