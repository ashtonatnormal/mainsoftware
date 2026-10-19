// The field for a texted code (T21, T20; AUTH-DESIGN §10.1, §10.4; SHL-07, SHL-27, QA-04): sign-in's
// code step now, C0.16's re-authentication sheet later. One native input, never six boxes or an
// on-screen keypad, so the phone's number pad, a physical keyboard, paste and autofill all work and
// no tap can be dropped.
// - autocomplete="one-time-code" lets iOS offer the code from Messages, and inputmode="numeric"
//   brings up the number pad. There is no pattern (inputmode does that job on iOS 16.4, the pilot's
//   floor) and no maxlength (ui/code-field.ts: it would cut a pasted "123 456" short).
// - What is typed is kept as its digits only, at most `length` of them (normaliseCode), so the
//   field never holds what the server would refuse as the wrong shape.
// - Nothing submits on the last digit (WCAG 3.2.2): Enter or the form's button does.
// - The digits are 24 px, of one width and spaced; the label, hint and error come from Field.
import type { Ref } from 'react'
import { normaliseCode } from './code-field.ts'
import { DIGITS_CONTROL_CLASS, Field } from './Field.tsx'

export interface CodeFieldProps {
  label: string
  hint?: string
  error?: string
  // How many digits the code has (the server's codeLength).
  length: number
  value: string
  onChange(value: string): void
  disabled?: boolean
  enterKeyHint?: 'done' | 'go' | 'send'
  ref?: Ref<HTMLInputElement>
}

export function CodeField({
  label,
  hint,
  error,
  length,
  value,
  onChange,
  disabled,
  enterKeyHint = 'done',
  ref,
}: CodeFieldProps) {
  return (
    <Field label={label} hint={hint} error={error}>
      {control => (
        <input
          {...control}
          ref={ref}
          type="text"
          name="one-time-code"
          autoComplete="one-time-code"
          inputMode="numeric"
          enterKeyHint={enterKeyHint}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={value}
          disabled={disabled}
          onChange={event => onChange(normaliseCode(event.currentTarget.value, length))}
          className={DIGITS_CONTROL_CLASS}
        />
      )}
    </Field>
  )
}
