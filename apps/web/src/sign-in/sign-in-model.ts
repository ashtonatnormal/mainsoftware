// The sign-in screen's logic, pure (T20, T21; AUTH-DESIGN §10.1–10.2, DESIGN-SHELL §5.8,
// INTEGRATION.md item 3; D46, AQ-02, OD-01, PRD-53). transition(state, event) answers the next
// state, the call to make, and what the person should hear or where focus goes, as data, so Node
// tests cover every branch without a DOM. sign-in/controller.ts runs the calls and timers and hands
// the cues to the screen.
//
//   phone ──code_sent──▶ code ──signed_in──────────────────────────────▶ signed_in  (Member, Team Admin)
//                         │ ──code_verified{set_pin}──▶ set_pin ──signed_in──▶ signed_in
//                         │ ──code_verified{step_up, ok}──▶ enter_pin ──signed_in──▶ signed_in
//                         │ ──code_verified{step_up, locked}──▶ pin_locked
//                         enter_pin ──pin_locked | pin_reset_needed──▶ pin_locked
//   any step ──attempt_expired | wrong_step | pin_already_set──▶ phone (the number kept, the notice focused)
//   any step ──"Use a different number" / "Start again"──▶ phone (the number kept)
//
// The step lives here and in component state only: never in the URL, storage or history (R-44),
// so a reload starts again at the phone step. The attempt cookie carries the server's side. Which
// step follows the code is the server's answer alone; nothing reads a flag (WS-11), and a passkey
// in the step-up answer is ignored (OD-01, D46: dormant).
//
// Decisions are by the refusal's code, never its status, so a status the server moves changes
// nothing here. How each is shown (AUTH-DESIGN §10.2, auth-research-web §7):
// - a step change focuses the new step's h1; one with a reason (back to the phone step) focuses
//   the notice, which holds the reason;
// - an error on a field focuses that field, whose description carries it (aria-describedby), or,
//   when the field already has focus, is said assertively instead (sayIfFocused);
// - a refusal with no field (a wait, the server or the network unavailable) is shown in the notice
//   and said assertively, and focus stays where it is;
// - code_dead and code_expired disable the code field and focus "Send a new code", which they
//   enable at once and which carries the message;
// - statuses (a new code sent, the wait for one over, signed in) are said politely.
// Every outcome carries at most one cue, so every message is spoken exactly once.
import {
  type CodeSent,
  type ErrorExtras,
  formatE164,
  MESSAGES,
  normalisePhone,
  type OtpVerifyReply,
  type PinStateJSON,
  pinProblem,
} from '@hearth/shared'
import { SIGN_IN } from '@/strings/sign-in.ts'
import { normaliseCode, PIN_LENGTH } from '@/ui/code-field.ts'

// "Send a new code" waits this long after each request (SHL-07, AUTH-DESIGN §10.1).
export const RESEND_WAIT_MS = 30_000
// What the code step assumes when the answer names a length or a lifetime it can't use.
export const DEFAULT_CODE_LENGTH = 6
export const DEFAULT_CODE_SECONDS = 300
// A PIN locks for 15 minutes after its 5th wrong try (pin-lock.ts): fewer tries than this before a
// lock means earlier failures, so the enter step says how many are left before anything is typed.
export const TRIES_BEFORE_FIRST_LOCK = 5

export type PinOk = Extract<PinStateJSON, { state: 'ok' }>
// A timed lock ends at `until` (epoch ms; absent when the answer didn't say); only an Owner's reset
// ends the other kind.
export type Lock = { kind: 'timed'; until?: number } | { kind: 'reset' }

// "Send a new code": usable from `at`; until then held, with the reason as its description. `why`
// says whether the hold is the 30 s wait or the server's limit (a 429), which code_dead can't lift.
export interface Resend {
  readonly at: number
  readonly ready: boolean
  readonly why: 'wait' | 'limited'
  readonly reason: string
}

export type Step =
  | { readonly kind: 'phone' }
  | {
      readonly kind: 'code'
      readonly e164: string
      readonly codeLength: number
      readonly validMinutes: number
      readonly resend: Resend
      // The code can't be used any more (code_dead, code_expired): the message, which "Send a new
      // code" carries; the field is cleared and disabled until a new code is sent.
      readonly dead?: string
    }
  | { readonly kind: 'set_pin'; readonly e164: string }
  | { readonly kind: 'enter_pin'; readonly e164: string; readonly pin: PinOk }
  | { readonly kind: 'pin_locked'; readonly e164: string; readonly lock: Lock }
  | { readonly kind: 'signed_in' }

