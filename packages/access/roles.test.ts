// The per-role matrix for admin actions (CLAUDE.md Database: "The full per-role matrix (Member,
// Team Admin, Admin, Owner, AI Admin, Leadership, DPO, Compliance Officer, including the roles that
// must be refused) lives in packages/access's tests"; ACC-10; BUILD-PLAN C0.4). Every admin request
// in src/requests.ts, the create request and every request about your own session, devices and
// passkeys is decided by can() for every actor below, after a fresh re-authentication, and each row
// writes out exactly who it allows: every other actor must be refused. After the matrix come the
// dimensions one row can't show: re-authentication, the two-person rule, changing your own roles,
// ended roles, roles with no admin power yet, a run of every admin action an Admin may take, which
// never opens #leadership, and (from C0.8) the PIN roles and the re-authentication method each
// session uses (D46).
//
// The actors are the fixture org (src/testing) plus one persona per role holding exactly that role,
// so each role's powers show on their own, and the seed's combined holders, which show that roles
// add up.
//
//   npx vitest run packages/access/roles.test.ts --reporter=verbose
import { describe, expect, test } from 'vitest'
import {
  type AdminRequest,
  type AuditReaderRole,
  can,
  canRead,
  type Facts,
  holdsPinRole,
  type Id,
  listAccessible,
  type OrgRole,
  OWNER_ONLY_ROLES,
  PIN_ROLES,
  type ReauthFacts,
  type Ref,
  type Request,
  type ResourceKind,
  type RoleProposalFact,
  reauthenticated,
  reauthMethodOf,
  type SelfRequest,
  type Subject,
  type Topic,
  type TopicRequest,
  World,
} from './src/index.ts'
import { ADMIN_ACTIONS as ROUTED_ADMIN_ACTIONS, SELF_ACTIONS, TOPIC_ACTIONS } from './src/requests.ts'
import {
  AG,
  AS,
  agent,
  assistant,
  C,
  DEV,
  fixtureFacts,
  HEARTH,
  human,
  M,
  ORG_2,
  ORG_2_PEOPLE,
  otherOrgFacts,
  P,
  PK,
  PROPOSAL,
  R,
  ref,
  S,
  system,
  T,
  TK,
} from './src/testing/index.ts'

const REAUTH = { reauthenticated: true } as const

// One persona per role (fixture-only ids), each holding exactly that role.
const persona = (n: string): Id => `b0000000-0000-4000-8000-0000000000${n}`
const ONE = {
  owner: persona('a1'),
  admin: persona('a2'),
  aiAdmin: persona('a3'),
  leadership: persona('a4'),
  dpo: persona('a5'),
  compliance: persona('a6'),
  teamAdmin: persona('a7'), // Team Admin of Operations, and in the team
  member: persona('a8'), // no role
} as const

// Spaces and ids the matrix adds to the fixture.
const X = {
  opsLeads: 'ch-ops-leads', // private, owned by Operations; the Team Admin persona owns it, Marcus is in it
  oldNews: 'ch-old-news', // public, archived
  opsHuddle: 'rm-ops-huddle', // standalone, private, owned by Operations; the Team Admin persona owns it
  opsReview: 'rm-ops-review', // the same, but restricted (REC-07)
  unknownTeam: 'd0000000-0000-4000-8000-0000000000ff',
  unknownPerson: 'b0000000-0000-4000-8000-0000000000ff',
} as const

// DPO and Compliance Officer grants waiting for their second approver (PRD-85). PROPOSAL.priyaDpo
// (Priya as DPO, proposed by Ashton) is the fixture's own.
const PR = {
  nadiaCo: 'pr-nadia-co', // Nadia as Compliance Officer, proposed by the Owner persona
  adminDpo: 'pr-admin-dpo', // the Admin persona as DPO, proposed by Ashton
  forged: 'pr-forged', // "proposed" by the Admin persona, who isn't an Owner
  withdrawn: 'pr-withdrawn',
  approved: 'pr-approved',
  held: 'pr-weiling-co', // Wei Ling already holds the role
  leaver: 'pr-former-dpo-co', // for someone who has left
  missing: 'pr-missing', // not in the snapshot
} as const

function proposal(
  id: Id,
  personId: Id,
  role: 'dpo' | 'compliance_officer',
  proposedBy: Id,
  ended: { approvedAt?: number; withdrawnAt?: number } = {},
): RoleProposalFact {
  return { id, personId, role, proposedBy, approvedAt: null, withdrawnAt: null, ...ended }
}

const roleRow = (personId: Id, role: OrgRole, teamId: Id | null = null) => ({ personId, role, teamId, revokedAt: null })
const memberRow = (spaceId: Id, principalId: Id) => ({
  id: `mb:${spaceId}:${principalId}`,
  spaceId,
  principalId,
  afterSeq: 0,
  throughSeq: null,
})

// The fixture plus the personas, the matrix's spaces and the proposals above.
function matrixFacts(): Facts {
  const f = fixtureFacts()
  return {
    ...f,
    people: [...f.people, ...Object.values(ONE).map(id => ({ id, deactivatedAt: null }))],
    roles: [
      ...f.roles,
      roleRow(ONE.owner, 'owner'),
      roleRow(ONE.admin, 'admin'),
      roleRow(ONE.aiAdmin, 'ai_admin'),
      roleRow(ONE.leadership, 'leadership'),
      roleRow(ONE.dpo, 'dpo'),
      roleRow(ONE.compliance, 'compliance_officer'),
      roleRow(ONE.teamAdmin, 'team_admin', T.operations),
    ],
    roleProposals: [
      ...f.roleProposals,
      proposal(PR.nadiaCo, P.nadia, 'compliance_officer', ONE.owner),
      proposal(PR.adminDpo, ONE.admin, 'dpo', P.ashton),
      proposal(PR.forged, P.nadia, 'dpo', ONE.admin),
      proposal(PR.withdrawn, P.nadia, 'dpo', P.ashton, { withdrawnAt: 1 }),
      proposal(PR.approved, P.rachel, 'compliance_officer', P.ashton, { approvedAt: 1 }),
      proposal(PR.held, P.weiling, 'compliance_officer', P.ashton),
      proposal(PR.leaver, P.formerDpo, 'compliance_officer', P.ashton),
    ],
    teamMembers: [...f.teamMembers, { teamId: T.operations, personId: ONE.teamAdmin, removedAt: null }],
    channels: [
      ...f.channels,
      { id: X.opsLeads, visibility: 'private', ownerTeamId: T.operations, owners: [ONE.teamAdmin], archivedAt: null },
      { id: X.oldNews, visibility: 'public', ownerTeamId: null, owners: [P.huimin], archivedAt: 1 },
    ],
    rooms: [
      ...f.rooms,
      {
        id: X.opsHuddle,
        kind: 'standalone',
        visibility: 'private',
        restricted: false,
        ownerTeamId: T.operations,
        owners: [ONE.teamAdmin],
        archivedAt: null,
      },
      {
        id: X.opsReview,
        kind: 'standalone',
        visibility: 'private',
        restricted: true,
        ownerTeamId: T.operations,
        owners: [ONE.teamAdmin],
        archivedAt: null,
      },
    ],
    memberships: [
      ...f.memberships,
      memberRow(X.opsLeads, ONE.teamAdmin),
      memberRow(X.opsLeads, P.marcus),
      memberRow(X.opsHuddle, ONE.teamAdmin),
      memberRow(X.opsReview, ONE.teamAdmin),
    ],
  }
}

function matrixWorld(change?: (facts: Facts) => Facts): World {
  const facts = matrixFacts()
  return new World(change ? change(facts) : facts)
}
const W = matrixWorld()
// The fixture's audit-log readers list is empty (D45: nobody until chosen); these set one.
const withReaders = (readers: readonly AuditReaderRole[]) => matrixWorld(f => ({ ...f, auditLogReaders: readers }))

const ACTORS = [
  { key: 'owner', label: 'an Owner', subject: human(ONE.owner) },
  { key: 'admin', label: 'an Admin', subject: human(ONE.admin) },
  { key: 'aiAdmin', label: 'an AI Admin', subject: human(ONE.aiAdmin) },
  { key: 'leadership', label: 'a Leadership holder', subject: human(ONE.leadership) },
  { key: 'dpo', label: 'a DPO', subject: human(ONE.dpo) },
  { key: 'compliance', label: 'a Compliance Officer', subject: human(ONE.compliance) },
  { key: 'teamAdmin', label: 'the Team Admin of Operations', subject: human(ONE.teamAdmin) },
  { key: 'member', label: 'a Member', subject: human(ONE.member) },
  { key: 'ashton', label: 'Ashton (Owner and DPO)', subject: human(P.ashton) },
  { key: 'arjun', label: 'Arjun (Admin and AI Admin)', subject: human(P.arjun) },
  { key: 'weiling', label: 'Wei Ling (Leadership and Compliance Officer)', subject: human(P.weiling) },
  { key: 'marcus', label: 'Marcus (the seed’s Team Admin of Operations)', subject: human(P.marcus) },
  { key: 'huimin', label: 'Hui Min (Team Admin of People, another team)', subject: human(P.huimin) },
  { key: 'formerDpo', label: 'a DPO who has left', subject: human(P.formerDpo) },
  { key: 'formerAdmin', label: 'an Admin whose role was revoked', subject: human(P.formerAdmin) },
  { key: 'farah', label: 'Farah (Team Admin of the archived Night shift)', subject: human(P.farah) },
  { key: 'assistant', label: 'Ashton’s assistant', subject: assistant(AS.ashton) },
  { key: 'agent', label: 'the IT helpdesk agent', subject: agent(AG.it) },
  { key: 'system', label: 'the system principal', subject: system },
  { key: 'otherOrgOwner', label: 'another org’s Owner', subject: human(ORG_2_PEOPLE.owner) },
] as const satisfies readonly { key: string; label: string; subject: Subject }[]
type ActorKey = (typeof ACTORS)[number]['key']

const SUBJECTS = new Map<ActorKey, Subject>(ACTORS.map(a => [a.key, a.subject]))
function subjectOf(key: ActorKey): Subject {
  const subject = SUBJECTS.get(key)
  if (!subject) throw new Error(`No actor ${key}`)
  return subject
}

// Who each row allows, in actor order, so a failure shows the whole difference at once.
function allowedIn(world: World, request: Request): ActorKey[] {
  return ACTORS.filter(a => can(world, a.subject, request, REAUTH)).map(a => a.key)
}
function inOrder(keys: readonly ActorKey[]): ActorKey[] {
  return ACTORS.map(a => a.key).filter(key => keys.includes(key))
}
const plus = (...sets: (readonly ActorKey[])[]): ActorKey[] => [...new Set(sets.flat())]
const but = (keys: readonly ActorKey[], ...out: ActorKey[]): ActorKey[] => keys.filter(k => !out.includes(k))

const NOBODY: readonly ActorKey[] = []
const OWNERS: readonly ActorKey[] = ['owner', 'ashton']
// An Owner has every Admin power (T13; only an Owner grants Admin).
const ADMINS: readonly ActorKey[] = ['owner', 'admin', 'ashton', 'arjun']
const DPOS: readonly ActorKey[] = ['dpo', 'ashton']
const COMPLIANCE: readonly ActorKey[] = ['compliance', 'weiling']
const OPS_TEAM_ADMINS: readonly ActorKey[] = ['teamAdmin', 'marcus']
// Everyone on this org's roster who hasn't left.
const ACTIVE_PEOPLE: readonly ActorKey[] = [
  'owner',
  'admin',
  'aiAdmin',
  'leadership',
  'dpo',
  'compliance',
  'teamAdmin',
  'member',
  'ashton',
  'arjun',
  'weiling',
  'marcus',
  'huimin',
  'formerAdmin',
  'farah',
]

const grant = (person: Id, role: OrgRole, teamId: Id | null = null): AdminRequest => ({
  action: 'role.grant',
  person,
  role,
  teamId,
})
const revoke = (person: Id, role: OrgRole, teamId: Id | null = null): AdminRequest => ({
  action: 'role.revoke',
  person,
  role,
  teamId,
})
const approve = (proposalId: Id): AdminRequest => ({ action: 'role.approve', proposalId })
const addPerson = (...roles: { role: OrgRole; teamId: Id | null }[]): AdminRequest => ({
  action: 'person.add',
  roles,
  manager: null,
})
const addManaged = (manager: Id): AdminRequest => ({ action: 'person.add', roles: [], manager })
const setManager = (person: Id, manager: Id | null): AdminRequest => ({ action: 'person.set_manager', person, manager })
const teamChange = (team: Id, person: Id, op: 'add' | 'remove'): AdminRequest => ({
  action: 'team.members.change',
  team,
  person,
  op,
})
const teamDefaults = (team: Id, ...spaces: Ref[]): AdminRequest => ({ action: 'team.defaults.set', team, spaces })
const orgDefaults = (...spaces: Ref[]): AdminRequest => ({ action: 'org.defaults.set', spaces })
const readers = (op: 'add' | 'remove', role: OrgRole): AdminRequest => ({ action: 'audit_readers.change', role, op })
const transfer = (channel: Id, to: Id): AdminRequest => ({ action: 'channel.transfer_ownership', channel, to })

