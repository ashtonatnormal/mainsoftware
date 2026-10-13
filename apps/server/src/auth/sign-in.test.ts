import type { Redis } from 'ioredis'
import { describe, expect, it, vi } from 'vitest'
import type { Api } from '#src/api.ts'
import type { Attempt } from '#src/auth/attempts.ts'
import { deriveKeys, keyName } from '#src/auth/crypto.ts'
import { ApiError } from '#src/auth/errors.ts'
import { SLIDING_WINDOW } from '#src/auth/limiter.ts'
import { relyingParty } from '#src/auth/passkeys.ts'
import { pinRefusal, setPin, tooManyRequests, verifyCode, verifyPinStep } from '#src/auth/sign-in.ts'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'
import { AfterResponse, type ReqInfo } from '#src/http.ts'
import { OffboardingRegistry } from '#src/offboarding.ts'
import { type Statement, scriptedPool, systemPrincipal } from '#src/testing/pool.ts'

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

// The org's rows a code check reads: the person (left or not), their account and passkeys.
function orgPool(person: { left?: boolean; pinHash?: string | null; passkeys?: number } = {}) {
  return scriptedPool((statement: Statement) => {
    const { text } = statement
    if (text.startsWith('select deactivated_at from people')) {
      return [{ deactivated_at: person.left ? new Date('2026-10-01T00:00:00Z') : null }]
    }
    if (text.startsWith('select pin_hash, pin_failures')) {
      if (person.pinHash === undefined) return []
      return [{ pin_hash: person.pinHash, pin_failures: 0, pin_last_failed_at: null, now: new Date() }]
    }
    if (text.startsWith('select count(*) as n from passkeys')) return [{ n: String(person.passkeys ?? 0) }]
    return systemPrincipal(SYSTEM)(statement)
  })
}

function context(valkey: Redis, pool = scriptedPool()) {
  const tasks: (() => Promise<void>)[] = []
  const api: Api = {
    db: pool.db,
    valkey,
    keys: deriveKeys('unit-test-unit-test-unit-test-unit-test'),
    sms: undefined,
    keyPrefix: PREFIX,
    offboarding: new OffboardingRegistry({ info: vi.fn(), error: vi.fn() }),
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

describe('PRD-53 ACC-03 checking a sign-in code (§5)', () => {
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

describe('PRD-53 §4.4 how refusals answer', () => {
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
