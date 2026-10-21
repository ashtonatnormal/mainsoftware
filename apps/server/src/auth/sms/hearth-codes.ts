// The SmsProvider for a send-only SMS service (AQ-16; TECH-SPEC T7, T20): Hearth makes the code and
// the TextSender only delivers it. It is the shape the AWS End User Messaging fallback takes, once
// that has its own transfer-register entry (PDPA-10), secret and egress route; taking it over from
// Twilio is a reviewed config change, never an automatic failover (AQ-14).
// - start makes a code (crypto.ts newOtp), sends it, and returns ref = h1.<nonce>.<MAC>, where the
//   MAC is HMAC-SHA256 under the code-MAC key over the nonce and the code. The ref never holds the
//   number or the code.
// - check recomputes the MAC in constant time: approved or wrong, never gone, because expiry,
//   single use and the 5 tries live in the challenge record (auth/codes.ts).
// - cancel does nothing: the record no longer accepts a replaced code.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ProviderKey } from '@hearth/shared'
import { newOtp } from '#src/auth/crypto.ts'
import type { SmsProvider, Verdict } from '#src/auth/sms/provider.ts'

export interface TextSender {
  readonly name: 'aws_sms'
  readonly transfer: ProviderKey
  // Sends `body` to `to` (E.164). Throws an SmsProviderError, never carrying the number or text.
  sendText(to: string, body: string): Promise<void>
}

const REF = /^h1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/

export function hearthCodes(sender: TextSender, keys: { otp: Buffer }): SmsProvider {
  const mac = (nonce: string, code: string) =>
    createHmac('sha256', keys.otp).update(`hearth-code/v1|${nonce}|${code}`).digest()
  return {
    name: sender.name,
    transfer: sender.transfer,
    async start(to) {
      const code = newOtp()
      const nonce = randomBytes(16).toString('base64url')
      await sender.sendText(to, `Your Hearth code is ${code}. Don't share it with anyone.`)
      return { ref: `h1.${nonce}.${mac(nonce, code).toString('base64url')}`, foreign: false }
    },
    async check(ref, code): Promise<Verdict> {
      const match = REF.exec(ref)
      if (match === null) return 'wrong'
      const [, nonce = '', given = ''] = match
      const expected = mac(nonce, code)
      const actual = Buffer.from(given, 'base64url')
      return actual.length === expected.length && timingSafeEqual(actual, expected) ? 'approved' : 'wrong'
    },
    async cancel() {},
  }
}