const OWNER_ONLY: readonly OrgRole[] = ['owner', 'admin', 'ai_admin', 'leadership', 'dpo', 'compliance_officer']

interface Row {
  name: string
  request: Request
  allowed: readonly ActorKey[]
  // The matrix world unless a row needs another (an audit-log readers list, an org setting).
  world?: World
}
interface Section {
  ids: string
  title: string
  rows: readonly Row[]
}

// Deactivating, resetting the PIN and changing the phone take over or end an account, so a holder
// of an Owner-only role, or the grantee of an open DPO or Compliance Officer proposal, is handled by
// an Owner only (T13 item 5); never yourself.
const ACCOUNT_TARGETS: readonly { who: string; person: Id; allowed: readonly ActorKey[] }[] = [
  { who: 'someone with no role: an Admin or Owner', person: P.kelvin, allowed: ADMINS },
  {
    who: 'the grantee of an open Compliance Officer proposal who holds no role: an Owner only',
    person: P.nadia,
    allowed: OWNERS,
  },
  { who: 'a Team Admin (not an Owner-only role): an Admin or Owner', person: P.marcus, allowed: ADMINS },
  { who: 'a Leadership holder: an Owner only', person: P.priya, allowed: OWNERS },
  { who: 'the Admin: an Owner only, never Arjun', person: P.arjun, allowed: OWNERS },
  { who: 'a Compliance Officer: an Owner only', person: P.weiling, allowed: OWNERS },
  { who: 'the Owner and DPO: another Owner only, never Ashton', person: P.ashton, allowed: ['owner'] },
  { who: 'another Owner: Ashton only', person: ONE.owner, allowed: ['ashton'] },
  { who: 'someone whose Admin role was revoked: an Admin or Owner', person: P.formerAdmin, allowed: ADMINS },
  { who: 'the Team Admin of an archived team: an Admin or Owner', person: P.farah, allowed: ADMINS },
  { who: 'someone who has already left: nobody', person: P.formerDpo, allowed: NOBODY },
  { who: 'someone not on the roster: nobody', person: X.unknownPerson, allowed: NOBODY },
]

