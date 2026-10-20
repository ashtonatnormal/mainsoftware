// The code challenge's scripts (codes.ts) on the Compose stack's Valkey (TECH-SPEC T14 item 4, T20,
// PRD-53), each test under its own random key prefix. `npm run test:integration` runs it, with the
// stack up (`docker compose up -d --wait`).
import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { attachCode, openCode, reserveCode, type Settled, settleCode } from '#src/auth/codes.ts'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'

let valkey: Redis
const prefix = `it:${randomUUID()}:`
const keys = valkeyKeys(prefix)

beforeAll(async () => {
  valkey = new Redis(process.env.VALKEY_URL ?? 'redis://127.0.0.1:6379', { lazyConnect: true, maxRetriesPerRequest: 1 })
  await valkey.connect()
})

afterAll(async () => {
  const found = await valkey.keys(`${prefix}*`)
  if (found.length > 0) await valkey.del(...found)
  await valkey.quit()
})

// A number's tag, fresh per test.
const fresh = () => randomUUID()

describe('T14 T20 PRD-53 the code challenge record on Valkey', () => {
  it('counts a try before the provider is asked, and parallel guesses stop at 5', async () => {
    const n = fresh()
    await openCode(valkey, keys, n, 'a')
    expect(await attachCode(valkey, keys, n, 'a', 'VE1')).toBe('attached')
    const reserved = await Promise.all(Array.from({ length: 7 }, () => reserveCode(valkey, keys, n, 'a')))
    expect(
      reserved
        .filter(r => r.result === 'check')
        .map(r => ('tries' in r ? r.tries : 0))
        .sort(),
    ).toEqual([1, 2, 3, 4, 5])
    // The 6th and 7th take their count back and answer as once a record without a ref has died.
    expect(reserved.filter(r => r.result !== 'check')).toEqual([
      { result: 'expired', ref: undefined },
      { result: 'expired', ref: undefined },
    ])
    expect(await valkey.hget(keys.otp(n), 'tries')).toBe('5')
    // The 5 checks settle wrong: only the try counted 5th kills the record.
    for (let t = 1; t < 5; t++) {
      expect(await settleCode(valkey, keys, n, 'a', { ref: 'VE1', tries: t }, 'wrong')).toEqual({
        result: 'wrong',
        tries: t,
      })
    }
    expect(await settleCode(valkey, keys, n, 'a', { ref: 'VE1', tries: 5 }, 'wrong')).toEqual({
      result: 'dead',
      tries: 5,
    })
    expect(await valkey.exists(keys.otp(n))).toBe(0)
  })

  // Seven parallel guesses on one attempt, as sign-in makes them, with the provider answering wrong
  // to every check that reaches it: each reply as /otp/verify shows it (code_wrong carries the tries
  // left, so its count), sorted. Every reserve lands within the provider's round trip, before any
  // verdict; `lastFirst` settles the check counted 5th before the others.
  async function guesses(options: { ref: boolean; lastFirst?: boolean }): Promise<string[]> {
    const n = fresh()
    await openCode(valkey, keys, n, 'a')
    if (options.ref) await attachCode(valkey, keys, n, 'a', 'VE1')
    const reserved = await Promise.all(Array.from({ length: 7 }, () => reserveCode(valkey, keys, n, 'a')))
    const checks = reserved.flatMap(r => (r.result === 'check' ? [r] : []))
    if (options.lastFirst) checks.sort((x, y) => y.tries - x.tries)
    const settled: Settled[] = []
    for (const r of checks) settled.push(await settleCode(valkey, keys, n, 'a', r, 'wrong'))
    const replies = [...reserved.filter(r => r.result !== 'check'), ...settled]
    return replies.map(r => (r.result === 'wrong' ? `wrong ${r.tries}` : r.result)).sort()
  }

  it('T14: parallel guesses answer a roster number (a provider ref) exactly as one off the roster (none), whatever order the verdicts come in', async () => {
    const offRoster = await guesses({ ref: false })
    expect(offRoster).toEqual(['dead', 'expired', 'expired', 'wrong 1', 'wrong 2', 'wrong 3', 'wrong 4'])
    expect(await guesses({ ref: true })).toEqual(offRoster)
    expect(await guesses({ ref: true, lastFirst: true })).toEqual(offRoster)
  })

  it('a SETTLE that finds the record gone answers from its own count, whatever the provider said, and leaves it gone', async () => {
    const n = fresh()
    await openCode(valkey, keys, n, 'a')
    await attachCode(valkey, keys, n, 'a', 'VE1')
    await reserveCode(valkey, keys, n, 'a')
    await valkey.del(keys.otp(n))
    for (const verdict of ['approved', 'wrong', 'gone'] as const) {
      expect(await settleCode(valkey, keys, n, 'a', { ref: 'VE1', tries: 2 }, verdict)).toEqual({
        result: 'wrong',
        tries: 2,
      })
      expect(await settleCode(valkey, keys, n, 'a', { ref: 'VE1', tries: 5 }, verdict)).toEqual({
        result: 'dead',
        tries: 5,
      })
    }
    expect(await valkey.exists(keys.otp(n))).toBe(0)
  })

  it('answers every guess wrong without a provider reference, and the 5th dead', async () => {
    const n = fresh()
    await openCode(valkey, keys, n, 'a')
    for (let t = 1; t < 5; t++) expect(await reserveCode(valkey, keys, n, 'a')).toEqual({ result: 'wrong', tries: t })
    expect(await reserveCode(valkey, keys, n, 'a')).toEqual({ result: 'dead', tries: 5 })
    expect(await reserveCode(valkey, keys, n, 'a')).toEqual({ result: 'expired', ref: undefined })
  })

  it("refuses checks 5 minutes after the request, on Valkey's clock, and answers the caller its own ref to cancel", async () => {
    const n = fresh()
    await openCode(valkey, keys, n, 'a')
    await attachCode(valkey, keys, n, 'a', 'VE1')
    // Born 5 minutes and a moment ago.
    const [seconds] = await valkey.time()
    await valkey.hset(keys.otp(n), 'born', Number(seconds) * 1000 - 300_001)
    expect(await reserveCode(valkey, keys, n, 'a')).toEqual({ result: 'expired', ref: 'VE1' })
    expect(await valkey.exists(keys.otp(n))).toBe(0)
    // Kept 10 minutes, so a late check still finds its record.
    const m = fresh()
    await openCode(valkey, keys, m, 'a')
    const ttl = await valkey.pttl(keys.otp(m))
    expect(ttl).toBeGreaterThan(590_000)
    expect(ttl).toBeLessThanOrEqual(600_000)
  })

  it('replaces an earlier owner and answers its ref; ATTACH loses to a newer owner and attaches once', async () => {
    const n = fresh()
    expect(await openCode(valkey, keys, n, 'a')).toBeUndefined()
    expect(await attachCode(valkey, keys, n, 'a', 'VE1')).toBe('attached')
    expect(await attachCode(valkey, keys, n, 'a', 'VE2')).toBe('lost')
    expect(await openCode(valkey, keys, n, 'b')).toBe('VE1')
    expect(await attachCode(valkey, keys, n, 'a', 'VE3')).toBe('lost')
    expect(await valkey.hgetall(keys.otp(n))).toMatchObject({ owner: 'b', tries: '0' })
    expect(await valkey.hget(keys.otp(n), 'ref')).toBeNull()
  })

  it("T14 item 3: a displaced owner's RESERVE and SETTLE leave the new owner's record, tries and ref untouched, and SETTLE answers its own try", async () => {
    const n = fresh()
    await openCode(valkey, keys, n, 'a')
    await attachCode(valkey, keys, n, 'a', 'VE1')
    const reserved = await reserveCode(valkey, keys, n, 'a')
    expect(reserved).toEqual({ result: 'check', ref: 'VE1', tries: 1 })
    // A newer request replaces the record during a's check.
    await openCode(valkey, keys, n, 'b')
    await attachCode(valkey, keys, n, 'b', 'VE2')
    const before = await valkey.hgetall(keys.otp(n))
    for (const verdict of ['approved', 'wrong', 'gone'] as const) {
      expect(await settleCode(valkey, keys, n, 'a', { ref: 'VE1', tries: 1 }, verdict)).toEqual({
        result: 'displaced',
        tries: 1,
      })
      expect(await settleCode(valkey, keys, n, 'a', { ref: 'VE1', tries: 5 }, verdict)).toEqual({
        result: 'displaced',
        tries: 5,
      })
    }
    expect(await reserveCode(valkey, keys, n, 'a')).toEqual({ result: 'expired', ref: undefined })
    expect(await valkey.hgetall(keys.otp(n))).toEqual(before)
  })

  it("a stale attempt's check cancels nothing and the newest owner's code still works", async () => {
    const n = fresh()
    await openCode(valkey, keys, n, 'a')
    await attachCode(valkey, keys, n, 'a', 'VE1')
    // A newer request replaces a's record and answers a's ref for the newer owner to cancel.
    expect(await openCode(valkey, keys, n, 'b')).toBe('VE1')
    await attachCode(valkey, keys, n, 'b', 'VE2')
    // a's checks find another owner's record: expired with no ref, so a never cancels VE2, and they
    // spend none of b's tries.
    for (let t = 1; t <= 6; t++)
      expect(await reserveCode(valkey, keys, n, 'a')).toEqual({ result: 'expired', ref: undefined })
    expect(await valkey.hgetall(keys.otp(n))).toMatchObject({ owner: 'b', ref: 'VE2', tries: '0' })
    const reserved = await reserveCode(valkey, keys, n, 'b')
    expect(reserved).toEqual({ result: 'check', ref: 'VE2', tries: 1 })
    expect(await settleCode(valkey, keys, n, 'b', { ref: 'VE2', tries: 1 }, 'approved')).toEqual({
      result: 'approved',
      tries: 1,
    })
    expect(await valkey.exists(keys.otp(n))).toBe(0)
  })

  it('SETTLE failed after an OPEN refunds no try on the new record, and on its own record gives the try back', async () => {
    const n = fresh()
    await openCode(valkey, keys, n, 'a')
    await attachCode(valkey, keys, n, 'a', 'VE1')
    await reserveCode(valkey, keys, n, 'a')
    expect(await settleCode(valkey, keys, n, 'a', { ref: 'VE1', tries: 1 }, 'failed')).toEqual({ result: 'failed' })
    expect(await valkey.hget(keys.otp(n), 'tries')).toBe('0')
    await reserveCode(valkey, keys, n, 'a')
    await openCode(valkey, keys, n, 'b')
    await attachCode(valkey, keys, n, 'b', 'VE1')
    await reserveCode(valkey, keys, n, 'b')
    // Same ref, another owner: failed, and b's try stays counted.
    expect(await settleCode(valkey, keys, n, 'a', { ref: 'VE1', tries: 1 }, 'failed')).toEqual({ result: 'failed' })
    expect(await valkey.hget(keys.otp(n), 'tries')).toBe('1')
  })

  it('T20 item 3: a provider failure answers failed at a displaced, gone or marked record too, giving a try back only on its own live record', async () => {
    // Displaced: a newer request replaced the record during the check. The check is never counted
    // (the caller gives the day's check back), and the newer owner's record keeps its tries and ref.
    const n = fresh()
    await openCode(valkey, keys, n, 'a')
    await attachCode(valkey, keys, n, 'a', 'VE1')
    await reserveCode(valkey, keys, n, 'a')
    await openCode(valkey, keys, n, 'b')
    await attachCode(valkey, keys, n, 'b', 'VE2')
    await reserveCode(valkey, keys, n, 'b')
    const before = await valkey.hgetall(keys.otp(n))
    for (const tries of [1, 5]) {
      expect(await settleCode(valkey, keys, n, 'a', { ref: 'VE1', tries }, 'failed')).toEqual({ result: 'failed' })
    }
    expect(await valkey.hgetall(keys.otp(n))).toEqual(before)
    expect(before).toMatchObject({ owner: 'b', ref: 'VE2', tries: '1' })
    // Gone: another check killed or used it. Failed at any count, and nothing is made.
    const m = fresh()
    await openCode(valkey, keys, m, 'a')
    await attachCode(valkey, keys, m, 'a', 'VE1')
    await reserveCode(valkey, keys, m, 'a')
    await valkey.del(keys.otp(m))
    for (const tries of [1, 5]) {
      expect(await settleCode(valkey, keys, m, 'a', { ref: 'VE1', tries }, 'failed')).toEqual({ result: 'failed' })
    }
    expect(await valkey.exists(keys.otp(m))).toBe(0)
    // Marked gone by another check: failed, and its count left as it is.
    const g = fresh()
    await openCode(valkey, keys, g, 'a')
    await attachCode(valkey, keys, g, 'a', 'VE1')
    await reserveCode(valkey, keys, g, 'a')
    await reserveCode(valkey, keys, g, 'a')
    expect(await settleCode(valkey, keys, g, 'a', { ref: 'VE1', tries: 2 }, 'gone')).toEqual({ result: 'expired' })
    expect(await settleCode(valkey, keys, g, 'a', { ref: 'VE1', tries: 1 }, 'failed')).toEqual({ result: 'failed' })
    expect(await valkey.hgetall(keys.otp(g))).toMatchObject({ owner: 'a', ref: 'VE1', tries: '2', gone: '1' })
  })

  it('an approved verdict uses the record up, and gone expires it: marked, it answers as a deleted record would', async () => {
    const n = fresh()
    await openCode(valkey, keys, n, 'a')
    await attachCode(valkey, keys, n, 'a', 'VE1')
    await reserveCode(valkey, keys, n, 'a')
    expect(await settleCode(valkey, keys, n, 'a', { ref: 'VE1', tries: 1 }, 'approved')).toEqual({
      result: 'approved',
      tries: 1,
    })
    expect(await valkey.exists(keys.otp(n))).toBe(0)
    await openCode(valkey, keys, n, 'a')
    await attachCode(valkey, keys, n, 'a', 'VE2')
    await reserveCode(valkey, keys, n, 'a')
    expect(await settleCode(valkey, keys, n, 'a', { ref: 'VE2', tries: 1 }, 'gone')).toEqual({ result: 'expired' })
    expect(await valkey.hget(keys.otp(n), 'gone')).toBe('1')
    // RESERVE: expired with no ref to cancel, the record left as it is; ATTACH: lost.
    expect(await reserveCode(valkey, keys, n, 'a')).toEqual({ result: 'expired', ref: undefined })
    expect(await valkey.hget(keys.otp(n), 'tries')).toBe('1')
    expect(await attachCode(valkey, keys, n, 'a', 'VE3')).toBe('lost')
    // A SETTLE of any other answer from the provider answers from its own count, as at a deleted
    // record; a provider failure answers failed and gives back no try.
    expect(await settleCode(valkey, keys, n, 'a', { ref: 'VE2', tries: 2 }, 'failed')).toEqual({ result: 'failed' })
    for (const verdict of ['wrong', 'gone'] as const) {
      expect(await settleCode(valkey, keys, n, 'a', { ref: 'VE2', tries: 2 }, verdict)).toEqual({
        result: 'wrong',
        tries: 2,
      })
      expect(await settleCode(valkey, keys, n, 'a', { ref: 'VE2', tries: 5 }, verdict)).toEqual({
        result: 'dead',
        tries: 5,
      })
    }
    expect(await valkey.hget(keys.otp(n), 'tries')).toBe('1')
    // OPEN answers no ref for it: the provider no longer holds that code.
    expect(await openCode(valkey, keys, n, 'b')).toBeUndefined()
    expect(await valkey.hget(keys.otp(n), 'gone')).toBeNull()
  })

  it('T20 item 2: two checks of the right code in parallel, the gone one settled first, still approve the other', async () => {
    const n = fresh()
    await openCode(valkey, keys, n, 'a')
    await attachCode(valkey, keys, n, 'a', 'VE1')
    // Two tabs of one attempt send the right code at once: both reach the provider, which approves
    // the first and answers the second gone, since it has just used the code up.
    const first = await reserveCode(valkey, keys, n, 'a')
    const second = await reserveCode(valkey, keys, n, 'a')
    expect([first, second]).toEqual([
      { result: 'check', ref: 'VE1', tries: 1 },
      { result: 'check', ref: 'VE1', tries: 2 },
    ])
    // The gone reply settles first: that check answers expired.
    expect(await settleCode(valkey, keys, n, 'a', { ref: 'VE1', tries: 2 }, 'gone')).toEqual({ result: 'expired' })
    // A third check meanwhile answers expired and leaves the record for the approval.
    expect(await reserveCode(valkey, keys, n, 'a')).toEqual({ result: 'expired', ref: undefined })
    // The approval settles last and still signs in, using the record up.
    expect(await settleCode(valkey, keys, n, 'a', { ref: 'VE1', tries: 1 }, 'approved')).toEqual({
      result: 'approved',
      tries: 1,
    })
    expect(await valkey.exists(keys.otp(n))).toBe(0)
    // A newer request's record is never approved by an older check marked gone.
    const m = fresh()
    await openCode(valkey, keys, m, 'a')
    await attachCode(valkey, keys, m, 'a', 'VE1')
    await reserveCode(valkey, keys, m, 'a')
    await reserveCode(valkey, keys, m, 'a')
    await settleCode(valkey, keys, m, 'a', { ref: 'VE1', tries: 2 }, 'gone')
    await openCode(valkey, keys, m, 'b')
    expect(await settleCode(valkey, keys, m, 'a', { ref: 'VE1', tries: 1 }, 'approved')).toEqual({
      result: 'displaced',
      tries: 1,
    })
    expect(await valkey.hgetall(keys.otp(m))).toMatchObject({ owner: 'b', tries: '0' })
  })
})
