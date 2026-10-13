// Sign-in state between steps, in Valkey (T14). An attempt is made when a code is requested and
// is gone 10 minutes later, never extended. The browser holds its id in the attempt cookie; Valkey
// holds it under the id's hash, so neither a key nor a log line carries the id. The code's
// challenge is a separate record per number, bound to the attempt that asked for it: a newer
// request for the number, from any browser, replaces it, and the older attempt then finds its
// code expired.
import type { Redis } from 'ioredis'
import { z } from 'zod'
import { keyName, newSecret } from '#src/auth/crypto.ts'
import { runScript, script } from '#src/auth/limiter.ts'
import { ATTEMPT_TTL_MS, OTP } from '#src/auth/policy.ts'
import type { ValkeyKeys } from '#src/auth/valkey-keys.ts'

export const Attempt = z
  .object({
    v: z.literal(1),
    // tag() of the number, never the number.
    numberTag: z.string(),
    // Which step comes next: the code, then setting a PIN or the step-up (the PIN or a passkey).
    step: z.enum(['code_sent', 'set_pin', 'step_up']),
    // Set only when a code is handed to the SMS provider for a current roster number of someone
    // still at the org, just before the send (and kept if the send fails). An attempt without them
    // answers every code as wrong.
    orgId: z.uuid().optional(),
    personId: z.uuid().optional(),
    phoneNumberId: z.uuid().optional(),
  })
  .strict()
export type Attempt = z.infer<typeof Attempt>

export async function createAttempt(
  valkey: Redis,
  keys: ValkeyKeys,
  attempt: Attempt,
): Promise<{ id: string; key: string }> {
  const id = newSecret()
  const key = keyName(id)
  await valkey.set(keys.attempt(key), JSON.stringify(Attempt.parse(attempt)), 'PX', ATTEMPT_TTL_MS)
  return { id, key }
}

// The attempt a cookie names, or undefined if there's none, it has expired or it isn't readable.
export async function readAttempt(
  valkey: Redis,
  keys: ValkeyKeys,
  id: string | undefined,
): Promise<{ key: string; attempt: Attempt } | undefined> {
  if (id === undefined) return undefined
  const key = keyName(id)
  const stored = await valkey.get(keys.attempt(key))
  if (stored === null) return undefined
  let value: unknown
  try {
    value = JSON.parse(stored)
  } catch {
    return undefined
  }
  const parsed = Attempt.safeParse(value)
  return parsed.success ? { key, attempt: parsed.data } : undefined
}

// Rewrites an attempt that still exists, keeping its expiry (to name the person, or move to the
// next step). False if it expired or was consumed meanwhile.
export async function updateAttempt(valkey: Redis, keys: ValkeyKeys, key: string, attempt: Attempt): Promise<boolean> {
  return (await valkey.set(keys.attempt(key), JSON.stringify(Attempt.parse(attempt)), 'KEEPTTL', 'XX')) === 'OK'
}

// Removes the attempt and says whether this call removed it, so only one request can turn an
// attempt into a session.
export async function consumeAttempt(valkey: Redis, keys: ValkeyKeys, key: string): Promise<boolean> {
  return (await valkey.del(keys.attempt(key))) === 1
}

export async function dropAttempt(valkey: Redis, keys: ValkeyKeys, key: string): Promise<void> {
  await valkey.del(keys.attempt(key))
}

// KEYS[1]: otp:{tag}. ARGV: the attempt key, the code's MAC, the TTL in ms. Replaces any earlier
// code for the number in one step.
const STORE_OTP = script(`
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'attempt', ARGV[1], 'mac', ARGV[2], 'tries', 0)
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1
`)

export async function storeOtp(
  valkey: Redis,
  keys: ValkeyKeys,
  numberTag: string,
  attemptKey: string,
  mac: string,
): Promise<void> {
  await runScript(valkey, STORE_OTP, [keys.otp(numberTag)], [attemptKey, mac, OTP.ttlMs])
}

// KEYS[1]: otp:{tag}. ARGV: the attempt key, the MAC of the code given, the tries allowed. A code
// for another attempt, or none, is expired. A right code is used up. A wrong one counts, and the
// last allowed wrong one kills the code. The == compares two keyed MACs, so its timing tells
// nothing about the code.
const CHECK_OTP = script(`
local c = redis.call('HMGET', KEYS[1], 'attempt', 'mac', 'tries')
if not c[1] or c[1] ~= ARGV[1] then return {'expired', 0} end
if c[2] == ARGV[2] then redis.call('DEL', KEYS[1]); return {'ok', tonumber(c[3])} end
local tries = redis.call('HINCRBY', KEYS[1], 'tries', 1)
if tries >= tonumber(ARGV[3]) then redis.call('DEL', KEYS[1]); return {'dead', tries} end
return {'wrong', tries}
`)

export type OtpResult = 'ok' | 'wrong' | 'dead' | 'expired'

export async function checkOtp(
  valkey: Redis,
  keys: ValkeyKeys,
  numberTag: string,
  attemptKey: string,
  mac: string,
): Promise<{ result: OtpResult; tries: number }> {
  const reply = await runScript(valkey, CHECK_OTP, [keys.otp(numberTag)], [attemptKey, mac, OTP.maxTries])
  const [result, tries] = Array.isArray(reply) ? reply : []
  if (result !== 'ok' && result !== 'wrong' && result !== 'dead' && result !== 'expired') {
    throw new Error('the code check script answered unexpectedly')
  }
  return { result, tries: Number(tries) }
}
