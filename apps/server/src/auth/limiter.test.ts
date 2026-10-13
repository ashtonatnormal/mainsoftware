import { createHash } from 'node:crypto'
import type { Redis } from 'ioredis'
import { describe, expect, it } from 'vitest'
import { hit, limitSubject, runScript, SLIDING_WINDOW, script } from '#src/auth/limiter.ts'

// The Lua itself runs against Valkey in the integration test (npm run test:integration).

describe('T14 INF-RATELIMIT whose address a per-IP window counts', () => {
  it('counts an IPv4 address as it is, and an IPv4-mapped IPv6 address as its IPv4 form', () => {
    expect(limitSubject('198.51.100.4')).toBe('198.51.100.4')
    expect(limitSubject('::ffff:198.51.100.4')).toBe('198.51.100.4')
    expect(limitSubject('::FFFF:198.51.100.4')).toBe('198.51.100.4')
    expect(limitSubject('::ffff:c633:6404')).toBe('198.51.100.4')
  })

  it('counts an IPv6 address by its /64, however it is written', () => {
    expect(limitSubject('2001:db8:1:2:3:4:5:6')).toBe('2001:0db8:0001:0002::/64')
    expect(limitSubject('2001:db8:1:2::9')).toBe('2001:0db8:0001:0002::/64')
    expect(limitSubject('2001:DB8:1:2:ffff::')).toBe('2001:0db8:0001:0002::/64')
    expect(limitSubject('2001:db8::1')).toBe('2001:0db8:0000:0000::/64')
    expect(limitSubject('2001:db8:0:0:1::1')).toBe('2001:0db8:0000:0000::/64')
    expect(limitSubject('2001:db8:1:3::9')).not.toBe(limitSubject('2001:db8:1:2::9'))
    expect(limitSubject('::1')).toBe('0000:0000:0000:0000::/64')
    expect(limitSubject('fe80::1%eth0')).toBe('fe80:0000:0000:0000::/64')
    expect(limitSubject('64:ff9b::198.51.100.4')).toBe('0064:ff9b:0000:0000::/64')
  })

  it('leaves anything that is not an address unchanged', () => {
    expect(limitSubject('')).toBe('')
    expect(limitSubject('unknown')).toBe('unknown')
  })
})

// A stand-in for ioredis that records the calls and answers from `answers`, in order.
function fakeValkey(answers: (unknown | Error)[]) {
  const calls: { command: string; args: unknown[] }[] = []
  const answer = async (command: string, args: unknown[]) => {
    calls.push({ command, args })
    const next = answers.shift()
    if (next instanceof Error) throw next
    return next
  }
  const valkey = {
    evalsha: (...args: unknown[]) => answer('evalsha', args),
    eval: (...args: unknown[]) => answer('eval', args),
  } as unknown as Redis
  return { valkey, calls }
}

describe('T14 INF-RATELIMIT running the sliding-window script', () => {
  it('names a script by its SHA-1', () => {
    expect(script('return 1').sha).toBe(createHash('sha1').update('return 1').digest('hex'))
    expect(SLIDING_WINDOW.sha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('sends every window and one member, and reads an allowed or refused reply', async () => {
    const { valkey, calls } = fakeValkey([
      [1, 0],
      [0, 59_000],
    ])
    const windows = [
      { key: 'it:rl:{auth}:a:x', windowMs: 600_000, max: 3 },
      { key: 'it:rl:{auth}:b:x', windowMs: 86_400_000, max: 10 },
    ]
    expect(await hit(valkey, windows)).toEqual({ allowed: true })
    expect(await hit(valkey, windows)).toEqual({ allowed: false, retryAfterMs: 59_000 })
    const [sha, count, ...rest] = calls[0]?.args ?? []
    expect(sha).toBe(SLIDING_WINDOW.sha)
    expect(count).toBe(2)
    expect(rest.slice(0, 6)).toEqual(['it:rl:{auth}:a:x', 'it:rl:{auth}:b:x', 600_000, 3, 86_400_000, 10])
    expect(rest[6]).toMatch(/^[0-9a-f-]{36}$/)
    expect(rest).toHaveLength(7)
  })

  it('touches nothing for no windows', async () => {
    const { valkey, calls } = fakeValkey([])
    expect(await hit(valkey, [])).toEqual({ allowed: true })
    expect(calls).toEqual([])
  })

  it('sends the source once when Valkey has lost the script, and rethrows anything else', async () => {
    const lost = fakeValkey([new Error('NOSCRIPT No matching script. Please use EVAL.'), [1, 0]])
    expect(await runScript(lost.valkey, SLIDING_WINDOW, ['k'], [1, 2, 'm'])).toEqual([1, 0])
    expect(lost.calls.map(c => c.command)).toEqual(['evalsha', 'eval'])
    expect(lost.calls[1]?.args).toEqual([SLIDING_WINDOW.lua, 1, 'k', 1, 2, 'm'])

    const down = fakeValkey([new Error('Connection is closed.')])
    await expect(hit(down.valkey, [{ key: 'k', windowMs: 1, max: 1 }])).rejects.toThrow('Connection is closed.')
    expect(down.calls.map(c => c.command)).toEqual(['evalsha'])

    const odd = fakeValkey(['OK'])
    await expect(hit(odd.valkey, [{ key: 'k', windowMs: 1, max: 1 }])).rejects.toThrow(/unexpectedly/)
  })
})
