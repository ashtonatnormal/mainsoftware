// The api's error codes and the copy that goes with each (T14, T20): the server sends them, and the
// web app reads the code and may show the copy as it is (British spelling, short, active, and true
// in every case).

import type { ReauthMethod } from './auth.ts'

export const MESSAGES = {
  invalid_request: "That request wasn't understood.",
  invalid_phone:
    'Enter your mobile number starting with + and the country code, or just the 8 digits of a Singapore number.',
  invalid_code: 'Enter the 6-digit code.',
  invalid_pin: 'Your PIN is 6 digits.',
  pin_too_easy: 'Choose a harder PIN. Avoid repeated digits, runs like 123456 and common PINs.',
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
  pin_reset_needed: "Your PIN needs resetting. Ask an Owner to reset it. They'll check it's you first.",
  no_passkey: "There's no passkey on your account. Use your PIN.",
  passkey_expired: 'That took too long. Try again.',
  passkey_failed: "That didn't work. Try again or use your PIN.",
  passkey_exists: 'That passkey is already added.',
  signed_out: "You've been signed out. Sign in again to keep using Hearth.",
  reauth_required: "Confirm it's you, then try again.",
  // The session re-authenticates another way (D46); the copy names it (REAUTH_METHOD_MESSAGES).
  reauth_method: "Confirm it's you another way.",
  no_number: "There's no mobile number on your account. Ask an admin to add one.",
  forbidden: "You can't do that.",
  not_found: "We couldn't find that.",
  no_pin: "They haven't set a PIN, so there's nothing to reset.",
  // The flags route (C0.6, apps/server/src/flags/set.ts).
  flag_locked: 'That flag is locked: only a release can change it.',
  purpose_refused: "That feature isn't cleared for use yet.",
  invalid_cohort:
    "That cohort can't be used. Name 1 to 1,000 people still at this organisation and roles, or none for everyone.",
  // Read at sign-in too, where nothing the person sees has changed (AUTH-DESIGN §10.3).
  try_again: 'Something else happened at the same moment. Try again.',
  internal: 'Something went wrong on our side. Try again.',
} as const satisfies Record<string, string>

export type ErrorCode = keyof typeof MESSAGES

// What reauth_required and reauth_method say once the server names the method (D46, AQ-01): the
// first copy for a refused action, the second for a re-authentication route that isn't the
// session's own.
export const REAUTH_METHOD_MESSAGES = {
  pin: { required: "Confirm it's you with your PIN first.", method: "Confirm it's you with your PIN." },
  code: {
    required: "Confirm it's you with a code we text you first.",
    method: "Confirm it's you with a code we text you.",
  },
  sign_in: {
    required: 'Your account has changed. Sign out and sign in again to carry on.',
    method: 'Your account has changed. Sign out and sign in again to carry on.',
  },
} as const satisfies Record<ReauthMethod, { required: string; method: string }>
