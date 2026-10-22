// The transfer register's page, pure (PDPA-10, D46; C0.9 PD-05, PD-12, PD-13, PD-14, PD-27;
// TECH-SPEC T22 item 3): each provider's card (its clearance, review date, facts and what checks
// it), an entry as its edit form holds it and as the body the api takes, and what still blocks a
// save or a clearance (the shared rules). dpo/model.ts has what both pages share.
import {
  type RecordTransferJSON,
  type Safeguard,
  type Training,
  type TransferFacts,
  type TransferProblem,
  type TransferRowForClient,
  transferProblems,
  type ZeroRetention,
} from '@hearth/shared'
import { DPO, type NonAiProviderKey } from '@/strings/dpo.ts'
import { PROVIDER_CHECKS, SAFEGUARD_LABELS, TRANSFERS_COPY } from '@/strings/dpo-transfers.ts'
import { dayText, type Fact, providerName, recordedText, textOrNull } from './model.ts'

export interface TransferForm {
  readonly services: string
  readonly dataTypes: string
  // Typed as text: two-letter codes, separated by commas or spaces.
  readonly processingCountries: string
  readonly storageCountries: string
  readonly countriesConfirmed: string
  readonly safeguard: Safeguard | ''
  readonly safeguardReference: string
  // YYYY-MM-DD, as a date input gives it, or ''.
  readonly certificateVerifiedOn: string
  readonly dpaTermsConfirmed: boolean
  readonly training: Training | ''
  readonly zeroRetention: ZeroRetention | ''
  readonly providerRetention: string
  readonly retentionConfirmed: string
  readonly onwardRecipients: string
  readonly reviewOn: string
}

export function transferFormOf(row: TransferRowForClient): TransferForm {
  return {
    services: row.services ?? '',
    dataTypes: row.dataTypes ?? '',
    processingCountries: row.processingCountries.join(', '),
    storageCountries: row.storageCountries.join(', '),
    countriesConfirmed: row.countriesConfirmed ?? '',
    safeguard: row.safeguard ?? '',
    safeguardReference: row.safeguardReference ?? '',
    certificateVerifiedOn: row.certificateVerifiedOn ?? '',
    dpaTermsConfirmed: row.dpaTermsConfirmed,
    training: row.training ?? '',
    zeroRetention: row.zeroRetention ?? '',
    providerRetention: row.providerRetention ?? '',
    retentionConfirmed: row.retentionConfirmed ?? '',
    onwardRecipients: row.onwardRecipients ?? '',
    reviewOn: row.reviewOn ?? '',
  }
}

// Typed countries: the codes, upper case, once each and sorted, as the register stores them, and
// whether every item typed was a two-letter code.
export function countriesOf(text: string): { readonly codes: readonly string[]; readonly valid: boolean } {
  const items = text.split(/[\s,;]+/).filter(item => item !== '')
  const valid = items.every(item => /^[A-Za-z]{2}$/.test(item))
  return { codes: [...new Set(items.map(item => item.toUpperCase()))].sort(), valid }
}