export type StepKind = Step['kind']
export type FieldName = 'phone' | 'code' | 'pin' | 'pin2'
export type CallKind = 'request_code' | 'verify_code' | 'set_pin' | 'enter_pin'

export type Call =
  | { readonly id: number; readonly kind: 'request_code'; readonly phone: string }
  | { readonly id: number; readonly kind: 'verify_code'; readonly code: string }
  | { readonly id: number; readonly kind: 'set_pin'; readonly pin: string }
  | { readonly id: number; readonly kind: 'enter_pin'; readonly pin: string }

export interface SignInState {
  readonly step: Step
  // What was typed. The number survives every return to the phone step (WCAG 3.3.7).
  readonly values: Readonly<Record<FieldName, string>>
  // The PIN fields show digits instead of dots.
  readonly showPin: boolean
  // An error shown on one field.
  readonly error?: { readonly field: FieldName; readonly text: string }
  // A message for the step as a whole: why it came back to the phone step, or a refusal with no
  // field.
  readonly notice?: string
  // The step's submit held by a 429 until `until` (epoch ms), with the reason as its description.
  readonly hold?: { readonly until: number; readonly reason: string }
  // The call in flight; an answer to any other is stale and changes nothing.
  readonly pending?: { readonly id: number; readonly kind: CallKind; readonly e164?: string }
  readonly nextId: number
  // Why the last document left (the status line under the first phone step's h1), until the
  // person moves on.
  readonly left?: string
}

// A refusal as the screen reads it (api/http.ts ApiFailure, or a failure of the client's own).
export interface Failure {
  readonly code: string
  readonly message: string
  readonly extra: Readonly<ErrorExtras>
}

export type Answer =
  | { readonly kind: 'code_sent'; readonly reply: CodeSent }
  | { readonly kind: 'verified'; readonly reply: OtpVerifyReply }
  | { readonly kind: 'signed_in' }

export type SignInEvent =
  | { readonly kind: 'input'; readonly field: FieldName; readonly value: string }
  | { readonly kind: 'show_pin'; readonly shown: boolean }
  | { readonly kind: 'submit'; readonly now: number }
  | { readonly kind: 'resend'; readonly now: number }
  | { readonly kind: 'start_again' }
  | { readonly kind: 'answer'; readonly id: number; readonly now: number; readonly answer: Answer }
  | { readonly kind: 'failed'; readonly id: number; readonly now: number; readonly failure: Failure }
  // A timer: the resend wait or a hold may have run out.
  | { readonly kind: 'tick'; readonly now: number }

export type FocusTarget = 'h1' | 'notice' | 'resend' | FieldName
export type Politeness = 'polite' | 'assertive'

// What the person should hear: focus moved to a target (its text selected, for a field to retype),
// or a message said through the app's announcer. sayIfFocused is the error to say assertively when
// the target already has focus, since focusing it again says nothing.
export type Cue =
  | { readonly focus: FocusTarget; readonly select?: boolean; readonly sayIfFocused?: string }
  | { readonly say: string; readonly politeness: Politeness }

export interface Outcome {
  readonly state: SignInState
  readonly call?: Call
  // Signed in: open the app (session/document.ts enterDocument).
  readonly enter?: true
  readonly cue?: Cue
}

const EMPTY_VALUES: Readonly<Record<FieldName, string>> = { phone: '', code: '', pin: '', pin2: '' }

export function initialState(left?: string): SignInState {
  return { step: { kind: 'phone' }, values: EMPTY_VALUES, showPin: false, nextId: 1, left }
}

// When a timer should next look at the state (epoch ms): the hold's end, or when "Send a new code"
// may be used; undefined when nothing waits.
export function nextDeadline(state: SignInState): number | undefined {
  const times: number[] = []
  if (state.hold !== undefined) times.push(state.hold.until)
  if (state.step.kind === 'code' && !state.step.resend.ready) times.push(state.step.resend.at)
  return times.length === 0 ? undefined : Math.min(...times)
}

// The code step's copy: the same template for any number, registered or not (PRD-53), with the
// number as the server read it.
export function codeStepText(e164: string, codeLength: number, validMinutes: number): string {
  return SIGN_IN.codeIntro(formatE164(e164), codeLength, validMinutes)
}

