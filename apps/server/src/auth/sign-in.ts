// The sign-in service (ACC-01, ACC-02, ACC-03, PRD-53, T14). A sign-in is an
// attempt in Valkey (attempts.ts) that moves through three steps: a code is sent, then a new PIN
// is set or the step-up is passed (the account PIN or a passkey), and then a device and session
// are issued and the attempt is used up.
//
// - Every number gets the same reply to a code request, and nothing touches Postgres before that
//   reply. The roster lookup, the audit row and the text run after it, even when the client hangs
//   up first. The attempt names the person only on the way to sending their code, just before its
//   audit row is written and the code is handed to the SMS provider; if the audit row, the commit
//   or the send then fails, it still names them, and a guess at that code has the same odds as at
//   one that arrived. An attempt that names nobody answers every code as wrong, even the right one.
// - Every transaction before a session exists acts as the org's system principal: whoever holds
//   the phone hasn't proved anything yet. Each starts by reading the person's row FOR SHARE, the
//   first row in the lock order (0006), so someone who has left is refused there, before any
//   code, PIN or passkey is checked.
// - A failure that writes (a wrong PIN's count, a failed passkey's audit row) is returned from the
//   transaction, so it commits, and only then becomes an error.
// - A finished sign-in appends signin.started to the outbox in its transaction, and a first one,
//   which sets the PIN, account.pin_set too (C0.6, T16); a failure writes only counters and audit
//   rows, which append nothing (outbox/coverage.ts).
// - Valkey errors fail closed: sign-in answers 503 unavailable while Valkey is down.
// - Nothing here logs a phone number, code, PIN, token, attempt id, challenge or credential id.
import {
  type CodeSentSchema,
  type CodeVerifiedSchema,
  normalisePhone,
  pinProblem,
  type SignedInSchema,
} from '@hearth/shared'
import { sql } from 'kysely'
import type { z } from 'zod'
import type { Api } from '#src/api.ts'
import {
  type Attempt,
  checkOtp,
  consumeAttempt,
  createAttempt,
  dropAttempt,
  readAttempt,
  storeOtp,
  updateAttempt,
} from '#src/auth/attempts.ts'
import { writeAudit } from '#src/auth/audit.ts'
import { attemptCookie, clearedCookie, sessionCookie } from '#src/auth/cookies.ts'
import { hashPin, keyName, newOtp, otpMac, tag, withPinSlot } from '#src/auth/crypto.ts'
import { deviceLabel } from '#src/auth/device-label.ts'
import { ApiError } from '#src/auth/errors.ts'
import { hit, limitSubject, type Window } from '#src/auth/limiter.ts'
import {
  type AuthenticationResponse,
  authenticationOptions,
  type StoredCredential,
  verifyAuthentication,
} from '#src/auth/passkeys.ts'
import { checkPin, type PinCheck, pinStateJSON } from '#src/auth/pin.ts'
import { pinState } from '#src/auth/pin-lock.ts'
import { LIMITS, OTP, PASSKEY_CHALLENGE_TTL_MS } from '#src/auth/policy.ts'
import { AttemptStale, type IssuedSession, issueSession, numberStillTheirs } from '#src/auth/sessions.ts'
import { type InOrg, withOrg } from '#src/db/database.ts'
import { personByPhone } from '#src/db/pre-org.ts'
import type { Answer, ReqInfo } from '#src/http.ts'
import { appendOutbox } from '#src/outbox/append.ts'

// --- Shared with account.ts -----------------------------------------------------------------

// A Valkey call whose failure the request can't go on without: 503 unavailable.
export async function fromValkey<T>(info: ReqInfo, work: Promise<T>): Promise<T> {
  try {
    return await work
  } catch (error) {
    info.log.warn({ err: error, event: 'valkey_unavailable' }, 'valkey is unavailable')
    throw new ApiError(503, 'unavailable')
  }
}

// One of policy.ts's LIMITS, for one subject (a number's tag, an address's tag, a session id or
// 'all').
export function windowOf(api: Api, limit: { name: string; windowMs: number; max: number }, subject: string): Window {
  return { key: api.names.limit(limit.name, subject), windowMs: limit.windowMs, max: limit.max }
}

// 429, with the wait rounded up to whole minutes, so it doesn't date someone else's request to
// the second (a per-number window counts requests from every browser).
export function tooManyRequests(retryAfterMs: number): ApiError {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 60_000)) * 60
  return new ApiError(429, 'too_many_requests', { retryAfterSeconds })
}

