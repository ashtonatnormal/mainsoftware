import type { Redis } from 'ioredis'
import { describe, expect, it, vi } from 'vitest'
import type { Api } from '#src/api.ts'
import type { Attempt } from '#src/auth/attempts.ts'
import { deriveKeys, hashPin, keyName } from '#src/auth/crypto.ts'
import { ApiError } from '#src/auth/errors.ts'
import { SLIDING_WINDOW } from '#src/auth/limiter.ts'
import { relyingParty } from '#src/auth/passkeys.ts'
import {
  passkeyOptions,
  pinRefusal,
  requestCode,
  setPin,
  tooManyRequests,
  verifyCode,
  verifyPinStep,
} from '#src/auth/sign-in.ts'
import type { SmsProvider } from '#src/auth/sms/provider.ts'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'
import { AfterResponse, type ReqInfo } from '#src/http.ts'
import { staticFlags } from '#src/testing/flags.ts'
import { type Statement, scriptedPool, systemPrincipal } from '#src/testing/pool.ts'
import { MemorySms } from '#src/testing/sms.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const PERSON = 'b0000000-0000-4000-8000-000000000001'
const NUMBER = 'b0000000-0000-4000-8000-0000000000f1'
const SYSTEM = 'c0000000-0000-4000-8000-000000000001'
const PREFIX = 'it:unit:'
const ATTEMPT_ID = 'i'.repeat(43)
const names = valkeyKeys(PREFIX)
const named = { orgId: ORG, personId: PERSON, phoneNumberId: NUMBER }

// Valkey holding one attempt; the code check script answers `check`, the limiter allows.
function valkeyWith(attempt: Attempt | undefined, check: [string, number] = ['wrong', 1]) {
  const store = new Map<string, string>()
  if (attempt) store.set(names.attempt(keyName(ATTEMPT_ID)), JSON.stringify(attempt))
  const valkey = {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string, ...options: string[]) => {
      if (options.includes('XX') && !store.has(key)) return null
      store.set(key, value)
      return 'OK'
    },
    del: async (key: string) => (store.delete(key) ? 1 : 0),
    evalsha: async (sha: string) => (sha === SLIDING_WINDOW.sha ? [1, 0] : check),
  }
  return { valkey: valkey as unknown as Redis, store }
}

// The org's rows a code check reads: the person (left or not), the number the code went to (still
// theirs or not), their account and passkeys. `roster` also answers the roster lookup with them.
function orgPool(
  person: {
    left?: boolean
    numberRemoved?: boolean
    pinHash?: string | null
    passkeys?: number
    roster?: boolean
  } = {},
) {
  return scriptedPool((statement: Statement) => {
    const { text } = statement
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
  })
}

function context(valkey: Redis, pool = scriptedPool(), sms?: SmsProvider) {
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
    for (const [check, answer] of [
      [['wrong', 1], { status: 401, code: 'code_wrong', extra: { triesLeft: 4 } }],
      [['wrong', 4], { status: 401, code: 'code_wrong', extra: { triesLeft: 1 } }],
      [['dead', 5], { status: 401, code: 'code_dead' }],
      [['expired', 0], { status: 401, code: 'code_expired' }],
    ] as const) {
      const nobody = context(valkeyWith({ v: 1, numberTag: 't', step: 'code_sent' }, [...check]).valkey)
      expect(await refusal(verifyCode(nobody.api, code, ATTEMPT_ID, nobody.info))).toMatchObject(answer)
      expect(nobody.tasks).toHaveLength(0)
      const someone = context(valkeyWith({ v: 1, numberTag: 't', step: 'code_sent', ...named }, [...check]).valkey)
      expect(await refusal(verifyCode(someone.api, code, ATTEMPT_ID, someone.info))).toMatchObject(answer)
      expect(someone.tasks).toHaveLength(1)
    }
  })

  it('answers the right code on an attempt that names nobody exactly as a wrong guess at that count', async () => {
    const first = context(valkeyWith({ v: 1, numberTag: 't', step: 'code_sent' }, ['ok', 0]).valkey)
    expect(await refusal(verifyCode(first.api, code, ATTEMPT_ID, first.info))).toMatchObject({
      status: 401,
      code: 'code_wrong',
      extra: { triesLeft: 4 },
    })
    const fifth = context(valkeyWith({ v: 1, numberTag: 't', step: 'code_sent' }, ['ok', 4]).valkey)
    expect(await refusal(verifyCode(fifth.api, code, ATTEMPT_ID, fifth.info))).toMatchObject({ code: 'code_dead' })
    expect(first.pool.statements).toEqual([])
  })

  it('ACC-05: answers the right code for someone who has left as a wrong one, and audits it with left', async () => {
    const pool = orgPool({ left: true, pinHash: null })
    const left = context(valkeyWith({ v: 1, numberTag: 't', step: 'code_sent', ...named }, ['ok', 0]).valkey, pool)
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
    const stale = valkeyWith({ v: 1, numberTag: 't', step: 'code_sent', ...named }, ['ok', 0])
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

  it('moves a first sign-in to set_pin, and someone with a PIN to the step-up with their PIN state', async () => {
    const first = valkeyWith({ v: 1, numberTag: 't', step: 'code_sent', ...named }, ['ok', 0])
    const firstContext = context(first.valkey, orgPool())
    expect(await verifyCode(firstContext.api, code, ATTEMPT_ID, firstContext.info)).toEqual({
      body: { status: 'code_verified', next: 'set_pin' },
    })
    expect(JSON.parse(first.store.get(names.attempt(keyName(ATTEMPT_ID))) ?? '{}')).toMatchObject({ step: 'set_pin' })

    const again = valkeyWith({ v: 1, numberTag: 't', step: 'code_sent', ...named }, ['ok', 2])
    const hash = `$argon2id$v=19$m=19456,t=2,p=1$${'A'.repeat(22)}$${'B'.repeat(43)}`
    const againContext = context(again.valkey, orgPool({ pinHash: hash, passkeys: 1 }))
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

describe('ACC-03 T14 sending a code after the reply', () => {
  // A code request for a roster number, with its after-reply work run: what was texted, and the
  // audit row's details.
  async function delivered(person: { left?: boolean; numberRemoved?: boolean }) {
    const pool = orgPool({ ...person, roster: true })
    const sms = new MemorySms()
    const { api, info, tasks } = context(valkeyWith(undefined).valkey, pool, sms)
    const reply = await requestCode(api, { phone: '+6591234567' }, undefined, info)
    expect(reply.body).toEqual({ status: 'code_sent', expiresInSeconds: 300, codeLength: 6 })
    for (const task of tasks) await task()
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
