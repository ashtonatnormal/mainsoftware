// The app's routes (T21 items 1 and 5, OD-02, OD-03, X12, D-02). Code-based, so
// the tree is plain TypeScript that tests load in Node, with no generated file.
//
// __root__            RouteFocus and NoticeWatcher, then the matched route; PlainNotFound and
// │                   ErrorScreen as defaults
// ├── /sign-in        outside the shell; a signed-in document goes to /chats instead
// ├── /notice         outside the shell: the privacy notice to read and acknowledge (C0.9 PD-46); a
// │                   signed-out document goes to /sign-in
// └── _app (pathless) the shell; a signed-out document goes to /sign-in, keeping the path asked for,
//     │               and a person who hasn't acknowledged the current notice goes to /notice
//     ├── /           → /chats (OD-03: the app lands on Chats)
//     ├── /today /chats /rooms /tasks /calendar /drive   each tab's screen
//     ├── /more       the phone's More page
//     ├── /settings /settings/privacy   Settings and its sections (C0.9 PD-47): no nav entry; the
//     │                                 avatar menu opens them
//     ├── /dpo/purposes /dpo/transfers /dpo/contact /dpo/notice   the DPO's registers, their
//     │                                  contact details (C0.9 PR 3a, PD-70) and notice (C0.9 PD-26,
//     │                                  PD-48): no nav entry; the avatar menu opens them, and the
//     │                                  server decides who may read them
//     └── $           every other path: "Page not found" inside the shell
//
// The notice (C0.9 PD-44, PD-46; TECH-SPEC T22 items 29 and 31): _app's guard lets a path through
// only when noticeAllowsPath() (router/paths.ts) does for the runtime's standing (session/notice.ts):
// everywhere once the current version is acknowledged; before any is published, the DPO's own
// pages to the DPO; otherwise nowhere, and the guard keeps the path (an app path only, in the
// store's memory) and sends the visit to /notice. NoticeWatcher does the same whenever the standing
// changes (a hint, an answer, another tab), and when it becomes acknowledged while the tab is on
// /notice it opens the kept path, else Chats. The server refuses every request itself (403
// notice_required); this only keeps a screen from opening that it would refuse.
//
// The splat route sits under _app, so an unknown path (/xyz, /chats/abc, /sign-in/foo) runs _app's
// beforeLoad first: signed out, it goes to sign-in like any other path, and an unknown path is never
// kept as the return path (APP_PATHS lacks it); signed in, the shell shows the not-found screen with
// its one h1. PlainNotFound is only the backstop for a notFound() thrown outside _app (none is in
// C0.8). ErrorScreen and PlainNotFound are imported statically, so they render even when a chunk
// failed to load; every screen is a lazy chunk of its own.
//
// Rules the router tests hold (router/router.test.ts):
// - APP_PATHS (router/paths.ts, importing no module but a type) lists exactly the paths
//   registered under _app, and NAV_PATHS those of them the navigation reaches;
// - no route declares a search param, so no URL carries state (T21 item 5), and the scroll cache is
//   keyed by pathname alone (D-02);
// - reserved for a later step and deliberately not a route yet (T21 item 5): /admin/* (C0.16).
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
  useRouter,
} from '@tanstack/react-router'
import { useEffect } from 'react'
import { sessionQuery } from '@/api/queries.ts'
import { ErrorScreen } from '@/screens/ErrorScreen.tsx'
import { PlainNotFound } from '@/screens/PlainNotFound.tsx'
import { rememberReturnTo, type TabStorage } from '@/session/document.ts'
import type { SessionRuntime } from '@/session/runtime.ts'
import type { NavId } from '@/shell/nav.ts'
import { SHELL } from '@/strings/shell.ts'
import { SIGN_IN } from '@/strings/sign-in.ts'
import { type AppPath, NOTICE_PATH, noticeAllowsPath } from './paths.ts'
import { RouteFocus } from './RouteFocus.tsx'

export interface RouterContext {
  // The signed-in document's session runtime; null when the document is signed out.
  readonly runtime: SessionRuntime | null
  // This tab's session storage, where a signed-out visit keeps the app path it asked for.
  readonly storage: TabStorage | undefined
}

// Whether the person holds the DPO's pages, as the latest session answer says (the capability
// can() decided, never a role; C0.9 PD-26).
function registersOf(runtime: Pick<SessionRuntime, 'info' | 'queryClient'>): boolean {
  const latest = runtime.queryClient.getQueryData(sessionQuery.queryKey) ?? runtime.info
  return latest.capabilities.registers === true
}