// Records a hit in every window, or refuses with 429 if any is full. Fails closed.
export async function enforce(api: Api, info: ReqInfo, windows: readonly Window[]): Promise<void> {
  const result = await fromValkey(info, hit(api.valkey, windows))
  if (!result.allowed) throw tooManyRequests(result.retryAfterMs)
}

// The per-IP subject: an IPv4 address, or an IPv6 /64, as a keyed hash.
export function ipTag(api: Api, info: ReqInfo): string {
  return tag(api.keys, `ip:${limitSubject(info.ip)}`)
}

// The person's row FOR SHARE, the first row in the lock order: true while they are still at the
// org. A deactivation in progress makes this wait, then see it.
export async function stillHere(trx: InOrg, orgId: string, personId: string): Promise<boolean> {
  const { rows } = await sql<{ deactivated_at: Date | null }>`select deactivated_at from people
    where org_id = ${orgId} and id = ${personId} for share`.execute(trx)
  return rows.length === 1 && rows[0]?.deactivated_at === null
}

// The person's passkeys that haven't been removed.
export async function livePasskeys(trx: InOrg, orgId: string, personId: string): Promise<StoredCredential[]> {
  const rows = await trx
    .selectFrom('passkeys')
    .select(['credential_id', 'transports'])
    .where('org_id', '=', orgId)
    .where('user_id', '=', personId)
    .where('removed_at', 'is', null)
    .orderBy('created_at')
    .execute()
  return rows.map(row => ({ credentialId: row.credential_id, transports: row.transports }))
}

export interface CredentialRow extends StoredCredential {
  id: string
  publicKey: Buffer
  counter: number
  userHandle: string
  pinSet: boolean
}

// The person's live passkey with this credential id, locked for its counter update.
export async function credentialFor(
  trx: InOrg,
  orgId: string,
  personId: string,
  credentialId: Buffer,
): Promise<CredentialRow | undefined> {
  const { rows } = await sql<{
    id: string
    public_key: Buffer
    counter: string
    transports: string[]
    passkey_user_handle: string
    pin_hash: string | null
  }>`select k.id, k.public_key, k.counter, k.transports, u.passkey_user_handle, u.pin_hash
    from passkeys k join users u on u.org_id = k.org_id and u.id = k.user_id
    where k.org_id = ${orgId} and k.credential_id = ${credentialId} and k.user_id = ${personId}
      and k.removed_at is null
    for update of k`.execute(trx)
  const row = rows[0]
  if (row === undefined) return undefined
  return {
    id: row.id,
    credentialId,
    publicKey: row.public_key,
    // A bigint column comes back from pg as a string.
    counter: Number(row.counter),
    transports: row.transports,
    userHandle: row.passkey_user_handle,
    pinSet: row.pin_hash !== null,
  }
}

export async function recordPasskeyUse(trx: InOrg, orgId: string, passkeyId: string, counter: number): Promise<void> {
  await sql`update passkeys set counter = ${counter}, last_used_at = now()
    where org_id = ${orgId} and id = ${passkeyId}`.execute(trx)
}

// A PIN check that failed, as the reply (T14 item 9). At sign-in an unset PIN means the attempt
// should have gone to set_pin; at re-authentication only an admin reset helps.
export function pinRefusal(check: Exclude<PinCheck, { ok: true }>, during: 'sign_in' | 'reauth'): ApiError {
  switch (check.reason) {
    case 'wrong':
    case 'locked': {
      if (check.state.state === 'unset') return new ApiError(409, 'pin_reset_needed')
      const pin = pinStateJSON(check.state)
      return check.state.state === 'ok'
        ? new ApiError(401, 'pin_wrong', { pin })
        : new ApiError(423, 'pin_locked', { pin })
    }
    case 'unset':
      return during === 'sign_in' ? new ApiError(409, 'wrong_step') : new ApiError(409, 'pin_reset_needed')
    case 'other_key':
      return new ApiError(409, 'pin_reset_needed')
  }
}

// --- The attempt ----------------------------------------------------------------------------

const attemptExpired = () => new ApiError(401, 'attempt_expired', {}, ['attempt'])

// An attempt that a code was sent for, naming the person and the number the code went to.
type Named = Attempt & { orgId: string; personId: string; phoneNumberId: string }