const SECTIONS: readonly Section[] = [
  {
    ids: 'ADM-02 ACC-10 CLAUDE.md Database',
    title: 'role.grant',
    rows: [
      ...OWNER_ONLY.map(role => ({
        name: `only an Owner grants ${role}${role === 'dpo' || role === 'compliance_officer' ? ', as a proposal a second person approves (PRD-85)' : ''}`,
        request: grant(P.nadia, role),
        allowed: OWNERS,
      })),
      { name: 'an Owner grants Admin to the DPO', request: grant(ONE.dpo, 'admin'), allowed: OWNERS },
      {
        name: 'an Admin or Owner grants Team Admin of a live team; a Team Admin can’t',
        request: grant(P.nadia, 'team_admin', T.operations),
        allowed: ADMINS,
      },
      {
        name: 'Team Admin is per team: being Team Admin of Operations is no bar to People',
        request: grant(P.marcus, 'team_admin', T.people),
        allowed: ADMINS,
      },
      {
        name: 'T13: nobody grants Team Admin of an archived team',
        request: grant(P.nadia, 'team_admin', T.nightShift),
        allowed: NOBODY,
      },
      {
        name: 'T13: nor to someone whose old row for the archived team is still there',
        request: grant(P.farah, 'team_admin', T.nightShift),
        allowed: NOBODY,
      },
      {
        name: 'nobody grants Team Admin of a team that isn’t in the org',
        request: grant(P.nadia, 'team_admin', X.unknownTeam),
        allowed: NOBODY,
      },
      { name: 'Team Admin always names its team', request: grant(P.nadia, 'team_admin', null), allowed: NOBODY },
      {
        name: 'an org-wide role never names a team',
        request: grant(P.nadia, 'leadership', T.operations),
        allowed: NOBODY,
      },
      { name: 'nobody grants a role the person already holds', request: grant(P.priya, 'leadership'), allowed: NOBODY },
      {
        name: 'nobody grants a Team Admin role the person already holds',
        request: grant(P.marcus, 'team_admin', T.operations),
        allowed: NOBODY,
      },
      {
        name: 'ACC-05: nobody grants a role to someone who has left',
        request: grant(P.formerDpo, 'leadership'),
        allowed: NOBODY,
      },
      {
        name: 'ACC-11: nobody grants a role to someone in another org',
        request: grant(ORG_2_PEOPLE.owner, 'leadership'),
        allowed: NOBODY,
      },
      {
        name: 'nobody grants a role to someone not on the roster',
        request: grant(X.unknownPerson, 'admin'),
        allowed: NOBODY,
      },
    ],
  },
  {
    ids: 'PRD-85 ADM-02 CLAUDE.md Database',
    title: 'role.approve',
    rows: [
      {
        name: 'an Owner or Admin other than the proposing Owner and the grantee approves (Ashton proposed Priya)',
        request: approve(PROPOSAL.priyaDpo),
        allowed: ['owner', 'admin', 'arjun'],
      },
      {
        name: 'the proposing Owner never approves their own proposal',
        request: approve(PR.nadiaCo),
        allowed: ['admin', 'ashton', 'arjun'],
      },
      {
        name: 'the grantee never approves their own grant, though they are an Admin',
        request: approve(PR.adminDpo),
        allowed: ['owner', 'arjun'],
      },
      { name: 'a proposal not made by an Owner is never approved', request: approve(PR.forged), allowed: NOBODY },
      { name: 'a withdrawn proposal is never approved', request: approve(PR.withdrawn), allowed: NOBODY },
      { name: 'an approved proposal isn’t approved twice', request: approve(PR.approved), allowed: NOBODY },
      {
        name: 'a proposal for a role the grantee already holds is refused',
        request: approve(PR.held),
        allowed: NOBODY,
      },
      { name: 'ACC-05: a proposal for someone who has left is refused', request: approve(PR.leaver), allowed: NOBODY },
      { name: 'a proposal not in the snapshot is refused', request: approve(PR.missing), allowed: NOBODY },
    ],
  },
  {
    ids: 'ADM-02 ACC-10 CLAUDE.md Database',
    title: 'role.revoke',
    rows: [
      { name: 'only an Owner removes Leadership', request: revoke(P.priya, 'leadership'), allowed: OWNERS },
      {
        name: 'only an Owner removes Admin, and Arjun never removes their own',
        request: revoke(P.arjun, 'admin'),
        allowed: OWNERS,
      },
      { name: 'only an Owner removes AI Admin', request: revoke(P.arjun, 'ai_admin'), allowed: OWNERS },
      { name: 'only another Owner removes Owner', request: revoke(P.ashton, 'owner'), allowed: ['owner'] },
      { name: 'only another Owner removes Ashton’s DPO role', request: revoke(P.ashton, 'dpo'), allowed: ['owner'] },
      { name: 'Ashton removes Owner from the other Owner', request: revoke(ONE.owner, 'owner'), allowed: ['ashton'] },
      {
        name: 'only an Owner removes Compliance Officer',
        request: revoke(P.weiling, 'compliance_officer'),
        allowed: OWNERS,
      },
      {
        name: 'an Admin or Owner removes Team Admin; a fellow Team Admin can’t',
        request: revoke(P.marcus, 'team_admin', T.operations),
        allowed: ADMINS,
      },
      {
        name: 'removing Team Admin names the team it is held for',
        request: revoke(P.marcus, 'team_admin', T.people),
        allowed: NOBODY,
      },
      {
        name: 'T13: a Team Admin row for an archived team isn’t held, so there is nothing to remove',
        request: revoke(P.farah, 'team_admin', T.nightShift),
        allowed: NOBODY,
      },
      {
        name: 'nobody removes a role the person doesn’t hold',
        request: revoke(P.nadia, 'leadership'),
        allowed: NOBODY,
      },
      { name: 'a revoked role is already gone', request: revoke(P.formerAdmin, 'admin'), allowed: NOBODY },
      {
        name: 'ACC-05: someone who has left holds no role to remove; their row stays for the record',
        request: revoke(P.formerDpo, 'dpo'),
        allowed: NOBODY,
      },
    ],
  },
  {
    ids: 'ACC-03 ADM-02 CLAUDE.md Database',
    title: 'person.add (a roster add or one CSV row; its roles are decided as grants)',
    rows: [
      { name: 'an Admin or Owner adds someone with no role', request: addPerson(), allowed: ADMINS },
      ...OWNER_ONLY.map(role =>
        role === 'dpo' || role === 'compliance_officer'
          ? {
              name: `PRD-85: no row carries ${role}; it is granted once the person exists, as a proposal a second person approves`,
              request: addPerson({ role, teamId: null }),
              allowed: NOBODY,
            }
          : {
              name: `a row with ${role} needs an Owner, as the grant would`,
              request: addPerson({ role, teamId: null }),
              allowed: OWNERS,
            },
      ),
      {
        name: 'an Admin’s row with Team Admin of a live team is allowed',
        request: addPerson({ role: 'team_admin', teamId: T.operations }),
        allowed: ADMINS,
      },
      {
        name: 'T13: a row with Team Admin of an archived team is refused',
        request: addPerson({ role: 'team_admin', teamId: T.nightShift }),
        allowed: NOBODY,
      },
      {
        name: 'a row with Team Admin and no team is refused',
        request: addPerson({ role: 'team_admin', teamId: null }),
        allowed: NOBODY,
      },
      {
        name: 'a row with an org-wide role tied to a team is refused',
        request: addPerson({ role: 'leadership', teamId: T.operations }),
        allowed: NOBODY,
      },
      {
        name: 'one Owner-only role in a row makes the whole row need an Owner',
        request: addPerson({ role: 'team_admin', teamId: T.operations }, { role: 'leadership', teamId: null }),
        allowed: OWNERS,
      },
      {
        name: 'PRD-85: a DPO in a row refuses the whole row, whoever imports it',
        request: addPerson({ role: 'team_admin', teamId: T.operations }, { role: 'dpo', teamId: null }),
        allowed: NOBODY,
      },
      {
        name: 'ACC-03: a row may name an active manager other than whoever adds it',
        request: addManaged(P.marcus),
        allowed: but(ADMINS, 'marcus'),
      },
      {
        name: 'T13: nobody names themselves the new person’s manager (ACC-05 would hand them their items)',
        request: addManaged(ONE.admin),
        allowed: but(ADMINS, 'admin'),
      },
      {
        name: 'a row naming someone who has left as manager is refused',
        request: addManaged(P.formerDpo),
        allowed: NOBODY,
      },
    ],
  },
  {
    ids: 'ACC-03 ACC-05 ADM-02 T13',
    title: 'person.set_manager (a leaver’s items go to their manager, so never yourself)',
    rows: [
      { name: 'an Admin or Owner sets someone’s manager', request: setManager(P.kelvin, P.marcus), allowed: ADMINS },
      { name: 'an Admin or Owner clears it', request: setManager(P.kelvin, null), allowed: ADMINS },
      {
        name: 'T13: nobody names themselves someone’s manager; another Admin or an Owner does',
        request: setManager(P.kelvin, ONE.admin),
        allowed: but(ADMINS, 'admin'),
      },
      {
        name: 'T13: nor an Owner themselves',
        request: setManager(P.kelvin, P.ashton),
        allowed: but(ADMINS, 'ashton'),
      },
      { name: 'nobody is their own manager', request: setManager(P.kelvin, P.kelvin), allowed: NOBODY },
      {
        name: 'nobody changes their own manager through an admin power',
        request: setManager(ONE.admin, P.marcus),
        allowed: but(ADMINS, 'admin'),
      },
      { name: 'nobody manages someone who has left', request: setManager(P.formerDpo, P.marcus), allowed: NOBODY },
      { name: 'nobody who has left is anyone’s manager', request: setManager(P.kelvin, P.formerDpo), allowed: NOBODY },
      {
        name: 'nobody sets the manager of someone not on the roster',
        request: setManager(X.unknownPerson, P.marcus),
        allowed: NOBODY,
      },
    ],
  },
  ...(['person.deactivate', 'person.reset_pin', 'person.change_phone'] as const).map(action => ({
    ids: 'ADM-02 ACC-05 ACC-06 T13',
    title: action,
    rows: ACCOUNT_TARGETS.map(t => ({
      name: `${action} of ${t.who}`,
      request: { action, person: t.person },
      allowed: t.allowed,
    })),
  })),
  {
    ids: 'ACC-04 ACC-06 ADM-02',
    title: 'person.sign_out_devices (it only removes sessions, so any Admin, for anyone)',
    rows: [
      {
        name: 'an Admin or Owner signs out someone with no role',
        request: { action: 'person.sign_out_devices', person: P.nadia },
        allowed: ADMINS,
      },
      {
        name: 'an Admin signs out the Owner and DPO after a lost phone, and Ashton may sign out their own',
        request: { action: 'person.sign_out_devices', person: P.ashton },
        allowed: ADMINS,
      },
      {
        name: 'an Admin signs out a Compliance Officer, and Wei Ling may sign out their own',
        request: { action: 'person.sign_out_devices', person: P.weiling },
        allowed: plus(ADMINS, ['weiling']),
      },
      {
        name: 'an Admin signs out another Admin',
        request: { action: 'person.sign_out_devices', person: ONE.admin },
        allowed: ADMINS,
      },
      {
        name: 'ACC-05: an Admin may sign out someone who has left, which removes nothing more',
        request: { action: 'person.sign_out_devices', person: P.formerDpo },
        allowed: ADMINS,
      },
      {
        name: 'nobody signs out someone not on the roster',
        request: { action: 'person.sign_out_devices', person: X.unknownPerson },
        allowed: NOBODY,
      },
      {
        name: 'ACC-11: nobody here signs out someone in another org',
        request: { action: 'person.sign_out_devices', person: ORG_2_PEOPLE.owner },
        allowed: NOBODY,
      },
    ],
  },
  {
    ids: 'ACC-04 ADM-02',
    title: 'person.list_devices (labels and dates only, so any Admin, for anyone)',
    rows: [
      {
        name: 'an Admin or Owner lists the devices of someone with no role',
        request: { action: 'person.list_devices', person: P.nadia },
        allowed: ADMINS,
      },
      {
        name: 'an Admin lists the Owner and DPO’s devices, and Ashton may list their own',
        request: { action: 'person.list_devices', person: P.ashton },
        allowed: ADMINS,
      },
      {
        name: 'an Admin lists a Compliance Officer’s devices, and Wei Ling may list their own',
        request: { action: 'person.list_devices', person: P.weiling },
        allowed: plus(ADMINS, ['weiling']),
      },
      {
        name: 'an Admin lists another Admin’s devices',
        request: { action: 'person.list_devices', person: ONE.admin },
        allowed: ADMINS,
      },
      {
        name: 'ACC-05: an Admin may list the devices of someone who has left, to sign them out',
        request: { action: 'person.list_devices', person: P.formerDpo },
        allowed: ADMINS,
      },
      {
        name: 'nobody lists the devices of someone not on the roster',
        request: { action: 'person.list_devices', person: X.unknownPerson },
        allowed: NOBODY,
      },
      {
        name: 'ACC-11: nobody here lists the devices of someone in another org',
        request: { action: 'person.list_devices', person: ORG_2_PEOPLE.owner },
        allowed: NOBODY,
      },
    ],
  },
  {
    ids: 'ADM-03',
    title: 'team.create and team.archive',
    rows: [
      { name: 'an Admin or Owner creates a team', request: { action: 'team.create' }, allowed: ADMINS },
      {
        name: 'an Admin or Owner archives a live team; its Team Admin can’t',
        request: { action: 'team.archive', team: T.operations },
        allowed: ADMINS,
      },
      {
        name: 'an archived team isn’t archived again',
        request: { action: 'team.archive', team: T.nightShift },
        allowed: NOBODY,
      },
      {
        name: 'a team not in the org isn’t archived',
        request: { action: 'team.archive', team: X.unknownTeam },
        allowed: NOBODY,
      },
    ],
  },
  {
    ids: 'ACC-07 ADM-03 T13',
    title: 'team.members.change (an Admin, or that team’s live Team Admin; never your own)',
    rows: [
      {
        name: 'an Admin or Operations’ Team Admins add someone to Operations; another team’s Team Admin can’t',
        request: teamChange(T.operations, P.nadia, 'add'),
        allowed: plus(ADMINS, OPS_TEAM_ADMINS),
      },
      {
        name: 'the same people remove a member of Operations',
        request: teamChange(T.operations, P.kelvin, 'remove'),
        allowed: plus(ADMINS, OPS_TEAM_ADMINS),
      },
      {
        name: 'Hui Min changes People, their own team',
        request: teamChange(T.people, P.nadia, 'add'),
        allowed: plus(ADMINS, ['huimin']),
      },
      {
        name: 'a Team Admin never removes themselves; another Team Admin or an Admin does',
        request: teamChange(T.operations, ONE.teamAdmin, 'remove'),
        allowed: plus(ADMINS, ['marcus']),
      },
      {
        name: 'Arjun never adds themselves to Finance; another Admin or the Owner does',
        request: teamChange(T.finance, P.arjun, 'add'),
        allowed: ['owner', 'admin', 'ashton'],
      },
      {
        name: 'an Admin never adds themselves to Finance; Arjun or an Owner does',
        request: teamChange(T.finance, ONE.admin, 'add'),
        allowed: ['owner', 'ashton', 'arjun'],
      },
      {
        name: 'nobody removes someone who isn’t in the team',
        request: teamChange(T.operations, P.nadia, 'remove'),
        allowed: NOBODY,
      },
      {
        name: 'ACC-05: nobody adds someone who has left',
        request: teamChange(T.operations, P.formerDpo, 'add'),
        allowed: NOBODY,
      },
      {
        name: 'T13: nobody adds anyone to an archived team, its former Team Admin included',
        request: teamChange(T.nightShift, P.nadia, 'add'),
        allowed: NOBODY,
      },
      {
        name: 'T13: an Admin or Owner removes someone from an archived team, so its grants stop reaching them',
        request: teamChange(T.nightShift, P.kelvin, 'remove'),
        allowed: ADMINS,
      },
      {
        name: 'T13: an archived team’s former Team Admin is removed by an Admin, never by themselves',
        request: teamChange(T.nightShift, P.farah, 'remove'),
        allowed: ADMINS,
      },
      {
        name: 'nobody changes a team not in the org',
        request: teamChange(X.unknownTeam, P.nadia, 'add'),
        allowed: NOBODY,
      },
    ],
  },
  {
    ids: 'ACC-07 T13',
    title: 'team.defaults.set (public spaces; a private one only if the team owns it and the setter owns and is in it)',
    rows: [
      {
        name: 'an Admin or Operations’ Team Admins make a public channel a default',
        request: teamDefaults(T.operations, ref.channel(C.general)),
        allowed: plus(ADMINS, OPS_TEAM_ADMINS),
      },
      {
        name: 'the same people clear the defaults',
        request: teamDefaults(T.operations),
        allowed: plus(ADMINS, OPS_TEAM_ADMINS),
      },
      {
        name: 'a public standalone room can be a default',
        request: teamDefaults(T.operations, ref.room(R.lounge)),
        allowed: plus(ADMINS, OPS_TEAM_ADMINS),
      },
      {
        name: 'Operations’ private channel only by the Team Admin who owns it and is in it, not Marcus (in it, not an owner) or an Admin',
        request: teamDefaults(T.operations, ref.channel(X.opsLeads)),
        allowed: ['teamAdmin'],
      },
      {
        name: 'Operations’ private room the same way',
        request: teamDefaults(T.operations, ref.room(X.opsHuddle)),
        allowed: ['teamAdmin'],
      },
      {
        name: 'REC-07: never a restricted room, even one its own Team Admin owns and is in',
        request: teamDefaults(T.operations, ref.room(X.opsReview)),
        allowed: NOBODY,
      },
      {
        name: 'REC-07: never the restricted People 1:1s room, even for its team',
        request: teamDefaults(T.people, ref.room(R.people)),
        allowed: NOBODY,
      },
      {
        name: 'RMS-58: never a restricted public room',
        request: teamDefaults(T.operations, ref.room(R.townhall)),
        allowed: NOBODY,
      },
      {
        name: 'Rule 9: a private channel another team owns is never a default, so #leadership can’t be pulled into Operations',
        request: teamDefaults(T.operations, ref.channel(C.leadership)),
        allowed: NOBODY,
      },
      {
        name: '#leadership is a Leadership default only when set by Ashton, its owner and an Owner',
        request: teamDefaults(T.leadership, ref.channel(C.leadership)),
        allowed: ['ashton'],
      },
      {
        name: 'a private channel of another team is refused even to its owner',
        request: teamDefaults(T.people, ref.channel(X.opsLeads)),
        allowed: NOBODY,
      },
      {
        name: 'a channel’s own room is never a default on its own',
        request: teamDefaults(T.operations, ref.room(R.ops)),
        allowed: NOBODY,
      },
      {
        name: 'an archived channel is never a default',
        request: teamDefaults(T.operations, ref.channel(X.oldNews)),
        allowed: NOBODY,
      },
      {
        name: 'one space that fails refuses the whole list',
        request: teamDefaults(T.operations, ref.channel(C.general), ref.channel(C.leadership)),
        allowed: NOBODY,
      },
      { name: 'only spaces can be defaults', request: teamDefaults(T.operations, ref.task(TK.ot)), allowed: NOBODY },
      {
        name: 'T13: an archived team has no defaults set, by its Team Admin or anyone',
        request: teamDefaults(T.nightShift, ref.channel(C.general)),
        allowed: NOBODY,
      },
    ],
  },
  {
    ids: 'ACC-07 Rule 9',
    title: 'org.defaults.set (public channels only)',
    rows: [
      {
        name: 'an Admin or Owner makes a public channel a default',
        request: orgDefaults(ref.channel(C.general)),
        allowed: ADMINS,
      },
      {
        name: 'several public channels',
        request: orgDefaults(ref.channel(C.general), ref.channel(C.announcements)),
        allowed: ADMINS,
      },
      { name: 'clearing them', request: orgDefaults(), allowed: ADMINS },
      {
        name: 'a private channel never, even by its owner, so nobody pulls the org into #leadership',
        request: orgDefaults(ref.channel(C.leadership)),
        allowed: NOBODY,
      },
      { name: 'a room never', request: orgDefaults(ref.room(R.lounge)), allowed: NOBODY },
      { name: 'an archived channel never', request: orgDefaults(ref.channel(X.oldNews)), allowed: NOBODY },
      {
        name: 'one private channel refuses the whole list',
        request: orgDefaults(ref.channel(C.general), ref.channel(C.studio)),
        allowed: NOBODY,
      },
    ],
  },
  {
    ids: 'D45 ADM-06 T13',
    title: 'audit_readers.change (Owner: any role but Team Admin; Admin: not Admin, not a role they hold)',
    rows: [
      ...(['owner', 'leadership', 'dpo', 'compliance_officer'] as const).map(role => ({
        name: `an Admin or Owner adds ${role}, which none of the Admins hold (Ashton holds DPO but is an Owner)`,
        request: readers('add', role),
        allowed: ADMINS,
      })),
      {
        name: 'Arjun, who holds AI Admin, can’t add it; an Admin who doesn’t hold it can',
        request: readers('add', 'ai_admin'),
        allowed: but(ADMINS, 'arjun'),
      },
      { name: 'only an Owner adds Admin', request: readers('add', 'admin'), allowed: OWNERS },
      { name: 'Team Admin is never on the list', request: readers('add', 'team_admin'), allowed: NOBODY },
      { name: 'a role not on the list isn’t removed', request: readers('remove', 'leadership'), allowed: NOBODY },
      {
        name: 'Arjun can’t remove AI Admin either; an Admin who doesn’t hold it can',
        request: readers('remove', 'ai_admin'),
        allowed: but(ADMINS, 'arjun'),
        world: withReaders(['leadership', 'ai_admin', 'admin', 'dpo']),
      },
      {
        name: 'only an Owner removes Admin',
        request: readers('remove', 'admin'),
        allowed: OWNERS,
        world: withReaders(['leadership', 'ai_admin', 'admin', 'dpo']),
      },
      {
        name: 'an Admin or Owner removes Leadership',
        request: readers('remove', 'leadership'),
        allowed: ADMINS,
        world: withReaders(['leadership', 'ai_admin', 'admin', 'dpo']),
      },
      {
        name: 'an Owner removes a role they hold (Ashton and DPO)',
        request: readers('remove', 'dpo'),
        allowed: ADMINS,
        world: withReaders(['leadership', 'ai_admin', 'admin', 'dpo']),
      },
      {
        name: 'a role already on the list isn’t added again',
        request: readers('add', 'leadership'),
        allowed: NOBODY,
        world: withReaders(['leadership', 'ai_admin', 'admin', 'dpo']),
      },
      {
        name: 'Team Admin is never removed, since it is never there',
        request: readers('remove', 'team_admin'),
        allowed: NOBODY,
        world: withReaders(['leadership', 'ai_admin', 'admin', 'dpo']),
      },
    ],
  },
  {
    ids: 'D45 ADM-06',
    title: 'audit_log.read (only a role on the org’s readers list, as read_audit_events() checks)',
    rows: [
      {
        name: 'nobody reads it until a role is chosen, not even an Owner',
        request: { action: 'audit_log.read' },
        allowed: NOBODY,
      },
      {
        name: 'Owner on the list: the Owners',
        request: { action: 'audit_log.read' },
        allowed: OWNERS,
        world: withReaders(['owner']),
      },
      {
        name: 'Admin on the list: the Admins, not an Owner who doesn’t hold Admin',
        request: { action: 'audit_log.read' },
        allowed: ['admin', 'arjun'],
        world: withReaders(['admin']),
      },
      {
        name: 'DPO and Compliance Officer on the list: their holders, not a DPO who has left',
        request: { action: 'audit_log.read' },
        allowed: plus(DPOS, COMPLIANCE),
        world: withReaders(['dpo', 'compliance_officer']),
      },
      {
        name: 'AI Admin on the list: the AI Admins',
        request: { action: 'audit_log.read' },
        allowed: ['aiAdmin', 'arjun'],
        world: withReaders(['ai_admin']),
      },
      {
        name: 'Leadership on the list: its holders',
        request: { action: 'audit_log.read' },
        allowed: ['leadership', 'weiling'],
        world: withReaders(['leadership']),
      },
      {
        name: 'every role but Team Admin on the list: every holder of one, never a Team Admin or Member',
        request: { action: 'audit_log.read' },
        allowed: ['owner', 'admin', 'aiAdmin', 'leadership', 'dpo', 'compliance', 'ashton', 'arjun', 'weiling'],
        world: withReaders(['owner', 'admin', 'ai_admin', 'leadership', 'dpo', 'compliance_officer']),
      },
    ],
  },
  {
    ids: 'REC-07 ADM-04 decision 13',
    title: 'room.restrict, room.unrestrict and session.reclassify',
    rows: [
      {
        name: 'restricting narrows future sessions: an Admin, Owner or Compliance Officer, not a DPO alone',
        request: { action: 'room.restrict', room: R.lounge },
        allowed: plus(ADMINS, COMPLIANCE),
      },
      {
        name: 'a channel’s room is restricted the same way',
        request: { action: 'room.restrict', room: R.ops },
        allowed: plus(ADMINS, COMPLIANCE),
      },
      {
        name: 'a restricted room isn’t restricted again',
        request: { action: 'room.restrict', room: R.people },
        allowed: NOBODY,
      },
      {
        name: 'a room not in the org isn’t restricted',
        request: { action: 'room.restrict', room: 'rm-missing' },
        allowed: NOBODY,
      },
      {
        name: 'C2.3: lifting it widens access, so only the DPO or a Compliance Officer, never an Admin alone',
        request: { action: 'room.unrestrict', room: R.people },
        allowed: plus(DPOS, COMPLIANCE),
      },
      {
        name: 'C2.3: the same for a restricted public room',
        request: { action: 'room.unrestrict', room: R.townhall },
        allowed: plus(DPOS, COMPLIANCE),
      },
      {
        name: 'a room that isn’t restricted isn’t lifted',
        request: { action: 'room.unrestrict', room: R.lounge },
        allowed: NOBODY,
      },
      {
        name: 'reclassifying a past restricted session is a DPO or Compliance action',
        request: { action: 'session.reclassify', session: S.peopleAshton },
        allowed: plus(DPOS, COMPLIANCE),
      },
      {
        name: 'so is reclassifying an ordinary one',
        request: { action: 'session.reclassify', session: S.standupFri },
        allowed: plus(DPOS, COMPLIANCE),
      },
      {
        name: 'a session not in the org isn’t reclassified',
        request: { action: 'session.reclassify', session: 'ss-missing' },
        allowed: NOBODY,
      },
    ],
  },
  {
    ids: 'ADM-03 ADM-04',
    title: 'recording_policy.set and public_creation.set',
    rows: [
      {
        name: 'an Admin or Owner sets the recording policy',
        request: { action: 'recording_policy.set' },
        allowed: ADMINS,
      },
      {
        name: 'an Admin or Owner sets who may create public channels',
        request: { action: 'public_creation.set' },
        allowed: ADMINS,
      },
    ],
  },
  {
    ids: 'ADM-03 CHAT-01 Rule 9',
    title: 'channel.transfer_ownership (to an active person; for a private channel only to a current member)',
    rows: [
      {
        name: 'an Admin or Owner hands #leadership to Priya, a member',
        request: transfer(C.leadership, P.priya),
        allowed: ADMINS,
      },
      {
        name: 'Arjun can’t take #leadership: they aren’t in it',
        request: transfer(C.leadership, P.arjun),
        allowed: NOBODY,
      },
      {
        name: 'nor can an Admin hand it to themselves or anyone else outside it',
        request: transfer(C.leadership, ONE.admin),
        allowed: NOBODY,
      },
      { name: 'not to its current owner', request: transfer(C.leadership, P.ashton), allowed: NOBODY },
      {
        name: 'ACC-05: not to a member who has left',
        request: transfer(C.leadership, P.formerDpo),
        allowed: NOBODY,
      },
      { name: 'a private channel to a current member', request: transfer(C.studio, P.rachel), allowed: ADMINS },
      { name: 'a public channel to anyone active', request: transfer(C.general, P.nadia), allowed: ADMINS },
      {
        name: 'a public channel to the Admin asking, which opens nothing: the whole org reads it already',
        request: transfer(C.general, P.arjun),
        allowed: ADMINS,
      },
      { name: 'an archived channel isn’t transferred', request: transfer(X.oldNews, P.nadia), allowed: NOBODY },
      { name: 'a channel not in the org isn’t transferred', request: transfer('ch-missing', P.nadia), allowed: NOBODY },
      { name: 'not to someone not on the roster', request: transfer(C.general, X.unknownPerson), allowed: NOBODY },
      {
        name: 'ACC-11: not to someone in another org',
        request: transfer(C.general, ORG_2_PEOPLE.owner),
        allowed: NOBODY,
      },
      { name: 'not to an agent', request: transfer(C.general, AG.digest), allowed: NOBODY },
    ],
  },
  {
    ids: 'ADM-12 PDPA-13 Rule 9',
    title: 'privileged_console.open (opening only; every read in it is a Rule 9 read against a case)',
    rows: [
      {
        name: 'the compliance console: Compliance Officers only, never an Owner or Admin as such',
        request: { action: 'privileged_console.open', console: 'compliance' },
        allowed: COMPLIANCE,
      },
      {
        name: 'the DPO console: DPOs only, never an Owner or Admin as such, nor a DPO who has left',
        request: { action: 'privileged_console.open', console: 'dpo' },
        allowed: DPOS,
      },
    ],
  },
  {
    ids: 'T17 BUILD-PLAN C0.6 D41',
    title: 'flag.set (an Owner or Admin, never an AI flag; whether a flag is locked is the database’s to say)',
    rows: [
      {
        name: 'an Owner or Admin changes a core flag; nobody else, a departed DPO, a former Admin or an agent included',
        request: { action: 'flag.set', key: 'core.example' },
        allowed: ADMINS,
      },
      {
        name: 'an Owner or Admin changes a flag several levels down',
        request: { action: 'flag.set', key: 'core.example.wave_2' },
        allowed: ADMINS,
      },
      {
        name: 'A0 ADM-10: nobody turns AI on or off before A0, the Owner and DPO included',
        request: { action: 'flag.set', key: 'ai' },
        allowed: NOBODY,
      },
      { name: 'A0: nor any one AI feature', request: { action: 'flag.set', key: 'ai.ask' }, allowed: NOBODY },
      {
        name: 'A0 ADM-10: nor one agent',
        request: { action: 'flag.set', key: 'ai.agents.it_helpdesk' },
        allowed: NOBODY,
      },
      {
        name: 'a key that only starts with the letters ai is no AI flag',
        request: { action: 'flag.set', key: 'aisle.signs' },
        allowed: ADMINS,
      },
    ],
  },
  {
    ids: 'ADM-03 ROOM-01 CHAT-01 FILE-01 D16',
    title: 'create (no re-authentication needed; only a person creates)',
    rows: [
      {
        name: 'with creation limited to Admins, only an Admin or Owner creates a public channel',
        request: { action: 'create', kind: 'channel', visibility: 'public' },
        allowed: ADMINS,
      },
      {
        name: 'with creation open to everyone, anyone active creates one',
        request: { action: 'create', kind: 'channel', visibility: 'public' },
        allowed: ACTIVE_PEOPLE,
        world: matrixWorld(f => ({ ...f, settings: { publicCreation: 'everyone' } })),
      },
      {
        name: 'anyone active creates a private channel',
        request: { action: 'create', kind: 'channel', visibility: 'private' },
        allowed: ACTIVE_PEOPLE,
      },
      {
        name: 'standalone rooms follow the public-channel setting',
        request: { action: 'create', kind: 'room', visibility: 'public' },
        allowed: ADMINS,
      },
      {
        name: 'private standalone rooms too',
        request: { action: 'create', kind: 'room', visibility: 'private' },
        allowed: ADMINS,
      },
      { name: 'anyone active creates a task', request: { action: 'create', kind: 'task' }, allowed: ACTIVE_PEOPLE },
      { name: 'anyone active creates an event', request: { action: 'create', kind: 'event' }, allowed: ACTIVE_PEOPLE },
      {
        name: 'anyone active creates a file in their own Drive',
        request: { action: 'create', kind: 'file' },
        allowed: ACTIVE_PEOPLE,
      },
    ],
  },
  {
    ids: 'ACC-02 ACC-04 T14',
    title: 'your own devices and passkeys (devices need no re-authentication; passkeys need a fresh one)',
    rows: [
      {
        name: 'everyone active signs out this device or all their others',
        request: { action: 'devices.sign_out_own' },
        allowed: ACTIVE_PEOPLE,
      },
      {
        name: 'everyone active lists their own devices',
        request: { action: 'devices.list_own' },
        allowed: ACTIVE_PEOPLE,
      },
      {
        name: 'a device named by id is signed out only by its owner',
        request: { action: 'devices.sign_out_own', device: DEV.marcusPhone },
        allowed: ['marcus'],
      },
      {
        name: 'a device already signed out isn’t signed out again',
        request: { action: 'devices.sign_out_own', device: DEV.marcusOld },
        allowed: NOBODY,
      },
      {
        name: 'ACC-05: the device of someone who has left is nobody’s to sign out this way, not even theirs',
        request: { action: 'devices.sign_out_own', device: DEV.formerDpoPhone },
        allowed: NOBODY,
      },
      {
        name: 'a device not in the snapshot is refused, like someone else’s',
        request: { action: 'devices.sign_out_own', device: 'dev-missing' },
        allowed: NOBODY,
      },
      {
        name: 'everyone active adds a passkey after re-authenticating',
        request: { action: 'passkeys.add_own' },
        allowed: ACTIVE_PEOPLE,
      },
      {
        name: 'a passkey is removed only by its owner',
        request: { action: 'passkeys.remove_own', passkey: PK.marcus },
        allowed: ['marcus'],
      },
      {
        name: 'a passkey already removed isn’t removed again',
        request: { action: 'passkeys.remove_own', passkey: PK.marcusRemoved },
        allowed: NOBODY,
      },
      {
        name: 'ACC-05: the passkey of someone who has left is nobody’s to remove this way, not even theirs',
        request: { action: 'passkeys.remove_own', passkey: PK.formerDpo },
        allowed: NOBODY,
      },
      {
        name: 'a passkey not in the snapshot is refused, like someone else’s',
        request: { action: 'passkeys.remove_own', passkey: 'pk-missing' },
        allowed: NOBODY,
      },
    ],
  },
  {
    ids: 'T17 T21',
    title: 'your own session and client flags (no re-authentication)',
    rows: [
      {
        // The web shell's GET /api/session and GET /api/flags (T17 item 11). A leaver, another org's
        // Owner, an assistant, an agent and the system principal are refused (ACC-05, ACC-11, R9-03).
        name: 'everyone active reads their own session and client flags',
        request: { action: 'session.read_own' },
        allowed: ACTIVE_PEOPLE,
      },
    ],
  },
]

