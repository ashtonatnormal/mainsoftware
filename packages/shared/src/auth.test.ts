// The re-authentication methods the server names on its refusals and the web parses (T20, D46,
// AQ-01, AQ-02). One definition: packages/access decides the method with this type.
import { describe, expect, test } from 'vitest'
import { CodeSentSchema, OtpVerifyReplySchema, REAUTH_METHODS, ReauthMethodSchema } from './auth.ts'

describe('T20 D46: the re-authentication methods', () => {
  test('D46 AQ-01 AQ-02: the methods are the PIN, an SMS code and a new sign-in, nothing else', () => {
    expect([...REAUTH_METHODS]).toEqual(['pin', 'code', 'sign_in'])
    for (const method of REAUTH_METHODS) expect(ReauthMethodSchema.parse(method)).toBe(method)
  })

  test('D46: the schema refuses anything else, passkeys and plain SMS included', () => {
    for (const value of ['passkey', 'sms', 'PIN', 'sign-in', '', null, undefined, 1, {}]) {
      expect(ReauthMethodSchema.safeParse(value).success, String(value)).toBe(false)
    }
  })
})

describe('T14 T20: the sign-in replies parse as the server sends them', () => {
  test('T14: code_sent, signed_in and both code_verified shapes', () => {
    expect(CodeSentSchema.parse({ status: 'code_sent', expiresInSeconds: 300, codeLength: 6 }).codeLength).toBe(6)
    expect(OtpVerifyReplySchema.parse({ status: 'signed_in', device: { id: 'd', label: 'Phone' } }).status).toBe(
      'signed_in',
    )
    expect(OtpVerifyReplySchema.safeParse({ status: 'code_verified', next: 'set_pin' }).success).toBe(true)
    const pin = { state: 'ok', triesBeforeLock: 5, triesBeforeAdminLock: 10 }
    expect(
      OtpVerifyReplySchema.safeParse({ status: 'code_verified', next: 'step_up', pin, passkey: false }).success,
    ).toBe(true)
    expect(OtpVerifyReplySchema.safeParse({ status: 'code_verified', next: 'step_up' }).success).toBe(false)
  })
})