function named(attempt: Attempt): Named | undefined {
  const { orgId, personId, phoneNumberId } = attempt
  return orgId !== undefined && personId !== undefined && phoneNumberId !== undefined
    ? { ...attempt, orgId, personId, phoneNumberId }
    : undefined
}

// The attempt the cookie names, at the step this request needs: 401 attempt_expired (clearing
// the cookie) if it's gone, 409 wrong_step if it's at another step.
async function attemptAt(
  api: Api,
  info: ReqInfo,
  attemptId: string | undefined,
  step: 'set_pin' | 'step_up',
): Promise<{ key: string; attempt: Named }> {
  const found = await fromValkey(info, readAttempt(api.valkey, api.names, attemptId))
  if (found === undefined) throw attemptExpired()
  const attempt = named(found.attempt)
  if (found.attempt.step !== step || attempt === undefined) throw new ApiError(409, 'wrong_step')
  return { key: found.key, attempt }
}

// Whether the step can go on: the attempt's person is still here (read FOR SHARE) and the number
// its code went to is still theirs. A step that locks users or passkeys next reads the number with
// no lock (`locked: false`), since phone_numbers comes after them in the lock order, and reads it
// again FOR SHARE before anything it writes or shows commits; issueSession does so before any
// session. A step that locks nothing else reads it FOR SHARE here. A step that finds either has
// gone answers as it would for a leaver: the attempt is dropped, nothing is counted, and nothing
// of the account is shown (ACC-03, ACC-05, T14).
async function stillSigningIn(trx: InOrg, attempt: Named, options: { locked: boolean }): Promise<boolean> {
  const { orgId, personId, phoneNumberId } = attempt
  if (!(await stillHere(trx, orgId, personId))) return false
  return numberStillTheirs(trx, orgId, personId, phoneNumberId, options)
}

async function dropQuietly(api: Api, info: ReqInfo, key: string): Promise<void> {
  try {
    await dropAttempt(api.valkey, api.names, key)
  } catch (error) {
    info.log.warn({ err: error, event: 'attempt_drop_failed' })
  }
}

function signedIn(session: IssuedSession): Answer {
  return {
    body: { status: 'signed_in', device: { id: session.deviceId, label: session.label } } satisfies z.input<
      typeof SignedInSchema
    >,
    cookies: [sessionCookie(session.token, session.maxAgeSeconds), clearedCookie('attempt')],
  }
}

const sessionInput = (attempt: Named, info: ReqInfo, method: 'sms_new_pin' | 'sms_pin' | 'sms_passkey') => ({
  orgId: attempt.orgId,
  personId: attempt.personId,
  phoneNumberId: attempt.phoneNumberId,
  label: deviceLabel(info.userAgent),
  method,
  ip: info.ip,
  requestId: info.requestId,
})

// Runs a sign-in step's transaction; one that finds the roster no longer matches (the person left,
// or the number moved) throws AttemptStale, which rolls back what it wrote, drops the attempt and
// answers 401 attempt_expired.
async function issuing<T>(api: Api, info: ReqInfo, key: string, work: Promise<T>): Promise<T> {
  try {
    return await work
  } catch (error) {
    if (!(error instanceof AttemptStale)) throw error
    await dropQuietly(api, info, key)
    throw attemptExpired()
  }
}

// --- POST /api/auth/otp/request -------------------------------------------------------------

export async function requestCode(
  api: Api,
  body: { phone: string },
  attemptId: string | undefined,
  info: ReqInfo,
): Promise<Answer> {
  const sms = api.sms
  if (sms === undefined) throw new ApiError(503, 'unavailable')
  const e164 = normalisePhone(body.phone)
  if (e164 === undefined) throw new ApiError(400, 'invalid_phone')
  const numberTag = tag(api.keys, e164)
  const ip = ipTag(api, info)
  await enforce(api, info, [
    windowOf(api, LIMITS.otpAll, 'all'),
    ...LIMITS.otpPerNumber.map(limit => windowOf(api, limit, numberTag)),
    windowOf(api, LIMITS.otpPerIp, ip),
    windowOf(api, LIMITS.authPerIp, ip),
  ])
  const code = newOtp()
  const attempt: Attempt = { v: 1, numberTag, step: 'code_sent' }
  const created = await fromValkey(info, createAttempt(api.valkey, api.names, attempt))
  await fromValkey(
    info,
    storeOtp(api.valkey, api.names, numberTag, created.key, otpMac(api.keys, created.key, numberTag, code)),
  )
  // A new request starts a new attempt; the browser's old one goes.
  if (attemptId !== undefined) await dropQuietly(api, info, keyName(attemptId))
  info.after(() => deliverCode(api, info, { e164, code, attemptKey: created.key, attempt }))
  return {
    body: { status: 'code_sent', expiresInSeconds: OTP.ttlMs / 1000, codeLength: OTP.length } satisfies z.input<
      typeof CodeSentSchema
    >,
    cookies: [attemptCookie(created.id)],
  }
}

