// The code challenge's scripts (codes.ts) on the Compose stack's Valkey (TECH-SPEC T14 item 4, T20,
// PRD-53), each test under its own random key prefix. `npm run test:integration` runs it, with the
// stack up (`docker compose up -d --wait`).
import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { attachCode, openCode, reserveCode, settleCode } from '#src/auth/codes.ts'
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
    expect(reserved.filter(r => r.result === 'dead')).toEqual([
      { result: 'dead', tries: 5 },
      { result: 'dead', tries: 5 },
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

  it("a displaced owner's RESERVE and SETTLE leave the new owner's record, tries and ref untouched", async () => {
    const n = fresh()
    await openCode(valkey, keys, n, 'a')
    await attachCode(valkey, keys, n, 'a', 'VE1')
    const reserved = await reserveCode(valkey, keys, n, 'a')
    expect(reserved).toEqual({ result: 'check', ref: 'VE1', tries: 1 })
    // A newer request replaces the record during a's check.
    await openCode(valkey, keys, n, 'b')
    await attachCode(valkey, keys, n, 'b', 'VE2')
    const before = await valkey.hgetall(keys.otp(n))
    for (const verdict of ['approved', 'wrong', 'gone', 'failed'] as const) {
      expect(await settleCode(valkey, keys, n, 'a', { ref: 'VE1', tries: 1 }, verdict)).toEqual({ result: 'displaced' })
    }
    expect(await reserveCode(valkey, keys, n, 'a')).toEqual({ result: 'expired', ref: undefined })
    expect(await valkey.hgetall(keys.otp(n))).toEqual(before)
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
    // Same ref, another owner: still displaced.
    expect(await settleCode(valkey, keys, n, 'a', { ref: 'VE1', tries: 1 }, 'failed')).toEqual({ result: 'displaced' })
    expect(await valkey.hget(keys.otp(n), 'tries')).toBe('1')
  })

  it('an approved verdict uses the record up, and gone expires it', async () => {
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
    expect(await valkey.exists(keys.otp(n))).toBe(0)
  })
})
