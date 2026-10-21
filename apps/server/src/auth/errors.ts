// The api's refusals: a status, a stable code the web app reads, and copy it may show as it is
// (British spelling, short, active, and true in every case). The api scope's error handler sends
// `{ error: code, message, ...extra }` and clears the named cookies; anything that isn't an
// ApiError becomes 500 internal, logged with redaction.
//
// A failure that writes (a wrong PIN's count, a failed passkey's audit row) is returned from the
// transaction's work and becomes an ApiError only after the transaction has committed. A throw
// inside withOrg() rolls back, so throwing is kept for refusals that write nothing.

import {
  type ErrorCode,
  type ErrorExtrasSchema,
  MESSAGES,
  REAUTH_METHOD_MESSAGES,
  type ReauthMethod,
} from '@hearth/shared'
import type { z } from 'zod'

export { type ErrorCode, MESSAGES }

// The extras a refusal may carry, as the shared contract types them (packages/shared), so the
// server can't send one the web app doesn't read.
type Extras = z.input<typeof ErrorExtrasSchema>

// pin_locked's copy when an admin reset is needed (in practice an Owner's): the extra's pin.state
// is admin_locked.
export const PIN_ADMIN_LOCKED_MESSAGE = "Your PIN is locked. Ask an Owner to reset it. They'll check it's you first."

export class ApiError extends Error {
  override name = 'ApiError'
  readonly status: number
  readonly code: ErrorCode
  readonly extra: Extras
  readonly clear: readonly ('session' | 'attempt')[]
  // The acting person, on a re-authentication refusal (reauthRefusal): the error handler logs
  // reauth_wrong_method on a 409 reauth_method, and pin_rule_session_mismatch when the method is
  // sign_in, with this id and no other personal data (D46). Never sent.
  readonly person: string | undefined

  constructor(
    status: number,
    code: ErrorCode,
    extra: Extras = {},
    clear: readonly ('session' | 'attempt')[] = [],
    person?: string,
  ) {
    super(code)
    this.status = status
    this.code = code
    this.extra = extra
    this.clear = clear
    this.person = person
  }
}

// 403 reauth_required or 409 reauth_method naming the session's method (D46, AQ-01).
export function reauthRefusal(
  code: 'reauth_required' | 'reauth_method',
  method: ReauthMethod,
  person: string,
): ApiError {
  return new ApiError(code === 'reauth_required' ? 403 : 409, code, { method }, [], person)
}

// The copy to send with an error: MESSAGES, except pin_locked when an admin reset is needed (in
// practice an Owner's), and reauth_required and reauth_method, which name the method when they
// carry one.
export function messageFor(error: ApiError): string {
  if (error.code === 'pin_locked' && error.extra.pin?.state === 'admin_locked') return PIN_ADMIN_LOCKED_MESSAGE
  const method = error.extra.method
  if (method !== undefined && error.code === 'reauth_required') return REAUTH_METHOD_MESSAGES[method].required
  if (method !== undefined && error.code === 'reauth_method') return REAUTH_METHOD_MESSAGES[method].method
  return MESSAGES[error.code]
}

// Postgres errors that mean another transaction got there first: a deadlock (40P01), a
// serialisation failure (40001), or a lock that wasn't granted in time or at once (55P03, from
// lock_timeout or NOWAIT). Each answers 409 try_again, and the client tries once more. Anything
// else gives undefined, and the caller rethrows it.
const CONFLICTS = new Set(['40P01', '40001', '55P03'])

export function fromDatabase(error: unknown): ApiError | undefined {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  return typeof code === 'string' && CONFLICTS.has(code) ? new ApiError(409, 'try_again') : undefined
}
