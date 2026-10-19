// GET /api/flags (TECH-SPEC T17 item 11, T21 item 10): the signed-in person's own value of each
// flag the registry marks client: true, as a plain boolean, so the web shell can show or hide what
// a flag gates (FlagSlot). It answers no cohort, no revision and no ETag (OD-21): whether a flag is
// on for someone else is never the browser's business. The shell asks at boot, every 60 s while a
// tab is visible, and whenever the gateway nudges it about a client flag (T17 item 11, T19 item 10).
//
// - Who is asking: the acting session re-read and can() asked about session.read_own, in a
//   read-only transaction that leaves the session's last use alone (OD-14): the shell polls this
//   by itself, so a touch would keep an idle session alive while a tab stayed open (C-23). The
//   flags' subject is built from the World can() decided on, as the job runner builds one: whether
//   the person is still at the org, and the org-wide roles flags may name in a cohort.
// - With no client flag in the registry (production today, OD-13) the answer is { flags: {} } at
//   once: no wait, no flag read.
// - Otherwise the process's own copy decides (flags/cache.ts verdict()). The answer waits, after
//   the transaction so no transaction waits on the cache, for the org's first read for at most
//   FLAG_READ_WAIT_MS (track() never rejects, R-52). While the org's flags are unconfirmed the answer
//   is 503 unavailable, never a guess, and the client keeps the values it last had (R-53, P6).
import type { World } from '@hearth/access'
import { COHORT_ROLES, type FlagSpec, type FlagsJSON } from '@hearth/shared'
import { authorise } from '#src/access/world.ts'
import type { Api } from '#src/api.ts'
import { ApiError } from '#src/auth/errors.ts'
import { inSession, type SessionIds } from '#src/auth/sessions.ts'
import { FLAG_READ_WAIT_MS, type FlagVerdict } from '#src/flags/cache.ts'
import type { FlagSubject } from '#src/flags/evaluate.ts'
import type { Answer, ReqInfo } from '#src/http.ts'

const isCohortRole = (role: string): boolean => (COHORT_ROLES as readonly string[]).includes(role)

// The keys the browser may see (client: true), sorted, so every answer lists them in one order.
export function clientFlagKeys(registry: Readonly<Record<string, FlagSpec>>): string[] {
  return Object.entries(registry)
    .filter(([, spec]) => spec.client === true)
    .map(([key]) => key)
    .sort()
}

// Who the flags are evaluated for, from the World the request's can() decided on: whether the
// person is still at the org, and the org-wide roles they hold now that a cohort may name
// (COHORT_ROLES; team_admin isn't one), none once they've left. The same subject the job runner
// reads from role_assignments for a job's person (jobs/runner.ts), so a cohort decides alike in
// both (T17 item 3).
export function flagSubjectOf(world: World, personId: string): FlagSubject {
  const roles = world
    .rolesOf(personId)
    .map(fact => fact.role)
    .filter(isCohortRole)
  return { personId, active: world.isActivePerson(personId), roles: [...new Set(roles)].sort() }
}

// Each key's value: on is true; off and not_in_cohort are false, alike, so the answer never says
// which. A key whose verdict is unconfirmed makes the whole answer unconfirmed: a partial answer
// could switch off something the client last saw on.
export function clientFlagValues(
  keys: readonly string[],
  verdictOf: (key: string) => FlagVerdict,
): FlagsJSON | 'unconfirmed' {
  const flags: Record<string, boolean> = {}
  for (const key of keys) {
    const verdict = verdictOf(key)
    if (verdict === 'unconfirmed') return 'unconfirmed'
    flags[key] = verdict === 'on'
  }
  return { flags }
}

// Resolves when `promise` does or after `ms`, whichever is first; the timer is cleared once the
// promise settles, and never holds the process open.
export function waitAtMost(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    promise.then(done, done)
  })
}

// The answer for a session already looked up (web/routes.ts). `wait` is waitAtMost unless a test
// gives its own.
export async function readFlags(
  api: Api,
  session: SessionIds,
  info: ReqInfo,
  wait: (promise: Promise<void>, ms: number) => Promise<void> = waitAtMost,
): Promise<Answer> {
  const subject = await inSession(
    api,
    info,
    session,
    async trx =>
      flagSubjectOf(
        await authorise(trx, session, { action: 'session.read_own' }, 'not_found', { lock: false }),
        session.userId,
      ),
    { touch: false, readOnly: true },
  )
  const keys = clientFlagKeys(api.flags.registry)
  if (keys.length === 0) return { body: { flags: {} } satisfies FlagsJSON }
  await wait(api.flags.track(session.orgId), FLAG_READ_WAIT_MS)
  const answer = clientFlagValues(keys, key => api.flags.verdict(session.orgId, key, subject))
  if (answer === 'unconfirmed') throw new ApiError(503, 'unavailable')
  return { body: answer }
}