const ALL_ROWS: readonly Row[] = SECTIONS.flatMap(s => s.rows)
const worldOf = (row: Row) => row.world ?? W

// Every admin request kind, with the ids its tests cite. A Record, so leaving one out of
// src/requests.ts's AdminRequest fails typecheck.
const ADMIN_ACTION_IDS: Record<AdminRequest['action'], string> = {
  'role.grant': 'ADM-02 ACC-10',
  'role.approve': 'ADM-02 PRD-85',
  'role.revoke': 'ADM-02 ACC-10',
  'person.add': 'ADM-02 ACC-03',
  'person.set_manager': 'ACC-03 ACC-05',
  'person.deactivate': 'ADM-02 ACC-05',
  'person.reset_pin': 'ADM-02 ACC-06',
  'person.change_phone': 'ADM-02 ACC-06',
  'person.sign_out_devices': 'ADM-02 ACC-04',
  'person.list_devices': 'ADM-02 ACC-04',
  'team.create': 'ADM-03',
  'team.archive': 'ADM-03',
  'team.members.change': 'ADM-03 ACC-07',
  'team.defaults.set': 'ACC-07',
  'org.defaults.set': 'ACC-07',
  'audit_readers.change': 'D45 ADM-06',
  'audit_log.read': 'D45 ADM-06',
  'room.restrict': 'REC-07 ADM-04',
  'room.unrestrict': 'REC-07 decision 13',
  'session.reclassify': 'decision 13',
  'recording_policy.set': 'ADM-04',
  'public_creation.set': 'ADM-03',
  'channel.transfer_ownership': 'ADM-03',
  'privileged_console.open': 'ADM-12 PDPA-13',
  'flag.set': 'T17 ADM-10',
}
const ADMIN_ACTIONS = Object.keys(ADMIN_ACTION_IDS) as AdminRequest['action'][]
const isAdminRow = (row: Row) => (ADMIN_ACTIONS as string[]).includes(row.request.action)

