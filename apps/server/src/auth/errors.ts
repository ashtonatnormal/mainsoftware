// The api's refusals: a status, a stable code the web app reads, and copy it may show as it is
// (British spelling, short, active, and true in every case). The api scope's error handler sends
// `{ error: code, message, ...extra }` and clears the named cookies; anything that isn't an
// ApiError becomes 500 internal, logged with redaction.
//
// A failure that writes (a wrong PIN's count, a failed passkey's audit row) is returned from the
// transaction's work and becomes an ApiError only after the transaction has committed. A throw
// inside withOrg() rolls back, so throwing is kept for refusals that write nothing.

export const MESSAGES = {
  invalid_request: "That request wasn't understood.",
  invalid_phone:
    'Enter your mobile number starting with + and the country code, or just the 8 digits of a Singapore number.',
  invalid_code: 'Enter the 6-digit code.',
  invalid_pin: 'Your PIN is 6 digits.',
  pin_too_easy: 'Choose a harder PIN. Avoid repeated digits and runs like 123456.',
  too_many_requests: 'Too many tries. Try again later.',
  unavailable: "That isn't available right now. Try again in a few minutes.",
  attempt_expired: 'That sign-in has expired. Start again.',
  wrong_step: 'Start signing in again.',
  code_wrong: "That code isn't right. Check the text and try again.",
  code_dead: 'Too many tries with that code. Send a new one.',
  code_expired: 'That code has expired. Send a new one.',
  pin_wrong: "That PIN isn't right.",
  pin_locked: 'Too many wrong PINs. Wait for the lock to end, then try again.',
  pin_already_set: 'Your PIN is already set. Start signing in again.',
  pin_reset_needed: "Your PIN needs resetting. Ask an admin to reset it. They'll check it's you first.",
  no_passkey: "There's no passkey on your account. Use your PIN.",
  passkey_expired: 'That took too long. Try again.',
  passkey_failed: "That didn't work. Try again or use your PIN.",
  passkey_exists: 'That passkey is already added.',
  signed_out: "You've been signed out. Sign in again to keep using Hearth.",
  reauth_required: "Confirm it's you with your PIN or a passkey first.",
  forbidden: "You can't do that.",
  not_found: "We couldn't find that.",
  no_account: "They haven't signed in yet, so there's no PIN to reset.",
  // The flags route (C0.6, flags/set.ts).
  flag_locked: 'That flag is locked: only a release can change it.',
  purpose_refused: "That feature isn't cleared for use yet.",
  invalid_cohort:
    "That cohort can't be used. Name 1 to 1,000 people of this organisation and roles, or none for everyone.",
  try_again: 'Something else changed this at the same moment. Try again.',
  internal: 'Something went wrong on our side. Try again.',
} as const satisfies Record<string, string>

export type ErrorCode = keyof typeof MESSAGES

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
