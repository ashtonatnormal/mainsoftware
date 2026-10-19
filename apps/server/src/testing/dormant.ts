// What only the dormant passkey code answers or writes (D46: passkeys kept, switched off). The live
// sign-in suite skips these in its "every error code and audit action was seen" sweep, since with
// passkeys off nothing can reach them; the dormant suite (auth/passkeys.integration.test.ts), which
// switches passkeys on, requires every one of them instead.
import type { AuditAction } from '#src/auth/audit.ts'
import type { ErrorCode } from '#src/auth/errors.ts'

export const DORMANT_ERRORS: ReadonlySet<ErrorCode> = new Set([
  'no_passkey',
  'passkey_expired',
  'passkey_failed',
  'passkey_exists',
])

export const DORMANT_ACTIONS: ReadonlySet<AuditAction> = new Set([
  'auth.passkey_added',
  'auth.passkey_removed',
  'auth.passkey_failed',
])
