// A native <select> in a Field (T21, D-03; SHL-16). The browser's own picker is the most usable
// one on a phone, follows the system theme through color-scheme, and needs no listbox code. Its
// closed box is drawn like finance's: no native arrow (appearance-none), and a lucide chevron in
// the field's ink laid over the right edge, hidden from assistive technology and from the pointer,
// so a press still opens the picker. A data: URI chevron, as finance draws it, is what
// check-web-dist refuses.
import { ChevronDown } from 'lucide-react'
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
        <div className="relative">
          <select {...rest} {...control} className={cx(CONTROL_CLASS, 'peer appearance-none pr-10', className)}>
            {options.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDown
            aria-hidden
            size={16}
            className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-fg peer-disabled:text-muted"
          />
        </div>
      )}
    </Field>
  )
}
