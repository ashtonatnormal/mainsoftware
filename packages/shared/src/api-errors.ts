// The api's error codes and the copy that goes with each (T14, T20): the server sends them, and the
// web app reads the code and may show the copy as it is (British spelling, short, active, and true
// in every case).

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
  // The flags route (C0.6, apps/server/src/flags/set.ts).
  flag_locked: 'That flag is locked: only a release can change it.',
  purpose_refused: "That feature isn't cleared for use yet.",
  invalid_cohort:
    "That cohort can't be used. Name 1 to 1,000 people still at this organisation and roles, or none for everyone.",
  try_again: 'Something else changed this at the same moment. Try again.',
  internal: 'Something went wrong on our side. Try again.',
} as const satisfies Record<string, string>

export type ErrorCode = keyof typeof MESSAGES
