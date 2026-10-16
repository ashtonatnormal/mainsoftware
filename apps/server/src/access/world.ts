// How the server asks packages/access (Principle 1: every access check goes through can()). An
// action re-reads the acting session in its own transaction, loads the facts C0.5's requests need
// into a World, and lets can() decide, with the session's re-authentication as context.
import { can, type Facts, type Request, type RoleFact, World } from '@hearth/access'
import { sql } from 'kysely'
import { ApiError } from '#src/auth/errors.ts'
import { REAUTH, SESSION } from '#src/auth/policy.ts'
import { signedOut } from '#src/auth/sessions.ts'
import type { InOrg } from '#src/db/database.ts'
import type { SessionIds } from '#src/db/pre-org.ts'

export interface ActingOptions {
  // How the acting person's row is locked: FOR SHARE (the default), or FOR NO KEY UPDATE for an
  // action that ends all of their own sessions, so a sign-in in progress on another device
  // finishes first and is then signed out too (the lock order, 0006).
  person?: 'share' | 'no_key_update'
  // false: a plain read, for GETs, which change nothing.
  lock?: boolean
  // The person an admin action changes. Once can() has allowed the action, their person row is
  // taken FOR NO KEY UPDATE and can() decides again, so a deactivation of them in progress makes
  // the action wait and then decide on what it committed, and a refused caller locks nothing of
  // theirs. This is an exception to the lock order: the target's row comes after the actor's own
  // person, device and session rows, so two admins acting on each other at the same moment can
  // deadlock, and one of them gets 409 try_again (CLAUDE.md, Database).
  target?: string
}

// The acting session, re-read in the action's own transaction, because the pre-org lookup's
// locks ended with its transaction. Undefined unless the person, device and session are all still
// live; otherwise whether the session re-authenticated in the last 5 minutes. The rows are taken
// FOR SHARE, person, device, session (the lock order), so a deactivation, sign-out or revocation
// in progress either waits for this action, or makes it wait and then refuse (CLAUDE.md,
// Database).
export async function actingSession(
  trx: InOrg,
  session: SessionIds,
  options: ActingOptions = {},
): Promise<{ fresh: boolean } | undefined> {
  const locking =
    options.lock === false
      ? sql``
      : options.person === 'no_key_update'
        ? sql`for no key update of p for share of d, s`
        : sql`for share of p, d, s`
  const { rows } = await sql<{ fresh: boolean }>`
    select s.reauthenticated_at > now() - ${REAUTH.window}::interval as fresh
    from people p
    join devices d on d.org_id = p.org_id and d.user_id = p.id
    join sessions s on s.org_id = d.org_id and s.device_id = d.id
    where p.org_id = ${session.orgId} and p.id = ${session.userId}
      and d.id = ${session.deviceId} and s.id = ${session.sessionId}
      and s.revoked_at is null and s.expires_at > now() and s.last_seen_at > now() - ${SESSION.idle}::interval
      and d.signed_out_at is null and p.deactivated_at is null
    ${locking}`.execute(trx)
  const row = rows[0]
  return row === undefined ? undefined : { fresh: row.fresh === true }
}

const ms = (time: Date | null): number | null => (time === null ? null : time.getTime())

// A snapshot of what C0.5's requests need (T13): every person in the org with their deactivation,
// every role row, every team (a Team Admin row counts only while its team is live), and the
// devices and passkeys of the one person named. There are no role proposals until C0.16's table,
// so roleProposals is empty; C0.16's loader must then load every open proposal for actor and
// target (World's loader obligations). Every other fact is empty, and the settings the strictest,
// so a content request asked of this World is refused, never wrongly allowed.
export async function loadWorld(trx: InOrg, orgId: string, options: { credentialsOf?: string } = {}): Promise<World> {
  const people = await trx.selectFrom('people').select(['id', 'deactivated_at']).where('org_id', '=', orgId).execute()
  const roles = await trx
    .selectFrom('role_assignments')
    .select(['person_id', 'role', 'team_id', 'revoked_at'])
    .where('org_id', '=', orgId)
    .execute()
  const teams = await trx.selectFrom('teams').select(['id', 'archived_at']).where('org_id', '=', orgId).execute()
  const owner = options.credentialsOf
  const devices =
    owner === undefined
      ? []
      : await trx
          .selectFrom('devices')
          .select(['id', 'user_id', 'signed_out_at'])
          .where('org_id', '=', orgId)
          .where('user_id', '=', owner)
          .execute()
  const passkeys =
    owner === undefined
      ? []
      : await trx
          .selectFrom('passkeys')
          .select(['id', 'user_id', 'removed_at'])
          .where('org_id', '=', orgId)
          .where('user_id', '=', owner)
          .execute()
  return worldOf(orgId, {
    people: people.map(p => ({ id: p.id, deactivatedAt: ms(p.deactivated_at) })),
    roles: roles.map(r => ({ personId: r.person_id, role: r.role, teamId: r.team_id, revokedAt: ms(r.revoked_at) })),
    teams: teams.map(t => ({ id: t.id, archivedAt: ms(t.archived_at) })),
    devices: devices.map(d => ({ id: d.id, userId: d.user_id, signedOutAt: ms(d.signed_out_at) })),
    passkeys: passkeys.map(k => ({ id: k.id, userId: k.user_id, removedAt: ms(k.removed_at) })),
  })
}

