import { describe, expect, it } from 'vitest'
import { otpChecks } from '#src/api.ts'
import { OTP, PASSKEYS_ON, PIN_RULE_SESSION, SESSION } from '#src/auth/policy.ts'

// '168 hours' → seconds.
const seconds = (lifetime: string) => {
  const [n, unit] = lifetime.split(' ')
  if (unit !== 'hours') throw new Error(`a lifetime not in hours: ${lifetime}`)
  return Number(n) * 3600
}

describe('D46 T20 the sign-in policy constants', () => {
  it('AQ-05/06: a PIN-rule session is shorter than a normal one, and each lifetime matches its seconds', () => {
    expect(PIN_RULE_SESSION.lifetimeSeconds).toBeLessThan(SESSION.lifetimeSeconds)
    expect(seconds(PIN_RULE_SESSION.lifetime)).toBe(PIN_RULE_SESSION.lifetimeSeconds)
    expect(seconds(SESSION.lifetime)).toBe(SESSION.lifetimeSeconds)
  })

  it('AQ-04 AQ-20: the floor is 2 s and the breaker opens for 30 s after 3 failures in 60 s', () => {
    expect(OTP.verifyFloorMs).toBe(2_000)
    expect(OTP.breaker).toEqual({ failures: 3, windowMs: 60_000, openMs: 30_000 })
  })

  it('registerApi without an override builds api.otp from OTP', () => {
    const otp = otpChecks({})
    expect(otp.verifyFloorMs).toBe(2_000)
    expect(otp.breaker.policy).toEqual(OTP.breaker)
    expect(otpChecks({ otpForTests: { verifyFloorMs: 0 } }).verifyFloorMs).toBe(0)
  })

  it('D46: passkeys stay switched off, so turning them on is a reviewed change', () => {
    expect(PASSKEYS_ON).toBe(false)
  })
})
