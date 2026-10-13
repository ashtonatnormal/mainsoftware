// The admin actions on a person that C0.5 needs (ACC-04, ACC-05, ACC-06; design §3.28):
// deactivating them, resetting their PIN, signing their devices out, and listing their devices.
// C0.16's console calls these. Each decides through can() (Principle 1) in its own transaction,
// with a fresh re-authentication (§9.4), after re-reading the actor's own session FOR SHARE
// (authorise). An action on someone else then takes that person's row, so the actor's rows come
// first and the target's after, in the lock order (0006): two admins acting on each other at the
// same moment deadlock, and exactly one gets 409 try_again rather than both succeeding.
import { type Request, World } from '@hearth/access'
import { sql } from 'kysely'
import { authorise, consider, decide, refusalFor } from '#src/access/world.ts'
import type { Api } from '#src/api.ts'
import { writeAudit } from '#src/auth/audit.ts'
import { clearedCookie } from '#src/auth/cookies.ts'
import { ApiError } from '#src/auth/errors.ts'
import { inSession, type SessionIds } from '#src/auth/sessions.ts'
import type { InOrg } from '#src/db/database.ts'
import { endDevices, endedSessions, hasLiveSession } from '#src/devices/routes.ts'
import type { Answer, ReqInfo } from '#src/http.ts'
import { publishRevoked } from '#src/revocation.ts'

const audit = (session: SessionIds, info: ReqInfo, target: string) =>
  ({
    orgId: session.orgId,
    actorId: session.userId,
    targetType: 'person',
    targetId: target,
    deviceId: session.deviceId,
    ip: info.ip,
    requestId: info.requestId,
  }) as const

// The target's person row FOR NO KEY UPDATE, before their sessions are ended: a sign-in in
// progress holds it FOR SHARE, so it finishes first, and this then ends the session it made.
async function lockPerson(trx: InOrg, orgId: string, personId: string): Promise<void> {
  await sql`select 1 from people where org_id = ${orgId} and id = ${personId} for no key update`.execute(trx)
}

// The same snapshot with one person still active, to ask whether an action refused only because
// they've left would otherwise be allowed.
function asIfActive(world: World, personId: string): World {
  return new World({
    ...world.facts,
    people: world.facts.people.map(p => (p.id === personId ? { ...p, deactivatedAt: null } : p)),
  })
}

// --- POST /api/admin/people/deactivate ------------------------------------------------------

// Deactivating someone signs them out everywhere in the same transaction (0006's
// people_end_sessions); after it commits, the offboarding handlers run (one, in C0.5, closes their
// sockets). Asking again for someone already deactivated answers 200 with sessionsEnded 0 and
// writes nothing, if the actor could have deactivated them.
export async function deactivate(
  api: Api,
  body: { person: string },
  session: SessionIds,
  info: ReqInfo,
): Promise<Answer> {
  const me = session.userId
  const target = body.person
  const request: Request = { action: 'person.deactivate', person: target }
  const outcome = await inSession(api, info, session, async trx => {
    const { world, verdict, fresh } = await consider(trx, session, request)
    if (verdict !== 'allowed') {
      // can() refuses an action on someone who has already left, so ask it as though they hadn't.
      if (verdict === 'refused' && world.person(target)?.deactivatedAt != null) {
        const again = decide(asIfActive(world, target), me, request, fresh)
        if (again === 'allowed') return { sessionsEnded: 0, first: false }
        throw refusalFor(again, 'forbidden')
      }
      throw refusalFor(verdict, 'forbidden')
    }
    const updated = await trx
      .updateTable('people')
      .set({ deactivated_at: sql<Date>`now()`, deactivated_by: me })
      .where('org_id', '=', session.orgId)
      .where('id', '=', target)
      .where('deactivated_at', 'is', null)
      .returning('id')
      .execute()
    // Another admin deactivated them a moment ago: this update waited for theirs.
    if (updated.length === 0) return { sessionsEnded: 0, first: false }
    const { rows } = await sql<{ n: string }>`select count(*) as n from sessions
      where org_id = ${session.orgId} and user_id = ${target} and revoke_reason = 'deactivated' and revoked_at = now()`.execute(
      trx,
    )
    const sessionsEnded = Number(rows[0]?.n ?? 0)
    await writeAudit(trx, { ...audit(session, info, target), action: 'person.deactivate', details: { sessionsEnded } })
    return { sessionsEnded, first: true }
  })
  if (outcome.first) await api.offboarding.run({ orgId: session.orgId, personId: target, actorId: me })
  return { body: { status: 'deactivated', sessionsEnded: outcome.sessionsEnded } }
}

