// What runs before any library code exists (T21, D-02; K-08, K-09, K-65). main.ts calls preBoot()
// first, and only then loads the app by one dynamic import, so nothing in the app's graph (React,
// the router, Query, zod) has evaluated yet when this runs. It imports nothing (WS-10), and every
// storage access is guarded: storage that throws (blocked by the browser's settings) reads as absent.
//
// 1. Every boot removes the router's scroll cache. Router-core reads its cache from sessionStorage
//    when its module loads and writes all of it back on pagehide (scroll-restoration.js:10-19,
//    101-108), keyed by path, so one person's paths would reach the next document. The wipe is
//    unconditional: a session that ended while the tab was closed, crashed or discarded leaves no
//    marker to look for. Scroll positions are therefore kept within a document, never across a
//    load (recorded in T21 item 2). The router's own `tanstack_router_reload:<message>` marker and
//    Hearth's `hearth:*` keys stay (session/document.ts lists them).
// 2. A page restored from the back-forward cache is the previous document, perhaps the previous
//    person's: it reloads.
// 3. vite:preloadError (a stylesheet or chunk of a deploy that's gone) asks onPreloadError, which
//    reloads at most once a minute (session/document.ts, reloadForUpdate). When it reloaded, the
//    error is stopped; when it's blocked, the error goes on to the screen that loaded the chunk.
// 4. zod is told, before it loads, to build no code from strings (K-01, K-05). zod 4 compiles an
//    object schema's parser with `new Function` when it can, and finds out whether it can by trying
//    `new Function('')` when the first object schema is built. The app's CSP has no 'unsafe-eval',
//    so the browser blocks that probe: zod catches the error, but the browser still reports a
//    violation, and every page load would send /api/csp-report one, filling the log's cap and
//    hiding the real ones. zod's `jitless` setting turns the compiler and its probe off, but it is
//    read when a schema is built, and in the build zod and @hearth/shared's schemas share a chunk
//    that runs before any app module's own code could call z.config() (the e2e guard caught it).
//    zod keeps its settings in one global object, which it adopts when it loads if one is there
//    (zod/v4/core/core.js: globalThis.__zod_globalConfig ??= {}), so this sets jitless there first;
//    boot/zod-preset.test.ts checks zod still adopts it. It is the one __ member the app may write
//    (the web source guard's WS-02 names it).

// Every key the router's scroll cache has used or may use (`tsr-scroll-restoration-v1_3` today).
export const SCROLL_CACHE_PREFIX = 'tsr-scroll-restoration'

export interface ScrollCacheStorage {
  readonly length: number
  key(index: number): string | null
  removeItem(key: string): void
}

// zod's settings object, read when zod loads (item 4).
export interface ZodConfigHolder {
  __zod_globalConfig?: { jitless?: boolean }
}

export interface PreBootWindow extends ZodConfigHolder {
  // Reading it may throw; preBoot reads it through safeSessionStorage().
  readonly sessionStorage: ScrollCacheStorage
  readonly location: Pick<Location, 'reload'>
  addEventListener(type: 'pageshow' | 'vite:preloadError', listener: (event: Event) => void): void
}

// The window's session storage, or undefined when reading it throws.
export function safeSessionStorage<S>(win: { readonly sessionStorage: S }): S | undefined {
  try {
    return win.sessionStorage ?? undefined
  } catch {
    return undefined
  }
}

// Removes every scroll-cache key, last index first so removals don't shift what is still to read.
// Each key on its own: one that can't be removed doesn't stop the rest.
export function wipeScrollCache(storage: ScrollCacheStorage | undefined): void {
  if (storage === undefined) return
  let length = 0
  try {
    length = storage.length
  } catch {
    return
  }
  for (let index = length - 1; index >= 0; index--) {
    try {
      const key = storage.key(index)
      if (key?.startsWith(SCROLL_CACHE_PREFIX)) storage.removeItem(key)
    } catch {
      // Keep going: the next key may still be removable.
    }
  }
}

// Sets zod's jitless before zod loads (item 4), keeping any other setting already there.
export function presetZodJitless(scope: ZodConfigHolder): void {
  scope.__zod_globalConfig ??= {}
  scope.__zod_globalConfig.jitless = true
}

export function preBoot(win: PreBootWindow, onPreloadError: () => 'reloaded' | 'blocked'): void {
  presetZodJitless(win)
  wipeScrollCache(safeSessionStorage(win))

  win.addEventListener('pageshow', event => {
    if ((event as PageTransitionEvent).persisted === true) win.location.reload()
  })

  // Once a reload is under way, later preload errors (several chunks of the same gone deploy)
  // are stopped too, so none of them reaches a screen while the page reloads.
  let reloading = false
  win.addEventListener('vite:preloadError', event => {
    if (!reloading && onPreloadError() === 'reloaded') reloading = true
    if (reloading) event.preventDefault()
  })
}
