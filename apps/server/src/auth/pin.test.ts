import { beforeAll, describe, expect, it, vi } from 'vitest'
import { type AuthKeys, deriveKeys, hashPin } from '#src/auth/crypto.ts'
import { checkPin, type PinCheckInput, pinStateJSON } from '#src/auth/pin.ts'
import { withOrg } from '#src/db/database.ts'
import { type Statement, scriptedPool } from '#src/testing/pool.ts'

// These hash with argon2, which needs Node 24.7 or later (CLAUDE.md, Testing and CI).

const ORG = 'a0000000-0000-4000-8000-000000000001'
const PERSON = 'b0000000-0000-4000-8000-000000000001'
const NOW = new Date('2026-10-13T10:00:00Z')
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000)

const keys: AuthKeys = deriveKeys('unit-test-unit-test-unit-test-unit-test')
let hash = ''
beforeAll(async () => {
  hash = await hashPin('381904', keys)
})

const input = (pin: string, during: 'sign_in' | 'reauth' = 'sign_in'): PinCheckInput => ({
  orgId: ORG,
  personId: PERSON,
  pin,
  during,
  actorId: during === 'reauth' ? PERSON : null,
  deviceId: null,
  ip: '198.51.100.7',
  requestId: 'f0000000-0000-4000-8000-000000000001',
})

// The users row as the check reads it, and what the failure update returns (the trigger stamps
// pin_last_failed_at with the database's clock).
function account(row: { pinHash?: string | null; keyId?: string; failures?: number; lastFailedAt?: Date | null } = {}) {
  const failures = row.failures ?? 0
  return scriptedPool((statement: Statement) => {
    if (statement.text.startsWith('select pin_hash, pin_key_id')) {
      if (row.pinHash === null)
        return [{ pin_hash: null, pin_key_id: null, pin_failures: 0, pin_last_failed_at: null, now: NOW }]
      return [
        {
          pin_hash: row.pinHash ?? hash,
          pin_key_id: row.keyId ?? keys.pinKeyId,
          pin_failures: failures,
          pin_last_failed_at: row.lastFailedAt ?? (failures > 0 ? minutesAgo(1) : null),
          now: NOW,
        },
      ]
    }
    if (statement.text.startsWith('update users set pin_failures = pin_failures + 1')) {
      return [{ pin_failures: failures + 1, pin_last_failed_at: NOW, now: NOW }]
    }
    return []
  })
}

const run = async (pool: ReturnType<typeof account>, pin: string, during: 'sign_in' | 'reauth' = 'sign_in') => {
  const log = { error: vi.fn() }
  const result = await withOrg(pool.db, { orgId: ORG, userId: PERSON }, trx =>
    checkPin(trx, keys, input(pin, during), log),
  )
  const audits = pool.statements.filter(s => s.text.startsWith('insert into "audit_events"'))
  const writes = pool.texts().filter(text => text.startsWith('update'))
  return { result, audits, writes, log }
}