// Every request about your own session, devices and passkeys, the same way.
const SELF_ACTION_IDS: Record<SelfRequest['action'], string> = {
  'devices.sign_out_own': 'ACC-04',
  'devices.list_own': 'ACC-04',
  'passkeys.add_own': 'ACC-02 T14',
  'passkeys.remove_own': 'ACC-02 T14',
  'session.read_own': 'T17 T21',
}
const SELF_KINDS = Object.keys(SELF_ACTION_IDS) as SelfRequest['action'][]
const PASSKEY_ACTIONS: readonly SelfRequest['action'][] = ['passkeys.add_own', 'passkeys.remove_own']

// Every live-topic request kind (T19 item 7), the same way.
const TOPIC_ACTION_IDS: Record<TopicRequest['action'], string> = {
  'topic.subscribe': 'ACC-05 T19 PRD-108',
}
const TOPIC_KINDS = Object.keys(TOPIC_ACTION_IDS) as TopicRequest['action'][]
const subscribe = (kind: Topic['kind'], id: Id): TopicRequest => ({ action: 'topic.subscribe', topic: { kind, id } })

// Rows whose world puts a role on the audit-log readers list: there the log is read through the
// list, not through the role's own powers (D45).
const listsReader = (row: Row, role: OrgRole) =>
  row.request.action === 'audit_log.read' && (worldOf(row).facts.auditLogReaders as readonly OrgRole[]).includes(role)

describe('ACC-10 CLAUDE.md Database: the matrix', () => {
  test('ACC-10: each persona holds exactly its one role; combined holders hold both; ended rows hold none', () => {
    const held = (id: Id) => W.rolesOf(id).map(r => (r.teamId === null ? r.role : `${r.role}:${r.teamId}`))
    expect(held(ONE.owner)).toEqual(['owner'])
    expect(held(ONE.admin)).toEqual(['admin'])
    expect(held(ONE.aiAdmin)).toEqual(['ai_admin'])
    expect(held(ONE.leadership)).toEqual(['leadership'])
    expect(held(ONE.dpo)).toEqual(['dpo'])
    expect(held(ONE.compliance)).toEqual(['compliance_officer'])
    expect(held(ONE.teamAdmin)).toEqual([`team_admin:${T.operations}`])
    expect(held(ONE.member)).toEqual([])
    expect(held(P.ashton).sort()).toEqual(['dpo', 'owner'])
    expect(held(P.arjun).sort()).toEqual(['admin', 'ai_admin'])
    expect(held(P.weiling).sort()).toEqual(['compliance_officer', 'leadership'])
    // A leaver's DPO row, a revoked Admin row and a Team Admin row for an archived team are all
    // still in the facts, and none of them counts (ACC-05, Rule 6, T13).
    for (const id of [P.formerDpo, P.formerAdmin, P.farah]) {
      expect(W.facts.roles.some(r => r.personId === id)).toBe(true)
      expect(held(id)).toEqual([])
    }
  })

  test('ACC-10 ADM-02 ACC-04: can() routes exactly the admin and self actions the request types name', () => {
    // A kind added to a type but not to the set can() routes by would be decided as content.
    expect([...ROUTED_ADMIN_ACTIONS].sort()).toEqual([...ADMIN_ACTIONS].sort())
    expect([...SELF_ACTIONS].sort()).toEqual([...SELF_KINDS].sort())
  })

  test('ACC-05 T19: can() routes exactly the topic actions the request type names', () => {
    // A topic names no resource, so one missing from the set would be decided as content.
    expect([...TOPIC_ACTIONS].sort()).toEqual([...TOPIC_KINDS].sort())
    for (const action of TOPIC_KINDS) {
      expect(() => can(W, human(P.marcus), { action, topic: { kind: 'person', id: P.marcus } }), action).not.toThrow()
    }
  })

  test('ACC-10 ADM-02 ACC-04 T21: the matrix decides every admin request kind, the create request and every request about your own session, devices and passkeys', () => {
    const actions = new Set(ALL_ROWS.map(r => r.request.action))
    for (const action of ADMIN_ACTIONS) expect(actions.has(action), action).toBe(true)
    expect(actions.has('create')).toBe(true)
    for (const action of SELF_KINDS) expect(actions.has(action), action).toBe(true)
    // Every actor is refused somewhere, every holder of a live role is allowed some admin request
    // (AI Admin and Leadership only by being on the audit-log readers list), and a Member, a
    // revoked Admin and the Team Admin of an archived team none, so no row set passes by allowing
    // or refusing everyone.
    for (const a of ACTORS) expect(ALL_ROWS.some(r => !r.allowed.includes(a.key), a.key)).toBe(true)
    const powerless: readonly ActorKey[] = ['member', 'formerAdmin', 'farah']
    for (const key of ACTIVE_PEOPLE) {
      expect(
        ALL_ROWS.some(r => isAdminRow(r) && r.allowed.includes(key)),
        key,
      ).toBe(!powerless.includes(key))
    }
  })

  for (const section of SECTIONS) {
    describe(section.title, () => {
      for (const row of section.rows) {
        test(`${section.ids}: ${row.name}`, () => {
          expect(allowedIn(worldOf(row), row.request)).toEqual(inOrder(row.allowed))
        })
      }
    })
  }
})

describe('§9.4 ADM-02: every admin request needs a fresh re-authentication', () => {
  for (const action of ADMIN_ACTIONS) {
    test(`§9.4 ${ADMIN_ACTION_IDS[action]}: ${action} is refused without re-authentication, even to those it allows`, () => {
      const rows = ALL_ROWS.filter(r => r.request.action === action && r.allowed.length > 0)
      expect(rows.length, action).toBeGreaterThan(0)
      for (const row of rows) {
        const w = worldOf(row)
        for (const key of row.allowed) {
          const subject = subjectOf(key)
          expect(can(w, subject, row.request, REAUTH), `${key}: ${row.name}`).toBe(true)
          expect(can(w, subject, row.request), `${key} with no context: ${row.name}`).toBe(false)
          expect(can(w, subject, row.request, {}), `${key} with {}: ${row.name}`).toBe(false)
          expect(can(w, subject, row.request, { reauthenticated: false }), `${key}: ${row.name}`).toBe(false)
        }
      }
    })
  }

  test('§9.4 ACC-04 T21: reading your own session and client flags, listing and signing out your own devices and creating things need no re-authentication', () => {
    const rows = ALL_ROWS.filter(
      r =>
        r.request.action === 'session.read_own' ||
        r.request.action === 'devices.sign_out_own' ||
        r.request.action === 'devices.list_own' ||
        r.request.action === 'create',
    )
    expect(rows.some(r => r.request.action === 'session.read_own')).toBe(true)
    for (const row of rows) {
      for (const context of [undefined, {}, { reauthenticated: false }]) {
        expect(allowedIn(worldOf(row), row.request), `${JSON.stringify(context)}: ${row.name}`).toEqual(
          ACTORS.filter(a => can(worldOf(row), a.subject, row.request, context)).map(a => a.key),
        )
      }
    }
    expect(can(W, human(ONE.member), { action: 'session.read_own' })).toBe(true)
    expect(can(W, human(ONE.member), { action: 'devices.sign_out_own' })).toBe(true)
    expect(can(W, human(ONE.member), { action: 'devices.list_own' })).toBe(true)
    expect(can(W, human(P.marcus), { action: 'devices.sign_out_own', device: DEV.marcusPhone })).toBe(true)
  })

  for (const action of PASSKEY_ACTIONS) {
    test(`${SELF_ACTION_IDS[action]}: ${action} needs a fresh re-authentication, even on your own account`, () => {
      const rows = ALL_ROWS.filter(r => r.request.action === action)
      expect(rows.some(r => r.allowed.length > 0)).toBe(true)
      for (const row of rows) {
        const w = worldOf(row)
        for (const context of [undefined, {}, { reauthenticated: false }]) {
          expect(
            ACTORS.filter(a => can(w, a.subject, row.request, context)).map(a => a.key),
            `${JSON.stringify(context)}: ${row.name}`,
          ).toEqual([])
        }
      }
    })
  }
})

describe('ACC-10 A0 T13: what each role adds', () => {
  // Leaving out the rows where the log is read through the readers list (D45): there the role is
  // allowed because the org chose it, not because of a power of its own.
  for (const [key, id, role, why] of [
    ['aiAdmin', ONE.aiAdmin, 'ai_admin', 'AI Admin grants nothing beyond a Member until the AI layer (A0)'],
    ['leadership', ONE.leadership, 'leadership', 'Leadership grants no admin power (ADM-14’s insights come later)'],
  ] as const) {
    test(`ACC-10 A0: ${why}: on every request the ${key} persona is answered as the Member is`, () => {
      let compared = 0
      for (const row of ALL_ROWS) {
        if (listsReader(row, role)) continue
        const w = worldOf(row)
        expect(can(w, human(id), row.request, REAUTH), row.name).toBe(can(w, human(ONE.member), row.request, REAUTH))
        compared++
      }
      expect(compared).toBeGreaterThan(100)
    })
  }

  test('D45 ACC-10: on the readers list, AI Admin and Leadership read the log and nothing more', () => {
    const w = withReaders(['ai_admin', 'leadership'])
    for (const id of [ONE.aiAdmin, ONE.leadership]) {
      expect(can(w, human(id), { action: 'audit_log.read' }, REAUTH)).toBe(true)
      expect(can(w, human(id), { action: 'audit_readers.change', role: 'dpo', op: 'add' }, REAUTH)).toBe(false)
    }
    expect(can(w, human(ONE.member), { action: 'audit_log.read' }, REAUTH)).toBe(false)
  })

  test('T13: an Owner has every Admin power, because only an Owner grants Admin', () => {
    // Except where the rule looks at who is asking: an Owner never approves their own proposal,
    // and the log goes by the roles on the readers list, not by powers (D45).
    let compared = 0
    for (const row of ALL_ROWS) {
      if (row.request.action === 'audit_log.read') continue
      if (
        row.request.action === 'role.approve' &&
        worldOf(row).proposal(row.request.proposalId)?.proposedBy === ONE.owner
      ) {
        continue
      }
      if (row.allowed.includes('admin')) {
        expect(row.allowed.includes('owner'), row.name).toBe(true)
        compared++
      }
    }
    expect(compared).toBeGreaterThan(30)
  })

  test('ACC-10: the combined holders have each of their roles’ powers', () => {
    // Ashton opens the DPO console as a DPO and grants Admin as an Owner; Wei Ling opens the
    // compliance console as a Compliance Officer and reads the log when Leadership is listed;
    // Arjun archives teams as an Admin and reads the log when AI Admin is listed.
    expect(can(W, human(P.ashton), { action: 'privileged_console.open', console: 'dpo' }, REAUTH)).toBe(true)
    expect(can(W, human(P.ashton), grant(P.nadia, 'admin'), REAUTH)).toBe(true)
    expect(can(W, human(P.ashton), { action: 'privileged_console.open', console: 'compliance' }, REAUTH)).toBe(false)
    expect(can(W, human(P.weiling), { action: 'privileged_console.open', console: 'compliance' }, REAUTH)).toBe(true)
    expect(can(withReaders(['leadership']), human(P.weiling), { action: 'audit_log.read' }, REAUTH)).toBe(true)
    expect(can(W, human(P.weiling), { action: 'team.create' }, REAUTH)).toBe(false)
    expect(can(W, human(P.arjun), { action: 'team.archive', team: T.sales }, REAUTH)).toBe(true)
    expect(can(withReaders(['ai_admin']), human(P.arjun), { action: 'audit_log.read' }, REAUTH)).toBe(true)
    expect(can(W, human(P.arjun), { action: 'privileged_console.open', console: 'dpo' }, REAUTH)).toBe(false)
  })
})

