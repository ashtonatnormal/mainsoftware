// The small pieces both DPO pages draw (C0.9 PD-26), from the kit's tokens and controls only: a
// status pill, a card's facts, a note listing what blocks a save or what to check, and the fields
// the kit has no component for yet (a text box, a date, a checkbox). Every control is at least 44 px
// and its text 16 px (CONTROL_CLASS); every pill and note pairs its ink and ground as
// styles/contrast-pairs.ts lists them, and says its state in words, never by colour alone.
import { Check } from 'lucide-react'
import { type ReactNode, useId } from 'react'
import { cx } from '@/ui/cx.ts'
import { CONTROL_CLASS, Field } from '@/ui/Field.tsx'
import type { Fact } from './model.ts'

export type PillTone = 'ok' | 'warn' | 'muted' | 'plain'

const PILL_TONES: Record<PillTone, string> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  muted: 'bg-surface-2 text-muted',
  plain: 'bg-surface-2 text-fg',
}

export function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex max-w-full shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-small font-medium',
        PILL_TONES[tone],
      )}
    >
      {children}
    </span>
  )
}

// A card's facts as a description list: term over value on a phone, side by side from sm.
export function Facts({ facts }: { facts: readonly Fact[] }) {
  return (
    <dl className="flex flex-col gap-2">
      {facts.map(fact => (
        <div key={fact.term} className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
          <dt className="text-small text-muted sm:w-44 sm:shrink-0 sm:pt-px">{fact.term}</dt>
          <dd className="min-w-0 break-words">{fact.value}</dd>
        </div>
      ))}
    </dl>
  )
}

const NOTE_TONES = {
  info: 'border-line bg-accent-soft text-fg',
  warn: 'border-warn/30 bg-warn-soft text-warn',
  error: 'border-rec/30 bg-rec-soft text-rec',
} as const

// A titled list (what blocks a save, what to check), or a single line when there is no title.
export function Note({
  tone,
  title,
  items,
  children,
}: {
  tone: keyof typeof NOTE_TONES
  title?: string
  items?: readonly string[]
  children?: ReactNode
}) {
  return (
    <div className={cx('flex flex-col gap-1.5 rounded-xl border px-4 py-3', NOTE_TONES[tone])}>
      {title !== undefined && <p className="font-medium">{title}</p>}
      {items !== undefined && items.length > 0 && (
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {items.map(item => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
      {children}
    </div>
  )
}

export interface TextFieldProps {
  label: string
  hint?: string
  error?: string
  value: string
  onChange(value: string): void
  maxLength: number
  // A text box of a few lines, for what is longer than a phrase.
  multiline?: boolean
  inputMode?: 'text' | 'numeric'
  name: string
}

export function TextField({
  label,
  hint,
  error,
  value,
  onChange,
  maxLength,
  multiline,
  inputMode,
  name,
}: TextFieldProps) {
  return (
    <Field label={label} hint={hint} error={error}>
      {control =>
        multiline ? (
          <textarea
            {...control}
            name={name}
            rows={2}
            maxLength={maxLength}
            value={value}
            onChange={event => onChange(event.currentTarget.value)}
            className={cx(CONTROL_CLASS, 'py-2.5')}
          />
        ) : (
          <input
            {...control}
            type="text"
            name={name}
            inputMode={inputMode}
            maxLength={maxLength}
            autoComplete="off"
            value={value}
            onChange={event => onChange(event.currentTarget.value)}
            className={CONTROL_CLASS}
          />
        )
      }
    </Field>
  )
}

export function DateField({
  label,
  value,
  onChange,
  name,
}: {
  label: string
  value: string
  onChange(value: string): void
  name: string
}) {
  return (
    <Field label={label}>
      {control => (
        <input
          {...control}
          type="date"
          name={name}
          value={value}
          onChange={event => onChange(event.currentTarget.value)}
          className={CONTROL_CLASS}
        />
      )}
    </Field>
  )
}

// A checkbox whose whole row is the 44 px target, drawn as the kit's Switch is: the native input
// covers the row, without its native look, so the focus ring goes round the row; beside the label,
// a box in line-strong (3:1) that fills with the accent and a check mark when chosen.
export function CheckRow({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange(next: boolean): void
}) {
  const labelId = useId()
  return (
    <div className="relative flex min-h-11 items-center gap-3 rounded-xl py-1">
      <span
        aria-hidden
        className={cx(
          'inline-grid size-5 shrink-0 place-items-center rounded-md border',
          checked ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong bg-surface',
        )}
      >
        {checked && <Check size={14} strokeWidth={3} />}
      </span>
      <span id={labelId} className="min-w-0 flex-1">
        {label}
      </span>
      <input
        type="checkbox"
        checked={checked}
        aria-labelledby={labelId}
        onChange={event => onChange(event.currentTarget.checked)}
        className="absolute inset-0 z-10 m-0 size-full cursor-pointer appearance-none rounded-xl"
      />
    </div>
  )
}
