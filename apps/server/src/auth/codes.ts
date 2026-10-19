// The code challenge record (TECH-SPEC T14 item 4, T20): one per number, `otp:{numberTag}`, a hash
// of {owner, ref, tries, born}. owner is the attempt key of the sign-in that asked for the code (or,
// from re-authentication, `r:<session id>`); ref is the provider's opaque reference, attached once
// the code is sent; tries counts checks; born is Valkey's clock at the request. The record never
// holds a code or a number. The provider makes and checks the code (AQ-03); this record holds
// Hearth's own rules, the same whatever provider sits behind sms/provider.ts: 5 minutes from the
// request (PRD-53), 5 tries, the newest request for the number wins, and a code works only for the
// attempt that asked for it.
//
// Four scripts, each atomic on Valkey's clock, compare and act: a script that finds another owner's
// record, or none, changes nothing, so a stale attempt can never delete, cancel or spend a try of
// the newest owner's code.
// - OPEN replaces any record for the number with the caller's, and answers the replaced ref for the
//   caller to cancel (after its commit).
// - ATTACH sets the ref, only on the caller's record and only once.
// - RESERVE counts a try before the provider is asked, so parallel guesses stop at 5; past the 5
//   minutes it deletes the caller's record and answers its ref, the only ref a caller may cancel.
// - SETTLE applies the provider's verdict only while the record still holds the caller's owner and
//   ref; otherwise it answers displaced (a newer request replaced it during the check), which
//   sign-in answers as code_expired, whatever the provider said.
import type { Redis } from 'ioredis'
import { runScript, script } from '#src/auth/limiter.ts'
import { OTP } from '#src/auth/policy.ts'
import type { Verdict } from '#src/auth/sms/provider.ts'
import type { ValkeyKeys } from '#src/auth/valkey-keys.ts'

const NOW = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
`

// KEYS[1]: otp:{tag}. ARGV: the owner, the record's TTL in ms. Answers the replaced ref, or ''.
export const OPEN = script(`${NOW}
local prev = redis.call('HGET', KEYS[1], 'ref')
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'owner', ARGV[1], 'tries', 0, 'born', now)
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
return prev or ''
`)

// KEYS[1]: otp:{tag}. ARGV: the owner, the ref.
export const ATTACH = script(`
local c = redis.call('HMGET', KEYS[1], 'owner', 'ref')
if c[1] ~= ARGV[1] or c[2] then return 'lost' end
redis.call('HSET', KEYS[1], 'ref', ARGV[2])
return 'attached'
`)

// KEYS[1]: otp:{tag}. ARGV: the owner, the code's validity in ms, the tries allowed. A try past the
// allowed ones while others are still being checked is dead, takes its count back and leaves the
// record to them.
export const RESERVE = script(`${NOW}
local c = redis.call('HMGET', KEYS[1], 'owner', 'ref', 'born')
if c[1] ~= ARGV[1] then return {'expired', ''} end
if now - tonumber(c[3]) >= tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1])
  return {'expired', c[2] or ''}
end
local tries = redis.call('HINCRBY', KEYS[1], 'tries', 1)
if not c[2] then
  if tries >= tonumber(ARGV[3]) then redis.call('DEL', KEYS[1]); return {'dead', tries} end
  return {'wrong', tries}
end
if tries > tonumber(ARGV[3]) then
  redis.call('HINCRBY', KEYS[1], 'tries', -1)
  return {'dead', tries - 1}
end
return {'check', c[2], tries}
`)

// KEYS[1]: otp:{tag}. ARGV: the owner, the ref checked, the verdict (approved, wrong, gone or
// failed), the try RESERVE counted for this check, the tries allowed. A wrong verdict keeps that
// try; the one counted last kills the record.
export const SETTLE = script(`
local c = redis.call('HMGET', KEYS[1], 'owner', 'ref')
if c[1] ~= ARGV[1] or c[2] ~= ARGV[2] then return {'displaced', 0} end
local tries = tonumber(ARGV[4])
if ARGV[3] == 'approved' then redis.call('DEL', KEYS[1]); return {'approved', tries} end
if ARGV[3] == 'wrong' then
  if tries >= tonumber(ARGV[5]) then redis.call('DEL', KEYS[1]); return {'dead', tries} end
  return {'wrong', tries}
