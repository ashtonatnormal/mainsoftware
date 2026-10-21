// The shell and its screens, rendered whole with react-dom/server in Node (T21, D-03): the app's root
// over a router loaded at a path, as the boot renders it, with a stand-in session runtime. What the
// markup holds (landmarks, the one h1, names, current entries, classes) is checked here; how it lays
// out and behaves in a browser at each width is the e2e suite's (shell.spec.ts, a11y.spec.ts).
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { App } from '@/app/App.tsx'
import { createLiveStore } from '@/live/live-status.ts'
import { createAppRouter } from '@/router/router.tsx'
import { BootErrorScreen } from '@/screens/BootErrorScreen.tsx'
import { ErrorScreen } from '@/screens/ErrorScreen.tsx'
import { createQueryClient } from '@/session/query-client.ts'
import type { SessionRuntime } from '@/session/runtime.ts'
import { aiCopyIn } from '@/strings/ai-copy.ts'
import { documentTitle, SHELL } from '@/strings/shell.ts'
import { InShell } from './in-shell.ts'

// Marcus, from the Tembusu seed (db/seed/tembusu.sql).
const MARCUS = { personId: 'b0000000-0000-4000-8000-000000000003', name: 'Marcus Lim', timeZone: 'Asia/Singapore' }

function runtime(): SessionRuntime {
  const queryClient = createQueryClient(() => {})
  queryClient.setQueryData(['session'], MARCUS)
  return {
    info: MARCUS,
    queryClient,
    live: createLiveStore('live'),
    signOut: async () => 'ended',
    end: () => {},
  } as unknown as SessionRuntime
}

// The app at a path, as a signed-in (or signed-out) document's first render.
async function appAt(path: string, signedIn = true): Promise<string> {
  const session = signedIn ? runtime() : null
  const router = createAppRouter(
    { runtime: session, storage: undefined },
    createMemoryHistory({ initialEntries: [path] }),
  )
  await router.load()
  // The router's server render adds its scroll script, which a browser never renders (D-02).
  return renderToStaticMarkup(<App router={router} runtime={session} />).replace(/<script\b.*?<\/script>/gs, '')
}

