// The sign-in service (ACC-01, ACC-02, ACC-03, PRD-53, T14, T20, D46). A sign-in is an attempt in
// Valkey (attempts.ts): a code is sent, the provider approves it (verified), and then someone with
// no privileged role is signed in on the code alone, while a privileged holder (the roles only an
// Owner grants) goes on to set a new PIN or pass the step-up (the account PIN, or a passkey while
// those are switched on); a device and session are issued and the attempt is used up. Whether the
// person is privileged is read in the transaction that acts on it (access/world.ts privilegedNow),
// and sets the session's lifetime (PRIVILEGED_SESSION).
// - A refused code check answers no sooner than OTP.verifyFloorMs after it arrived, and a provider
//   that keeps failing trips the breaker, which refuses every check for a while (api.otp, T20).
//
// - Every number gets the same reply to a code request, and nothing touches Postgres before that
//   reply. The roster lookup, the audit row and the text run after it, even when the client hangs
//   up first. The attempt names the person only on the way to sending their code, just before its
//   audit row is written and the SMS provider is asked to make and send the code; if the audit
//   row, the commit or the send then fails, it still names them, but no provider reference reaches
//   its record, so there is no code to guess and every guess answers wrong. An attempt that names
//   nobody answers every code as wrong, even the right one.
// - Every transaction before a session exists acts as the org's system principal: whoever holds
//   the phone hasn't proved anything yet. Each starts by reading the person's row FOR SHARE, the
//   first row in the lock order (0006), so someone who has left is refused there, before any
//   code, PIN or passkey is checked.
// - A failure that writes (a wrong PIN's count, a failed passkey's audit row) is returned from the
//   transaction, so it commits, and only then becomes an error.
// - A finished sign-in appends signin.started to the outbox in its transaction (which also makes a
//   code-only person's account row on their first sign-in), and a privileged holder's first one,
//   which sets the PIN, account.pin_set too (C0.6, T16); a failure writes only counters and audit
//   rows, which append nothing (outbox/coverage.ts).
// - Valkey errors fail closed: sign-in answers 503 unavailable while Valkey is down.
// - Nothing here logs a phone number, code, PIN, token, attempt id, challenge or credential id.

import { setTimeout as delay } from 'node:timers/promises'
import {
  type CodeSentSchema,
  type CodeVerifiedSchema,
  normalisePhone,
  pinProblem,
  type SignedInSchema,
} from '@hearth/shared'
import { sql } from 'kysely'
import type { z } from 'zod'
import { privilegedNow } from '#src/access/world.ts'
import type { Api } from '#src/api.ts'
import {
  type Attempt,
  consumeAttempt,
  createAttempt,
  dropAttempt,
  readAttempt,
  updateAttempt,
} from '#src/auth/attempts.ts'
import { writeAudit } from '#src/auth/audit.ts'
import { attachCode, codeOwner, openCode, reserveCode, settleCode } from '#src/auth/codes.ts'
import { attemptCookie, clearedCookie, sessionCookie } from '#src/auth/cookies.ts'
import { hashPin, keyName, tag, withPinSlot } from '#src/auth/crypto.ts'
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
import { type SmsProvider, SmsProviderError, type Verdict } from '#src/auth/sms/provider.ts'
import { type InOrg, withOrg } from '#src/db/database.ts'
import { personByPhone } from '#src/db/pre-org.ts'
import type { Answer, ReqInfo } from '#src/http.ts'
import { C06_GATE } from '#src/jobs/gate.ts'
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

