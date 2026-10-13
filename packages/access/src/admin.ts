import type { Id, OrgRole, Ref } from './model.ts'
import { OWNER_ONLY_ROLES, TWO_PERSON_ROLES } from './model.ts'
import type { AdminRequest, RequestContext } from './requests.ts'
import type { World } from './world.ts'

// Admin powers are roles held as rows (ACC-10, CLAUDE.md Database). An Owner has every Admin
// power (only an Owner grants Admin, so Owner sits above it; T13). AI Admin grants nothing until
// the AI layer (A0). No role reads content: reading what you couldn't otherwise open happens only
// in the Rule 9 module, against a case, never here.
export function isAdmin(world: World, personId: Id): boolean {
  return world.holds(personId, 'admin') || world.holds(personId, 'owner')
}
export function isOwner(world: World, personId: Id): boolean {
  return world.holds(personId, 'owner')
}

// Who may grant or remove a role, and on whom (CLAUDE.md: only an Owner grants or removes Owner,
// Admin, AI Admin, Leadership, DPO and Compliance Officer; Admins assign Team Admin; nobody
// changes their own roles). Shared by role.grant, role.revoke and every role in a roster row, so
// the console and the CSV import can't drift (CLAUDE.md: "Both console paths run the same
// server-side checks").
function roleAuthority(world: World, actor: Id, role: OrgRole, teamId: Id | null): boolean {
  if (role === 'team_admin') return teamId !== null && world.isLiveTeam(teamId) && isAdmin(world, actor)
  if (teamId !== null) return false
  return OWNER_ONLY_ROLES.includes(role) && isOwner(world, actor)
}

export function adminCan(world: World, actor: Id, request: AdminRequest, context: RequestContext): boolean {
  // Every admin action needs an active person who has just re-authenticated (§9.4).
  if (!world.isActivePerson(actor) || context.reauthenticated !== true) return false
  switch (request.action) {
    case 'role.grant': {
      if (request.person === actor || !world.isActivePerson(request.person)) return false
      if (world.rolesOf(request.person).some(r => r.role === request.role && r.teamId === request.teamId)) return false
      // A DPO or Compliance Officer grant made here is a proposal; the role is held only once a
      // second person approves it (role.approve, PRD-85).
      return roleAuthority(world, actor, request.role, request.teamId)
    }
    case 'role.approve': {
      // The proposal comes from the snapshot, never from the request: its proposer, grantee and
      // role are what the console stored (C0.16).
      const proposal = world.proposal(request.proposalId)
      if (!proposal || proposal.approvedAt !== null || proposal.withdrawnAt !== null) return false
      if (!TWO_PERSON_ROLES.includes(proposal.role) || proposal.proposedBy === proposal.personId) return false
      if (!isOwner(world, proposal.proposedBy) || !world.isActivePerson(proposal.personId)) return false
      if (world.holds(proposal.personId, proposal.role)) return false
      // An Owner or Admin other than the proposer and the grantee (CLAUDE.md, PRD-85).
      return actor !== proposal.proposedBy && actor !== proposal.personId && isAdmin(world, actor)
    }
    case 'role.revoke': {
      if (request.person === actor) return false
      if (!world.rolesOf(request.person).some(r => r.role === request.role && r.teamId === request.teamId)) return false
      return roleAuthority(world, actor, request.role, request.teamId)
    }
    case 'person.add':
      // A new person, so "never self" holds; each role in the row needs the same authority as a
      // grant (an Admin's row can't make an Owner, Admin or DPO), and its manager the same check
      // as a manager change.
      return (
        isAdmin(world, actor) &&
        request.roles.every(r => roleAuthority(world, actor, r.role, r.teamId)) &&
        mayBeManager(world, actor, null, request.manager)
      )
    case 'person.set_manager':
      // Never your own record; the person must still be here.
      if (request.person === actor || !world.isActivePerson(request.person)) return false
      return isAdmin(world, actor) && mayBeManager(world, actor, request.person, request.manager)
    case 'person.deactivate':
    case 'person.reset_pin':
    case 'person.change_phone': {
      // These take over or end an account, which in effect removes its roles, so a holder of an
      // Owner-only role is handled by an Owner only (T13). So is the grantee of an open DPO or
      // Compliance Officer proposal, or an Admin could take over the account and then approve
      // the grant to it, holding Rule 9 access alone. Never yourself.
      if (request.person === actor || !world.isActivePerson(request.person)) return false
      if (!isAdmin(world, actor)) return false
      const ownerOnlyTarget =
        world.rolesOf(request.person).some(r => OWNER_ONLY_ROLES.includes(r.role)) ||
        world.facts.roleProposals.some(
          p => p.personId === request.person && p.approvedAt === null && p.withdrawnAt === null,
        )
      return !ownerOnlyTarget || isOwner(world, actor)
    }
    case 'person.sign_out_devices':
      // Signing out only removes sessions, so an Admin may do it for anyone, the Owner and DPO
      // included (ACC-04: "admins can remotely sign out any user's devices").
      return world.person(request.person) !== undefined && (request.person === actor || isAdmin(world, actor))
    case 'team.create':
      return isAdmin(world, actor)
    case 'team.archive':
      return world.isLiveTeam(request.team) && isAdmin(world, actor)
    case 'team.members.change': {
      // Team membership opens everything shared with the team, so nobody changes their own
      // through an admin power; another Admin or Team Admin does (T13). Nobody joins an archived
      // team, but an Admin can still remove its members, so its grants can be narrowed (an
      // archived team's Team Admins have no powers left).
      if (request.person === actor) return false
      if (request.op === 'add' && !(world.isLiveTeam(request.team) && world.isActivePerson(request.person))) return false
      if (request.op === 'remove' && !world.isTeamMember(request.person, request.team)) return false
      return isAdmin(world, actor) || world.isTeamAdminOf(actor, request.team)
    }
    case 'team.defaults.set': {
      if (!world.isLiveTeam(request.team)) return false
      if (!(isAdmin(world, actor) || world.isTeamAdminOf(actor, request.team))) return false
      return request.spaces.every(space => mayBeTeamDefault(world, actor, request.team, space))
    }
    case 'org.defaults.set':
      // Everyone joins an org default, so only a public channel can be one (ACC-07).
      return isAdmin(world, actor) && request.spaces.every(space => isOpenPublicChannel(world, space))
    case 'audit_readers.change': {
      // D45: Owners and Admins change the list, only an Owner adds or removes Admin, and Team Admin
      // can never be on it. An Admin who isn't an Owner also can't add or remove a role they hold
      // themselves, so no Admin gives themselves the log (T13).
      if (request.role === 'team_admin') return false
      const listed = (world.facts.auditLogReaders as readonly OrgRole[]).includes(request.role)
      if (request.op === 'add' ? listed : !listed) return false
      if (isOwner(world, actor)) return true
      if (!world.holds(actor, 'admin') || request.role === 'admin') return false
      return !world.holds(actor, request.role)
    }
    case 'audit_log.read':
      // Mirrors read_audit_events(): a role on the org's readers list (D45).
      return world
        .rolesOf(actor)
        .some(r => r.role !== 'team_admin' && (world.facts.auditLogReaders as readonly OrgRole[]).includes(r.role))
    case 'room.restrict': {
      // Restricting narrows who sees future sessions: Admins and Compliance Officers (REC-07, ADM-04).
      const room = world.get({ kind: 'room', id: request.room })
      if (!room || room.restricted) return false
      return isAdmin(world, actor) || world.holds(actor, 'compliance_officer')
    }
    case 'room.unrestrict': {
      // Lifting it widens access, so only the DPO or a Compliance Officer (decision 13, C2.3).
      const room = world.get({ kind: 'room', id: request.room })
      if (!room?.restricted) return false
      return world.holds(actor, 'dpo') || world.holds(actor, 'compliance_officer')
    }
    case 'session.reclassify':
      // Changing a past session's class is an audited DPO or Compliance action (decision 13).
      return (
        world.get({ kind: 'session', id: request.session }) !== undefined &&
        (world.holds(actor, 'dpo') || world.holds(actor, 'compliance_officer'))
      )
    case 'recording_policy.set':
    case 'public_creation.set':
      return isAdmin(world, actor)
    case 'channel.transfer_ownership': {
      // ADM-03. The new owner must be an active person and, for a private channel, already a
      // member, so no Admin makes themselves owner of a private channel they can't read.
      const channel = world.get({ kind: 'channel', id: request.channel })
      if (!channel || channel.archivedAt !== null || !world.isActivePerson(request.to)) return false
      if (channel.owners.includes(request.to)) return false
      if (channel.visibility === 'private' && !world.isCurrentMember(request.to, channel.id)) return false
      return isAdmin(world, actor)
    }
    case 'privileged_console.open':
      // Opening the console only: every read through it is a Rule 9 read against a case, in the
      // privileged module (ADM-12, PDPA-13).
      return request.console === 'compliance' ? world.holds(actor, 'compliance_officer') : world.holds(actor, 'dpo')
    default:
      return false
  }
}

