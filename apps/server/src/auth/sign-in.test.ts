import type { Redis } from 'ioredis'
import { describe, expect, it, vi } from 'vitest'
import type { Api } from '#src/api.ts'
import type { Attempt } from '#src/auth/attempts.ts'
import { Breaker } from '#src/auth/breaker.ts'
import { ATTACH, OPEN, RESERVE, SETTLE } from '#src/auth/codes.ts'
import { deriveKeys, hashPin, keyName } from '#src/auth/crypto.ts'
import { ApiError } from '#src/auth/errors.ts'
import { SLIDING_WINDOW } from '#src/auth/limiter.ts'
import { relyingParty } from '#src/auth/passkeys.ts'
import { OTP } from '#src/auth/policy.ts'
import {
  passkeyOptions,
  pinRefusal,
  requestCode,
  setPin,
  tooManyRequests,
  verifyCode,
  verifyPinStep,
} from '#src/auth/sign-in.ts'
import { FakeVerify } from '#src/auth/sms/fake.ts'
import { type SmsProvider, SmsProviderError, type Verdict } from '#src/auth/sms/provider.ts'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'
import { AfterResponse, type ReqInfo } from '#src/http.ts'
import { staticFlags } from '#src/testing/flags.ts'
import { type Statement, scriptedPool, systemPrincipal } from '#src/testing/pool.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const PERSON = 'b0000000-0000-4000-8000-000000000001'
const NUMBER = 'b0000000-0000-4000-8000-0000000000f1'
const SYSTEM = 'c0000000-0000-4000-8000-000000000001'
const PREFIX = 'it:unit:'
const ATTEMPT_ID = 'i'.repeat(43)
const names = valkeyKeys(PREFIX)
const named = { orgId: ORG, personId: PERSON, phoneNumberId: NUMBER }

// Valkey holding one attempt; the challenge's RESERVE answers `reserve` and SETTLE `settle` (both
// run against Valkey in codes.integration.test.ts), OPEN records its owner for the deliverer's
// owner check, any other script answers 'attached', and the limiter allows.
function valkeyWith(
  attempt: Attempt | undefined,
  reserve: unknown[] = ['wrong', 1],
  settle: unknown[] = ['approved', 1],
  replaced?: string,
) {
  const store = new Map<string, string>()
  if (attempt) store.set(names.attempt(keyName(ATTEMPT_ID)), JSON.stringify(attempt))
  let owner: string | null = null
  const calls: { sha: string; args: (string | number)[] }[] = []
  const valkey = {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string, ...options: string[]) => {
      if (options.includes('XX') && !store.has(key)) return null
      store.set(key, value)
      return 'OK'
    },
    del: async (key: string) => (store.delete(key) ? 1 : 0),
    hget: async () => owner,
    evalsha: async (sha: string, _n: number, ..._args: (string | number)[]) => {
      calls.push({ sha, args: _args })
      if (sha === SLIDING_WINDOW.sha) return [1, 0]
      if (sha === RESERVE.sha) return reserve
      if (sha === SETTLE.sha) return settle
      if (sha === OPEN.sha) {
        owner = String(_args[1])
        return replaced ?? ''
      }
      return 'attached'
    },
  }
  return {
    valkey: valkey as unknown as Redis,
    store,
    calls,
    // Another request takes the record (as OPEN would for a newer attempt).
    displace: () => {
      owner = 'someone-else'
    },
  }
}

// A provider whose check answers `verdict` (or throws), recording cancels.
function checking(verdict: Verdict | Error) {
  const cancels: string[] = []
  const sms: SmsProvider = {
    name: 'fake',
    transfer: null,
    start: async () => ({ ref: 'VE1', foreign: false }),
    check: async () => {
      if (verdict instanceof Error) throw verdict
      return verdict
    },
    cancel: async ref => {
      cancels.push(ref)
    },
  }
  return { sms, cancels }
}

// The org's rows a code check reads: the person (left or not), the number the code went to (still
// theirs or not), their account and passkeys. `roster` also answers the roster lookup with them.
function orgPool(person: Parameters<typeof orgAnswer>[0] = {}) {
  return scriptedPool(orgAnswer(person))
}

function orgAnswer(
  person: {
    left?: boolean
    numberRemoved?: boolean
    pinHash?: string | null
    passkeys?: number
    roster?: boolean
    // Roles they hold now (D46): any of the Owner-only roles makes them privileged.
    roles?: string[]
  } = {},
) {
  return (statement: Statement) => {
    const { text } = statement
    if (text.startsWith('select id, deactivated_at from people')) {
      return [{ id: PERSON, deactivated_at: person.left ? new Date('2026-10-01T00:00:00Z') : null }]
    }
    if (text.startsWith('select person_id, role, team_id, revoked_at from role_assignments')) {
      return (person.roles ?? []).map(role => ({ person_id: PERSON, role, team_id: null, revoked_at: null }))
    }
    if (text.startsWith('insert into "devices"')) return [{ id: 'b0000000-0000-4000-8000-0000000000d1' }]
    if (text.startsWith('insert into sessions')) return [{ id: 'b0000000-0000-4000-8000-0000000000e1' }]
    if (person.roster && text.includes('from public.person_by_phone(')) {
      return [{ phone_number_id: NUMBER, org_id: ORG, person_id: PERSON }]
    }
    if (text.startsWith('select deactivated_at from people')) {
      return [{ deactivated_at: person.left ? new Date('2026-10-01T00:00:00Z') : null }]
    }
    if (text.startsWith('select 1 from phone_numbers')) return person.numberRemoved ? [] : [{ '?column?': 1 }]
    if (text.startsWith('select pin_hash, pin_failures')) {
      if (person.pinHash === undefined) return []
      return [{ pin_hash: person.pinHash, pin_failures: 0, pin_last_failed_at: null, now: new Date() }]
    }
    if (text.startsWith('select count(*) as n from passkeys')) return [{ n: String(person.passkeys ?? 0) }]
    return systemPrincipal(SYSTEM)(statement)
  }
}

