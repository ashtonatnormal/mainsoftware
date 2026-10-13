import { describe, expect, it } from 'vitest'
import { pinState } from '#src/auth/pin-lock.ts'

const now = new Date('2026-10-13T09:00:00Z')
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000)
const HASH = '$argon2id$…'

describe('PRD-53 ACC-02 ACC-06 pinState', () => {
  it('is unset with no hash, whatever the count', () => {
    expect(pinState({ pinHash: null, failures: 0, lastFailedAt: null }, now)).toEqual({ state: 'unset' })
    expect(pinState({ pinHash: null, failures: 10, lastFailedAt: minutesAgo(1) }, now)).toEqual({ state: 'unset' })
  })

  it('is ok for 0 to 4 failures, with 5 to 1 tries before the lock', () => {
    for (let failures = 0; failures <= 4; failures++) {
      expect(pinState({ pinHash: HASH, failures, lastFailedAt: failures === 0 ? null : minutesAgo(0) }, now)).toEqual({
        state: 'ok',
        triesBeforeLock: 5 - failures,
        triesBeforeAdminLock: 10 - failures,
      })
    }
  })

  it('locks for 15 minutes at the 5th failure', () => {
    expect(pinState({ pinHash: HASH, failures: 5, lastFailedAt: now }, now)).toEqual({
      state: 'locked',
      until: new Date(now.getTime() + 15 * 60_000),
    })
    expect(pinState({ pinHash: HASH, failures: 5, lastFailedAt: minutesAgo(14) }, now)).toEqual({
      state: 'locked',
      until: new Date(now.getTime() + 60_000),
    })
  })

  it('allows one more try once the lock has ended, and each later failure locks again', () => {
    expect(pinState({ pinHash: HASH, failures: 5, lastFailedAt: minutesAgo(16) }, now)).toEqual({
      state: 'ok',
      triesBeforeLock: 1,
      triesBeforeAdminLock: 5,
    })
    // Exactly 15 minutes on, the lock has ended.
    expect(pinState({ pinHash: HASH, failures: 5, lastFailedAt: minutesAgo(15) }, now).state).toBe('ok')
    expect(pinState({ pinHash: HASH, failures: 9, lastFailedAt: minutesAgo(1) }, now)).toEqual({
      state: 'locked',
      until: new Date(now.getTime() + 14 * 60_000),
    })
    expect(pinState({ pinHash: HASH, failures: 9, lastFailedAt: minutesAgo(20) }, now)).toEqual({
      state: 'ok',
      triesBeforeLock: 1,
      triesBeforeAdminLock: 1,
    })
  })

  it('stays locked until an admin resets it from the 10th failure, however long ago', () => {
    for (const lastFailedAt of [now, minutesAgo(16), minutesAgo(60 * 24 * 365)]) {
      expect(pinState({ pinHash: HASH, failures: 10, lastFailedAt }, now)).toEqual({ state: 'admin_locked' })
    }
    expect(pinState({ pinHash: HASH, failures: 11, lastFailedAt: now }, now)).toEqual({ state: 'admin_locked' })
  })
})
