// The route tree, loaded in Node with a memory history (T21 item 1). Node runs the router's server
// load, which doesn't follow a redirect, so a guard's redirect is read from the guard itself and its
// effect (the return path) from storage; what each path matches is read from the loaded router.
import { type NoticeStanding, ROUTE_WORDS } from '@hearth/shared'
import { createMemoryHistory, isRedirect } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import type { TabStorage } from '@/session/document.ts'
import { createNoticeStore } from '@/session/notice.ts'
import type { SessionRuntime } from '@/session/runtime.ts'
import { NAV } from '@/shell/nav.ts'
import { SHELL } from '@/strings/shell.ts'
import { APP_PATHS, NAV_PATHS, noticeAllowsPath } from './paths.ts'
import { createAppRouter, noticeMove, ROUTER_OPTIONS, type RouterContext } from './router.tsx'

function memoryStorage(): TabStorage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get length() {
      return map.size
    },
    key: index => [...map.keys()][index] ?? null,
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
    removeItem: key => {
      map.delete(key)
    },
  }
}

// What a route's guard reads of a runtime: the person's standing with the privacy notice (a real
// store over stand-ins, C0.9 PD-46), and whether the latest session answer allows the DPO's pages
// (registers). Nothing in a component reads it while loading.
function runtimeWith(
  standing: NoticeStanding,
  options: { registers?: boolean; latest?: { capabilities: { registers: boolean } } } = {},
): SessionRuntime {
  const noop = () => {}
  return {
    info: {
      personId: 'b0000000-0000-4000-8000-000000000003',
      name: 'Marcus',
      timeZone: 'Asia/Singapore',
      capabilities: { registers: options.registers === true },
      notice: standing,
    },
    queryClient: { getQueryData: () => options.latest },
    notice: createNoticeStore({
      initial: standing,
      live: { start: noop, resume: noop },
      refetchAll: noop,
      resetNotice: noop,
      fetchNotice: noop,
      post: noop,
    }),
  } as unknown as SessionRuntime
}

const RUNTIME = runtimeWith('acknowledged')

function routerAt(path: string, context: RouterContext) {
  return createAppRouter(context, createMemoryHistory({ initialEntries: [path] }))
}

const signedIn = (): RouterContext => ({ runtime: RUNTIME, storage: memoryStorage() })

// Runs a route's guard as the router would, and returns the redirect it throws, if any.
function guard(routeId: string, path: string, context: RouterContext): { to?: unknown; replace?: unknown } | undefined {
  const router = routerAt(path, context)
  const route = router.routesById[routeId as keyof typeof router.routesById]
  const beforeLoad = route?.options.beforeLoad as ((options: unknown) => unknown) | undefined
  expect(beforeLoad, routeId).toBeTypeOf('function')
  try {
    beforeLoad?.({ context, location: router.buildLocation({ to: path as '/' }) })
  } catch (thrown) {
    if (isRedirect(thrown)) return { to: thrown.options.to, replace: thrown.options.replace }
    throw thrown
  }
  return undefined
}

// The paths registered inside the shell, the index and the splat aside.
function shellPaths(): string[] {
  const router = routerAt('/', signedIn())
  return Object.values(router.routesById)
    .filter(route => route.parentRoute?.id === '/_app')
    .map(route => route.fullPath as string)
    .filter(path => path !== '/' && path !== '/$')
}