function isOpenPublicChannel(world: World, ref: Ref): boolean {
  if (ref.kind !== 'channel') return false
  const channel = world.get({ kind: 'channel', id: ref.id })
  return channel !== undefined && channel.archivedAt === null && channel.visibility === 'public'
}

// A team's default channels and rooms (ACC-07): public ones, or private ones the team owns and the
// person setting them already manages, never a restricted room. So a team default can't pull the
// team into a space none of them could open.
// A person's manager receives their items when they leave (ACC-05), so nobody names themselves
// anyone's manager through an admin power; another Admin or an Owner does (T13). The manager is
// an active person other than the person themselves, or nobody.
function mayBeManager(world: World, actor: Id, person: Id | null, manager: Id | null): boolean {
  if (manager === null) return true
  return manager !== actor && manager !== person && world.isActivePerson(manager)
}

function mayBeTeamDefault(world: World, actor: Id, teamId: Id, ref: Ref): boolean {
  if (ref.kind === 'channel') {
    const channel = world.get({ kind: 'channel', id: ref.id })
    if (!channel || channel.archivedAt !== null) return false
    if (channel.visibility === 'public') return true
    return channel.ownerTeamId === teamId && channel.owners.includes(actor) && world.isCurrentMember(actor, channel.id)
  }
  if (ref.kind === 'room') {
    const room = world.get({ kind: 'room', id: ref.id })
    if (!room || room.archivedAt !== null || room.restricted || room.kind !== 'standalone') return false
    if (room.visibility === 'public') return true
    return room.ownerTeamId === teamId && room.owners.includes(actor) && world.isCurrentMember(actor, room.id)
  }
  return false
}