// The facts the gateway's topic decisions need (TECH-SPEC T19 item 8, T13's loader obligations),
// read in the caller's read-only transaction: for every person listed, their person row, every team
// membership not removed and every role row not revoked, and every team of the org, so keysOf() is
// exact for each of them. Nothing else is loaded, and can() is asked only about those people, and
// only topic requests (realtime/topics.ts). No row is locked: teams and memberships are never
// locked, so the lock order (CLAUDE.md, Database) is unchanged.
export async function loadTopicWorld(trx: InOrg, orgId: string, people: readonly string[]): Promise<World> {
  const ids = [...new Set(people)]
  const { rows: persons } = await sql<{ id: string; deactivated_at: Date | null }>`
    select id, deactivated_at from people where org_id = ${orgId} and id = any(${ids}::uuid[])`.execute(trx)
  const { rows: members } = await sql<{ team_id: string; person_id: string; removed_at: Date | null }>`
    select team_id, person_id, removed_at from team_memberships
    where org_id = ${orgId} and person_id = any(${ids}::uuid[]) and removed_at is null`.execute(trx)
  const { rows: roles } = await sql<{
    person_id: string
    role: RoleFact['role']
    team_id: string | null
    revoked_at: Date | null
  }>`
    select person_id, role, team_id, revoked_at from role_assignments
    where org_id = ${orgId} and person_id = any(${ids}::uuid[]) and revoked_at is null`.execute(trx)
  const { rows: teams } = await sql<{ id: string; archived_at: Date | null }>`
    select id, archived_at from teams where org_id = ${orgId}`.execute(trx)
  return worldOf(orgId, {
    people: persons.map(p => ({ id: p.id, deactivatedAt: ms(p.deactivated_at) })),
    roles: roles.map(r => ({ personId: r.person_id, role: r.role, teamId: r.team_id, revokedAt: ms(r.revoked_at) })),
    teams: teams.map(t => ({ id: t.id, archivedAt: ms(t.archived_at) })),
    teamMembers: members.map(m => ({ teamId: m.team_id, personId: m.person_id, removedAt: ms(m.removed_at) })),
  })
}

// A World of these facts, every other one empty, and the settings the strictest, so a request the
// loader didn't load for is refused, never wrongly allowed.
function worldOf(
  orgId: string,
  facts: Pick<Facts, 'people' | 'roles' | 'teams'> & Partial<Pick<Facts, 'teamMembers' | 'devices' | 'passkeys'>>,
): World {
  return new World({
    org: { id: orgId },
    // Not stored until C0.16; the stricter value, which no C0.5 or C0.7 request reads.
    settings: { publicCreation: 'admins' },
    people: facts.people,
    roles: facts.roles,
    roleProposals: [],
    teams: facts.teams,
    teamMembers: facts.teamMembers ?? [],
    auditLogReaders: [],
    agents: [],
    assistants: [],
    channels: [],
    conversations: [],
    memberships: [],
    messages: [],
    rooms: [],
    threads: [],
    sessions: [],
    slideCopies: [],
    events: [],
    tasks: [],
    suggestedTasks: [],
    folders: [],
    files: [],
    comments: [],
    derived: [],
    devices: facts.devices ?? [],
    passkeys: facts.passkeys ?? [],
  })
}

export type Verdict = 'allowed' | 'reauth_required' | 'refused'

// can()'s answer for a person, with whether only a fresh re-authentication is missing, so the web
// app can ask for the PIN or a passkey and try again.
export function decide(world: World, me: string, request: Request, fresh: boolean): Verdict {
  const subject = { kind: 'human', id: me } as const
  if (can(world, subject, request, { reauthenticated: fresh })) return 'allowed'
  if (!fresh && can(world, subject, request, { reauthenticated: true })) return 'reauth_required'
  return 'refused'
}

// The acting session re-read, then can(). Throws 401 signed_out (clearing the cookie) when the
// acting session has ended, 403 reauth_required when only a fresh re-authentication is missing,
// and otherwise the refusal given: 403 forbidden for an admin action, or 404 not_found for one of
// your own devices or passkeys, so the answer never shows whether someone else's exists.
export async function authorise(
  trx: InOrg,
  session: SessionIds,
  request: Request,
  refusal: 'forbidden' | 'not_found',
  options: ActingOptions = {},
): Promise<World> {
  const { world, verdict } = await consider(trx, session, request, options)
  if (verdict === 'allowed') return world
  throw refusalFor(verdict, refusal)
}

// authorise() without the throw on a refusal, for a service that answers some refusals itself (a
// second deactivation, admin/people.ts). Still throws when the acting session has ended.
export async function consider(
  trx: InOrg,
  session: SessionIds,
  request: Request,
  options: ActingOptions = {},
): Promise<{ world: World; verdict: Verdict; fresh: boolean }> {
  const acting = await actingSession(trx, session, options)
  if (acting === undefined) throw signedOut()
  // Every C0.5 request about devices or passkeys is about the session's own person.
  let world = await loadWorld(trx, session.orgId, { credentialsOf: session.userId })
  let verdict = decide(world, session.userId, request, acting.fresh)
  // The target's row only once can() has allowed the action, so a refused caller never waits on
  // or holds anyone else's row; then can() decides again on what that lock let commit.
  if (verdict === 'allowed' && options.target !== undefined) {
    await sql`select 1 from people where org_id = ${session.orgId} and id = ${options.target}
      for no key update`.execute(trx)
    world = await loadWorld(trx, session.orgId, { credentialsOf: session.userId })
    verdict = decide(world, session.userId, request, acting.fresh)
  }
  return { world, verdict, fresh: acting.fresh }
}

export function refusalFor(verdict: Exclude<Verdict, 'allowed'>, refusal: 'forbidden' | 'not_found'): ApiError {
  if (verdict === 'reauth_required') return new ApiError(403, 'reauth_required')
  return refusal === 'forbidden' ? new ApiError(403, 'forbidden') : new ApiError(404, 'not_found')
}
