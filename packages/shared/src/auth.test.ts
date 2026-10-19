// The sign-in and re-authentication contract the server sends and the web parses (T14, T20, D46,
// AQ-01, AQ-02). One definition of the methods: packages/access decides the method with its type.
import { describe, expect, test } from 'vitest'
import {
  CodeSentSchema,
  ErrorExtrasSchema,
  OtpVerifyReplySchema,
  REAUTH_METHODS,
  ReauthenticatedSchema,
  ReauthMethodSchema,
} from './auth.ts'

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
    expect(ReauthenticatedSchema.parse({ status: 'reauthenticated', validForSeconds: 300 }).validForSeconds).toBe(300)
  })
})

describe("T14 T20: a refusal's extras parse leniently", () => {
  test('T14 PRD-53: tries left, the wait and the PIN state come through as the server sends them', () => {
    const pin = { state: 'locked', until: '2026-10-19T08:00:00.000Z' }
    expect(ErrorExtrasSchema.parse({ error: 'code_wrong', message: 'm', triesLeft: 4 })).toEqual({ triesLeft: 4 })
    expect(ErrorExtrasSchema.parse({ error: 'too_many_requests', retryAfterSeconds: 120 })).toEqual({
      retryAfterSeconds: 120,
    })
    expect(ErrorExtrasSchema.parse({ error: 'pin_locked', pin })).toEqual({ pin })
    expect(ErrorExtrasSchema.parse({ error: 'not_found' })).toEqual({})
  })

  test('T14: a field that does not parse drops only itself, never the refusal', () => {
    expect(
      ErrorExtrasSchema.parse({ triesLeft: 'four', retryAfterSeconds: -1, pin: { state: 'locked' }, extra: 1 }),
    ).toEqual({ triesLeft: undefined, retryAfterSeconds: undefined, pin: undefined })
    expect(ErrorExtrasSchema.parse({ triesLeft: 2, pin: { state: 'unset' } })).toEqual({ triesLeft: 2, pin: undefined })
  })

  test('D46 AQ-02: the method a refusal names, and an unknown one reads as a new sign-in', () => {
    for (const method of REAUTH_METHODS) expect(ErrorExtrasSchema.parse({ method }).method).toBe(method)
    for (const method of ['passkey', 'sms', '', null, 1]) {
      expect(ErrorExtrasSchema.parse({ method }).method, String(method)).toBe('sign_in')
    }
    expect(ErrorExtrasSchema.parse({}).method).toBeUndefined()
  })
})
