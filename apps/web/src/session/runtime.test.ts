import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ChannelLike, TabStorage } from './document.ts'
import type { RuntimeEnv } from './runtime.ts'

// The runtime, the api client's halt latch and the document's identity channel are module state
// that lives as long as a document, so each test loads fresh copies, as a new document would.
let runtimeModule: typeof import('./runtime.ts')
let http: typeof import('@/api/http.ts')
beforeEach(async () => {
  vi.resetModules()
  runtimeModule = await import('./runtime.ts')
  http = await import('@/api/http.ts')
})
afterEach(() => {
  vi.unstubAllGlobals()
})

// Marcus and Priya, from the Tembusu seed (db/seed/tembusu.sql).
const MARCUS = { personId: 'b0000000-0000-4000-8000-000000000003', name: 'Marcus', timeZone: 'Asia/Singapore' }
const PRIYA = { personId: 'b0000000-0000-4000-8000-000000000002', name: 'Priya', timeZone: 'Asia/Singapore' }

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const signedOut = () => json(401, { error: 'signed_out', message: "You've been signed out." })

// The browser's fetch, answered per path by the test; every call is recorded.
function stubFetch(answers: Record<string, () => Response | Promise<Response>>) {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (url: RequestInfo | URL) => {
    calls.push(String(url))
    const answer = answers[String(url)]
    if (answer === undefined) throw new TypeError('Failed to fetch')
    return answer()
  })
  return calls
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

