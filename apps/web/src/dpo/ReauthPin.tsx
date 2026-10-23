// The PIN step on the DPO pages (C0.9 PD-26, PD-30; T20 item 6, D46), inline until C0.16's
// re-authentication sheet. A read or a write refused with 403 reauth_required {method: 'pin'} shows
// it where the refusal is: on the page for a read, in the dialog for a write. The PIN goes to POST
// /api/auth/reauth/pin; once it is confirmed, the caller makes the refused call again, once. The
// form being edited stays as it was, in component state (never storage, WS-01), and the PIN is
// held only by this step, never by Query's cache (pinStepOptions).
//
// The field is the kit's PinField: current-password, so a password manager can fill it, and paste
// is never blocked (WCAG 3.3.8, WS-13). It takes focus when the step appears. A wrong PIN, a lock
// or a limit is said on the field, in the server's words, and announced, since the field already
// has focus. A session that re-authenticates some other way can only sign in again (pinOutcomeOf).
import { REAUTH_METHOD_MESSAGES } from '@hearth/shared'
import { useMutation } from '@tanstack/react-query'
import { LoaderCircle } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { DPO } from '@/strings/dpo.ts'
import { announce } from '@/ui/announce.ts'
import { Button } from '@/ui/Button.tsx'
import { PinField, ShowPin } from '@/ui/PinField.tsx'
import { failureOf, pinEntryProblem, pinOutcomeOf } from './model.ts'
import { pinStepOptions } from './queries.ts'
import { SignOutNotice } from './SignOutNotice.tsx'

export interface ReauthPinProps {
  // The PIN was confirmed: make the refused call again.
  onConfirmed(): void
}

export function ReauthPin({ onConfirmed }: ReauthPinProps) {
  const [pin, setPin] = useState('')
  const [shown, setShown] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [signIn, setSignIn] = useState<string | undefined>()
  const field = useRef<HTMLInputElement>(null)
  const titleId = useId()
  // The PIN being sent, for the mutation to read on each try; emptied once the step settles.
  const entered = useRef('')
  const confirm = useMutation(pinStepOptions(entered))

  useEffect(() => {
    field.current?.focus()
  }, [])

  const fail = (text: string) => {
    setError(text)
    announce(text, 'assertive')
    field.current?.focus()
  }

  const submit = () => {
    if (confirm.isPending) return
    const problem = pinEntryProblem(pin)
    if (problem !== undefined) return fail(problem)
    entered.current = pin
    confirm.mutate(undefined, {
      onSuccess: () => {
        setPin('')
        setError(undefined)
        onConfirmed()
      },
      onError: error => {
        setPin('')
        const outcome = pinOutcomeOf(failureOf(error))
        if (outcome.kind === 'sign_in') setSignIn(outcome.text)
        else fail(outcome.text)
      },
    })
  }

  if (signIn !== undefined) return <SignOutNotice text={signIn} />

  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-4 sm:p-5"
    >
      <p id={titleId} className="font-medium">
        {REAUTH_METHOD_MESSAGES.pin.method}
      </p>
      <form
        method="post"
        noValidate
        onSubmit={event => {
          event.preventDefault()
          submit()
        }}
        className="flex flex-col gap-4"
      >
        <PinField
          ref={field}
          label={DPO.reauth.pinLabel}
          error={error}
          value={pin}
          onChange={value => {
            setPin(value)
            if (error !== undefined) setError(undefined)
          }}
          autoComplete="current-password"
          name="pin"
          shown={shown}
          enterKeyHint="go"
        />
        <ShowPin shown={shown} onChange={setShown} />
        <Button
          type="submit"
          variant="primary"
          className="self-start"
          disabledReason={confirm.isPending ? DPO.reauth.confirming : undefined}
        >
          {confirm.isPending && <LoaderCircle aria-hidden size={16} className="shrink-0 animate-spin" />}
          {DPO.reauth.confirm}
        </Button>
      </form>
    </section>
  )
}
