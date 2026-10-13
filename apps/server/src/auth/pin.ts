// The one PIN check, for the sign-in step-up and for re-authentication (ACC-02, PRD-53). The
// caller has already read the person's row FOR SHARE in this transaction, refusing someone who
// has left before any check, and holds a PIN slot (crypto.ts withPinSlot) around the whole
// transaction, so a check waiting for a slot holds no pooled connection and no row lock.
//
// A wrong PIN is never thrown: the failure count and its audit rows are returned with the
// result, so the transaction commits them before the caller answers (auth/errors.ts).
import type { FastifyBaseLogger } from 'fastify'
import { sql } from 'kysely'
import { writeAudit } from '#src/auth/audit.ts'
import { type AuthKeys, isIssuedPinHash, verifyPin } from '#src/auth/crypto.ts'
import { type PinState, pinState } from '#src/auth/pin-lock.ts'
import type { InOrg } from '#src/db/database.ts'

export type PinCheck =
  | { ok: true }
  // The state after this failure, which may have just locked the PIN.
  | { ok: false; reason: 'wrong'; state: PinState }
  // Refused without checking: the PIN is locked already.
  | { ok: false; reason: 'locked'; state: PinState }
  | { ok: false; reason: 'unset' }
  // Hashed under another pepper, or at a cost the server doesn't issue: only an admin reset helps.
  | { ok: false; reason: 'other_key' }

export interface PinCheckInput {
  orgId: string
  personId: string
  pin: string
  during: 'sign_in' | 'reauth'
  // Null at sign-in, where whoever holds the phone isn't known to be the person yet.
  actorId: string | null
  deviceId: string | null
  ip: string | null
  requestId: string
}

export async function checkPin(
  trx: InOrg,
  keys: AuthKeys,
  input: PinCheckInput,
  log: Pick<FastifyBaseLogger, 'error'>,
): Promise<PinCheck> {
  const { orgId, personId } = input
  // NOWAIT: if another check of this account is in progress, Postgres answers 55P03 at once,
  // which is thrown (nothing is written yet) and answers 409 try_again. So parallel guesses
  // never queue on the row while holding pooled connections.
  const { rows } = await sql<{
    pin_hash: string | null
    pin_key_id: string | null
    pin_failures: number
    pin_last_failed_at: Date | null
    now: Date
  }>`select pin_hash, pin_key_id, pin_failures, pin_last_failed_at, now() as now from users
    where org_id = ${orgId} and id = ${personId} for update nowait`.execute(trx)
  const row = rows[0]
  if (row === undefined || row.pin_hash === null) return { ok: false, reason: 'unset' }
  const state = pinState(
    { pinHash: row.pin_hash, failures: row.pin_failures, lastFailedAt: row.pin_last_failed_at },
    row.now,
  )
  if (state.state === 'locked' || state.state === 'admin_locked') return { ok: false, reason: 'locked', state }
  if (row.pin_key_id !== keys.pinKeyId || !isIssuedPinHash(row.pin_hash)) {
    log.error({ event: 'pin_other_key', personId }, 'a PIN was hashed under another key or cost')
    return { ok: false, reason: 'other_key' }
  }
  if (await verifyPin(input.pin, row.pin_hash, keys)) {
    // The trigger clears pin_last_failed_at with the count.
    if (row.pin_failures > 0) {
      await sql`update users set pin_failures = 0 where org_id = ${orgId} and id = ${personId}`.execute(trx)
    }
    return { ok: true }
  }
  // One more failure. The trigger stamps when, with the database's clock.
  const failed = await sql<{ pin_failures: number; pin_last_failed_at: Date | null; now: Date }>`
    update users set pin_failures = pin_failures + 1 where org_id = ${orgId} and id = ${personId}
    returning pin_failures, pin_last_failed_at, now() as now`.execute(trx)
  const after = failed.rows[0]
  if (after === undefined) throw new Error('the PIN failure count was not returned')
  const next = pinState(
    { pinHash: row.pin_hash, failures: after.pin_failures, lastFailedAt: after.pin_last_failed_at },
    after.now,
  )
  const audit = {
    orgId,
    actorId: input.actorId,
    targetType: 'person',
    targetId: personId,
    deviceId: input.deviceId,
    ip: input.ip,
    requestId: input.requestId,
  } as const
  await writeAudit(trx, {
    ...audit,
    action: 'auth.pin_failed',
    details: { failures: after.pin_failures, during: input.during },
  })
  if (next.state === 'locked' || next.state === 'admin_locked') {
    await writeAudit(trx, {
      ...audit,
      action: 'auth.pin_locked',
      details: {
        failures: after.pin_failures,
        until: next.state === 'locked' ? next.until.toISOString() : 'admin_reset',
      },
    })
  }
  return { ok: false, reason: 'wrong', state: next }
}

// How a PIN's state is shown to the person whose PIN it is (T14 item 9): after a correct code at
// step-up, or with a refusal. Never for 'unset', which the flow answers by asking for a new PIN.
export type PinStateJSON =
  | { state: 'ok'; triesBeforeLock: number; triesBeforeAdminLock: number }
  | { state: 'locked'; until: string }
  | { state: 'admin_locked' }

export function pinStateJSON(state: Exclude<PinState, { state: 'unset' }>): PinStateJSON {
  switch (state.state) {
    case 'ok':
      return { state: 'ok', triesBeforeLock: state.triesBeforeLock, triesBeforeAdminLock: state.triesBeforeAdminLock }
    case 'locked':
      return { state: 'locked', until: state.until.toISOString() }
    case 'admin_locked':
      return { state: 'admin_locked' }
  }
}
