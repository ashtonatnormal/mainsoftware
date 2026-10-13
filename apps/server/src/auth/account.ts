// Signed-in self-service (ACC-02, §9.4; design §3.24): re-authenticating with the PIN or a
// passkey, adding and removing a passkey, and signing out. Every transaction runs as the
// session's person (inSession) and starts by re-reading the acting session FOR SHARE (person,
// device, session), so a session that ended a moment ago is refused with 401 signed_out.
//
// Re-authentication stamps the session; admin actions and passkey changes need a stamp from the
// last 5 minutes. It counts against a per-session window that, unlike sign-in's, lets requests
// through when Valkey is down: re-authentication is signed-in traffic, which carries on without
// Valkey, and the PIN lock in Postgres still bounds guessing while the PIN slots bound the work.
import { sql } from 'kysely'
import { actingSession, authorise } from '#src/access/world.ts'
import type { Api } from '#src/api.ts'
import { writeAudit } from '#src/auth/audit.ts'
import { clearedCookie } from '#src/auth/cookies.ts'
import { withPinSlot } from '#src/auth/crypto.ts'
import { ApiError } from '#src/auth/errors.ts'
import { hit } from '#src/auth/limiter.ts'
import {
  type AuthenticationResponse,
  authenticationOptions,
  type RegistrationResponse,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from '#src/auth/passkeys.ts'
import { checkPin } from '#src/auth/pin.ts'
import { LIMITS, PASSKEY_CHALLENGE_TTL_MS, REAUTH } from '#src/auth/policy.ts'
import { inSession, type SessionIds, signedOut, stampReauth } from '#src/auth/sessions.ts'
import {
  credentialFor,
  fromValkey,
  livePasskeys,
  pinRefusal,
  recordPasskeyUse,
  tooManyRequests,
  windowOf,
} from '#src/auth/sign-in.ts'
import type { InOrg } from '#src/db/database.ts'
import { endDevices, endedSessions } from '#src/devices/routes.ts'
import type { Answer, ReqInfo } from '#src/http.ts'
import { publishRevoked } from '#src/revocation.ts'

const reauthenticated: Answer = { body: { status: 'reauthenticated', validForSeconds: REAUTH.windowSeconds } }

// The acting session, or 401 signed_out.
async function acting(trx: InOrg, session: SessionIds): Promise<void> {
  if ((await actingSession(trx, session)) === undefined) throw signedOut()
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
      await acting(trx, session)
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

// --- POST /api/auth/reauth/passkey/options --------------------------------------------------

export async function reauthPasskeyOptions(api: Api, session: SessionIds, info: ReqInfo): Promise<Answer> {
  const live = await inSession(api, info, session, async trx => {
    await acting(trx, session)
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
  const expected = await fromValkey(info, api.valkey.getdel(api.names.challenge('reauth', session.sessionId)))
  if (expected === null) throw new ApiError(401, 'passkey_expired')
  const credentialId = Buffer.from(body.response.id, 'base64url')
  const ok = await inSession(api, info, session, async trx => {
    await acting(trx, session)
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
      // Its trigger ends the device's session with the reason device_sign_out (0003).
      const ended = await endDevices(trx, session, session.userId, { only: session.deviceId })
      if (ended.length > 0) await writeAudit(trx, { ...audit(session, info), action: 'auth.sign_out' })
      return endedSessions(trx, session.orgId, ended)
    })
  } catch (error) {
    if (error instanceof ApiError && error.code === 'signed_out') return done
    throw error
  }
  await publishRevoked(api.valkey, api.keyPrefix, revoked, info.log)
  return done
}
