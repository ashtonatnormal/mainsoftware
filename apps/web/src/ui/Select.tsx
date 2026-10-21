// A native <select> in a Field (T21, D-03; SHL-16). The browser's own picker is the most usable
// one on a phone, follows the system theme through color-scheme, and needs no listbox code.
import type { SelectHTMLAttributes } from 'react'
import { cx } from './cx.ts'
import { CONTROL_CLASS, Field } from './Field.tsx'

export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children' | 'id'> & {
  label: string
  hint?: string
  error?: string
  options: readonly { value: string; label: string }[]
}

export function Select({ label, hint, error, options, className, ...rest }: SelectProps) {
  return (
    <Field label={label} hint={hint} error={error}>
      {control => (
        <select {...rest} {...control} className={cx(CONTROL_CLASS, className)}>
          {options.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  )
}