// The attributes of every element with this tag, in order.
function tags(markup: string, tag: string): Map<string, string>[] {
  return [...markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map(
    match => new Map([...(match[1] ?? '').matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map(a => [a[1] ?? '', a[2] ?? ''])),
  )
}

const classesOf = (element: Map<string, string> | undefined) => (element?.get('class') ?? '').split(/\s+/)

// The text of every element with this tag.
const textsOf = (markup: string, tag: string) =>
  [...markup.matchAll(new RegExp(`<${tag}\\b[^>]*>(.*?)</${tag}>`, 'gs'))].map(match =>
    (match[1] ?? '').replace(/<[^>]+>/g, ''),
  )

// What a reader meets: the text, and every aria-label, title and alt.
function readable(markup: string): string[] {
  const text = markup
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  const names = [...markup.matchAll(/\b(?:aria-label|title|alt)="([^"]*)"/g)].map(match => match[1] ?? '')
  return [...text, ...names].map(value => value.replaceAll('&#x27;', "'").replaceAll('&amp;', '&'))
}

const navsNamedMain = (markup: string) => tags(markup, 'nav').filter(nav => nav.get('aria-label') === 'Main')

// The links inside the nav with this class, by label, with each one's aria-current, if any.
function navLinks(markup: string, navClass: string): [string, string | undefined][] {
  const start = markup.search(new RegExp(`<nav[^>]*class="[^"]*${navClass}`))
  const nav = markup.slice(start, markup.indexOf('</nav>', start))
  return [...nav.matchAll(/<a\b([^>]*)>(.*?)<\/a>/gs)].map(match => [
    (match[2] ?? '').replace(/<[^>]+>/g, ''),
    (match[1] ?? '').match(/aria-current="([^"]*)"/)?.[1],
  ])
}

describe('T21 D-08: the shell (shell/Shell.tsx) and its screens', () => {
  it('SHM-01 D-08 X16 SHL-42: the shell has one h1 naming the screen, the skip link first, main#main, the one scroller #screen, and one "Main" navigation per layout', async () => {
    const markup = await appAt('/chats')
    expect(textsOf(markup, 'h1')).toEqual(['Chats'])
    const h1 = tags(markup, 'h1')[0]
    expect(h1?.get('tabindex')).toBe('-1')
    expect(h1?.has('data-screen-title')).toBe(true)
    // The skip link is the first link or button, to #main.
    expect(markup.match(/<(?:a|button)\b[^>]*>/)?.[0]).toMatch(/href="#main"/)
    const main = tags(markup, 'main')
    expect(main).toHaveLength(1)
    expect(main[0]?.get('id')).toBe('main')
    expect(main[0]?.get('tabindex')).toBe('-1')
    const screen = tags(markup, 'div').filter(div => div.get('id') === 'screen')
    expect(screen).toHaveLength(1)
    expect(screen[0]?.get('data-scroll-restoration-id')).toBe('screen')
    expect(classesOf(screen[0])).toEqual(expect.arrayContaining(['overflow-y-auto', 'min-h-0', 'flex-1']))
    // Two "Main" navigations, each hidden in the other layout: the tab bar below the rail
    // breakpoint, the rail's from it.
    const navs = navsNamedMain(markup)
    expect(navs).toHaveLength(2)
    const header = tags(markup, 'header')
    expect(header).toHaveLength(1)
    expect(classesOf(header[0])).toEqual(expect.arrayContaining(['hidden', 'rail:flex']))
    expect(navs.filter(nav => classesOf(nav).includes('rail:hidden'))).toHaveLength(1)
    // The toasts' region exists from the start, after #screen.
    expect(markup.indexOf('aria-label="Notifications"')).toBeGreaterThan(markup.indexOf('id="screen"'))
  })

  it('SHM-02 OD-02 T21 item 5 WCAG 1.4.1: the tab bar holds Today, Chats, Rooms, Tasks, More and the rail six entries, each current one marked by aria-current, the pill and the heavier label', async () => {
    const chats = await appAt('/chats')
    expect(navLinks(chats, 'rail:hidden')).toEqual([
      ['Today', undefined],
      ['Chats', 'page'],
      ['Rooms', undefined],
      ['Tasks', undefined],
      ['More', undefined],
    ])
    expect(navLinks(chats, 'overflow-y-auto')).toEqual([
      ['Today', undefined],
      ['Chats', 'page'],
      ['Rooms', undefined],
      ['Tasks', undefined],
      ['Calendar', undefined],
      ['Drive', undefined],
    ])
    const current = tags(chats, 'a').filter(link => link.get('aria-current') === 'page')
    expect(current).toHaveLength(2)
    for (const link of current) {
      expect(classesOf(link)).toEqual(expect.arrayContaining(['font-semibold', 'text-fg']))
      expect(classesOf(link)).toContain('focus-visible:-outline-offset-2')
    }
    expect(chats).toMatch(/<span aria-hidden="true" class="[^"]*bg-fg text-surface/)

    // Calendar on a phone marks More as the section that holds it ("true", never "page": More's
    // link goes to /more), with the same pill and label; on the rail, Calendar itself is the page.
    const calendar = await appAt('/calendar')
    expect(navLinks(calendar, 'rail:hidden').filter(([, on]) => on)).toEqual([['More', 'true']])
    expect(navLinks(calendar, 'overflow-y-auto').filter(([, on]) => on)).toEqual([['Calendar', 'page']])
    const more = tags(calendar, 'a').filter(link => link.get('aria-current') === 'true')
    expect(more.map(link => link.get('href'))).toEqual(['/more'])
    expect(classesOf(more[0])).toEqual(expect.arrayContaining(['font-semibold', 'text-fg']))
    // /more itself is More's own page.
    expect(navLinks(await appAt('/more'), 'rail:hidden').filter(([, on]) => on)).toEqual([['More', 'page']])
  })

  it('SHM-03 OD-05 X10 SHL-41: the avatar button is named "Account, {name}" and opens a menu labelled Account holding Sign out, with the name above it hidden from assistive technology; one per layout', async () => {
    const markup = await appAt('/today')
    const triggers = tags(markup, 'button').filter(button => button.get('aria-haspopup') === 'menu')
    expect(triggers.map(button => button.get('aria-label'))).toEqual(['Account, Marcus Lim', 'Account, Marcus Lim'])
    expect(triggers.every(button => button.get('aria-expanded') === 'false')).toBe(true)
    const menus = tags(markup, 'div').filter(div => div.get('role') === 'menu')
    expect(menus.map(menu => menu.get('aria-label'))).toEqual(['Account', 'Account'])
    expect(menus.map(menu => menu.get('id'))).toEqual(triggers.map(button => button.get('aria-controls')))
    expect(textsOf(markup, 'button').filter(text => text === 'Sign out')).toHaveLength(2)
    expect(markup).toMatch(/<p aria-hidden="true"[^>]*>Marcus Lim<\/p><div[^>]*role="menu"/)
    // The phone's sits in the header row and opens downward; the rail's in the rail's foot, upward.
    expect(markup).toMatch(/class="rail:hidden"><div class="relative">/)
    expect(markup).toMatch(/bottom-full left-0/)
  })

  it('SHM-04 OD-04 decision 8: no searchbox anywhere in the shell, and no AI copy on any screen', async () => {
    for (const path of ['/today', '/chats', '/rooms', '/tasks', '/calendar', '/drive', '/more', '/xyz']) {
      const markup = await appAt(path)
      expect(markup, path).not.toMatch(/type="search"|role="search"/)
      expect(
        readable(markup).filter(text => aiCopyIn(text) !== undefined),
        path,
      ).toEqual([])
    }
  })

  it('SHM-05 OD-02 X16: each tab is its h1 and an honest empty state (an h2 that claims nothing more)', async () => {
    const screens = [
      ['/today', 'Today', SHELL.empty.today],
      ['/chats', 'Chats', SHELL.empty.chats],
      ['/rooms', 'Rooms', SHELL.empty.rooms],
      ['/tasks', 'Tasks', SHELL.empty.tasks],
      ['/calendar', 'Calendar', SHELL.empty.calendar],
      ['/drive', 'Drive', SHELL.empty.drive],
    ] as const
    for (const [path, title, empty] of screens) {
      const markup = await appAt(path)
      expect(textsOf(markup, 'h1'), path).toEqual([title])
      expect(textsOf(markup, 'h2'), path).toEqual([empty])
    }
  })

  it('SHM-06 PRD §6.1: More lists Calendar and Drive as 56 px links to their screens', async () => {
    const markup = await appAt('/more')
    expect(textsOf(markup, 'h1')).toEqual(['More'])
    const screen = markup.slice(markup.indexOf('id="screen"'))
    const links = [...screen.matchAll(/<a\b([^>]*)>(.*?)<\/a>/gs)].map(match => ({
      href: match[1]?.match(/href="([^"]*)"/)?.[1],
      text: (match[2] ?? '').replace(/<[^>]+>/g, ''),
      classes: match[1]?.match(/class="([^"]*)"/)?.[1]?.split(/\s+/) ?? [],
    }))
    expect(links.slice(0, 2).map(link => [link.href, link.text])).toEqual([
      ['/calendar', 'Calendar'],
      ['/drive', 'Drive'],
    ])
    for (const link of links.slice(0, 2)) expect(link.classes).toContain('min-h-14')
  })

  it('SHM-07 T21 item 5: an unknown path is Page not found inside the shell, with one h1, the navigations and a 44 px way to Chats', async () => {
    for (const path of ['/xyz', '/chats/abc']) {
      const markup = await appAt(path)
      expect(textsOf(markup, 'h1'), path).toEqual([SHELL.notFound.title])
      expect(navsNamedMain(markup), path).toHaveLength(2)
      expect(tags(markup, 'main'), path).toHaveLength(1)
      expect(markup, path).toContain(SHELL.notFound.body.replace("'", '&#x27;'))
      const toChats = [...markup.matchAll(/<a\b([^>]*)>Go to Chats<\/a>/g)].map(match => match[1] ?? '')
      expect(toChats, path).toHaveLength(1)
      expect(toChats[0], path).toMatch(/href="\/chats"/)
      expect(toChats[0], path).toMatch(/min-h-11/)
      // No tab claims a page that isn't its own.
      expect(
        tags(markup, 'a').filter(link => link.has('aria-current')),
        path,
      ).toEqual([])
    }
  })

  it('SHM-08 T21 item 5: the boot error screen stands alone: its own main and h1, the reason, and a 44 px Try again', () => {
    const markup = renderToStaticMarkup(<BootErrorScreen reload={() => {}} />)
    expect(tags(markup, 'main')).toHaveLength(1)
    expect(textsOf(markup, 'h1')).toEqual(['Can&#x27;t reach Hearth'])
    expect(textsOf(markup, 'p')).toEqual(['Check your connection, then try again.'])
    const button = tags(markup, 'button')
    expect(button).toHaveLength(1)
    expect(classesOf(button[0])).toEqual(expect.arrayContaining(['min-h-11', 'min-w-11']))
    expect(textsOf(markup, 'button')).toEqual(['Try again'])
    const crashed = renderToStaticMarkup(<BootErrorScreen kind="crashed" reload={() => {}} />)
    expect(textsOf(crashed, 'h1')).toEqual(['Something went wrong'])
    expect(textsOf(crashed, 'button')).toEqual(['Reload'])
  })

  it('SHM-10 T21 item 5 X16: a screen that failed keeps the shell’s h1 and says so in an h2 with Try again and Go to Chats; above the shell it brings its own main and h1', () => {
    const router = createRouter({
      routeTree: createRootRoute(),
      history: createMemoryHistory({ initialEntries: ['/chats'] }),
    })
    const failed = (inShell: boolean) =>
      renderToStaticMarkup(
        <RouterContextProvider router={router}>
          <InShell value={inShell}>
            <ErrorScreen error={new Error('chunk')} reset={() => {}} info={{ componentStack: '' }} />
          </InShell>
        </RouterContextProvider>,
      )
    const inside = failed(true)
    expect(textsOf(inside, 'h2')).toEqual([SHELL.error.title])
    expect(tags(inside, 'h1')).toEqual([])
    expect(tags(inside, 'main')).toEqual([])
    expect(textsOf(inside, 'button')).toEqual(['Try again'])
    expect(inside).toMatch(/<a\b[^>]*href="\/chats"[^>]*>Go to Chats<\/a>/)
    const above = failed(false)
    expect(textsOf(above, 'h1')).toEqual([SHELL.error.title])
    expect(tags(above, 'main')).toHaveLength(1)
    expect(textsOf(above, 'button')).toEqual(['Try again'])
  })

  it('SHM-11 X6 WCAG 2.4.2: the document title names the screen and Hearth once', () => {
    expect(documentTitle('Chats')).toBe('Chats – Hearth')
    expect(documentTitle(SHELL.bootError.title)).toBe("Can't reach Hearth")
  })

  it('SHM-09 D-01: signed out, the sign-in screen stands outside the shell: its own main and h1, no navigation, no avatar', async () => {
    const markup = await appAt('/sign-in', false)
    expect(textsOf(markup, 'h1')).toEqual(['Sign in to Hearth'])
    expect(tags(markup, 'main')).toHaveLength(1)
    expect(tags(markup, 'nav')).toEqual([])
    expect(markup).not.toMatch(/aria-haspopup="menu"/)
  })
})
