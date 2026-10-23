// The processing register (PDPA-01; C0.9 PD-04, PD-06, PD-07, PD-11, PD-26, PD-27), the DPO's
// page at /dpo/purposes. One card per purpose outside the AI layer, in the register's order: its
// status, legal basis and what the basis takes beside it, retention, who receives it and who
// recorded it. A pinned purpose says Hearth keeps it active. Purposes for later stages stay in the
// database, planned, and off this page until A0 (PD-27), which the line under the list says.
//
// Edit opens the kit's Dialog (a sheet on phones) holding the entry:
// - the status, as the kit's Segmented, offering only what can save (statusesFor); a pinned
//   purpose's one status shows as text;
// - the legal basis, offering only what can save (basesFor): no consent-type basis for a pinned
//   purpose, nor for one that needs a per-person switch until those exist (PD-11);
// - the reference and the opt-out window the basis takes, and nothing it doesn't (BASIS_NEEDS);
// - retention, and the providers, as checkboxes;
// - PDPA-01's warnings, which never block, in a polite live region as the basis changes them;
// - what blocks the save (purposeProblems), which holds Save with the reason.
// Save sends the version the page read; a newer one is refused with register_changed and Reload
// (PD-25). The router loads this module lazily (router/router.tsx).
import { PURPOSE_STATUSES, type PurposeKey, type PurposeRowForClient } from '@hearth/shared'
import { Pencil } from 'lucide-react'
import { useId, useState } from 'react'
import { DPO, PROVIDER_NAMES } from '@/strings/dpo.ts'
import {
  BASIS_LABELS,
  PURPOSE_PROBLEM_COPY,
  PURPOSE_WARNING_COPY,
  PURPOSES_COPY,
  STATUS_LABELS,
} from '@/strings/dpo-purposes.ts'
import { Button } from '@/ui/Button.tsx'
import { Dialog } from '@/ui/Dialog.tsx'
import { Segmented } from '@/ui/Segmented.tsx'
import { Select } from '@/ui/Select.tsx'
import { SHOWN_PROVIDERS } from './model.ts'
import { CheckRow, Facts, Note, Pill, TextField } from './parts.tsx'
import { type PurposeForm, purposeBodyOf, purposeEditor, purposeFormOf, purposeView } from './purposes-model.ts'
import { RegisterPage, useRegisterWrite, WriteRefusal } from './RegisterPage.tsx'

const STATUS_TONE = { planned: 'muted', active: 'ok', retired: 'plain' } as const

function PurposeCard({ row, onEdit }: { row: PurposeRowForClient; onEdit(): void }) {
  const view = purposeView(row)
  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start gap-2">
        <h2 className="min-w-0 flex-1 break-words font-semibold">{view.label}</h2>
        <Pill tone={STATUS_TONE[view.status]}>{view.statusLabel}</Pill>
      </div>
      <Facts facts={view.facts} />
      {view.pinned && <p className="text-small text-muted">{PURPOSES_COPY.pinned}</p>}
      <Button icon={Pencil} className="self-start" aria-label={DPO.edit(view.label)} onClick={onEdit}>
        {DPO.editButton}
      </Button>
    </li>
  )
}

