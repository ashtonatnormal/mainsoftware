// The re-authentication method a refusal names (T20, D46, AQ-01, AQ-02; AUTH-DESIGN §10.4,
// INTEGRATION.md item 4). C0.16's sheet reads it; C0.8 ships the reading.
import { REAUTH_METHODS } from '@hearth/shared'
import { describe, expect, it } from 'vitest'
import { reauthMethodOf } from './reauth.ts'

describe('T20: reauthMethodOf (api/reauth.ts)', () => {
  it('D46 AQ-01 AQ-02: 403 reauth_required and 409 reauth_method name the session’s method: pin, code or sign_in', () => {
    for (const method of REAUTH_METHODS) {
      expect(reauthMethodOf({ code: 'reauth_required', extra: { method } })).toBe(method)
      expect(reauthMethodOf({ code: 'reauth_method', extra: { method } })).toBe(method)
    }
  })

  it('AUTH-DESIGN §10.4: a refusal with no method reads as sign_in, which always works', () => {
    expect(reauthMethodOf({ code: 'reauth_required', extra: {} })).toBe('sign_in')
  })

  it('any other refusal names no method, whatever its extras say', () => {
    for (const code of ['forbidden', 'signed_out', 'pin_wrong', 'try_again', 'network'])
      expect(reauthMethodOf({ code, extra: { method: 'pin' } })).toBeUndefined()
  })
})
