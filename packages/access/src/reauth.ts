// Who is privileged and how a session re-authenticates (D46, AQ-01, AQ-02). The server reads the
// raw session facts in the deciding transaction and passes them in; can() still receives only the
// boolean reauthenticated() computes (requests.ts, RequestContext).
import type { ReauthMethod } from '@hearth/shared'
import { type Id, PIN_ROLES } from './model.ts'
import type { World } from './world.ts'

// Raw facts of the acting session.
export interface ReauthFacts {
  stampFresh: boolean // sessions.reauthenticated_at within the re-authentication window
  pinSet: boolean // users.pin_hash is not null
  issuedPrivileged: boolean // the session was issued under the PIN rule
}

// A PIN role held now. rolesOf() already drops revoked rows, leavers and archived teams' Team
// Admins. Not named isPrivileged: R9-02 keeps the word privileged out of this package's exports.
export function holdsPinRole(world: World, person: Id): boolean {
  return world.rolesOf(person).some(r => PIN_ROLES.includes(r.role))
}

// Decided by the session first. A session issued under the PIN rule re-authenticates only with the
// PIN, whatever its holder's roles are now, so no SMS stamp ever lands on it; if its PIN has been
// cleared, only a new sign-in mends it. Any other session uses an SMS code, unless its holder is
// privileged now (a role granted without ending their sessions, which C0.16 must never do): only a
// new sign-in, through the PIN step, mends that.
export function reauthMethodOf(world: World, person: Id, facts: ReauthFacts): ReauthMethod {
  if (facts.issuedPrivileged) return facts.pinSet ? 'pin' : 'sign_in'
  return holdsPinRole(world, person) ? 'sign_in' : 'code'
}

// What can() receives as context.reauthenticated.
export function reauthenticated(world: World, person: Id, facts: ReauthFacts): boolean {
  return facts.stampFresh && reauthMethodOf(world, person, facts) !== 'sign_in'
}