// Where the notice sends a signed-in tab on path when the standing changes, or undefined to leave
// it (NoticeWatcher; C0.9 PD-46): from /notice, once acknowledged, to the kept path (read once),
// else Chats; from a path the standing doesn't allow, to /notice, keeping the path. /sign-in is no
// signed-in document's (its guard sends it to Chats), so it is left alone.
export function noticeMove(
  runtime: Pick<SessionRuntime, 'info' | 'queryClient' | 'notice'>,
  path: string,
): AppPath | typeof NOTICE_PATH | undefined {
  const standing = runtime.notice.standing()
  if (path === NOTICE_PATH) return standing === 'acknowledged' ? (runtime.notice.takeReturn() ?? '/chats') : undefined
  if (path === '/sign-in' || noticeAllowsPath(standing, registersOf(runtime), path)) return undefined
  runtime.notice.rememberReturn(path)
  return NOTICE_PATH
}

// Moves the tab when the person's standing with the notice changes (see the header).
function NoticeWatcher(): null {
  const router = useRouter()
  const { runtime } = rootRoute.useRouteContext()
  useEffect(() => {
    if (runtime === null) return
    return runtime.notice.subscribe(() => {
      const to = noticeMove(runtime, router.state.location.pathname)
      if (to !== undefined) void router.navigate({ to, replace: true })
    })
  }, [router, runtime])
  return null
}

function Root() {
  return (
    <>
      <RouteFocus />
      <NoticeWatcher />
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

// The privacy notice (C0.9 PD-46): outside the shell, so nothing of the app is reachable from it but
// Sign out. Signed out, the visit goes to sign-in, and /notice, which is no app path, forgets an
// older return path, as any such path does; after sign-in the shell's guard brings the person back
// here if they still need to acknowledge.
const noticeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: NOTICE_PATH,
  staticData: { title: SHELL.notice },
  beforeLoad: ({ context, location }) => {
    if (context.runtime !== null) return
    rememberReturnTo(location.pathname, context.storage)
    throw redirect({ to: '/sign-in', replace: true })
  },
  component: lazyRouteComponent(() => import('@/notice/NoticeScreen.tsx'), 'NoticeScreen'),
})

const notFoundScreen = lazyRouteComponent(() => import('@/screens/NotFoundScreen.tsx'), 'NotFoundScreen')

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_app',
  beforeLoad: ({ context, location }) => {
    const { runtime } = context
    if (runtime === null) {
      rememberReturnTo(location.pathname, context.storage)
      throw redirect({ to: '/sign-in', replace: true })
    }
    if (noticeAllowsPath(runtime.notice.standing(), registersOf(runtime), location.pathname)) return
    runtime.notice.rememberReturn(location.pathname)
    throw redirect({ to: NOTICE_PATH, replace: true })
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

// Settings and its sections (C0.9 PD-47; settings/sections.ts): each its own lazy chunk, with its
// title and no nav entry. What they say (strings/notice.ts) loads only with their chunks.
const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings',
  staticData: { title: SHELL.settings.title },
  component: lazyRouteComponent(() => import('@/settings/SettingsScreen.tsx'), 'SettingsScreen'),
})

const privacyRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/privacy',
  staticData: { title: SHELL.settings.privacy },
  component: lazyRouteComponent(() => import('@/settings/PrivacySettings.tsx'), 'PrivacySettings'),
})

// The DPO's registers and notice (C0.9 PD-26, PD-48, OD-03): each its own lazy chunk, with its title
// and no nav entry. Their titles come from strings/shell.ts, which the boot loads anyway; the pages'
// own copy (strings/dpo*.ts) loads only with their chunks, so the boot's bundle doesn't grow by it
// (C0.9 PD-31).
const purposesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/dpo/purposes',
  staticData: { title: SHELL.dpo.purposes },
  component: lazyRouteComponent(() => import('@/dpo/PurposesScreen.tsx'), 'PurposesScreen'),
})

const transfersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/dpo/transfers',
  staticData: { title: SHELL.dpo.transfers },
  component: lazyRouteComponent(() => import('@/dpo/TransfersScreen.tsx'), 'TransfersScreen'),
})

// The DPO's business contact (PDPA-13, PDPA-02; C0.9 OD-10, PD-70), which the notice prints.
const dpoContactRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/dpo/contact',
  staticData: { title: SHELL.dpo.contact },
  component: lazyRouteComponent(() => import('@/dpo/ContactScreen.tsx'), 'ContactScreen'),
})

const dpoNoticeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/dpo/notice',
  staticData: { title: SHELL.dpo.notice },
  component: lazyRouteComponent(() => import('@/dpo/NoticeTab.tsx'), 'NoticeTab'),
})

const notFoundRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '$',
  staticData: { title: SHELL.notFound.title },
  component: notFoundScreen,
})

export const routeTree = rootRoute.addChildren([
  signInRoute,
  noticeRoute,
  appRoute.addChildren([
    indexRoute,
    todayRoute,
    chatsRoute,
    roomsRoute,
    tasksRoute,
    calendarRoute,
    driveRoute,
    moreRoute,
    settingsRoute,
    privacyRoute,
    purposesRoute,
    transfersRoute,
    dpoContactRoute,
    dpoNoticeRoute,
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
