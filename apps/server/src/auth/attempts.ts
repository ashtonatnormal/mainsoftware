// Sign-in state between steps, in Valkey (T14, T20). An attempt is made when a code is requested
// and is gone 10 minutes later, never extended. The browser holds its id in the attempt cookie;
// Valkey holds it under the id's hash, so neither a key nor a log line carries the id. The code's
// challenge is a separate record per number (codes.ts), owned by the attempt that asked for it: a
// newer request for the number, from any browser, replaces it, and the older attempt then finds
// its code expired.
import type { Redis } from 'ioredis'
import { z } from 'zod'
import { keyName, newSecret } from '#src/auth/crypto.ts'
import { ATTEMPT_TTL_MS } from '#src/auth/policy.ts'
import type { ValkeyKeys } from '#src/auth/valkey-keys.ts'

export const Attempt = z
  .object({
    v: z.literal(1),
    // tag() of the number, never the number.
    numberTag: z.string(),
    // Which step comes next: the code; verified, once the provider approved the code and before the
    // sign-in finishes (a retry then finishes it without a second check); then setting a PIN or the
    // step-up (the PIN or a passkey).
    step: z.enum(['code_sent', 'verified', 'set_pin', 'step_up']),
    // Set only on the way to sending a code to a current roster number of someone still at the
    // org, just before the code's audit row is written and the code is handed to the SMS provider,
    // and kept if the audit row, the commit or the send then fails. An attempt without them answers
    // every code as wrong.
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
