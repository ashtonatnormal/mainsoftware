// Your own devices (ACC-04, T14 item 7): the list of browsers and phones you're signed in on (with
// your passkeys only while those are switched on, D46), and signing one out, or all but this one.
// Signing a device out ends its sessions in the same transaction (0003's devices_end_sessions),
// which appends signin.ended to the outbox (C0.6, T16), and after the commit the realtime role is
// told to close their sockets (revocation/channels.ts), as the worker's revocation consumer also
// does from the outbox (C0.7). Your own list shows exact times; an admin's view of it shows dates
// only (admin/people.ts).
import type { FastifyInstance } from 'fastify'
import { sql } from 'kysely'
import { z } from 'zod'
import { authorise } from '#src/access/world.ts'
import type { Api } from '#src/api.ts'
import { writeAudit } from '#src/auth/audit.ts'
import { clearedCookie } from '#src/auth/cookies.ts'
import { ApiError } from '#src/auth/errors.ts'
import { SESSION } from '#src/auth/policy.ts'
import { inSession, requireSession, type SessionIds } from '#src/auth/sessions.ts'
import type { InOrg } from '#src/db/database.ts'
import { type Answer, parse, type ReqInfo, requestInfo, send, Uuid } from '#src/http.ts'
import { appendOutbox } from '#src/outbox/append.ts'
import { publishRevoked } from '#src/revocation/channels.ts'

// Signs out the person's devices that are still signed in: one (only), all but one (except), or
// all of them, as the acting session's person, and returns the devices this statement ended and the
// sessions their trigger ended with them (0003's devices_end_sessions, reason device_sign_out).
// When it ended any, it appends signin.ended to the outbox in the same transaction (T16), so every
// caller (signing out, your devices, an admin's) emits it. The caller has locked the person's row
// first when it ends more than one device (the lock order, 0006).
export async function endDevices(
  trx: InOrg,
  actor: SessionIds,
  personId: string,
  filter: { only?: string; except?: string } = {},
): Promise<{ devices: string[]; sessions: string[] }> {
  let query = trx
    .updateTable('devices')
    .set({ signed_out_at: sql<Date>`now()`, signed_out_by: actor.userId })
    .where('org_id', '=', actor.orgId)
    .where('user_id', '=', personId)
    .where('signed_out_at', 'is', null)
  if (filter.only !== undefined) query = query.where('id', '=', filter.only)
  if (filter.except !== undefined) query = query.where('id', '<>', filter.except)
  const devices = (await query.returning('id').execute()).map(row => row.id)
  if (devices.length === 0) return { devices, sessions: [] }
  // now() is the transaction's start time, the same for every statement in it, so this finds
  // exactly the sessions the trigger just ended.
  const { rows } = await sql<{ id: string }>`select id from sessions
    where org_id = ${actor.orgId} and device_id = any(${devices}::uuid[])
      and revoke_reason = 'device_sign_out' and revoked_at = now()`.execute(trx)
  const sessions = rows.map(row => row.id)
  await appendOutbox(trx, {
    orgId: actor.orgId,
    type: 'signin.ended',
    entity: { type: 'person', id: personId },
    subjects: [personId],
    purpose: 'accounts',
    ids: { sessions, devices, reason: 'device_sign_out' },
  })
  return { devices, sessions }
}

// A device counts as signed in while it has a live session: open, unexpired and used within the
// idle limit. Exported for the admin view, which shows the same devices.
export const hasLiveSession = sql`exists (select 1 from sessions s
  where s.org_id = d.org_id and s.device_id = d.id and s.revoked_at is null and s.expires_at > now()
    and s.last_seen_at > now() - ${SESSION.idle}::interval)`

// --- GET /api/devices -----------------------------------------------------------------------