// After the reply: find the number on the roster, and send the code only to a current number of
// someone still at the org, within the global SMS cap. The attempt names them just before the audit
// row is written and the code is handed to the provider. Its errors are logged with at most a
// person id, never the number.
async function deliverCode(
  api: Api,
  info: ReqInfo,
  sending: { e164: string; code: string; attemptKey: string; attempt: Attempt },
): Promise<void> {
  const sms = api.sms
  if (sms === undefined) return
  const matches = await personByPhone(api.db, sending.e164)
  if (matches.length === 0) {
    info.log.info({ event: 'otp_non_roster' }, 'a code was asked for a number not on the roster')
    return
  }
  const [match] = matches
  if (matches.length > 1 || match === undefined) {
    info.log.error({ event: 'phone_in_two_orgs', orgs: matches.length }, 'a number is on more than one roster')
    return
  }
  const { orgId, personId, phoneNumberId } = match
  const send = await withOrg(api.db, { orgId, system: true }, async trx => {
    const audit = (send: 'attempted' | 'skipped_left' | 'skipped_number_removed' | 'skipped_cap') =>
      writeAudit(trx, {
        orgId,
        actorId: null,
        action: 'auth.code_requested',
        targetType: 'person',
        targetId: personId,
        deviceId: null,
        ip: info.ip,
        requestId: info.requestId,
        details: { send },
      })
    if (!(await stillHere(trx, orgId, personId))) {
      await audit('skipped_left')
      return false
    }
    // The lookup's own lock ended with its transaction, so the number is read again: one removed or
    // moved since gets no code.
    if (!(await numberStillTheirs(trx, orgId, personId, phoneNumberId))) {
      await audit('skipped_number_removed')
      return false
    }
    let capped: 'sms_global_cap' | 'sms_cap_unavailable' | undefined
    try {
      const result = await hit(api.valkey, [windowOf(api, LIMITS.smsGlobal, 'all')])
      if (!result.allowed) capped = 'sms_global_cap'
    } catch {
      capped = 'sms_cap_unavailable'
    }
    if (capped !== undefined) {
      await audit('skipped_cap')
      info.log.error({ event: capped, personId }, 'a sign-in code was not sent: the SMS cap')
      return false
    }
    const attempt: Attempt = { ...sending.attempt, orgId, personId, phoneNumberId }
    // False when the browser asked again meanwhile, or the attempt expired: nothing is sent.
    if (!(await updateAttempt(api.valkey, api.names, sending.attemptKey, attempt))) return false
    await audit('attempted')
    return true
  })
  if (!send) return
  try {
    await sms.sendCode(sending.e164, sending.code)
  } catch (error) {
    info.log.error(
      {
        event: 'sms_send_failed',
        provider: sms.name,
        error: error instanceof Error ? error.name : 'unknown',
        personId,
      },
      'a sign-in code could not be sent',
    )
  }
}

// --- POST /api/auth/otp/verify --------------------------------------------------------------

