// The PIN's fields (T20; T21 item 13; SHL-49, WCAG 3.3.8): sign-in's PIN steps
// now, C0.16's re-authentication sheet later.
// - PinField: one native password input, inputmode="numeric" for the number pad, and
//   autocomplete new-password (choosing one) or current-password (entering it), so a password
//   manager can save and fill it. WCAG 3.3.8 allows a memory test at sign-in only where such help
//   works, so nothing blocks paste or autofill. What is typed is kept as its 6 digits at most
//   (normaliseCode), with no maxlength, which would cut a paste short.
// - ShowPin: the kit's Switch, turning the dots into digits and back; focus stays on it.
// - PinUsername: the hidden username a password manager files the PIN under, the number the code
//   went to, so a saved PIN belongs to that account.
import type { Ref } from 'react'
import { normaliseCode, PIN_LENGTH } from './code-field.ts'
import { DIGITS_CONTROL_CLASS, Field } from './Field.tsx'
import { Switch } from './Switch.tsx'
import { UI } from './strings.ts'

export interface PinFieldProps {
  label: string
  hint?: string
  error?: string
  value: string
  onChange(value: string): void
  // new-password when the PIN is being chosen, current-password when it is entered.
  autoComplete: 'new-password' | 'current-password'
  name: string
  // Digits instead of dots (ShowPin).
  shown: boolean
  enterKeyHint?: 'done' | 'go' | 'next'
  ref?: Ref<HTMLInputElement>
}

export function PinField({
  label,
  hint,
  error,
  value,
  onChange,
  autoComplete,
  name,
  shown,
  enterKeyHint = 'go',
  ref,
}: PinFieldProps) {
  return (
    <Field label={label} hint={hint} error={error}>
      {control => (
        <input
          {...control}
          ref={ref}
          type={shown ? 'text' : 'password'}
          name={name}
          autoComplete={autoComplete}
          inputMode="numeric"
          enterKeyHint={enterKeyHint}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={value}
          onChange={event => onChange(normaliseCode(event.currentTarget.value, PIN_LENGTH))}
          className={DIGITS_CONTROL_CLASS}
        />
      )}
    </Field>
  )
}

export function ShowPin({ shown, onChange }: { shown: boolean; onChange(shown: boolean): void }) {
  return <Switch label={UI.showPin} checked={shown} onChange={onChange} />
}

// Hidden from everyone but a password manager: never shown, never focusable, read only.
export function PinUsername({ number }: { number: string }) {
  return <input type="text" name="username" autoComplete="username" value={number} readOnly hidden />
}
