// The sign-in screen's store (T20; T21 item 13, SHL-07, X11, WCAG 4.1.3), on a fake
// clock and a fake api: the calls it makes, the timers it runs, and the cues it hands the screen.
import { MESSAGES } from '@hearth/shared'
import { describe, expect, it } from 'vitest'
import { ApiFailure } from '@/api/http.ts'
import { API_COPY } from '@/strings/api.ts'
import { SIGN_IN } from '@/strings/sign-in.ts'
import type { SignInApi } from './api.ts'
import { BUSY_SAY_MS, createSignInController, failureOf } from './controller.ts'
import type { Cue } from './sign-in-model.ts'
import { RESEND_WAIT_MS, startAgainHeld } from './sign-in-model.ts'

// A clock and timers that move only when told.
function fakeTime(start = Date.UTC(2026, 9, 19, 9, 0, 0)) {
  let now = start
  let nextHandle = 1
  const timers = new Map<number, { at: number; task: () => void }>()
  return {
    now: () => now,
    setTimeout: (task: () => void, ms: number) => {
      const handle = nextHandle++
      timers.set(handle, { at: now + ms, task })
      return handle
    },
    clearTimeout: (handle: unknown) => {
      timers.delete(handle as number)
    },
    pending: () => timers.size,
    // Moves the clock on, firing each timer that falls due, in order.
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (due === undefined) break
        timers.delete(due[0])
        now = due[1].at
        due[1].task()
      }
      now = end
    },
  }
}

