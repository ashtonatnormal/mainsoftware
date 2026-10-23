// Where people stand with their org's privacy notice (PDPA-03, ACC-12; C0.9 PD-43 to PD-45,
// TECH-SPEC T22 items 28 and 30): 'unpublished' while the org has no version, 'acknowledged' once
// the person has acknowledged the highest version, and 'required' otherwise. packages/access's
// noticeAdmits() decides what each standing lets through; this only reads it.
//
// One plain SELECT in the caller's transaction: the org's latest version (its unique (org_id,
// version) index) and, for each person, whether an acknowledgement of it exists. It takes no lock
// and calls no function, so the api's REST gate (access/world.ts requireNotice) and the realtime
// gateway's read-only admission (realtime/admission.ts; scripts/guards/realtime-readonly.test.ts
// reads this file too) both use it within their own grants, and it never joins the lock order. At
// READ COMMITTED a publish that commits after this read is seen by the next request: one decided
// before it finishes within its 30 s (T22 item 28's bound).
import type { NoticeStanding } from '@hearth/shared'
import { sql } from 'kysely'
import type { InOrg } from '#src/db/database.ts'

// Each person's standing, by id. A person the read somehow doesn't return reads as 'required', the
// standing that lets the least through besides the exempt uses (fail closed).
export async function noticeStandings(
  trx: InOrg,
  orgId: string,
  people: readonly string[],
): Promise<ReadonlyMap<string, NoticeStanding>> {
  const ids = [...new Set(people)]
  const standings = new Map<string, NoticeStanding>()
  if (ids.length === 0) return standings
  const { rows } = await sql<{ person: string; standing: NoticeStanding }>`
    select x.person,
      case when v.id is null then 'unpublished'
        when exists (
          select 1 from notice_acknowledgments a
          where a.org_id = ${orgId} and a.person_id = x.person and a.notice_version_id = v.id)
        then 'acknowledged'
        else 'required' end as standing
    from unnest(${ids}::uuid[]) as x(person)
    left join lateral (
      select id from notice_versions where org_id = ${orgId} order by version desc limit 1) v on true`.execute(trx)
  for (const row of rows) standings.set(row.person, row.standing)
  for (const id of ids) if (!standings.has(id)) standings.set(id, 'required')
  return standings
}

// One person's standing.
export async function noticeStanding(trx: InOrg, orgId: string, person: string): Promise<NoticeStanding> {
  return (await noticeStandings(trx, orgId, [person])).get(person) ?? 'required'
}
