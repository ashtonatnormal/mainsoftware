// Sessions (T5): the browser holds an opaque token in the __Host-hearth_session cookie, and the
// database only its SHA-256. A request's session is found before the org is known
// (db/pre-org.ts), then every query for it runs in withOrg() acting as the session's person. A
// finished sign-in makes a device row and a session row in the sign-in's own transaction
// (issueSession). The database stamps a session's start, last use and re-authentication times
// (0006), so nothing here chooses them.
import type { FastifyRequest } from 'fastify'
import { sql } from 'kysely'
import type { Api } from '#src/api.ts'
import { writeAudit } from '#src/auth/audit.ts'
import { readCookie, SESSION_COOKIE } from '#src/auth/cookies.ts'
import { newSecret, sha256 } from '#src/auth/crypto.ts'
import { ApiError } from '#src/auth/errors.ts'
import { SESSION } from '#src/auth/policy.ts'
import { type Database, type InOrg, withOrg } from '#src/db/database.ts'
import { type SessionIds, sessionByToken } from '#src/db/pre-org.ts'
import type { ReqInfo } from '#src/http.ts'

export type { SessionIds }

// The live session behind a request, or undefined if there's no cookie, it's malformed, or the
// session has ended (revoked, expired, unused for 30 days, its device signed out, or its person
// gone). A lookup that fails is a 503: the request can't be decided either way.
export async function authenticate(db: Database, request: FastifyRequest): Promise<SessionIds | undefined> {
  const token = readCookie(request.headers.cookie, SESSION_COOKIE)
  if (token === undefined) return undefined
  try {
    return await sessionByToken(db, sha256(token), SESSION.idle)
  } catch (error) {
    request.log.error({ err: error, event: 'session_lookup_failed' }, 'session lookup failed')
    throw new ApiError(503, 'unavailable')
  }
}

// The same, or a 401 that clears the cookie, so the web app shows the signed-out screen.
export async function requireSession(db: Database, request: FastifyRequest): Promise<SessionIds> {
  const session = await authenticate(db, request)
  if (session === undefined) throw signedOut()
  return session
}

export function signedOut(): ApiError {
  return new ApiError(401, 'signed_out', {}, ['session'])
}

// Work for a signed-in request: withOrg() acting as the session's person. The session's last-use
// time is written after the response (touch).
export async function inSession<T>(
  api: Api,
  info: ReqInfo,
  session: SessionIds,
  work: (trx: InOrg) => Promise<T>,
): Promise<T> {
  const result = await withOrg(api.db, { orgId: session.orgId, userId: session.userId }, work)
  info.after(() => touch(api.db, session, info))
  return result
}

// When each session was last touched by this process, so a busy session writes at most once a
// minute. Cleared whenever it grows past MAX_TOUCHED, which only costs an extra write.
const touched = new Map<string, number>()
const MAX_TOUCHED = 10_000

// Writes the session's and its device's last-use time, at most once a minute per session per
// process, in a transaction of its own after the response. The device comes first, as the lock
// order has it (people, users, passkeys, phone_numbers, devices, sessions; 0006), and ended rows
// are left alone. The sessions trigger stores now() whatever is written. A GET touches too: the
// time is bookkeeping, not a change anyone makes. A failure is logged and otherwise ignored.
async function touch(db: Database, session: SessionIds, info: ReqInfo): Promise<void> {
  const now = Date.now()
  const last = touched.get(session.sessionId)
  if (last !== undefined && now - last < SESSION.touchEveryMs) return
  if (touched.size >= MAX_TOUCHED) touched.clear()
  touched.set(session.sessionId, now)
  try {
    await withOrg(db, { orgId: session.orgId, userId: session.userId }, async trx => {
      await sql`update devices set last_seen_at = now()
        where org_id = ${session.orgId} and id = ${session.deviceId}
          and signed_out_at is null and last_seen_at < now() - interval '1 minute'`.execute(trx)
      await sql`update sessions set last_seen_at = now()
        where org_id = ${session.orgId} and id = ${session.sessionId}
          and revoked_at is null and last_seen_at < now() - interval '1 minute'`.execute(trx)
    })
  } catch (error) {
    info.log.warn({ err: error, event: 'session_touch_failed', sessionId: session.sessionId })
  }
}

// Stamps a re-authentication on the session (§9.4). The trigger stores now() whatever is written.
export async function stampReauth(trx: InOrg, session: SessionIds): Promise<void> {
  await sql`update sessions set reauthenticated_at = now()
    where org_id = ${session.orgId} and id = ${session.sessionId}`.execute(trx)
}

// The sign-in can't finish: the person left, or the number the code went to was removed or moved
// to someone else, after the code was sent. The caller answers 401 attempt_expired.
export class AttemptStale extends Error {
  override name = 'AttemptStale'
  constructor() {
    super('the sign-in attempt no longer matches the roster')
  }
}

export interface IssuedSession {
  token: string
  sessionId: string
  deviceId: string
  label: string
  maxAgeSeconds: number
}

// Makes the device and session a finished sign-in earns, in the caller's transaction, which has
// already read the person FOR SHARE (sign-in.ts), and audits auth.sign_in. The number the code
// went to is read again FOR SHARE, so a number removed since the code was sent can't finish a
// sign-in (ACC-03, T14). The session starts re-authenticated: the sign-in just proved the PIN or a
// passkey (0006's default stamps it at the start).
export async function issueSession(
  trx: InOrg,
  input: {
    orgId: string
    personId: string
    phoneNumberId: string
    label: string
    method: 'sms_new_pin' | 'sms_pin' | 'sms_passkey'
    ip: string | null
    requestId: string
  },
): Promise<IssuedSession> {
  const { orgId, personId } = input
  const number = await sql`select 1 from phone_numbers
    where org_id = ${orgId} and id = ${input.phoneNumberId} and person_id = ${personId} and removed_at is null
    for share`.execute(trx)
  if (number.rows.length === 0) throw new AttemptStale()
  const token = newSecret()
  let deviceId: string
  let sessionId: string
  try {
    const device = await trx
      .insertInto('devices')
      .values({ org_id: orgId, user_id: personId, label: input.label })
      .returning('id')
      .executeTakeFirstOrThrow()
    deviceId = device.id
    const session = await sql<{ id: string }>`insert into sessions (org_id, user_id, device_id, token_hash, expires_at)
      values (${orgId}, ${personId}, ${deviceId}, ${sha256(token)}, now() + ${SESSION.lifetime}::interval)
      returning id`.execute(trx)
    const row = session.rows[0]
    if (row === undefined) throw new Error('the new session was not returned')
    sessionId = row.id
  } catch (error) {
    // check_user_active and sessions_check_start (0006) refuse someone who has left with a
    // check_violation of no named constraint; a named one is a real bug and is rethrown.
    if (isTriggerRefusal(error)) throw new AttemptStale()
    throw error
  }
  await writeAudit(trx, {
    orgId,
    actorId: personId,
    action: 'auth.sign_in',
    targetType: 'person',
    targetId: personId,
    deviceId,
    ip: input.ip,
    requestId: input.requestId,
    details: { method: input.method },
  })
  return { token, sessionId, deviceId, label: input.label, maxAgeSeconds: SESSION.lifetimeSeconds }
}

function isTriggerRefusal(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { code, constraint } = error as { code?: unknown; constraint?: unknown }
  return code === '23514' && constraint === undefined
}