describe('ADM-02 CLAUDE.md Database: nobody changes their own roles or teams', () => {
  const ALL_ROLES: readonly OrgRole[] = [...OWNER_ONLY, 'team_admin']

  test('CLAUDE.md Database: nobody grants themselves any role, revokes their own or changes their own team', () => {
    for (const a of ACTORS) {
      if (a.subject.kind !== 'human') continue
      const me = a.subject.id
      for (const role of ALL_ROLES) {
        const teamId = role === 'team_admin' ? T.finance : null
        expect(can(W, a.subject, grant(me, role, teamId), REAUTH), `${a.key} grants themselves ${role}`).toBe(false)
        // A re-import of your own row with a role in it is the same grant (ACC-03).
        expect(can(W, a.subject, revoke(me, role, teamId), REAUTH), `${a.key} revokes their own ${role}`).toBe(false)
      }
      for (const held of W.rolesOf(me)) {
        expect(can(W, a.subject, revoke(me, held.role, held.teamId), REAUTH), `${a.key} ${held.role}`).toBe(false)
      }
      for (const team of W.facts.teams) {
        for (const op of ['add', 'remove'] as const) {
          expect(can(W, a.subject, teamChange(team.id, me, op), REAUTH), `${a.key} ${op} ${team.id}`).toBe(false)
        }
      }
    }
  })

  test('CLAUDE.md Database: the same requests about someone else are allowed, so the refusals are about self', () => {
    expect(can(W, human(ONE.owner), grant(P.ashton, 'admin'), REAUTH)).toBe(true)
    expect(can(W, human(P.ashton), grant(ONE.owner, 'dpo'), REAUTH)).toBe(true)
    expect(can(W, human(ONE.admin), grant(P.arjun, 'team_admin', T.finance), REAUTH)).toBe(true)
    expect(can(W, human(P.arjun), grant(ONE.admin, 'team_admin', T.finance), REAUTH)).toBe(true)
    expect(can(W, human(ONE.owner), revoke(P.ashton, 'dpo'), REAUTH)).toBe(true)
    expect(can(W, human(P.marcus), teamChange(T.operations, ONE.teamAdmin, 'remove'), REAUTH)).toBe(true)
    expect(can(W, human(ONE.teamAdmin), teamChange(T.operations, P.marcus, 'remove'), REAUTH)).toBe(true)
  })

  test('D45: an Admin who also holds Leadership can’t add or remove it on the readers list; an Owner who holds a role can', () => {
    const both = matrixWorld(f => ({ ...f, roles: [...f.roles, roleRow(ONE.admin, 'leadership')] }))
    expect(can(both, human(ONE.admin), readers('add', 'leadership'), REAUTH)).toBe(false)
    expect(can(both, human(ONE.admin), readers('add', 'compliance_officer'), REAUTH)).toBe(true)
    const listed = matrixWorld(f => ({
      ...f,
      roles: [...f.roles, roleRow(ONE.admin, 'leadership')],
      auditLogReaders: ['leadership', 'dpo'],
    }))
    expect(can(listed, human(ONE.admin), readers('remove', 'leadership'), REAUTH)).toBe(false)
    // Ashton holds DPO and is an Owner (Owners as D45 has them).
    expect(can(W, human(P.ashton), readers('add', 'dpo'), REAUTH)).toBe(true)
    expect(can(listed, human(P.ashton), readers('remove', 'dpo'), REAUTH)).toBe(true)
  })

  test('D45: no Admin gives themselves the log; another person putting their role on the list is what opens it', () => {
    // Arjun can't add AI Admin; the Leadership they can add isn't theirs, so they still can't read it.
    expect(can(W, human(P.arjun), readers('add', 'ai_admin'), REAUTH)).toBe(false)
    expect(can(W, human(P.arjun), readers('add', 'leadership'), REAUTH)).toBe(true)
    const afterLeadership = withReaders(['leadership'])
    expect(can(afterLeadership, human(P.arjun), { action: 'audit_log.read' }, REAUTH)).toBe(false)
    // An Admin who doesn't hold AI Admin may add it, and then the AI Admins (Arjun included) read
    // the log, but not the Admin who added it.
    expect(can(W, human(ONE.admin), readers('add', 'ai_admin'), REAUTH)).toBe(true)
    const afterAiAdmin = withReaders(['ai_admin'])
    expect(can(afterAiAdmin, human(ONE.admin), { action: 'audit_log.read' }, REAUTH)).toBe(false)
    expect(can(afterAiAdmin, human(P.arjun), { action: 'audit_log.read' }, REAUTH)).toBe(true)
  })

  test('D45: Team Admin never reads the log, even if a row naming it reached the list', () => {
    const forced = withReaders(['team_admin' as AuditReaderRole])
    for (const id of [ONE.teamAdmin, P.marcus, P.huimin, P.farah]) {
      expect(can(forced, human(id), { action: 'audit_log.read' }, REAUTH), id).toBe(false)
    }
  })

  test('D45 Rule 6: a reader stops reading the log when their role is revoked or they leave', () => {
    const listed = withReaders(['dpo'])
    expect(can(listed, human(ONE.dpo), { action: 'audit_log.read' }, REAUTH)).toBe(true)
    const revoked = matrixWorld(f => ({
      ...f,
      auditLogReaders: ['dpo'],
      roles: f.roles.map(r => (r.personId === ONE.dpo ? { ...r, revokedAt: 2 } : r)),
    }))
    const left = matrixWorld(f => ({
      ...f,
      auditLogReaders: ['dpo'],
      people: f.people.map(p => (p.id === ONE.dpo ? { ...p, deactivatedAt: 2 } : p)),
    }))
    for (const w of [revoked, left]) expect(can(w, human(ONE.dpo), { action: 'audit_log.read' }, REAUTH)).toBe(false)
  })
})

describe('PRD-85 ADM-02: DPO and Compliance Officer need a second approver', () => {
  test('PRD-85: an Owner’s grant is a proposal; the role is held only once a third person approves it', () => {
    // The Owner persona proposed Nadia as Compliance Officer. Until approval Nadia holds nothing.
    expect(can(W, human(ONE.owner), grant(P.nadia, 'compliance_officer'), REAUTH)).toBe(true)
    expect(W.holds(P.nadia, 'compliance_officer')).toBe(false)
    expect(can(W, human(P.nadia), { action: 'privileged_console.open', console: 'compliance' }, REAUTH)).toBe(false)
    expect(can(W, human(ONE.owner), approve(PR.nadiaCo), REAUTH)).toBe(false)
    expect(can(W, human(P.nadia), approve(PR.nadiaCo), REAUTH)).toBe(false)
    expect(can(W, human(ONE.admin), approve(PR.nadiaCo), REAUTH)).toBe(true)
    // Once the Admin approves (C0.16 stamps the proposal and adds the role row), Nadia holds it, and
    // the proposal can't be approved again nor the role granted twice.
    const approved = matrixWorld(f => ({
      ...f,
      roleProposals: f.roleProposals.map(p => (p.id === PR.nadiaCo ? { ...p, approvedAt: 2 } : p)),
      roles: [...f.roles, roleRow(P.nadia, 'compliance_officer')],
    }))
    expect(approved.holds(P.nadia, 'compliance_officer')).toBe(true)
    expect(can(approved, human(P.nadia), { action: 'privileged_console.open', console: 'compliance' }, REAUTH)).toBe(
      true,
    )
    expect(allowedIn(approved, approve(PR.nadiaCo))).toEqual([])
    expect(allowedIn(approved, grant(P.nadia, 'compliance_officer'))).toEqual([])
  })

  test('PRD-85: the proposer must still be an active Owner when the grant is approved', () => {
    const revoked = matrixWorld(f => ({
      ...f,
      roles: f.roles.map(r => (r.personId === ONE.owner ? { ...r, revokedAt: 2 } : r)),
    }))
    const left = matrixWorld(f => ({
      ...f,
      people: f.people.map(p => (p.id === ONE.owner ? { ...p, deactivatedAt: 2 } : p)),
    }))
    expect(can(W, human(ONE.admin), approve(PR.nadiaCo), REAUTH)).toBe(true)
    for (const w of [revoked, left]) expect(allowedIn(w, approve(PR.nadiaCo))).toEqual([])
  })

  test('PRD-85: the approver’s own powers count when approving: a revoked or departed Admin can’t', () => {
    const revoked = matrixWorld(f => ({
      ...f,
      roles: f.roles.map(r => (r.personId === ONE.admin ? { ...r, revokedAt: 2 } : r)),
    }))
    expect(can(revoked, human(ONE.admin), approve(PR.nadiaCo), REAUTH)).toBe(false)
    expect(can(W, human(P.formerAdmin), approve(PR.nadiaCo), REAUTH)).toBe(false)
  })

  test('PRD-85: a stored proposal for a role that needs no second approver is never approved through it', () => {
    const w = matrixWorld(f => ({
      ...f,
      roleProposals: [
        ...f.roleProposals,
        { ...proposal('pr-nadia-admin', P.nadia, 'dpo', P.ashton), role: 'admin' } as unknown as RoleProposalFact,
      ],
    }))
    expect(allowedIn(w, approve('pr-nadia-admin'))).toEqual([])
  })
})

describe('T13 ACC-05 Rule 6: ended roles and ended teams confer nothing', () => {
  test('T13: a Team Admin’s powers end when the team is archived, and return if it is live again', () => {
    const live = matrixWorld(f => ({
      ...f,
      teams: f.teams.map(t => (t.id === T.nightShift ? { ...t, archivedAt: null } : t)),
    }))
    const requests: AdminRequest[] = [
      teamChange(T.nightShift, P.nadia, 'add'),
      teamChange(T.nightShift, P.kelvin, 'remove'),
      teamDefaults(T.nightShift, ref.channel(C.general)),
    ]
    for (const request of requests) {
      expect(can(W, human(P.farah), request, REAUTH), request.action).toBe(false)
      expect(can(live, human(P.farah), request, REAUTH), request.action).toBe(true)
    }
    // And no Admin grants Team Admin of it while it is archived.
    expect(can(W, human(ONE.admin), grant(P.nadia, 'team_admin', T.nightShift), REAUTH)).toBe(false)
    expect(can(live, human(ONE.admin), grant(P.nadia, 'team_admin', T.nightShift), REAUTH)).toBe(true)
  })

  test('Rule 6 ACC-10: a revoked Admin is answered as a Member everywhere, and the row is what refuses', () => {
    for (const row of ALL_ROWS) {
      const w = worldOf(row)
      expect(can(w, human(P.formerAdmin), row.request, REAUTH), row.name).toBe(
        can(w, human(ONE.member), row.request, REAUTH),
      )
    }
    const restored = matrixWorld(f => ({
      ...f,
      roles: f.roles.map(r => (r.personId === P.formerAdmin ? { ...r, revokedAt: null } : r)),
    }))
    expect(can(restored, human(P.formerAdmin), { action: 'team.create' }, REAUTH)).toBe(true)
  })

  test('ACC-05: someone who has left is refused everything though their DPO role was never revoked', () => {
    for (const row of ALL_ROWS) {
      expect(can(worldOf(row), human(P.formerDpo), row.request, REAUTH), row.name).toBe(false)
    }
    expect(can(W, human(P.formerDpo), { action: 'person.sign_out_devices', person: P.formerDpo }, REAUTH)).toBe(false)
    // Their row is what would open the console, so it is the deactivation that refuses.
    const back = matrixWorld(f => ({
      ...f,
      people: f.people.map(p => (p.id === P.formerDpo ? { ...p, deactivatedAt: null } : p)),
    }))
    expect(can(back, human(P.formerDpo), { action: 'privileged_console.open', console: 'dpo' }, REAUTH)).toBe(true)
  })
})

describe('T19 PRD-108 ACC-05: live topics are decided by keys, never by a role', () => {
  test('T19 PRD-108: topic.subscribe is decided by keys, never by a role', () => {
    // An Owner and an Admin, alone or with other roles, are refused another person's person topic
    // and a team they aren't in, as a Member is; each holds their own and the org's.
    for (const key of ['owner', 'admin', 'ashton', 'arjun'] as const) {
      const subject = subjectOf(key)
      expect(can(W, subject, subscribe('person', P.nadia)), key).toBe(false)
      expect(can(W, subject, subscribe('team', T.operations)), key).toBe(false)
      expect(can(W, subject, subscribe('person', subject.id)), key).toBe(true)
      expect(can(W, subject, subscribe('org', W.orgId)), key).toBe(true)
    }
    // Over every actor: a person topic is its person's alone, the org's every active person's in it,
    // and a team's its members', whatever roles they hold. An unknown team and another org are
    // nobody's.
    expect(allowedIn(W, subscribe('person', P.marcus))).toEqual(['marcus'])
    expect(allowedIn(W, subscribe('org', W.orgId))).toEqual(inOrder(ACTIVE_PEOPLE))
    expect(allowedIn(W, subscribe('team', T.operations))).toEqual(inOrder(['teamAdmin', 'marcus', 'farah']))
    expect(allowedIn(W, subscribe('team', T.people))).toEqual(['huimin'])
    expect(allowedIn(W, subscribe('team', X.unknownTeam))).toEqual(NOBODY)
    expect(allowedIn(W, subscribe('person', X.unknownPerson))).toEqual(NOBODY)
    expect(allowedIn(W, subscribe('org', ORG_2))).toEqual(NOBODY)
    // Keys both ways: the Team Admin of Operations taken out of the team, role kept, is refused its
    // topic; a Member put in it, with no role, holds it.
    const out = matrixWorld(f => ({
      ...f,
      teamMembers: f.teamMembers.filter(m => !(m.personId === ONE.teamAdmin && m.teamId === T.operations)),
    }))
    expect(out.isTeamAdminOf(ONE.teamAdmin, T.operations)).toBe(true)
    expect(can(out, human(ONE.teamAdmin), subscribe('team', T.operations))).toBe(false)
    const joined = matrixWorld(f => ({
      ...f,
      teamMembers: [...f.teamMembers, { teamId: T.operations, personId: ONE.member, removedAt: null }],
    }))
    expect(can(W, human(ONE.member), subscribe('team', T.operations))).toBe(false)
    expect(can(joined, human(ONE.member), subscribe('team', T.operations))).toBe(true)
  })

  test('T13 item 14 T19: a Team Admin of an archived team still holds the team topic while a member', () => {
    // Farah is in the archived Night shift and its Team Admin. The role gives nothing while the team
    // is archived (T13), but membership still holds the topic, as it does for Kelvin, with no role.
    expect(W.isLiveTeam(T.nightShift)).toBe(false)
    expect(W.isTeamAdminOf(P.farah, T.nightShift)).toBe(false)
    expect(can(W, human(P.farah), subscribe('team', T.nightShift))).toBe(true)
    expect(can(W, human(P.kelvin), subscribe('team', T.nightShift))).toBe(true)
    // Removed from the team, with the Team Admin row still unrevoked, Farah no longer holds it.
    const removed = matrixWorld(f => ({
      ...f,
      teamMembers: f.teamMembers.map(m =>
        m.personId === P.farah && m.teamId === T.nightShift ? { ...m, removedAt: 2 } : m,
      ),
    }))
    expect(removed.facts.roles).toContainEqual({
      personId: P.farah,
      role: 'team_admin',
      teamId: T.nightShift,
      revokedAt: null,
    })
    expect(can(removed, human(P.farah), subscribe('team', T.nightShift))).toBe(false)
    expect(can(removed, human(P.kelvin), subscribe('team', T.nightShift))).toBe(true)
  })
})

