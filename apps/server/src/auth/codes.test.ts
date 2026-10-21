import { describe, expect, it } from 'vitest'
import {
  ATTACH,
  attachCode,
  OPEN,
  openCode,
  parseAttach,
  parseOpen,
  parseReserve,
  parseSettle,
  RESERVE,
  reserveCode,
  SETTLE,
  settleCode,
} from '#src/auth/codes.ts'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'

// Argument building and reply parsing only; the Lua runs against Valkey in
// codes.integration.test.ts.

const keys = valkeyKeys('it:unit:')

// Records each script call and answers `reply`.
function recorder(reply: unknown) {
  const calls: { sha: string; args: (string | number)[] }[] = []
  const valkey = {
    evalsha: async (sha: string, _n: number, ...args: (string | number)[]) => {
      calls.push({ sha, args })
      return reply
    },
    eval: async () => reply,
  }
  return { valkey: valkey as never, calls }
}

describe('T14 T20 the code challenge scripts: arguments and replies', () => {
  it("names the number's record, the owner and the policy numbers", async () => {
    const open = recorder('')
    expect(await openCode(open.valkey, keys, 'tag', 'owner')).toBeUndefined()
    expect(open.calls).toEqual([{ sha: OPEN.sha, args: ['it:unit:otp:{tag}', 'owner', 600_000] }])
    const attach = recorder('attached')
    expect(await attachCode(attach.valkey, keys, 'tag', 'owner', 'VE1')).toBe('attached')
    expect(attach.calls).toEqual([{ sha: ATTACH.sha, args: ['it:unit:otp:{tag}', 'owner', 'VE1'] }])
    const reserve = recorder(['wrong', 1])
    expect(await reserveCode(reserve.valkey, keys, 'tag', 'owner')).toEqual({ result: 'wrong', tries: 1 })
    expect(reserve.calls).toEqual([{ sha: RESERVE.sha, args: ['it:unit:otp:{tag}', 'owner', 300_000, 5] }])
    const settle = recorder(['failed', 0])
    expect(await settleCode(settle.valkey, keys, 'tag', 'owner', { ref: 'VE1', tries: 2 }, 'failed')).toEqual({
      result: 'failed',
    })
    expect(settle.calls).toEqual([{ sha: SETTLE.sha, args: ['it:unit:otp:{tag}', 'owner', 'VE1', 'failed', 2, 5] }])
  })

  it('parses every reply, and refuses anything else', () => {
    expect(parseOpen('VE1')).toBe('VE1')
    expect(parseOpen('')).toBeUndefined()
    expect(parseAttach('lost')).toBe('lost')
    expect(parseReserve(['expired', ''])).toEqual({ result: 'expired', ref: undefined })
    expect(parseReserve(['expired', 'VE1'])).toEqual({ result: 'expired', ref: 'VE1' })
    expect(parseReserve(['dead', 5])).toEqual({ result: 'dead', tries: 5 })
    expect(parseReserve(['check', 'VE1', 3])).toEqual({ result: 'check', ref: 'VE1', tries: 3 })
    expect(parseSettle(['approved', 2])).toEqual({ result: 'approved', tries: 2 })
    expect(parseSettle(['dead', 5])).toEqual({ result: 'dead', tries: 5 })
    expect(parseSettle(['displaced', 3])).toEqual({ result: 'displaced', tries: 3 })
    expect(parseSettle(['expired', 1])).toEqual({ result: 'expired' })
    for (const bad of [1, null, ['ok', 1], ['check', '', 1], ['wrong', 'x']]) {
      expect(() => parseReserve(bad)).toThrow(/answered unexpectedly/)
    }
    for (const bad of [null, ['ok', 1], ['wrong'], ['displaced']]) {
      expect(() => parseSettle(bad)).toThrow(/answered unexpectedly/)
    }
    expect(() => parseOpen(1)).toThrow(/answered unexpectedly/)
    expect(() => parseAttach('ok')).toThrow(/answered unexpectedly/)
  })
})
