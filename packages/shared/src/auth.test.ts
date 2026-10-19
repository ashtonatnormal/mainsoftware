// The re-authentication methods the server names on its refusals and the web parses (T20, D46,
// AQ-01, AQ-02). One definition: packages/access decides the method with this type.
import { describe, expect, test } from 'vitest'
import { REAUTH_METHODS, type ReauthMethod, ReauthMethodSchema } from './auth.ts'

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

  test('T20: the type and the list agree', () => {
    const methods: readonly ReauthMethod[] = REAUTH_METHODS
    expect(methods).toHaveLength(3)
  })
})