describe('PRD-53 ACC-02 the PIN check', () => {
  it('locks the users row NOWAIT, so a second check of the same account at once is refused, not queued', async () => {
    const pool = account()
    await run(pool, '381904')
    expect(pool.texts()).toContain(
      'select pin_hash, pin_key_id, pin_failures, pin_last_failed_at, now() as now from users where org_id = $1 and id = $2 for update nowait',
    )
  })

  it('accepts the right PIN, and resets a failure count only when there is one', async () => {
    const clean = await run(account(), '381904')
    expect(clean.result).toEqual({ ok: true })
    expect(clean.writes).toEqual([])
    const after3 = await run(account({ failures: 3 }), '381904')
    expect(after3.result).toEqual({ ok: true })
    expect(after3.writes).toEqual(['update users set pin_failures = 0 where org_id = $1 and id = $2'])
    expect(after3.audits).toEqual([])
  })

  it('counts a wrong PIN, audits it and returns the state after it, without throwing', async () => {
    const { result, audits, writes } = await run(account({ failures: 1 }), '000001', 'reauth')
    expect(result).toEqual({
      ok: false,
      reason: 'wrong',
      state: { state: 'ok', triesBeforeLock: 3, triesBeforeAdminLock: 8 },
    })
    expect(writes).toEqual([
      'update users set pin_failures = pin_failures + 1 where org_id = $1 and id = $2 returning pin_failures, pin_last_failed_at, now() as now',
    ])
    expect(audits).toHaveLength(1)
    expect(audits[0]?.values).toContain('auth.pin_failed')
    expect(audits[0]?.values).toContainEqual({ failures: 2, during: 'reauth' })
    // At re-authentication the person is the actor.
    expect(audits[0]?.values).toContain(PERSON)
  })

  it('locks for 15 minutes at the 5th failure, auditing the lock with when it ends', async () => {
    const { result, audits } = await run(account({ failures: 4 }), '000001')
    const until = new Date(NOW.getTime() + 15 * 60_000)
    expect(result).toEqual({ ok: false, reason: 'wrong', state: { state: 'locked', until } })
    expect(audits.map(a => a.values.find(v => typeof v === 'string' && v.startsWith('auth.')))).toEqual([
      'auth.pin_failed',
      'auth.pin_locked',
    ])
    expect(audits[1]?.values).toContainEqual({ failures: 5, until: until.toISOString() })
  })

  it('locks until an admin resets it at the 10th failure', async () => {
    const { result, audits } = await run(account({ failures: 9, lastFailedAt: minutesAgo(16) }), '000001')
    expect(result).toEqual({ ok: false, reason: 'wrong', state: { state: 'admin_locked' } })
    expect(audits[1]?.values).toContainEqual({ failures: 10, until: 'admin_reset' })
  })

  it('refuses a locked PIN without checking it or writing anything, even the right one', async () => {
    const timed = await run(account({ failures: 5, lastFailedAt: minutesAgo(1) }), '381904')
    expect(timed.result).toEqual({
      ok: false,
      reason: 'locked',
      state: { state: 'locked', until: new Date(minutesAgo(1).getTime() + 15 * 60_000) },
    })
    const admin = await run(account({ failures: 10 }), '381904')
    expect(admin.result).toEqual({ ok: false, reason: 'locked', state: { state: 'admin_locked' } })
    for (const { writes, audits } of [timed, admin]) {
      expect(writes).toEqual([])
      expect(audits).toEqual([])
    }
  })

  it('answers unset for no account or no PIN', async () => {
    const none = scriptedPool()
    const log = { error: vi.fn() }
    expect(
      await withOrg(none.db, { orgId: ORG, userId: PERSON }, trx => checkPin(trx, keys, input('381904'), log)),
    ).toEqual({
      ok: false,
      reason: 'unset',
    })
    expect((await run(account({ pinHash: null }), '381904')).result).toEqual({ ok: false, reason: 'unset' })
  })

  it('answers other_key for a hash under another pepper or cost, without checking or counting', async () => {
    const pepper = await run(account({ keyId: '0123456789abcdef' }), '381904')
    expect(pepper.result).toEqual({ ok: false, reason: 'other_key' })
    expect(pepper.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'pin_other_key', personId: PERSON }),
      expect.any(String),
    )
    const cost = await run(account({ pinHash: hash.replace('m=19456', 'm=65536') }), '381904')
    expect(cost.result).toEqual({ ok: false, reason: 'other_key' })
    for (const { writes, audits } of [pepper, cost]) {
      expect(writes).toEqual([])
      expect(audits).toEqual([])
    }
  })

  it('shows a PIN state as JSON with an ISO time (§4.1)', () => {
    const until = new Date('2026-10-13T10:15:00Z')
    expect(pinStateJSON({ state: 'ok', triesBeforeLock: 2, triesBeforeAdminLock: 7 })).toEqual({
      state: 'ok',
      triesBeforeLock: 2,
      triesBeforeAdminLock: 7,
    })
    expect(pinStateJSON({ state: 'locked', until })).toEqual({ state: 'locked', until: '2026-10-13T10:15:00.000Z' })
    expect(pinStateJSON({ state: 'admin_locked' })).toEqual({ state: 'admin_locked' })
  })
})
