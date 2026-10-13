// Your own devices (ACC-04, T14 item 7): the list of browsers and phones you're signed in on,
// with your passkeys, and signing one out, or all but this one. Signing a device out ends its
// sessions in the same transaction (0003's devices_end_sessions), and after the commit the
// realtime role is told to close their sockets (revocation.ts). Your own list shows exact times;
// an admin's view of it shows dates only (admin/people.ts).
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
import { publishRevoked } from '#src/revocation.ts'

// Signs out the person's devices that are still signed in: one (only), all but one (except), or
// all of them, as the acting session's person. Returns the devices this statement ended; the
// trigger ends their sessions with the reason device_sign_out. The caller has locked the person's
// row first when it ends more than one device (the lock order, 0006).
export async function endDevices(
  trx: InOrg,
  actor: SessionIds,
  personId: string,
  filter: { only?: string; except?: string } = {},
): Promise<string[]> {
  let query = trx
    .updateTable('devices')
    .set({ signed_out_at: sql<Date>`now()`, signed_out_by: actor.userId })
    .where('org_id', '=', actor.orgId)
    .where('user_id', '=', personId)
    .where('signed_out_at', 'is', null)
  if (filter.only !== undefined) query = query.where('id', '=', filter.only)
  if (filter.except !== undefined) query = query.where('id', '<>', filter.except)
  const rows = await query.returning('id').execute()
  return rows.map(row => row.id)
}

// The sessions this transaction ended by signing those devices out. now() is the transaction's
// start time, the same for every statement in it, so this finds exactly what it ended.
export async function endedSessions(trx: InOrg, orgId: string, deviceIds: readonly string[]): Promise<string[]> {
  if (deviceIds.length === 0) return []
  const { rows } = await sql<{ id: string }>`select id from sessions
    where org_id = ${orgId} and device_id = any(${[...deviceIds]}::uuid[])
      and revoke_reason = 'device_sign_out' and revoked_at = now()`.execute(trx)
  return rows.map(row => row.id)
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
        devices: devices.rows.map(d => ({
          id: d.id,
          label: d.label,
          createdAt: d.created_at,
          lastSeenAt: d.last_seen_at,
          current: d.id === session.deviceId,
        })),
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

// --- POST /api/devices/sign-out -------------------------------------------------------------

export const SignOutBody = z.union([z.strictObject({ device: Uuid }), z.strictObject({ allOthers: z.literal(true) })])

export async function signOutOwn(
  api: Api,
  body: z.output<typeof SignOutBody>,
  session: SessionIds,
  info: ReqInfo,
): Promise<Answer> {
  const named = 'device' in body ? body.device : undefined
  const { ended, revoked } = await inSession(api, info, session, async trx => {
    let ended: string[]
    if (named !== undefined) {
      // Someone else's device, or one already signed out, is 404: nothing shows that it exists.
      await authorise(trx, session, { action: 'devices.sign_out_own', device: named }, 'not_found')
      ended = await endDevices(trx, session, session.userId, { only: named })
      if (ended.length === 0) throw new ApiError(404, 'not_found')
    } else {
      // All your others: your person row FOR NO KEY UPDATE first, so a sign-in in progress on
      // another device finishes and is then signed out too.
      await authorise(trx, session, { action: 'devices.sign_out_own' }, 'not_found', { person: 'no_key_update' })
      ended = await endDevices(trx, session, session.userId, { except: session.deviceId })
    }
    if (ended.length > 0) {
      await writeAudit(trx, {
        orgId: session.orgId,
        actorId: session.userId,
        action: 'auth.device_sign_out',
        targetType: 'person',
        targetId: session.userId,
        deviceId: session.deviceId,
        ip: info.ip,
        requestId: info.requestId,
        details: { devices: ended },
      })
    }
    return { ended, revoked: await endedSessions(trx, session.orgId, ended) }
  })
  await publishRevoked(api.valkey, api.keyPrefix, revoked, info.log)
  const current = named === session.deviceId
  return { body: { signedOut: ended.length, current }, cookies: current ? [clearedCookie('session')] : [] }
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