export async function listOwn(api: Api, session: SessionIds, info: ReqInfo): Promise<Answer> {
  const { orgId, userId } = session
  return inSession(api, info, session, async trx => {
    await authorise(trx, session, { action: 'devices.list_own' }, 'not_found', { lock: false })
    const devices = await sql<{ id: string; label: string; created_at: Date; last_seen_at: Date }>`
      select d.id, d.label, d.created_at, d.last_seen_at from devices d
      where d.org_id = ${orgId} and d.user_id = ${userId} and d.signed_out_at is null and ${hasLiveSession}
      order by d.last_seen_at desc`.execute(trx)
    // Passkeys are listed only while they're switched on (D46); off, the reply has no passkeys key.
    if (!api.passkeys) return { body: { devices: devices.rows.map(d => deviceJSON(d, session.deviceId)) } }
    const passkeys = await sql<{
      id: string
      created_at: Date
      last_used_at: Date | null
      backed_up: boolean
      added_on: string | null
    }>`select k.id, k.created_at, k.last_used_at, k.backed_up, d.label as added_on
      from passkeys k left join devices d on d.org_id = k.org_id and d.id = k.created_device_id
      where k.org_id = ${orgId} and k.user_id = ${userId} and k.removed_at is null
      order by k.created_at`.execute(trx)
    return {
      body: {
        devices: devices.rows.map(d => deviceJSON(d, session.deviceId)),
        passkeys: passkeys.rows.map(k => ({
          id: k.id,
          createdAt: k.created_at,
          lastUsedAt: k.last_used_at,
          backedUp: k.backed_up,
          addedOn: k.added_on,
        })),
      },
    }
  })
}

// One device as GET /api/devices lists it.
function deviceJSON(d: { id: string; label: string; created_at: Date; last_seen_at: Date }, current: string) {
  return { id: d.id, label: d.label, createdAt: d.created_at, lastSeenAt: d.last_seen_at, current: d.id === current }
}

// --- POST /api/devices/sign-out -------------------------------------------------------------

export const SignOutBody = z.union([z.strictObject({ device: Uuid }), z.strictObject({ allOthers: z.literal(true) })])

export async function signOutOwn(
  api: Api,
  body: z.output<typeof SignOutBody>,
  session: SessionIds,
  info: ReqInfo,
): Promise<Answer> {
  const named = 'device' in body ? body.device : undefined
  const ended = await inSession(api, info, session, async trx => {
    let ended: { devices: string[]; sessions: string[] }
    if (named !== undefined) {
      // Someone else's device, or one already signed out, is 404: nothing shows that it exists.
      await authorise(trx, session, { action: 'devices.sign_out_own', device: named }, 'not_found')
      ended = await endDevices(trx, session, session.userId, { only: named })
      if (ended.devices.length === 0) throw new ApiError(404, 'not_found')
    } else {
      // All your others: your person row FOR NO KEY UPDATE first, so a sign-in in progress on
      // another device finishes and is then signed out too.
      await authorise(trx, session, { action: 'devices.sign_out_own' }, 'not_found', { person: 'no_key_update' })
      ended = await endDevices(trx, session, session.userId, { except: session.deviceId })
    }
    if (ended.devices.length > 0) {
      await writeAudit(trx, {
        orgId: session.orgId,
        actorId: session.userId,
        action: 'auth.device_sign_out',
        targetType: 'person',
        targetId: session.userId,
        deviceId: session.deviceId,
        ip: info.ip,
        requestId: info.requestId,
        details: { devices: ended.devices },
      })
    }
    return ended
  })
  if (api.publishRevoked !== false) await publishRevoked(api.valkey, api.keyPrefix, ended.sessions, info.log)
  const current = named === session.deviceId
  return { body: { signedOut: ended.devices.length, current }, cookies: current ? [clearedCookie('session')] : [] }
}

export function deviceRoutes(api: Api) {
  return async (scope: FastifyInstance): Promise<void> => {
    scope.get('/', async (request, reply) => {
      const session = await requireSession(api.db, request)
      return send(reply, await listOwn(api, session, requestInfo(api, request)))
    })
    scope.post('/sign-out', async (request, reply) => {
      const body = parse(SignOutBody, request.body)
      const session = await requireSession(api.db, request)
      return send(reply, await signOutOwn(api, body, session, requestInfo(api, request)))
    })
  }
}
