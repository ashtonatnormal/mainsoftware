// The processing register's page, pure (PDPA-01; C0.9 PD-04, PD-06, PD-07, PD-11, PD-27): the
// answer's rows as the cards show them, an entry as its edit form holds it and as the body the api
// takes, and what the page offers, warns of and refuses (the shared rules). dpo/model.ts has what
// both pages share.
import {
  BASIS_NEEDS,
  type Basis,
  basesFor,
  NON_AI_PROVIDERS,
  PURPOSES,
  type PurposeEntry,
  type PurposeKey,
  type PurposeProblem,
  type PurposeRowForClient,
  type PurposeStatus,
  type PurposeWarning,
  purposeProblems,
  purposeWarnings,
  type SetPurposeJSON,
  statusesFor,
} from '@hearth/shared'
import { DPO } from '@/strings/dpo.ts'
import { BASIS_LABELS, PURPOSES_COPY, REFERENCE_LABELS, STATUS_LABELS } from '@/strings/dpo-purposes.ts'
import { type Fact, providerName, recordedText, textOrNull } from './model.ts'

export const purposeLabel = (key: PurposeKey): string => PURPOSES[key].register

export interface PurposeView {
  readonly key: PurposeKey
  readonly label: string
  readonly status: PurposeStatus
  readonly statusLabel: string
  readonly facts: readonly Fact[]
  readonly pinned: boolean
}

// A purpose's card: its status, then basis, its attachment, retention, providers, and which
// version this is and who recorded it, with "Not recorded" for what isn't.
export function purposeView(row: PurposeRowForClient): PurposeView {
  const facts: Fact[] = [
    { term: PURPOSES_COPY.basis, value: row.basis === null ? DPO.notRecorded : BASIS_LABELS[row.basis] },
  ]
  const referenceLabel = row.basis === null ? undefined : REFERENCE_LABELS[row.basis]
  if (referenceLabel !== undefined) facts.push({ term: referenceLabel, value: row.basisReference ?? DPO.notRecorded })
  if (row.optOutDays !== null)
    facts.push({ term: PURPOSES_COPY.optOutDays, value: PURPOSES_COPY.optOutValue(String(row.optOutDays)) })
  facts.push(
    { term: PURPOSES_COPY.retention, value: row.retention ?? DPO.notRecorded },
    {
      term: PURPOSES_COPY.providers,
      value: row.providers.length === 0 ? PURPOSES_COPY.noProviders : row.providers.map(providerName).join(', '),
    },
    { term: PURPOSES_COPY.version, value: String(row.version) },
    { term: PURPOSES_COPY.recorded, value: recordedText(row.recordedOn, row.recordedBy, row.version === 1) },
  )
  return {
    key: row.purpose,
    label: purposeLabel(row.purpose),
    status: row.status,
    statusLabel: STATUS_LABELS[row.status],
    facts,
    pinned: row.pinned,
  }
}

// The edit form: what the fields hold, as typed.
export interface PurposeForm {
  readonly status: PurposeStatus
  readonly basis: Basis | ''
  readonly basisReference: string
  readonly optOutDays: string
  readonly retention: string
  readonly providers: readonly string[]
}

export function purposeFormOf(row: PurposeRowForClient): PurposeForm {
  return {
    status: row.status,
    basis: row.basis ?? '',
    basisReference: row.basisReference ?? '',
    optOutDays: row.optOutDays === null ? '' : String(row.optOutDays),
    retention: row.retention ?? '',
    providers: row.providers,
  }
}

// A typed window: blank is none, digits are a number, anything else a number out of range
// (opt_out_range), so the page says what's wrong and never sends it.
function daysOf(text: string): number | null {
  const typed = text.trim()
  if (typed === '') return null
  return /^[0-9]{1,4}$/.test(typed) ? Number(typed) : Number.NaN
}

// The entry the form would save. A field the chosen basis doesn't take is left out, as the page
// hides it, so what the person typed there before changing the basis is never sent.
export function purposeEntryOf(form: PurposeForm): PurposeEntry {
  const basis = form.basis === '' ? null : form.basis
  const needs = basis === null ? { reference: false, optOutDays: false } : BASIS_NEEDS[basis]
  return {
    status: form.status,
    basis,
    basisReference: needs.reference ? textOrNull(form.basisReference) : null,
    optOutDays: needs.optOutDays ? daysOf(form.optOutDays) : null,
    retention: textOrNull(form.retention),
    // In the registry's order, once each.
    providers: NON_AI_PROVIDERS.filter(provider => form.providers.includes(provider)),
  }
}

export function purposeBodyOf(row: PurposeRowForClient, form: PurposeForm): SetPurposeJSON {
  const entry = purposeEntryOf(form)
  return {
    purpose: row.purpose,
    seen: row.version,
    status: entry.status,
    basis: entry.basis,
    basisReference: entry.basisReference,
    optOutDays: entry.optOutDays,
    retention: entry.retention,
    providers: NON_AI_PROVIDERS.filter(provider => entry.providers.includes(provider)),
  }
}

export interface PurposeEditor {
  // What the page offers: only what can save (statusesFor, basesFor). A pinned purpose has one
  // status, so the page shows it as text.
  readonly statuses: readonly PurposeStatus[]
  readonly bases: readonly Basis[]
  readonly referenceLabel: string | undefined
  readonly takesOptOut: boolean
  readonly problems: readonly PurposeProblem[]
  readonly warnings: readonly PurposeWarning[]
}

export function purposeEditor(key: PurposeKey, form: PurposeForm): PurposeEditor {
  const entry = purposeEntryOf(form)
  return {
    statuses: statusesFor(key),
    bases: basesFor(key),
    referenceLabel: entry.basis === null ? undefined : REFERENCE_LABELS[entry.basis],
    takesOptOut: entry.basis !== null && BASIS_NEEDS[entry.basis].optOutDays,
    problems: purposeProblems(key, entry),
    warnings: purposeWarnings(key, entry),
  }
}
