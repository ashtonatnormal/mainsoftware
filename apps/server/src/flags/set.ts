// POST /api/admin/flags/set (TECH-SPEC T17 item 9): an Owner or Admin turns a feature flag on or
// off, or changes who it is on for. It is the one way a flag changes in production; C0.16's console
// and A0.3's kill switch call it. In one transaction, as the signed-in admin:
//   1. can() decides flag.set (Principle 1), with a re-authentication from the last 5 minutes
//      (§9.4): only an Owner or Admin, and never for an ai.* flag, which A0 decides (ADM-05, ADM-10);
//   2. a key this process doesn't know answers 404, as one the org has no row for does;
//   3. a change that lets the feature reach anyone it doesn't reach now (turning it on, or, while
//      it is on, widening its cohort or giving it to the whole org) answers 409 purpose_refused when
//      the purpose gate refuses any of its own purposes, judged on the registers read in this
//      transaction (C0.9 PD-19, TECH-SPEC T22 item 11; compliance/registers.ts). Turning a flag off,
//      narrowing it, and a change that reaches nobody new are never refused, and no register change
//      is ever refused because a flag is on. A flag's own purposes are the whole check, since no
//      flag outside ai.* has a flag under it (G2, packages/shared catalogues.test.ts);
//   4. set_feature_flag() (migration 0007) re-checks the person and their role FOR SHARE, refuses a
//      locked flag (HF003) and a change that adds anyone outside the org or who has left it (HF004,
//      reading them FOR SHARE; someone already named who has since left stays and matches nothing),
//      bumps the revision
//      and writes the audit event (ADM-06), naming who joined and left the cohort;
//   5. on a real change, flag.changed goes to the outbox in the same transaction (T16).
// After the commit, the change is published on the flags channel, so every process reloads the
// org's flags at once (channel.ts); the 2 s poll covers a lost message.
//
// A flag gates a feature, never an access check or a privacy or safety control (T17 item 10), so
// turning one on opens nothing to anyone: can() still decides every action.
import { COHORT_ROLES, type CohortRole, cohortProblem, FLAG_KEY, FLAG_KEY_MAX } from '@hearth/shared'
import { sql } from 'kysely'
import { z } from 'zod'
import { authorise } from '#src/access/world.ts'
import type { Api } from '#src/api.ts'
import { ApiError } from '#src/auth/errors.ts'
import { inSession, type SessionIds } from '#src/auth/sessions.ts'
import { purposeAllowed, readRegisterState } from '#src/compliance/registers.ts'
import { FLAG_LOCKED, INSUFFICIENT_PRIVILEGE, INVALID_COHORT, INVALID_PARAMETER, sqlstateOf } from '#src/db/sqlstate.ts'
import { publishFlags } from '#src/flags/channel.ts'
import { type Answer, type ReqInfo, Uuid } from '#src/http.ts'
import { appendOutbox } from '#src/outbox/append.ts'

// The codes only this route answers, which its integration suite must see (and the sign-in
// suite's sweep of every code leaves to it).
export const FLAG_ERRORS = ['flag_locked', 'purpose_refused', 'invalid_cohort'] as const

const isCohortRole = (role: string): role is CohortRole => (COHORT_ROLES as readonly string[]).includes(role)

export const SetFlagBody = z
  .strictObject({
    key: z.string().max(FLAG_KEY_MAX).regex(FLAG_KEY),
    enabled: z.boolean(),
    audience: z.enum(['org', 'cohort']).default('org'),
    // Who it is on for when the audience is a cohort: people of the org and holders of org-wide
    // roles (A1; Team Admin comes with team cohorts). The table allows 1,000 entries in all, which
    // the route checks first (A8), answering 400 invalid_cohort for more, for a cohort naming
    // nobody, for names given with the whole org as the audience, and for a role a cohort can't
    // name.
    people: z.array(Uuid).default([]),
    roles: z.array(z.string().max(64)).default([]),
  })
  .transform(body => {
    const roles = body.roles.filter(isCohortRole)
    const problem =
      roles.length === body.roles.length
        ? cohortProblem(body.audience, { people: body.people, roles })
        : 'A cohort names only org-wide roles.'
    return { key: body.key, enabled: body.enabled, audience: body.audience, people: body.people, roles, problem }
  })
export type SetFlagBody = z.output<typeof SetFlagBody>

// A flag's row as the route reads it before the change.
interface FlagRow {
  enabled: boolean
  audience: 'org' | 'cohort'
  cohort_people: string[]
  cohort_roles: string[]
}

