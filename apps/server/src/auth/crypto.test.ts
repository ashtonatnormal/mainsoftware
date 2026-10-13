import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  deriveKeys,
  hashPin,
  isIssuedPinHash,
  keyName,
  newOtp,
  newSecret,
  otpMac,
  PinSlotsFull,
  sha256,
  tag,
  verifyPin,
  withPinSlot,
} from '#src/auth/crypto.ts'

// Low-entropy test secrets: secret scanners read test files too.
const keys = deriveKeys('test-secret-test-secret-test-secret')
const otherKeys = deriveKeys('other-secret-other-secret-other-secret')

// 0006's users_pin_hash, as written in the migration.
const USERS_PIN_HASH = '^\\$argon2id\\$v=19\\$m=19456,t=2,p=1\\$[A-Za-z0-9+/]{22}\\$[A-Za-z0-9+/]{43}$'

// True when the promise settles within a few microtasks: argon2 runs on the thread pool, so a
// promise that waits on it can't.
async function settlesAtOnce(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  promise.then(
    () => (settled = true),
    () => (settled = true),
  )
  for (let i = 0; i < 5; i++) await null
  return settled
}

describe('T6 T14 sign-in keys', () => {
  it('derives four distinct keys from the secret, the same every time, with a 16-hex pepper id', () => {
    const again = deriveKeys('test-secret-test-secret-test-secret')
    expect(again).toEqual(keys)
    expect(keys.pinKeyId).toMatch(/^[0-9a-f]{16}$/)
    const hex = [keys.otp, keys.tag, keys.pinPepper].map(key => key.toString('hex'))
    expect(new Set(hex).size).toBe(3)
    for (const key of [keys.otp, keys.tag, keys.pinPepper]) expect(key).toHaveLength(32)
    expect(hex.some(key => key.startsWith(keys.pinKeyId))).toBe(false)
    expect(otherKeys.pinKeyId).not.toBe(keys.pinKeyId)
  })

  it('makes 43-character random secrets, and hashes them for storage and key names', () => {
    const secret = newSecret()
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newSecret()).not.toBe(secret)
    expect(sha256(secret)).toHaveLength(32)
    expect(keyName(secret)).toBe(sha256(secret).toString('base64url'))
    expect(keyName(secret)).not.toContain(secret)
  })

  it('tags a value stably, differently under another key, in 22 base64url characters', () => {
    expect(tag(keys, '+6580000001')).toBe(tag(keys, '+6580000001'))
    expect(tag(keys, '+6580000001')).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(tag(keys, '+6580000001')).not.toBe(tag(keys, '+6580000002'))
    expect(tag(otherKeys, '+6580000001')).not.toBe(tag(keys, '+6580000001'))
  })

  it('binds a code MAC to the attempt, the number and the code', () => {
    const mac = otpMac(keys, 'attempt-a', 'number-a', '123456')
    expect(mac).toMatch(/^[0-9a-f]{64}$/)
    expect(otpMac(keys, 'attempt-a', 'number-a', '123456')).toBe(mac)
    for (const other of [
      otpMac(keys, 'attempt-b', 'number-a', '123456'),
      otpMac(keys, 'attempt-a', 'number-b', '123456'),
      otpMac(keys, 'attempt-a', 'number-a', '123457'),
      otpMac(otherKeys, 'attempt-a', 'number-a', '123456'),
    ]) {
      expect(other).not.toBe(mac)
    }
  })

  it('makes sign-in codes of exactly 6 ASCII digits (PRD-53)', () => {
    const codes = new Set<string>()
    for (let i = 0; i < 2000; i++) {
      const code = newOtp()
      expect(code).toMatch(/^[0-9]{6}$/)
      codes.add(code)
    }
    expect(codes.size).toBeGreaterThan(1900)
  })
})

describe('T6 PIN hashing (argon2id; needs Node 24.7 or later)', () => {
  it("issues a hash that 0006's users_pin_hash accepts", async () => {
    expect(readFileSync(new URL('../../../../db/migrations/0006_sign_in.sql', import.meta.url), 'utf8')).toContain(
      `pin_hash ~ '${USERS_PIN_HASH}'`,
    )
    const phc = await hashPin('381904', keys)
    expect(phc).toMatch(new RegExp(USERS_PIN_HASH))
    expect(isIssuedPinHash(phc)).toBe(true)
    expect(await hashPin('381904', keys)).not.toBe(phc)
  })

  it('verifies the PIN, and refuses another PIN, another pepper and a malformed hash', async () => {
    const phc = await hashPin('381904', keys)
    expect(await verifyPin('381904', phc, keys)).toBe(true)
    expect(await verifyPin('381905', phc, keys)).toBe(false)
    expect(await verifyPin('381904', phc, otherKeys)).toBe(false)
    expect(await verifyPin('381904', phc.slice(0, -1), keys)).toBe(false)
    expect(await verifyPin('381904', `${phc}x`, keys)).toBe(false)
    expect(await verifyPin('381904', '', keys)).toBe(false)
  })

  it('T14 item 8: refuses at once, without hashing, a hash at any cost the server never issues', async () => {
    const phc = await hashPin('381904', keys)
    const costly = phc.replace('m=19456', 'm=65536')
    expect(isIssuedPinHash(costly)).toBe(false)
    expect(await settlesAtOnce(verifyPin('381904', costly, keys))).toBe(true)
    expect(await verifyPin('381904', costly, keys)).toBe(false)
    for (const variant of [phc.replace('t=2', 't=3'), phc.replace('p=1', 'p=4'), phc.replace('argon2id', 'argon2i')]) {
      expect(isIssuedPinHash(variant)).toBe(false)
    }
    // The issued cost does reach argon2, so the check above means something.
    expect(await settlesAtOnce(verifyPin('381904', phc, keys))).toBe(false)
  })
})

describe('T14 PIN slots (at most 2 hashing, 16 waiting)', () => {
  function deferred() {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  it('runs 2 at once, queues 16, refuses the 19th, and frees a slot when work throws', async () => {
    const started: number[] = []
    const gates = Array.from({ length: 18 }, () => deferred())
    const runs = gates.map((gate, i) =>
      withPinSlot(async () => {
        started.push(i)
        await gate.promise
        return i
      }),
    )
    await new Promise(resolve => setImmediate(resolve))
    expect(started).toEqual([0, 1])
    await expect(withPinSlot(async () => 'never')).rejects.toBeInstanceOf(PinSlotsFull)

    // The first one fails: its slot goes to the next in line.
    gates[0]?.reject(new Error('work failed'))
    await expect(runs[0]).rejects.toThrow('work failed')
    await new Promise(resolve => setImmediate(resolve))
    expect(started).toEqual([0, 1, 2])

    for (const gate of gates) gate.resolve()
    expect(await Promise.all(runs.slice(1))).toEqual(Array.from({ length: 17 }, (_, i) => i + 1))
    expect(started).toHaveLength(18)

    // Everything has finished, so both slots are free again.
    const again = [deferred(), deferred()]
    const both: number[] = []
    const pair = again.map((gate, i) =>
      withPinSlot(async () => {
        both.push(i)
        await gate.promise
      }),
    )
    await new Promise(resolve => setImmediate(resolve))
    expect(both).toEqual([0, 1])
    for (const gate of again) gate.resolve()
    await Promise.all(pair)
  })
})