// What the code answer allows: a length of 4 to 10 digits, else 6; a lifetime in whole minutes,
// at least 1, else 5.
function codeShape(reply: CodeSent): { codeLength: number; validMinutes: number } {
  const length = reply.codeLength
  const seconds = reply.expiresInSeconds > 0 ? reply.expiresInSeconds : DEFAULT_CODE_SECONDS
  return {
    codeLength: length >= 4 && length <= 10 ? length : DEFAULT_CODE_LENGTH,
    validMinutes: Math.max(1, Math.round(seconds / 60)),
  }
}

const waitingResend = (now: number): Resend => ({
  at: now + RESEND_WAIT_MS,
  ready: false,
  why: 'wait',
  reason: SIGN_IN.resendWait,
})

function lockOf(pin: PinStateJSON | undefined): Lock {
  if (pin?.state === 'admin_locked') return { kind: 'reset' }
  if (pin?.state === 'locked') {
    const until = Date.parse(pin.until)
    return Number.isFinite(until) ? { kind: 'timed', until } : { kind: 'timed' }
  }
  return { kind: 'timed' }
}

// The tries line under the PIN (T14 item 9): before the next 15-minute lock, or, when the next lock
// is the one only an Owner's reset ends, before that.
export function pinTriesText(pin: PinOk): string {
  const untilReset = pin.triesBeforeAdminLock <= pin.triesBeforeLock
  return SIGN_IN.pinTries(untilReset ? pin.triesBeforeAdminLock : pin.triesBeforeLock, untilReset)
}

// Whether the enter step shows the tries line before anything is typed: only after earlier
// failures.
export const showsTriesFirst = (pin: PinOk) => pin.triesBeforeLock < TRIES_BEFORE_FIRST_LOCK

const e164Of = (step: Step): string =>
  step.kind === 'code' || step.kind === 'set_pin' || step.kind === 'enter_pin' || step.kind === 'pin_locked'
    ? step.e164
    : ''

// Back to the phone step, the number kept and everything else cleared.
function toPhone(state: SignInState, notice?: string): SignInState {
  return {
    step: { kind: 'phone' },
    values: { ...EMPTY_VALUES, phone: state.values.phone },
    showPin: false,
    nextId: state.nextId,
    notice,
  }
}

// A step reached forward: values but the number cleared, nothing pending, h1 focused.
function forward(state: SignInState, step: Step): Outcome {
  return {
    state: {
      step,
      values: { ...EMPTY_VALUES, phone: state.values.phone },
      showPin: false,
      nextId: state.nextId,
    },
    cue: { focus: 'h1' },
  }
}

function fieldError(state: SignInState, field: FieldName, text: string, select = false): Outcome {
  return {
    state: { ...state, error: { field, text }, notice: undefined },
    cue: { focus: field, select, sayIfFocused: text },
  }
}

function start(state: SignInState, call: Call, e164?: string): Outcome {
  return {
    state: {
      ...state,
      error: undefined,
      notice: undefined,
      pending: { id: call.id, kind: call.kind, e164 },
      nextId: state.nextId + 1,
    },
    call,
  }
}

function submit(state: SignInState, now: number): Outcome {
  if (state.pending !== undefined) return { state }
  let current = state
  if (current.hold !== undefined) {
    if (now < current.hold.until) return { state }
    current = { ...current, hold: undefined }
  }
  const id = current.nextId
  const { step, values } = current
  switch (step.kind) {
    case 'phone': {
      const e164 = normalisePhone(values.phone)
      if (e164 === undefined) return fieldError(current, 'phone', MESSAGES.invalid_phone)
      return start(current, { id, kind: 'request_code', phone: e164 }, e164)
    }
    case 'code': {
      if (step.dead !== undefined) return { state }
      const code = normaliseCode(values.code, step.codeLength)
      if (code.length !== step.codeLength) return fieldError(current, 'code', SIGN_IN.enterCode(step.codeLength))
      return start(current, { id, kind: 'verify_code', code })
    }
    case 'set_pin': {
      const problem = pinProblem(values.pin)
      if (problem === 'format') return fieldError(current, 'pin', MESSAGES.invalid_pin)
      if (problem === 'too_easy') return fieldError(current, 'pin', MESSAGES.pin_too_easy, true)
      if (values.pin2 === '') return fieldError(current, 'pin2', SIGN_IN.pinAgainMissing)
      if (values.pin2 !== values.pin) return fieldError(current, 'pin2', SIGN_IN.pinMismatch, true)
      return start(current, { id, kind: 'set_pin', pin: values.pin })
    }
    case 'enter_pin': {
      if (values.pin.length !== PIN_LENGTH) return fieldError(current, 'pin', MESSAGES.invalid_pin)
      return start(current, { id, kind: 'enter_pin', pin: values.pin })
    }
    default:
      return { state }
  }
}