describe('T21 item 1: the route tree (router/router.tsx)', () => {
  it('RO-01 X12 OD-02 OD-03 C0.9 PD-26 PD-47 PD-48: every NAV path is a route with its title; Settings, its Privacy section and the DPO pages are routes with theirs and no nav entry; / goes to /chats; APP_PATHS (importing no module but a type, so main.ts may reach it) equals the paths registered in the shell, splat excluded, and NAV_PATHS the NAV entries', async () => {
    for (const entry of Object.values(NAV)) {
      const router = routerAt(entry.to, signedIn())
      await router.load()
      const leaf = router.state.matches.at(-1)
      expect(leaf?.routeId, entry.to).toBe(`/_app${entry.to}`)
      expect(leaf?.staticData.title, entry.to).toBe(entry.label)
      expect(leaf?.staticData.nav, entry.to).toBe(entry.id)
    }
    for (const [path, title] of [
      ['/settings', SHELL.settings.title],
      ['/settings/privacy', SHELL.settings.privacy],
      ['/dpo/purposes', SHELL.dpo.purposes],
      ['/dpo/transfers', SHELL.dpo.transfers],
      ['/dpo/notice', SHELL.dpo.notice],
    ] as const) {
      const router = routerAt(path, signedIn())
      await router.load()
      const leaf = router.state.matches.at(-1)
      expect(leaf?.routeId, path).toBe(`/_app${path}`)
      expect(leaf?.staticData.title, path).toBe(title)
      expect(leaf?.staticData.nav, path).toBeUndefined()
    }
    expect(guard('/_app/', '/', signedIn())).toEqual({ to: '/chats', replace: true })
    expect([...shellPaths()].sort()).toEqual([...APP_PATHS].sort())
    expect(new Set(APP_PATHS).size).toBe(APP_PATHS.length)
    expect([...NAV_PATHS].sort()).toEqual(
      Object.values(NAV)
        .map(entry => entry.to as string)
        .sort(),
    )
    expect(APP_PATHS.filter(path => !(NAV_PATHS as readonly string[]).includes(path))).toEqual([
      '/settings',
      '/settings/privacy',
      '/dpo/purposes',
      '/dpo/transfers',
      '/dpo/notice',
    ])
  })

  it('RO-02 D-02: getScrollRestorationKey is the pathname only; #screen is the scroll container', () => {
    const router = routerAt('/chats', signedIn())
    const location = router.buildLocation({ to: '/chats', hash: 'x' })
    expect(ROUTER_OPTIONS.getScrollRestorationKey({ ...location, searchStr: '?q=1', href: '/chats?q=1#x' })).toBe(
      '/chats',
    )
    expect(ROUTER_OPTIONS.scrollRestoration).toBe(true)
    expect(ROUTER_OPTIONS.scrollToTopSelectors).toEqual(['#screen'])
    expect(router.options.getScrollRestorationKey).toBe(ROUTER_OPTIONS.getScrollRestorationKey)
  })

  it('RO-03 T21 item 5 C0.9 PD-46: /admin is not a route and not in APP_PATHS: signed in it is Page not found; /notice is a route outside the shell, not an app path, titled Privacy notice', async () => {
    for (const path of ['/admin', '/admin/roles', '/settings/devices']) {
      expect(APP_PATHS as readonly string[], path).not.toContain(path)
      const router = routerAt(path, signedIn())
      await router.load()
      expect(router.state.matches.at(-1)?.routeId, path).toBe('/_app/$')
    }
    expect(APP_PATHS as readonly string[]).not.toContain('/notice')
    for (const standing of ['acknowledged', 'required', 'unpublished'] as const) {
      const context = { runtime: runtimeWith(standing), storage: memoryStorage() }
      expect(guard('/notice', '/notice', context), standing).toBeUndefined()
      const router = routerAt('/notice', context)
      await router.load()
      expect(
        router.state.matches.map(match => match.routeId),
        standing,
      ).toEqual(['__root__', '/notice'])
      expect(router.state.matches.at(-1)?.staticData.title, standing).toBe('Privacy notice')
    }
  })

  it('T21 item 5 RO-04: no route declares validateSearch or a search middleware, so no URL carries state', () => {
    const router = routerAt('/', signedIn())
    const routes = Object.values(router.routesById)
    expect(routes.length).toBeGreaterThan(10)
    for (const route of routes) {
      const options = route.options as { validateSearch?: unknown; search?: unknown; loaderDeps?: unknown }
      expect(options.validateSearch, route.id).toBeUndefined()
      expect(options.search, route.id).toBeUndefined()
      expect(options.loaderDeps, route.id).toBeUndefined()
    }
  })

  it("RO-05 T21 item 5: /xyz, /chats/abc and /sign-in/foo match the splat under _app, so _app's guard runs: signed out they go to /sign-in and keep no return path; signed in the match is __root__ > _app > $ titled Page not found", async () => {
    for (const path of ['/xyz', '/chats/abc', '/sign-in/foo']) {
      // Signed out: the guard sends the visit to sign-in, and an unknown path forgets an older
      // return path rather than keeping itself.
      const storage = memoryStorage()
      storage.map.set('hearth:return-to', '/rooms')
      const out: RouterContext = { runtime: null, storage }
      expect(guard('/_app', path, out), path).toEqual({ to: '/sign-in', replace: true })
      expect(storage.map.has('hearth:return-to'), path).toBe(false)
      const away = routerAt(path, { runtime: null, storage: memoryStorage() })
      await away.load()
      expect(
        away.matchRoutes(away.state.location).map(match => match.routeId),
        path,
      ).toEqual(['__root__', '/_app', '/_app/$'])

      // Signed in: the shell shows the not-found screen with its one title.
      const router = routerAt(path, signedIn())
      await router.load()
      expect(
        router.state.matches.map(match => match.routeId),
        path,
      ).toEqual(['__root__', '/_app', '/_app/$'])
      expect(router.state.matches.at(-1)?.staticData.title, path).toBe('Page not found')
    }
  })

  it('T21 item 5 OD-03 C0.9 PD-26: signed out, an app path (a DPO page included) is kept as the return path and the guard sends the visit to sign-in; signed in, /sign-in goes to /chats; signed out, /sign-in is the sign-in screen', async () => {
    const storage = memoryStorage()
    expect(guard('/_app', '/tasks', { runtime: null, storage })).toEqual({ to: '/sign-in', replace: true })
    expect(storage.map.get('hearth:return-to')).toBe('/tasks')
    // A DPO page is an app path too, so a deep link to it survives the sign-in (C0.9 PD-26).
    expect(guard('/_app', '/dpo/transfers', { runtime: null, storage })).toEqual({ to: '/sign-in', replace: true })
    expect(storage.map.get('hearth:return-to')).toBe('/dpo/transfers')
    expect(guard('/sign-in', '/sign-in', signedIn())).toEqual({ to: '/chats', replace: true })
    expect(guard('/sign-in', '/sign-in', { runtime: null, storage: memoryStorage() })).toBeUndefined()
    const router = routerAt('/sign-in', { runtime: null, storage: memoryStorage() })
    await router.load()
    expect(router.state.matches.map(match => match.routeId)).toEqual(['__root__', '/sign-in'])
    expect(router.state.matches.at(-1)?.staticData.title).toBe('Sign in')
  })

  it("RO-06 T21 item 9: ROUTE_WORDS, the only segments a CSP report's path keeps, equals the words of every path the router registers", () => {
    const router = routerAt('/', signedIn())
    const words = new Set(
      Object.values(router.routesById)
        .flatMap(route => (route.fullPath as string).split('/'))
        .filter(segment => segment !== '' && segment !== '$'),
    )
    expect([...words].sort()).toEqual([...ROUTE_WORDS].sort())
    expect(new Set(ROUTE_WORDS).size).toBe(ROUTE_WORDS.length)
  })

  it('NTW-05 C0.9 PD-44 PD-46 T22 items 29 and 31: noticeAllowsPath lets an acknowledged person go anywhere, the DPO only their own pages before any version is published, and nobody anything else', () => {
    const paths = ['/chats', '/settings/privacy', '/dpo/purposes', '/dpo/transfers', '/dpo/notice', '/xyz']
    for (const path of paths) {
      expect(noticeAllowsPath('acknowledged', false, path), path).toBe(true)
      expect(noticeAllowsPath('acknowledged', true, path), path).toBe(true)
      expect(noticeAllowsPath('required', true, path), path).toBe(false)
      expect(noticeAllowsPath('required', false, path), path).toBe(false)
      expect(noticeAllowsPath('unpublished', false, path), path).toBe(false)
      expect(noticeAllowsPath('unpublished', true, path), path).toBe(path.startsWith('/dpo/'))
    }
    // By whole segment: a path that only begins with the letters is not the DPO's.
    expect(noticeAllowsPath('unpublished', true, '/dpox')).toBe(false)
    expect(noticeAllowsPath('unpublished', true, '/dpo')).toBe(false)
  })

  it('NTW-05 C0.9 PD-46 WS-01: signed in, the shell’s guard sends a person who hasn’t acknowledged to /notice, keeping an app path in the store’s memory and never in storage; acknowledged, nothing moves', () => {
    const storage = memoryStorage()
    const required = runtimeWith('required')
    expect(guard('/_app', '/tasks', { runtime: required, storage })).toEqual({ to: '/notice', replace: true })
    expect(required.notice.takeReturn()).toBe('/tasks')
    expect(storage.map.size).toBe(0)
    // An unknown path is never kept.
    expect(guard('/_app', '/xyz', { runtime: required, storage })).toEqual({ to: '/notice', replace: true })
    expect(required.notice.takeReturn()).toBeUndefined()
    for (const path of ['/tasks', '/settings', '/dpo/notice', '/xyz'])
      expect(guard('/_app', path, { runtime: runtimeWith('acknowledged'), storage }), path).toBeUndefined()

    // Before v0 (OD-01): the DPO reaches their own pages, and only them.
    const dpo = runtimeWith('unpublished', { registers: true })
    expect(guard('/_app', '/dpo/purposes', { runtime: dpo, storage })).toBeUndefined()
    expect(guard('/_app', '/dpo/notice', { runtime: dpo, storage })).toBeUndefined()
    expect(guard('/_app', '/chats', { runtime: dpo, storage })).toEqual({ to: '/notice', replace: true })
    const member = runtimeWith('unpublished')
    expect(guard('/_app', '/dpo/purposes', { runtime: member, storage })).toEqual({ to: '/notice', replace: true })
    // The latest session answer's capability counts, over the boot's.
    const promoted = runtimeWith('unpublished', { latest: { capabilities: { registers: true } } })
    expect(guard('/_app', '/dpo/purposes', { runtime: promoted, storage })).toBeUndefined()
    expect(storage.map.size).toBe(0)
  })

  it('NTW-05 C0.9 PD-46: signed out, /notice goes to sign-in and forgets an older return path, as any path that isn’t an app path does', () => {
    const storage = memoryStorage()
    storage.map.set('hearth:return-to', '/rooms')
    expect(guard('/notice', '/notice', { runtime: null, storage })).toEqual({ to: '/sign-in', replace: true })
    expect(storage.map.has('hearth:return-to')).toBe(false)
  })

  it('NTW-05 C0.9 PD-46: noticeMove, NoticeWatcher’s decision on a change of standing: leaving /notice once acknowledged for the kept path, else Chats; to /notice from a path the standing doesn’t allow, keeping it; nothing else moves', () => {
    const runtime = runtimeWith('required')
    expect(noticeMove(runtime, '/notice')).toBeUndefined()
    expect(noticeMove(runtime, '/settings/privacy')).toBe('/notice')
    runtime.notice.acknowledged('elsewhere')
    expect(noticeMove(runtime, '/notice')).toBe('/settings/privacy')
    // Read once: the next leave goes to Chats.
    expect(noticeMove(runtime, '/notice')).toBe('/chats')
    expect(noticeMove(runtime, '/tasks')).toBeUndefined()

    // A hint while on a page: the DPO who just published from /dpo/notice is taken to /notice.
    const dpo = runtimeWith('unpublished', { registers: true })
    expect(noticeMove(dpo, '/dpo/notice')).toBeUndefined()
    dpo.notice.required()
    expect(noticeMove(dpo, '/dpo/notice')).toBe('/notice')
    dpo.notice.acknowledged('here')
    expect(noticeMove(dpo, '/notice')).toBe('/dpo/notice')
    // /sign-in is never a signed-in document's to keep.
    expect(noticeMove(runtimeWith('required'), '/sign-in')).toBeUndefined()
  })
})
