// Which way a refused admin request asks the person to confirm it's them (T20 item 6, D46, AQ-01,
// AQ-02; T21 item 13). The server decides it in the transaction that refuses, from the session and
// the roles it has just read, and names it on the refusal: 403 reauth_required {method} on the
// admin request, 409 reauth_method {method} on a re-authentication route that isn't the session's
// own. So the client never guesses and never holds a stale copy:
// - 'pin': the PIN (a session issued under the PIN rule);
// - 'code': a fresh code texted to the session's own number (everyone else);
// - 'sign_in': only signing out and in again mends the session (its roles changed under it).
// A method this build doesn't know, or none, reads as 'sign_in', which always works (the shared
// extras schema reads an unknown one that way already, api/http.ts).
//
// C0.8 ships this reading and the fields the sheet reuses (ui/CodeField.tsx, ui/PinField.tsx).
// C0.9's DPO pages, the first admin actions in the UI, confirm the PIN inline and retry once
// (dpo/ReauthPin.tsx, T22 item 15); C0.16's sheet replaces that step (T20).
import type { ReauthMethod } from '@hearth/shared'
import type { ApiFailure } from './http.ts'

export const REAUTH_REFUSALS = ['reauth_required', 'reauth_method'] as const

// The method a refusal names, or undefined when it isn't a re-authentication refusal.
export function reauthMethodOf(failure: Pick<ApiFailure, 'code' | 'extra'>): ReauthMethod | undefined {
  if (!(REAUTH_REFUSALS as readonly string[]).includes(failure.code)) return undefined
  return failure.extra.method ?? 'sign_in'
}
