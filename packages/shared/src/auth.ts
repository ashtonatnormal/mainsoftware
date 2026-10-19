// The sign-in and re-authentication contract the web app and the server share (T20, D46).
import { z } from 'zod'

// How a session re-authenticates (D46, AQ-01, AQ-02): `pin` for a session issued under the PIN
// rule, `code` (a fresh SMS code to the session's own number) for everyone else, and `sign_in`
// when only a new sign-in mends the session. The only definition: packages/access imports the
// type, and the web parses the server's refusals with the enum.
export const REAUTH_METHODS = ['pin', 'code', 'sign_in'] as const
export const ReauthMethodSchema = z.enum(REAUTH_METHODS)
export type ReauthMethod = (typeof REAUTH_METHODS)[number]

// How a PIN's state is shown to the person whose PIN it is (T14 item 9): after a correct code at
// step-up, or with a refusal. Never for 'unset', which the flow answers by asking for a new PIN.
export const PinStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ok'), triesBeforeLock: z.number().int(), triesBeforeAdminLock: z.number().int() }),
  z.object({ state: z.literal('locked'), until: z.string() }),
  z.object({ state: z.literal('admin_locked') }),
])
export type PinStateJSON = z.infer<typeof PinStateSchema>

// The api's sign-in replies (T14, T20). The server types its replies with z.input of these, and
// the web app parses them.
export const CodeSentSchema = z.object({
  status: z.literal('code_sent'),
  expiresInSeconds: z.number().int(),
  codeLength: z.number().int(),
})
export type CodeSent = z.infer<typeof CodeSentSchema>

export const SignedInSchema = z.object({
  status: z.literal('signed_in'),
  device: z.object({ id: z.string(), label: z.string() }),
})
export type SignedIn = z.infer<typeof SignedInSchema>

export const CodeVerifiedSchema = z.discriminatedUnion('next', [
  z.object({ status: z.literal('code_verified'), next: z.literal('set_pin') }),
  z.object({
    status: z.literal('code_verified'),
    next: z.literal('step_up'),
    pin: PinStateSchema,
    passkey: z.boolean(),
  }),
])
export type CodeVerified = z.infer<typeof CodeVerifiedSchema>

export const OtpVerifyReplySchema = z.union([SignedInSchema, CodeVerifiedSchema])
export type OtpVerifyReply = z.infer<typeof OtpVerifyReplySchema>

export const ReauthenticatedSchema = z.object({
  status: z.literal('reauthenticated'),
  validForSeconds: z.number().int(),
})
export type Reauthenticated = z.infer<typeof ReauthenticatedSchema>