// The provider approves every code unless a test gives another.
function context(valkey: Redis, pool = scriptedPool(), sms: SmsProvider = checking('approved').sms) {
  const tasks: (() => Promise<void>)[] = []
  const api: Api = {
    db: pool.db,
    valkey,
    keys: deriveKeys('unit-test-unit-test-unit-test-unit-test'),
    sms,
    keyPrefix: PREFIX,
    flags: staticFlags(),
    afterResponse: new AfterResponse(),
    appOrigin: 'https://hearth.example.com',
    names,
    rp: relyingParty('https://hearth.example.com'),
    otp: { verifyFloorMs: 0, breaker: new Breaker(OTP.breaker) },
  }
  const info: ReqInfo = {
    ip: '198.51.100.7',
    requestId: 'f0000000-0000-4000-8000-000000000001',
    userAgent: undefined,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ReqInfo['log'],
    after: task => tasks.push(task),
  }
  return { api, info, tasks, pool }
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!(error instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(error)}`)
  return error
}

const code = { code: '123456' }

describe('PRD-53 ACC-03 T14 checking a sign-in code', () => {
  it('answers a missing attempt 401 attempt_expired, clearing its cookie, and one at another step 409 wrong_step', async () => {
    const none = context(valkeyWith(undefined).valkey)
    expect(await refusal(verifyCode(none.api, code, ATTEMPT_ID, none.info))).toMatchObject({
      status: 401,
      code: 'attempt_expired',
      clear: ['attempt'],
    })
    const later = context(valkeyWith({ v: 1, numberTag: 't', step: 'set_pin', ...named }).valkey)
    expect(await refusal(verifyCode(later.api, code, ATTEMPT_ID, later.info))).toMatchObject({
      status: 409,
      code: 'wrong_step',
    })
  })

  it('answers wrong, dead and expired codes with tries left, and audits only an attempt that names someone', async () => {
    for (const [reserve, settle, answer] of [
      [['wrong', 1], [], { status: 401, code: 'code_wrong', extra: { triesLeft: 4 } }],
      [['dead', 5], [], { status: 401, code: 'code_dead' }],
      [['expired', ''], [], { status: 401, code: 'code_expired' }],
      [['check', 'VE1', 1], ['wrong', 1], { status: 401, code: 'code_wrong', extra: { triesLeft: 4 } }],
      [['check', 'VE1', 4], ['wrong', 4], { status: 401, code: 'code_wrong', extra: { triesLeft: 1 } }],
      [['check', 'VE1', 5], ['dead', 5], { status: 401, code: 'code_dead' }],
      [['check', 'VE1', 2], ['expired', 2], { status: 401, code: 'code_expired' }],
      // T14 item 3: a check a newer request overtook answers from its own try, as RESERVE answers
      // the same try at a number off the roster.
      [['check', 'VE1', 2], ['displaced', 2], { status: 401, code: 'code_wrong', extra: { triesLeft: 3 } }],
      [['check', 'VE1', 5], ['displaced', 5], { status: 401, code: 'code_dead' }],
    ] as const) {
      const sms = checking('wrong').sms
      const nobody = context(valkeyWith({ v: 1, numberTag: 't', step: 'code_sent' }, [...reserve], [...settle]).valkey)
      nobody.api.sms = sms
      expect(await refusal(verifyCode(nobody.api, code, ATTEMPT_ID, nobody.info))).toMatchObject(answer)
      const someone = context(
        valkeyWith({ v: 1, numberTag: 't', step: 'code_sent', ...named }, [...reserve], [...settle]).valkey,
      )
      someone.api.sms = sms
      expect(await refusal(verifyCode(someone.api, code, ATTEMPT_ID, someone.info))).toMatchObject(answer)
      // The audit row, and for a dead code its cancel, run after the reply.
      const cancels = settle[0] === 'dead' ? 1 : 0
      expect(nobody.tasks).toHaveLength(cancels)
      expect(someone.tasks).toHaveLength(1 + cancels)
    }
  })

  it("T20: cancels a caller's own expired or dead code after the reply, and nothing of another owner's", async () => {
    const expired = checking('wrong')
    const own = context(valkeyWith({ v: 1, numberTag: 't', step: 'code_sent' }, ['expired', 'VE9']).valkey)
    own.api.sms = expired.sms
    expect(await refusal(verifyCode(own.api, code, ATTEMPT_ID, own.info))).toMatchObject({ code: 'code_expired' })
    expect(expired.cancels).toEqual([])
    for (const task of own.tasks) await task()
    expect(expired.cancels).toEqual(['VE9'])

    const dead = checking('wrong')
    const fifth = context(
      valkeyWith({ v: 1, numberTag: 't', step: 'code_sent' }, ['check', 'VE1', 5], ['dead', 5]).valkey,
    )
    fifth.api.sms = dead.sms
    expect(await refusal(verifyCode(fifth.api, code, ATTEMPT_ID, fifth.info))).toMatchObject({ code: 'code_dead' })
    for (const task of fifth.tasks) await task()
    expect(dead.cancels).toEqual(['VE1'])

    // T14 items 3 and 4: a newer request replaced the record during the check. The newest request
    // wins: nobody signs in although the provider approved, and nothing is cancelled, not even at
    // the 5th try. The reply comes from the check's own try, as at a number off the roster, never
    // code_expired, which would tell a roster number apart.
    for (const [tries, answer] of [
      [1, { status: 401, code: 'code_wrong', extra: { triesLeft: 4 } }],
      [5, { status: 401, code: 'code_dead' }],
    ] as const) {
      const displaced = checking('approved')
      const stale = context(
        valkeyWith({ v: 1, numberTag: 't', step: 'code_sent', ...named }, ['check', 'VE1', tries], ['displaced', tries])
          .valkey,
        orgPool(),
      )
      stale.api.sms = displaced.sms
      expect(await refusal(verifyCode(stale.api, code, ATTEMPT_ID, stale.info))).toMatchObject(answer)
      // The audit row only.
      expect(stale.tasks).toHaveLength(1)
      for (const task of stale.tasks) await task()
      expect(displaced.cancels).toEqual([])
      expect(stale.pool.texts().some(text => text.includes('pin_hash'))).toBe(false)
      const audit = stale.pool.statements.find(s => s.text.startsWith('insert into "audit_events"'))
      expect(audit?.values).toContainEqual({ result: tries < 5 ? 'wrong' : 'dead' })
    }
  })

  it('T20: answers 503 when the provider cannot check, giving the try back, and the attempt stays at the code', async () => {
    const down = checking(new Error('cut off'))
    const settles: unknown[][] = []
    const valkey = valkeyWith({ v: 1, numberTag: 't', step: 'code_sent', ...named }, ['check', 'VE1', 1], ['failed', 0])
    const evalsha = (valkey.valkey as unknown as { evalsha: (...a: unknown[]) => Promise<unknown> }).evalsha
    ;(valkey.valkey as unknown as { evalsha: (...a: unknown[]) => Promise<unknown> }).evalsha = async (...a) => {
      if (a[0] === SETTLE.sha) settles.push(a.slice(2))
      return evalsha(...a)
    }
    const failed = context(valkey.valkey)
    failed.api.sms = down.sms
    expect(await refusal(verifyCode(failed.api, code, ATTEMPT_ID, failed.info))).toMatchObject({
      status: 503,
      code: 'unavailable',
    })
    expect(settles).toEqual([[names.otp('t'), keyName(ATTEMPT_ID), 'VE1', 'failed', 1, 5]])
    expect(failed.tasks).toHaveLength(0)
    expect(JSON.parse(valkey.store.get(names.attempt(keyName(ATTEMPT_ID))) ?? '{}')).toMatchObject({
      step: 'code_sent',
    })
  })

  it('answers an approved code on an attempt that names nobody exactly as a wrong guess at that count', async () => {
    const first = context(valkeyWith({ v: 1, numberTag: 't', step: 'code_sent' }, ['check', 'VE1', 1]).valkey)
    first.api.sms = checking('approved').sms
    expect(await refusal(verifyCode(first.api, code, ATTEMPT_ID, first.info))).toMatchObject({
      status: 401,
      code: 'code_wrong',
      extra: { triesLeft: 4 },
    })
    const fifth = context(
      valkeyWith({ v: 1, numberTag: 't', step: 'code_sent' }, ['check', 'VE1', 5], ['approved', 5]).valkey,
    )
    fifth.api.sms = checking('approved').sms
    expect(await refusal(verifyCode(fifth.api, code, ATTEMPT_ID, fifth.info))).toMatchObject({ code: 'code_dead' })
    expect(first.pool.statements).toEqual([])
  })

  it('ACC-05: answers the right code for someone who has left as a wrong one, and audits it with left', async () => {
    const pool = orgPool({ left: true, pinHash: null })
    const left = context(
      valkeyWith({ v: 1, numberTag: 't', step: 'code_sent', ...named }, ['check', 'VE1', 1]).valkey,
      pool,
    )
    expect(await refusal(verifyCode(left.api, code, ATTEMPT_ID, left.info))).toMatchObject({
      code: 'code_wrong',
      extra: { triesLeft: 4 },
    })
    expect(left.tasks).toHaveLength(1)
    await left.tasks[0]?.()
    const audit = pool.statements.find(s => s.text.startsWith('insert into "audit_events"'))
    expect(audit?.values).toContain('auth.code_failed')
    expect(audit?.values).toContainEqual({ result: 'wrong', left: true })
  })

  it('ACC-03 T14: answers the right code sent to a number removed or moved since as a wrong one, shows nothing of the account, and audits it', async () => {
    const pin = `$argon2id$v=19$m=19456,t=2,p=1$${'A'.repeat(22)}$${'B'.repeat(43)}`
    const pool = orgPool({ numberRemoved: true, pinHash: pin, passkeys: 1 })
    const stale = valkeyWith({ v: 1, numberTag: 't', step: 'code_sent', ...named }, ['check', 'VE1', 1])
    const removed = context(stale.valkey, pool)
    expect(await refusal(verifyCode(removed.api, code, ATTEMPT_ID, removed.info))).toMatchObject({
      code: 'code_wrong',
      extra: { triesLeft: 4 },
    })
    // The attempt stays where it was, and neither the PIN nor the passkeys were read.
    expect(JSON.parse(stale.store.get(names.attempt(keyName(ATTEMPT_ID))) ?? '{}')).toMatchObject({ step: 'code_sent' })
    expect(pool.texts().filter(text => text.includes('pin_hash') || text.includes('from passkeys'))).toEqual([])
    const number = pool.statements.find(s => s.text.startsWith('select 1 from phone_numbers'))
    expect(number?.text).toMatch(/person_id = \$\d+ and removed_at is null for share$/)
    expect(number?.values).toEqual(expect.arrayContaining([ORG, NUMBER, PERSON]))
    expect(removed.tasks).toHaveLength(1)
    await removed.tasks[0]?.()
    const audit = pool.statements.find(s => s.text.startsWith('insert into "audit_events"'))
    expect(audit?.values).toContain('auth.code_failed')
    expect(audit?.values).toContainEqual({ result: 'wrong', numberRemoved: true })
  })

  it("D46 AQ-02: moves a privileged holder's first sign-in to set_pin, and one with a PIN to the step-up with their PIN state", async () => {
    const first = valkeyWith({ v: 1, numberTag: 't', step: 'code_sent', ...named }, ['check', 'VE1', 1])
    const firstContext = context(first.valkey, orgPool({ roles: ['admin'] }))
    expect(await verifyCode(firstContext.api, code, ATTEMPT_ID, firstContext.info)).toEqual({
      body: { status: 'code_verified', next: 'set_pin' },
    })
    expect(JSON.parse(first.store.get(names.attempt(keyName(ATTEMPT_ID))) ?? '{}')).toMatchObject({ step: 'set_pin' })

    const again = valkeyWith(
      { v: 1, numberTag: 't', step: 'code_sent', ...named },
      ['check', 'VE1', 3],
      ['approved', 3],
    )
    const hash = `$argon2id$v=19$m=19456,t=2,p=1$${'A'.repeat(22)}$${'B'.repeat(43)}`
    const againContext = context(again.valkey, orgPool({ pinHash: hash, passkeys: 1, roles: ['owner'] }))
    expect(await verifyCode(againContext.api, code, ATTEMPT_ID, againContext.info)).toEqual({
      body: {
        status: 'code_verified',
        next: 'step_up',
        pin: { state: 'ok', triesBeforeLock: 5, triesBeforeAdminLock: 10 },
        passkey: true,
      },
    })
    expect(JSON.parse(again.store.get(names.attempt(keyName(ATTEMPT_ID))) ?? '{}')).toMatchObject({ step: 'step_up' })
  })
})

describe('D46 T20 the code-only finish, the verified step, the floor and the breaker', () => {
  const attemptKey = names.attempt(keyName(ATTEMPT_ID))

  it('D46 AQ-02: signs someone with no privileged role in on the code alone, making their account, and uses the attempt up last', async () => {
    const valkey = valkeyWith({ v: 1, numberTag: 't', step: 'code_sent', ...named }, ['check', 'VE1', 1])
    const pool = orgPool({ roles: [] })
    const { api, info } = context(valkey.valkey, pool)
    const answer = await verifyCode(api, code, ATTEMPT_ID, info)
    expect(answer.body).toEqual({
      status: 'signed_in',
      device: { id: 'b0000000-0000-4000-8000-0000000000d1', label: expect.any(String) },
    })
    expect(answer.cookies?.[0]).toMatch(/^__Host-hearth_session=.*Max-Age=7776000/)
    expect(valkey.store.has(attemptKey)).toBe(false)
    const work = pool
      .texts()
      .filter(text => !/^(start transaction|commit|select set_config|select id from principals)/.test(text))
    // People first, then the roles, then users before phone_numbers (the lock order), and no PIN read.
    expect(work[0]).toMatch(/^select deactivated_at from people .* for share$/)
    expect(work.findIndex(t => t.startsWith('insert into users'))).toBeGreaterThan(
      work.findIndex(t => t.startsWith('select person_id, role')),
    )
    expect(work.findIndex(t => t.startsWith('select 1 from phone_numbers'))).toBeGreaterThan(
      work.findIndex(t => t.startsWith('insert into users')),
    )
    expect(work.some(t => t.includes('pin_hash'))).toBe(false)
    const session = pool.statements.find(st => st.text.startsWith('insert into sessions'))
    expect(session?.values.at(-1)).toBe('2160 hours')
  })

  it('T20 R1: a finish that fails before the consume leaves the attempt verified, and a retry with any 6 digits finishes it with no second check', async () => {
    const valkey = valkeyWith({ v: 1, numberTag: 't', step: 'code_sent', ...named }, ['check', 'VE1', 1])
    let fail = true
    const rows = orgAnswer({ roles: [] })
    const failing = scriptedPool(statement => {
      if (fail && statement.text.startsWith('insert into users')) return new Error('connection lost')
      return rows(statement)
    })
    const checks: string[] = []
    const sms: SmsProvider = {
      ...checking('approved').sms,
      check: async ref => {
        checks.push(ref)
        return 'approved'
      },
    }
    const first = context(valkey.valkey, failing, sms)
    await expect(verifyCode(first.api, code, ATTEMPT_ID, first.info)).rejects.toThrow('connection lost')
    expect(JSON.parse(valkey.store.get(attemptKey) ?? '{}')).toMatchObject({ step: 'verified' })
    fail = false
    const again = context(valkey.valkey, failing, sms)
    const answer = await verifyCode(again.api, { code: '000000' }, ATTEMPT_ID, again.info)
    expect(answer.body).toMatchObject({ status: 'signed_in' })
    expect(checks).toEqual(['VE1'])
    expect(valkey.store.has(attemptKey)).toBe(false)
  })

  it('T20 R2: a stale first pass sends the attempt back to the code; a stale retry drops it', async () => {
    const first = valkeyWith({ v: 1, numberTag: 't', step: 'code_sent', ...named }, ['check', 'VE1', 1])
    const left = context(first.valkey, orgPool({ left: true }))
    expect(await refusal(verifyCode(left.api, code, ATTEMPT_ID, left.info))).toMatchObject({ code: 'code_wrong' })
    expect(JSON.parse(first.store.get(attemptKey) ?? '{}')).toMatchObject({ step: 'code_sent' })

    const retry = valkeyWith({ v: 1, numberTag: 't', step: 'verified', ...named })
    const gone = context(retry.valkey, orgPool({ numberRemoved: true }))
    expect(await refusal(verifyCode(gone.api, code, ATTEMPT_ID, gone.info))).toMatchObject({
      status: 401,
      code: 'attempt_expired',
    })
    expect(retry.store.has(attemptKey)).toBe(false)
  })

  it('T20: a verified attempt that names nobody answers attempt_expired', async () => {
    const valkey = valkeyWith({ v: 1, numberTag: 't', step: 'verified' })
    const { api, info } = context(valkey.valkey)
    expect(await refusal(verifyCode(api, code, ATTEMPT_ID, info))).toMatchObject({
      status: 401,
      code: 'attempt_expired',
    })
  })

  it('T20 AQ-20: after 3 provider failures every check answers 503 without asking the provider', async () => {
    const down = checking(new Error('cut off'))
    let calls = 0
    const sms: SmsProvider = {
      ...down.sms,
      check: async (ref, c) => {
        calls += 1
        return down.sms.check(ref, c)
      },
    }
    const valkey = valkeyWith({ v: 1, numberTag: 't', step: 'code_sent', ...named }, ['check', 'VE1', 1], ['failed', 0])
    const { api, info } = context(valkey.valkey, scriptedPool(), sms)
    for (let i = 0; i < 3; i += 1) {
      expect(await refusal(verifyCode(api, code, ATTEMPT_ID, info))).toMatchObject({ status: 503, code: 'unavailable' })
    }
    expect(calls).toBe(3)
    const nobody = valkeyWith({ v: 1, numberTag: 't', step: 'code_sent' }, ['wrong', 1])
    for (const v of [valkey.valkey, nobody.valkey]) {
      const other = context(v, scriptedPool(), sms)
      other.api.otp = api.otp
      expect(await refusal(verifyCode(other.api, code, ATTEMPT_ID, other.info))).toMatchObject({ status: 503 })
    }
    expect(calls).toBe(3)
  })

  it('T14 item 3 T20: a refused check answers no sooner than the floor, and a success is not padded', async () => {
    const wrong = context(valkeyWith({ v: 1, numberTag: 't', step: 'code_sent' }, ['wrong', 1]).valkey)
    wrong.api.otp = { ...wrong.api.otp, verifyFloorMs: 150 }
    const started = Date.now()
    expect(await refusal(verifyCode(wrong.api, code, ATTEMPT_ID, wrong.info))).toMatchObject({ code: 'code_wrong' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(149)

    const right = context(
      valkeyWith({ v: 1, numberTag: 't', step: 'code_sent', ...named }, ['check', 'VE1', 1]).valkey,
      orgPool({ roles: [] }),
    )
    right.api.otp = { ...right.api.otp, verifyFloorMs: 5_000 }
    const begun = Date.now()
    expect((await verifyCode(right.api, code, ATTEMPT_ID, right.info)).body).toMatchObject({ status: 'signed_in' })
    expect(Date.now() - begun).toBeLessThan(5_000)
  })
})

describe('ACC-03 T14 sending a code after the reply', () => {
  // A code request for a roster number, with its after-reply work run: what was texted, and the
  // audit row's details.
  async function delivered(
    person: { left?: boolean; numberRemoved?: boolean },
    options: { sms?: FakeVerify; gate?: Api['gate']; info?: (info: ReqInfo) => void } = {},
  ) {
    const pool = orgPool({ ...person, roster: true })
    const sms = options.sms ?? new FakeVerify()
    const { api, info, tasks } = context(valkeyWith(undefined).valkey, pool, sms)
    if (options.gate !== undefined) api.gate = options.gate
    const reply = await requestCode(api, { phone: '+6591234567' }, undefined, info)
    expect(reply.body).toEqual({ status: 'code_sent', expiresInSeconds: 300, codeLength: 6 })
    for (const task of tasks) await task()
    options.info?.(info)
    const audit = pool.statements.find(s => s.text.startsWith('insert into "audit_events"'))
    return {
      sent: sms.sent.map(entry => entry.to),
      audit: audit?.values.find(value => typeof value === 'object' && value !== null),
    }
  }

  it('texts a current roster number of someone still here, and audits it attempted', async () => {
    expect(await delivered({})).toEqual({ sent: ['+6591234567'], audit: { send: 'attempted' } })
  })

  it('texts nothing to a number removed or moved after the roster lookup, and audits it skipped_number_removed', async () => {
    expect(await delivered({ numberRemoved: true })).toEqual({ sent: [], audit: { send: 'skipped_number_removed' } })
  })

  it('texts nothing to someone who left after the roster lookup, and audits it skipped_left', async () => {
    expect(await delivered({ left: true })).toEqual({ sent: [], audit: { send: 'skipped_left' } })
  })

  it('PDPA-10 T20: texts nothing through a provider the transfer register has not cleared, and audits it skipped_not_cleared', async () => {
    // No gate given: C06_GATE, which clears no provider until C0.9.
    const unset = await delivered({}, { sms: new FakeVerify({ transfer: 'twilio' }) })
    expect(unset).toEqual({ sent: [], audit: { send: 'skipped_not_cleared' } })
    const asked: [string, string][] = []
    const cleared = await delivered(
      {},
      {
        sms: new FakeVerify({ transfer: 'twilio' }),
        gate: {
          providerCleared: (orgId, provider) => {
            asked.push([orgId, provider])
            return true
          },
        },
      },
    )
    expect(cleared).toEqual({ sent: ['+6591234567'], audit: { send: 'attempted' } })
    expect(asked).toEqual([[ORG, 'twilio']])
    // The local fake needs no entry: it sends nothing anywhere, so no gate is asked.
    expect(await delivered({}, { gate: { providerCleared: () => false } })).toEqual({
      sent: ['+6591234567'],
      audit: { send: 'attempted' },
    })
  })

  it("T7 T20: logs a failed send with the provider's code and HTTP status, never the number", async () => {
    const sms = new FakeVerify()
    sms.failNext('start', new SmsProviderError('blocked', 60410, 403))
    let logged: unknown[][] = []
    const result = await delivered({}, { sms, info: info => (logged = vi.mocked(info.log.error).mock.calls) })
    expect(result).toEqual({ sent: [], audit: { send: 'attempted' } })
    expect(logged).toEqual([
      [
        {
          event: 'sms_send_failed',
          provider: 'fake',
          error: 'SmsProviderError',
          kind: 'blocked',
          providerCode: 60410,
          httpStatus: 403,
          personId: PERSON,
        },
        'a code could not be sent',
      ],
    ])
    expect(JSON.stringify(logged)).not.toContain('91234567')
  })

  // A code request for the seed-range number +65 8000 0001 with a provider that has `pending`
  // verifications for it already (foreign ones Hearth didn't start), and its after-reply work run.
  async function started(
    options: { pending?: number; replaced?: string; displaceAfterStart?: boolean; newerAtSecondStart?: boolean } = {},
  ) {
    const pool = orgPool({ roster: true })
    const sms = new FakeVerify()
    const valkey = valkeyWith(undefined, undefined, undefined, options.replaced)
    const { api, info, tasks } = context(valkey.valkey, pool, sms)
    const before: string[] = []
    for (let i = 0; i < (options.pending ?? 0); i++) {
      const { ref } = await sms.start('+6580000001')
      before.push(ref)
    }
    const start = sms.start.bind(sms)
    if (options.displaceAfterStart) {
      sms.start = async to => {
        const result = await start(to)
        valkey.displace()
        return result
      }
    }
    // Just before this request's second start, a newer request takes the record and starts its
    // own code, a fresh verification (the first was cancelled), which the second start then gets
    // back as foreign.
    const newer: string[] = []
    if (options.newerAtSecondStart) {
      let starts = 0
      sms.start = async to => {
        starts++
        if (starts === 2) {
          valkey.displace()
          newer.push((await start(to)).ref)
        }
        return start(to)
      }
    }
    await requestCode(api, { phone: '+65 8000 0001' }, undefined, info)
    for (const task of tasks) await task()
    const attached = valkey.calls.filter(call => call.sha === ATTACH.sha).map(call => call.args[2])
    return { sms, before, attached, info, newer }
  }

  it("T20: cancels the replaced code first, then attaches the new reference to the owner's record", async () => {
    const { sms, attached } = await started({ replaced: 'VE-replaced' })
    expect(sms.cancels).toEqual([{ ref: 'VE-replaced' }])
    expect(attached).toEqual([sms.sent.at(-1)?.ref])
  })

  it('T20: a foreign verification is cancelled and started once more while the owner still holds the record', async () => {
    const { sms, before, attached } = await started({ pending: 1 })
    expect(sms.cancels.map(c => c.ref)).toEqual(before)
    const fresh = sms.sent.at(-1)?.ref
    expect(fresh).not.toBe(before[0])
    expect(attached).toEqual([fresh])
  })

  it('T20: a second foreign reply is cancelled too, nothing is attached, and it is logged without the number', async () => {
    const pool = orgPool({ roster: true })
    const sms = new FakeVerify()
    // Every start hands back a verification with more sends than Hearth made.
    sms.start = async () => ({ ref: `VE${'f'.repeat(32)}`, foreign: true })
    const valkey = valkeyWith(undefined)
    const { api, info, tasks } = context(valkey.valkey, pool, sms)
    await requestCode(api, { phone: '+65 8000 0001' }, undefined, info)
    for (const task of tasks) await task()
    expect(sms.cancels).toHaveLength(2)
    expect(valkey.calls.filter(call => call.sha === ATTACH.sha)).toEqual([])
    expect(info.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'provider_foreign_verification', personId: PERSON }),
      expect.any(String),
    )
    expect(JSON.stringify(vi.mocked(info.log.warn).mock.calls)).not.toContain('80000001')
  })

  it('T20: a request that lost the record to a newer one leaves its verification alone, even a foreign one', async () => {
    const { sms, attached } = await started({ pending: 1, displaceAfterStart: true })
    expect(sms.cancels).toEqual([])
    expect(attached).toEqual([])
  })

  it("T14 T20: a request that loses the record during its second start never cancels the newer owner's code", async () => {
    const { sms, before, attached, newer, info } = await started({ pending: 1, newerAtSecondStart: true })
    // Only the stray verification was cancelled; the newer owner's, handed back as foreign, was left
    // alone, and nothing was attached or logged as foreign.
    expect(sms.cancels.map(c => c.ref)).toEqual(before)
    expect(sms.sent.at(-1)?.ref).toBe(newer[0])
    expect(attached).toEqual([])
    expect(info.log.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'provider_foreign_verification' }),
      expect.any(String),
    )
    // The newer owner's code still works.
    const ref = newer[0] ?? ''
    const code = sms.sent.find(entry => entry.ref === ref)?.code ?? ''
    expect(await sms.check(ref, code)).toBe('approved')
  })
})

describe('SHL-49 PRD-53 the PIN steps refuse before any work', () => {
  it('sets a PIN only after a code check that answered set_pin, and checks its format and strength first', async () => {
    const early = context(valkeyWith({ v: 1, numberTag: 't', step: 'code_sent', ...named }).valkey)
    expect(await refusal(setPin(early.api, { pin: '381904' }, ATTEMPT_ID, early.info))).toMatchObject({
      code: 'wrong_step',
    })
    const ready = { v: 1, numberTag: 't', step: 'set_pin', ...named } as const
    for (const [pin, answer] of [
      ['12345', { status: 400, code: 'invalid_pin' }],
      ['１２３４５６', { status: 400, code: 'invalid_pin' }],
      ['123456', { status: 422, code: 'pin_too_easy' }],
      ['111111', { status: 422, code: 'pin_too_easy' }],
    ] as const) {
      const c = context(valkeyWith(ready).valkey)
      expect(await refusal(setPin(c.api, { pin }, ATTEMPT_ID, c.info))).toMatchObject(answer)
      expect(c.pool.statements).toEqual([])
    }
  })

  it('checks a PIN only at the step-up, and only one of 6 digits', async () => {
    const early = context(valkeyWith({ v: 1, numberTag: 't', step: 'set_pin', ...named }).valkey)
    expect(await refusal(verifyPinStep(early.api, { pin: '381904' }, ATTEMPT_ID, early.info))).toMatchObject({
      code: 'wrong_step',
    })
    const c = context(valkeyWith({ v: 1, numberTag: 't', step: 'step_up', ...named }).valkey)
    expect(await refusal(verifyPinStep(c.api, { pin: '38190' }, ATTEMPT_ID, c.info))).toMatchObject({
      status: 400,
      code: 'invalid_pin',
    })
    expect(c.pool.statements).toEqual([])
  })
})

describe('ACC-03 T14 a sign-in step after the number was removed or moved', () => {
  const pin = `$argon2id$v=19$m=19456,t=2,p=1$${'A'.repeat(22)}$${'B'.repeat(43)}`

  // The step-up for someone with a PIN and a passkey whose number has gone: each step drops the
  // attempt and answers attempt_expired, before the PIN or any passkey is read.
  async function refusedAt(
    step: 'set_pin' | 'step_up',
    lock: 'none' | 'for share',
    run: (c: ReturnType<typeof context>) => Promise<unknown>,
  ) {
    const pool = orgPool({ numberRemoved: true, pinHash: step === 'set_pin' ? null : pin, passkeys: 1 })
    const held = valkeyWith({ v: 1, numberTag: 't', step, ...named })
    const c = context(held.valkey, pool)
    expect(await refusal(run(c))).toMatchObject({ status: 401, code: 'attempt_expired', clear: ['attempt'] })
    expect(held.store.has(names.attempt(keyName(ATTEMPT_ID)))).toBe(false)
    const number = pool.texts().find(text => text.startsWith('select 1 from phone_numbers'))
    // With no lock where users or passkeys are locked next (they come before phone_numbers in the
    // lock order), and FOR SHARE where nothing else is.
    expect(number).toMatch(lock === 'none' ? /removed_at is null$/ : /removed_at is null for share$/)
    // Nothing of the account was read or written: no PIN, no failure count, no passkey.
    expect(pool.texts().filter(text => /pin_hash|pin_failures|passkeys|insert into/.test(text))).toEqual([])
  }

  it('refuses the PIN at the step-up, right or wrong, without counting it', async () => {
    await refusedAt('step_up', 'none', c => verifyPinStep(c.api, { pin: '381904' }, ATTEMPT_ID, c.info))
  })

  it('refuses passkey options, showing none of the passkeys', async () => {
    await refusedAt('step_up', 'for share', c => passkeyOptions(c.api, ATTEMPT_ID, c.info))
  })

  it('refuses a new PIN before hashing it', async () => {
    await refusedAt('set_pin', 'for share', c => setPin(c.api, { pin: '381904' }, ATTEMPT_ID, c.info))
  })

  it('rolls back a wrong PIN whose number was removed after the unlocked read, counting nothing', async () => {
    const held = valkeyWith({ v: 1, numberTag: 't', step: 'step_up', ...named })
    const keys = deriveKeys('unit-test-unit-test-unit-test-unit-test')
    const stored = await hashPin('381904', keys)
    // The number is still there when read with no lock, and gone once read FOR SHARE after the
    // PIN check: the removal committed in between.
    const pool = scriptedPool(statement => {
      const { text } = statement
      if (text.startsWith('select deactivated_at from people')) return [{ deactivated_at: null }]
      if (text.startsWith('select 1 from phone_numbers')) return text.endsWith('for share') ? [] : [{ '?column?': 1 }]
      if (text.startsWith('select pin_hash, pin_key_id')) {
        return [
          { pin_hash: stored, pin_key_id: keys.pinKeyId, pin_failures: 0, pin_last_failed_at: null, now: new Date() },
        ]
      }
      if (text.startsWith('update users set pin_failures = pin_failures + 1')) {
        return [{ pin_failures: 1, pin_last_failed_at: new Date(), now: new Date() }]
      }
      return systemPrincipal(SYSTEM)(statement)
    })
    const c = context(held.valkey, pool)
    expect(await refusal(verifyPinStep(c.api, { pin: '290517' }, ATTEMPT_ID, c.info))).toMatchObject({
      status: 401,
      code: 'attempt_expired',
    })
    // The count was written, then rolled back with the rest of the transaction.
    const texts = pool.texts()
    expect(texts.some(text => text.startsWith('update users set pin_failures = pin_failures + 1'))).toBe(true)
    expect(texts.at(-1)).toBe('rollback')
    expect(texts).not.toContain('commit')
    expect(held.store.has(names.attempt(keyName(ATTEMPT_ID)))).toBe(false)
  })
})

describe('PRD-53 T14 how refusals answer', () => {
  it('rounds a wait up to whole minutes, so it never dates another request to the second', () => {
    for (const [ms, seconds] of [
      [1, 60],
      [60_000, 60],
      [60_001, 120],
      [600_000, 600],
      [82_800_000, 82_800],
    ] as const) {
      expect(tooManyRequests(ms)).toMatchObject({
        status: 429,
        code: 'too_many_requests',
        extra: { retryAfterSeconds: seconds },
      })
    }
  })

  it('maps a failed PIN check to its reply, at sign-in and at re-authentication', () => {
    const until = new Date('2026-10-13T10:15:00Z')
    const ok = { state: 'ok', triesBeforeLock: 2, triesBeforeAdminLock: 7 } as const
    expect(pinRefusal({ ok: false, reason: 'wrong', state: ok }, 'sign_in')).toMatchObject({
      status: 401,
      code: 'pin_wrong',
      extra: { pin: ok },
    })
    expect(pinRefusal({ ok: false, reason: 'wrong', state: { state: 'locked', until } }, 'reauth')).toMatchObject({
      status: 423,
      code: 'pin_locked',
      extra: { pin: { state: 'locked', until: '2026-10-13T10:15:00.000Z' } },
    })
    expect(pinRefusal({ ok: false, reason: 'locked', state: { state: 'admin_locked' } }, 'sign_in')).toMatchObject({
      status: 423,
      code: 'pin_locked',
      extra: { pin: { state: 'admin_locked' } },
    })
    expect(pinRefusal({ ok: false, reason: 'unset' }, 'sign_in')).toMatchObject({ status: 409, code: 'wrong_step' })
    expect(pinRefusal({ ok: false, reason: 'unset' }, 'reauth')).toMatchObject({
      status: 409,
      code: 'pin_reset_needed',
    })
    expect(pinRefusal({ ok: false, reason: 'other_key' }, 'sign_in')).toMatchObject({
      status: 409,
      code: 'pin_reset_needed',
    })
  })
})
