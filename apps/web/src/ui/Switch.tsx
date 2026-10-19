// An on/off setting (T21, D-03; SHL-37). A native checkbox with role="switch" and aria-checked
// (Biome's useAriaPropsForRole asks for it), so Space toggles it and a screen reader says "on" or
// "off". The checkbox itself is the whole row, drawn without its native look, so the row is the
// 44 px target and the focus ring goes round the row. Beside the label, the track: off is the
// control ground with a line-strong border and a muted knob, on is the accent with an accent-fg
// knob, each at 3:1 (SHL-37, UI_PAIRS). Forced colours (Windows High Contrast) would paint both
// knob and track in Canvas, so app.css draws them in system colours there: the off track Canvas
// with a CanvasText border and a CanvasText knob, the on track (.switch-on) Highlight with a
// HighlightText knob (.switch-knob), and the state shows either way.
//
// A switch that can't change says why, as Button does: aria-disabled and its reason as a
// description, focusable, and a press that changes nothing.
import { type MouseEvent, useId } from 'react'
import { cx } from './cx.ts'

export interface SwitchProps {
  label: string
  checked: boolean
  onChange(next: boolean): void
  description?: string
  disabledReason?: string
}

export function Switch({ label, checked, onChange, description, disabledReason }: SwitchProps) {
  const id = useId()
  const labelId = `${id}label`
  const descriptionId = `${id}description`
  const reasonId = `${id}reason`
  const held = disabledReason !== undefined
  const describedBy = [description === undefined ? undefined : descriptionId, held ? reasonId : undefined]
    .filter(Boolean)
    .join(' ')
  return (
    <div className="relative flex min-h-11 items-center gap-3 rounded-xl py-1">
      <span className="flex min-w-0 flex-1 flex-col">
        <span id={labelId}>{label}</span>
        {description !== undefined && (
          <span id={descriptionId} className="text-small text-muted">
            {description}
          </span>
        )}
      </span>
      <span
        aria-hidden
        className={cx(
          'switch-track inline-flex h-7 w-12 shrink-0 items-center rounded-full border p-0.5 transition',
          checked ? 'switch-on border-accent bg-accent' : 'border-line-strong bg-surface-2',
        )}
      >
        <span
          className={cx(
            'switch-knob size-5 rounded-full transition',
            checked ? 'translate-x-5 bg-accent-fg' : 'translate-x-0 bg-muted',
          )}
        />
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        aria-labelledby={labelId}
        aria-describedby={describedBy || undefined}
        aria-disabled={held || undefined}
        onChange={event => {
          if (!held) onChange(event.currentTarget.checked)
        }}
        onClick={(event: MouseEvent<HTMLInputElement>) => {
          if (held) event.preventDefault()
        }}
        className="absolute inset-0 z-10 m-0 size-full cursor-pointer appearance-none rounded-xl aria-disabled:cursor-not-allowed"
      />
      {held && (
        <span id={reasonId} hidden>
          {disabledReason}
        </span>
      )}
    </div>
  )
}
