// The sign-in calls (T20; T21 item 13): each path and body, the
// shared schemas, one repeat of a try_again (and of nothing else), and the 20 s limit.
import { describe, expect, it } from 'vitest'
import { ApiFailure } from '@/api/http.ts'
import {
  AUTH_TIMEOUT_MS,
  type AuthCallEnv,
  enterPin,
  RETRY_MIN_MS,
  RETRY_SPREAD_MS,
  requestCode,
  setPin,
  verifyCode,
} from './api.ts'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface Recorded {
  calls: { url: string; body: unknown; signal: AbortSignal | undefined }[]
  sleeps: number[]
  limits: number[]
}

// An env whose fetch answers from a list and whose sleep and timeout are recorded, not real.
function env(answers: (Response | Error)[], random = 0.5): AuthCallEnv & { recorded: Recorded } {
  const recorded: Recorded = { calls: [], sleeps: [], limits: [] }
  return {
    recorded,
    fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
      recorded.calls.push({ url: String(url), body: JSON.parse(String(init?.body)), signal: init?.signal ?? undefined })
      const next = answers.shift()
      if (next === undefined) throw new Error('no answer left')
      if (next instanceof Error) throw next
      return next
    }) as typeof fetch,
    signalAfter: ms => {
      recorded.limits.push(ms)
      return new AbortController().signal
    },
    sleep: async ms => {
      recorded.sleeps.push(ms)
    },
    random: () => random,
  }
}

async function refusal(promise: Promise<unknown>): Promise<ApiFailure> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ApiFailure) return error
    throw error
  }
  throw new Error('expected a refusal')
}

const TRY_AGAIN = { error: 'try_again', message: 'Something else happened at the same moment. Try again.' }
const SIGNED_IN = { status: 'signed_in', device: { id: 'd1', label: 'Safari on iPhone' } }

describe('T20 T21: the sign-in calls (sign-in/api.ts)', () => {
  it('T21 item 13: each call posts its body to its path and reads its answer with the shared schema', async () => {
    const e = env([
      json(200, { status: 'code_sent', expiresInSeconds: 300, codeLength: 6 }),
      json(200, {
        status: 'code_verified',
        next: 'step_up',
        pin: { state: 'ok', triesBeforeLock: 5, triesBeforeAdminLock: 10 },
      }),
      json(200, SIGNED_IN),
      json(200, SIGNED_IN),
    ])
    await expect(requestCode('+6580000003', e)).resolves.toEqual({
      status: 'code_sent',
      expiresInSeconds: 300,
      codeLength: 6,
    })
    await expect(verifyCode('123456', e)).resolves.toMatchObject({ status: 'code_verified', next: 'step_up' })
    await expect(setPin('482913', e)).resolves.toEqual(SIGNED_IN)
    await expect(enterPin('482913', e)).resolves.toEqual(SIGNED_IN)
    expect(e.recorded.calls.map(call => [call.url, call.body])).toEqual([
      ['/api/auth/otp/request', { phone: '+6580000003' }],
      ['/api/auth/otp/verify', { code: '123456' }],
      ['/api/auth/pin/set', { pin: '482913' }],
      ['/api/auth/pin/verify', { pin: '482913' }],
    ])
    // A 2xx the contract doesn't describe is a refusal the screen shows, not a step it guesses.
    const odd = env([json(200, { status: 'code_verified', next: 'passkey' })])
    expect(await refusal(verifyCode('123456', odd))).toMatchObject({ code: 'invalid_response' })
  })

  it('T21 item 13: every call is limited to 20 s, and a call cut off reads as network', async () => {
    const e = env([json(200, SIGNED_IN)])
    await enterPin('482913', e)
    expect(e.recorded.limits).toEqual([AUTH_TIMEOUT_MS])
    expect(AUTH_TIMEOUT_MS).toBe(20_000)
    expect(e.recorded.calls[0]?.signal).toBeDefined()

    // The limit fires: fetch rejects with the signal's reason, and the screen reads network.
    const controller = new AbortController()
    const hanging: AuthCallEnv = {
      fetch: ((_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })) as typeof fetch,
      signalAfter: () => controller.signal,
      sleep: async () => {},
      random: () => 0,
    }
    const pending = verifyCode('123456', hanging)
    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'))
    expect(await refusal(pending)).toMatchObject({ status: 0, code: 'network' })
  })

  it('T21 item 13: a 409 try_again is sent once more after 0.5 to 1.5 s with the same body, and a second one is shown', async () => {
    const once = env([json(409, TRY_AGAIN), json(200, SIGNED_IN)], 0.25)
    await expect(verifyCode('123456', once)).resolves.toEqual(SIGNED_IN)
    expect(once.recorded.calls.map(call => call.body)).toEqual([{ code: '123456' }, { code: '123456' }])
    expect(once.recorded.sleeps).toEqual([RETRY_MIN_MS + 0.25 * RETRY_SPREAD_MS])
    // Each send has its own 20 s.
    expect(once.recorded.limits).toEqual([AUTH_TIMEOUT_MS, AUTH_TIMEOUT_MS])
    for (const random of [0, 0.999]) {
      const e = env([json(409, TRY_AGAIN), json(200, SIGNED_IN)], random)
      await setPin('482913', e)
      const [slept] = e.recorded.sleeps
      expect(slept).toBeGreaterThanOrEqual(500)
      expect(slept).toBeLessThan(1_500)
    }

    const twice = env([json(409, TRY_AGAIN), json(409, TRY_AGAIN)])
    expect(await refusal(enterPin('482913', twice))).toMatchObject({ status: 409, code: 'try_again' })
    expect(twice.recorded.calls).toHaveLength(2)
  })

  it('T21 item 13: nothing else is repeated: a 503, a 401, a 429, another 409 or a network failure is shown at once', async () => {
    const refusals: (Response | Error)[] = [
      json(503, { error: 'unavailable', message: "That isn't available right now. Try again in a few minutes." }),
      json(401, { error: 'code_wrong', message: "That code isn't right.", triesLeft: 4 }),
      json(429, { error: 'too_many_requests', message: 'Too many tries.', retryAfterSeconds: 600 }),
      json(409, { error: 'wrong_step', message: 'Start signing in again.' }),
      new TypeError('Failed to fetch'),
    ]
    for (const answer of refusals) {
      const e = env([answer, json(200, SIGNED_IN)])
      const failed = await refusal(verifyCode('123456', e))
      expect(failed.code).not.toBe('try_again')
      expect(e.recorded.calls).toHaveLength(1)
      expect(e.recorded.sleeps).toEqual([])
    }
    const extras = await refusal(verifyCode('123456', env([json(401, { error: 'code_wrong', triesLeft: 4 })])))
    expect(extras.extra).toEqual({ triesLeft: 4 })
  })
})