// Whether the change lets the feature reach anyone it doesn't reach now (C0.9 PD-19): turning it
// on; or, while it is on, going from a cohort to the whole org, or naming a person or role the
// cohort didn't (the new cohort isn't a subset of the old, entry by entry, so a person newly named
// who already held a named role counts as new). Turning it off, narrowing it, and the same audience
// again reach nobody new. Ids compare as the database stores them: lower case, as Uuid gives them.
export function widens(
  before: FlagRow,
  after: Pick<SetFlagBody, 'enabled' | 'audience' | 'people' | 'roles'>,
): boolean {
  if (!after.enabled) return false
  if (!before.enabled) return true
  if (before.audience === 'org') return false
  if (after.audience === 'org') return true
  const people = new Set(before.cohort_people)
  const roles = new Set<string>(before.cohort_roles)
  return after.people.some(person => !people.has(person)) || after.roles.some(role => !roles.has(role))
}

export async function setFlag(api: Api, body: SetFlagBody, session: SessionIds, info: ReqInfo): Promise<Answer> {
  if (body.problem !== undefined) throw new ApiError(400, 'invalid_cohort')
  const { orgId } = session
  const outcome = await inSession(api, info, session, async trx => {
    await authorise(trx, session, { action: 'flag.set', key: body.key }, 'forbidden')
    const spec = Object.hasOwn(api.flags.registry, body.key) ? api.flags.registry[body.key] : undefined
    if (spec === undefined) throw new ApiError(404, 'not_found')
    // The row as it is: whether the change reaches anyone new, and so a call that changes nothing
    // (set_feature_flag() returns the same revision and writes nothing) appends and publishes
    // nothing either. A change committed between this read and the call at worst adds one
    // flag.changed, which consumers handle by re-reading the flag (A9); one that would make this
    // change reach someone new is caught below.
    const before = await trx
      .selectFrom('feature_flags')
      .select(['id', 'revision', 'enabled', 'audience', 'cohort_people', 'cohort_roles'])
      .where('org_id', '=', orgId)
      .where('key', '=', body.key)
      .executeTakeFirst()
    if (before === undefined) throw new ApiError(404, 'not_found')
    const widening = widens(before, body)
    if (widening) {
      // A plain read of the registers as they are now; hearth_app reads no restrictions.
      const registers = await readRegisterState(trx, orgId, { restrictions: false })
      if (spec.purposes.some(purpose => !purposeAllowed(registers, purpose))) throw new ApiError(409, 'purpose_refused')
    }
    let revision: number
    try {
      const { rows } = await sql<{ revision: string }>`select public.set_feature_flag(${body.key}, ${body.enabled},
          ${body.audience}, ${body.people}::uuid[], ${body.roles}::text[], ${info.requestId}, ${session.deviceId}::uuid,
          ${info.ip}::inet) as revision`.execute(trx)
      revision = Number(rows[0]?.revision)
    } catch (error) {
      throw refusalOf(error) ?? error
    }
    const changed = revision !== Number(before.revision)
    // Another change committed between the read above and set_feature_flag(): a change judged to
    // reach nobody new was judged on a row that has gone (turned off meanwhile, this would turn it
    // back on unchecked), so it rolls back and the admin tries again on the row as it is now.
    if (!widening && changed && revision !== Number(before.revision) + 1) throw new ApiError(409, 'try_again')
    if (changed) {
      await appendOutbox(trx, {
        orgId,
        type: 'flag.changed',
        entity: { type: 'feature_flag', id: before.id },
        subjects: [],
        purpose: 'service_operation',
        ids: { enabled: body.enabled },
      })
    }
    return { revision, changed }
  })
  if (outcome.changed) {
    await publishFlags(
      api.valkey,
      api.keyPrefix,
      { v: 1, org: orgId, key: body.key, revision: outcome.revision, at: Date.now() },
      info.log,
    )
    // This process's own copy needn't wait for the message.
    void api.flags.reload(orgId)
  }
  return { body: { key: body.key, enabled: body.enabled, revision: outcome.revision } }
}

// What set_feature_flag()'s refusals answer. A lock not granted in time (55P03) is the api's
// 409 try_again already (auth/errors.ts fromDatabase).
function refusalOf(error: unknown): ApiError | undefined {
  switch (sqlstateOf(error)) {
    case FLAG_LOCKED:
      return new ApiError(409, 'flag_locked')
    case INVALID_COHORT:
      return new ApiError(400, 'invalid_cohort')
    case INVALID_PARAMETER:
      return new ApiError(404, 'not_found')
    case INSUFFICIENT_PRIVILEGE:
      return new ApiError(403, 'forbidden')
    default:
      return undefined
  }
}
