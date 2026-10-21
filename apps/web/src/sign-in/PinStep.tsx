// The PIN steps, for holders of the roles only an Owner grants (T20, T21; D46, AQ-02, ACC-02,
// ACC-06, T14 items 8, 9 and 12; T21 item 13). Everyone else
// signs in on the code alone and never sees them. There is no passkey here, whatever the answer
// says (OD-01: dormant).
// - SetPinStep, "Choose a PIN": the new PIN twice. The browser checks it with the server's own rule
//   (pinProblem, packages/shared: 6 digits, not one digit six times, not a run, not a common PIN)
//   before anything is sent, and that the two match; the server checks again.
// - EnterPinStep, "Enter your PIN": after earlier failures it says how many tries are left before
//   anything is typed; a wrong PIN says it again with the field's error.
// - PinLockedStep, "Your PIN is locked": the form is gone, so nobody retries a step that can't
//   succeed. A timed lock says when it ends (in this browser's zone: before sign-in there is no
//   profile), and that a new code is needed then, since the attempt (10 minutes) ends before the lock
//   (15). A lock only an Owner can end says so. Either way the one way on is "Start again".
// "Start again" is held while the PIN is being checked, with the busy text as its reason
// (startAgainHeld): the answer may sign the person in.
// Both forms carry the number the code went to as a hidden username, so a password manager files
// the PIN under it (ui/PinField.tsx), and their fields allow paste and autofill (WCAG 3.3.8).
import { formattersFor } from '@/lib/time.ts'
import { SIGN_IN } from '@/strings/sign-in.ts'
import { Button } from '@/ui/Button.tsx'
import { PinField, PinUsername, ShowPin } from '@/ui/PinField.tsx'
import type { StepProps } from './PhoneStep.tsx'
import { errorOn, Notice, StepForm, StepFrame, SubmitButton } from './StepFrame.tsx'
import { type Lock, pinTriesText, type Step, showsTriesFirst, startAgainHeld, submitHeld } from './sign-in-model.ts'

type StepOf<K extends Step['kind']> = Extract<Step, { kind: K }>

// held: why it can't act now (startAgainHeld), or undefined when it can.
function StartAgain({ onPress, held, primary = false }: { onPress(): void; held?: string; primary?: boolean }) {
  return (
    <Button
      variant={primary ? 'primary' : 'ghost'}
      size={primary ? 'lg' : 'md'}
      className="w-full"
      disabledReason={held}
      onClick={() => onPress()}
    >
      {SIGN_IN.startAgain}
    </Button>
  )
}

export function SetPinStep({ state, step, controller, refs }: StepProps & { step: StepOf<'set_pin'> }) {
  return (
    <StepFrame title={SIGN_IN.steps.set_pin} h1={refs.h1} intro={<p className="text-muted">{SIGN_IN.setPinWhy}</p>}>
      <StepForm onSubmit={controller.submit}>
        {state.notice !== undefined && <Notice text={state.notice} ref={refs.notice} />}
        <PinUsername number={step.e164} />
        <PinField
          ref={refs.pin}
          label={SIGN_IN.newPin}
          hint={SIGN_IN.newPinHint}
          error={errorOn(state, 'pin')}
          value={state.values.pin}
          onChange={value => controller.input('pin', value)}
          autoComplete="new-password"
          name="new-pin"
          shown={state.showPin}
          enterKeyHint="next"
        />
        <PinField
          ref={refs.pin2}
          label={SIGN_IN.newPinAgain}
          error={errorOn(state, 'pin2')}
          value={state.values.pin2}
          onChange={value => controller.input('pin2', value)}
          autoComplete="new-password"
          name="confirm-pin"
          shown={state.showPin}
          enterKeyHint="done"
        />
        <ShowPin shown={state.showPin} onChange={controller.showPin} />
        <p className="text-small text-muted">{SIGN_IN.ifForgotten}</p>
        <SubmitButton label={SIGN_IN.setPin} held={submitHeld(state)} busy={state.pending !== undefined} />
      </StepForm>
      <StartAgain onPress={controller.startAgain} held={startAgainHeld(state)} />
    </StepFrame>
  )
}

export function EnterPinStep({ state, step, controller, refs }: StepProps & { step: StepOf<'enter_pin'> }) {
  const error = errorOn(state, 'pin')
  return (
    <StepFrame title={SIGN_IN.steps.enter_pin} h1={refs.h1} intro={<p className="text-muted">{SIGN_IN.enterPinWhy}</p>}>
      <StepForm onSubmit={controller.submit}>
        {state.notice !== undefined && <Notice text={state.notice} ref={refs.notice} />}
        <PinUsername number={step.e164} />
        <PinField
          ref={refs.pin}
          label={SIGN_IN.pinLabel}
          hint={error === undefined && showsTriesFirst(step.pin) ? pinTriesText(step.pin) : undefined}
          error={error}
          value={state.values.pin}
          onChange={value => controller.input('pin', value)}
          autoComplete="current-password"
          name="pin"
          shown={state.showPin}
          enterKeyHint="go"
        />
        <ShowPin shown={state.showPin} onChange={controller.showPin} />
        <SubmitButton label={SIGN_IN.signIn} held={submitHeld(state)} busy={state.pending !== undefined} />
      </StepForm>
      {/* The summary keeps its display: list-item, which is what draws its disclosure marker, the
          one sign it opens; padding, not flex, brings its text to the middle of its 44 px. */}
      <details className="rounded-xl">
        <summary className="min-h-11 cursor-pointer py-2.5 font-medium">{SIGN_IN.forgotPin}</summary>
        <p className="text-muted">{SIGN_IN.forgotPinBody}</p>
      </details>
      <StartAgain onPress={controller.startAgain} held={startAgainHeld(state)} />
    </StepFrame>
  )
}

// The zone this browser is in, for the lock's end: nobody is signed in yet, so there is no profile
// zone (OD-10); formattersFor falls back to Singapore's for a zone it doesn't know.
const browserZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

export function lockText(lock: Lock, zone: string = browserZone()): { body: string; after: string | undefined } {
  if (lock.kind === 'reset') return { body: SIGN_IN.lockedReset, after: undefined }
  const after =
    lock.until === undefined ? SIGN_IN.lockEndsUnknown : SIGN_IN.lockEnds(formattersFor(zone).time(lock.until))
  return { body: SIGN_IN.lockedTimed, after }
}

export function PinLockedStep({ step, controller, refs }: StepProps & { step: StepOf<'pin_locked'> }) {
  const text = lockText(step.lock)
  return (
    <StepFrame
      title={SIGN_IN.steps.pin_locked}
      h1={refs.h1}
      intro={
        <>
          <p>{text.body}</p>
          {text.after !== undefined && <p className="text-muted">{text.after}</p>}
        </>
      }
    >
      <StartAgain onPress={controller.startAgain} primary />
    </StepFrame>
  )
}
