import { describe, expect, it } from 'vitest'
import {
  ApiError,
  fromDatabase,
  MESSAGES,
  messageFor,
  PIN_ADMIN_LOCKED_MESSAGE,
  reauthRefusal,
} from '#src/auth/errors.ts'

describe('C0.5 api errors', () => {
  it('turns a deadlock, a serialisation failure and a lock not granted into 409 try_again', () => {
    for (const code of ['40P01', '40001', '55P03']) {
      const error = fromDatabase(Object.assign(new Error('could not obtain lock'), { code }))
      expect(error).toBeInstanceOf(ApiError)
      expect(error).toMatchObject({ status: 409, code: 'try_again', extra: {}, clear: [] })
    }
  })

  it('leaves anything else to the caller to rethrow', () => {
    for (const error of [
      Object.assign(new Error('duplicate key'), { code: '23505' }),
      Object.assign(new Error('check'), { code: '23514' }),
      Object.assign(new Error('econnrefused'), { code: 'ECONNREFUSED' }),
      new Error('plain'),
      'a string',
      undefined,
      null,
      { code: 40001 },
    ]) {
      expect(fromDatabase(error)).toBeUndefined()
    }
  })

  it('has British copy for every code, and the admin wording for an admin lock', () => {
    for (const [code, message] of Object.entries(MESSAGES)) {
      expect(code).toMatch(/^[a-z_]+$/)
      expect(message.length, code).toBeGreaterThan(0)
      expect(message, code).toMatch(/[.!]$/)
    }
    expect(Object.values(MESSAGES).join(' ')).not.toMatch(/\b(?:color|authorize|organization|canceled)\b/i)
    expect(messageFor(new ApiError(423, 'pin_locked', { pin: { state: 'locked', until: 'x' } }))).toBe(
      MESSAGES.pin_locked,
    )
    expect(messageFor(new ApiError(423, 'pin_locked', { pin: { state: 'admin_locked' } }))).toBe(
      PIN_ADMIN_LOCKED_MESSAGE,
    )
    // It names the + that someone who typed their country code without one is missing.
    expect(messageFor(new ApiError(400, 'invalid_phone'))).toBe(
      'Enter your mobile number starting with + and the country code, or just the 8 digits of a Singapore number.',
    )
    // It claims nothing about an id that never existed or is someone else's.
    expect(messageFor(new ApiError(404, 'not_found'))).toBe("We couldn't find that.")
  })

  it('ACC-06 D46 AQ-02: the PIN-reset copy asks an Owner, and no_pin says there is nothing to reset', () => {
    // Only PIN-role holders have a PIN, and only an Owner resets one (T14 item 12).
    expect(MESSAGES.pin_reset_needed).toBe(
      "Your PIN needs resetting. Ask an Owner to reset it. They'll check it's you first.",
    )
    expect(messageFor(new ApiError(423, 'pin_locked', { pin: { state: 'admin_locked' } }))).toBe(
      "Your PIN is locked. Ask an Owner to reset it. They'll check it's you first.",
    )
    expect(messageFor(new ApiError(409, 'no_pin'))).toBe("They haven't set a PIN, so there's nothing to reset.")
    expect(Object.keys(MESSAGES)).not.toContain('no_account')
  })

  it('carries its extras and the cookies to clear', () => {
    const error = new ApiError(401, 'attempt_expired', {}, ['attempt'])
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('attempt_expired')
    expect(error.clear).toEqual(['attempt'])
    expect(new ApiError(429, 'too_many_requests', { retryAfterSeconds: 60 }).extra).toEqual({ retryAfterSeconds: 60 })
  })

  it('D46 AQ-01: reauth_required and reauth_method name the method in their copy, and carry the person for the log only', () => {
    expect(messageFor(new ApiError(403, 'reauth_required'))).toBe("Confirm it's you, then try again.")
    const cases = [
      ['pin', "Confirm it's you with your PIN first.", "Confirm it's you with your PIN."],
      ['code', "Confirm it's you with a code we text you first.", "Confirm it's you with a code we text you."],
      [
        'sign_in',
        'Your account has changed. Sign out and sign in again to carry on.',
        'Your account has changed. Sign out and sign in again to carry on.',
      ],
    ] as const
    for (const [method, required, other] of cases) {
      const refused = reauthRefusal('reauth_required', method, 'p-1')
      expect(refused).toMatchObject({ status: 403, code: 'reauth_required', extra: { method }, person: 'p-1' })
      expect(messageFor(refused)).toBe(required)
      const wrong = reauthRefusal('reauth_method', method, 'p-1')
      expect(wrong).toMatchObject({ status: 409, code: 'reauth_method', extra: { method } })
      expect(messageFor(wrong)).toBe(other)
    }
    expect(messageFor(new ApiError(409, 'no_number'))).toBe(MESSAGES.no_number)
  })
})