describe('R9-03 D16 ACC-11: only a person on this org’s roster holds admin powers', () => {
  test('D16: Ashton’s assistant, an agent and the system principal hold none of the powers Ashton has', () => {
    const ashtons = ALL_ROWS.filter(r => r.allowed.includes('ashton'))
    expect(ashtons.length).toBeGreaterThan(50)
    for (const row of ashtons) {
      for (const subject of [assistant(AS.ashton), agent(AG.it), system]) {
        expect(can(worldOf(row), subject, row.request, REAUTH), `${subject.kind}: ${row.name}`).toBe(false)
      }
    }
  })

  test('D16 R9-03: a subject whose kind doesn’t match its id is refused, never treated as the person', () => {
    const mismatched: Subject[] = [
      { kind: 'assistant', id: P.ashton },
      { kind: 'agent', id: P.arjun },
      { kind: 'system', id: P.ashton },
      { kind: 'human', id: AS.ashton },
      { kind: 'human', id: AG.it },
    ]
    for (const row of ALL_ROWS) {
      for (const subject of mismatched) {
        expect(can(worldOf(row), subject, row.request, REAUTH), `${subject.kind} ${subject.id}: ${row.name}`).toBe(
          false,
        )
      }
    }
  })

  test('ACC-11: another org’s Owner acts in their own org only, and this org’s Owner not in theirs', () => {
    const theirs = new World(otherOrgFacts())
    const owner2 = human(ORG_2_PEOPLE.owner)
    for (const request of [
      { action: 'team.create' },
      { action: 'recording_policy.set' },
      { action: 'audit_log.read' },
    ] as const) {
      expect(can(theirs, owner2, request, REAUTH), request.action).toBe(true)
      expect(can(W, owner2, request, REAUTH), request.action).toBe(false)
      expect(can(theirs, human(P.ashton), request, REAUTH), request.action).toBe(false)
    }
    // Nobody in their org is reached from here, nor anyone here from there.
    expect(can(theirs, owner2, grant(P.nadia, 'leadership'), REAUTH)).toBe(false)
    expect(can(W, human(P.ashton), grant(ORG_2_PEOPLE.owner, 'leadership'), REAUTH)).toBe(false)
  })
})

describe('T17 T21: your own session and client flags', () => {
  test('T21 ACC-05: reading your own session is decided by the acting person alone; a field naming someone else changes nothing', () => {
    // The request names no one. A field smuggled into it, naming an active person or a leaver,
    // neither opens it to a leaver nor closes it to an active person (the server never sends one).
    const read = { action: 'session.read_own' } as const
    for (const named of [P.ashton, P.formerDpo, ORG_2_PEOPLE.owner]) {
      const smuggled = { ...read, person: named, userId: named } as unknown as SelfRequest
      for (const a of ACTORS) {
        expect(can(W, a.subject, smuggled), `${a.key} naming ${named}`).toBe(can(W, a.subject, read))
      }
    }
    expect(can(W, human(P.formerDpo), read)).toBe(false)
    expect(can(W, human(P.ashton), read)).toBe(true)
  })
})

describe('ACC-04 ACC-06: device sign-out and the lone Owner', () => {
  test('ACC-04: every active person lists and signs out their own devices, either way, and nobody else’s without Admin', () => {
    for (const a of ACTORS) {
      if (a.subject.kind !== 'human') continue
      const active = (ACTIVE_PEOPLE as readonly string[]).includes(a.key)
      const me = a.subject.id
      expect(can(W, a.subject, { action: 'devices.sign_out_own' }), a.key).toBe(active)
      expect(can(W, a.subject, { action: 'devices.list_own' }), a.key).toBe(active)
      expect(can(W, a.subject, { action: 'person.sign_out_devices', person: me }, REAUTH), a.key).toBe(active)
      expect(can(W, a.subject, { action: 'person.list_devices', person: me }, REAUTH), a.key).toBe(active)
    }
    for (const action of ['person.sign_out_devices', 'person.list_devices'] as const) {
      expect(can(W, human(ONE.member), { action, person: P.nadia }, REAUTH), action).toBe(false)
      expect(can(W, human(ONE.dpo), { action, person: P.nadia }, REAUTH), action).toBe(false)
    }
  })

  test('ACC-04 ACC-02: a device or passkey is decided by the snapshot’s owner and end, never by the request', () => {
    // Marcus's phone moved to Nadia's account in the snapshot: now Nadia's to sign out, not Marcus's.
    const moved = matrixWorld(f => ({
      ...f,
      devices: f.devices.map(d => (d.id === DEV.marcusPhone ? { ...d, userId: P.nadia } : d)),
      passkeys: f.passkeys.map(k => (k.id === PK.marcus ? { ...k, userId: P.nadia } : k)),
    }))
    const signOut = { action: 'devices.sign_out_own', device: DEV.marcusPhone } as const
    const remove = { action: 'passkeys.remove_own', passkey: PK.marcus } as const
    expect(can(moved, human(P.nadia), signOut)).toBe(true)
    expect(can(moved, human(P.marcus), signOut)).toBe(false)
    expect(can(moved, human(P.nadia), remove, REAUTH)).toBe(true)
    expect(can(moved, human(P.marcus), remove, REAUTH)).toBe(false)
    // Signed out and removed in the snapshot: refused to Marcus too.
    const ended = matrixWorld(f => ({
      ...f,
      devices: f.devices.map(d => (d.id === DEV.marcusPhone ? { ...d, signedOutAt: 2 } : d)),
      passkeys: f.passkeys.map(k => (k.id === PK.marcus ? { ...k, removedAt: 2 } : k)),
    }))
    expect(can(ended, human(P.marcus), signOut)).toBe(false)
    expect(can(ended, human(P.marcus), remove, REAUTH)).toBe(false)
    // An Admin's powers reach no one else's device or passkey through these requests.
    for (const id of [P.arjun, P.ashton, ONE.admin]) {
      expect(can(W, human(id), signOut), id).toBe(false)
      expect(can(W, human(id), remove, REAUTH), id).toBe(false)
    }
  })

  test('ACC-06 T13: in the seed org nobody changes the lone Owner’s phone or PIN, but any Admin signs out the Owner’s devices', () => {
    // Ashton is the only Owner: never themselves, and an Admin can't act on an Owner-only role holder.
    // That leaves the reviewed bootstrap-style script a person runs (an open owner question in
    // T13 item 5), never a can() path. Signing out only removes sessions, so a lost phone is covered.
    const seed = new World(fixtureFacts())
    for (const action of ['person.change_phone', 'person.reset_pin', 'person.deactivate'] as const) {
      for (const id of [P.ashton, P.arjun, P.weiling, P.marcus]) {
        expect(can(seed, human(id), { action, person: P.ashton }, REAUTH), `${id} ${action}`).toBe(false)
      }
    }
    expect(can(seed, human(P.arjun), { action: 'person.sign_out_devices', person: P.ashton }, REAUTH)).toBe(true)
    expect(can(seed, human(P.arjun), { action: 'person.list_devices', person: P.ashton }, REAUTH)).toBe(true)
    expect(can(seed, human(P.arjun), { action: 'person.sign_out_devices', person: P.weiling }, REAUTH)).toBe(true)
    expect(can(seed, human(P.marcus), { action: 'person.sign_out_devices', person: P.ashton }, REAUTH)).toBe(false)
  })
})

// A run of every action someone may take that changes memberships or ownership, applied one after
// another to the facts (ADM-03, ACC-07, CHAT-01). Removing someone only ever narrows
// reads, so the run applies the additions, transfers and grants.
const KINDS: readonly ResourceKind[] = [
  'channel',
  'dm',
  'group_dm',
  'agent_dm',
  'assistant_chat',
  'room',
  'thread',
  'message',
  'session',
  'slide_copy',
  'event',
  'task',
  'suggested_task',
  'folder',
  'file',
  'comment',
  'derived',
]
const readable = (w: World, me: Id) =>
  KINDS.flatMap(kind => listAccessible(w, human(me), kind).map(r => `${r.kind}:${r.id}`))

function candidates(w: World): Request[] {
  const people = w.activePeople()
  const teams = w.facts.teams.map(t => t.id)
  const channels = w.facts.channels.map(c => c.id)
  const spaces: Ref[] = [...channels.map(ref.channel), ...w.facts.rooms.map(r => ref.room(r.id))]
  // Joins and adds first, then org defaults: once the defaults have run, everyone is already in
  // every public space, and those would change nothing. The second pass tries them all again.
  const out: Request[] = []
  for (const space of spaces) {
    out.push({ action: 'join', resource: space })
    for (const person of people)
      out.push({ action: 'member.add', resource: space, principal: { kind: 'human', id: person } })
  }
  for (const space of spaces) out.push(orgDefaults(space))
  for (const channel of channels) for (const to of people) out.push(transfer(channel, to))
  for (const team of teams) for (const person of people) out.push(teamChange(team, person, 'add'))
  for (const team of teams) for (const space of spaces) out.push(teamDefaults(team, space))
  for (const person of people) {
    for (const team of teams) out.push(grant(person, 'team_admin', team))
    for (const role of OWNER_ONLY) out.push(grant(person, role))
  }
  return out
}

function addMembers(f: Facts, spaceId: Id, people: readonly Id[]): Facts {
  const current = new Set(
    f.memberships.filter(m => m.spaceId === spaceId && m.throughSeq === null).map(m => m.principalId),
  )
  const fresh = [...new Set(people)].filter(p => !current.has(p))
  if (fresh.length === 0) return f
  return {
    ...f,
    memberships: [
      ...f.memberships,
      ...fresh.map(principalId => ({
        id: `run:${spaceId}:${principalId}`,
        spaceId,
        principalId,
        afterSeq: 0,
        throughSeq: null,
      })),
    ],
  }
}

// What an allowed request does to the facts (C0.16's console and C1's spaces will do it for real).
function apply(f: Facts, w: World, request: Request, me: Id): Facts {
  switch (request.action) {
    case 'channel.transfer_ownership':
      return { ...f, channels: f.channels.map(c => (c.id === request.channel ? { ...c, owners: [request.to] } : c)) }
    case 'team.members.change':
      if (request.op === 'remove' || w.isTeamMember(request.person, request.team)) return f
      return {
        ...f,
        teamMembers: [...f.teamMembers, { teamId: request.team, personId: request.person, removedAt: null }],
      }
    case 'team.defaults.set': {
      // Everyone in the team joins its defaults (ACC-07).
      const members = w.membersOf(request.team).filter(p => w.isActivePerson(p))
      return request.spaces.reduce((acc, space) => addMembers(acc, space.id, members), f)
    }
    case 'org.defaults.set':
      return request.spaces.reduce((acc, space) => addMembers(acc, space.id, w.activePeople()), f)
    case 'role.grant':
      return { ...f, roles: [...f.roles, roleRow(request.person, request.role, request.teamId)] }
    case 'join': {
      const space = request.resource
      if (space.kind === 'channel') return addMembers(f, space.id, [me])
      if (space.kind !== 'room') return f
      // Joining a channel's room joins the channel (ROOM-01).
      const room = w.get({ kind: 'room', id: space.id })
      if (room?.kind === 'channel_room') return addMembers(f, room.channelId, [me])
      return room?.kind === 'standalone' ? addMembers(f, room.id, [me]) : f
    }
    case 'member.add':
      return addMembers(f, request.resource.id, [request.principal.id])
    default:
      return f
  }
}

