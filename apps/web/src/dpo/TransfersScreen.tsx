// The transfer register (PDPA-10, D46; C0.9 PD-05, PD-12, PD-13, PD-14, PD-26, PD-27), the DPO's
// page at /dpo/transfers. One card per provider outside the AI layer: whether it is cleared, by
// whom and when (or at set-up, by the first-Owner bootstrap); its review date, overdue once passed
// (which never ends a clearance, PD-13); its main facts; and what in Hearth checks its clearance
// today (TECH-SPEC T22 item 3: only Twilio Verify's, before each code).
//
// Actions:
// - Edit: every PDPA-10 fact in the kit's Dialog, with what is still needed before clearing
//   (transferProblems, against the answer's today in the org's zone). On an entry that isn't
//   cleared, Save records the facts. On a cleared one, the primary action is "Save and keep
//   cleared", which clears the new facts in the same transaction and is held while any fact is
//   missing; a plain Save that changes anything ends the clearance (facts_changed), so it asks
//   first, with the same consequence as Withdraw (PD-05).
// - Clear for use: clears the saved facts, after a confirmation; held while any is missing.
// - Withdraw clearance: after a confirmation that says what withdrawing stops for this provider.
// Every write sends the revision the page read where it takes one; a newer one is refused with
// register_changed and Reload (PD-25).
//
// The published notice (C0.9 PD-41, PD-48, PD-59): the Notice link's badge and a banner say whether
// it still says what the registers say; a cleared provider whose facts the published notice doesn't
// state says nothing is sent to it until the next publish (Twilio Verify: only the DPO gets sign-in
// codes); and once a generated version states a cleared provider's facts, the dialog says what a
// change to one of them stops until the next publish (dpo/notice-markers.tsx). The router loads
// this module lazily (router/router.tsx).
import {
  noticeFactsOf,
  type ProviderKey,
  SAFEGUARDS,
  sameNoticeFacts,
  TRAINING,
  type TransferRowForClient,
  ZERO_RETENTION,
} from '@hearth/shared'
import { Pencil } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { DPO } from '@/strings/dpo.ts'
import {
  SAFEGUARD_LABELS,
  TRAINING_LABELS,
  TRANSFER_PROBLEM_COPY,
  TRANSFERS_COPY,
  ZERO_RETENTION_LABELS,
} from '@/strings/dpo-transfers.ts'
import { Button } from '@/ui/Button.tsx'
import { Dialog } from '@/ui/Dialog.tsx'
import { Select } from '@/ui/Select.tsx'
import {
  factsSaveStops,
  factsStopText,
  NoticeBadge,
  NoticeBanner,
  noticeGenerated,
  ProviderNoticeMarker,
  SaveStopsNote,
} from './notice-markers.tsx'
import { CheckRow, DateField, Facts, Note, Pill, TextField } from './parts.tsx'
import { RegisterPage, type RegisterWriter, useRegisterWrite, WriteRefusal } from './RegisterPage.tsx'
import {
  countriesOf,
  countryNames,
  recordBodyOf,
  rowFacts,
  type TransferForm,
  transferEditor,
  transferFactsOf,
  transferFormOf,
  transferView,
} from './transfers-model.ts'

type Opened = { readonly kind: 'edit' | 'clear' | 'withdraw'; readonly provider: ProviderKey }

function TransferCard({
  row,
  today,
  onOpen,
}: {
  row: TransferRowForClient
  today: string
  onOpen(kind: Opened['kind']): void
}) {
  const view = transferView(row, today)
  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start gap-2">
        <h2 className="min-w-0 flex-1 break-words font-semibold">{view.name}</h2>
        <Pill tone={view.cleared ? 'ok' : 'muted'}>
          {view.cleared ? TRANSFERS_COPY.cleared : TRANSFERS_COPY.notCleared}
        </Pill>
      </div>
      {(view.clearance !== undefined || view.review !== undefined) && (
        <div className="flex flex-col items-start gap-1">
          {view.clearance !== undefined && <p className="text-small text-muted">{view.clearance}</p>}
          {view.review !== undefined &&
            (view.review.overdue ? (
              <Pill tone="warn">{view.review.text}</Pill>
            ) : (
              <p className="text-small text-muted">{view.review.text}</p>
            ))}
        </div>
      )}
      <ProviderNoticeMarker row={row} />
      <Facts facts={view.facts} />
      <p className="text-small text-muted">
        <span className="font-medium text-fg">{TRANSFERS_COPY.checkedBy}: </span>
        {view.checkedBy}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button icon={Pencil} aria-label={DPO.edit(view.name)} onClick={() => onOpen('edit')}>
          {DPO.editButton}
        </Button>
        {view.cleared ? (
          <Button variant="danger" onClick={() => onOpen('withdraw')}>
            {TRANSFERS_COPY.withdraw}
          </Button>
        ) : (
          <Button variant="primary" disabledReason={view.clearHeld} onClick={() => onOpen('clear')}>
            {TRANSFERS_COPY.clearForUse}
          </Button>
        )}
      </div>
    </li>
  )
}

