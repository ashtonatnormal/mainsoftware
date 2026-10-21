import type { Redis } from 'ioredis'
import { describe, expect, it } from 'vitest'
import { Attempt, consumeAttempt, createAttempt, dropAttempt, readAttempt, updateAttempt } from '#src/auth/attempts.ts'
import { keyName } from '#src/auth/crypto.ts'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'

// The code challenge's scripts (codes.ts) run against Valkey in codes.integration.test.ts.

const keys = valkeyKeys('it:unit:')
const PERSON = 'b0000000-0000-4000-8000-000000000001'

// A stand-in for the few string commands attempts use, recording each call's arguments.
function fakeValkey() {
  const store = new Map<string, string>()
  const calls: unknown[][] = []
  const valkey = {
    set: async (key: string, value: string, ...options: unknown[]) => {
      calls.push(['set', key, ...options])
      if (options.includes('XX') && !store.has(key)) return null
      store.set(key, value)
      return 'OK'
    },
    get: async (key: string) => store.get(key) ?? null,
    del: async (key: string) => (store.delete(key) ? 1 : 0),
  } as unknown as Redis
  return { valkey, store, calls }
}

describe('C0.5 T14 sign-in attempts', () => {
  it('stores an attempt under the hash of its id for 10 minutes, never the id itself', async () => {
    const { valkey, store, calls } = fakeValkey()
    const { id, key } = await createAttempt(valkey, keys, { v: 1, numberTag: 'tag', step: 'code_sent' })
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(key).toBe(keyName(id))
    expect([...store.keys()]).toEqual([`it:unit:att:${key}`])
    expect(JSON.stringify([...store])).not.toContain(id)
    expect(calls).toEqual([['set', `it:unit:att:${key}`, 'PX', 600_000]])
    expect(await readAttempt(valkey, keys, id)).toEqual({ key, attempt: { v: 1, numberTag: 'tag', step: 'code_sent' } })
  })

  it('reads nothing for no cookie, an unknown id, or a stored value that is not a valid attempt', async () => {
    const { valkey, store } = fakeValkey()
    expect(await readAttempt(valkey, keys, undefined)).toBeUndefined()
    expect(await readAttempt(valkey, keys, 'x'.repeat(43))).toBeUndefined()
    for (const [id, value] of [
      ['a'.repeat(43), 'not json'],
      ['b'.repeat(43), JSON.stringify({ v: 2, numberTag: 't', step: 'code_sent' })],
      ['c'.repeat(43), JSON.stringify({ v: 1, numberTag: 't', step: 'signed_in' })],
      ['d'.repeat(43), JSON.stringify({ v: 1, numberTag: 't', step: 'code_sent', phone: '+6580000001' })],
      ['e'.repeat(43), JSON.stringify({ v: 1, numberTag: 't', step: 'code_sent', personId: 'someone' })],
    ] as const) {
      store.set(keys.attempt(keyName(id)), value)
      expect(await readAttempt(valkey, keys, id), value).toBeUndefined()
    }
  })

  it('updates only an attempt that still exists, keeping its expiry', async () => {
    const { valkey, calls } = fakeValkey()
    const { id, key } = await createAttempt(valkey, keys, { v: 1, numberTag: 'tag', step: 'code_sent' })
    const named = { v: 1, numberTag: 'tag', step: 'code_sent', personId: PERSON } as const
    expect(await updateAttempt(valkey, keys, key, named)).toBe(true)
    expect(calls.at(-1)).toEqual(['set', `it:unit:att:${key}`, 'KEEPTTL', 'XX'])
    expect((await readAttempt(valkey, keys, id))?.attempt).toEqual(named)
    expect(await consumeAttempt(valkey, keys, key)).toBe(true)
    expect(await updateAttempt(valkey, keys, key, named)).toBe(false)
  })

  it('lets only one caller consume an attempt', async () => {
    const { valkey } = fakeValkey()
    const { key } = await createAttempt(valkey, keys, { v: 1, numberTag: 'tag', step: 'step_up' })
    expect(await consumeAttempt(valkey, keys, key)).toBe(true)
    expect(await consumeAttempt(valkey, keys, key)).toBe(false)
    await dropAttempt(valkey, keys, key)
  })

  it('refuses to store anything but an attempt', async () => {
    const { valkey } = fakeValkey()
    const bad = { v: 1, numberTag: 'tag', step: 'code_sent', e164: '+6580000001' } as unknown as Attempt
    await expect(createAttempt(valkey, keys, bad)).rejects.toThrow()
    expect(Attempt.safeParse({ v: 1, numberTag: 'tag', step: 'step_up', orgId: PERSON }).success).toBe(true)
  })

  it('T20: knows the verified step, between an approved code and the finished sign-in', () => {
    expect(Attempt.safeParse({ v: 1, numberTag: 'tag', step: 'verified', personId: PERSON }).success).toBe(true)
  })
})