// An api whose every call waits until the test answers it.
function fakeApi() {
  const calls: { kind: keyof SignInApi; arg: string; resolve(value: unknown): void; reject(error: unknown): void }[] =
    []
  const call =
    (kind: keyof SignInApi) =>
    (arg: string): Promise<never> =>
      new Promise((resolve, reject) => {
        calls.push({ kind, arg, resolve: resolve as (value: unknown) => void, reject })
      })
  const api: SignInApi = {
    requestCode: call('requestCode'),
    verifyCode: call('verifyCode'),
    setPin: call('setPin'),
    enterPin: call('enterPin'),
    sessionHeld: () => call('sessionHeld')(''),
  }
  return { api, calls }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function setup(left?: string) {
  const time = fakeTime()
  const { api, calls } = fakeApi()
  const cues: Cue[] = []
  let entered = 0
  const controller = createSignInController(
    {
      api,
      now: time.now,
      setTimeout: time.setTimeout,
      clearTimeout: time.clearTimeout,
      cue: cue => cues.push(cue),
      enter: () => {
        entered += 1
      },
    },
    left,
  )
  controller.start()
  return { time, calls, cues, controller, entered: () => entered }
}

const CODE_SENT = { status: 'code_sent', expiresInSeconds: 300, codeLength: 6 }

describe('T20 T21: the sign-in store (sign-in/controller.ts)', () => {
  it('SHL-07 SI-08 X11: after a code is sent, Send a new code is held 30 s, then said ready once, politely, and sends one request', async () => {
    const { time, calls, cues, controller } = setup()
    controller.input('phone', '+6580000003')
    controller.submit()
    expect(calls.map(call => [call.kind, call.arg])).toEqual([['requestCode', '+6580000003']])
    calls[0]?.resolve(CODE_SENT)
    await flush()
    expect(controller.snapshot().step.kind).toBe('code')
    expect(cues.at(-1)).toEqual({ focus: 'h1' })

    controller.resend()
    time.advance(RESEND_WAIT_MS - 1)
    controller.resend()
    expect(calls).toHaveLength(1)
    expect(cues.filter(cue => 'say' in cue && cue.say === SIGN_IN.resendReady)).toEqual([])
    time.advance(1_000)
    expect(cues.filter(cue => 'say' in cue && cue.say === SIGN_IN.resendReady)).toHaveLength(1)
    time.advance(120_000)
    expect(cues.filter(cue => 'say' in cue && cue.say === SIGN_IN.resendReady)).toHaveLength(1)
    // No timer is left once nothing waits.
    expect(time.pending()).toBe(0)

    controller.resend()
    controller.resend()
    expect(calls.map(call => call.kind)).toEqual(['requestCode', 'requestCode'])
  })

  it('WCAG 4.1.3: a call still out after a second is said busy once, politely; one answered sooner says nothing', async () => {
    const { time, calls, cues, controller } = setup()
    controller.input('phone', '+6580000003')
    controller.submit()
    time.advance(BUSY_SAY_MS - 1)
    expect(cues).toEqual([])
    time.advance(1)
    expect(cues).toEqual([{ say: SIGN_IN.busy.sending, politeness: 'polite' }])
    calls[0]?.resolve(CODE_SENT)
    await flush()

    cues.length = 0
    controller.input('code', '123456')
    controller.submit()
    calls[1]?.reject(new ApiFailure(401, 'code_wrong', MESSAGES.code_wrong, { triesLeft: 4 }))
    await flush()
    time.advance(BUSY_SAY_MS * 2)
    expect(cues.filter(cue => 'say' in cue && cue.say === SIGN_IN.busy.checking)).toEqual([])
    expect(cues).toEqual([{ focus: 'code', select: true, sayIfFocused: `${MESSAGES.code_wrong} 4 tries left.` }])
  })

  it('D-01 D46: a signed-in answer opens the app once; a PIN step signs in the same way', async () => {
    const { calls, controller, entered } = setup()
    controller.input('phone', '+6580000002')
    controller.submit()
    calls[0]?.resolve(CODE_SENT)
    await flush()
    controller.input('code', '123456')
    controller.submit()
    calls[1]?.resolve({ status: 'code_verified', next: 'set_pin' })
    await flush()
    expect(controller.snapshot().step.kind).toBe('set_pin')
    expect(entered()).toBe(0)
    controller.input('pin', '482913')
    controller.input('pin2', '482913')
    controller.submit()
    expect(calls[2]).toMatchObject({ kind: 'setPin', arg: '482913' })
    calls[2]?.resolve({ status: 'signed_in', device: { id: 'd', label: 'Chrome on Android' } })
    await flush()
    expect(controller.snapshot().step.kind).toBe('signed_in')
    expect(entered()).toBe(1)
  })

  it('T21 item 2 D-01: a code or PIN step whose answer is lost asks GET /api/session before showing the retry, and opens the app when it names a person', async () => {
    const network = () => new ApiFailure(0, 'network', API_COPY.network)
    const unreadable = () => new ApiFailure(200, 'invalid_response', MESSAGES.internal)
    // The code step, for a number on the roster.
    const atCode = async () => {
      const harness = setup()
      harness.controller.input('phone', '+6580000002')
      harness.controller.submit()
      harness.calls[0]?.resolve(CODE_SENT)
      await flush()
      harness.controller.input('code', '123456')
      harness.controller.submit()
      return harness
    }

    // The code was right and the session issued, but the answer was cut off at 20 s.
    for (const lost of [network, unreadable]) {
      const { calls, controller, entered } = await atCode()
      calls[1]?.reject(lost())
      await flush()
      expect(calls.map(call => call.kind)).toEqual(['requestCode', 'verifyCode', 'sessionHeld'])
      // Still checking: nothing shown yet, and Start again still held.
      expect(controller.snapshot().notice).toBeUndefined()
      expect(startAgainHeld(controller.snapshot())).toBe(SIGN_IN.busy.checking)
      calls[2]?.resolve(true)
      await flush()
      expect(controller.snapshot().step.kind).toBe('signed_in')
      expect(entered()).toBe(1)
    }

    // No session after all: the failure shows as it came, and Start again is free.
    const signedOut = await atCode()
    signedOut.calls[1]?.reject(network())
    await flush()
    signedOut.calls[2]?.resolve(false)
    await flush()
    expect(signedOut.controller.snapshot()).toMatchObject({ step: { kind: 'code' }, notice: API_COPY.network })
    expect(startAgainHeld(signedOut.controller.snapshot())).toBeUndefined()
    expect(signedOut.entered()).toBe(0)

    // The PIN step the same way.
    const pin = await atCode()
    pin.calls[1]?.resolve({ status: 'code_verified', next: 'set_pin' })
    await flush()
    pin.controller.input('pin', '482913')
    pin.controller.input('pin2', '482913')
    pin.controller.submit()
    pin.calls[2]?.reject(network())
    await flush()
    expect(pin.calls[3]?.kind).toBe('sessionHeld')
    pin.calls[3]?.resolve(true)
    await flush()
    expect(pin.entered()).toBe(1)

    // A refusal the server named, and a code request (which signs nobody in), ask nothing.
    const refused = await atCode()
    refused.calls[1]?.reject(new ApiFailure(401, 'code_wrong', MESSAGES.code_wrong))
    await flush()
    const request = setup()
    request.controller.input('phone', '+6580000002')
    request.controller.submit()
    request.calls[0]?.reject(network())
    await flush()
    expect(refused.calls.map(call => call.kind)).toEqual(['requestCode', 'verifyCode'])
    expect(request.calls.map(call => call.kind)).toEqual(['requestCode'])
    expect(request.controller.snapshot().notice).toBe(API_COPY.network)
  })

  it('PRD-53: a 429 holds the submit until the wait ends, then lets go on the timer; stop() clears every timer and start() catches up', async () => {
    const { time, calls, controller } = setup()
    controller.input('phone', '+6580000003')
    controller.submit()
    calls[0]?.reject(new ApiFailure(429, 'too_many_requests', MESSAGES.too_many_requests, { retryAfterSeconds: 60 }))
    await flush()
    expect(controller.snapshot().hold?.reason).toBe('Too many tries. Try again in 1 minute.')
    controller.stop()
    expect(time.pending()).toBe(0)
    time.advance(61_000)
    expect(controller.snapshot().hold).toBeDefined()
    controller.start()
    expect(controller.snapshot().hold).toBeUndefined()
    controller.submit()
    expect(calls).toHaveLength(2)
  })

  it('T21 item 13 X11: the first start() says why the last document left, once, politely; a later start() and a screen with no reason say nothing', () => {
    const { cues, controller } = setup(SIGN_IN.signedOut)
    expect(cues).toEqual([{ say: SIGN_IN.signedOut, politeness: 'polite' }])
    controller.stop()
    controller.start()
    expect(cues).toHaveLength(1)
    expect(setup().cues).toEqual([])
  })

  it('P6: anything thrown that is not an ApiFailure reads as internal, with the generic copy', () => {
    expect(failureOf(new Error('boom'))).toEqual({ code: 'internal', message: MESSAGES.internal, extra: {} })
    expect(failureOf(new ApiFailure(503, 'unavailable', MESSAGES.unavailable))).toEqual({
      code: 'unavailable',
      message: MESSAGES.unavailable,
      extra: {},
    })
  })

  it('a subscriber hears each change of state and nothing else', () => {
    const { controller } = setup()
    let heard = 0
    const stop = controller.subscribe(() => {
      heard += 1
    })
    controller.input('phone', '8')
    controller.input('phone', '8')
    controller.showPin(false)
    expect(heard).toBe(1)
    stop()
    controller.input('phone', '80')
    expect(heard).toBe(1)
  })
})
