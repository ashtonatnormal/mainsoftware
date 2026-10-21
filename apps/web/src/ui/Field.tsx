// A labelled form control with its hint and error (T21; SHL-28, SHL-16, X7, WCAG 3.3.1, 3.3.2).
// The label is always visible, never a placeholder alone. The caller renders the control from the
// props it is handed: the id the label points at, aria-describedby naming the hint and then the
// error, and aria-invalid while there is an error. The error is text with an icon, in the danger
// ink, so it never rests on colour alone. Every control takes CONTROL_CLASS, or, for the code and
// PIN fields, DIGITS_CONTROL_CLASS (their 24 px figures). Both share one box: text of at least
// 16 px at every width (iOS zooms into anything smaller), a 44 px minimum height and the
// line-strong border that marks a control at 3:1 (X7, SHL-37).
//
// Every form the app renders carries noValidate: the checks are the client's own and the server's
// codes, shown here, so the browser's bubble (in its own locale, outside this error model) never
// appears and an attribute such as `pattern` can't block a submit (KM-14).
import { CircleAlert } from 'lucide-react'
import { type ReactNode, useId } from 'react'

export interface FieldControlProps {
  id: string
  'aria-describedby'?: string
  'aria-invalid'?: true
}

export interface FieldProps {
  label: string
  hint?: string
  error?: string
  children(control: FieldControlProps): ReactNode
}

// A control's box: the 44 px height, the 3:1 border, the error's border, and a disabled control
// on the control ground in muted ink (a TEXT_PAIRS pair, never opacity, X9). Finance's field
// padding, and its focus ring flush with the box (the base accent ring with no offset).
const CONTROL_BOX =
  'min-h-11 w-full rounded-xl border border-line-strong bg-surface px-3.5 text-fg focus-visible:outline-offset-0 aria-invalid:border-rec disabled:bg-surface-2 disabled:text-muted'

export const CONTROL_CLASS = `${CONTROL_BOX} text-base`

// A code or PIN field's (ui/CodeField.tsx, ui/PinField.tsx): 24 px figures of one width, spaced, so
// six digits read at a glance.
export const DIGITS_CONTROL_CLASS = `${CONTROL_BOX} text-2xl tabular-nums tracking-widest`

export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId()
  const hintId = `${id}hint`
  const errorId = `${id}error`
  const describedBy = [hint === undefined ? undefined : hintId, error === undefined ? undefined : errorId]
    .filter(Boolean)
    .join(' ')
  const control: FieldControlProps = { id }
  if (describedBy) control['aria-describedby'] = describedBy
  if (error !== undefined) control['aria-invalid'] = true
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      {hint !== undefined && (
        <p id={hintId} className="text-small text-muted">
          {hint}
        </p>
      )}
      {children(control)}
      {error !== undefined && (
        <p id={errorId} className="flex items-start gap-1.5 text-small text-rec">
          <CircleAlert aria-hidden size={16} className="mt-px shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </div>
  )
}