// Applies every request the actor is allowed, in two passes so that a request one step makes
// possible is tried too, checking after each step that changed the facts. Counts, by action, the
// requests allowed (whether or not they changed anything) and those that changed the facts.
interface Run {
  allowed: Map<string, number>
  applied: Map<string, number>
  last: World
}
function runAll(me: Id, check: (w: World, request: Request) => void = () => {}): Run {
  let facts = fixtureFacts()
  let w = new World(facts)
  const allowed = new Map<string, number>()
  const applied = new Map<string, number>()
  const count = (map: Map<string, number>, action: string) => map.set(action, (map.get(action) ?? 0) + 1)
  for (let pass = 0; pass < 2; pass++) {
    for (const request of candidates(w)) {
      if (!can(w, human(me), request, REAUTH)) continue
      count(allowed, request.action)
      const next = apply(facts, w, request, me)
      if (next === facts) continue
      facts = next
      w = new World(facts)
      count(applied, request.action)
      check(w, request)
    }
  }
  return { allowed, applied, last: w }
}

describe('Rule 9 ACC-10 ADM-03 ACC-07: no run of admin actions opens content to the person taking them', () => {
  test('Rule 9 ADM-03 ACC-07 CHAT-01: no run of the actions Arjun is allowed lets them read #leadership', () => {
    // Arjun (Admin and AI Admin) sets every org default they may, transfers every channel they may,
    // adds everyone they may to every team, sets every team default they may, grants Team Admin
    // wherever they may, and joins and adds people to every space they may. Arjun isn't in #leadership,
    // can't take it, can't add themselves to a team or make themselves Team Admin, and so never reads it.
    expect(canRead(new World(fixtureFacts()), human(P.arjun), ref.message(M.leadership))).toBe(false)
    const run = runAll(P.arjun, (w, request) => {
      const step = JSON.stringify(request)
      expect(canRead(w, human(P.arjun), ref.message(M.leadership)), step).toBe(false)
      expect(canRead(w, human(P.arjun), ref.channel(C.leadership)), step).toBe(false)
      expect(canRead(w, human(P.arjun), ref.message(M.digest)), step).toBe(false)
    })
    // The run took every kind of action (each was allowed at least once) and changed the facts
    // many times over.
    for (const action of [
      'join',
      'member.add',
      'org.defaults.set',
      'channel.transfer_ownership',
      'team.members.change',
      'team.defaults.set',
      'role.grant',
    ]) {
      expect(run.allowed.get(action) ?? 0, action).toBeGreaterThan(0)
    }
    expect([...run.applied.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(100)
    // Arjun took #leadership from nobody and handed it only to its members.
    const leadership = run.last.get({ kind: 'channel', id: C.leadership })
    expect(leadership?.owners.every(o => run.last.isCurrentMember(o, C.leadership))).toBe(true)
  })

  test('Rule 9 ACC-10: after the whole run Arjun reads exactly what they read before', () => {
    const before = readable(new World(fixtureFacts()), P.arjun)
    expect(readable(runAll(P.arjun).last, P.arjun)).toEqual(before)
  })

  test('Rule 9 ACC-07 T13: no run of a Team Admin’s actions (Marcus, of Operations) opens anything new to them', () => {
    const before = readable(new World(fixtureFacts()), P.marcus)
    const run = runAll(P.marcus, (w, request) => {
      expect(canRead(w, human(P.marcus), ref.message(M.leadership)), JSON.stringify(request)).toBe(false)
    })
    expect(run.allowed.get('team.members.change') ?? 0).toBeGreaterThan(0)
    expect(run.allowed.get('team.defaults.set') ?? 0).toBeGreaterThan(0)
    expect([...run.applied.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(10)
    expect(run.allowed.get('channel.transfer_ownership') ?? 0).toBe(0)
    expect(run.allowed.get('role.grant') ?? 0).toBe(0)
    expect(readable(run.last, P.marcus)).toEqual(before)
  })
})

// Who signs in and re-authenticates with the PIN (D46, AQ-02), and the method each session must use
// (AQ-01). The server reads ReauthFacts from the session in the deciding transaction; can() still
// receives only the boolean reauthenticated() computes. The exports avoid the word privileged,
// which means Rule 9 access here (R9-02).
describe('D46 AQ-02 AQ-01: the PIN roles and the re-authentication method', () => {
  const facts = (f: Partial<ReauthFacts> = {}): ReauthFacts => ({
    stampFresh: true,
    pinSet: true,
    issuedUnderPinRule: false,
    ...f,
  })
  // The same matrix with every role row of one person revoked.
  const revoked = (person: Id) =>
    matrixWorld(f => ({
      ...f,
      roles: f.roles.map(r => (r.personId === person ? { ...r, revokedAt: 1 } : r)),
    }))
  const SIX = [ONE.owner, ONE.admin, ONE.aiAdmin, ONE.leadership, ONE.dpo, ONE.compliance]

  test('D46 AQ-02 ACC-10: PIN_ROLES is exactly the six Owner-only roles and leaves out Team Admin', () => {
    expect([...PIN_ROLES]).toEqual([...OWNER_ONLY_ROLES])
    expect([...PIN_ROLES].sort()).toEqual(['admin', 'ai_admin', 'compliance_officer', 'dpo', 'leadership', 'owner'])
    expect(PIN_ROLES).not.toContain('team_admin')
  })

  test('D46 AQ-02: each of the six Owner-only roles is a PIN role on its own', () => {
    for (const person of SIX) expect(holdsPinRole(W, person), person).toBe(true)
  })

  test('D46 AQ-02: the seed’s holders add up; its Team Admins and Members sign in on the code alone', () => {
    // Ashton (Owner, DPO), Arjun (Admin, AI Admin), Priya, Wei Ling and Ahmad (Leadership).
    for (const person of [P.ashton, P.arjun, P.priya, P.weiling, P.ahmad]) {
      expect(holdsPinRole(W, person), person).toBe(true)
    }
    // Marcus and Hui Min (Team Admins), and Members.
    for (const person of [P.marcus, P.huimin, P.kelvin, P.nadia, P.rachel, P.daniel, P.cfo]) {
      expect(holdsPinRole(W, person), person).toBe(false)
    }
  })

  test('D46 AQ-02 Rule 6 ACC-05: a revoked row, a leaver, a Team Admin and a Member hold no PIN role', () => {
    expect(holdsPinRole(W, P.formerAdmin)).toBe(false) // the Admin row was revoked
    expect(holdsPinRole(W, P.formerDpo)).toBe(false) // has left; the DPO row was never revoked
    expect(holdsPinRole(W, ONE.teamAdmin)).toBe(false) // Team Admin of a live team
    expect(holdsPinRole(W, P.farah)).toBe(false) // Team Admin of an archived team
    expect(holdsPinRole(W, ONE.member)).toBe(false)
    for (const person of SIX) expect(holdsPinRole(revoked(person), person), person).toBe(false)
  })

  test('D46 ACC-10: assistants, agents, the system principal and unknown ids hold no PIN role', () => {
    for (const id of [...Object.values(AS), ...Object.values(AG), HEARTH, X.unknownPerson]) {
      expect(holdsPinRole(W, id), id).toBe(false)
      expect(reauthMethodOf(W, id, facts()), id).toBe('code')
    }
  })

  // The whole table: the session decides first, then the holder's roles now. stampFresh never
  // changes the method, only whether the stamp counts.
  const TABLE: { issuedUnderPinRule: boolean; pinSet: boolean; holderNow: boolean; method: string }[] = [
    { issuedUnderPinRule: true, pinSet: true, holderNow: true, method: 'pin' },
    { issuedUnderPinRule: true, pinSet: true, holderNow: false, method: 'pin' },
    { issuedUnderPinRule: true, pinSet: false, holderNow: true, method: 'sign_in' },
    { issuedUnderPinRule: true, pinSet: false, holderNow: false, method: 'sign_in' },
    { issuedUnderPinRule: false, pinSet: true, holderNow: true, method: 'sign_in' },
    { issuedUnderPinRule: false, pinSet: false, holderNow: true, method: 'sign_in' },
    { issuedUnderPinRule: false, pinSet: true, holderNow: false, method: 'code' },
    { issuedUnderPinRule: false, pinSet: false, holderNow: false, method: 'code' },
  ]
  test.each(TABLE)(
    'D46 AQ-01 AQ-02: issued under the PIN rule $issuedUnderPinRule, PIN set $pinSet, holder now $holderNow → $method',
    ({ issuedUnderPinRule, pinSet, holderNow, method }) => {
      // A holder now: each of the six. Not one: a Member, a Team Admin, and a former holder.
      const people = holderNow ? SIX : [ONE.member, ONE.teamAdmin, P.formerAdmin]
      for (const person of people) {
        for (const stampFresh of [true, false]) {
          const f = facts({ issuedUnderPinRule, pinSet, stampFresh })
          expect(reauthMethodOf(W, person, f), person).toBe(method)
          expect(reauthenticated(W, person, f), person).toBe(stampFresh && method !== 'sign_in')
        }
      }
    },
  )

  test('D46: a session issued under the PIN rule keeps the PIN after its holder’s roles are removed', () => {
    for (const person of SIX) {
      expect(reauthMethodOf(revoked(person), person, facts({ issuedUnderPinRule: true })), person).toBe('pin')
    }
  })

  test('D46 AQ-02: a remove, SMS re-auth, re-grant cycle can’t put an SMS stamp on a PIN-rule session', () => {
    const session = facts({ issuedUnderPinRule: true })
    // Removed: the session is still on the PIN rule, so the SMS code routes refuse it.
    const removed = revoked(ONE.admin)
    expect(holdsPinRole(removed, ONE.admin)).toBe(false)
    expect(reauthMethodOf(removed, ONE.admin, session)).toBe('pin')
    // Re-granted: still the PIN, and only a PIN stamp counts.
    expect(reauthMethodOf(W, ONE.admin, session)).toBe('pin')
    expect(reauthenticated(W, ONE.admin, session)).toBe(true)
    expect(reauthenticated(W, ONE.admin, { ...session, stampFresh: false })).toBe(false)
  })

  test('D46: a role granted mid-session to a code-only session is mended only by a new sign-in', () => {
    // Before the grant the Member re-authenticates by SMS code; after it, a stamp on that session
    // never counts, however fresh.
    const session = facts({ pinSet: false })
    expect(reauthMethodOf(W, ONE.member, session)).toBe('code')
    const granted = matrixWorld(f => ({ ...f, roles: [...f.roles, roleRow(ONE.member, 'admin')] }))
    expect(reauthMethodOf(granted, ONE.member, session)).toBe('sign_in')
    expect(reauthenticated(granted, ONE.member, session)).toBe(false)
  })

  test('D46 ADM-02 T14: can() follows reauthenticated() for admin requests and passkey changes', () => {
    const team = { action: 'team.create' } as const
    // An Owner on a PIN-rule session with a fresh PIN stamp may act; on a code-only session, or a
    // stale stamp, or a PIN-rule session whose PIN was cleared, may not.
    const ok = { reauthenticated: reauthenticated(W, ONE.owner, facts({ issuedUnderPinRule: true })) }
    expect(can(W, human(ONE.owner), team, ok)).toBe(true)
    for (const f of [
      facts(),
      facts({ issuedUnderPinRule: true, stampFresh: false }),
      facts({ issuedUnderPinRule: true, pinSet: false }),
    ]) {
      expect(can(W, human(ONE.owner), team, { reauthenticated: reauthenticated(W, ONE.owner, f) })).toBe(false)
    }
    // A Member's fresh SMS stamp counts for their own passkeys (dormant in C0.8), a stale one doesn't.
    const add = { action: 'passkeys.add_own' } as const
    const member = (f: ReauthFacts) => ({ reauthenticated: reauthenticated(W, ONE.member, f) })
    expect(can(W, human(ONE.member), add, member(facts()))).toBe(true)
    expect(can(W, human(ONE.member), add, member(facts({ stampFresh: false })))).toBe(false)
  })

  test('D46 T21: reading your own session ignores the re-authentication method, so a session only a new sign-in mends still loads the shell', () => {
    const read = { action: 'session.read_own' } as const
    // An Owner on a code-only session, or on a PIN-rule session whose PIN was cleared, must sign in
    // again before any admin action, and a Member's stamp may be stale: each still reads who they are
    // and their client flags.
    expect(reauthMethodOf(W, ONE.owner, facts())).toBe('sign_in')
    for (const [id, f] of [
      [ONE.owner, facts()],
      [ONE.owner, facts({ issuedUnderPinRule: true, pinSet: false })],
      [ONE.member, facts({ stampFresh: false })],
    ] as const) {
      expect(reauthenticated(W, id, f), id).toBe(false)
      expect(can(W, human(id), read, { reauthenticated: reauthenticated(W, id, f) }), id).toBe(true)
    }
  })
})
