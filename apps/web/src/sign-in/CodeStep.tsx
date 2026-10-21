// The second step: the texted code (T20, T21 item 13; PRD-53, SHL-07, X11). Its words are the same
// for any number: they never say a text was sent, only that one will come if the number is
// registered, and for how long the code works. The number is shown as the server read it, so a bare
// 8-digit number shows its +65.
//
// One code field (ui/CodeField.tsx) and "Sign in". Below them:
// - "Send a new code", held for 30 s after each request with the reason as its description, and
//   said once when it can be used (the model's tick); no countdown every second (X11). A code that
//   can no longer be used (code_dead, code_expired) clears and disables the field and enables it at
//   once, with the message above it as its description, and focus moves to it.
// - "Use a different number": back to the phone step with the number kept. While the code is being
//   checked, or a new code requested, it is held, with the busy text as its reason (startAgainHeld):
//   a check's answer may sign the person in, and a request's sets the attempt cookie.
// Once "Send a new code" has its answer, a note at the top of the form says a new code is on its way
// and earlier ones no longer work. It has no live role: the model's cue says it once.
import { CircleAlert, LoaderCircle, MessageSquareText } from 'lucide-react'
import { useId } from 'react'
import { SIGN_IN } from '@/strings/sign-in.ts'
import { Button } from '@/ui/Button.tsx'
import { CodeField } from '@/ui/CodeField.tsx'
import type { StepProps } from './PhoneStep.tsx'
import { errorOn, Notice, StepForm, StepFrame, SubmitButton } from './StepFrame.tsx'
import { codeStepText, resendHeld, type Step, startAgainHeld, submitHeld } from './sign-in-model.ts'

export function CodeStep({ state, step, controller, refs }: StepProps & { step: Extract<Step, { kind: 'code' }> }) {
  const deadId = useId()
  const resending = state.pending?.kind === 'request_code'
  return (
    <StepFrame
      title={SIGN_IN.steps.code}
      h1={refs.h1}
      intro={<p className="text-muted">{codeStepText(step.e164, step.codeLength, step.validMinutes)}</p>}
    >
      <StepForm onSubmit={controller.submit}>
        {state.notice !== undefined && <Notice text={state.notice} ref={refs.notice} />}
        {step.resent && (
          <p className="flex items-start gap-2 rounded-xl border border-accent/30 bg-accent-soft px-4 py-3 text-fg">
            <MessageSquareText aria-hidden size={18} className="mt-0.5 shrink-0" />
            <span>{SIGN_IN.newCode}</span>
          </p>
        )}
        <CodeField
          ref={refs.code}
          label={SIGN_IN.codeLabel(step.codeLength)}
          length={step.codeLength}
          value={state.values.code}
          error={errorOn(state, 'code')}
          disabled={step.dead !== undefined}
          onChange={value => controller.input('code', value)}
        />
        <SubmitButton label={SIGN_IN.signIn} held={submitHeld(state)} busy={state.pending?.kind === 'verify_code'} />
      </StepForm>
      <div className="flex flex-col gap-2">
        {step.dead !== undefined && (
          <p id={deadId} className="flex items-start gap-1.5 text-small text-rec">
            <CircleAlert aria-hidden size={16} className="mt-px shrink-0" />
            <span>{step.dead}</span>
          </p>
        )}
        <Button
          ref={refs.resend}
          className="w-full"
          disabledReason={resendHeld(state)}
          aria-describedby={step.dead === undefined ? undefined : deadId}
          onClick={controller.resend}
        >
          {resending && <LoaderCircle aria-hidden size={16} className="shrink-0 animate-spin" />}
          {SIGN_IN.resend}
        </Button>
        <Button
          variant="ghost"
          className="w-full"
          disabledReason={startAgainHeld(state)}
          onClick={controller.startAgain}
        >
          {SIGN_IN.differentNumber}
        </Button>
      </div>
    </StepFrame>
  )
}
