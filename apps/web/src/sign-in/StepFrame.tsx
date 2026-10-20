// What every sign-in step shares (T21 item 13, T20; PRD-66, NFR-02):
// - StepFrame: the step's column inside the screen's <main>. On a phone the Hearth mark, the h1 and
//   the step's words sit at the top and the form at the bottom, in the thumb's reach (PRD-66); from
//   the rail breakpoint it is a centred card. One h1 per step, focusable and marked as the screen's
//   title, which a step change focuses (X6).
// - Notice: a message for the step as a whole, at the top of its form: why the step came back to
//   the number, or a refusal with no field (a wait, the server or network unavailable). It is
//   focusable, so a step change with a reason can move focus to it and have it read in full, and it
//   has no live role: the model says each message once, by focus or by the announcer, never both.
// - SubmitButton: the step's primary, full width and large, in a form whose Enter submits it. While
//   a call is in flight, a 429's wait runs or the code can't be used, it is aria-disabled with the
//   reason as its description (the kit's disabledReason), and a spinner shows while the call is out.
// - SignInRefs: the elements the model's cues name, so the screen can move focus to them.
import { CircleAlert, Flame, LoaderCircle } from 'lucide-react'
import { createRef, type ReactNode, type RefObject } from 'react'
import { Button } from '@/ui/Button.tsx'
import type { FieldName, FocusTarget, SignInState } from './sign-in-model.ts'

export interface SignInRefs extends Record<FocusTarget, RefObject<HTMLElement | null>> {
  readonly h1: RefObject<HTMLHeadingElement | null>
  readonly notice: RefObject<HTMLParagraphElement | null>
  readonly resend: RefObject<HTMLButtonElement | null>
  readonly phone: RefObject<HTMLInputElement | null>
  readonly code: RefObject<HTMLInputElement | null>
  readonly pin: RefObject<HTMLInputElement | null>
  readonly pin2: RefObject<HTMLInputElement | null>
}

export const createSignInRefs = (): SignInRefs => ({
  h1: createRef(),
  notice: createRef(),
  resend: createRef(),
  phone: createRef(),
  code: createRef(),
  pin: createRef(),
  pin2: createRef(),
})

// The error on one field, if it is that field's.
export const errorOn = (state: SignInState, field: FieldName): string | undefined =>
  state.error?.field === field ? state.error.text : undefined

export interface StepFrameProps {
  title: string
  h1: RefObject<HTMLHeadingElement | null>
  // The step's words under the h1.
  intro?: ReactNode
  children?: ReactNode
}

export function StepFrame({ title, h1, intro, children }: StepFrameProps) {
  return (
    <div className="flex w-full flex-1 flex-col gap-8 px-6 py-8 rail:max-w-md rail:flex-none rail:rounded-2xl rail:border rail:border-line rail:bg-surface rail:shadow-card">
      <div className="flex flex-col gap-3">
        <span aria-hidden className="grid size-12 place-items-center rounded-2xl bg-accent text-accent-fg">
          <Flame size={26} />
        </span>
        <h1 ref={h1} tabIndex={-1} data-screen-title className="break-words font-display text-2xl font-semibold">
          {title}
        </h1>
        {intro}
      </div>
      {children !== undefined && <div className="mt-auto flex flex-col gap-4">{children}</div>}
    </div>
  )
}

export function Notice({ text, ref }: { text: string; ref: RefObject<HTMLParagraphElement | null> }) {
  return (
    <p ref={ref} tabIndex={-1} className="flex items-start gap-2 rounded-xl bg-rec-soft p-3 text-rec">
      <CircleAlert aria-hidden size={18} className="mt-0.5 shrink-0" />
      <span>{text}</span>
    </p>
  )
}

export function SubmitButton({ label, held, busy }: { label: string; held: string | undefined; busy: boolean }) {
  return (
    <Button type="submit" variant="primary" size="lg" className="w-full" disabledReason={held}>
      {busy && <LoaderCircle aria-hidden size={20} className="shrink-0 animate-spin" />}
      {label}
    </Button>
  )
}

// The form every step submits: a real form (Enter submits, SHL-27), posted by script only. method
// post keeps a typed number out of the URL even if the script never ran (and CSP form-action 'none'
// stops that submit anyway); noValidate keeps the browser's own bubble out (KM-14).
export function StepForm({ onSubmit, children }: { onSubmit(): void; children: ReactNode }) {
  return (
    <form
      method="post"
      noValidate
      onSubmit={event => {
        event.preventDefault()
        onSubmit()
      }}
      className="flex flex-col gap-4"
    >
      {children}
    </form>
  )
}
