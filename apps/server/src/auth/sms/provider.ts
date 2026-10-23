// How sign-in and re-authentication codes reach a phone (CLAUDE.md: one interface per swappable
// provider; TECH-SPEC T20). The provider makes, sends and checks the code (Twilio Verify, AQ-03);
// Hearth's own rules (5 minutes, 5 tries, the newest request wins, the code bound to the attempt
// that asked for it, PRD-53's windows) live in the challenge record (auth/codes.ts), so the same
// sign-in code is tested whatever sits behind this interface. The implementations: twilio.ts
// (Twilio Verify, the primary), fake.ts (the local fake) and hearth-codes.ts over a TextSender (the
// shape the AWS End User Messaging fallback takes). Each outside provider is asked to send only
// while its entry in the org's transfer register is cleared (PDPA-10; compliance/transfers.ts,
// TECH-SPEC T22 item 8).
// An implementation never puts the number, the code or a provider's message (which can quote the
// number) in an error it throws or logs, because errors are logged.
import type { ProviderKey } from '@hearth/shared'

// gone: the provider no longer holds a pending code for the reference (expired, cancelled,
// already used, or past its own check cap).
export type Verdict = 'approved' | 'wrong' | 'gone'

export interface SmsProvider {
  readonly name: 'twilio' | 'aws_sms' | 'fake'
  // The transfer-register entry this provider needs cleared before it may receive a number
  // (PDPA-10, C0.9). null for the local fake, which sends nothing anywhere.
  readonly transfer: ProviderKey | null
  // Sends a code to `to` (E.164). ref is the provider's opaque reference for it and never holds the
  // number or the code. foreign: the provider handed back a pending verification this call didn't
  // create (Twilio reuses one for the same number); the deliverer then cancels it and starts once
  // more (sign-in.ts).
  start(to: string): Promise<{ ref: string; foreign: boolean }>
  // Never retried: a check may have landed even when its reply was lost.
  check(ref: string, code: string): Promise<Verdict>
  // Best effort; an unknown or finished reference counts as done.
  cancel(ref: string): Promise<void>
}

export type SmsProviderErrorKind = 'invalid_number' | 'blocked' | 'send_limit' | 'unavailable' | 'auth' | 'bug'

// A provider's failure. It never carries the number, the code or the provider's message.
export class SmsProviderError extends Error {
  override name = 'SmsProviderError'
  readonly kind: SmsProviderErrorKind
  readonly providerCode: number | undefined
  readonly httpStatus: number | undefined
  constructor(kind: SmsProviderErrorKind, providerCode?: number, httpStatus?: number) {
    super(kind)
    this.kind = kind
    this.providerCode = providerCode
    this.httpStatus = httpStatus
  }
}
