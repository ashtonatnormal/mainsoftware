// The route tree, loaded in Node with a memory history (T21; OD-24). Node runs the router's server
// load, which doesn't follow a redirect, so a guard's redirect is read from the guard itself and its
// effect (the return path) from storage; what each path matches is read from the loaded router.
import { createMemoryHistory, isRedirect } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import type { TabStorage } from '@/session/document.ts'
import type { SessionRuntime } from '@/session/runtime.ts'
import { NAV } from '@/shell/nav.ts'
import { APP_PATHS } from './paths.ts'
import { createAppRouter, ROUTER_OPTIONS, type RouterContext } from './router.tsx'

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

// The router only checks that a runtime is there; nothing in a route's guard or component reads it
// while loading.
const RUNTIME = {} as SessionRuntime

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

describe('T21 OD-24: the route tree (router/router.tsx)', () => {
  it('RO-01 X12 OD-02 OD-03: every NAV path is a route with its title; / goes to /chats; APP_PATHS (import-free, so main.ts may reach it) equals the paths registered in the shell, splat excluded', async () => {
    for (const entry of Object.values(NAV)) {
      const router = routerAt(entry.to, signedIn())
      await router.load()
      const leaf = router.state.matches.at(-1)
      expect(leaf?.routeId, entry.to).toBe(`/_app${entry.to}`)
      expect(leaf?.staticData.title, entry.to).toBe(entry.label)
      expect(leaf?.staticData.nav, entry.to).toBe(entry.id)
    }
    expect(guard('/_app/', '/', signedIn())).toEqual({ to: '/chats', replace: true })
    expect([...shellPaths()].sort()).toEqual([...APP_PATHS].sort())
    expect(shellPaths()).toHaveLength(Object.keys(NAV).length)
  })

  it('RO-02 C-13 D-02: getScrollRestorationKey is the pathname only; #screen is the scroll container', () => {
    const router = routerAt('/chats', signedIn())
    const location = router.buildLocation({ to: '/chats', hash: 'x' })
    expect(ROUTER_OPTIONS.getScrollRestorationKey({ ...location, searchStr: '?q=1', href: '/chats?q=1#x' })).toBe(
      '/chats',
    )
    expect(ROUTER_OPTIONS.scrollRestoration).toBe(true)
    expect(ROUTER_OPTIONS.scrollToTopSelectors).toEqual(['#screen'])
    expect(router.options.getScrollRestorationKey).toBe(ROUTER_OPTIONS.getScrollRestorationKey)
  })

  it('RO-03 OD-46: /admin, /settings and /notice are not routes and not in APP_PATHS: signed in they are Page not found', async () => {
    for (const path of ['/admin', '/admin/roles', '/settings', '/notice']) {
      expect(APP_PATHS as readonly string[], path).not.toContain(path)
      const router = routerAt(path, signedIn())
      await router.load()
      expect(router.state.matches.at(-1)?.routeId, path).toBe('/_app/$')
    }
  })

  it('R-44 RO-04: no route declares validateSearch or a search middleware, so no URL carries state', () => {
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

  it("RO-05 OD-42 R-37: /xyz, /chats/abc and /sign-in/foo match the splat under _app, so _app's guard runs: signed out they go to /sign-in and keep no return path; signed in the match is __root__ > _app > $ titled Page not found", async () => {
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

  it('R-44 OD-03: signed out, an app path is kept as the return path and the guard sends the visit to sign-in; signed in, /sign-in goes to /chats; signed out, /sign-in is the sign-in screen', async () => {
    const storage = memoryStorage()
    expect(guard('/_app', '/tasks', { runtime: null, storage })).toEqual({ to: '/sign-in', replace: true })
    expect(storage.map.get('hearth:return-to')).toBe('/tasks')
    expect(guard('/sign-in', '/sign-in', signedIn())).toEqual({ to: '/chats', replace: true })
    expect(guard('/sign-in', '/sign-in', { runtime: null, storage: memoryStorage() })).toBeUndefined()
    const router = routerAt('/sign-in', { runtime: null, storage: memoryStorage() })
    await router.load()
    expect(router.state.matches.map(match => match.routeId)).toEqual(['__root__', '/sign-in'])
    expect(router.state.matches.at(-1)?.staticData.title).toBe('Sign in')
  })
})
