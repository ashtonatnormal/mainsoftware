// A session is a document (T21, D-01, D-02; R-42, R-44, CHT-60, K-08, K-10, K-42). Every change of
// person ends in a full page load: sign-in, sign-out, a 401 signed_out, the gateway's 4401, a
// session answer naming someone else, or another tab's sign-in or sign-out. So the QueryClient,
// the gateway client, the router and every module's state live exactly as long as one person's
// document, and nothing of theirs can outlive it. This file is the only way a document hands over
// to the next.
//
// What may cross a document load is sessionStorage, and only these keys (WS-01 keeps every other
// file off sessionStorage, and off localStorage, IndexedDB and Cache Storage entirely):
// - hearth:left: why the last document left (a LeftReason), for the sign-in screen's status line;
// - hearth:return-to: an app path (APP_PATHS) a signed-out visit asked for, opened after sign-in;
// - hearth:reloaded-at: when reloadForUpdate last reloaded (epoch ms), so it reloads once a minute;
// - hearth:focus-heading: '1', for one load: the next document's first route focuses its h1;
// - the router's scroll cache (tsr-scroll-restoration*), keyed by path, which every boot removes
//   before the router loads (boot/pre-boot.ts) and leaveDocument removes as well;
// - the router's own tanstack_router_reload:<message> marker (lazyRouteComponent.js:37-41), set
//   before the one reload it makes after a chunk failed to load. It holds an asset URL, not
//   anyone's data, and is never removed: it is what stops a missing chunk reloading for ever.
// None holds anyone's data. The person's id, name and everything the api sent stay in memory.
//
// The identity channel (a BroadcastChannel) tells this browser's other tabs that the person here
// changed. Its message is { t: 'identity' } alone: no id, no data. A signed-in tab that hears it
// ends its runtime with other_tab and reloads, so its next document shows whoever the cookie now
// names. A signed-out tab asks GET /api/session again and reloads only when it names a person
// (app/boot.tsx), so another tab's sign-out doesn't cost a sign-in step in progress. A document
// opens at most one channel object, so its own posts never come back to it.
//
// main.ts loads this file statically, before preBoot() runs, so it imports nothing but import-free
// modules (boot/pre-boot.ts, router/paths.ts) and types (WS-10).
import { type ScrollCacheStorage, safeSessionStorage, wipeScrollCache } from '@/boot/pre-boot.ts'
import { type AppPath, isAppPath } from '@/router/paths.ts'

export const LEFT_REASONS = ['signed_out_here', 'session_ended', 'person_changed', 'other_tab'] as const
// signed_out_here: this tab pressed Sign out. session_ended: the server ended the session (a 401
// signed_out, a 4401). person_changed: the session answer named someone else. other_tab: another
// tab signed in or out.
export type LeftReason = (typeof LEFT_REASONS)[number]

export const STORAGE_KEYS = {
  left: 'hearth:left',
  returnTo: 'hearth:return-to',
  reloadedAt: 'hearth:reloaded-at',
  focusHeading: 'hearth:focus-heading',
} as const

// reloadForUpdate reloads at most once in this many milliseconds (K-42).
export const RELOAD_MIN_MS = 60_000

export const IDENTITY_CHANNEL = 'hearth:identity'
const IDENTITY_MESSAGE = Object.freeze({ t: 'identity' })

export type TabStorage = ScrollCacheStorage & Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export interface ChannelLike {
  postMessage(message: unknown): void
  close(): void
  onmessage: ((event: MessageEvent) => void) | null
}

export interface DocumentEnv {
  readonly location: Pick<Location, 'replace' | 'reload'>
  // This tab's session storage, or undefined when the browser refuses it.
  readonly storage: TabStorage | undefined
  addEventListener(type: 'pagehide', listener: () => void): void
  readonly BroadcastChannel: (new (name: string) => ChannelLike) | undefined
}

export function browserDocumentEnv(): DocumentEnv {
  return {
    location: window.location,
    storage: safeSessionStorage(window),
    addEventListener: (type, listener) => window.addEventListener(type, listener),
    BroadcastChannel: typeof BroadcastChannel === 'function' ? BroadcastChannel : undefined,
  }
}

const tabStorage = (): TabStorage | undefined =>
  typeof window === 'undefined' ? undefined : safeSessionStorage(window)