export async function verifyCode(
  api: Api,
  body: { code: string },
  attemptId: string | undefined,
  info: ReqInfo,
): Promise<Answer> {
  const found = await fromValkey(info, readAttempt(api.valkey, api.names, attemptId))
  if (found === undefined) throw attemptExpired()
  const { key, attempt } = found
  if (attempt.step !== 'code_sent') throw new ApiError(409, 'wrong_step')
  // At most 10 code checks per number per rolling day, counted for every number alike.
  await enforce(api, info, [
    windowOf(api, LIMITS.authPerIp, ipTag(api, info)),
    windowOf(api, LIMITS.verifyPerNumber, attempt.numberTag),
  ])
  const check = await fromValkey(
    info,
    checkOtp(api.valkey, api.names, attempt.numberTag, key, otpMac(api.keys, key, attempt.numberTag, body.code)),
  )
  const person = named(attempt)
  let stale: 'left' | 'number_removed' | undefined
  if (check.result === 'ok' && person !== undefined) {
    const { orgId, personId, phoneNumberId } = person
    const account = await withOrg(api.db, { orgId, system: true }, async trx => {
      if (!(await stillHere(trx, orgId, personId))) return 'left' as const
      // A number removed or moved since the code went to it moves the sign-in no further, and
      // shows nothing of the account.
      if (!(await numberStillTheirs(trx, orgId, personId, phoneNumberId))) return 'number_removed' as const
      const user = await sql<{
        pin_hash: string | null
        pin_failures: number
        pin_last_failed_at: Date | null
        now: Date
      }>`select pin_hash, pin_failures, pin_last_failed_at, now() as now from users
        where org_id = ${orgId} and id = ${personId}`.execute(trx)
      const passkeys = await sql<{ n: string }>`select count(*) as n from passkeys
        where org_id = ${orgId} and user_id = ${personId} and removed_at is null`.execute(trx)
      return { user: user.rows[0], passkeys: Number(passkeys.rows[0]?.n ?? 0) }
    })
    if (typeof account !== 'string') {
      const { user } = account
      const pinHash = user?.pin_hash ?? null
      const next = pinHash === null ? 'set_pin' : 'step_up'
      if (!(await fromValkey(info, updateAttempt(api.valkey, api.names, key, { ...attempt, step: next })))) {
        throw attemptExpired()
      }
      if (user === undefined || pinHash === null)
        return { body: { status: 'code_verified', next: 'set_pin' } satisfies z.input<typeof CodeVerifiedSchema> }
      const state = pinState({ pinHash, failures: user.pin_failures, lastFailedAt: user.pin_last_failed_at }, user.now)
      if (state.state === 'unset') throw new Error('a PIN with a hash read as unset')
      return {
        body: {
          status: 'code_verified',
          next: 'step_up',
          pin: pinStateJSON(state),
          passkey: account.passkeys > 0,
        } satisfies z.input<typeof CodeVerifiedSchema>,
      }
    }
    stale = account
  }
  // Every failure is answered as a wrong guess at that count would be: a right code on an attempt
  // that names nobody (a one-in-a-million guess), a leaver, or a number no longer theirs too, so
  // nothing tells them apart.
  const tries = check.result === 'ok' ? check.tries + 1 : check.tries
  const result = check.result === 'ok' ? (tries >= OTP.maxTries ? 'dead' : 'wrong') : check.result
  if (person !== undefined) {
    info.after(() =>
      withOrg(api.db, { orgId: person.orgId, system: true }, trx =>
        writeAudit(trx, {
          orgId: person.orgId,
          actorId: null,
          action: 'auth.code_failed',
          targetType: 'person',
          targetId: person.personId,
          deviceId: null,
          ip: info.ip,
          requestId: info.requestId,
          details:
            stale === 'left'
              ? { result, left: true }
              : stale === 'number_removed'
                ? { result, numberRemoved: true }
                : { result },
        }),
      ),
    )
  }
  if (result === 'expired') throw new ApiError(401, 'code_expired')
  if (result === 'dead') throw new ApiError(401, 'code_dead')
  throw new ApiError(401, 'code_wrong', { triesLeft: OTP.maxTries - tries })
}

// --- POST /api/auth/pin/set -----------------------------------------------------------------

