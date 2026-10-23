import { onlineManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { FakeClock, type FakeSocket, socketClass } from '@/live/testing/fakes.ts'
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
  onlineManager.setOnline(true)
})

// Marcus and Priya, from the Tembusu seed (db/seed/tembusu.sql).
const MARCUS = {
  personId: 'b0000000-0000-4000-8000-000000000003',
  name: 'Marcus',
  timeZone: 'Asia/Singapore',
  capabilities: { registers: false },
  notice: 'acknowledged' as const,
}
const PRIYA = {
  personId: 'b0000000-0000-4000-8000-000000000002',
  name: 'Priya',
  timeZone: 'Asia/Singapore',
  capabilities: { registers: false },
  notice: 'acknowledged' as const,
}

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

interface FakeEnvOptions {
  // The tab's session storage, kept across a reload; fresh when absent.
  storage?: ReturnType<typeof memoryStorage>
  random?: () => number
  // Every socket fails to connect, as when realtime is down.
  refuse?: boolean
  // Called whenever the client closes a socket itself.
  onSocketClose?: (code: number | undefined) => void
}

function fakeEnv(onLeave: (how: string) => void = () => {}, options: FakeEnvOptions = {}) {
  const storage = options.storage ?? memoryStorage()
  const left: string[] = []
  const FakeChannel = channelClass()
  const clock = new FakeClock()
  const net = socketClass({ clock, refuse: () => options.refuse === true })
  const onSocketClose = options.onSocketClose
  class RecordingSocket extends net.WebSocket {
    override close(code?: number, reason?: string) {
      onSocketClose?.(code)
      super.close(code, reason)
    }
  }
  const visible = new Set<() => void>()
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
    random: options.random ?? (() => 0),
    live: {
      url: 'wss://hearth.test/ws',
      WebSocket: RecordingSocket,
      clock,
      onVisible: listener => {
        visible.add(listener)
        return () => visible.delete(listener)
      },
    },
  }
  // The page shown again: every listener the runtime left registered hears it.
  const show = () => {
    for (const listener of visible) listener()
  }
  return { env, storage, left, FakeChannel, clock, net, visible, show }
}

// The person's own topic, which the runtime holds from the start.
const MARCUS_TOPIC = `person:${MARCUS.personId}`