function read(storage: TabStorage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

// Says whether the value was stored.
function write(storage: TabStorage | undefined, key: string, value: string): boolean {
  if (storage === undefined) return false
  try {
    storage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

function remove(storage: TabStorage | undefined, key: string): void {
  try {
    storage?.removeItem(key)
  } catch {
    // Absent storage holds nothing to remove.
  }
}

// --- The identity channel ---

export interface IdentityChannel {
  post(): void
  close(): void
}

// The document's one channel object, shared by everything that listens in it.
let identity: { channel: ChannelLike | undefined; listeners: Set<() => void> } | undefined

const isIdentity = (data: unknown) =>
  typeof data === 'object' && data !== null && (data as { t?: unknown }).t === 'identity'

function newChannel(env: Pick<DocumentEnv, 'BroadcastChannel'>): ChannelLike | undefined {
  try {
    return env.BroadcastChannel === undefined ? undefined : new env.BroadcastChannel(IDENTITY_CHANNEL)
  } catch {
    return undefined
  }
}

// Tells the other tabs: through this document's channel when one is open (so it doesn't come back
// here), else through one opened for the post and closed at once (a closed sender's message is
// still delivered).
function postIdentity(env: Pick<DocumentEnv, 'BroadcastChannel'>): void {
  const open = identity?.channel
  const channel = open ?? newChannel(env)
  try {
    channel?.postMessage(IDENTITY_MESSAGE)
  } catch {
    // A tab that can't post leaves the others to notice at their next session answer or 4401.
  }
  if (open === undefined) {
    try {
      channel?.close()
    } catch {
      // Nothing more to do with it.
    }
  }
}

// Calls onIdentity when another tab of this browser says its person changed.
export function openIdentityChannel(
  env: Pick<DocumentEnv, 'BroadcastChannel'>,
  onIdentity: () => void,
): IdentityChannel {
  if (identity === undefined) {
    const listeners = new Set<() => void>()
    const channel = newChannel(env)
    if (channel)
      channel.onmessage = event => {
        if (!isIdentity(event.data)) return
        for (const listener of [...listeners]) listener()
      }
    identity = { channel, listeners }
  }
  const current = identity
  current.listeners.add(onIdentity)
  return {
    post: () => postIdentity(env),
    close: () => {
      current.listeners.delete(onIdentity)
      if (current.listeners.size > 0) return
      try {
        current.channel?.close()
      } catch {
        // Closed either way.
      }
      if (identity === current) identity = undefined
    },
  }
}

// --- Leaving and entering ---

// The end of a signed-in document (the session runtime's end(), last step). It records why, so the
// next document can say so; flags its first route to focus the h1; tells the other tabs unless
// another tab is why; removes the router's scroll cache now and again on pagehide, after the
// router's own pagehide write (the next boot removes it too, before the router exists); then loads
// the next document: sign-in, or for other_tab a reload, which opens whatever the cookie now holds.
export function leaveDocument(reason: LeftReason, env: DocumentEnv): void {
  write(env.storage, STORAGE_KEYS.left, reason)
  write(env.storage, STORAGE_KEYS.focusHeading, '1')
  if (reason !== 'other_tab') postIdentity(env)
  wipeScrollCache(env.storage)
  try {
    env.addEventListener('pagehide', () => wipeScrollCache(env.storage))
  } catch {
    // The boot's own wipe still runs before the next router loads.
  }
  if (reason === 'other_tab') env.location.reload()
  else env.location.replace('/sign-in')
}

// The end of a sign-in (C0.8 S11): tells the other tabs, flags the next document's first route to
// focus its h1, then opens the path a signed-out visit asked for, or Chats (OD-03).
export function enterDocument(env: DocumentEnv): void {
  postIdentity(env)
  remove(env.storage, STORAGE_KEYS.left)
  write(env.storage, STORAGE_KEYS.focusHeading, '1')
  env.location.replace(takeReturnTo(env.storage) ?? '/chats')
}

// Keeps the path a signed-out visit asked for (R-44): only a registered app path, which holds no
// query and no other origin. Any other path forgets an older one, so sign-in opens what was asked
// for last or nothing.
export function rememberReturnTo(pathname: string, storage: TabStorage | undefined = tabStorage()): void {
  if (isAppPath(pathname)) write(storage, STORAGE_KEYS.returnTo, pathname)
  else remove(storage, STORAGE_KEYS.returnTo)
}

// Reads the kept path once, and checks it against APP_PATHS again.
export function takeReturnTo(storage: TabStorage | undefined = tabStorage()): AppPath | undefined {
  const path = read(storage, STORAGE_KEYS.returnTo)
  remove(storage, STORAGE_KEYS.returnTo)
  return path !== null && isAppPath(path) ? path : undefined
}

// Reads why the last document left, once.
export function takeLeftReason(storage: TabStorage | undefined = tabStorage()): LeftReason | undefined {
  const reason = read(storage, STORAGE_KEYS.left)
  remove(storage, STORAGE_KEYS.left)
  return LEFT_REASONS.find(known => known === reason)
}

// Whether this document's first route should focus its h1 (router/RouteFocus.tsx), once.
export function takeFocusHeading(storage: TabStorage | undefined = tabStorage()): boolean {
  const flag = read(storage, STORAGE_KEYS.focusHeading)
  remove(storage, STORAGE_KEYS.focusHeading)
  return flag === '1'
}

// Reloads for a new deploy (the gateway's 4426, or vite:preloadError) at most once a minute (K-42),
// so a stale index.html can't reload the tab in a loop. Blocked when the last reload was under a
// minute ago, or when the time of this one can't be stored; the caller then shows its own way out
// (a Reload button, or the screen's error).
export function reloadForUpdate(
  env: { readonly location: Pick<Location, 'reload'>; readonly storage: TabStorage | undefined },
  now: number = Date.now(),
): 'reloaded' | 'blocked' {
  const raw = read(env.storage, STORAGE_KEYS.reloadedAt)
  const last = raw === null ? Number.NaN : Number(raw)
  if (Number.isFinite(last) && now >= last && now - last < RELOAD_MIN_MS) return 'blocked'
  if (!write(env.storage, STORAGE_KEYS.reloadedAt, String(now))) return 'blocked'
  env.location.reload()
  return 'reloaded'
}