// A yes-or-no before a change that clears or stops a provider: what it does, then Cancel or go.
function ConfirmDialog({
  title,
  body,
  confirm,
  variant,
  writer,
  onConfirm,
  onClose,
}: {
  title: string
  body: readonly string[]
  confirm: string
  variant: 'primary' | 'danger'
  writer: RegisterWriter
  onConfirm(): void
  onClose(): void
}) {
  return (
    <Dialog
      open
      presentation="centred"
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>{DPO.cancel}</Button>
          <Button variant={variant} disabledReason={writer.pending ? DPO.saving : undefined} onClick={onConfirm}>
            {confirm}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <WriteRefusal writer={writer} />
        {body.map(paragraph => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>
    </Dialog>
  )
}

// The dialogs are exported for their markup test (dpo/dpo.markup.test.tsx).
export function ClearDialog({ row, today, onClose }: { row: TransferRowForClient; today: string; onClose(): void }) {
  const view = transferView(row, today)
  const writer = useRegisterWrite(onClose, TRANSFERS_COPY.clearedToast(view.name))
  return (
    <ConfirmDialog
      title={TRANSFERS_COPY.confirmClear.title(view.name)}
      body={[TRANSFERS_COPY.confirmClear.body, view.checkedBy]}
      confirm={TRANSFERS_COPY.clearForUse}
      variant="primary"
      writer={writer}
      onConfirm={() => writer.send({ kind: 'clear', body: { provider: row.provider, seen: row.revision } })}
      onClose={onClose}
    />
  )
}

export function WithdrawDialog({ row, today, onClose }: { row: TransferRowForClient; today: string; onClose(): void }) {
  const view = transferView(row, today)
  const writer = useRegisterWrite(onClose, TRANSFERS_COPY.withdrawnToast(view.name))
  return (
    <ConfirmDialog
      title={TRANSFERS_COPY.confirmWithdraw.title(view.name)}
      body={[view.withdrawing]}
      confirm={TRANSFERS_COPY.withdraw}
      variant="danger"
      writer={writer}
      onConfirm={() => writer.send({ kind: 'withdraw', body: { provider: row.provider } })}
      onClose={onClose}
    />
  )
}

// A country list field: the codes as typed, the names they stand for as its hint once they read.
function CountriesField({
  label,
  name,
  value,
  invalid,
  onChange,
}: {
  label: string
  name: string
  value: string
  invalid: boolean
  onChange(value: string): void
}) {
  const codes = countriesOf(value).codes
  return (
    <TextField
      label={label}
      name={name}
      maxLength={300}
      hint={!invalid && codes.length > 0 ? countryNames(codes) : TRANSFERS_COPY.countriesHint}
      error={invalid ? TRANSFERS_COPY.countriesInvalid : undefined}
      value={value}
      onChange={onChange}
    />
  )
}

// generated: the latest published version is a generated one (noticeGenerated), so it states the
// facts of every provider it lists.
export function TransferDialog({
  row,
  today,
  generated = false,
  onClose,
}: {
  row: TransferRowForClient
  today: string
  generated?: boolean
  onClose(): void
}) {
  const [form, setForm] = useState<TransferForm>(() => transferFormOf(row))
  // A plain Save of a cleared entry's changed facts is waiting for its confirmation.
  const [confirming, setConfirming] = useState(false)
  const editor = transferEditor(row, form, today)
  const view = transferView(row, today)
  // A change to a fact the notice states (C0.9 PD-41) stops sends to the provider until the next
  // publish, once a generated version states it.
  const stops = factsSaveStops(
    row,
    !sameNoticeFacts(noticeFactsOf(transferFactsOf(form)), noticeFactsOf(rowFacts(row))),
    generated,
  )
  const writer = useRegisterWrite(onClose)
  const formId = useId()
  const confirmText = useRef<HTMLParagraphElement>(null)
  const plainSave = useRef<HTMLButtonElement>(null)
  const set = (change: Partial<TransferForm>) => setForm(before => ({ ...before, ...change }))
  const pending = writer.pending ? DPO.saving : undefined

  useEffect(() => {
    if (confirming) confirmText.current?.focus()
  }, [confirming])

  const save = (keepCleared: boolean) => writer.send({ kind: 'record', body: recordBodyOf(row, form, keepCleared) })
  const savePlain = () => {
    if (pending !== undefined || editor.saveHeld !== undefined) return
    if (editor.saveEndsClearance) setConfirming(true)
    else save(false)
  }
  const saveKeepingCleared = () => {
    if (pending !== undefined || editor.keepClearedHeld !== undefined) return
    save(true)
  }
  // Enter in a field does what the primary button does.
  const submit = editor.cleared ? saveKeepingCleared : savePlain

  if (confirming) {
    return (
      <Dialog
        open
        onClose={onClose}
        title={TRANSFERS_COPY.confirmSaveEnds.title}
        footer={
          <>
            <Button
              onClick={() => {
                setConfirming(false)
                requestAnimationFrame(() => plainSave.current?.focus())
              }}
            >
              {TRANSFERS_COPY.back}
            </Button>
            <Button variant="danger" disabledReason={pending} onClick={() => save(false)}>
              {TRANSFERS_COPY.confirmSaveEnds.confirm}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <WriteRefusal writer={writer} />
          <p ref={confirmText} tabIndex={-1}>
            {TRANSFERS_COPY.confirmSaveEnds.body(view.name)}
          </p>
          <p>{view.withdrawing}</p>
        </div>
      </Dialog>
    )
  }

  const footer = editor.cleared ? (
    <>
      <Button onClick={onClose}>{DPO.cancel}</Button>
      <Button ref={plainSave} disabledReason={pending ?? editor.saveHeld} onClick={savePlain}>
        {DPO.save}
      </Button>
      <Button type="submit" form={formId} variant="primary" disabledReason={pending ?? editor.keepClearedHeld}>
        {TRANSFERS_COPY.saveKeepCleared}
      </Button>
    </>
  ) : (
    <>
      <Button onClick={onClose}>{DPO.cancel}</Button>
      <Button type="submit" form={formId} variant="primary" disabledReason={pending ?? editor.saveHeld}>
        {DPO.save}
      </Button>
    </>
  )

  const fields = TRANSFERS_COPY.fields
  return (
    <Dialog open onClose={onClose} title={DPO.edit(view.name)} footer={footer}>
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
          <TextField
            label={fields.services}
            name="services"
            multiline
            maxLength={500}
            value={form.services}
            onChange={services => set({ services })}
          />
          <TextField
            label={fields.dataTypes}
            name="data-types"
            multiline
            maxLength={1000}
            value={form.dataTypes}
            onChange={dataTypes => set({ dataTypes })}
          />
          <CountriesField
            label={fields.processingCountries}
            name="processing-countries"
            value={form.processingCountries}
            invalid={editor.processingInvalid}
            onChange={processingCountries => set({ processingCountries })}
          />
          <CountriesField
            label={fields.storageCountries}
            name="storage-countries"
            value={form.storageCountries}
            invalid={editor.storageInvalid}
            onChange={storageCountries => set({ storageCountries })}
          />
          <TextField
            label={fields.countriesConfirmed}
            name="countries-confirmed"
            maxLength={500}
            value={form.countriesConfirmed}
            onChange={countriesConfirmed => set({ countriesConfirmed })}
          />
          <Select
            label={fields.safeguard}
            name="safeguard"
            value={form.safeguard}
            options={[
              { value: '', label: DPO.notRecorded },
              ...SAFEGUARDS.map(safeguard => ({ value: safeguard, label: SAFEGUARD_LABELS[safeguard] })),
            ]}
            onChange={event => set({ safeguard: event.currentTarget.value as TransferForm['safeguard'] })}
          />
          <TextField
            label={fields.safeguardReference}
            hint={fields.safeguardReferenceHint}
            name="safeguard-reference"
            maxLength={500}
            value={form.safeguardReference}
            onChange={safeguardReference => set({ safeguardReference })}
          />
          {form.safeguard === 'certification' && (
            <DateField
              label={fields.certificateVerifiedOn}
              name="certificate-verified-on"
              value={form.certificateVerifiedOn}
              onChange={certificateVerifiedOn => set({ certificateVerifiedOn })}
            />
          )}
          <CheckRow
            label={fields.dpaTerms}
            checked={form.dpaTermsConfirmed}
            onChange={dpaTermsConfirmed => set({ dpaTermsConfirmed })}
          />
          <Select
            label={fields.training}
            name="training"
            value={form.training}
            options={[
              { value: '', label: DPO.notRecorded },
              ...TRAINING.map(training => ({ value: training, label: TRAINING_LABELS[training] })),
            ]}
            onChange={event => set({ training: event.currentTarget.value as TransferForm['training'] })}
          />
          <Select
            label={fields.zeroRetention}
            name="zero-retention"
            value={form.zeroRetention}
            options={[
              { value: '', label: DPO.notRecorded },
              ...ZERO_RETENTION.map(result => ({ value: result, label: ZERO_RETENTION_LABELS[result] })),
            ]}
            onChange={event => set({ zeroRetention: event.currentTarget.value as TransferForm['zeroRetention'] })}
          />
          <TextField
            label={fields.providerRetention}
            name="provider-retention"
            multiline
            maxLength={1000}
            value={form.providerRetention}
            onChange={providerRetention => set({ providerRetention })}
          />
          <TextField
            label={fields.retentionConfirmed}
            name="retention-confirmed"
            maxLength={500}
            value={form.retentionConfirmed}
            onChange={retentionConfirmed => set({ retentionConfirmed })}
          />
          <TextField
            label={fields.onwardRecipients}
            hint={fields.onwardRecipientsHint}
            name="onward-recipients"
            multiline
            maxLength={1000}
            value={form.onwardRecipients}
            onChange={onwardRecipients => set({ onwardRecipients })}
          />
          <DateField
            label={fields.reviewOn}
            name="review-on"
            value={form.reviewOn}
            onChange={reviewOn => set({ reviewOn })}
          />
          <div role="status">{stops && <SaveStopsNote text={factsStopText(row, view.name)} />}</div>
          {editor.problems.length > 0 ? (
            <Note
              tone="info"
              title={TRANSFERS_COPY.stillNeeded}
              items={editor.problems.map(problem => TRANSFER_PROBLEM_COPY[problem])}
            />
          ) : (
            <Note tone="info">
              <p>{TRANSFERS_COPY.nothingNeeded}</p>
            </Note>
          )}
        </form>
      </div>
    </Dialog>
  )
}

export function TransfersScreen() {
  const [opened, setOpened] = useState<Opened | undefined>()
  const close = () => setOpened(undefined)
  return (
    <RegisterPage current="transfers" noticeBadge={registers => <NoticeBadge status={registers.notice} />}>
      {registers => {
        const row = registers.transfers.find(each => each.provider === opened?.provider)
        const today = registers.today
        return (
          <>
            <NoticeBanner registers={registers} />
            <p className="text-muted">{TRANSFERS_COPY.intro}</p>
            <ul className="flex flex-col gap-3">
              {registers.transfers.map(each => (
                <TransferCard
                  key={each.provider}
                  row={each}
                  today={today}
                  onOpen={kind => setOpened({ kind, provider: each.provider })}
                />
              ))}
            </ul>
            {row !== undefined && opened?.kind === 'edit' && (
              <TransferDialog
                key={row.provider}
                row={row}
                today={today}
                generated={noticeGenerated(registers)}
                onClose={close}
              />
            )}
            {row !== undefined && opened?.kind === 'clear' && (
              <ClearDialog key={row.provider} row={row} today={today} onClose={close} />
            )}
            {row !== undefined && opened?.kind === 'withdraw' && (
              <WithdrawDialog key={row.provider} row={row} today={today} onClose={close} />
            )}
          </>
        )
      }}
    </RegisterPage>
  )
}
