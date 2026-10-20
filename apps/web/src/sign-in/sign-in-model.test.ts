// The sign-in screen's pure logic (T20, T21 item 13). Each transition is checked for its next step,
// the call it asks for, and what the person hears (a focus move or a message), with no DOM.
import { type CodeSent, type ErrorExtras, MESSAGES, type OtpVerifyReply, type PinStateJSON } from '@hearth/shared'
import { describe, expect, it } from 'vitest'
import { SIGN_IN } from '@/strings/sign-in.ts'
import {
  type Answer,
  busyText,
  codeStepText,
  type Failure,
  initialState,
  nextDeadline,
  type Outcome,
  pinTriesText,
  RESEND_WAIT_MS,
  resendHeld,
  type SignInEvent,
  type SignInState,
  showsTriesFirst,
  startAgainHeld,
  submitHeld,
  transition,
} from './sign-in-model.ts'

// Numbers from the Tembusu seed's fictional +65 8000 range (db/seed/tembusu.sql): Marcus (Team
// Admin, code only) and Priya (Leadership, a PIN role).
const MARCUS = '+6580000003'
const PRIYA = '+6580000002'
const T0 = Date.UTC(2026, 9, 19, 9, 0, 0)

const CODE_SENT: CodeSent = { status: 'code_sent', expiresInSeconds: 300, codeLength: 6 }
const SIGNED_IN: OtpVerifyReply = { status: 'signed_in', device: { id: 'd', label: 'Chrome on Android' } }
const OK_PIN: Extract<PinStateJSON, { state: 'ok' }> = { state: 'ok', triesBeforeLock: 5, triesBeforeAdminLock: 10 }

const failure = (code: string, extra: ErrorExtras = {}, message?: string): Failure => ({
  code,
  message: message ?? (MESSAGES as Record<string, string>)[code] ?? MESSAGES.internal,
  extra,
})

// Runs events in order from a state, returning every outcome.
function run(state: SignInState, ...events: SignInEvent[]): Outcome[] {
  const outcomes: Outcome[] = []
  let current = state
  for (const event of events) {
    const outcome = transition(current, event)
    outcomes.push(outcome)
    current = outcome.state
  }
  return outcomes
}

const last = (outcomes: Outcome[]): Outcome => {
  const outcome = outcomes.at(-1)
  if (outcome === undefined) throw new Error('no outcome')
  return outcome
}

// Answers the call in flight.
function answer(state: SignInState, reply: Answer, now = T0): Outcome {
  const id = state.pending?.id
  if (id === undefined) throw new Error('nothing in flight')
  return transition(state, { kind: 'answer', id, now, answer: reply })
}

function fail(state: SignInState, refusal: Failure, now = T0): Outcome {
  const id = state.pending?.id
  if (id === undefined) throw new Error('nothing in flight')
  return transition(state, { kind: 'failed', id, now, failure: refusal })
}

// The phone step with a number typed and sent.
function requested(phone = MARCUS): Outcome {
  return last(run(initialState(), { kind: 'input', field: 'phone', value: phone }, { kind: 'submit', now: T0 }))
}

// The code step for a number, 30 s wait running.
function atCode(phone = MARCUS, now = T0): SignInState {
  return answer(requested(phone).state, { kind: 'code_sent', reply: CODE_SENT }, now).state
}

// The code step with a code typed and sent.
function verifying(code = '123456', phone = MARCUS): SignInState {
  return last(run(atCode(phone), { kind: 'input', field: 'code', value: code }, { kind: 'submit', now: T0 + 5_000 }))
    .state
}

const atSetPin = () =>
  answer(verifying('123456', PRIYA), { kind: 'verified', reply: { status: 'code_verified', next: 'set_pin' } }).state

const atEnterPin = (pin: PinStateJSON = OK_PIN) =>
  answer(verifying('123456', PRIYA), { kind: 'verified', reply: { status: 'code_verified', next: 'step_up', pin } })
    .state

