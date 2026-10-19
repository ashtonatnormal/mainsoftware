// GET /api/session (T21 item 10, OD-22): who is signed in, as the web shell needs it to start: the
// person's id, the name to show and the time zone to show times in (OD-10). Nothing more: no phone
// number and no roles; C0.16 adds capability booleans decided by can() when a screen needs one.
//
// The acting session is re-read and can() asked about session.read_own in a read-only
// transaction. Unlike GET /api/flags, the request counts as use of the session, so its last-use
// time is written after the response (sessions.ts touch, at most once a minute per process): the
// shell asks at boot, which a person does. That write is exempt from the outbox
// (outbox/coverage.ts, last_seen_at), and the read itself writes nothing.
import type { SessionJSON } from '@hearth/shared'
import { sql } from 'kysely'
import { authorise } from '#src/access/world.ts'
import type { Api } from '#src/api.ts'
import { ApiError } from '#src/auth/errors.ts'
import { inSession, type SessionIds } from '#src/auth/sessions.ts'
import type { Answer, ReqInfo } from '#src/http.ts'

// The answer for a session already looked up (web/routes.ts). The name is the profile's display
// name, else the roster's full name; the zone is the profile's, else the org's (orgs.time_zone is
// NOT NULL, migration 0001), so the server always sends one.
export async function readSession(api: Api, session: SessionIds, info: ReqInfo): Promise<Answer> {
  const found = await inSession(
    api,
    info,
    session,
    async trx => {
      await authorise(trx, session, { action: 'session.read_own' }, 'not_found', { lock: false })
      const { rows } = await sql<{ name: string; time_zone: string }>`
        select coalesce(pr.display_name, p.full_name) as name, coalesce(pr.time_zone, o.time_zone) as time_zone
        from people p
        join orgs o on o.id = p.org_id
        left join profiles pr on pr.org_id = p.org_id and pr.person_id = p.id
        where p.org_id = ${session.orgId} and p.id = ${session.userId}`.execute(trx)
      return rows[0]
    },
    { readOnly: true },
  )
  // Past authorise() the person's row exists; if it somehow doesn't, the session reads as ended.
  // web/routes.ts sends this 401 without clearing the cookie, as every refusal of these GETs.
  if (found === undefined) throw new ApiError(401, 'signed_out')
  const body: SessionJSON = { personId: session.userId, name: found.name, timeZone: found.time_zone }
  return { body }
}
