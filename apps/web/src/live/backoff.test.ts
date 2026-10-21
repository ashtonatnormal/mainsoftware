import { describe, expect, it } from 'vitest'
import { abuseDelay, fullJitter, retryAckDelay, withinSpread } from './backoff.ts'
import { TokenBucket } from './bucket.ts'

const ends = [0, 0.25, 0.5, 0.999_999]

describe('T19 item 10: the live connection’s waits (live/backoff.ts)', () => {
  it('BO-01 T21 item 4: withinSpread stays within [0, spread]; full jitter within 1–30 s; abuse from 30 s', () => {
    for (const r of ends) {
      const random = () => r
      const spread = withinSpread(5_000, random)
      expect(spread).toBeGreaterThanOrEqual(0)
      expect(spread).toBeLessThan(5_000)
      expect(withinSpread(-1, random)).toBe(0)
      // The cap of full jitter doubles from 1 s and stops at 30 s.
      const caps = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]
      caps.forEach((cap, failures) => {
        const wait = fullJitter(failures, random)
        expect(wait).toBeGreaterThanOrEqual(0)
        expect(wait).toBeLessThan(cap)
      })
      expect(fullJitter(10_000, random)).toBeLessThan(30_000)
      const abuse = abuseDelay(random)
      expect(abuse).toBeGreaterThanOrEqual(30_000)
      expect(abuse).toBeLessThan(60_000)
    }
    expect(fullJitter(4, () => 0.999_999)).toBe(15_999)
    expect(fullJitter(5, () => 0.999_999)).toBe(29_999)
    expect(abuseDelay(() => 0)).toBe(30_000)
  })

  it('BO-02 T19 item 10 (2): a retried topic waits 1–5 s, doubling with each retry in a row, capped at 30 s', () => {
    expect([0, 1, 2, 3, 4, 20].map(n => retryAckDelay(n, () => 0))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
    ])
    expect([0, 1, 2, 3].map(n => retryAckDelay(n, () => 0.999_999))).toEqual([4_999, 9_999, 19_999, 30_000])
  })

  it('BO-03 T21 item 4: the bucket starts full, refills at its rate, never above its burst, and says how long until a token', () => {
    const bucket = new TokenBucket(18, 4, 0)
    let taken = 0
    while (bucket.take(0)) taken++
    expect(taken).toBe(18)
    expect(bucket.waitMs(0)).toBe(250)
    expect(bucket.take(249)).toBe(false)
    expect(bucket.take(250)).toBe(true)
    expect(bucket.take(250)).toBe(false)
    // A long rest refills to the burst and no further.
    taken = 0
    while (bucket.take(3_600_000)) taken++
    expect(taken).toBe(18)
  })
})
