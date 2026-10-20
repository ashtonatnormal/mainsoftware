// The sign-in screens' calls (T20; T21 item 13): the one
// file in apps/web that knows the sign-in contract. Each call posts through api/http.ts (relative
// /api paths, same-origin credentials, no-store) and reads its answer with the shared schema
// (packages/shared auth.ts), so a reply the server changes fails here, not on a screen:
// - requestCode: POST /api/auth/otp/request {phone} → 200 code_sent {expiresInSeconds, codeLength},
//   the same answer for any number (PRD-53);
// - verifyCode: POST /api/auth/otp/verify {code} → 200 signed_in (Member, Team Admin), or
//   code_verified {next: 'set_pin'} or {next: 'step_up', pin} for a holder of a PIN role (D46,
//   AQ-02);
// - setPin, enterPin: POST /api/auth/pin/set and /pin/verify {pin} → 200 signed_in.
// A refusal arrives as an ApiFailure with the server's code, message and extras; sign-in-model.ts
// decides by the code alone.
//
// Two rules hold for every call:
// - it is abandoned after 20 s (AUTH_TIMEOUT_MS), which covers a provider's 4 s check plus the 2 s
//   floor on a wrong code with room to spare, and the abandoned call reads as a network failure;
// - a 409 try_again (a row lock not granted in time) is sent once more, after 0.5 to 1.5 s, before
//   it is shown: the server refused before writing anything, and an attempt whose code was right
//   stays verified, so the repeat finishes the sign-in with the same body. A second try_again, and
//   every other refusal (a 503 included: the person sees it and presses again), is shown as it is.
import {
  type CodeSent,
  CodeSentSchema,
  type OtpVerifyReply,
  OtpVerifyReplySchema,
  type SignedIn,
  SignedInSchema,
} from '@hearth/shared'
import type { z } from 'zod'
import { ApiFailure, type ApiPath, apiPost } from '@/api/http.ts'

export const AUTH_TIMEOUT_MS = 20_000
// The wait before the one repeat of a try_again: 0.5 s plus up to 1 s more, at random.
export const RETRY_MIN_MS = 500
export const RETRY_SPREAD_MS = 1_000

export interface AuthCallEnv {
  // The fetch to use; the browser's own when absent.
  fetch?: typeof fetch
  // A signal that aborts after this long (AbortSignal.timeout).
  signalAfter(ms: number): AbortSignal
  sleep(ms: number): Promise<void>
  random(): number
}

export const browserAuthEnv = (): AuthCallEnv => ({
  signalAfter: ms => AbortSignal.timeout(ms),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  random: () => Math.random(),
})

const isTryAgain = (error: unknown) => error instanceof ApiFailure && error.code === 'try_again'

async function post<T>(path: ApiPath, body: unknown, schema: z.ZodType<T>, env: AuthCallEnv): Promise<T> {
  const once = async () =>
    (await apiPost(path, body, schema, { fetch: env.fetch, signal: env.signalAfter(AUTH_TIMEOUT_MS) })) as T
  try {
    return await once()
  } catch (error) {
    if (!isTryAgain(error)) throw error
  }
  await env.sleep(RETRY_MIN_MS + env.random() * RETRY_SPREAD_MS)
  return once()
}

// The number as the phone step read it (normalisePhone): the server reads it the same way.
export function requestCode(phone: string, env: AuthCallEnv = browserAuthEnv()): Promise<CodeSent> {
  return post('/api/auth/otp/request', { phone }, CodeSentSchema, env)
}

export function verifyCode(code: string, env: AuthCallEnv = browserAuthEnv()): Promise<OtpVerifyReply> {
  return post('/api/auth/otp/verify', { code }, OtpVerifyReplySchema, env)
}

export function setPin(pin: string, env: AuthCallEnv = browserAuthEnv()): Promise<SignedIn> {
  return post('/api/auth/pin/set', { pin }, SignedInSchema, env)
}

export function enterPin(pin: string, env: AuthCallEnv = browserAuthEnv()): Promise<SignedIn> {
  return post('/api/auth/pin/verify', { pin }, SignedInSchema, env)
}

// The calls as one object, which the screen's controller takes (and its tests replace).
export interface SignInApi {
  requestCode(phone: string): Promise<CodeSent>
  verifyCode(code: string): Promise<OtpVerifyReply>
  setPin(pin: string): Promise<SignedIn>
  enterPin(pin: string): Promise<SignedIn>
}

export const signInApi: SignInApi = {
  requestCode: phone => requestCode(phone),
  verifyCode: code => verifyCode(code),
  setPin: pin => setPin(pin),
  enterPin: pin => enterPin(pin),
}