function resend(state: SignInState, now: number): Outcome {
  const { step } = state
  if (step.kind !== 'code' || state.pending !== undefined) return { state }
  if (!step.resend.ready && now < step.resend.at) return { state }
  return start(state, { id: state.nextId, kind: 'request_code', phone: step.e164 }, step.e164)
}

function answered(state: SignInState, answer: Answer, now: number): Outcome {
  const pending = state.pending
  const settled: SignInState = { ...state, pending: undefined }
  if (answer.kind === 'code_sent') {
    const shape = codeShape(answer.reply)
    if (settled.step.kind === 'code') {
      // A new code for the same number: the old one no longer works (T14 item 4).
      return {
        state: {
          ...settled,
          step: { ...settled.step, ...shape, resend: waitingResend(now), dead: undefined },
          values: { ...settled.values, code: '' },
          error: undefined,
          notice: undefined,
        },
        cue: { say: SIGN_IN.newCode, politeness: 'polite' },
      }
    }
    const e164 = pending?.e164 ?? normalisePhone(settled.values.phone) ?? ''
    return forward(settled, { kind: 'code', e164, ...shape, resend: waitingResend(now) })
  }
  if (answer.kind === 'signed_in' || answer.reply.status === 'signed_in') return signedIn(settled)
  const e164 = e164Of(settled.step)
  const reply = answer.reply
  if (reply.next === 'set_pin') return forward(settled, { kind: 'set_pin', e164 })
  if (reply.pin.state === 'ok') return forward(settled, { kind: 'enter_pin', e164, pin: reply.pin })
  return forward(settled, { kind: 'pin_locked', e164, lock: lockOf(reply.pin) })
}

function signedIn(state: SignInState): Outcome {
  return {
    state: { step: { kind: 'signed_in' }, values: EMPTY_VALUES, showPin: false, nextId: state.nextId },
    enter: true,
    cue: { say: SIGN_IN.signedIn, politeness: 'polite' },
  }
}

// A refusal with no field: the notice, said assertively; focus stays.
const noticed = (state: SignInState, text: string): Outcome => ({
  state: { ...state, notice: text, error: undefined },
  cue: { say: text, politeness: 'assertive' },
})

function failed(state: SignInState, failure: Failure, now: number): Outcome {
  const kind = state.pending?.kind
  const settled: SignInState = { ...state, pending: undefined }
  const { step } = settled
  const { code, message, extra } = failure

  switch (code) {
    // The attempt is gone or elsewhere: start again from the number, kept (T14 item 3).
    case 'attempt_expired':
    case 'wrong_step':
    case 'pin_already_set':
      return { state: toPhone(settled, message), cue: { focus: 'notice' } }

    case 'too_many_requests': {
      const seconds = extra.retryAfterSeconds
      if (seconds === undefined) return noticed(settled, message)
      const text = SIGN_IN.tooMany(SIGN_IN.wait(seconds))
      const until = now + seconds * 1000
      if (kind === 'request_code' && step.kind === 'code') {
        const resend: Resend = { at: until, ready: false, why: 'limited', reason: text }
        return noticed({ ...settled, step: { ...step, resend } }, text)
      }
      return noticed({ ...settled, hold: { until, reason: text } }, text)
    }

    case 'invalid_phone':
      if (step.kind === 'phone') return fieldError(settled, 'phone', message)
      break

    case 'invalid_code':
      if (step.kind === 'code') return fieldError(settled, 'code', message, true)
      break

    case 'code_wrong':
      if (step.kind === 'code') {
        const left = extra.triesLeft
        return fieldError(settled, 'code', left === undefined ? message : `${message} ${SIGN_IN.triesLeft(left)}`, true)
      }
      break

    case 'code_dead':
    case 'code_expired':
      if (step.kind === 'code') {
        const held = step.resend.why === 'limited' && now < step.resend.at
        const resend: Resend = held ? step.resend : { ...step.resend, ready: true }
        return {
          state: {
            ...settled,
            step: { ...step, resend, dead: message },
            values: { ...settled.values, code: '' },
            error: undefined,
            notice: undefined,
          },
          cue: { focus: 'resend' },
        }
      }
      break

    case 'invalid_pin':
    case 'pin_too_easy':
      if (step.kind === 'set_pin' || step.kind === 'enter_pin') return fieldError(settled, 'pin', message, true)
      break

    case 'pin_wrong':
      if (step.kind === 'enter_pin') {
        const pin = extra.pin?.state === 'ok' ? extra.pin : undefined
        const next = pin === undefined ? settled : { ...settled, step: { ...step, pin } }
        return fieldError(next, 'pin', pin === undefined ? message : `${message} ${pinTriesText(pin)}`, true)
      }
      break

    case 'pin_locked':
      if (step.kind === 'enter_pin')
        return forward(settled, { kind: 'pin_locked', e164: step.e164, lock: lockOf(extra.pin) })
      break

    case 'pin_reset_needed':
      if (step.kind === 'enter_pin' || step.kind === 'set_pin')
        return forward(settled, { kind: 'pin_locked', e164: step.e164, lock: { kind: 'reset' } })
      break
  }
  // Anything else (unavailable, a second try_again, the network, a reply that didn't read, a code
  // this build doesn't know): the server's words, or the client's, in the notice. What was typed
  // stays, so pressing the button again needs no new text; a 503 at the code gave the try back.
  return noticed(settled, message)
}

