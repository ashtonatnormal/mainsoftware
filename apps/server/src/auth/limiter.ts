// The generic sliding-window limiter (INF-RATELIMIT; A0's per-person AI quotas reuse it). Each
// window counts hits in the last windowMs and allows at most max. Sliding windows, not token
// buckets or fixed windows, because PRD-53's "at most 3 per 10 minutes and 10 per day" is exact
// only this way (TECH-SPEC T14). Valkey keeps the windows; PIN locks are in Postgres instead,
// because a Valkey restart forgets everything.
import { createHash, randomUUID } from 'node:crypto'
import { isIPv4, isIPv6 } from 'node:net'
import type { Redis } from 'ioredis'

export interface Window {
  key: string
  windowMs: number
  max: number
}

export type LimitResult = { allowed: true } | { allowed: false; retryAfterMs: number }

// A Lua script and its SHA-1, which EVALSHA names it by.
export interface Script {
  lua: string
  sha: string
}

export function script(lua: string): Script {
  return { lua, sha: createHash('sha1').update(lua).digest('hex') }
}

// Runs a script by its SHA-1, sending the source once if Valkey doesn't have it yet (after a
// restart or a failover). Throws whatever else Valkey answers.
export async function runScript(
  valkey: Redis,
  { lua, sha }: Script,
  keys: readonly string[],
  args: readonly (string | number)[],
): Promise<unknown> {
  try {
    return await valkey.evalsha(sha, keys.length, ...keys, ...args)
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith('NOSCRIPT'))) throw error
    return valkey.eval(lua, keys.length, ...keys, ...args)
  }
}

// KEYS: the windows' keys. ARGV: each window's length in ms and its max, in key order, then the
// hit's member. Timed by Valkey's own clock, so the api tasks' clocks don't matter. Checks every
// window first, and records the hit in all of them only if none is full, so a refused request
// costs nothing; the reply is {1, 0}, or {0, ms until the fullest window has room}.
export const SLIDING_WINDOW = script(`
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local n = #KEYS
local retry = 0
for i = 1, n do
  local window = tonumber(ARGV[2 * i - 1]); local limit = tonumber(ARGV[2 * i])
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now - window)
  local count = redis.call('ZCARD', KEYS[i])
  if count >= limit then
    local oldest = redis.call('ZRANGE', KEYS[i], 0, count - limit, 'WITHSCORES')
    local wait = tonumber(oldest[#oldest]) + window - now
    if wait > retry then retry = wait end
  end
end
if retry > 0 then return {0, retry} end
local member = ARGV[2 * n + 1]
for i = 1, n do
  redis.call('ZADD', KEYS[i], now, member)
  redis.call('PEXPIRE', KEYS[i], tonumber(ARGV[2 * i - 1]))
end
return {1, 0}
`)

// Checks every window and records one hit in all of them if none is full. Atomic. Throws if
// Valkey can't answer; sign-in callers then fail closed.
export async function hit(valkey: Redis, windows: readonly Window[]): Promise<LimitResult> {
  if (windows.length === 0) return { allowed: true }
  const reply = await runScript(
    valkey,
    SLIDING_WINDOW,
    windows.map(w => w.key),
    [...windows.flatMap(w => [w.windowMs, w.max]), randomUUID()],
  )
  if (!Array.isArray(reply) || reply.length !== 2) throw new Error('the sliding-window script answered unexpectedly')
  const [allowed, retryAfterMs] = reply.map(Number)
  return allowed === 1 ? { allowed: true } : { allowed: false, retryAfterMs: retryAfterMs ?? 0 }
}

// Whose address a per-IP window counts: an IPv4 address as it is (an IPv4-mapped IPv6 address as
// its IPv4 form), and an IPv6 address by its /64, which one client normally holds whole (security
// critic S4). Anything else is returned unchanged.
export function limitSubject(ip: string): string {
  if (isIPv4(ip)) return ip
  if (!isIPv6(ip)) return ip
  const groups = expandIPv6(ip.toLowerCase().replace(/%.*$/, ''))
  if (groups.slice(0, 5).every(g => g === '0000') && groups[5] === 'ffff') {
    const [high = 0, low = 0] = groups.slice(6).map(g => Number.parseInt(g, 16))
    return [high >> 8, high & 255, low >> 8, low & 255].join('.')
  }
  return `${groups.slice(0, 4).join(':')}::/64`
}

// The eight groups of an IPv6 address, each as 4 hex digits, with a dotted IPv4 tail turned into
// two groups.
function expandIPv6(ip: string): string[] {
  let address = ip
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address)
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number]
    address = `${address.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head = '', rest] = address.split('::')
  const left = head === '' ? [] : head.split(':')
  const right = rest === undefined || rest === '' ? [] : rest.split(':')
  const missing = rest === undefined ? 0 : 8 - left.length - right.length
  return [...left, ...Array<string>(missing).fill('0'), ...right].map(g => g.padStart(4, '0'))
}