// Opens and welcomes the runtime's socket, and acks its sub of the person's topic.
function goLive(socket: FakeSocket) {
  socket.connect()
  const sub = socket.frames('sub')[0]
  socket.ack(sub?.id, { ok: sub?.topics ?? [] })
  return sub
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

// GET /api/notice's answer for a standing (C0.9 PD-46): Marcus's, unless another person is named.
const NOTICE_ID = 'e0000000-0000-4000-8000-000000000001'
function noticeAnswer(standing: 'acknowledged' | 'required' | 'unpublished', person = MARCUS.personId) {
  return {
    person,
    standing,
    current:
      standing === 'unpublished'
        ? null
        : { id: NOTICE_ID, version: 1, publishedAt: '2026-10-23T01:00:00.000Z', body: '## About this notice' },
    changes: null,
    mine: [],
  }
}
// The person, before they have acknowledged the current notice.
const UNACKNOWLEDGED = { ...MARCUS, notice: 'required' as const }

describe('T21 D-01: the session runtime (session/runtime.ts)', () => {
  it('CHT-60 OD-10: it seeds the session answer and the formatters for the person', () => {
    const { env } = fakeEnv()
    const runtime = runtimeModule.startSessionRuntime({ ...MARCUS, timeZone: 'Europe/London' }, env)
    expect(runtime.queryClient.getQueryData(['session'])).toEqual({ ...MARCUS, timeZone: 'Europe/London' })
    // 13:30 UTC on 11 Oct 2026 is 2:30 pm in London (BST).
    expect(runtime.formatters.time(Date.UTC(2026, 9, 11, 13, 30))).toBe('2:30 pm')
  })

  it('RT-01 CHT-60: end() halts requests, stops the gateway, clears the QueryClient, then leaves the document, in that order', async () => {
    const calls = stubFetch({ '/api/session': () => json(200, MARCUS) })
    const steps: string[] = []
    const refused: string[] = []
    const { env, storage, net, clock, visible } = fakeEnv(
      how => {
        steps.push(how)
        // By the time the document leaves, nothing of the person is cached.
        steps.push(`cached ${runtime.queryClient.getQueryCache().getAll().length}`)
      },
      {
        onSocketClose: code => {
          // Requests are already halted when the socket closes.
          http.apiGet('/api/session', z.unknown()).catch((error: unknown) => {
            if (error instanceof http.ApiFailure) refused.push(error.code)
          })
          steps.push(`socket closed ${code}`)
        },
      },
    )
    const runtime = runtimeModule.startSessionRuntime(MARCUS, env)
    goLive(net.last())
    expect(runtime.live.snapshot().status).toBe('live')
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

    expect(steps).toEqual(['socket closed 1000', 'removed session', 'removed topic', 'replace /sign-in', 'cached 0'])
    expect(refused).toEqual(['halted', 'halted', 'halted'])
    expect(calls).toEqual([])
    expect(storage.map.get('hearth:left')).toBe('session_ended')
    // The live connection is off for good: no timer left, no listener, no new socket.
    expect(runtime.live.snapshot().status).toBe('stopped')
    expect(clock.pending()).toBe(0)
    expect(visible.size).toBe(0)
    clock.advance(600_000)
    expect(net.sockets).toHaveLength(1)
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

  it('RT-03 OD-05: a sign-out unanswered after 20 s is abandoned and answers failed, keeping the session, and the next press sends a POST of its own', async () => {
    const calls: string[] = []
    let answer: (() => Response) | undefined
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(url))
      const next = answer
      // The first POST never answers; it ends only when its signal aborts.
      if (next === undefined)
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })
      return next()
    })
    const { env, left, clock, net } = fakeEnv()
    const runtime = runtimeModule.startSessionRuntime(MARCUS, env)
    goLive(net.last())
    const first = runtime.signOut()
    let settled = false
    void first.then(() => {
      settled = true
    })
    clock.advance(runtimeModule.SIGN_OUT_TIMEOUT_MS - 1)
    await tick()
    expect(settled).toBe(false)
    // A press while it waits joins it.
    expect(runtime.signOut()).toBe(first)
    clock.advance(1)
    expect(await first).toBe('failed')
    expect(left).toEqual([])
    expect(runtime.live.snapshot().status).toBe('live')
    expect(runtime.queryClient.getQueryData(['session'])).toEqual(MARCUS)

    answer = () => json(200, { status: 'signed_out' })
    expect(await runtime.signOut()).toBe('ended')
    expect(calls).toEqual(['/api/auth/sign-out', '/api/auth/sign-out'])
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

  it('RT-04 T21 item 3: a 401 signed_out from the session answer ends the session (session_ended)', async () => {
    stubFetch({ '/api/session': signedOut })
    const { env, left, storage } = fakeEnv()
    const runtime = runtimeModule.startSessionRuntime(MARCUS, env)
    await runtime.queryClient.refetchQueries({ queryKey: ['session'] })
    await tick()
    expect(left).toEqual(['replace /sign-in'])
    expect(storage.map.get('hearth:left')).toBe('session_ended')
  })

  it('RT-08 CHT-60: a 401 signed_out that arrives while signOut() waits ends with signed_out_here; a failed sign-out leaves the gateway running, and a later 401 is session_ended again', async () => {
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

    // A sign-out that failed leaves no trace: the live connection was never stopped, so it carries
    // on as it was, and a later 401 is the server ending the session.
    vi.resetModules()
    runtimeModule = await import('./runtime.ts')
    http = await import('@/api/http.ts')
    stubFetch({ '/api/flags': signedOut })
    const second = fakeEnv()
    const again = runtimeModule.startSessionRuntime(MARCUS, second.env)
    goLive(second.net.last())
    expect(await again.signOut()).toBe('failed')
    expect(again.live.snapshot().status).toBe('live')
    expect(second.net.last().closedWith).toBeUndefined()
    expect(second.net.sockets).toHaveLength(1)
    const pings = second.net.last().frames('ping').length
    second.clock.advance(25_000)
    expect(second.net.last().frames('ping')).toHaveLength(pings + 1)
    await again.queryClient
      .fetchQuery({ queryKey: ['flags'], queryFn: () => http.apiGet('/api/flags', z.unknown()) })
      .catch(() => {})
    expect(second.storage.map.get('hearth:left')).toBe('session_ended')
  })

  it('RT-08 CHT-60 T21 item 4: a 4401 that arrives while signOut() waits ends with signed_out_here', async () => {
    stubFetch({ '/api/auth/sign-out': () => new Promise<Response>(() => {}) })
    const { env, left, storage, net } = fakeEnv()
    const runtime = runtimeModule.startSessionRuntime(MARCUS, env)
    goLive(net.last())
    void runtime.signOut()
    // The server revoked the session and closed this tab's socket before answering the POST.
    net.last().serverClose(4401, 'signed_out')
    expect(left).toEqual(['replace /sign-in'])
    expect(storage.map.get('hearth:left')).toBe('signed_out_here')
  })

  it('RT-05 T19 item 10 T21 item 4 C0.9 PD-46: 4401 ends the session; 4403 does not, wipes nothing, keeps the session running and makes the notice required; acknowledging it resumes the connection', async () => {
    const signedOutHere = fakeEnv()
    const first = runtimeModule.startSessionRuntime(MARCUS, signedOutHere.env)
    goLive(signedOutHere.net.last())
    signedOutHere.net.last().serverClose(4401, 'signed_out')
    expect(signedOutHere.left).toEqual(['replace /sign-in'])
    expect(signedOutHere.storage.map.get('hearth:left')).toBe('session_ended')
    expect(first.live.snapshot().status).toBe('stopped')

    vi.resetModules()
    runtimeModule = await import('./runtime.ts')
    const notice = fakeEnv()
    const runtime = runtimeModule.startSessionRuntime(MARCUS, notice.env)
    goLive(notice.net.last())
    runtime.queryClient.setQueryData(['topic', MARCUS_TOPIC], { inbox: 'cached' })
    notice.net.last().serverClose(4403, 'notice_required')
    expect(notice.left).toEqual([])
    expect(runtime.live.snapshot().status).toBe('paused')
    expect(runtime.queryClient.getQueryData(['topic', MARCUS_TOPIC])).toEqual({ inbox: 'cached' })
    expect(runtime.queryClient.getQueryData(['session'])).toEqual(MARCUS)
    expect(runtime.notice.standing()).toBe('required')
    // Paused: no reconnect until the notice is acknowledged (/notice tells the store).
    notice.clock.advance(120_000)
    expect(notice.net.sockets).toHaveLength(1)
    stubFetch({ '/api/session': () => json(200, MARCUS) })
    runtime.notice.acknowledged('here')
    expect(notice.net.sockets).toHaveLength(2)
    const sub = goLive(notice.net.last())
    expect(sub?.topics).toEqual([MARCUS_TOPIC])
    expect(runtime.live.snapshot().status).toBe('live')
    expect(runtime.queryClient.getQueryData(['topic', MARCUS_TOPIC])).toEqual({ inbox: 'cached' })
  })

  it('RT-06 T17 item 11: a flags nudge invalidates the flags query within the spread, and nothing else', () => {
    const { env, clock, net } = fakeEnv(() => {}, { random: () => 0.5 })
    const runtime = runtimeModule.startSessionRuntime(MARCUS, env)
    goLive(net.last())
    runtime.queryClient.setQueryData(['flags'], { 'core.system': false })
    runtime.queryClient.setQueryData(['topic', MARCUS_TOPIC], { inbox: 'cached' })
    net.last().receive({ v: 1, t: 'nudge', what: 'flags' })
    // The welcome's spread is 5 s: the refetch waits half of it with this random.
    clock.advance(2_499)
    expect(runtime.queryClient.getQueryState(['flags'])?.isInvalidated).toBe(false)
    clock.advance(1)
    expect(runtime.queryClient.getQueryState(['flags'])?.isInvalidated).toBe(true)
    expect(runtime.queryClient.getQueryState(['topic', MARCUS_TOPIC])?.isInvalidated).toBe(false)
    expect(runtime.queryClient.getQueryState(['session'])?.isInvalidated).toBe(false)
  })

  it('RT-07 T19 item 11: after 30 s of refused reconnects the probe reads GET /api/flags, and its 401 ends the session', async () => {
    const calls = stubFetch({ '/api/flags': signedOut })
    const { env, left, storage, clock, net } = fakeEnv(() => {}, { random: () => 0.5, refuse: true })
    const runtime = runtimeModule.startSessionRuntime(MARCUS, env)
    clock.advance(29_999)
    expect(runtime.live.snapshot().status).toBe('connecting')
    expect(calls).toEqual([])
    clock.advance(1)
    expect(runtime.live.snapshot().status).toBe('stalled')
    // The probe runs at a random point in the next 5 s: half-way with this random.
    clock.advance(2_500)
    await tick()
    expect(calls).toEqual(['/api/flags'])
    expect(left).toEqual(['replace /sign-in'])
    expect(storage.map.get('hearth:left')).toBe('session_ended')
    const tried = net.sockets.length
    clock.advance(600_000)
    expect(net.sockets).toHaveLength(tried)
  })

  it('RT-07 T19 item 11: the probe sends a request of its own while a flags fetch waits offline, so its 401 still ends the session', async () => {
    const calls = stubFetch({ '/api/flags': signedOut })
    const { env, left, storage, clock } = fakeEnv(() => {}, { random: () => 0.5, refuse: true })
    const runtime = runtimeModule.startSessionRuntime(MARCUS, env)
    // A flags poll that started while the browser said it was offline: Query holds it, unsent.
    onlineManager.setOnline(false)
    const polled = runtime.queryClient
      .fetchQuery({ queryKey: ['flags'], queryFn: () => http.apiGet('/api/flags', z.unknown()) })
      .catch(() => 'cancelled')
    await tick()
    expect(runtime.queryClient.getQueryState(['flags'])?.fetchStatus).toBe('paused')
    expect(calls).toEqual([])
    // Stalled at 30 s; the probe runs half-way through the next 5 s with this random.
    clock.advance(32_500)
    await tick()
    expect(calls).toEqual(['/api/flags'])
    expect(left).toEqual(['replace /sign-in'])
    expect(storage.map.get('hearth:left')).toBe('session_ended')
    expect(await polled).toBe('cancelled')
  })

  it('RT-07 T19 item 11: a probe that finds the session alive, or can’t tell, keeps it and the connection trying', async () => {
    let answer = () => json(200, { flags: {} })
    const calls = stubFetch({ '/api/flags': () => answer() })
    const { env, left, clock, net } = fakeEnv(() => {}, { random: () => 0.5, refuse: true })
    const runtime = runtimeModule.startSessionRuntime(MARCUS, env)
    clock.advance(32_500)
    await tick()
    expect(calls).toEqual(['/api/flags'])
    answer = () => json(503, { error: 'unavailable', message: 'Later.' })
    clock.advance(30_000)
    await tick()
    expect(calls).toEqual(['/api/flags', '/api/flags'])
    expect(left).toEqual([])
    expect(runtime.live.snapshot().status).toBe('stalled')
    const tried = net.sockets.length
    clock.advance(30_000)
    expect(net.sockets.length).toBeGreaterThan(tried)
  })

  it('RT-07 T19 item 11 T21 item 4: a probe whose request hangs is let go and its request ended at 20 s, so the next one 30 s later sends its own, and its 401 ends the session', async () => {
    const { env, left, storage, clock } = fakeEnv(() => {}, { random: () => 0.5, refuse: true })
    const calls: string[] = []
    const ended: number[] = []
    let answer: (() => Response) | undefined
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(url))
      const next = answer
      // The first request never answers; it ends only when it is cancelled.
      if (next === undefined)
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            ended.push(clock.now())
            reject(init.signal?.reason)
          })
        })
      return next()
    })
    runtimeModule.startSessionRuntime(MARCUS, env)
    clock.advance(32_500)
    await tick()
    expect(calls).toEqual(['/api/flags'])
    clock.advance(19_999)
    await tick()
    expect(ended).toEqual([])
    // Let go at 20 s, and its request ended then, before the next probe at 62.5 s.
    clock.advance(1)
    await tick()
    expect(ended).toEqual([52_500])
    expect(calls).toEqual(['/api/flags'])
    answer = signedOut
    clock.advance(10_000)
    await tick()
    expect(calls).toEqual(['/api/flags', '/api/flags'])
    expect(left).toEqual(['replace /sign-in'])
    expect(storage.map.get('hearth:left')).toBe('session_ended')
  })

  it('RT-09 T19 item 10 Rule 6: the runtime holds person:<id>; an ok ack, an ev or a reset invalidates the topic, a refusal or a drop removes it, and a shown page pings', () => {
    const { env, clock, net, show } = fakeEnv(() => {}, { random: () => 0.5 })
    const runtime = runtimeModule.startSessionRuntime(MARCUS, env)
    const socket = net.last()
    expect(socket.url).toBe('wss://hearth.test/ws')
    socket.connect()
    const sub = socket.frames('sub')[0]
    expect(sub?.topics).toEqual([MARCUS_TOPIC])
    const key = ['topic', MARCUS_TOPIC]
    runtime.queryClient.setQueryData(key, { inbox: 1 })
    socket.ack(sub?.id, { ok: [MARCUS_TOPIC] })
    expect(runtime.queryClient.getQueryState(key)?.isInvalidated).toBe(true)

    runtime.queryClient.setQueryData(key, { inbox: 2 })
    socket.receive({ v: 1, t: 'ev', topic: MARCUS_TOPIC, type: 'inbox.changed', ids: {} })
    expect(runtime.queryClient.getQueryState(key)?.isInvalidated).toBe(true)

    runtime.queryClient.setQueryData(key, { inbox: 3 })
    socket.receive({ v: 1, t: 'reset', topics: [MARCUS_TOPIC], reason: 'gap' })
    clock.advance(2_500)
    expect(runtime.queryClient.getQueryState(key)?.isInvalidated).toBe(true)

    const pings = socket.frames('ping').length
    clock.advance(5_000)
    show()
    expect(socket.frames('ping')).toHaveLength(pings + 1)

    socket.receive({ v: 1, t: 'dropped', topics: [MARCUS_TOPIC], reason: 'access' })
    expect(runtime.queryClient.getQueryData(key)).toBeUndefined()
    expect(runtime.queryClient.getQueryData(['session'])).toEqual(MARCUS)
  })

  it('RT-10 T21 item 4 B-10: 4426 reloads for the update; the reloaded page, a new document still too old, is told again within the minute, holds the reload back and the live store says so', async () => {
    const { env, left, net, storage } = fakeEnv()
    const runtime = runtimeModule.startSessionRuntime(MARCUS, env)
    goLive(net.last())
    net.last().serverClose(4426, 'client_outdated')
    expect(left).toEqual(['reload'])
    expect(runtime.live.snapshot()).toEqual({ status: 'paused', updateBlocked: false })
    // Nothing resumes a 4426 pause in this document: its build stays too old (C0.9 PD-46).
    runtime.gateway.resume()
    expect(net.sockets).toHaveLength(1)

    // The reload: a new document with a runtime of its own, over the same tab's storage.
    expect(storage.map.has('hearth:reloaded-at')).toBe(true)
    vi.resetModules()
    runtimeModule = await import('./runtime.ts')
    const reloaded = fakeEnv(() => {}, { storage })
    const again = runtimeModule.startSessionRuntime(MARCUS, reloaded.env)
    goLive(reloaded.net.last())
    reloaded.net.last().serverClose(4426, 'client_outdated')
    expect(reloaded.left).toEqual([])
    expect(left).toEqual(['reload'])
    expect(again.live.snapshot()).toEqual({ status: 'paused', updateBlocked: true })
  })

  it('RT-11 T21 item 4 T19 item 11: with a 4426 reload held back, the paused connection still probes GET /api/flags, and its 401 ends the session', async () => {
    const { env, left, net, storage, clock } = fakeEnv(() => {}, { random: () => 0.5 })
    // The last reload was a moment ago, so this 4426 is held back.
    storage.map.set('hearth:reloaded-at', String(Date.now()))
    const runtime = runtimeModule.startSessionRuntime(MARCUS, env)
    goLive(net.last())
    net.last().serverClose(4426, 'client_outdated')
    expect(left).toEqual([])
    expect(runtime.live.snapshot()).toEqual({ status: 'paused', updateBlocked: true })

    // The session is revoked meanwhile: no socket hears a 4401, but the probe's 401 ends it.
    const calls = stubFetch({ '/api/flags': signedOut })
    clock.advance(15_000)
    await tick()
    expect(calls).toEqual(['/api/flags'])
    expect(left).toEqual(['replace /sign-in'])
    expect(storage.map.get('hearth:left')).toBe('session_ended')
    expect(runtime.live.snapshot().status).toBe('stopped')
  })

  it("T21 item 2: another tab's identity message ends the session with other_tab, which reloads", async () => {
    const { env, left, storage, FakeChannel } = fakeEnv()
    runtimeModule.startSessionRuntime(MARCUS, env)
    new FakeChannel('hearth:identity').postMessage({ t: 'identity' })
    await tick()
    expect(left).toEqual(['reload'])
    expect(storage.map.get('hearth:left')).toBe('other_tab')
  })

  it('NTW-03 C0.9 PD-45 PD-46: a session that hasn’t acknowledged opens no socket, its connection paused for the notice; acknowledging here starts the live connection with the person’s topic, fetches every query again and tells the other tabs; another tab’s word does the same but tells nobody', async () => {
    const calls = stubFetch({ '/api/session': () => json(200, MARCUS) })
    const { env, net, FakeChannel, clock } = fakeEnv()
    const otherTab = new FakeChannel('hearth:identity')
    const heard: unknown[] = []
    otherTab.onmessage = event => heard.push(event.data)
    const runtime = runtimeModule.startSessionRuntime(UNACKNOWLEDGED, env)
    expect(runtime.notice.standing()).toBe('required')
    clock.advance(600_000)
    expect(net.sockets).toHaveLength(0)
    expect(runtime.live.snapshot().status).toBe('paused')
    await tick()
    runtime.queryClient.setQueryData(['flags'], { 'core.system': false })

    runtime.notice.acknowledged('here')
    expect(runtime.notice.standing()).toBe('acknowledged')
    expect(net.sockets).toHaveLength(1)
    const sub = goLive(net.last())
    expect(sub?.topics).toEqual([MARCUS_TOPIC])
    expect(runtime.queryClient.getQueryState(['flags'])?.isInvalidated).toBe(true)
    await tick()
    // The session observer's query is fetched again (the paused connection's probes aside, GW-26);
    // the message names nobody and carries nothing.
    expect(calls.filter(call => call !== '/api/flags')).toEqual(['/api/session'])
    expect(heard).toEqual([{ t: 'notice' }])

    vi.resetModules()
    runtimeModule = await import('./runtime.ts')
    const elsewhere = fakeEnv()
    const listening: unknown[] = []
    const watcher = new elsewhere.FakeChannel('hearth:identity')
    watcher.onmessage = event => listening.push(event.data)
    const second = runtimeModule.startSessionRuntime(UNACKNOWLEDGED, elsewhere.env)
    second.notice.acknowledged('elsewhere')
    expect(elsewhere.net.sockets).toHaveLength(1)
    await tick()
    expect(listening).toEqual([])
  })

  it('NTW-03 C0.9 PD-46 GW-26: unacknowledged, with no socket to hear a 4401, the paused connection’s probe hears a sign-out elsewhere within 30 s and ends the document, as on /notice so on the DPO’s pages before v0', async () => {
    const calls = stubFetch({ '/api/flags': signedOut })
    const { env, left, storage, clock, net } = fakeEnv(() => {}, { random: () => 0.99 })
    runtimeModule.startSessionRuntime(UNACKNOWLEDGED, env)
    clock.advance(29_000)
    await tick()
    expect(calls).toEqual([])
    clock.advance(1_000)
    await vi.waitFor(() => expect(left).toEqual(['replace /sign-in']))
    expect(calls).toEqual(['/api/flags'])
    expect(storage.map.get('hearth:left')).toBe('session_ended')
    expect(net.sockets).toHaveLength(0)
  })

  it('NTW-03 C0.9 PD-46: a 403 notice_required from any query, or a 4403, makes the standing required, and nothing ends', async () => {
    stubFetch({ '/api/flags': () => json(403, { error: 'notice_required', message: 'Read the notice.' }) })
    const { env, left, net } = fakeEnv()
    const runtime = runtimeModule.startSessionRuntime(MARCUS, env)
    goLive(net.last())
    const seen: string[] = []
    runtime.notice.subscribe(() => seen.push(runtime.notice.standing()))
    await runtime.queryClient
      .fetchQuery({ queryKey: ['flags'], queryFn: () => http.apiGet('/api/flags', z.unknown()) })
      .catch(() => {})
    expect(seen).toEqual(['required'])
    // A hint is not an end: the connection carries on until the gateway's own 4403.
    expect(runtime.live.snapshot().status).toBe('live')
    net.last().serverClose(4403, 'notice_required')
    expect(runtime.live.snapshot().status).toBe('paused')
    expect(seen).toEqual(['required'])
    expect(left).toEqual([])
  })

  it('NTW-03 C0.9 PD-46 B-11: every GET /api/notice answer moves the standing: acknowledged at once, and one naming someone else ends the document with person_changed', async () => {
    let answer = () => json(200, noticeAnswer('acknowledged'))
    stubFetch({ '/api/notice': () => answer(), '/api/session': () => json(200, MARCUS) })
    const { env, net, left, storage } = fakeEnv()
    const runtime = runtimeModule.startSessionRuntime(UNACKNOWLEDGED, env)
    runtime.notice.check()
    // The query loads its schema with its first fetch (api/queries.ts), so the answer takes a moment.
    await vi.waitFor(() => expect(runtime.notice.standing()).toBe('acknowledged'))
    expect(net.sockets).toHaveLength(1)
    // Acknowledged: another tab's word asks nothing more.
    const asked = vi.fn(() => json(200, noticeAnswer('acknowledged')))
    answer = asked
    runtime.notice.check()
    // A fetch would be under way at once.
    expect(runtime.queryClient.isFetching({ queryKey: ['notice'] })).toBe(0)
    await tick()
    expect(asked).not.toHaveBeenCalled()

    vi.resetModules()
    runtimeModule = await import('./runtime.ts')
    stubFetch({ '/api/notice': () => json(200, noticeAnswer('required', PRIYA.personId)) })
    const other = fakeEnv()
    const theirs = runtimeModule.startSessionRuntime(UNACKNOWLEDGED, other.env)
    theirs.notice.check()
    await vi.waitFor(() => expect(other.left).toEqual(['replace /sign-in']))
    expect(other.storage.map.get('hearth:left')).toBe('person_changed')
    expect(left).toEqual([])
    expect(storage.map.has('hearth:left')).toBe(false)
  })

  it('NTW-03 C0.9 PD-46: an answer saying required moves the standing back only when its request was sent after the last acknowledgement; one that crossed it changes nothing', async () => {
    let answerNotice: ((response: Response) => void) | undefined
    let session = () => json(200, MARCUS)
    stubFetch({
      '/api/notice': () =>
        new Promise<Response>(resolve => {
          answerNotice = resolve
        }),
      '/api/session': () => session(),
    })
    const { env } = fakeEnv()
    const runtime = runtimeModule.startSessionRuntime(UNACKNOWLEDGED, env)
    // Sent before the acknowledgement, answered after it.
    runtime.notice.check()
    await vi.waitFor(() => expect(answerNotice).toBeDefined())
    runtime.notice.acknowledged('here')
    await tick()
    answerNotice?.(json(200, noticeAnswer('required')))
    await tick()
    expect(runtime.notice.standing()).toBe('acknowledged')

    // Sent after it: a newer version was published meanwhile.
    session = () => json(200, { ...MARCUS, notice: 'required' })
    await runtime.queryClient.refetchQueries({ queryKey: ['session'] })
    await tick()
    expect(runtime.notice.standing()).toBe('required')
  })

  it("NTW-03 C0.9 PD-46 T22 item 31: another tab's { t: 'notice' } makes this tab ask GET /api/notice, whose answer starts the live connection", async () => {
    const calls = stubFetch({
      '/api/notice': () => json(200, noticeAnswer('acknowledged')),
      '/api/session': () => json(200, MARCUS),
    })
    const { env, net, FakeChannel } = fakeEnv()
    const runtime = runtimeModule.startSessionRuntime(UNACKNOWLEDGED, env)
    new FakeChannel('hearth:identity').postMessage({ t: 'notice' })
    // Its answer, then every query fetched again: the session observer's.
    await vi.waitFor(() => expect(calls).toEqual(['/api/notice', '/api/session']))
    expect(runtime.notice.standing()).toBe('acknowledged')
    expect(net.sockets).toHaveLength(1)
  })
})