// --- POST /api/admin/people/reset-pin -------------------------------------------------------

// ACC-06: after an identity check in person or on a video call, an admin clears someone's PIN and
// its lock. Their sessions end, so their next sign-in sets a new PIN after the SMS code. Their
// passkeys stay.
export async function resetPin(
  api: Api,
  body: { person: string; identityCheck: 'in_person' | 'video_call'; note?: string | undefined },
  session: SessionIds,
  info: ReqInfo,
): Promise<Answer> {
  const me = session.userId
  const { orgId } = session
  const target = body.person
  const ended = await inSession(api, info, session, async trx => {
    await authorise(trx, session, { action: 'person.reset_pin', person: target }, 'forbidden')
    await lockPerson(trx, orgId, target)
    const user = await sql`select id from users where org_id = ${orgId} and id = ${target} for update`.execute(trx)
    // Someone who has never signed in has no PIN to reset.
    if (user.rows.length === 0) throw new ApiError(409, 'no_account')
    await sql`update users set pin_hash = null, pin_key_id = null, pin_set_at = null, pin_failures = 0,
        pin_reset_at = now(), pin_reset_by = ${me}
      where org_id = ${orgId} and id = ${target}`.execute(trx)
    const { rows } = await sql<{ id: string }>`update sessions
      set revoked_at = now(), revoked_by = ${me}, revoke_reason = 'pin_reset'
      where org_id = ${orgId} and user_id = ${target} and revoked_at is null
      returning id`.execute(trx)
    const ids = rows.map(row => row.id)
    await writeAudit(trx, {
      ...audit(session, info, target),
      action: 'person.reset_pin',
      ...(body.note === undefined ? {} : { reason: body.note }),
      details: { identityCheck: body.identityCheck, sessionsEnded: ids.length },
    })
    return ids
  })
  await publishRevoked(api.valkey, api.keyPrefix, ended, info.log)
  return { body: { status: 'pin_reset', sessionsEnded: ended.length } }
}

// --- POST /api/admin/people/sign-out-devices ------------------------------------------------

// Signs every one of someone's devices out (ACC-04: "admins can remotely sign out any user's
// devices"). Signing yourself out this way includes this device, so the cookie is cleared too.
export async function signOutDevices(
  api: Api,
  body: { person: string },
  session: SessionIds,
  info: ReqInfo,
): Promise<Answer> {
  const target = body.person
  const self = target === session.userId
  const { ended, revoked } = await inSession(api, info, session, async trx => {
    await authorise(trx, session, { action: 'person.sign_out_devices', person: target }, 'forbidden', {
      person: self ? 'no_key_update' : 'share',
    })
    if (!self) await lockPerson(trx, session.orgId, target)
    const ended = await endDevices(trx, session, target)
    await writeAudit(trx, {
      ...audit(session, info, target),
      action: 'person.sign_out_devices',
      details: { devices: ended },
    })
    return { ended, revoked: await endedSessions(trx, session.orgId, ended) }
  })
  await publishRevoked(api.valkey, api.keyPrefix, revoked, info.log)
  return { body: { signedOut: ended.length }, cookies: self ? [clearedCookie('session')] : [] }
}

// --- GET /api/admin/people/:person/devices --------------------------------------------------

// Someone's signed-in devices, with dates in the org's time zone rather than times: another
// person's exact activity times are per-person activity data (PDPA-18, ADM-14), and an admin needs
// only "used recently or not".
export async function listDevices(api: Api, person: string, session: SessionIds, info: ReqInfo): Promise<Answer> {
  const { orgId } = session
  const { rows } = await inSession(api, info, session, async trx => {
    await authorise(trx, session, { action: 'person.list_devices', person }, 'forbidden', { lock: false })
    return sql<{ id: string; label: string; created_on: string; last_seen_on: string }>`
      select d.id, d.label,
        ((d.created_at at time zone o.time_zone)::date)::text as created_on,
        ((d.last_seen_at at time zone o.time_zone)::date)::text as last_seen_on
      from devices d join orgs o on o.id = d.org_id
      where d.org_id = ${orgId} and d.user_id = ${person} and d.signed_out_at is null and ${hasLiveSession}
      order by d.last_seen_at desc`.execute(trx)
  })
  return {
    body: {
      devices: rows.map(d => ({ id: d.id, label: d.label, createdOn: d.created_on, lastSeenOn: d.last_seen_on })),
    },
  }
}
