// The first step: the mobile number (T20, T21 item 13; OD-01, BUILD-PLAN C0.8). Any country's
// number (ACC-01): the hint says how, and the shared normaliser (normalisePhone, packages/shared)
// reads it here exactly as the server will, so a number it can't read is refused on the field
// before anything is sent. The field asks for the browser's own number autofill (autocomplete tel,
// WCAG 1.3.5) and the phone keypad; its text is 16 px, so iOS doesn't zoom in. Under the h1, once,
// the reason the last document left, if it did.
import { SIGN_IN } from '@/strings/sign-in.ts'
import { CONTROL_CLASS, Field } from '@/ui/Field.tsx'
import type { SignInController } from './controller.ts'
import { errorOn, Notice, type SignInRefs, StepForm, StepFrame, SubmitButton } from './StepFrame.tsx'
import { type SignInState, submitHeld } from './sign-in-model.ts'

export interface StepProps {
  state: SignInState
  controller: SignInController
  refs: SignInRefs
}

export function PhoneStep({ state, controller, refs }: StepProps) {
  return (
    <StepFrame
      title={SIGN_IN.steps.phone}
      h1={refs.h1}
      intro={
        state.left !== undefined && (
          <p role="status" className="text-muted">
            {state.left}
          </p>
        )
      }
    >
      <StepForm onSubmit={controller.submit}>
        {state.notice !== undefined && <Notice text={state.notice} ref={refs.notice} />}
        <Field label={SIGN_IN.phoneLabel} hint={SIGN_IN.phoneHint} error={errorOn(state, 'phone')}>
          {control => (
            <input
              {...control}
              ref={refs.phone}
              type="tel"
              name="phone"
              autoComplete="tel"
              inputMode="tel"
              enterKeyHint="send"
              value={state.values.phone}
              onChange={event => controller.input('phone', event.currentTarget.value)}
              className={CONTROL_CLASS}
            />
          )}
        </Field>
        <SubmitButton label={SIGN_IN.sendCode} held={submitHeld(state)} busy={state.pending !== undefined} />
      </StepForm>
    </StepFrame>
  )
}