end
if ARGV[3] == 'gone' then redis.call('DEL', KEYS[1]); return {'expired', tries} end
redis.call('HINCRBY', KEYS[1], 'tries', -1)
return {'failed', tries - 1}
`)

export type Reserved =
  | { result: 'expired'; ref: string | undefined }
  | { result: 'wrong' | 'dead'; tries: number }
  | { result: 'check'; ref: string; tries: number }

export type Settled =
  | { result: 'approved' | 'wrong' | 'dead'; tries: number }
  | { result: 'expired' | 'failed' | 'displaced' }

const unexpected = (name: string) => new Error(`the ${name} script answered unexpectedly`)

const count = (value: unknown, name: string): number => {
  const n = Number(value)
  if (!Number.isInteger(n)) throw unexpected(name)
  return n
}

export function parseOpen(reply: unknown): string | undefined {
  if (typeof reply !== 'string') throw unexpected('code open')
  return reply === '' ? undefined : reply
}

export function parseAttach(reply: unknown): 'attached' | 'lost' {
  if (reply !== 'attached' && reply !== 'lost') throw unexpected('code attach')
  return reply
}

export function parseReserve(reply: unknown): Reserved {
  if (!Array.isArray(reply)) throw unexpected('code reserve')
  const [result, a, b] = reply as unknown[]
  switch (result) {
    case 'expired':
      if (typeof a !== 'string') throw unexpected('code reserve')
      return { result, ref: a === '' ? undefined : a }
    case 'wrong':
    case 'dead':
      return { result, tries: count(a, 'code reserve') }
    case 'check':
      if (typeof a !== 'string' || a === '') throw unexpected('code reserve')
      return { result, ref: a, tries: count(b, 'code reserve') }
    default:
      throw unexpected('code reserve')
  }
}

export function parseSettle(reply: unknown): Settled {
  if (!Array.isArray(reply)) throw unexpected('code settle')
  const [result, tries] = reply as unknown[]
  switch (result) {
    case 'approved':
    case 'wrong':
    case 'dead':
      return { result, tries: count(tries, 'code settle') }
    case 'expired':
    case 'failed':
    case 'displaced':
      return { result }
    default:
      throw unexpected('code settle')
  }
}

type Valkey = Pick<Redis, 'evalsha' | 'eval'>

// Starts a new challenge for the number, owned by `owner`; answers the replaced record's ref, if it
// had one, for the caller to cancel once it has committed.
export async function openCode(
  valkey: Valkey,
  keys: ValkeyKeys,
  numberTag: string,
  owner: string,
): Promise<string | undefined> {
  return parseOpen(await runScript(valkey, OPEN, [keys.otp(numberTag)], [owner, OTP.recordTtlMs]))
}

export async function attachCode(
  valkey: Valkey,
  keys: ValkeyKeys,
  numberTag: string,
  owner: string,
  ref: string,
): Promise<'attached' | 'lost'> {
  return parseAttach(await runScript(valkey, ATTACH, [keys.otp(numberTag)], [owner, ref]))
}

export async function reserveCode(
  valkey: Valkey,
  keys: ValkeyKeys,
  numberTag: string,
  owner: string,
): Promise<Reserved> {
  return parseReserve(await runScript(valkey, RESERVE, [keys.otp(numberTag)], [owner, OTP.ttlMs, OTP.maxTries]))
}

// `reserved` is RESERVE's check. failed: the provider couldn't be asked, or didn't answer; the
// reserved try is given back.
export async function settleCode(
  valkey: Valkey,
  keys: ValkeyKeys,
  numberTag: string,
  owner: string,
  reserved: { ref: string; tries: number },
  verdict: Verdict | 'failed',
): Promise<Settled> {
  return parseSettle(
    await runScript(
      valkey,
      SETTLE,
      [keys.otp(numberTag)],
      [owner, reserved.ref, verdict, reserved.tries, OTP.maxTries],
    ),
  )
}

// The record's owner, or null: whether a start's caller still holds the record (sign-in.ts uses it
// before acting on a foreign verification, so a request that lost a race never cancels the newer
// owner's).
export async function codeOwner(
  valkey: Pick<Redis, 'hget'>,
  keys: ValkeyKeys,
  numberTag: string,
): Promise<string | null> {
  return valkey.hget(keys.otp(numberTag), 'owner')
}