function tick(state: SignInState, now: number): Outcome {
  let next = state
  let cue: Cue | undefined
  if (next.hold !== undefined && now >= next.hold.until) {
    next = { ...next, hold: undefined, notice: next.notice === next.hold.reason ? undefined : next.notice }
  }
  const { step } = next
  if (step.kind === 'code' && !step.resend.ready && now >= step.resend.at) {
    const notice = step.resend.why === 'limited' && next.notice === step.resend.reason ? undefined : next.notice
    next = { ...next, step: { ...step, resend: { ...step.resend, ready: true } }, notice }
    cue = { say: SIGN_IN.resendReady, politeness: 'polite' }
  }
  return cue === undefined ? { state: next } : { state: next, cue }
}

export function transition(state: SignInState, event: SignInEvent): Outcome {
  switch (event.kind) {
    case 'input': {
      const { step } = state
      if (event.field === 'code' && step.kind === 'code' && step.dead !== undefined) return { state }
      const value =
        event.field === 'phone'
          ? event.value
          : normaliseCode(event.value, event.field === 'code' && step.kind === 'code' ? step.codeLength : PIN_LENGTH)
      if (state.values[event.field] === value) return { state }
      const values = { ...state.values, [event.field]: value }
      // A wait the server set on the phone step was most likely the number's own (three requests in
      // ten minutes), so another number may go at once; the server still decides, and a request it
      // refuses costs nothing.
      if (event.field === 'phone' && step.kind === 'phone' && state.hold !== undefined) {
        const notice = state.notice === state.hold.reason ? undefined : state.notice
        return { state: { ...state, values, hold: undefined, notice } }
      }
      return { state: { ...state, values } }
    }
    case 'show_pin':
      return state.showPin === event.shown ? { state } : { state: { ...state, showPin: event.shown } }
    case 'submit':
      return submit(state, event.now)
    case 'resend':
      return resend(state, event.now)
    case 'start_again':
      if (state.step.kind === 'signed_in') return { state }
      return { state: toPhone(state), cue: { focus: 'h1' } }
    case 'answer':
      if (state.pending?.id !== event.id) return { state }
      return answered(state, event.answer, event.now)
    case 'failed':
      if (state.pending?.id !== event.id) return { state }
      return failed(state, event.failure, event.now)
    case 'tick':
      return tick(state, event.now)
  }
}

// What the step's submit says while it can't act: the call in flight, a 429's wait, or a code that
// can no longer be used. undefined when it can.
export function submitHeld(state: SignInState): string | undefined {
  if (state.pending !== undefined) return busyText(state)
  if (state.hold !== undefined) return state.hold.reason
  if (state.step.kind === 'code' && state.step.dead !== undefined) return state.step.dead
  return undefined
}

// What "Send a new code" says while it can't act.
export function resendHeld(state: SignInState): string | undefined {
  if (state.step.kind !== 'code') return undefined
  if (state.pending !== undefined) return busyText(state)
  return state.step.resend.ready ? undefined : state.step.resend.reason
}

// The busy text for the call in flight: sending a code, or checking one or a PIN.
export function busyText(state: SignInState): string | undefined {
  if (state.pending === undefined) return undefined
  return state.pending.kind === 'request_code' ? SIGN_IN.busy.sending : SIGN_IN.busy.checking
}
