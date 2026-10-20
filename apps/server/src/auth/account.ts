// Signed-in self-service (ACC-02, §9.4, T14, T20): re-authenticating with the PIN or an SMS code,
// signing out, and the dormant passkey routes (re-authenticating with a passkey, adding and
// removing one), registered only while passkeys are switched on (D46, policy.ts PASSKEYS_ON).
// Every transaction runs as the session's person (inSession) and starts by re-reading the acting
// session FOR SHARE (person, device, session), so a session that ended a moment ago is refused
// with 401 signed_out. Adding or removing a passkey and signing out append their outbox events
// beside the change (C0.6, T16); a re-authentication writes only stamps and counters, which are
// exempt (outbox/coverage.ts).
//
// Re-authentication stamps the session; admin actions and passkey changes need a stamp from the
// last 5 minutes. Each session has one method (D46, AQ-01, AQ-02; packages/access reauthMethodOf):
// the PIN for a session issued under the PIN rule, a fresh SMS code to the person's own number for
// any other, and a new sign-in for one that neither mends. Each route decides the method in the
// transaction that stamps, after re-reading the acting session, and refuses any other with 409
// reauth_method {method} before it checks or sends anything, so a PIN-rule session never
// gets an SMS stamp.
// - The PIN counts against a per-session window that, unlike sign-in's, lets requests through when
//   Valkey is down: re-authentication is signed-in traffic, which carries on without Valkey, and the
//   PIN lock in Postgres still bounds guessing while the PIN slots bound the work. So PIN-role
//   holders keep their admin powers through a Valkey or SMS provider outage.
// - An SMS code fails closed instead (AQ-10): the same per-session window, and per person 20 code
//   requests and 20 code checks a rolling day. The code lives in the number's one challenge record
//   (codes.ts), owned by `r:<session id>`, so a re-authentication code replaces a pending sign-in
//   code and the reverse; re-authentication codes don't count against sign-in's per-number windows.
//   A session sends one code at a time: a code request that overlaps another from the same session
//   answers 409 try_again before anything is opened or sent (sendLock). Its refusals carry no
//   floor: the caller is signed in, and there's nothing to hide. An approved code is kept until its
//   stamp commits (REAUTH.approvedMs), so a stamp that fails (409 try_again) is retried with no
//   second code; the session's next code request ends it before it opens the record, so from then
//   on only the new code stamps.
import { randomUUID } from 'node:crypto'
import type { CodeSentSchema, ReauthenticatedSchema, ReauthMethod } from '@hearth/shared'
import { sql } from 'kysely'
import type { z } from 'zod'
import { actingSession, authorise, reauthMethodNow } from '#src/access/world.ts'
import type { Api } from '#src/api.ts'
import { writeAudit } from '#src/auth/audit.ts'
import { openCode, reserveCode, settleCode } from '#src/auth/codes.ts'
import { clearedCookie } from '#src/auth/cookies.ts'
import { tag, withPinSlot } from '#src/auth/crypto.ts'
import { ApiError, reauthRefusal } from '#src/auth/errors.ts'
import { hit, runScript, script } from '#src/auth/limiter.ts'
import {
  type AuthenticationResponse,
  authenticationOptions,
  type RegistrationResponse,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from '#src/auth/passkeys.ts'
import { checkPin } from '#src/auth/pin.ts'
import { LIMITS, OTP, PASSKEY_CHALLENGE_TTL_MS, REAUTH } from '#src/auth/policy.ts'
import { inSession, numberStillTheirs, type SessionIds, signedOut, stampReauth } from '#src/auth/sessions.ts'
import {
  cancelQuietly,
  credentialFor,
  enforce,
  fromValkey,
  giveBack,
  livePasskeys,
  pinRefusal,
  providerFailure,
  recordPasskeyUse,
  startCode,
  tooManyRequests,
  windowOf,
} from '#src/auth/sign-in.ts'
import type { SmsProvider, Verdict } from '#src/auth/sms/provider.ts'
import type { InOrg } from '#src/db/database.ts'
import { endDevices } from '#src/devices/routes.ts'
import type { Answer, ReqInfo } from '#src/http.ts'
import { C06_GATE } from '#src/jobs/gate.ts'
import { appendOutbox } from '#src/outbox/append.ts'
import { publishRevoked } from '#src/revocation/channels.ts'

const reauthenticated: Answer = {
  body: { status: 'reauthenticated', validForSeconds: REAUTH.windowSeconds } satisfies z.input<
    typeof ReauthenticatedSchema
  >,
}

// The acting session, or 401 signed_out.
async function acting(trx: InOrg, session: SessionIds) {
  const facts = await actingSession(trx, session)
  if (facts === undefined) throw signedOut()
  return facts
}

// The acting session, and 409 reauth_method {method} unless it re-authenticates by `own` (D46, I2).
// Thrown before anything is checked, counted or sent, so nothing is written; the error handler logs
// it as reauth_wrong_method at warn (api.ts, T20 item 6).
async function actingBy(trx: InOrg, session: SessionIds, own: ReauthMethod): Promise<void> {
  const method = await reauthMethodNow(trx, session, await acting(trx, session))
  if (method !== own) throw reauthRefusal('reauth_method', method, session.userId)
}

// At most 10 re-authentications per session per 10 minutes. A Valkey error lets it through.
async function reauthLimit(api: Api, session: SessionIds, info: ReqInfo): Promise<void> {
  let result: Awaited<ReturnType<typeof hit>>
  try {
    result = await hit(api.valkey, [windowOf(api, LIMITS.reauthPerSession, session.sessionId)])
  } catch (error) {
    info.log.warn({ err: error, event: 'reauth_limit_unavailable' }, 'the re-authentication limit is unavailable')
    return
  }
  if (!result.allowed) throw tooManyRequests(result.retryAfterMs)
}

const audit = (session: SessionIds, info: ReqInfo) =>
  ({
    orgId: session.orgId,
    actorId: session.userId,
    targetType: 'person',
    targetId: session.userId,
    deviceId: session.deviceId,
    ip: info.ip,
    requestId: info.requestId,
  }) as const

// --- POST /api/auth/reauth/pin --------------------------------------------------------------

export async function reauthPin(api: Api, body: { pin: string }, session: SessionIds, info: ReqInfo): Promise<Answer> {
  if (!/^[0-9]{6}$/.test(body.pin)) throw new ApiError(400, 'invalid_pin')
  await reauthLimit(api, session, info)
  const check = await withPinSlot(() =>
    inSession(api, info, session, async trx => {
      await actingBy(trx, session, 'pin')
      const check = await checkPin(
        trx,
        api.keys,
        {
          orgId: session.orgId,
          personId: session.userId,
          pin: body.pin,
          during: 'reauth',
          actorId: session.userId,
          deviceId: session.deviceId,
          ip: info.ip,
          requestId: info.requestId,
        },
        info.log,
      )
      if (check.ok) {
        await stampReauth(trx, session)
        await writeAudit(trx, { ...audit(session, info), action: 'auth.reauth', details: { method: 'pin' } })
      }
      // A failure is returned, so its count and audit rows commit.
      return check
    }),
  )
  if (!check.ok) throw pinRefusal(check, 'reauth')
  return reauthenticated
}

// --- POST /api/auth/reauth/code/request -----------------------------------------------------

// The person's one current number (0002: one per person), read with no lock: phone_numbers comes
// before devices and sessions in the lock order, which acting() has already taken.
async function currentNumber(trx: InOrg, session: SessionIds): Promise<{ id: string; e164: string }> {
  const row = await trx
    .selectFrom('phone_numbers')
    .select(['id', 'e164'])
    .where('org_id', '=', session.orgId)
    .where('person_id', '=', session.userId)
    .where('removed_at', 'is', null)
    .executeTakeFirst()
  if (row === undefined) throw new ApiError(409, 'no_number')
  return row
}

// The challenge record's owner for a session's re-authentication (codes.ts).
const ownerOf = (session: SessionIds) => `r:${session.sessionId}`

// KEYS[1]: reauth-send:<session id>. ARGV: the holder's token. Frees the lock only while this
// request still holds it, so a request that outlived its lock never frees a newer request's.
const UNLOCK = script(`
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`)

type SendLock = { key: string; token: string }

// The session's send lock, or 409 try_again: another code request from this session (a double tap,
// two tabs) is still opening the record or sending. Every request from one session owns the record
// as r:<session id>, so two at once would both pass startCode's owner check: the older could attach
// its reference and the newer answer 503, after texting a code Hearth won't accept (T20 item 6).
// Taken before anything is opened or sent; fails closed, as the route does (AQ-10).
async function sendLock(api: Api, info: ReqInfo, session: SessionIds): Promise<SendLock> {
  const key = api.names.reauthSending(session.sessionId)
  const token = randomUUID()
  if ((await fromValkey(info, api.valkey.set(key, token, 'PX', REAUTH.sendLockMs, 'NX'))) !== 'OK') {
    info.log.info(
      { event: 'reauth_code_busy', personId: session.userId },
      'a re-authentication code request from this session is still in progress',
    )
    throw new ApiError(409, 'try_again')
  }
  return { key, token }
}

// Frees the send lock, best effort: a failure is logged, and the lock ends after REAUTH.sendLockMs.
async function unlock(api: Api, info: ReqInfo, lock: SendLock): Promise<void> {
  try {
    await runScript(api.valkey, UNLOCK, [lock.key], [lock.token])
  } catch (error) {
    info.log.warn({ err: error, event: 'reauth_unlock_failed' }, 'a re-authentication send lock could not be freed')
  }
}

export async function reauthCodeRequest(api: Api, session: SessionIds, info: ReqInfo): Promise<Answer> {
  const sms = api.sms
  if (sms === undefined) throw new ApiError(503, 'unavailable')
  await enforce(api, info, [windowOf(api, LIMITS.reauthPerSession, session.sessionId)])
  const lock = await sendLock(api, info, session)
  try {
    return await sendReauthCode(api, session, info, sms)
  } finally {
    await unlock(api, info, lock)
  }
}

// The request's work, under the session's send lock.
async function sendReauthCode(api: Api, session: SessionIds, info: ReqInfo, sms: SmsProvider): Promise<Answer> {
  const owner = ownerOf(session)
  const opened = await inSession(api, info, session, async trx => {
    await actingBy(trx, session, 'code')
    const number = await currentNumber(trx, session)
    await enforce(api, info, [windowOf(api, LIMITS.reauthCodePerPerson, session.userId)])
    const requested = (send: 'attempted' | 'skipped_not_cleared' | 'skipped_cap') =>
      writeAudit(trx, {
        ...audit(session, info),
        action: 'auth.code_requested',
        details: { during: 'reauth', send },
      })
    // An outside provider receives the number only once PDPA-10's transfer register clears it (C0.9).
    if (sms.transfer !== null && !(api.gate ?? C06_GATE).providerCleared(session.orgId, sms.transfer)) {
      await requested('skipped_not_cleared')
      info.log.error(
        { event: 'sms_provider_not_cleared', provider: sms.name, personId: session.userId },
        'a re-authentication code was not sent: the provider is not cleared in the transfer register',
      )
      return undefined
    }
    let capped: 'sms_global_cap' | 'sms_cap_unavailable' | undefined
    try {
      const result = await hit(api.valkey, [windowOf(api, LIMITS.smsGlobal, 'all')])
      if (!result.allowed) capped = 'sms_global_cap'
    } catch {
      capped = 'sms_cap_unavailable'
    }
    if (capped !== undefined) {
      await requested('skipped_cap')
      info.log.error({ event: capped, personId: session.userId }, 'a re-authentication code was not sent: the SMS cap')
      return undefined
    }
    const numberTag = tag(api.keys, number.e164)
    // A new code ends any approval this session still holds from a stamp that failed, before the
    // record is opened, so from here only the new code stamps it (T20 item 6).
    await fromValkey(info, api.valkey.del(api.names.reauthApproved(session.sessionId)))
    // This session owns the number's challenge from here; any earlier code is cancelled below.
    const replacedRef = await fromValkey(info, openCode(api.valkey, api.names, numberTag, owner))
    await requested('attempted')
    return { e164: number.e164, numberTag, replacedRef }
  })
  // A skip was audited and committed; nothing was sent.
  if (opened === undefined) throw new ApiError(503, 'unavailable')
  // Signed-in traffic, nothing to hide: the text is sent before the reply, so a failure says so.
  if (opened.replacedRef !== undefined) await cancelQuietly(sms, info, opened.replacedRef)
  let started: Awaited<ReturnType<typeof startCode>>
  try {
    started = await startCode(api, info, sms, {
      e164: opened.e164,
      numberTag: opened.numberTag,
      owner,
      personId: session.userId,
    })
  } catch (error) {
    info.log.error(
      { event: 'sms_send_failed', provider: sms.name, ...providerFailure(error), personId: session.userId },
      'a re-authentication code could not be sent',
    )
    throw new ApiError(503, 'unavailable')
  }
  // A sign-in request for the number replaced this code meanwhile, or the provider twice handed back
  // a verification Hearth didn't start: no code is live for this session.
  if (started !== 'attached') throw new ApiError(503, 'unavailable')
  return {
    body: { status: 'code_sent', expiresInSeconds: OTP.ttlMs / 1000, codeLength: OTP.length } satisfies z.input<
      typeof CodeSentSchema
    >,
  }
}

// --- POST /api/auth/reauth/code/verify ------------------------------------------------------

export async function reauthCodeVerify(
  api: Api,
  body: { code: string },
  session: SessionIds,
  info: ReqInfo,
): Promise<Answer> {
  const sms = api.sms
  if (sms === undefined) throw new ApiError(503, 'unavailable')
  // A check the provider never answered (the breaker open, or the provider failing) gives the day's
  // check back (sign-in.ts giveBack); the per-session window still counts the request.
  const day = windowOf(api, LIMITS.reauthCheckPerPerson, session.userId)
  const member = await enforce(api, info, [windowOf(api, LIMITS.reauthPerSession, session.sessionId), day])
  const owner = ownerOf(session)
  // Transaction A writes nothing: the method is decided before any provider check is spent.
  const number = await inSession(api, info, session, async trx => {
    await actingBy(trx, session, 'code')
    return currentNumber(trx, session)
  })
  // The provider approved this session's code for this number, and the stamp failed before it
  // committed (409 try_again, Postgres lost): any 6 digits stamp it now with no second check, as
  // sign-in's verified step finishes a sign-in (T20 items 4 and 6). No provider is asked, so the
  // day's check is given back.
  const approvedKey = api.names.reauthApproved(session.sessionId)
  if ((await fromValkey(info, api.valkey.get(approvedKey))) === number.id) {
    await giveBack(api, info, [day], member)
    if (await stampByCode(api, info, session, number.id, approvedKey)) return reauthenticated
    await inSession(api, info, session, trx =>
      writeAudit(trx, {
        ...audit(session, info),
        action: 'auth.code_failed',
        details: { during: 'reauth', result: 'expired' },
      }),
    )
    throw new ApiError(401, 'code_expired')
  }
  if (api.otp.breaker.isOpen()) {
    await giveBack(api, info, [day], member)
    throw new ApiError(503, 'unavailable')
  }
  const numberTag = tag(api.keys, number.e164)
  const reserved = await fromValkey(info, reserveCode(api.valkey, api.names, numberTag, owner))
  let check: { result: 'approved' | 'wrong' | 'dead' | 'expired'; tries: number }
  if (reserved.result === 'check') {
    let verdict: Verdict | 'failed' = 'failed'
    try {
      verdict = await sms.check(reserved.ref, body.code)
    } catch (error) {
      api.otp.breaker.failed()
      info.log.error(
        { event: 'sms_check_failed', provider: sms.name, ...providerFailure(error) },
        'the SMS provider could not check a code',
      )
    }
    const settled = await fromValkey(info, settleCode(api.valkey, api.names, numberTag, owner, reserved, verdict))
    // The provider couldn't answer: the try was given back (on this session's own live record), and
    // the day's check, even when a sign-in request replaced the record meanwhile.
    if (settled.result === 'failed') {
      await giveBack(api, info, [day], member)
      throw new ApiError(503, 'unavailable')
    }
    // A sign-in request replaced this session's code during the check: it no longer counts.
    if (settled.result === 'displaced') check = { result: 'expired', tries: 0 }
    else check = 'tries' in settled ? settled : { result: 'expired', tries: 0 }
    if (settled.result === 'dead') {
      const ref = reserved.ref
      info.after(() => cancelQuietly(sms, info, ref))
    }
  } else if (reserved.result === 'expired') {
    const { ref } = reserved
    if (ref !== undefined) info.after(() => cancelQuietly(sms, info, ref))
    check = { result: 'expired', tries: 0 }
  } else {
    check = reserved
  }
  if (check.result === 'approved') {
    // SETTLE has used the record up, so the approval is kept until the stamp commits: a retry
    // after a failed stamp needs no second code (above).
    await fromValkey(info, api.valkey.set(approvedKey, number.id, 'PX', REAUTH.approvedMs))
    if (await stampByCode(api, info, session, number.id, approvedKey)) return reauthenticated
    check = { result: 'expired', tries: 0 }
  }
  const result = check.result
  await inSession(api, info, session, trx =>
    writeAudit(trx, { ...audit(session, info), action: 'auth.code_failed', details: { during: 'reauth', result } }),
  )
  if (result === 'expired') throw new ApiError(401, 'code_expired')
  if (result === 'dead') throw new ApiError(401, 'code_dead')
  throw new ApiError(401, 'code_wrong', { triesLeft: OTP.maxTries - check.tries })
}

// Transaction B, after an approved code: the method again (a grant committed since refuses, and the
// spent code stamps nothing), and the number still theirs, then the stamp. The number is read with
// no lock: acting() has already taken the person, device and session FOR SHARE, and phone_numbers
// comes before devices and sessions in the lock order (0006, CLAUDE.md). The person's row, held FOR
// SHARE, already serialises this against a phone change, which takes it FOR NO KEY UPDATE first and
// ends every session. The approval is used up as the last statement before COMMIT, so only a stamp
// that didn't commit leaves it for a retry; a COMMIT that then fails asks for a new code, as a
// sign-in's does (T20 item 4). False when the number is no longer theirs.
async function stampByCode(
  api: Api,
  info: ReqInfo,
  session: SessionIds,
  numberId: string,
  approvedKey: string,
): Promise<boolean> {
  return inSession(api, info, session, async trx => {
    await actingBy(trx, session, 'code')
    if (!(await numberStillTheirs(trx, session.orgId, session.userId, numberId, { locked: false }))) return false
    await stampReauth(trx, session)
    await writeAudit(trx, { ...audit(session, info), action: 'auth.reauth', details: { method: 'sms' } })
    await fromValkey(info, api.valkey.del(approvedKey))
    return true
  })
}

// --- POST /api/auth/reauth/passkey/options --------------------------------------------------

export async function reauthPasskeyOptions(api: Api, session: SessionIds, info: ReqInfo): Promise<Answer> {
  const live = await inSession(api, info, session, async trx => {
    // A passkey stands in for the PIN, so only a session that re-authenticates with the PIN asks for
    // one (D46, I2): the dormant code keeps the one-method rule.
    await actingBy(trx, session, 'pin')
    return livePasskeys(trx, session.orgId, session.userId)
  })
  if (live.length === 0) throw new ApiError(409, 'no_passkey')
  const options = await authenticationOptions(api.rp, live)
  await fromValkey(
    info,
    api.valkey.set(api.names.challenge('reauth', session.sessionId), options.challenge, 'PX', PASSKEY_CHALLENGE_TTL_MS),
  )
  return { body: { options } }
}

// --- POST /api/auth/reauth/passkey/verify ---------------------------------------------------

export async function reauthPasskeyVerify(
  api: Api,
  body: { response: AuthenticationResponse },
  session: SessionIds,
  info: ReqInfo,
): Promise<Answer> {
  await reauthLimit(api, session, info)
  // The wrong method is refused before the challenge is spent (D46, I2), as the options route does.
  await inSession(api, info, session, trx => actingBy(trx, session, 'pin'))
  const expected = await fromValkey(info, api.valkey.getdel(api.names.challenge('reauth', session.sessionId)))
  if (expected === null) throw new ApiError(401, 'passkey_expired')
  const credentialId = Buffer.from(body.response.id, 'base64url')
  const ok = await inSession(api, info, session, async trx => {
    // A passkey stands in for the PIN, so only a session that re-authenticates with the PIN uses one.
    await actingBy(trx, session, 'pin')
    const failed = async (passkey?: string) => {
      await writeAudit(trx, {
        ...audit(session, info),
        action: 'auth.passkey_failed',
        details: passkey === undefined ? { during: 'reauth' } : { during: 'reauth', passkey },
      })
      return false
    }
    const stored = await credentialFor(trx, session.orgId, session.userId, credentialId)
    if (stored === undefined) return failed()
    const verified = await verifyAuthentication(api.rp, body.response, expected, stored, stored.userHandle, info.log)
    if (verified === undefined) return failed(stored.id)
    await recordPasskeyUse(trx, session.orgId, stored.id, verified.newCounter)
    await stampReauth(trx, session)
    await writeAudit(trx, { ...audit(session, info), action: 'auth.reauth', details: { method: 'passkey' } })
    return true
  })
  if (!ok) throw new ApiError(401, 'passkey_failed')
  return reauthenticated
}

// --- POST /api/auth/passkeys/register/options -----------------------------------------------

export async function registerOptions(api: Api, session: SessionIds, info: ReqInfo): Promise<Answer> {
  const { orgId, userId } = session
  const found = await inSession(api, info, session, async trx => {
    await authorise(trx, session, { action: 'passkeys.add_own' }, 'forbidden')
    const user = await trx
      .selectFrom('users')
      .select('passkey_user_handle')
      .where('org_id', '=', orgId)
      .where('id', '=', userId)
      .executeTakeFirstOrThrow()
    const person = await trx
      .selectFrom('people')
      .select('full_name')
      .where('org_id', '=', orgId)
      .where('id', '=', userId)
      .executeTakeFirstOrThrow()
    return { handle: user.passkey_user_handle, name: person.full_name, live: await livePasskeys(trx, orgId, userId) }
  })
  // The person's other passkeys are excluded, so an authenticator that holds one says so.
  const options = await registrationOptions(api.rp, { handle: found.handle, name: found.name }, found.live)
  await fromValkey(
    info,
    api.valkey.set(
      api.names.challenge('register', session.sessionId),
      options.challenge,
      'PX',
      PASSKEY_CHALLENGE_TTL_MS,
    ),
  )
  return { body: { options } }
}

// --- POST /api/auth/passkeys/register/verify ------------------------------------------------

export async function registerVerify(
  api: Api,
  body: { response: RegistrationResponse },
  session: SessionIds,
  info: ReqInfo,
): Promise<Answer> {
  const expected = await fromValkey(info, api.valkey.getdel(api.names.challenge('register', session.sessionId)))
  if (expected === null) throw new ApiError(401, 'passkey_expired')
  const passkey = await verifyRegistration(api.rp, body.response, expected, info.log)
  if (passkey === undefined) throw new ApiError(400, 'passkey_failed')
  const created = await inSession(api, info, session, async trx => {
    await authorise(trx, session, { action: 'passkeys.add_own' }, 'forbidden')
    let row: { id: string; created_at: Date } | undefined
    try {
      const inserted = await sql<{ id: string; created_at: Date }>`insert into passkeys
          (org_id, user_id, credential_id, public_key, counter, transports, backed_up, created_device_id)
        values (${session.orgId}, ${session.userId}, ${passkey.credentialId}, ${passkey.publicKey}, ${passkey.counter},
          ${passkey.transports}::text[], ${passkey.backedUp}, ${session.deviceId})
        returning id, created_at`.execute(trx)
      row = inserted.rows[0]
    } catch (error) {
      if (isDuplicateCredential(error)) throw new ApiError(409, 'passkey_exists')
      throw error
    }
    if (row === undefined) throw new Error('the new passkey was not returned')
    await appendOutbox(trx, {
      orgId: session.orgId,
      type: 'account.passkey_added',
      entity: { type: 'person', id: session.userId },
      subjects: [session.userId],
      purpose: 'accounts',
      ids: { passkey: row.id },
    })
    await writeAudit(trx, {
      ...audit(session, info),
      action: 'auth.passkey_added',
      details: { passkey: row.id, backedUp: passkey.backedUp },
    })
    return row
  })
  return {
    status: 201,
    body: { passkey: { id: created.id, createdAt: created.created_at, backedUp: passkey.backedUp } },
  }
}

function isDuplicateCredential(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { code, constraint } = error as { code?: unknown; constraint?: unknown }
  return code === '23505' && constraint === 'passkeys_credential_id_unique'
}

// --- POST /api/auth/passkeys/remove ---------------------------------------------------------

export async function removePasskey(
  api: Api,
  body: { passkey: string },
  session: SessionIds,
  info: ReqInfo,
): Promise<Answer> {
  await inSession(api, info, session, async trx => {
    // Someone else's passkey, or one already removed, is 404: nothing shows that it exists.
    await authorise(trx, session, { action: 'passkeys.remove_own', passkey: body.passkey }, 'not_found')
    const removed = await trx
      .updateTable('passkeys')
      .set({ removed_at: sql<Date>`now()`, removed_by: session.userId })
      .where('org_id', '=', session.orgId)
      .where('id', '=', body.passkey)
      .where('user_id', '=', session.userId)
      .where('removed_at', 'is', null)
      .returning('id')
      .execute()
    if (removed.length === 0) throw new ApiError(404, 'not_found')
    await appendOutbox(trx, {
      orgId: session.orgId,
      type: 'account.passkey_removed',
      entity: { type: 'person', id: session.userId },
      subjects: [session.userId],
      purpose: 'accounts',
      ids: { passkey: body.passkey },
    })
    await writeAudit(trx, {
      ...audit(session, info),
      action: 'auth.passkey_removed',
      details: { passkey: body.passkey },
    })
  })
  return { body: { status: 'removed' } }
}

// --- POST /api/auth/sign-out ----------------------------------------------------------------

// Signs this device out, ending its session. Idempotent: with no session, or one that ended a
// moment ago, it answers the same and clears the cookie.
export async function signOut(api: Api, session: SessionIds | undefined, info: ReqInfo): Promise<Answer> {
  const done: Answer = { body: { status: 'signed_out' }, cookies: [clearedCookie('session')] }
  if (session === undefined) return done
  let revoked: string[]
  try {
    revoked = await inSession(api, info, session, async trx => {
      await authorise(trx, session, { action: 'devices.sign_out_own' }, 'not_found')
      // Its trigger ends the device's session with the reason device_sign_out (0003), and
      // endDevices appends signin.ended for it.
      const ended = await endDevices(trx, session, session.userId, { only: session.deviceId })
      if (ended.devices.length > 0) await writeAudit(trx, { ...audit(session, info), action: 'auth.sign_out' })
      return ended.sessions
    })
  } catch (error) {
    if (error instanceof ApiError && error.code === 'signed_out') return done
    throw error
  }
  if (api.publishRevoked !== false) await publishRevoked(api.valkey, api.keyPrefix, revoked, info.log)
  return done
}