// Exported for its markup test (dpo/dpo.markup.test.tsx).
export function PurposeDialog({ row, onClose }: { row: PurposeRowForClient; onClose(): void }) {
  const [form, setForm] = useState<PurposeForm>(() => purposeFormOf(row))
  const editor = purposeEditor(row.purpose, form)
  const writer = useRegisterWrite(onClose)
  const formId = useId()
  const label = purposeView(row).label
  const set = (change: Partial<PurposeForm>) => setForm(before => ({ ...before, ...change }))
  const held = writer.pending ? DPO.saving : editor.problems.length > 0 ? DPO.fixFirst : undefined
  const submit = () => {
    if (held !== undefined) return
    writer.send({ kind: 'purpose', body: purposeBodyOf(row, form) })
  }
  const basisOptions = [
    { value: '', label: DPO.notRecorded },
    ...editor.bases.map(basis => ({ value: basis, label: BASIS_LABELS[basis] })),
  ]
  return (
    <Dialog
      open
      onClose={onClose}
      title={DPO.edit(label)}
      footer={
        <>
          <Button onClick={onClose}>{DPO.cancel}</Button>
          <Button type="submit" form={formId} variant="primary" disabledReason={held}>
            {DPO.save}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <WriteRefusal writer={writer} />
        <form
          id={formId}
          method="post"
          noValidate
          onSubmit={event => {
            event.preventDefault()
            submit()
          }}
          className="flex flex-col gap-4"
        >
          {editor.statuses.length > 1 ? (
            <div className="flex flex-col gap-1.5">
              <p aria-hidden className="font-medium">
                {PURPOSES_COPY.status}
              </p>
              <Segmented
                label={PURPOSES_COPY.status}
                value={form.status}
                options={PURPOSE_STATUSES.filter(status => editor.statuses.includes(status)).map(status => ({
                  value: status,
                  label: STATUS_LABELS[status],
                }))}
                onChange={status => set({ status })}
              />
            </div>
          ) : (
            <p>
              <span className="font-medium">{PURPOSES_COPY.status}: </span>
              {STATUS_LABELS[form.status]}
            </p>
          )}
          {row.pinned && <p className="text-small text-muted">{PURPOSES_COPY.pinned}</p>}
          <Select
            label={PURPOSES_COPY.basis}
            name="basis"
            value={form.basis}
            options={basisOptions}
            onChange={event => set({ basis: event.currentTarget.value as PurposeForm['basis'] })}
          />
          {editor.referenceLabel !== undefined && (
            <TextField
              label={editor.referenceLabel}
              name="basis-reference"
              multiline
              maxLength={1000}
              value={form.basisReference}
              onChange={basisReference => set({ basisReference })}
            />
          )}
          {editor.takesOptOut && (
            <TextField
              label={PURPOSES_COPY.optOutDays}
              name="opt-out-days"
              inputMode="numeric"
              maxLength={4}
              value={form.optOutDays}
              onChange={optOutDays => set({ optOutDays })}
            />
          )}
          <TextField
            label={PURPOSES_COPY.retention}
            name="retention"
            multiline
            maxLength={1000}
            value={form.retention}
            onChange={retention => set({ retention })}
          />
          <fieldset className="m-0 flex min-w-0 flex-col border-0 p-0">
            <legend className="mb-1 p-0 font-medium">{PURPOSES_COPY.providers}</legend>
            {SHOWN_PROVIDERS.map(provider => (
              <CheckRow
                key={provider}
                label={PROVIDER_NAMES[provider]}
                checked={form.providers.includes(provider)}
                onChange={on =>
                  set({
                    providers: on
                      ? [...form.providers, provider]
                      : form.providers.filter(listed => listed !== provider),
                  })
                }
              />
            ))}
          </fieldset>
          <div role="status">
            {editor.warnings.length > 0 && (
              <Note
                tone="warn"
                title={PURPOSES_COPY.warnings}
                items={editor.warnings.map(warning => PURPOSE_WARNING_COPY[warning])}
              />
            )}
          </div>
          {editor.problems.length > 0 && (
            <Note
              tone="info"
              title={DPO.beforeSaving}
              items={editor.problems.map(problem => PURPOSE_PROBLEM_COPY[problem])}
            />
          )}
        </form>
      </div>
    </Dialog>
  )
}

export function PurposesScreen() {
  const [editing, setEditing] = useState<PurposeKey | undefined>()
  return (
    <RegisterPage current="purposes">
      {registers => {
        const row = registers.purposes.find(each => each.purpose === editing)
        return (
          <>
            <p className="text-muted">{PURPOSES_COPY.intro}</p>
            <ul className="flex flex-col gap-3">
              {registers.purposes.map(each => (
                <PurposeCard key={each.purpose} row={each} onEdit={() => setEditing(each.purpose)} />
              ))}
            </ul>
            <div className="flex flex-col gap-1 text-small text-muted">
              <p>{PURPOSES_COPY.startsWhenNotified}</p>
              <p>{PURPOSES_COPY.laterStages}</p>
            </div>
            {row !== undefined && <PurposeDialog key={row.purpose} row={row} onClose={() => setEditing(undefined)} />}
          </>
        )
      }}
    </RegisterPage>
  )
}