export async function setPin(
  api: Api,
  body: { pin: string },
  attemptId: string | undefined,
  info: ReqInfo,
): Promise<Answer> {
  const { key, attempt } = await attemptAt(api, info, attemptId, 'set_pin')
  await enforce(api, info, [windowOf(api, LIMITS.authPerIp, ipTag(api, info))])
  const problem = pinProblem(body.pin)
  if (problem === 'format') throw new ApiError(400, 'invalid_pin')
  if (problem === 'too_easy') throw new ApiError(422, 'pin_too_easy')
  const { orgId, personId } = attempt
  // Refuse before hashing, which costs a PIN slot: someone who has left or whose number has gone,
  // or a PIN set meanwhile.
  const ready = await withOrg(api.db, { orgId, system: true }, async trx => {
    if (!(await stillSigningIn(trx, attempt, { locked: true }))) return 'left'
    const user = await trx
      .selectFrom('users')
      .select('pin_hash')
      .where('org_id', '=', orgId)
      .where('id', '=', personId)
      .executeTakeFirst()
    return user?.pin_hash != null ? 'pin_set' : 'ok'
  })
  if (ready === 'left') {
    await dropQuietly(api, info, key)
    throw attemptExpired()
  }
  if (ready === 'pin_set') throw new ApiError(409, 'pin_already_set')
  const hash = await withPinSlot(() => hashPin(body.pin, api.keys))
  const session = await issuing(
    api,
    info,
    key,
    withOrg(api.db, { orgId, system: true }, async trx => {
      if (!(await stillHere(trx, orgId, personId))) throw new AttemptStale()
      // The first sign-in makes the account; two at once both get here, and one then finds the
      // other's PIN below.
      await sql`insert into users (id, org_id) values (${personId}, ${orgId}) on conflict (id) do nothing`.execute(trx)
      const current = await sql<{ pin_hash: string | null }>`select pin_hash from users
        where org_id = ${orgId} and id = ${personId} for update nowait`.execute(trx)
      if (current.rows[0]?.pin_hash != null) throw new ApiError(409, 'pin_already_set')
      await sql`update users set pin_hash = ${hash}, pin_key_id = ${api.keys.pinKeyId}, pin_set_at = now(), pin_failures = 0
        where org_id = ${orgId} and id = ${personId}`.execute(trx)
      // Only one request turns an attempt into a session.
      if (!(await fromValkey(info, consumeAttempt(api.valkey, api.names, key)))) throw attemptExpired()
      const issued = await issueSession(trx, sessionInput(attempt, info, 'sms_new_pin'))
      // As Hearth, before a session exists: the event names the person as its actor (T16 item 10).
      await appendOutbox(trx, {
        orgId,
        type: 'account.pin_set',
        entity: { type: 'person', id: personId },
        actor: { id: personId, kind: 'human' },
        subjects: [personId],
        purpose: 'accounts',
        ids: {},
      })
      await writeAudit(trx, {
        orgId,
        actorId: personId,
        action: 'auth.pin_set',
        targetType: 'person',
        targetId: personId,
        deviceId: issued.deviceId,
        ip: info.ip,
        requestId: info.requestId,
      })
      return issued
    }),
  )
  return signedIn(session)
}

// --- POST /api/auth/pin/verify --------------------------------------------------------------

export async function verifyPinStep(
  api: Api,
  body: { pin: string },
  attemptId: string | undefined,
  info: ReqInfo,
): Promise<Answer> {
  const { key, attempt } = await attemptAt(api, info, attemptId, 'step_up')
  if (!/^[0-9]{6}$/.test(body.pin)) throw new ApiError(400, 'invalid_pin')
  await enforce(api, info, [windowOf(api, LIMITS.authPerIp, ipTag(api, info))])
  const { orgId, personId } = attempt
  const outcome = await issuing(
    api,
    info,
    key,
    withPinSlot(() =>
      withOrg(api.db, { orgId, system: true }, async trx => {
        // Someone who has left, or whose number has gone, gets the same answer for a right and a
        // wrong PIN, and no count.
        if (!(await stillSigningIn(trx, attempt, { locked: false }))) return { kind: 'left' } as const
        const check = await checkPin(
          trx,
          api.keys,
          {
            orgId,
            personId,
            pin: body.pin,
            during: 'sign_in',
            actorId: null,
            deviceId: null,
            ip: info.ip,
            requestId: info.requestId,
          },
          info.log,
        )
        // The number was read with no lock above. Before a refusal commits its count, read it again
        // FOR SHARE (users is locked now, and phone_numbers comes after it), so a number removed
        // meanwhile rolls the count back.
        if (!check.ok && !(await numberStillTheirs(trx, orgId, personId, attempt.phoneNumberId))) {
          throw new AttemptStale()
        }
        // Returned, so the failure count and its audit rows commit.
        if (!check.ok) return { kind: 'refused', check } as const
        if (!(await fromValkey(info, consumeAttempt(api.valkey, api.names, key)))) throw attemptExpired()
        return { kind: 'issued', session: await issueSession(trx, sessionInput(attempt, info, 'sms_pin')) } as const
      }),
    ),
  )
  if (outcome.kind === 'left') {
    await dropQuietly(api, info, key)
    throw attemptExpired()
  }
  if (outcome.kind === 'refused') throw pinRefusal(outcome.check, 'sign_in')
  return signedIn(outcome.session)
}