const sessionInput = (
  attempt: Named,
  info: ReqInfo,
  method: 'sms' | 'sms_new_pin' | 'sms_pin' | 'sms_passkey',
  privileged: boolean,
) => ({
  orgId: attempt.orgId,
  personId: attempt.personId,
  phoneNumberId: attempt.phoneNumberId,
  label: deviceLabel(info.userAgent),
  method,
  privileged,
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
  const attempt: Attempt = { v: 1, numberTag, step: 'code_sent' }
  const created = await fromValkey(info, createAttempt(api.valkey, api.names, attempt))
  // The new attempt owns the number's challenge from here: a newer request replaces any earlier
  // code (T14 item 4), whose provider reference is cancelled after the reply.
  const replacedRef = await fromValkey(info, openCode(api.valkey, api.names, numberTag, created.key))
  // A new request starts a new attempt; the browser's old one goes.
  if (attemptId !== undefined) await dropQuietly(api, info, keyName(attemptId))
  info.after(() => deliverCode(api, info, { e164, attemptKey: created.key, attempt, replacedRef }))
  return {
    body: { status: 'code_sent', expiresInSeconds: OTP.ttlMs / 1000, codeLength: OTP.length } satisfies z.input<
      typeof CodeSentSchema
    >,
    cookies: [attemptCookie(created.id)],
  }
}

// After the reply: find the number on the roster, and send a code only to a current number of
// someone still at the org, within the global SMS cap. The attempt names them just before the audit
// row is written and the provider is asked to send. The replaced record's code, if any, is cancelled
// first, so the provider makes a new one. Its errors are logged with at most a person id, never the
// number.
async function deliverCode(
  api: Api,
  info: ReqInfo,
  sending: { e164: string; attemptKey: string; attempt: Attempt; replacedRef: string | undefined },
): Promise<void> {
  const sms = api.sms
  if (sms === undefined) return
  if (sending.replacedRef !== undefined) await cancelQuietly(sms, info, sending.replacedRef)
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
    const audit = (
      send: 'attempted' | 'skipped_left' | 'skipped_number_removed' | 'skipped_not_cleared' | 'skipped_cap',
    ) =>
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
    // An outside provider receives the number only once PDPA-10's transfer register clears it (C0.9):
    // until then nothing is sent, and the reply stays the same as for any other request.
    if (sms.transfer !== null && !(api.gate ?? C06_GATE).providerCleared(orgId, sms.transfer)) {
      await audit('skipped_not_cleared')
      info.log.error(
        { event: 'sms_provider_not_cleared', provider: sms.name, personId },
        'a sign-in code was not sent: the provider is not cleared in the transfer register',
      )
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
    await startCode(api, info, sms, {
      e164: sending.e164,
      numberTag: sending.attempt.numberTag,
      owner: sending.attemptKey,
      personId,
    })
  } catch (error) {
    info.log.error(
      {
        event: 'sms_send_failed',
        provider: sms.name,
        ...providerFailure(error),
        personId,
      },
      'a code could not be sent',
    )
  }
}

// Asks the provider for a code and attaches its reference to the owner's record. After every start
// it first asks whether the owner still holds the record, and only then acts on a verification the
// provider handed back from someone else (foreign): it cancels it and starts once more, and a second
// foreign reply is cancelled too and nothing is attached, so the attempt answers as after a lost
// text. A request that has lost the record to a newer one by the time either start answers leaves
// that verification alone, so it never cancels the newer owner's: a newer request that starts
// between this one's cancel and its second start makes the verification this one then gets back
// as foreign. Answers whether a code is now live for the owner (attached), or not (lost: a newer
// request owns the record; foreign: twice handed someone else's); account.ts's re-authentication
// answers 503 for either.
export async function startCode(
  api: Api,
  info: ReqInfo,
  sms: SmsProvider,
  sending: { e164: string; numberTag: string; owner: string; personId: string },
): Promise<'attached' | 'lost' | 'foreign'> {
  const { numberTag, owner } = sending
  const stillOwner = async () => (await codeOwner(api.valkey, api.names, numberTag)) === owner
  let started = await sms.start(sending.e164)
  if (!(await stillOwner())) return 'lost'
  if (started.foreign) {
    await sms.cancel(started.ref)
    started = await sms.start(sending.e164)
    if (!(await stillOwner())) return 'lost'
    if (started.foreign) {
      await cancelQuietly(sms, info, started.ref)
      info.log.warn(
        { event: 'provider_foreign_verification', provider: sms.name, personId: sending.personId },
        'the provider handed back a verification Hearth did not start, twice; nothing was attached',
      )
      return 'foreign'
    }
  }
  return attachCode(api.valkey, api.names, numberTag, owner, started.ref)
}

// What a provider's failure puts in a log line: the error's name, and for an SmsProviderError its
// kind, the provider's numeric code and the HTTP status (TECH-SPEC T7, T20), so a refusal such as
// Twilio's 60410 can be told from 60605. Never its message, which can quote the number.
export function providerFailure(error: unknown) {
  if (!(error instanceof SmsProviderError)) return { error: error instanceof Error ? error.name : 'unknown' }
  return { error: error.name, kind: error.kind, providerCode: error.providerCode, httpStatus: error.httpStatus }
}

// Cancels a provider reference, best effort: a failure is logged (without the reference) and
// otherwise ignored, since the record no longer accepts that code anyway.
export async function cancelQuietly(sms: SmsProvider, info: ReqInfo, ref: string): Promise<void> {
  try {
    await sms.cancel(ref)
  } catch (error) {
    info.log.warn(
      {
        event: 'sms_cancel_failed',
        provider: sms.name,
        ...providerFailure(error),
      },
      'the SMS provider could not cancel a code',
    )
  }
}

// --- POST /api/auth/otp/verify --------------------------------------------------------------

// A refused check answers no sooner than the floor after the request arrived (T20), so a roster
// number's round trip to the provider can't be told from a number off the roster's instant answer.
async function floored(api: Api, arrived: number, error: ApiError): Promise<never> {
  const wait = arrived + api.otp.verifyFloorMs - Date.now()
  if (wait > 0) await delay(wait)
  throw error
}

export async function verifyCode(
  api: Api,
  body: { code: string },
  attemptId: string | undefined,
  info: ReqInfo,
): Promise<Answer> {
  const arrived = Date.now()
  const found = await fromValkey(info, readAttempt(api.valkey, api.names, attemptId))
  if (found === undefined) throw attemptExpired()
  const { key, attempt } = found
  // The provider approved this attempt's code, and the finish failed before it was used up (a
  // conflict, Valkey or Postgres down): any 6 digits finish it, with no second check (T20).
  if (attempt.step === 'verified') return finishAgain(api, info, key, attempt)
  if (attempt.step !== 'code_sent') throw new ApiError(409, 'wrong_step')
  // At most 10 code checks per number per rolling day, counted for every number alike.
  await enforce(api, info, [
    windowOf(api, LIMITS.authPerIp, ipTag(api, info)),
    windowOf(api, LIMITS.verifyPerNumber, attempt.numberTag),
  ])
  // The provider keeps failing: every check is refused for a while, named or not, without asking it.
  if (api.otp.breaker.isOpen()) throw new ApiError(503, 'unavailable')
  const reserved = await fromValkey(info, reserveCode(api.valkey, api.names, attempt.numberTag, key))
  // The outcome: approved, or a refusal with the tries counted so far.
  let check: { result: 'approved' | 'wrong' | 'dead' | 'expired'; tries: number }
  if (reserved.result === 'check') {
    const sms = api.sms
    let verdict: Verdict | 'failed' = 'failed'
    if (sms !== undefined) {
      try {
        verdict = await sms.check(reserved.ref, body.code)
      } catch (error) {
        api.otp.breaker.failed()
        info.log.error(
          {
            event: 'sms_check_failed',
            provider: sms.name,
            ...providerFailure(error),
          },
          'the SMS provider could not check a code',
        )
      }
    }
    const settled = await fromValkey(info, settleCode(api.valkey, api.names, attempt.numberTag, key, reserved, verdict))
    // The provider couldn't answer: the try was given back, and the attempt stays at the code.
    if (settled.result === 'failed') throw new ApiError(503, 'unavailable')
    if (settled.result === 'displaced') {
      // A newer request replaced the record during the check. The newest request wins: this check
      // signs nobody in, whatever the provider said, and touches and cancels nothing of the newer
      // record. It answers from its own try, wrong or at the 5th dead, as the same try at a number
      // off the roster answered at RESERVE, before the newer request landed; code_expired here
      // would tell a roster number apart (T14 item 3). The attempt's next check finds another
      // owner's record and answers code_expired, for every number alike.
      const { tries } = settled
      check = { result: tries >= OTP.maxTries ? 'dead' : 'wrong', tries }
    } else {
      // expired: the provider no longer holds the code. A record gone meanwhile (another check
      // killed or used it) answers wrong or dead from this check's count, as a number off the
      // roster would (codes.ts).
      check = 'tries' in settled ? settled : { result: 'expired', tries: 0 }
      // The 5th try is dead: this attempt's own code is cancelled after the reply.
      if (settled.result === 'dead' && sms !== undefined) {
        const ref = reserved.ref
        info.after(() => cancelQuietly(sms, info, ref))
      }
    }
  } else if (reserved.result === 'expired') {
    // Only the caller's own record, past its 5 minutes, answers a ref: cancel it after the reply.
    const { ref } = reserved
    const sms = api.sms
    if (ref !== undefined && sms !== undefined) info.after(() => cancelQuietly(sms, info, ref))
    check = { result: 'expired', tries: 0 }
  } else {
    // No code was sent for this attempt (it names nobody, or the text failed): every guess is wrong.
    check = reserved
  }
  const person = named(attempt)
  let stale: Stale | undefined
  if (check.result === 'approved' && person !== undefined) {
    // Approved: from here a retry finishes the sign-in without a second check, until it is used up
    // or the attempt's 10 minutes end.
    if (!(await fromValkey(info, updateAttempt(api.valkey, api.names, key, { ...person, step: 'verified' })))) {
      throw attemptExpired()
    }
    const finished = await finish(api, info, key, person)
    if (finished.kind === 'answer') return finished.answer
    // Stale on the first pass: the attempt goes back to the code (its record is gone, so its next
    // check answers code_expired), and the reply is the wrong guess below.
    try {
      await updateAttempt(api.valkey, api.names, key, attempt)
    } catch (error) {
      info.log.warn({ err: error, event: 'attempt_update_failed' })
    }
    stale = finished.stale
  }
  // Every failure is answered as a wrong guess at that count would be: an approved code on an attempt
  // that names nobody, a leaver, or a number no longer theirs too, so nothing tells them apart. The
  // record is gone (SETTLE deleted it), so the attempt's next check answers code_expired.
  const { tries } = check
  const result = check.result === 'approved' ? (tries >= OTP.maxTries ? 'dead' : 'wrong') : check.result
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
  if (result === 'expired') return floored(api, arrived, new ApiError(401, 'code_expired'))
  if (result === 'dead') return floored(api, arrived, new ApiError(401, 'code_dead'))
  return floored(api, arrived, new ApiError(401, 'code_wrong', { triesLeft: OTP.maxTries - tries }))
}

// Why a finish found the roster no longer matches: the person left, or the number moved.
type Stale = 'left' | 'number_removed'

type Finished = { kind: 'answer'; answer: Answer } | { kind: 'stale'; stale: Stale }

// A retry of a verified attempt: only the per-IP window, and a finish. One that finds the roster no
// longer matches drops the attempt: there's no code to go back to.
async function finishAgain(api: Api, info: ReqInfo, key: string, found: Attempt): Promise<Answer> {
  await enforce(api, info, [windowOf(api, LIMITS.authPerIp, ipTag(api, info))])
  const attempt = named(found)
  if (attempt === undefined) {
    await dropQuietly(api, info, key)
    throw attemptExpired()
  }
  const finished = await finish(api, info, key, attempt)
  if (finished.kind === 'answer') return finished.answer
  await dropQuietly(api, info, key)
  throw attemptExpired()
}

// The sign-in after an approved code (D46). One transaction reads the person FOR SHARE, then their
// roles, and acts on them, so a role granted meanwhile is either seen here or waits for it:
// - someone with no privileged role signs in on the code alone: the account row is made if it's
//   their first, the device and session issued, and the attempt used up as the last statement
//   before the commit, so a failure before it leaves the attempt verified for a retry (R1);
// - a privileged holder goes on to set their PIN (none yet) or to enter it, with its state.
// A leaver, or a number gone, answers stale and writes nothing.
async function finish(api: Api, info: ReqInfo, key: string, attempt: Named): Promise<Finished> {
  const { orgId, personId, phoneNumberId } = attempt
  let outcome:
    | { kind: 'stale'; stale: Stale }
    | { kind: 'signed_in'; session: IssuedSession }
    | {
        kind: 'pin'
        user: { pin_hash: string | null; pin_failures: number; pin_last_failed_at: Date | null; now: Date } | undefined
        passkeys: number | undefined
      }
  try {
    outcome = await withOrg(api.db, { orgId, system: true }, async trx => {
      if (!(await stillHere(trx, orgId, personId))) return { kind: 'stale', stale: 'left' } as const
      if (!(await privilegedNow(trx, orgId, personId))) {
        // The first sign-in makes the account (users comes before phone_numbers in the lock order).
        await sql`insert into users (id, org_id) values (${personId}, ${orgId}) on conflict (id) do nothing`.execute(
          trx,
        )
        const session = await issueSession(trx, sessionInput(attempt, info, 'sms', false))
        // Last, so only one request turns the attempt into a session, and a failure before here
        // leaves it verified.
        if (!(await fromValkey(info, consumeAttempt(api.valkey, api.names, key)))) throw attemptExpired()
        return { kind: 'signed_in', session } as const
      }
      // A number removed or moved since the code went to it moves the sign-in no further, and shows
      // nothing of the account.
      if (!(await numberStillTheirs(trx, orgId, personId, phoneNumberId))) {
        return { kind: 'stale', stale: 'number_removed' } as const
      }
      const user = await sql<{
        pin_hash: string | null
        pin_failures: number
        pin_last_failed_at: Date | null
        now: Date
      }>`select pin_hash, pin_failures, pin_last_failed_at, now() as now from users
        where org_id = ${orgId} and id = ${personId}`.execute(trx)
      // Passkeys are counted only while they're switched on (D46); off, the reply has no passkey key.
      if (!api.passkeys) return { kind: 'pin', user: user.rows[0], passkeys: undefined } as const
      const passkeys = await sql<{ n: string }>`select count(*) as n from passkeys
        where org_id = ${orgId} and user_id = ${personId} and removed_at is null`.execute(trx)
      return { kind: 'pin', user: user.rows[0], passkeys: Number(passkeys.rows[0]?.n ?? 0) } as const
    })
  } catch (error) {
    // issueSession found the number gone (or the person left after the read above).
    if (error instanceof AttemptStale) return { kind: 'stale', stale: 'number_removed' }
    throw error
  }
  if (outcome.kind === 'stale') return outcome
  if (outcome.kind === 'signed_in') return { kind: 'answer', answer: signedIn(outcome.session) }
  const { user } = outcome
  const pinHash = user?.pin_hash ?? null
  const next = pinHash === null ? 'set_pin' : 'step_up'
  if (!(await fromValkey(info, updateAttempt(api.valkey, api.names, key, { ...attempt, step: next })))) {
    throw attemptExpired()
  }
  if (user === undefined || pinHash === null) {
    return {
      kind: 'answer',
      answer: { body: { status: 'code_verified', next: 'set_pin' } satisfies z.input<typeof CodeVerifiedSchema> },
    }
  }
  const state = pinState({ pinHash, failures: user.pin_failures, lastFailedAt: user.pin_last_failed_at }, user.now)
  if (state.state === 'unset') throw new Error('a PIN with a hash read as unset')
  return {
    kind: 'answer',
    answer: {
      body: {
        status: 'code_verified',
        next: 'step_up',
        pin: pinStateJSON(state),
        ...(outcome.passkeys === undefined ? {} : { passkey: outcome.passkeys > 0 }),
      } satisfies z.input<typeof CodeVerifiedSchema>,
    },
  }
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
      // Read again here, where the session is issued: a role removed since the code was checked
      // still finishes with the PIN (stricter), with a normal lifetime (D46).
      const privileged = await privilegedNow(trx, orgId, personId)
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
      const issued = await issueSession(trx, sessionInput(attempt, info, 'sms_new_pin', privileged))
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
        const privileged = await privilegedNow(trx, orgId, personId)
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
        return {
          kind: 'issued',
          session: await issueSession(trx, sessionInput(attempt, info, 'sms_pin', privileged)),
        } as const
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
      const privileged = await privilegedNow(trx, orgId, personId)
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
      return {
        kind: 'issued',
        session: await issueSession(trx, sessionInput(attempt, info, 'sms_passkey', privileged)),
      } as const
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