function fakeEnv(onLeave: (how: string) => void = () => {}) {
  const storage = memoryStorage()
  const left: string[] = []
  const FakeChannel = channelClass()
  const env: RuntimeEnv = {
    location: {
      replace: (url: string | URL) => {
        left.push(`replace ${String(url)}`)
        onLeave(`replace ${String(url)}`)
      },
      reload: () => {
        left.push('reload')
        onLeave('reload')
      },
    },
    storage,
    addEventListener: () => {},
    BroadcastChannel: FakeChannel,
    random: () => 0,
  }
  return { env, storage, left, FakeChannel }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

describe('T21 D-01: the session runtime (session/runtime.ts)', () => {
  it('R-42 CHT-60 OD-10: it seeds the session answer and the formatters for the person', () => {
    const { env } = fakeEnv()
    const runtime = runtimeModule.startSessionRuntime({ ...MARCUS, timeZone: 'Europe/London' }, env)
    expect(runtime.queryClient.getQueryData(['session'])).toEqual({ ...MARCUS, timeZone: 'Europe/London' })
    // 13:30 UTC on 11 Oct 2026 is 2:30 pm in London (BST).
    expect(runtime.formatters.time(Date.UTC(2026, 9, 11, 13, 30))).toBe('2:30 pm')
  })

  it('RT-01 R-42 CHT-60: end() halts requests, clears the QueryClient, then leaves the document, in that order', async () => {
    const calls = stubFetch({ '/api/session': () => json(200, MARCUS) })
    const steps: string[] = []
    const refused: string[] = []
    const { env, storage } = fakeEnv(how => {
      steps.push(how)
      // By the time the document leaves, nothing of the person is cached.
      steps.push(`cached ${runtime.queryClient.getQueryCache().getAll().length}`)
    })
    const runtime = runtimeModule.startSessionRuntime(MARCUS, env)
    runtime.queryClient.setQueryData(['topic', 'person:x'], { anything: true })
    runtime.queryClient.getQueryCache().subscribe(event => {
      if (event.type !== 'removed') return
      steps.push(`removed ${String(event.query.queryKey[0])}`)
      // A refetch while the cache clears sends nothing: requests are already halted.
      http.apiGet('/api/session', z.unknown()).catch((error: unknown) => {
        if (error instanceof http.ApiFailure) refused.push(error.code)
      })
    })

    runtime.end('session_ended')
    await tick()

    expect(steps).toEqual(['removed session', 'removed topic', 'replace /sign-in', 'cached 0'])
    expect(refused).toEqual(['halted', 'halted'])
    expect(calls).toEqual([])
    expect(storage.map.get('hearth:left')).toBe('session_ended')
  })

  it('RT-02: end() is idempotent: the first reason wins and the document leaves once', () => {
    const { env, left, storage } = fakeEnv()
    const runtime = runtimeModule.startSessionRuntime(MARCUS, env)
    runtime.end('person_changed')
    runtime.end('session_ended')
    runtime.end('other_tab')
    expect(left).toEqual(['replace /sign-in'])
    expect(storage.map.get('hearth:left')).toBe('person_changed')
  })

  it('RT-02: a step that throws does not stop the document leaving', () => {
    const { env, left } = fakeEnv()
    const runtime = runtimeModule.startSessionRuntime(MARCUS, env)
    vi.spyOn(runtime.queryClient, 'clear').mockImplementation(() => {
      throw new Error('clear failed')
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    runtime.end('session_ended')
    expect(left).toEqual(['replace /sign-in'])
    expect(logged).toHaveBeenCalledTimes(1)
  })

  it('RT-03 OD-05: signOut(): a 2xx and a 401 end the session with signed_out_here; one press sends one POST', async () => {
    for (const answer of [() => json(200, { status: 'signed_out' }), signedOut]) {
      vi.resetModules()
      runtimeModule = await import('./runtime.ts')
      const calls = stubFetch({ '/api/auth/sign-out': answer })
      const { env, left, storage } = fakeEnv()
      const runtime = runtimeModule.startSessionRuntime(MARCUS, env)
      const [first, second] = [runtime.signOut(), runtime.signOut()]
      expect(await first).toBe('ended')
      expect(await second).toBe('ended')
      expect(calls).toEqual(['/api/auth/sign-out'])
      expect(left).toEqual(['replace /sign-in'])
      expect(storage.map.get('hearth:left')).toBe('signed_out_here')
      // After the end, a sign-out sends nothing and answers ended.
      expect(await runtime.signOut()).toBe('ended')
      expect(calls).toHaveLength(1)
    }
  })

  it('RT-03 OD-05: a network or 5xx failure keeps the session and answers failed, and Sign out can be pressed again', async () => {
    let next: () => Response = () => {
      throw new TypeError('Failed to fetch')
    }
    const calls = stubFetch({ '/api/auth/sign-out': () => next() })
    const { env, left } = fakeEnv()
    const runtime = runtimeModule.startSessionRuntime(MARCUS, env)
    expect(await runtime.signOut()).toBe('failed')
    next = () => json(503, { error: 'unavailable', message: 'Later.' })
    expect(await runtime.signOut()).toBe('failed')
    expect(left).toEqual([])
    expect(runtime.queryClient.getQueryData(['session'])).toEqual(MARCUS)
    next = () => json(200, { status: 'signed_out' })
    expect(await runtime.signOut()).toBe('ended')
    expect(calls).toHaveLength(3)
    expect(left).toEqual(['replace /sign-in'])
  })

  it('RT-04 CHT-60: a session answer naming another person ends with person_changed; one naming the same person changes nothing', async () => {
    const { env, left, storage } = fakeEnv()
    const runtime = runtimeModule.startSessionRuntime(MARCUS, env)
    runtime.queryClient.setQueryData(['session'], { ...MARCUS, name: 'Marcus O.' })
    await tick()
    expect(left).toEqual([])

    stubFetch({ '/api/session': () => json(200, PRIYA) })
    await runtime.queryClient.refetchQueries({ queryKey: ['session'] })
    await tick()
    expect(left).toEqual(['replace /sign-in'])
    expect(storage.map.get('hearth:left')).toBe('person_changed')
  })

  it('RT-04 R-54: a 401 signed_out from the session answer ends the session (session_ended)', async () => {
    stubFetch({ '/api/session': signedOut })
    const { env, left, storage } = fakeEnv()
    const runtime = runtimeModule.startSessionRuntime(MARCUS, env)
    await runtime.queryClient.refetchQueries({ queryKey: ['session'] })
    await tick()
    expect(left).toEqual(['replace /sign-in'])
    expect(storage.map.get('hearth:left')).toBe('session_ended')
  })

  it("RT-08 R-42: a 401 signed_out that arrives while signOut() waits ends with signed_out_here; after a failed sign-out it's session_ended again", async () => {
    let answerSignOut: (response: Response) => void = () => {}
    stubFetch({
      '/api/auth/sign-out': () =>
        new Promise<Response>(resolve => {
          answerSignOut = resolve
        }),
      '/api/flags': signedOut,
    })
    const { env, left, storage } = fakeEnv()
    const runtime = runtimeModule.startSessionRuntime(MARCUS, env)
    const signingOut = runtime.signOut()
    // The server revoked the session and published it: a query answers 401 first.
    await runtime.queryClient
      .fetchQuery({ queryKey: ['flags'], queryFn: () => http.apiGet('/api/flags', z.unknown()) })
      .catch(() => {})
    expect(left).toEqual(['replace /sign-in'])
    expect(storage.map.get('hearth:left')).toBe('signed_out_here')
    // The POST's own answer lands after the halt; the sign-out still reads as ended.
    answerSignOut(json(200, { status: 'signed_out' }))
    expect(await signingOut).toBe('ended')
    expect(left).toHaveLength(1)

    // A sign-out that failed leaves no trace: a later 401 is the server ending the session.
    vi.resetModules()
    runtimeModule = await import('./runtime.ts')
    http = await import('@/api/http.ts')
    stubFetch({ '/api/flags': signedOut })
    const second = fakeEnv()
    const again = runtimeModule.startSessionRuntime(MARCUS, second.env)
    expect(await again.signOut()).toBe('failed')
    await again.queryClient
      .fetchQuery({ queryKey: ['flags'], queryFn: () => http.apiGet('/api/flags', z.unknown()) })
      .catch(() => {})
    expect(second.storage.map.get('hearth:left')).toBe('session_ended')
  })

  it("K-10: another tab's identity message ends the session with other_tab, which reloads", async () => {
    const { env, left, storage, FakeChannel } = fakeEnv()
    runtimeModule.startSessionRuntime(MARCUS, env)
    new FakeChannel('hearth:identity').postMessage({ t: 'identity' })
    await tick()
    expect(left).toEqual(['reload'])
    expect(storage.map.get('hearth:left')).toBe('other_tab')
  })
})