// --- POST /api/auth/passkey/options ---------------------------------------------------------

export async function passkeyOptions(api: Api, attemptId: string | undefined, info: ReqInfo): Promise<Answer> {
  const { key, attempt } = await attemptAt(api, info, attemptId, 'step_up')
  await enforce(api, info, [windowOf(api, LIMITS.authPerIp, ipTag(api, info))])
  const { orgId, personId } = attempt
  const found = await withOrg(api.db, { orgId, system: true }, async trx => {
    // FOR SHARE: a removal of the number waits until the options are built, so no passkey of an
    // account whose number has gone is listed.
    if (!(await stillSigningIn(trx, attempt, { locked: true }))) return undefined
    const user = await trx
      .selectFrom('users')
      .select('pin_hash')
      .where('org_id', '=', orgId)
      .where('id', '=', personId)
      .executeTakeFirst()
    return { pinSet: user?.pin_hash != null, live: await livePasskeys(trx, orgId, personId) }
  })
  if (found === undefined) {
    await dropQuietly(api, info, key)
    throw attemptExpired()
  }
  // A passkey stands in for the PIN only once there is one: set a PIN first.
  if (!found.pinSet) throw new ApiError(409, 'wrong_step')
  if (found.live.length === 0) throw new ApiError(409, 'no_passkey')
  const options = await authenticationOptions(api.rp, found.live)
  await fromValkey(
    info,
    api.valkey.set(api.names.challenge('signin', key), options.challenge, 'PX', PASSKEY_CHALLENGE_TTL_MS),
  )
  return { body: { options } }
}

// --- POST /api/auth/passkey/verify ----------------------------------------------------------

export async function passkeyVerify(
  api: Api,
  body: { response: AuthenticationResponse },
  attemptId: string | undefined,
  info: ReqInfo,
): Promise<Answer> {
  const { key, attempt } = await attemptAt(api, info, attemptId, 'step_up')
  await enforce(api, info, [windowOf(api, LIMITS.authPerIp, ipTag(api, info))])
  // Read once: a replayed assertion finds no challenge.
  const expected = await fromValkey(info, api.valkey.getdel(api.names.challenge('signin', key)))
  if (expected === null) throw new ApiError(401, 'passkey_expired')
  const credentialId = Buffer.from(body.response.id, 'base64url')
  const { orgId, personId } = attempt
  const outcome = await issuing(
    api,
    info,
    key,
    withOrg(api.db, { orgId, system: true }, async trx => {
      if (!(await stillSigningIn(trx, attempt, { locked: false }))) return { kind: 'left' } as const
      const failed = async (passkey?: string) => {
        // As for a refused PIN: a number removed since the unlocked read writes no failure.
        if (!(await numberStillTheirs(trx, orgId, personId, attempt.phoneNumberId))) throw new AttemptStale()
        await writeAudit(trx, {
          orgId,
          actorId: null,
          action: 'auth.passkey_failed',
          targetType: 'person',
          targetId: personId,
          deviceId: null,
          ip: info.ip,
          requestId: info.requestId,
          details: passkey === undefined ? { during: 'sign_in' } : { during: 'sign_in', passkey },
        })
        return { kind: 'failed' } as const
      }
      const stored = await credentialFor(trx, orgId, personId, credentialId)
      if (stored === undefined) return failed()
      if (!stored.pinSet) return { kind: 'wrong_step' } as const
      const verified = await verifyAuthentication(api.rp, body.response, expected, stored, stored.userHandle, info.log)
      if (verified === undefined) return failed(stored.id)
      // The PIN's failure count is left as it is, and a locked PIN doesn't stop a passkey.
      await recordPasskeyUse(trx, orgId, stored.id, verified.newCounter)
      if (!(await fromValkey(info, consumeAttempt(api.valkey, api.names, key)))) throw attemptExpired()
      return { kind: 'issued', session: await issueSession(trx, sessionInput(attempt, info, 'sms_passkey')) } as const
    }),
  )
  switch (outcome.kind) {
    case 'left':
      await dropQuietly(api, info, key)
      throw attemptExpired()
    case 'failed':
      throw new ApiError(401, 'passkey_failed')
    case 'wrong_step':
      throw new ApiError(409, 'wrong_step')
    case 'issued':
      return signedIn(outcome.session)
  }
}
