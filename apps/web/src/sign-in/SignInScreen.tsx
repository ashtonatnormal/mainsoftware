// The sign-in screen (T21 item 13, T20; D46, AQ-02, OD-01): the router's /sign-in route, the only
// screen a signed-out document shows. It sits outside the shell, in its own <main>; each step has
// its own h1 (StepFrame). On a phone the step's form sits low, in the thumb's reach (PRD-66); from
// the rail breakpoint it is a centred card.
//
// The steps: the number, the code, and for a holder of a PIN role setting or entering the PIN (or
// the locked view). Which follows the code is the server's answer alone. The logic is pure
// (sign-in-model.ts) and its store runs the calls and timers (controller.ts); this file holds the
// elements and turns the model's cues into focus and speech:
// - a step change focuses the new h1 (or the notice, when it carries the reason) and sets the
//   document's title (X6);
// - a field error focuses the field, or is said assertively when the field has focus already;
// - a status is said through the app's one announcer (X11), once React has committed and any focus
//   move has happened (lib/focus.ts afterCommit), so the focused element is read first.
// Signed in, the app opens in a new document (session/document.ts enterDocument, D-01): it tells the
// other tabs, and the new document's first route focuses its h1.
//
// When the last document left with a reason (session/document.ts, takeLeftReason), a line under the
// phone step's h1 says so: "You've signed out." after this tab's own Sign out, "You've been signed
// out." after anything else. The reason is read once, when the screen first renders, and said once,
// politely, after the first route has focused the h1 (the store's first start()); the line goes once
// the person moves on.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { afterCommit, type FocusTarget as FocusableElement, focusAfter } from '@/lib/focus.ts'
import { browserDocumentEnv, enterDocument, type LeftReason, takeLeftReason } from '@/session/document.ts'
import { documentTitle } from '@/strings/shell.ts'
import { SIGN_IN } from '@/strings/sign-in.ts'
import { announce } from '@/ui/announce.ts'
import { signInApi } from './api.ts'
import { CodeStep } from './CodeStep.tsx'
import { createSignInController, type SignInController } from './controller.ts'
import { PhoneStep } from './PhoneStep.tsx'
import { EnterPinStep, PinLockedStep, SetPinStep } from './PinStep.tsx'
import { createSignInRefs, type SignInRefs, StepFrame } from './StepFrame.tsx'
import type { Cue, SignInState, StepKind } from './sign-in-model.ts'

const leftText = (reason: LeftReason) => (reason === 'signed_out_here' ? SIGN_IN.signedOutHere : SIGN_IN.signedOut)

// The document's title for a step: its h1, or a shorter name where the h1 says more.
export const stepTitle = (kind: StepKind): string => (kind === 'phone' ? SIGN_IN.titles.phone : SIGN_IN.steps[kind])

// A field whose text is selected as it takes focus, so the next keys replace it.
function selecting(element: HTMLElement): FocusableElement {
  return {
    get isConnected() {
      return element.isConnected
    },
    getClientRects: () => element.getClientRects(),
    focus(options) {
      element.focus(options)
      if (element instanceof HTMLInputElement) element.select()
    },
  }
}

// Turns a cue into focus or speech (T21 item 13): one or the other, never both.
function applyCue(cue: Cue, refs: SignInRefs): void {
  if ('say' in cue) {
    afterCommit(() => announce(cue.say, cue.politeness))
    return
  }
  const target = () => refs[cue.focus].current
  const now = target()
  if (cue.sayIfFocused !== undefined && now !== null && now === document.activeElement) {
    if (cue.select && now instanceof HTMLInputElement) now.select()
    announce(cue.sayIfFocused, 'assertive')
    return
  }
  focusAfter(() => {
    const element = target()
    return element !== null && cue.select ? selecting(element) : element
  })
}

function createController(refs: SignInRefs): SignInController {
  const left = takeLeftReason()
  return createSignInController(
    {
      api: signInApi,
      now: () => Date.now(),
      setTimeout: (task, ms) => window.setTimeout(task, ms),
      clearTimeout: handle => window.clearTimeout(handle as number),
      cue: cue => applyCue(cue, refs),
      enter: () => enterDocument(browserDocumentEnv()),
    },
    left === undefined ? undefined : leftText(left),
  )
}

export function SignInScreen() {
  const [refs] = useState(createSignInRefs)
  const [controller] = useState(() => createController(refs))
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  const kind = state.step.kind

  useEffect(() => {
    controller.start()
    return () => controller.stop()
  }, [controller])

  useEffect(() => {
    document.title = documentTitle(stepTitle(kind))
  }, [kind])

  return (
    <main
      id="main"
      tabIndex={-1}
      className="flex min-h-dvh flex-col pt-safe pb-safe px-safe rail:items-center rail:justify-center"
    >
      <SignInStep key={kind} state={state} controller={controller} refs={refs} />
    </main>
  )
}

// The step the state is at.
export function SignInStep({
  state,
  controller,
  refs,
}: {
  state: SignInState
  controller: SignInController
  refs: SignInRefs
}) {
  const props = { state, controller, refs }
  const { step } = state
  switch (step.kind) {
    case 'phone':
      return <PhoneStep {...props} />
    case 'code':
      return <CodeStep {...props} step={step} />
    case 'set_pin':
      return <SetPinStep {...props} step={step} />
    case 'enter_pin':
      return <EnterPinStep {...props} step={step} />
    case 'pin_locked':
      return <PinLockedStep {...props} step={step} />
    case 'signed_in':
      return (
        <StepFrame
          title={SIGN_IN.steps.signed_in}
          h1={refs.h1}
          intro={<p className="text-muted">{SIGN_IN.signedIn}</p>}
        />
      )
  }
}