// Codes as names, in British English ("Singapore, United States"); a code the browser can't name
// stays a code.
export function countryNames(codes: readonly string[]): string {
  let names: Intl.DisplayNames | undefined
  try {
    names = new Intl.DisplayNames(['en-GB'], { type: 'region' })
  } catch {
    names = undefined
  }
  return codes
    .map(code => {
      try {
        return names?.of(code) ?? code
      } catch {
        return code
      }
    })
    .join(', ')
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const dayOrNull = (text: string): string | null => (DAY.test(text) ? text : null)

// The facts the form would save. The verification date belongs to a certification only, as the
// page shows it.
export function transferFactsOf(form: TransferForm): TransferFacts {
  return {
    services: textOrNull(form.services),
    dataTypes: textOrNull(form.dataTypes),
    processingCountries: countriesOf(form.processingCountries).codes,
    storageCountries: countriesOf(form.storageCountries).codes,
    countriesConfirmed: textOrNull(form.countriesConfirmed),
    safeguard: form.safeguard === '' ? null : form.safeguard,
    safeguardReference: textOrNull(form.safeguardReference),
    certificateVerifiedOn: form.safeguard === 'certification' ? dayOrNull(form.certificateVerifiedOn) : null,
    dpaTermsConfirmed: form.dpaTermsConfirmed,
    training: form.training === '' ? null : form.training,
    zeroRetention: form.zeroRetention === '' ? null : form.zeroRetention,
    providerRetention: textOrNull(form.providerRetention),
    retentionConfirmed: textOrNull(form.retentionConfirmed),
    onwardRecipients: textOrNull(form.onwardRecipients),
    reviewOn: dayOrNull(form.reviewOn),
  }
}

// The facts a row holds, in the same shape.
export function rowFacts(row: TransferRowForClient): TransferFacts {
  return transferFactsOf(transferFormOf(row))
}

const sameFacts = (a: TransferFacts, b: TransferFacts): boolean => JSON.stringify(a) === JSON.stringify(b)

export function recordBodyOf(row: TransferRowForClient, form: TransferForm, keepCleared: boolean): RecordTransferJSON {
  const facts = transferFactsOf(form)
  return {
    provider: row.provider,
    seen: row.revision,
    ...facts,
    processingCountries: [...facts.processingCountries],
    storageCountries: [...facts.storageCountries],
    keepCleared,
  }
}

export const isCleared = (row: TransferRowForClient): boolean =>
  row.clearance !== null && row.clearance.withdrawnOn === null

// The clearance as the card says it, beside its pill: when and by whom, or how it ended. A provider
// never cleared has no line but the pill's, and Twilio Verify's says what that stops (T22 item 3).
export function clearanceText(row: TransferRowForClient): string | undefined {
  const clearance = row.clearance
  if (clearance === null) return row.provider === 'twilio' ? TRANSFERS_COPY.twilioNotCleared : undefined
  if (clearance.withdrawnOn !== null) {
    return clearance.withdrawReason === 'facts_changed'
      ? TRANSFERS_COPY.endedOn(dayText(clearance.withdrawnOn))
      : TRANSFERS_COPY.withdrawnOn(dayText(clearance.withdrawnOn))
  }
  if (clearance.clearedVia === 'bootstrap') return TRANSFERS_COPY.clearedAtSetUp(dayText(clearance.clearedOn))
  return clearance.clearedBy === null
    ? `${TRANSFERS_COPY.cleared}, ${dayText(clearance.clearedOn)}`
    : TRANSFERS_COPY.clearedOn(dayText(clearance.clearedOn), clearance.clearedBy)
}

// The review date as the card says it (PD-13): overdue once passed while the provider is cleared,
// which never ends the clearance; due on the day; else the date. None when no date is recorded.
export function reviewOf(
  row: TransferRowForClient,
  today: string,
): { readonly text: string; readonly overdue: boolean } | undefined {
  if (row.reviewOn === null) return undefined
  if (isCleared(row) && row.reviewOn < today)
    return { text: TRANSFERS_COPY.reviewOverdue(dayText(row.reviewOn)), overdue: true }
  if (isCleared(row) && row.reviewOn === today) return { text: TRANSFERS_COPY.reviewToday, overdue: true }
  return { text: TRANSFERS_COPY.reviewBy(dayText(row.reviewOn)), overdue: false }
}

export interface TransferView {
  readonly provider: NonAiProviderKey
  readonly name: string
  readonly cleared: boolean
  readonly clearance: string | undefined
  readonly review: { readonly text: string; readonly overdue: boolean } | undefined
  readonly facts: readonly Fact[]
  readonly checkedBy: string
  readonly withdrawing: string
  // Why "Clear for use" can't act on the saved facts, or undefined when it can.
  readonly clearHeld: string | undefined
}

const listOr = (codes: readonly string[]) => (codes.length === 0 ? DPO.notRecorded : countryNames(codes))

export function transferView(row: TransferRowForClient, today: string): TransferView {
  const provider = row.provider as NonAiProviderKey
  // The answer's rows are non-AI providers only (PD-27), each with its line.
  const checks = Object.hasOwn(PROVIDER_CHECKS, provider) ? PROVIDER_CHECKS[provider] : PROVIDER_CHECKS.aws_sms
  return {
    provider,
    name: providerName(row.provider),
    cleared: isCleared(row),
    clearance: clearanceText(row),
    review: reviewOf(row, today),
    facts: [
      { term: TRANSFERS_COPY.summary.processes, value: listOr(row.processingCountries) },
      { term: TRANSFERS_COPY.summary.stores, value: listOr(row.storageCountries) },
      {
        term: TRANSFERS_COPY.summary.safeguard,
        value: row.safeguard === null ? DPO.notRecorded : SAFEGUARD_LABELS[row.safeguard],
      },
      { term: TRANSFERS_COPY.summary.kept, value: row.providerRetention ?? DPO.notRecorded },
      { term: TRANSFERS_COPY.summary.onward, value: row.onwardRecipients ?? DPO.notRecorded },
      { term: TRANSFERS_COPY.updated, value: recordedText(row.updatedOn, row.updatedBy, row.updatedBy === null) },
    ],
    checkedBy: checks.checkedBy,
    withdrawing: checks.withdrawing,
    clearHeld: transferProblems(row, today).length === 0 ? undefined : TRANSFERS_COPY.clearHeld,
  }
}

export interface TransferEditor {
  readonly problems: readonly TransferProblem[]
  readonly processingInvalid: boolean
  readonly storageInvalid: boolean
  // The form says something the saved row doesn't.
  readonly changed: boolean
  readonly cleared: boolean
  // Why Save can't act (a country typed wrongly), or undefined.
  readonly saveHeld: string | undefined
  // Why "Save and keep cleared" can't act, or undefined.
  readonly keepClearedHeld: string | undefined
  // A plain Save ends the clearance, so it asks first, as Withdraw does (PD-05).
  readonly saveEndsClearance: boolean
}

export function transferEditor(row: TransferRowForClient, form: TransferForm, today: string): TransferEditor {
  const facts = transferFactsOf(form)
  const processingInvalid = !countriesOf(form.processingCountries).valid
  const storageInvalid = !countriesOf(form.storageCountries).valid
  const problems = transferProblems({ provider: row.provider, ...facts }, today)
  const changed = !sameFacts(facts, rowFacts(row))
  const cleared = isCleared(row)
  const saveHeld = processingInvalid || storageInvalid ? TRANSFERS_COPY.countriesInvalid : undefined
  return {
    problems,
    processingInvalid,
    storageInvalid,
    changed,
    cleared,
    saveHeld,
    keepClearedHeld: saveHeld ?? (problems.length > 0 ? TRANSFERS_COPY.saveKeepClearedHeld : undefined),
    saveEndsClearance: cleared && changed,
  }
}

// The providers the transfer page lists, in the registry's order (PD-27).
