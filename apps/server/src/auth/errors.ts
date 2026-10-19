// The api's refusals: a status, a stable code the web app reads, and copy it may show as it is
// (British spelling, short, active, and true in every case). The api scope's error handler sends
// `{ error: code, message, ...extra }` and clears the named cookies; anything that isn't an
// ApiError becomes 500 internal, logged with redaction.
//
// A failure that writes (a wrong PIN's count, a failed passkey's audit row) is returned from the
// transaction's work and becomes an ApiError only after the transaction has committed. A throw
// inside withOrg() rolls back, so throwing is kept for refusals that write nothing.

import { type ErrorCode, MESSAGES } from '@hearth/shared'

export { type ErrorCode, MESSAGES }

// pin_locked's copy when only an admin can lift the lock (the extra's pin.state is admin_locked).
export const PIN_ADMIN_LOCKED_MESSAGE = "Your PIN is locked. Ask an admin to reset it. They'll check it's you first."

export class ApiError extends Error {
  override name = 'ApiError'
  readonly status: number
  readonly code: ErrorCode
  readonly extra: Record<string, unknown>
  readonly clear: readonly ('session' | 'attempt')[]

  constructor(
    status: number,
    code: ErrorCode,
    extra: Record<string, unknown> = {},
    clear: readonly ('session' | 'attempt')[] = [],
  ) {
    super(code)
    this.status = status
    this.code = code
    this.extra = extra
    this.clear = clear
  }
}

// The copy to send with an error: MESSAGES, except pin_locked when only an admin can lift it.
export function messageFor(error: ApiError): string {
  const pin = error.extra.pin as { state?: unknown } | undefined
  if (error.code === 'pin_locked' && pin?.state === 'admin_locked') return PIN_ADMIN_LOCKED_MESSAGE
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
