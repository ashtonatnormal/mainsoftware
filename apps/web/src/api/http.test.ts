import { MESSAGES, SessionResponseForClient } from '@hearth/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { API_COPY } from '@/strings/api.ts'
import type { ApiPath } from './http.ts'

// http.ts keeps its halt latch in module state (it lives as long as the document), so each test
// loads a fresh copy.
let http: typeof import('./http.ts')
beforeEach(async () => {
  vi.resetModules()
  http = await import('./http.ts')
})

interface Call {
  url: string
  init: RequestInit
}

// A fetch that answers from a list, recording each call.
function fakeFetch(...answers: (Response | Error)[]) {
  const calls: Call[] = []
  const fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const next = answers.shift()
    if (next === undefined) throw new Error('no answer left')
    if (next instanceof Error) throw next
    return next
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// Marcus, from the Tembusu seed (db/seed/tembusu.sql).
const PERSON = { personId: 'b0000000-0000-4000-8000-000000000003', name: 'Marcus', timeZone: 'Asia/Singapore' }

async function failureOf(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    if (error instanceof http.ApiFailure) return error
    throw error
  }
  throw new Error('expected an ApiFailure')
}

describe('T21: the api client (api/http.ts)', () => {
  it('HT-01 R-63 CL Security: same-origin credentials, no-store, no redirects, relative /api paths only', async () => {
    const { fetch, calls } = fakeFetch(json(200, PERSON), json(200, { status: 'signed_out' }))
    await expect(http.apiGet('/api/session', SessionResponseForClient, { fetch })).resolves.toEqual(PERSON)
    await expect(http.apiPost('/api/auth/sign-out', {}, undefined, { fetch })).resolves.toBeUndefined()

    expect(calls.map(call => call.url)).toEqual(['/api/session', '/api/auth/sign-out'])
    for (const { init } of calls) {
      expect(init.credentials).toBe('same-origin')
      expect(init.cache).toBe('no-store')
      expect(init.redirect).toBe('error')
    }
    const [get, post] = calls
    expect(get?.init.method).toBe('GET')
    expect(get?.init.body).toBeUndefined()
    expect(post?.init.method).toBe('POST')
    expect(post?.init.body).toBe('{}')
    expect(post?.init.headers).toMatchObject({ 'content-type': 'application/json' })

    // Anything but an /api path is refused before a request: another origin, a scheme-relative
    // URL, a query, a dotted segment.
    for (const path of [
      'https://elsewhere.example/api/session',
      '//elsewhere.example/api/session',
      '/api/session?x=1',
      '/api/../session',
      '/session',
    ]) {
      await expect(http.apiGet(path as ApiPath, z.unknown(), { fetch })).rejects.toThrow(/Not an api path/)
    }
    expect(calls).toHaveLength(2)
  })

  it('HT-01 R-63: without a fetch passed in, the browser global is the one called, at call time', async () => {
    const { fetch, calls } = fakeFetch(json(200, PERSON))
    vi.stubGlobal('fetch', fetch)
    try {
      await http.apiGet('/api/session', SessionResponseForClient)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(calls.map(call => call.url)).toEqual(['/api/session'])
  })

  it('HT-02 P6: an error body becomes an ApiFailure with code, message and extras; an unreadable one gets the generic message', async () => {
    const { fetch } = fakeFetch(
      json(401, { error: 'code_wrong', message: "That code isn't right.", triesLeft: 3 }),
      json(403, { error: 'reauth_required', message: 'Confirm.', method: 'telepathy' }),
      json(429, { error: 'too_many_requests', retryAfterSeconds: 'soon', triesLeft: -1 }),
      json(404, { error: 'Not Found' }),
      json(403, { error: 'Forbidden' }),
      new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
      json(500, { message: 'no code' }),
    )
    const get = () => http.apiGet('/api/session', z.unknown(), { fetch })

    const wrong = await failureOf(get())
    expect(wrong).toMatchObject({ status: 401, code: 'code_wrong', serverMessage: "That code isn't right." })
    expect(wrong.extra).toEqual({ triesLeft: 3 })
    expect(Object.isFrozen(wrong.extra)).toBe(true)

    // A re-authentication method this build doesn't know reads as sign_in (D46, AUTH-DESIGN §10.4).
    expect((await failureOf(get())).extra).toEqual({ method: 'sign_in' })

    // Extras that don't read are dropped, never the error; the code's own copy fills a missing message.
    const limited = await failureOf(get())
    expect(limited).toMatchObject({ code: 'too_many_requests', serverMessage: MESSAGES.too_many_requests })
    expect(limited.extra).toEqual({})

    // Bodies with no message (the not-found handler, the Origin hook) get the generic copy.
    expect(await failureOf(get())).toMatchObject({ status: 404, code: 'Not Found', serverMessage: MESSAGES.internal })
    expect(await failureOf(get())).toMatchObject({ status: 403, code: 'Forbidden', serverMessage: MESSAGES.internal })

    // A body that isn't an error body at all keeps its status and reads as invalid_response.
    expect(await failureOf(get())).toMatchObject({
      status: 502,
      code: 'invalid_response',
      serverMessage: MESSAGES.internal,
    })
    expect(await failureOf(get())).toMatchObject({ status: 500, code: 'invalid_response' })
  })

  it('HT-03: a network failure is code network, status 0; a 2xx failing its schema is invalid_response', async () => {
    const { fetch } = fakeFetch(
      new TypeError('Failed to fetch'),
      json(200, { personId: 7 }),
      new Response('not json', { status: 200 }),
    )
    const get = () => http.apiGet('/api/session', SessionResponseForClient, { fetch })
    expect(await failureOf(get())).toMatchObject({ status: 0, code: 'network', serverMessage: API_COPY.network })
    expect(await failureOf(get())).toMatchObject({ status: 200, code: 'invalid_response' })
    expect(await failureOf(get())).toMatchObject({ status: 200, code: 'invalid_response' })
  })

  it('HT-03 AUTH-DESIGN §10.1: an aborted request (a time limit, a cancelled query) reads as network', async () => {
    const controller = new AbortController()
    const fetch = (async (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })) as typeof globalThis.fetch
    const pending = http.apiPost('/api/auth/otp/verify', { code: '123456' }, z.unknown(), {
      fetch,
      signal: controller.signal,
    })
    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'))
    expect(await failureOf(pending)).toMatchObject({ status: 0, code: 'network' })
  })

  it('HT-04 D-01 R-42: after haltRequests() no fetch is called, and apiGet and apiPost reject with halted', async () => {
    const { fetch, calls } = fakeFetch(json(200, PERSON))
    http.haltRequests()
    expect(await failureOf(http.apiGet('/api/session', SessionResponseForClient, { fetch }))).toMatchObject({
      status: 0,
      code: 'halted',
    })
    expect(await failureOf(http.apiPost('/api/auth/sign-out', {}, undefined, { fetch }))).toMatchObject({
      code: 'halted',
    })
    expect(calls).toEqual([])
  })

  it('HT-04 D-01 R-42: an answer that lands after the halt is dropped, success or failure', async () => {
    const answers: ((response: Response) => void)[] = []
    const fetch = (async () =>
      new Promise<Response>(resolve => {
        answers.push(resolve)
      })) as typeof globalThis.fetch
    const read = failureOf(http.apiGet('/api/session', SessionResponseForClient, { fetch }))
    const refused = failureOf(http.apiGet('/api/session', SessionResponseForClient, { fetch }))
    expect(answers).toHaveLength(2)
    http.haltRequests()
    answers[0]?.(json(200, PERSON))
    answers[1]?.(json(401, { error: 'signed_out', message: "You've been signed out." }))
    expect(await read).toMatchObject({ code: 'halted' })
    expect(await refused).toMatchObject({ code: 'halted' })
  })

  it('HT-04 D-01: halted while the body is still being read, the answer is dropped too', async () => {
    let release: () => void = () => {}
    const body = new ReadableStream<Uint8Array>({
      start: controller => {
        release = () => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(PERSON)))
          controller.close()
        }
      },
    })
    const fetch = (async () => new Response(body, { status: 200 })) as typeof globalThis.fetch
    const pending = failureOf(http.apiGet('/api/session', SessionResponseForClient, { fetch }))
    await new Promise(resolve => setTimeout(resolve, 0))
    http.haltRequests()
    release()
    expect(await pending).toMatchObject({ code: 'halted' })
  })
})
