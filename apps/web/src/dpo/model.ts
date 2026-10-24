// The DPO pages' logic, pure (C0.9 PD-20, PD-25, PD-26, PD-27; TECH-SPEC T22 items 2, 3 and 15),
// in three modules so each page's chunk carries only its own: this one, what both pages share (what
// a refusal asks of the person, days as the app shows them, the cards' facts); purposes-model.ts,
// the processing register's cards and edit; transfers-model.ts, the transfer register's. The rules
// themselves are packages/shared's (purposeProblems, purposeWarnings, transferProblems, statusesFor,
// basesFor), which the server runs before the database and migration 0009 enforces; these modules
// only feed them and word their codes (strings/dpo*.ts). Node tests cover them without a DOM
// (dpo/model.test.ts, DPP-01 to DPP-04).
import { MESSAGES, NON_AI_PROVIDERS, REAUTH_METHOD_MESSAGES } from '@hearth/shared'
import type { ApiFailure } from '@/api/http.ts'
import { reauthMethodOf } from '@/api/reauth.ts'
import { dayText } from '@/lib/time.ts'
import { DPO, type NonAiProviderKey, PROVIDER_NAMES } from '@/strings/dpo.ts'

// --- Refusals (PD-25, PD-30) -------------------------------------------------------------------

// What a refused read or write asks of the person:
//   pin        403 reauth_required {method: 'pin'}: the inline PIN step, then the same call once more
//   sign_in    any other method: only a new sign-in mends the session. A DPO's session is issued
//              under the PIN rule, or can't re-authenticate at all (T20 item 6), and these pages
//              have no texted-code step, so a code method reads the same way
//   forbidden  403 forbidden: someone other than the DPO (a deep link, a role revoked)
//   changed    409 register_changed: the entry changed since the page read it; Reload
//   message    anything else, in the server's own words (or the client's for no answer)
export type Refusal =
  | { readonly kind: 'pin' }
  | { readonly kind: 'sign_in'; readonly text: string }
  | { readonly kind: 'forbidden'; readonly text: string }
  | { readonly kind: 'changed'; readonly text: string }
  | { readonly kind: 'message'; readonly text: string }

export type FailureLike = Pick<ApiFailure, 'code' | 'serverMessage' | 'extra'>

export function refusalOf(failure: FailureLike): Refusal {
  const method = reauthMethodOf(failure)
  if (method === 'pin') return { kind: 'pin' }
  if (method !== undefined) return { kind: 'sign_in', text: REAUTH_METHOD_MESSAGES.sign_in.required }
  if (failure.code === 'forbidden') return { kind: 'forbidden', text: DPO.forbidden }
  if (failure.code === 'register_changed') return { kind: 'changed', text: failure.serverMessage }
  return { kind: 'message', text: failure.serverMessage }
}

// What was thrown, as a failure: an api failure as it is; anything else (a bug) as the generic one.
export function failureOf(error: unknown): FailureLike {
  if (typeof error === 'object' && error !== null && 'code' in error && 'serverMessage' in error && 'extra' in error) {
    return error as FailureLike
  }
  return { code: 'internal', serverMessage: MESSAGES.internal, extra: {} }
}

export const refusalOfError = (error: unknown): Refusal => refusalOf(failureOf(error))

// The PIN step's own refusals (POST /api/auth/reauth/pin): a session that re-authenticates some
// other way (409 reauth_method) can only sign in again; a PIN that needs an Owner's reset (409
// pin_reset_needed, or 423 pin_locked once the lock needs one: pin.state admin_locked) says so in
// these pages' words, since the server's say "Ask"; anything else (a wrong PIN, a lock that ends, a
// limit, no answer) is said on the field, in the server's words.
export type PinOutcome =
  | { readonly kind: 'field'; readonly text: string }
  | { readonly kind: 'sign_in'; readonly text: string }

export function pinOutcomeOf(failure: FailureLike): PinOutcome {
  const method = reauthMethodOf(failure)
  if (method !== undefined && method !== 'pin') return { kind: 'sign_in', text: REAUTH_METHOD_MESSAGES.sign_in.method }
  if (failure.code === 'pin_reset_needed') return { kind: 'field', text: DPO.reauth.pinResetNeeded }
  if (failure.code === 'pin_locked' && failure.extra.pin?.state === 'admin_locked') {
    return { kind: 'field', text: DPO.reauth.pinAdminLocked }
  }
  return { kind: 'field', text: failure.serverMessage }
}

// The toast once a write lands: its own line only when it changed something; a write that changed
// nothing wrote nothing (PD-21), so the page doesn't say it did.
export const landedText = (result: { readonly changed: boolean }, savedText: string): string =>
  result.changed ? savedText : DPO.nothingChanged

// A PIN is 6 digits; anything else is said before it is sent.
export function pinEntryProblem(pin: string): string | undefined {
  return /^[0-9]{6}$/.test(pin) ? undefined : MESSAGES.invalid_pin
}

// --- Days ----------------------------------------------------------------------------------------

// A day the answer gives, as the app shows dates (lib/time.ts, where Settings reads it too without
// loading the DPO's chunk; C0.9 PD-75).
export { dayText }

// --- What both registers' cards share ------------------------------------------------------------

export const providerName = (key: string): string =>
  Object.hasOwn(PROVIDER_NAMES, key) ? PROVIDER_NAMES[key as NonAiProviderKey] : key

// Who recorded a version: Hearth for version 1 (and the starting facts), else the name, when the
// answer could read it.
export function recordedText(day: string, name: string | null, hearths: boolean): string {
  if (hearths) return `${DPO.byHearth}, ${dayText(day)}`
  return name === null ? dayText(day) : DPO.recordedOn(dayText(day), name)
}

export interface Fact {
  readonly term: string
  readonly value: string
  // A value of several lines, kept as they are (a postal address).
  readonly lines?: boolean
}

// Typed text as the register stores it: trimmed, and none when blank.
export const textOrNull = (text: string): string | null => (text.trim() === '' ? null : text.trim())

// The providers the pages list, in the registry's order (PD-27).
export const SHOWN_PROVIDERS: readonly NonAiProviderKey[] = NON_AI_PROVIDERS as readonly NonAiProviderKey[]
