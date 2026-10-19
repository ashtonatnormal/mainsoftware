// The sign-in and re-authentication contract the web app and the server share (T20, D46).
import { z } from 'zod'

// How a session re-authenticates (D46, AQ-01, AQ-02): `pin` for a session issued under the PIN
// rule, `code` (a fresh SMS code to the session's own number) for everyone else, and `sign_in`
// when only a new sign-in mends the session. The only definition: packages/access imports the
// type, and the web parses the server's refusals with the enum.
export const REAUTH_METHODS = ['pin', 'code', 'sign_in'] as const
export const ReauthMethodSchema = z.enum(REAUTH_METHODS)
export type ReauthMethod = (typeof REAUTH_METHODS)[number]
