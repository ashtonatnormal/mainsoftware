// The app's routes (T21 items 1 and 5, OD-02, OD-03, X12, D-02). Code-based, so
// the tree is plain TypeScript that tests load in Node, with no generated file.
//
// __root__            RouteFocus, then the matched route; PlainNotFound and ErrorScreen as defaults
// ├── /sign-in        outside the shell; a signed-in document goes to /chats instead
// └── _app (pathless) the shell; a signed-out document goes to /sign-in, keeping the path asked for
//     ├── /           → /chats (OD-03: the app lands on Chats)
//     ├── /today /chats /rooms /tasks /calendar /drive   each tab's screen
//     ├── /more       the phone's More page
//     └── $           every other path: "Page not found" inside the shell
//
// The splat route sits under _app, so an unknown path (/xyz, /chats/abc, /sign-in/foo) runs _app's
// beforeLoad first: signed out, it goes to sign-in like any other path, and an unknown path is never
// kept as the return path (APP_PATHS lacks it); signed in, the shell shows the not-found screen with
// its one h1. PlainNotFound is only the backstop for a notFound() thrown outside _app (none is in
// C0.8). ErrorScreen and PlainNotFound are imported statically, so they render even when a chunk
// failed to load; every screen is a lazy chunk of its own.
//
// Rules the router tests hold (router/router.test.ts):
// - APP_PATHS (router/paths.ts, import-free) lists exactly the paths registered under _app;
// - no route declares a search param, so no URL carries state (T21 item 5), and the scroll cache is
//   keyed by pathname alone (D-02);
// - reserved for later steps and deliberately not routes yet (T21 item 5): /admin/* (C0.16),
//   /settings/* (the settings registry, C0.9 onwards) and /notice (C0.9).
//
// No route has a loader in C0.8. From C1 a loader fills Query's cache through the runtime in its
// context (context.runtime.queryClient.ensureQueryData(...)) and returns nothing: Query is the cache.
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  type ParsedLocation,
  type RouterHistory,
  redirect,
} from '@tanstack/react-router'
import { ErrorScreen } from '@/screens/ErrorScreen.tsx'
import { PlainNotFound } from '@/screens/PlainNotFound.tsx'
import { rememberReturnTo, type TabStorage } from '@/session/document.ts'
import type { SessionRuntime } from '@/session/runtime.ts'
import type { NavId } from '@/shell/nav.ts'
import { SHELL } from '@/strings/shell.ts'
import { SIGN_IN } from '@/strings/sign-in.ts'
import { RouteFocus } from './RouteFocus.tsx'

export interface RouterContext {
  // The signed-in document's session runtime; null when the document is signed out.
  readonly runtime: SessionRuntime | null
  // This tab's session storage, where a signed-out visit keeps the app path it asked for.
  readonly storage: TabStorage | undefined
}

function Root() {
  return (
    <>
      <RouteFocus />
      <Outlet />
    </>
  )
}

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Root })

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
  staticData: { title: SIGN_IN.title },
  beforeLoad: ({ context }) => {
    if (context.runtime !== null) throw redirect({ to: '/chats', replace: true })
  },
  component: lazyRouteComponent(() => import('@/sign-in/SignInScreen.tsx'), 'SignInScreen'),
})

const notFoundScreen = lazyRouteComponent(() => import('@/screens/NotFoundScreen.tsx'), 'NotFoundScreen')

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_app',
  beforeLoad: ({ context, location }) => {
    if (context.runtime !== null) return
    rememberReturnTo(location.pathname, context.storage)
    throw redirect({ to: '/sign-in', replace: true })
  },
  component: lazyRouteComponent(() => import('@/shell/Shell.tsx'), 'Shell'),
  // A notFound() a C1 loader throws inside the shell.
  notFoundComponent: notFoundScreen,
})

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/chats', replace: true })
  },
})

// The tab screens' module, as a type only: it loads lazily, when a tab's route first needs it.
type TabScreens = typeof import('@/screens/TabScreen.tsx')

const tabScreen = (name: Exclude<Extract<keyof TabScreens, `${string}Screen`>, 'TabScreen'>) =>
  lazyRouteComponent(() => import('@/screens/TabScreen.tsx'), name)

// One route per place in the navigation, each with its title (the shell's h1 and the document's
// title) and the nav entry it belongs to.
const placeRoute = <const N extends Exclude<NavId, 'more'>>(nav: N, component: ReturnType<typeof tabScreen>) =>
  createRoute({
    getParentRoute: () => appRoute,
    path: `/${nav}` as `/${N}`,
    staticData: { title: SHELL.nav[nav], nav },
    component,
  })

const todayRoute = placeRoute('today', tabScreen('TodayScreen'))
const chatsRoute = placeRoute('chats', tabScreen('ChatsScreen'))
const roomsRoute = placeRoute('rooms', tabScreen('RoomsScreen'))
const tasksRoute = placeRoute('tasks', tabScreen('TasksScreen'))
const calendarRoute = placeRoute('calendar', tabScreen('CalendarScreen'))
const driveRoute = placeRoute('drive', tabScreen('DriveScreen'))

const moreRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/more',
  staticData: { title: SHELL.nav.more, nav: 'more' },
  component: lazyRouteComponent(() => import('@/screens/MoreScreen.tsx'), 'MoreScreen'),
})

const notFoundRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '$',
  staticData: { title: SHELL.notFound.title },
  component: notFoundScreen,
})

export const routeTree = rootRoute.addChildren([
  signInRoute,
  appRoute.addChildren([
    indexRoute,
    todayRoute,
    chatsRoute,
    roomsRoute,
    tasksRoute,
    calendarRoute,
    driveRoute,
    moreRoute,
    notFoundRoute,
  ]),
])

// The router's options, apart from the tree and context (exported for router.test.ts).
export const ROUTER_OPTIONS = {
  // Scroll positions are restored within a document, by the router, in #screen (the one scroller).
  scrollRestoration: true,
  // Keyed by the pathname alone: never a query string, a hash or a whole href (D-02).
  getScrollRestorationKey: (location: ParsedLocation) => location.pathname,
  scrollToTopSelectors: ['#screen'],
  // A link's route loads on hover or focus; Query, not the router, caches data.
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  // Nothing pending shows for a load quicker than this.
  defaultPendingMs: 400,
} as const

export function createAppRouter(context: RouterContext, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context,
    ...ROUTER_OPTIONS,
    scrollToTopSelectors: [...ROUTER_OPTIONS.scrollToTopSelectors],
    defaultNotFoundComponent: PlainNotFound,
    defaultErrorComponent: ErrorScreen,
    ...(history === undefined ? {} : { history }),
  })
}

export type AppRouter = ReturnType<typeof createAppRouter>

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter
  }
  interface StaticDataRouteOption {
    // The screen's h1 and the document's title.
    title?: string
    // The navigation entry the route belongs to.
    nav?: NavId
    // Hides the tab bar (C1's conversation view).
    immersive?: boolean
  }
}
