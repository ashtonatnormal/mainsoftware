import { createMemoryHistory } from '@tanstack/react-router'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeClock, socketClass } from '@/live/testing/fakes.ts'
import type { ChannelLike, TabStorage } from '@/session/document.ts'
import type { RuntimeEnv } from '@/session/runtime.ts'
import { BOOT } from '@/strings/boot.ts'
import type { AppProps } from './App.tsx'

// boot.tsx, the api client's halt latch and the document's identity channel are module state that
// lives as long as a document, so each test loads fresh copies, as a new document would.
// The App and BootErrorScreen a test compares with come from the same fresh copies boot.tsx loaded.
let app: typeof import('./boot.tsx')
let App: typeof import('./App.tsx')['App']
let BootErrorScreen: typeof import('@/screens/BootErrorScreen.tsx')['BootErrorScreen']
beforeEach(async () => {
  vi.resetModules()
  app = await import('./boot.tsx')
  ;({ App } = await import('./App.tsx'))
  ;({ BootErrorScreen } = await import('@/screens/BootErrorScreen.tsx'))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

// Marcus, from the Tembusu seed (db/seed/tembusu.sql).
const MARCUS = {
  personId: 'b0000000-0000-4000-8000-000000000003',
  name: 'Marcus',
  timeZone: 'Asia/Singapore',
  capabilities: { registers: false },
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const signedIn = () => json(200, MARCUS)
const signedOut = () => json(401, { error: 'signed_out', message: "You've been signed out." })

// The browser's fetch: GET /api/session answers with whatever `session` holds at the time.
function stubSession(first: () => Response | Promise<Response>) {
  const state = { session: first, calls: 0 }
  vi.stubGlobal('fetch', async (url: RequestInfo | URL) => {
    if (String(url) !== '/api/session') throw new TypeError('Failed to fetch')
    state.calls += 1
    return state.session()
  })
  return state
}

// BroadcastChannel as the spec has it: to every other open object of the name, in a later task.
function channelClass() {
  const open = new Set<FakeChannel>()
  class FakeChannel implements ChannelLike {
    onmessage: ((event: MessageEvent) => void) | null = null
    readonly name: string
    constructor(name: string) {
      this.name = name
      open.add(this)
    }
    postMessage(data: unknown) {
      const targets = [...open].filter(other => other !== this && other.name === this.name)
      setTimeout(() => {
        for (const target of targets) target.onmessage?.(new MessageEvent('message', { data }))
      }, 0)
    }
    close() {
      open.delete(this)
    }
  }
  return FakeChannel
}

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

// A document whose last one left with session_ended, and another tab of the same browser.
function fakeDocument() {
  const storage = memoryStorage()
  storage.map.set('hearth:left', 'session_ended')
  const left: string[] = []
  const FakeChannel = channelClass()
  const env: RuntimeEnv = {
    location: {
      replace: (url: string | URL) => left.push(`replace ${String(url)}`),
      reload: () => left.push('reload'),
    },
    storage,
    addEventListener: () => {},
    BroadcastChannel: FakeChannel,
    random: () => 0,
    // A live connection whose timers run only if a test moves the clock: here it never opens.
    live: {
      url: 'wss://hearth.test/ws',
      WebSocket: socketClass().WebSocket,
      clock: new FakeClock(),
      onVisible: () => () => {},
    },
  }
  const root = { textContent: 'Loading Hearth…' }
  // What the boot rendered into #root, in order.
  const rendered: ReactElement[] = []
  const render = (element: ReactElement) => {
    rendered.push(element)
  }
  // A new document's first location: a deep link to Drive.
  const history = createMemoryHistory({ initialEntries: ['/drive'] })
  // Another tab says its person changed: it signed in or out, or its session ended.
  const otherTab = () => {
    const channel = new FakeChannel('hearth:identity')
    channel.postMessage({ t: 'identity' })
    channel.close()
  }
  return { env, root, render, history, rendered, storage, left, otherTab }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

describe('T21 D-01: the boot (app/boot.tsx)', () => {
  it("BT-02 D-01 CHT-60 X12: signed in, it drops the last document's leave reason, starts the person's runtime and renders the app once with the deep link's route loaded; another tab's identity message ends it with other_tab", async () => {
    const fetch = stubSession(signedIn)
    const { env, root, render, history, rendered, storage, left, otherTab } = fakeDocument()
    await app.boot({ env, root, render, history })
    // The reason was for a sign-in screen; this document isn't one.
    expect(storage.map.has('hearth:left')).toBe(false)
    expect(root.textContent).toBe('Loading Hearth…')
    expect(left).toEqual([])
    // The app rendered once, with Marcus's runtime, its router already on Drive inside the shell,
    // so the first paint is the screen.
    const [shown, ...more] = rendered
    expect(more).toEqual([])
    expect(shown?.type).toBe(App)
    const props = shown?.props as AppProps
    expect(props.runtime?.info).toEqual(MARCUS)
    expect(props.router.state.matches.map(match => match.routeId)).toEqual(['__root__', '/_app', '/_app/drive'])
    expect(storage.map.has('hearth:return-to')).toBe(false)

    otherTab()
    await tick()
    // The runtime ended without asking the server again, and the next document opens as whoever
    // the cookie now names.
    expect(left).toEqual(['reload'])
    expect(storage.map.get('hearth:left')).toBe('other_tab')
    expect(fetch.calls).toBe(1)
  })

  it("BT-03 D-01 T21 items 5 and 13: signed out, it renders the app with no runtime, keeping the deep link as the return path and the leave reason for the sign-in screen; another tab's sign-out or ended session doesn't reload, its sign-in does, once", async () => {
    const fetch = stubSession(signedOut)
    const { env, root, render, history, rendered, storage, left, otherTab } = fakeDocument()
    await app.boot({ env, root, render, history })
    expect(storage.map.get('hearth:left')).toBe('session_ended')
    expect(fetch.calls).toBe(1)
    // The app rendered with no runtime; the shell's guard sent the deep link to sign-in and kept
    // Drive as the path to open afterwards (T21 item 5).
    expect(rendered.map(element => element.type)).toEqual([App])
    const props = rendered[0]?.props as AppProps
    expect(props.runtime).toBeNull()
    expect(storage.map.get('hearth:return-to')).toBe('/drive')

    // A stale tab learns its session ended, or signs out: the cookie still names no one here, so a
    // sign-in step in progress keeps its place.
    otherTab()
    await tick()
    expect(fetch.calls).toBe(2)
    expect(left).toEqual([])

    // The api can't answer: no guess, no reload.
    fetch.session = () => json(503, { error: 'unavailable', message: 'Later.' })
    otherTab()
    await tick()
    expect(left).toEqual([])

    // Another tab signs in: this document reloads, once, into the signed-in app.
    fetch.session = signedIn
    otherTab()
    await tick()
    expect(left).toEqual(['reload'])
    otherTab()
    await tick()
    expect(left).toEqual(['reload'])
    expect(fetch.calls).toBe(4)
    expect(storage.map.get('hearth:left')).toBe('session_ended')
  })

  it('BT-03 D-01: a message during a check makes one more check after it, so a sign-in that lands meanwhile is followed', async () => {
    const fetch = stubSession(signedOut)
    const { env, root, render, history, left, otherTab } = fakeDocument()
    await app.boot({ env, root, render, history })

    let answer: (response: Response) => void = () => {}
    fetch.session = () =>
      new Promise<Response>(resolve => {
        answer = resolve
      })
    otherTab()
    await tick()
    // Two more messages while the check waits: one check follows it, not two.
    otherTab()
    otherTab()
    await tick()
    expect(fetch.calls).toBe(2)
    fetch.session = signedIn
    answer(signedOut())
    await tick()
    expect(fetch.calls).toBe(3)
    expect(left).toEqual(['reload'])
  })

  it("BT-04 T21 items 5 and 10: an api that can't answer renders the boot error screen alone and starts nothing; a boot that throws leaves the plain text in #root", async () => {
    stubSession(() => json(503, { error: 'unavailable', message: 'Later.' }))
    const down = fakeDocument()
    await app.boot({ env: down.env, root: down.root, render: down.render, history: down.history })
    expect(down.rendered.map(element => element.type)).toEqual([BootErrorScreen])
    expect(down.root.textContent).toBe('Loading Hearth…')
    down.otherTab()
    await tick()
    expect(down.left).toEqual([])
    expect(down.storage.map.get('hearth:left')).toBe('session_ended')

    stubSession(signedIn)
    const broken = fakeDocument()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const env: RuntimeEnv = {
      ...broken.env,
      get storage(): TabStorage {
        throw new Error('storage gone')
      },
    }
    await app.boot({ env, root: broken.root, render: broken.render, history: broken.history })
    expect(broken.root.textContent).toBe(BOOT.cantReach)
    expect(broken.rendered).toEqual([])
    expect(logged).toHaveBeenCalledTimes(1)
    broken.otherTab()
    await tick()
    expect(broken.left).toEqual([])
  })
})
