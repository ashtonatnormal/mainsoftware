import { describe, expect, it } from 'vitest'
import { ApiError, fromDatabase, MESSAGES, messageFor, PIN_ADMIN_LOCKED_MESSAGE } from '#src/auth/errors.ts'

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

  it('carries its extras and the cookies to clear', () => {
    const error = new ApiError(401, 'attempt_expired', {}, ['attempt'])
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('attempt_expired')
    expect(error.clear).toEqual(['attempt'])
    expect(new ApiError(429, 'too_many_requests', { retryAfterSeconds: 60 }).extra).toEqual({ retryAfterSeconds: 60 })
  })
})