function pinSent(state: SignInState, pin: string, pin2?: string): SignInState {
  const events: SignInEvent[] = [{ kind: 'input', field: 'pin', value: pin }]
  if (pin2 !== undefined) events.push({ kind: 'input', field: 'pin2', value: pin2 })
  events.push({ kind: 'submit', now: T0 + 10_000 })
  return last(run(state, ...events)).state
}

describe('T20 T21: the sign-in model (sign-in/sign-in-model.ts)', () => {
  it('OD-01 BP C0.8: the phone step sends the number as the server reads it, and refuses one it cannot read on the field without a call', () => {
    const sent = requested('8000 0003')
    expect(sent.call).toEqual({ id: 1, kind: 'request_code', phone: MARCUS })
    expect(sent.state.pending).toEqual({ id: 1, kind: 'request_code', e164: MARCUS })
    expect(sent.cue).toBeUndefined()

    const refused = last(
      run(initialState(), { kind: 'input', field: 'phone', value: '12345' }, { kind: 'submit', now: T0 }),
    )
    expect(refused.call).toBeUndefined()
    expect(refused.state.error).toEqual({ field: 'phone', text: MESSAGES.invalid_phone })
    expect(refused.cue).toEqual({ focus: 'phone', select: false, sayIfFocused: MESSAGES.invalid_phone })
    // The server's invalid_phone lands on the same field.
    const server = fail(sent.state, failure('invalid_phone'))
    expect(server.state.error?.field).toBe('phone')
    expect(server.state.step.kind).toBe('phone')
  })

  it('X6 T21 item 13: a code request answered moves to the code step, focuses its h1, and drops the left-reason line', () => {
    const start = initialState(SIGN_IN.signedOut)
    expect(start.left).toBe(SIGN_IN.signedOut)
    const sent = last(run(start, { kind: 'input', field: 'phone', value: MARCUS }, { kind: 'submit', now: T0 }))
    const code = answer(sent.state, { kind: 'code_sent', reply: CODE_SENT })
    expect(code.state.step).toMatchObject({ kind: 'code', e164: MARCUS, codeLength: 6, validMinutes: 5 })
    expect(code.cue).toEqual({ focus: 'h1' })
    expect(code.state.left).toBeUndefined()
    expect(code.state.values.phone).toBe(MARCUS)
  })

  it('SM-05 PRD-53 T14 item 3: codeStepText is the same template for any number, registered or not, claims no send, and shows the +65 the server assumed', () => {
    const marcus = codeStepText(MARCUS, 6, 5)
    const stranger = codeStepText('+6580009999', 6, 5)
    expect(marcus).toBe(
      "If +65 8000 0003 is registered on Hearth, we'll text it a 6-digit code. It can take a minute to arrive, and it works for 5 minutes.",
    )
    expect(stranger).toBe(marcus.replace('+65 8000 0003', '+65 8000 9999'))
    expect(marcus).not.toMatch(/sent|we've|has been/i)
    // The answer's shape decides the length and lifetime, within bounds.
    const odd = answer(requested().state, {
      kind: 'code_sent',
      reply: { status: 'code_sent', expiresInSeconds: 60, codeLength: 12 },
    })
    expect(odd.state.step).toMatchObject({ codeLength: 6, validMinutes: 1 })
  })

  it('SM-08 SI-07: the code is kept as its digits only, capped at the code length, and a short one is refused on the field without a call', () => {
    const state = atCode()
    const pasted = transition(state, { kind: 'input', field: 'code', value: '１２３ 456' })
    expect(pasted.state.values.code).toBe('123456')
    expect(transition(state, { kind: 'input', field: 'code', value: '123-4567' }).state.values.code).toBe('123456')
    const short = last(
      run(state, { kind: 'input', field: 'code', value: '123 45' }, { kind: 'submit', now: T0 + 1_000 }),
    )
    expect(short.call).toBeUndefined()
    expect(short.state.error).toEqual({ field: 'code', text: 'Enter the 6-digit code.' })
    expect(short.cue).toMatchObject({ focus: 'code', sayIfFocused: 'Enter the 6-digit code.' })
    const sent = last(run(state, { kind: 'input', field: 'code', value: '123 456' }, { kind: 'submit', now: T0 }))
    expect(sent.call).toEqual({ id: 2, kind: 'verify_code', code: '123456' })
  })

  it('D46 ACC-01 SM-06: a signed_in answer after the code signs in at once (Member, Team Admin): the app opens, said politely', () => {
    const done = answer(verifying(), { kind: 'verified', reply: SIGNED_IN })
    expect(done.state.step).toEqual({ kind: 'signed_in' })
    expect(done.enter).toBe(true)
    expect(done.cue).toEqual({ say: SIGN_IN.signedIn, politeness: 'polite' })
    // Nothing typed survives into the signed-in state.
    expect(Object.values(done.state.values).every(value => value === '')).toBe(true)
  })

  it('SM-06 AQ-02 ACC-02 OD-01: code_verified set_pin opens Choose a PIN; step_up ok opens Enter your PIN; step_up locked or admin_locked opens the locked view; a passkey field changes nothing', () => {
    const setPin = answer(verifying('123456', PRIYA), {
      kind: 'verified',
      reply: { status: 'code_verified', next: 'set_pin' },
    })
    expect(setPin.state.step).toEqual({ kind: 'set_pin', e164: PRIYA })
    expect(setPin.cue).toEqual({ focus: 'h1' })
    expect(setPin.enter).toBeUndefined()

    for (const passkey of [undefined, true, false]) {
      const reply: OtpVerifyReply = { status: 'code_verified', next: 'step_up', pin: OK_PIN }
      const enter = answer(verifying('123456', PRIYA), {
        kind: 'verified',
        reply: passkey === undefined ? reply : { ...reply, passkey },
      })
      expect(enter.state.step).toEqual({ kind: 'enter_pin', e164: PRIYA, pin: OK_PIN })
      expect(enter.cue).toEqual({ focus: 'h1' })
    }

    const until = '2026-10-19T09:15:00.000Z'
    const locked = answer(verifying('123456', PRIYA), {
      kind: 'verified',
      reply: { status: 'code_verified', next: 'step_up', pin: { state: 'locked', until } },
    })
    expect(locked.state.step).toEqual({
      kind: 'pin_locked',
      e164: PRIYA,
      lock: { kind: 'timed', until: Date.parse(until) },
    })
    const admin = answer(verifying('123456', PRIYA), {
      kind: 'verified',
      reply: { status: 'code_verified', next: 'step_up', pin: { state: 'admin_locked' } },
    })
    expect(admin.state.step).toEqual({ kind: 'pin_locked', e164: PRIYA, lock: { kind: 'reset' } })
  })

  it('SM-01 PRD-53 WCAG 3.3.1: code_wrong stays on the code with the message and the tries left on the field, its text selected; behaviour follows the code alone', () => {
    const wrong = fail(verifying(), failure('code_wrong', { triesLeft: 3 }))
    expect(wrong.state.step.kind).toBe('code')
    const text = `${MESSAGES.code_wrong} 3 tries left.`
    expect(wrong.state.error).toEqual({ field: 'code', text })
    expect(wrong.cue).toEqual({ focus: 'code', select: true, sayIfFocused: text })
    expect(wrong.state.values.code).toBe('123456')
    expect(fail(verifying(), failure('code_wrong', { triesLeft: 1 })).state.error?.text).toBe(
      `${MESSAGES.code_wrong} 1 try left.`,
    )
    // No tries left in the answer: the message alone.
    expect(fail(verifying(), failure('code_wrong')).state.error?.text).toBe(MESSAGES.code_wrong)
    // pin_too_easy is read by its code: the same behaviour whatever the status it came with.
    const easy = fail(pinSent(atSetPin(), '482913', '482913'), failure('pin_too_easy'))
    expect(easy.state.error).toEqual({ field: 'pin', text: MESSAGES.pin_too_easy })
  })

  it('SM-02 PRD-53 T21 item 13: code_dead and code_expired clear and disable the code, enable Send a new code at once and focus it, with the message as its description', () => {
    for (const code of ['code_dead', 'code_expired'] as const) {
      const dead = fail(verifying(), failure(code))
      const step = dead.state.step
      if (step.kind !== 'code') throw new Error('expected the code step')
      expect(step.dead).toBe(MESSAGES[code])
      expect(step.resend.ready).toBe(true)
      expect(dead.state.values.code).toBe('')
      expect(dead.state.error).toBeUndefined()
      expect(dead.cue).toEqual({ focus: 'resend' })
      expect(resendHeld(dead.state)).toBeUndefined()
      // Sign in can't act on a dead code, and says why; typing changes nothing.
      expect(submitHeld(dead.state)).toBe(MESSAGES[code])
      expect(transition(dead.state, { kind: 'submit', now: T0 + 6_000 }).call).toBeUndefined()
      expect(transition(dead.state, { kind: 'input', field: 'code', value: '1' }).state).toBe(dead.state)
      // A new code brings the field back.
      const again = transition(dead.state, { kind: 'resend', now: T0 + 6_000 })
      expect(again.call).toMatchObject({ kind: 'request_code', phone: MARCUS })
      const fresh = answer(again.state, { kind: 'code_sent', reply: CODE_SENT }, T0 + 7_000)
      expect(fresh.state.step).toMatchObject({ kind: 'code', dead: undefined })
    }
  })

  it('SM-03 T14 item 3 WCAG 3.3.7: attempt_expired, wrong_step and pin_already_set go back to the phone step with the number kept and focus the notice', () => {
    const cases: [SignInState, string][] = [
      [verifying(), 'attempt_expired'],
      [verifying(), 'wrong_step'],
      [pinSent(atSetPin(), '482913', '482913'), 'pin_already_set'],
      [pinSent(atSetPin(), '482913', '482913'), 'attempt_expired'],
      [pinSent(atEnterPin(), '482913'), 'wrong_step'],
    ]
    for (const [state, code] of cases) {
      const back = fail(state, failure(code))
      expect(back.state.step, code).toEqual({ kind: 'phone' })
      expect(back.state.values.phone).toBe(state.values.phone)
      expect(back.state.values.code).toBe('')
      expect(back.state.values.pin).toBe('')
      expect(back.state.notice).toBe((MESSAGES as Record<string, string>)[code])
      expect(back.cue).toEqual({ focus: 'notice' })
    }
  })

  it('SM-04 PRD-53: too_many_requests holds the submit for retryAfterSeconds, says the wait in minutes or hours, and lets go when the wait ends', () => {
    const limited = fail(requested().state, failure('too_many_requests', { retryAfterSeconds: 600 }))
    const text = 'Too many tries. Try again in 10 minutes.'
    expect(limited.state.hold).toEqual({ until: T0 + 600_000, reason: text })
    expect(limited.state.notice).toBe(text)
    expect(limited.cue).toEqual({ say: text, politeness: 'assertive' })
    expect(submitHeld(limited.state)).toBe(text)
    expect(nextDeadline(limited.state)).toBe(T0 + 600_000)
    // A press during the wait does nothing.
    expect(transition(limited.state, { kind: 'submit', now: T0 + 1_000 }).call).toBeUndefined()
    // The wait ends: the hold and its notice go, and a press sends again.
    const over = transition(limited.state, { kind: 'tick', now: T0 + 600_000 })
    expect(over.state.hold).toBeUndefined()
    expect(over.state.notice).toBeUndefined()
    expect(transition(over.state, { kind: 'submit', now: T0 + 600_001 }).call).toMatchObject({ kind: 'request_code' })

    // At the code, a verify limit holds Sign in; a request limit holds Send a new code.
    const verify = fail(verifying(), failure('too_many_requests', { retryAfterSeconds: 3 * 3600 }))
    expect(verify.state.hold?.reason).toBe('Too many tries. Try again in about 3 hours.')
    const resent = transition(transition(atCode(), { kind: 'tick', now: T0 + RESEND_WAIT_MS }).state, {
      kind: 'resend',
      now: T0 + RESEND_WAIT_MS,
    })
    const request = fail(resent.state, failure('too_many_requests', { retryAfterSeconds: 600 }), T0 + RESEND_WAIT_MS)
    expect(request.state.hold).toBeUndefined()
    expect(resendHeld(request.state)).toBe(text)
    // code_dead can't lift a limit the server set.
    const verifyAfter = last(
      run(request.state, { kind: 'input', field: 'code', value: '654321' }, { kind: 'submit', now: T0 + 40_000 }),
    )
    const dead = fail(verifyAfter.state, failure('code_dead'), T0 + 41_000)
    expect(resendHeld(dead.state)).toBe(text)
    // On the phone step, another number may go at once: the wait was most likely the number's own.
    const other = transition(limited.state, { kind: 'input', field: 'phone', value: '+6580000011' })
    expect(other.state.hold).toBeUndefined()
    expect(other.state.notice).toBeUndefined()
    expect(transition(other.state, { kind: 'submit', now: T0 + 1_000 }).call).toMatchObject({
      kind: 'request_code',
      phone: '+6580000011',
    })
    // No wait in the answer: the server's message, nothing held.
    const bare = fail(requested().state, failure('too_many_requests'))
    expect(bare.state.hold).toBeUndefined()
    expect(bare.state.notice).toBe(MESSAGES.too_many_requests)
  })

  it('PRD-53: the wait is words, in minutes up to 59 and in hours, rounded up, from an hour', () => {
    expect(SIGN_IN.wait(60)).toBe('1 minute')
    expect(SIGN_IN.wait(1)).toBe('1 minute')
    expect(SIGN_IN.wait(61)).toBe('2 minutes')
    expect(SIGN_IN.wait(59 * 60)).toBe('59 minutes')
    expect(SIGN_IN.wait(60 * 60)).toBe('about 1 hour')
    expect(SIGN_IN.wait(61 * 60)).toBe('about 2 hours')
    expect(SIGN_IN.wait(20 * 3600)).toBe('about 20 hours')
  })

  it('SHL-07 SI-08 X11: Send a new code waits 30 s after each request with its reason, then is said ready once, politely', () => {
    const code = atCode()
    expect(resendHeld(code)).toBe(SIGN_IN.resendWait)
    expect(nextDeadline(code)).toBe(T0 + RESEND_WAIT_MS)
    // Pressed early: nothing.
    expect(transition(code, { kind: 'resend', now: T0 + 29_999 }).call).toBeUndefined()
    // A tick before the deadline changes nothing.
    expect(transition(code, { kind: 'tick', now: T0 + 29_999 }).state).toBe(code)
    const ready = transition(code, { kind: 'tick', now: T0 + RESEND_WAIT_MS })
    expect(ready.cue).toEqual({ say: SIGN_IN.resendReady, politeness: 'polite' })
    expect(resendHeld(ready.state)).toBeUndefined()
    expect(nextDeadline(ready.state)).toBeUndefined()
    // Said once: a later tick says nothing.
    expect(transition(ready.state, { kind: 'tick', now: T0 + 60_000 }).cue).toBeUndefined()

    // A new code: the field cleared, the wait again, said politely; focus stays.
    const again = transition(ready.state, { kind: 'resend', now: T0 + 40_000 })
    expect(again.call).toEqual({ id: 2, kind: 'request_code', phone: MARCUS })
    expect(resendHeld(again.state)).toBe(SIGN_IN.busy.sending)
    const sent = answer(again.state, { kind: 'code_sent', reply: CODE_SENT }, T0 + 41_000)
    expect(sent.cue).toEqual({ say: SIGN_IN.newCode, politeness: 'polite' })
    expect(sent.state.step).toMatchObject({ kind: 'code', resend: { at: T0 + 41_000 + RESEND_WAIT_MS, ready: false } })
    expect(sent.state.values.code).toBe('')
    // Shown as well as said (resent), until a code dies; the first code's step doesn't show it.
    expect(code.step).not.toHaveProperty('resent')
    expect(sent.state.step).toMatchObject({ resent: true })
    const verifyingNew = transition(transition(sent.state, { kind: 'input', field: 'code', value: '123456' }).state, {
      kind: 'submit',
      now: T0 + 42_000,
    }).state
    const dead = fail(verifyingNew, failure('code_expired'))
    expect(dead.state.step).toMatchObject({ dead: MESSAGES.code_expired, resent: undefined })
  })

  it('T21 item 13: a 503, a network failure or a second try_again at the code keeps the code for another press, in the notice, said assertively', () => {
    for (const code of ['unavailable', 'network', 'try_again', 'invalid_response', 'internal']) {
      const refused = fail(verifying(), failure(code, {}, `${code} copy`))
      expect(refused.state.step.kind).toBe('code')
      expect(refused.state.values.code).toBe('123456')
      expect(refused.state.notice).toBe(`${code} copy`)
      expect(refused.cue).toEqual({ say: `${code} copy`, politeness: 'assertive' })
      // Pressing again sends the same code.
      expect(transition(refused.state, { kind: 'submit', now: T0 + 6_000 }).call).toMatchObject({
        kind: 'verify_code',
        code: '123456',
      })
    }
  })

  it('SHL-49 T14 item 8: Choose a PIN checks the shared policy and the match before sending, and the server’s invalid_pin and pin_too_easy land on the first field', () => {
    const state = atSetPin()
    expect(pinSent(state, '1234', '1234').error).toEqual({ field: 'pin', text: MESSAGES.invalid_pin })
    for (const easy of ['111111', '123456', '987654', '159753']) {
      const refused = last(run(state, { kind: 'input', field: 'pin', value: easy }, { kind: 'submit', now: T0 }))
      expect(refused.call, easy).toBeUndefined()
      expect(refused.state.error).toEqual({ field: 'pin', text: MESSAGES.pin_too_easy })
    }
    const missing = last(run(state, { kind: 'input', field: 'pin', value: '482913' }, { kind: 'submit', now: T0 }))
    expect(missing.state.error).toEqual({ field: 'pin2', text: SIGN_IN.pinAgainMissing })
    const mismatch = last(
      run(
        state,
        { kind: 'input', field: 'pin', value: '482913' },
        { kind: 'input', field: 'pin2', value: '482914' },
        { kind: 'submit', now: T0 },
      ),
    )
    expect(mismatch.call).toBeUndefined()
    expect(mismatch.state.error).toEqual({ field: 'pin2', text: SIGN_IN.pinMismatch })
    expect(mismatch.cue).toMatchObject({ focus: 'pin2', select: true })
    // A date is allowed (T14 item 8), and full-width digits are read as digits.
    const ok = last(
      run(
        state,
        { kind: 'input', field: 'pin', value: '１９０８６５' },
        { kind: 'input', field: 'pin2', value: '190865' },
        { kind: 'submit', now: T0 },
      ),
    )
    expect(ok.call).toEqual({ id: 3, kind: 'set_pin', pin: '190865' })
    // The server says the same.
    for (const code of ['invalid_pin', 'pin_too_easy']) {
      const refused = fail(ok.state, failure(code))
      expect(refused.state.error).toEqual({ field: 'pin', text: (MESSAGES as Record<string, string>)[code] })
    }
    expect(answer(ok.state, { kind: 'signed_in' })).toMatchObject({
      enter: true,
      state: { step: { kind: 'signed_in' } },
    })
  })

  it('T14 item 9: Enter your PIN says the tries left before typing only after earlier failures, and pin_wrong picks the 15-minute or the Owner-reset line', () => {
    expect(showsTriesFirst(OK_PIN)).toBe(false)
    expect(showsTriesFirst({ state: 'ok', triesBeforeLock: 4, triesBeforeAdminLock: 9 })).toBe(true)
    expect(pinTriesText({ state: 'ok', triesBeforeLock: 2, triesBeforeAdminLock: 7 })).toBe(
      '2 tries left before a 15-minute lock.',
    )
    // After a lock ends, one try before the next; the 10th failure needs an Owner.
    expect(pinTriesText({ state: 'ok', triesBeforeLock: 1, triesBeforeAdminLock: 4 })).toBe(
      '1 try left before a 15-minute lock.',
    )
    expect(pinTriesText({ state: 'ok', triesBeforeLock: 1, triesBeforeAdminLock: 1 })).toBe(
      '1 try left before your PIN locks until an Owner resets it.',
    )

    const pin = { state: 'ok', triesBeforeLock: 3, triesBeforeAdminLock: 8 } as const
    const wrong = fail(pinSent(atEnterPin(), '482913'), failure('pin_wrong', { pin }))
    const text = `${MESSAGES.pin_wrong} 3 tries left before a 15-minute lock.`
    expect(wrong.state.error).toEqual({ field: 'pin', text })
    expect(wrong.cue).toEqual({ focus: 'pin', select: true, sayIfFocused: text })
    expect(wrong.state.step).toMatchObject({ kind: 'enter_pin', pin })
    // A short PIN is refused before a call.
    expect(pinSent(atEnterPin(), '12').error).toEqual({ field: 'pin', text: MESSAGES.invalid_pin })
  })

  it('SM-04 ACC-06 T14 item 12: pin_locked opens the locked view with its end; pin_reset_needed and an admin lock open the one only an Owner ends; only Start again is left', () => {
    const until = '2026-10-19T09:15:00.000Z'
    const timed = fail(pinSent(atEnterPin(), '482913'), failure('pin_locked', { pin: { state: 'locked', until } }))
    expect(timed.state.step).toMatchObject({ kind: 'pin_locked', lock: { kind: 'timed', until: Date.parse(until) } })
    expect(timed.cue).toEqual({ focus: 'h1' })
    const admin = fail(pinSent(atEnterPin(), '482913'), failure('pin_locked', { pin: { state: 'admin_locked' } }))
    expect(admin.state.step).toMatchObject({ lock: { kind: 'reset' } })
    const reset = fail(pinSent(atEnterPin(), '482913'), failure('pin_reset_needed'))
    expect(reset.state.step).toMatchObject({ kind: 'pin_locked', lock: { kind: 'reset' } })
    // The locked view has no form: a submit does nothing; Start again keeps the number.
    expect(transition(reset.state, { kind: 'submit', now: T0 }).call).toBeUndefined()
    const back = transition(reset.state, { kind: 'start_again' })
    expect(back.state.step).toEqual({ kind: 'phone' })
    expect(back.state.values.phone).toBe(PRIYA)
    expect(back.cue).toEqual({ focus: 'h1' })
  })

  it('X6: Use a different number and Start again go back to the phone step with the number kept and focus its h1', () => {
    const code = last(run(atCode(), { kind: 'input', field: 'code', value: '12' }))
    expect(startAgainHeld(code.state)).toBeUndefined()
    const back = transition(code.state, { kind: 'start_again' })
    expect(back.state.step).toEqual({ kind: 'phone' })
    expect(back.state.values).toEqual({ phone: MARCUS, code: '', pin: '', pin2: '' })
    expect(back.cue).toEqual({ focus: 'h1' })
    for (const state of [atSetPin(), atEnterPin()]) {
      expect(startAgainHeld(state)).toBeUndefined()
      expect(transition(state, { kind: 'start_again' }).state.step).toEqual({ kind: 'phone' })
    }
  })

  it('X6: while a code or PIN is being checked, Use a different number and Start again are held with the busy text, so an answer that signs in still opens the app', () => {
    // The answer may set the session cookie, so leaving the step would orphan a live session.
    const inFlight = [verifying(), pinSent(atSetPin(), '482913', '482913'), pinSent(atEnterPin(), '482913')]
    for (const state of inFlight) {
      const kind = state.pending?.kind
      expect(startAgainHeld(state), kind).toBe(SIGN_IN.busy.checking)
      const pressed = transition(state, { kind: 'start_again' })
      expect(pressed.state, kind).toBe(state)
      expect(pressed.cue, kind).toBeUndefined()
      // The call answers signed in: the app opens, as it would have without the press.
      const reply: Answer = kind === 'verify_code' ? { kind: 'verified', reply: SIGNED_IN } : { kind: 'signed_in' }
      const done = answer(pressed.state, reply)
      expect(done.enter, kind).toBe(true)
      expect(done.state.step, kind).toEqual({ kind: 'signed_in' })
      // A refusal frees them again.
      const refused = fail(pressed.state, failure('unavailable'))
      expect(startAgainHeld(refused.state), kind).toBeUndefined()
      expect(transition(refused.state, { kind: 'start_again' }).state.step, kind).toEqual({ kind: 'phone' })
    }
  })

  it('X6: a code request in flight holds nothing: Use a different number goes back, and its late answer is stale and changes nothing', () => {
    const ready = transition(atCode(), { kind: 'tick', now: T0 + RESEND_WAIT_MS }).state
    const resending = transition(ready, { kind: 'resend', now: T0 + 40_000 }).state
    expect(resending.pending?.kind).toBe('request_code')
    expect(startAgainHeld(resending)).toBeUndefined()
    const back = transition(resending, { kind: 'start_again' })
    expect(back.state.step).toEqual({ kind: 'phone' })
    expect(back.state.pending).toBeUndefined()
    const id = resending.pending?.id ?? 0
    const late = transition(back.state, {
      kind: 'answer',
      id,
      now: T0 + 41_000,
      answer: { kind: 'code_sent', reply: CODE_SENT },
    })
    expect(late.state).toBe(back.state)
    expect(late.cue).toBeUndefined()
    expect(
      transition(back.state, { kind: 'failed', id, now: T0 + 41_000, failure: failure('too_many_requests') }).state,
    ).toBe(back.state)
  })

  it('one call at a time: a second submit or a resend while one is in flight does nothing, and the busy text names it', () => {
    const inFlight = verifying()
    expect(busyText(inFlight)).toBe(SIGN_IN.busy.checking)
    expect(submitHeld(inFlight)).toBe(SIGN_IN.busy.checking)
    expect(transition(inFlight, { kind: 'submit', now: T0 + 6_000 }).state).toBe(inFlight)
    expect(transition(inFlight, { kind: 'resend', now: T0 + 60_000 }).call).toBeUndefined()
    expect(busyText(requested().state)).toBe(SIGN_IN.busy.sending)
    expect(busyText(atCode())).toBeUndefined()
  })

  it('T21 item 13: every ErrorCode the server sends has a behaviour on every step that calls, never a throw and never silence', () => {
    const inFlight = [
      requested().state,
      verifying(),
      pinSent(atSetPin(), '482913', '482913'),
      pinSent(atEnterPin(), '482913'),
    ]
    for (const code of Object.keys(MESSAGES)) {
      for (const state of inFlight) {
        const outcome = fail(state, failure(code, { retryAfterSeconds: 60, triesLeft: 2, pin: OK_PIN }))
        expect(outcome.state.pending, code).toBeUndefined()
        expect(outcome.cue, `${code} at ${state.step.kind}`).toBeDefined()
      }
    }
  })

  it('every outcome carries at most one cue, a focus move or a message, so nothing is spoken twice', () => {
    // The cue type is one or the other; check no outcome in a long run builds both.
    const outcomes = [
      requested(),
      answer(requested().state, { kind: 'code_sent', reply: CODE_SENT }),
      fail(verifying(), failure('code_wrong', { triesLeft: 2 })),
      fail(verifying(), failure('code_dead')),
      fail(verifying(), failure('attempt_expired')),
      fail(verifying(), failure('too_many_requests', { retryAfterSeconds: 60 })),
      fail(verifying(), failure('unavailable')),
      transition(atCode(), { kind: 'tick', now: T0 + RESEND_WAIT_MS }),
      answer(verifying(), { kind: 'verified', reply: SIGNED_IN }),
    ]
    for (const outcome of outcomes) {
      if (outcome.cue === undefined) continue
      expect('focus' in outcome.cue && 'say' in outcome.cue).toBe(false)
    }
  })

  it('T21 item 5: the state holds the step and what was typed only; Show PIN switches both PIN fields', () => {
    const state = atSetPin()
    const shown = transition(state, { kind: 'show_pin', shown: true })
    expect(shown.state.showPin).toBe(true)
    expect(transition(shown.state, { kind: 'show_pin', shown: true }).state).toBe(shown.state)
    expect(Object.keys(initialState())).toEqual(['step', 'values', 'showPin', 'nextId', 'left'])
  })
})
