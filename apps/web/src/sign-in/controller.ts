// The sign-in screen's store (T20; T21 item 13): it holds the state
// sign-in-model.ts computes, makes the calls the model asks for (sign-in/api.ts), and runs the two
// kinds of timer the screen needs, all through injected dependencies, so Node tests drive it with a
// fake clock and a fake api:
// - the deadline timer: when "Send a new code" may be used again (30 s after each request, or a
//   429's wait) or a held submit may act, it sends the model a tick, which says once, politely, that
//   a new code can be had;
// - the busy timer: a call still in flight after a second says "Sending…" or "Checking…" politely,
//   once (WCAG 4.1.3), since a wrong code takes at least 2 s (the server's floor).
// Cues (a focus move or a message to say) go to the screen, which owns the elements and the
// announcer. A signed-in answer calls enter(), which opens the app in a new document (D-01).
//
// The screen subscribes with useSyncExternalStore, starts the timers when it mounts and stops them
// when it unmounts; a call's answer that arrives after that changes only this store.
import { MESSAGES } from '@hearth/shared'
import { ApiFailure } from '@/api/http.ts'
import type { SignInApi } from './api.ts'
import {
  type Answer,
  busyText,
  type Call,
  type Cue,
  type Failure,
  type FieldName,
  initialState,
  nextDeadline,
  type SignInEvent,
  type SignInState,
  transition,
} from './sign-in-model.ts'

// A call still in flight this long is said to be busy.
export const BUSY_SAY_MS = 1_000
// A deadline's timer fires this long after it, so the tick finds it passed.
const TIMER_SLACK_MS = 50

export interface ControllerDeps {
  readonly api: SignInApi
  now(): number
  setTimeout(task: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  // A focus move or a message to say (sign-in-model.ts Cue).
  cue(cue: Cue): void
  // Signed in: open the app.
  enter(): void
}

export interface SignInController {
  snapshot(): SignInState
  subscribe(listener: () => void): () => void
  input(field: FieldName, value: string): void
  showPin(shown: boolean): void
  submit(): void
  resend(): void
  startAgain(): void
  // Arms the timers (the screen mounted); stop() clears them (it unmounted).
  start(): void
  stop(): void
}

// A refusal as the model reads it: the api's code, message and extras, or the generic copy for
// anything that isn't an ApiFailure (a bug, never a server answer).
export function failureOf(error: unknown): Failure {
  if (error instanceof ApiFailure) return { code: error.code, message: error.serverMessage, extra: error.extra }
  return { code: 'internal', message: MESSAGES.internal, extra: {} }
}

export function createSignInController(deps: ControllerDeps, left?: string): SignInController {
  let state = initialState(left)
  const listeners = new Set<() => void>()
  let running = false
  let deadline: { at: number; handle: unknown } | undefined
  let busy: unknown

  const clearDeadline = () => {
    if (deadline !== undefined) deps.clearTimeout(deadline.handle)
    deadline = undefined
  }

  // Keeps one timer armed for the state's next deadline, re-arming when it moves or when a tick
  // found it not yet passed.
  const rearm = () => {
    const at = running ? nextDeadline(state) : undefined
    if (deadline !== undefined && deadline.at === at) return
    clearDeadline()
    if (at === undefined) return
    const handle = deps.setTimeout(
      () => {
        deadline = undefined
        dispatch({ kind: 'tick', now: deps.now() })
        rearm()
      },
      Math.max(0, at - deps.now()) + TIMER_SLACK_MS,
    )
    deadline = { at, handle }
  }

  const sayBusyLater = (id: number) => {
    if (busy !== undefined) deps.clearTimeout(busy)
    busy = deps.setTimeout(() => {
      busy = undefined
      const text = busyText(state)
      if (state.pending?.id === id && text !== undefined) deps.cue({ say: text, politeness: 'polite' })
    }, BUSY_SAY_MS)
  }

  const run = (call: Call) => {
    const answer: Promise<Answer> =
      call.kind === 'request_code'
        ? deps.api.requestCode(call.phone).then(reply => ({ kind: 'code_sent', reply }))
        : call.kind === 'verify_code'
          ? deps.api.verifyCode(call.code).then(reply => ({ kind: 'verified', reply }))
          : (call.kind === 'set_pin' ? deps.api.setPin(call.pin) : deps.api.enterPin(call.pin)).then(() => ({
              kind: 'signed_in',
            }))
    answer.then(
      answered => dispatch({ kind: 'answer', id: call.id, now: deps.now(), answer: answered }),
      (error: unknown) => dispatch({ kind: 'failed', id: call.id, now: deps.now(), failure: failureOf(error) }),
    )
    sayBusyLater(call.id)
  }

  function dispatch(event: SignInEvent): void {
    const outcome = transition(state, event)
    if (outcome.state !== state) {
      state = outcome.state
      for (const listener of [...listeners]) listener()
    }
    if (outcome.cue !== undefined) deps.cue(outcome.cue)
    if (outcome.call !== undefined) run(outcome.call)
    if (outcome.enter) deps.enter()
    rearm()
  }

  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    input: (field, value) => dispatch({ kind: 'input', field, value }),
    showPin: shown => dispatch({ kind: 'show_pin', shown }),
    submit: () => dispatch({ kind: 'submit', now: deps.now() }),
    resend: () => dispatch({ kind: 'resend', now: deps.now() }),
    startAgain: () => dispatch({ kind: 'start_again' }),
    start() {
      running = true
      // A deadline that passed while stopped is caught up at once.
      dispatch({ kind: 'tick', now: deps.now() })
    },
    stop() {
      running = false
      clearDeadline()
      if (busy !== undefined) deps.clearTimeout(busy)
      busy = undefined
    },
  }
}
