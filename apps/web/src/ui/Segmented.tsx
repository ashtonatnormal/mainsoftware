// A choice of one among a few, shown side by side (T21, D-03; fixes X10, SHL-40). The demo drew
// it as tabs (role="tablist") with no panels; here it is what it is, a radio group: a <fieldset>
// with a legend (visually hidden: the context names it on screen) and native radios, so arrow keys
// move and select, Tab enters and leaves the group in one step, and a screen reader says "1 of 3".
// Each radio covers its segment, so the segment is the 44 px target and gets the focus ring. It is
// finance's large segmented control (T21 item 6): a hairline-edged surface track, its segments
// inset, the chosen one ink with surface text (surface on fg, TEXT_PAIRS) and a check mark, so it
// is never shown by colour alone.
import { Check } from 'lucide-react'
import { useId } from 'react'
import { cx } from './cx.ts'

export interface SegmentedProps<T extends string> {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange(value: T): void
}

export function Segmented<T extends string>({ label, value, options, onChange }: SegmentedProps<T>) {
  const name = useId()
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="sr-only">{label}</legend>
      <div className="inline-flex max-w-full flex-wrap gap-2 rounded-2xl border border-line bg-surface p-1.5">
        {options.map(option => {
          const chosen = option.value === value
          return (
            <label
              key={option.value}
              className={cx(
                'relative inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 font-medium transition',
                chosen ? 'bg-fg text-surface' : 'text-fg hover:bg-bg',
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={chosen}
                onChange={() => onChange(option.value)}
                className="absolute inset-0 m-0 size-full cursor-pointer appearance-none rounded-xl"
              />
              {chosen && <Check aria-hidden size={16} className="shrink-0" />}
              <span>{option.label}</span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
