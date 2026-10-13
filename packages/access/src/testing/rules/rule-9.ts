import { expect } from 'vitest'
import accessPackage from '../../../package.json' with { type: 'json' }
import * as access from '../../index.ts'
import {
  type AdminRequest,
  type ContentAction,
  can,
  type Facts,
  type Id,
  isOwner,
  listAccessible,
  type OrgRole,
  type Ref,
  type Request,
  type RequestContext,
  type ResourceKind,
  type RoleProposalFact,
  type Subject,
  type World,
} from '../../index.ts'
import * as accessSql from '../../sql.ts'
import { AG, AS, agent, assistant, C, CV, FI, human, P, PROPOSAL, R, ref, S, SEED_PEOPLE, system, T } from '../index.ts'
import { ai, c0, core, type RuleCase } from './case.ts'
import { allows, changed, reads, refsOf, world } from './helpers.ts'

type Change = (facts: Facts) => Facts

const everyone = [...SEED_PEOPLE, P.cfo, P.formerDpo, P.formerAdmin]
const reauthenticated = { reauthenticated: true }
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
const CONTENT_ACTIONS: readonly ContentAction[] = [
  'read',
  'post',
  'join',
  'leave',
  'manage',
  'edit',
  'delete',
  'cancel',
  'comment',
  'resolve',
  'view_history',
  'share',
  'present',
  'present_anyway',
  'trash',
  'restore',
  'purge',
  'set_editors_can_share',
  'limit_editing',
  'correct',
  'view_viewed_by',
  'accept',
  'dismiss',
]
// One of every admin request, with targets that exist, so a refusal is never for a missing target.
const ADMIN_REQUESTS: readonly AdminRequest[] = [
  { action: 'role.grant', person: P.priya, role: 'compliance_officer', teamId: null },
  { action: 'role.grant', person: P.nadia, role: 'team_admin', teamId: T.customerSuccess },
  { action: 'role.approve', proposalId: PROPOSAL.priyaDpo },
  { action: 'role.revoke', person: P.weiling, role: 'compliance_officer', teamId: null },
  { action: 'person.add', roles: [], manager: null },
  { action: 'person.set_manager', person: P.nadia, manager: P.marcus },
  { action: 'person.deactivate', person: P.nadia },
  { action: 'person.reset_pin', person: P.nadia },
  { action: 'person.change_phone', person: P.nadia },
  { action: 'person.sign_out_devices', person: P.nadia },
  { action: 'team.create' },
  { action: 'team.archive', team: T.fleet },
  { action: 'team.members.change', team: T.finance, person: P.nadia, op: 'add' },
  { action: 'team.defaults.set', team: T.operations, spaces: [ref.channel(C.ops)] },
  { action: 'org.defaults.set', spaces: [ref.channel(C.general)] },
  { action: 'audit_readers.change', role: 'dpo', op: 'add' },
  { action: 'audit_log.read' },
  { action: 'room.restrict', room: R.lounge },
  { action: 'room.unrestrict', room: R.people },
  { action: 'session.reclassify', session: S.peopleFloor },
  { action: 'recording_policy.set' },
  { action: 'public_creation.set' },
  { action: 'channel.transfer_ownership', channel: C.ops, to: P.marcus },
  { action: 'privileged_console.open', console: 'dpo' },
  { action: 'privileged_console.open', console: 'compliance' },
]
const DPO_CONSOLE = { action: 'privileged_console.open', console: 'dpo' } as const
const COMPLIANCE_CONSOLE = { action: 'privileged_console.open', console: 'compliance' } as const

const steps =
  (...changes: Change[]): Change =>
  f =>
    changes.reduce((acc, change) => change(acc), f)
const withRole =
  (personId: Id, role: OrgRole): Change =>
  f => ({ ...f, roles: [...f.roles, { personId, role, teamId: null, revokedAt: null }] })
const withoutRole =
  (personId: Id, role: OrgRole): Change =>
  f => ({ ...f, roles: f.roles.filter(r => !(r.personId === personId && r.role === role)) })
const revokeRole =
  (personId: Id, role: OrgRole): Change =>
  f => ({ ...f, roles: f.roles.map(r => (r.personId === personId && r.role === role ? { ...r, revokedAt: 2 } : r)) })
const deactivate =
  (personId: Id): Change =>
  f => ({ ...f, people: f.people.map(p => (p.id === personId ? { ...p, deactivatedAt: 2 } : p)) })
const editProposal =
  (id: Id, edit: (p: RoleProposalFact) => RoleProposalFact): Change =>
  f => ({ ...f, roleProposals: f.roleProposals.map(p => (p.id === id ? edit(p) : p)) })
const addProposal =
  (proposal: Omit<RoleProposalFact, 'approvedAt' | 'withdrawnAt'>): Change =>
  f => ({ ...f, roleProposals: [...f.roleProposals, { ...proposal, approvedAt: null, withdrawnAt: null }] })
const approve = (proposalId: Id): AdminRequest => ({ action: 'role.approve', proposalId })

// Everything a subject can read, kind by kind, and every content request it may make, so two
// worlds can be compared for any widening.
function reach(w: World, s: Subject): string[] {
  const readable = KINDS.flatMap(kind => listAccessible(w, s, kind).map(r => `read ${r.kind}:${r.id}`))
  const acts = CONTENT_ACTIONS.flatMap(action =>
    refsOf()
      .filter(r => can(w, s, { action, resource: r }))
      .map(r => `${action} ${r.kind}:${r.id}`),
  )
  return [...readable, ...acts]
}

export const RULE_9: readonly RuleCase[] = [
  c0(
    'R9-01',
    'Rule 9 ADM-12 PDPA-13: holding DPO or Compliance Officer widens no read or content action through can()',
    () => {
      // Ashton is Owner and DPO; Wei Ling is Leadership and Compliance Officer; Kelvin, a Member in
      // no private space, is given both roles. Each is compared with the same world without them.
      const pairs: [World, World, Id, Subject[]][] = [
        [world, changed(withoutRole(P.ashton, 'dpo')), P.ashton, [human(P.ashton), assistant(AS.ashton)]],
        [world, changed(withoutRole(P.weiling, 'compliance_officer')), P.weiling, [human(P.weiling)]],
        [
          changed(steps(withRole(P.kelvin, 'dpo'), withRole(P.kelvin, 'compliance_officer'))),
          world,
          P.kelvin,
          [human(P.kelvin)],
        ],
      ]
      for (const [withRoles, plain, person, subjects] of pairs) {
        expect(withRoles.holds(person, 'dpo') || withRoles.holds(person, 'compliance_officer'), person).toBe(true)
        expect(plain.holds(person, 'dpo') || plain.holds(person, 'compliance_officer'), person).toBe(false)
        for (const s of subjects) {
          const reached = reach(withRoles, s)
          expect(reached.length, s.id).toBeGreaterThan(0)
          expect(reached, `${s.kind} ${s.id}`).toEqual(reach(plain, s))
        }
      }
      // What each still can't open, role and all: DMs, restricted sessions and private items
      // they aren't in.
      const outside: [World, Id, Ref[]][] = [
        [
          world,
          P.ashton,
          [
            ref.dm(CV.farahKelvin),
            ref.groupDm(CV.floor),
            ref.session(S.peopleFloor),
            ref.channel(C.studio),
            ref.file(FI.rachelNotes),
            ref.assistantChat(CV.danielAssistant),
          ],
        ],
        [
          world,
          P.weiling,
          [ref.dm(CV.ashtonPriya), ref.session(S.peopleAshton), ref.groupDm(CV.floor), ref.file(FI.rachelNotes)],
        ],
        [
          pairs[2]?.[0] ?? world,
          P.kelvin,
          [ref.channel(C.leadership), ref.session(S.peopleAshton), ref.dm(CV.ashtonPriya), ref.file(FI.q3Numbers)],
        ],
      ]
      for (const [w, person, items] of outside) {
        for (const item of items) expect(reads(w, person, item), `${person} ${item.id}`).toBe(false)
      }
    },
  ),
  c0('R9-02', 'Rule 9 B.4 BUILD-PLAN C1.11: packages/access exports no privileged, bypass or override path', () => {
    const names = [...Object.keys(access), ...Object.keys(accessSql)]
    expect(names).toContain('can')
    expect(names).toContain('sqlReadableBy')
    for (const name of names) expect(name).not.toMatch(/privileged|bypass|rule_?9|sudo|asAdmin|override|elevat/i)
    // Its entry points are the core, the SQL filter and the test fixture; none opens a way round.
    for (const [entry, target] of Object.entries(accessPackage.exports)) {
      expect(`${entry} ${target}`).not.toMatch(/privileged|bypass|rule_?9|sudo|admin|override/i)
    }
  }),
  c0(
    'R9-02b',
    'Rule 9 B.4 ADM-12: a read that claims a case, a reason or a privileged flag reads nothing more, and an unknown action is refused',
    () => {
      for (const person of [P.ashton, P.weiling]) {
        for (const item of refsOf()) {
          const plain = can(world, human(person), { action: 'read', resource: item })
          const claimed = {
            action: 'read' as const,
            resource: item,
            privileged: true,
            caseId: 'case-1',
            reason: 'access request',
          }
          const context = { reauthenticated: true, privileged: true, caseId: 'case-1' } as RequestContext
          expect(can(world, human(person), claimed as Request, context), `${person} ${item.id}`).toBe(plain)
          for (const action of ['privileged.read', 'read_privileged', 'export', 'redact']) {
            const forged = { action, resource: item } as unknown as Request
            expect(can(world, human(person), forged, context), `${person} ${action} ${item.id}`).toBe(false)
          }
        }
      }
      // So the DPO still can't open the floor 1:1 through can(), however the request is dressed.
      expect(reads(world, P.ashton, ref.session(S.peopleFloor))).toBe(false)
    },
  ),
  c0(
    'R9-03',
    'Rule 9 D16 PA-03 ACC-10: only people hold roles; the Owner’s assistant, agents and system jobs are refused every admin request',
    () => {
      // Ashton, Owner and DPO, may make most of these themselves, so their assistant's refusals matter.
      const ashtons = ADMIN_REQUESTS.filter(r => can(world, human(P.ashton), r, reauthenticated))
      expect(ashtons.length).toBeGreaterThan(15)
      const nonHumans: Subject[] = [...Object.values(AS).map(assistant), ...Object.values(AG).map(agent), system]
      for (const s of nonHumans) {
        for (const r of ADMIN_REQUESTS) expect(can(world, s, r, reauthenticated), `${s.id} ${r.action}`).toBe(false)
        expect(can(world, s, { action: 'devices.sign_out_own' }), s.id).toBe(false)
      }
      // A role row that names an assistant or an agent gives it nothing, whichever kind of subject
      // it is asked as.
      const w = changed(steps(withRole(AS.ashton, 'dpo'), withRole(AS.daniel, 'owner'), withRole(AG.it, 'admin')))
      for (const r of ADMIN_REQUESTS) {
        for (const s of [assistant(AS.ashton), human(AS.ashton), assistant(AS.daniel), agent(AG.it), human(AG.it)]) {
          expect(can(w, s, r, reauthenticated), `${s.kind} ${s.id} ${r.action}`).toBe(false)
        }
      }
    },
  ),
  c0(
    'R9-04',
    'Rule 9 ADM-12 PDPA-13: only the DPO opens the DPO console and only a Compliance Officer the compliance one; the Owner, Admins and Leadership can’t',
    () => {
      // Ashton is the DPO and Wei Ling the Compliance Officer. Someone who left with a DPO role
      // never revoked, and the grantee of a pending DPO proposal (Priya), are refused like anyone.
      for (const p of everyone) {
        expect(allows(world, p, DPO_CONSOLE, reauthenticated), `${p} dpo`).toBe(p === P.ashton)
        expect(allows(world, p, COMPLIANCE_CONSOLE, reauthenticated), `${p} compliance`).toBe(p === P.weiling)
      }
      // The Owner without the DPO role.
      const notDpo = changed(withoutRole(P.ashton, 'dpo'))
      expect(isOwner(notDpo, P.ashton)).toBe(true)
      expect(allows(notDpo, P.ashton, DPO_CONSOLE, reauthenticated)).toBe(false)
      // A revoked Compliance Officer.
      expect(
        allows(changed(revokeRole(P.weiling, 'compliance_officer')), P.weiling, COMPLIANCE_CONSOLE, reauthenticated),
      ).toBe(false)
      // A Member made DPO opens that console, and only that one.
      const kelvinDpo = changed(withRole(P.kelvin, 'dpo'))
      expect(allows(kelvinDpo, P.kelvin, DPO_CONSOLE, reauthenticated)).toBe(true)
      expect(allows(kelvinDpo, P.kelvin, COMPLIANCE_CONSOLE, reauthenticated)).toBe(false)
    },
  ),
  c0(
    'R9-05',
    'Rule 9 PRD-85 ACC-10: a DPO or Compliance Officer grant needs an Owner to propose it and an Owner or Admin who is neither proposer nor grantee to approve it',
    () => {
      // Ashton (Owner) has proposed Priya as DPO.
      const priyaDpo = approve(PROPOSAL.priyaDpo)
      for (const p of everyone) {
        expect(allows(world, p, priyaDpo, reauthenticated), p).toBe(p === P.arjun)
      }
      expect(allows(world, P.arjun, priyaDpo)).toBe(false)
      // A second Owner may approve too.
      expect(allows(changed(withRole(P.ahmad, 'owner')), P.ahmad, priyaDpo, reauthenticated)).toBe(true)
      // Only an Owner proposes; an Admin can't.
      for (const role of ['dpo', 'compliance_officer'] as const) {
        const grant = { action: 'role.grant' as const, person: P.nadia, role, teamId: null }
        expect(allows(world, P.ashton, grant, reauthenticated), role).toBe(true)
        expect(allows(world, P.arjun, grant, reauthenticated), role).toBe(false)
      }
      // Refused: an unknown proposal; one withdrawn or already approved; a proposer no longer an
      // Owner or gone; a grantee gone or already DPO.
      const refused: [string, World, Id][] = [
        ['unknown', world, 'pr-nowhere'],
        ['withdrawn', changed(editProposal(PROPOSAL.priyaDpo, x => ({ ...x, withdrawnAt: 2 }))), PROPOSAL.priyaDpo],
        ['approved', changed(editProposal(PROPOSAL.priyaDpo, x => ({ ...x, approvedAt: 2 }))), PROPOSAL.priyaDpo],
        ['proposer demoted', changed(revokeRole(P.ashton, 'owner')), PROPOSAL.priyaDpo],
        ['proposer left', changed(deactivate(P.ashton)), PROPOSAL.priyaDpo],
        ['grantee left', changed(deactivate(P.priya)), PROPOSAL.priyaDpo],
        ['grantee already DPO', changed(withRole(P.priya, 'dpo')), PROPOSAL.priyaDpo],
      ]
      for (const [why, w, id] of refused) expect(allows(w, P.arjun, approve(id), reauthenticated), why).toBe(false)
      // A proposal an Admin made, not an Owner, can't be approved, and naming an Owner as its
      // proposer in the request changes nothing: the proposer is the stored one.
      const byAdmin = changed(
        addProposal({
          id: 'pr-kelvin-compliance',
          personId: P.kelvin,
          role: 'compliance_officer',
          proposedBy: P.arjun,
        }),
      )
      expect(allows(byAdmin, P.ashton, approve('pr-kelvin-compliance'), reauthenticated)).toBe(false)
      const forged = {
        action: 'role.approve',
        proposalId: 'pr-kelvin-compliance',
        proposedBy: P.ashton,
      } as AdminRequest
      expect(allows(byAdmin, P.ashton, forged, reauthenticated)).toBe(false)
      // A proposal, approved or not, gives its grantee nothing until the role is recorded.
      expect(allows(world, P.priya, DPO_CONSOLE, reauthenticated)).toBe(false)
      const approved = changed(editProposal(PROPOSAL.priyaDpo, x => ({ ...x, approvedAt: 2 })))
      expect(allows(approved, P.priya, DPO_CONSOLE, reauthenticated)).toBe(false)
    },
  ),
  c0(
    'R9-06',
    'Rule 9 ACC-10 D45 T13: nobody grants, approves or revokes their own role, or widens their own access through an admin power',
    () => {
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
      // The Owner grants every Owner-only role to others, never to themselves, and can't drop their own.
      for (const role of ['owner', 'admin', 'ai_admin', 'leadership', 'dpo', 'compliance_officer'] as const) {
        expect(allows(world, P.ashton, grant(P.nadia, role), reauthenticated), role).toBe(true)
        expect(allows(world, P.ashton, grant(P.ashton, role), reauthenticated), role).toBe(false)
      }
      for (const role of ['owner', 'dpo'] as const) {
        expect(allows(world, P.ashton, revoke(P.ashton, role), reauthenticated), role).toBe(false)
      }
      expect(allows(world, P.ashton, revoke(P.weiling, 'compliance_officer'), reauthenticated)).toBe(true)
      // The Compliance Officer and a Team Admin can't drop their own roles either.
      expect(allows(world, P.weiling, revoke(P.weiling, 'compliance_officer'), reauthenticated)).toBe(false)
      expect(allows(world, P.marcus, revoke(P.marcus, 'team_admin', T.operations), reauthenticated)).toBe(false)
      expect(allows(world, P.arjun, revoke(P.marcus, 'team_admin', T.operations), reauthenticated)).toBe(true)
      // The Admin makes others Team Admin, not themselves.
      expect(allows(world, P.arjun, grant(P.kelvin, 'team_admin', T.it), reauthenticated)).toBe(true)
      expect(allows(world, P.arjun, grant(P.arjun, 'team_admin', T.it), reauthenticated)).toBe(false)
      // An Admin named in a proposal can't approve it; another Admin can.
      const arjunProposed = changed(
        steps(
          addProposal({
            id: 'pr-arjun-compliance',
            personId: P.arjun,
            role: 'compliance_officer',
            proposedBy: P.ashton,
          }),
          withRole(P.nadia, 'admin'),
        ),
      )
      expect(allows(arjunProposed, P.arjun, approve('pr-arjun-compliance'), reauthenticated)).toBe(false)
      expect(allows(arjunProposed, P.nadia, approve('pr-arjun-compliance'), reauthenticated)).toBe(true)
      // Nor does an Admin reach further through an admin power: no joining a team themselves, no
      // taking over a private channel they aren't in, no audit-log access for a role they hold (D45).
      const change = { action: 'team.members.change', team: T.finance, op: 'add' } as const
      expect(allows(world, P.arjun, { ...change, person: P.arjun }, reauthenticated)).toBe(false)
      expect(allows(world, P.arjun, { ...change, person: P.nadia }, reauthenticated)).toBe(true)
      expect(
        allows(
          world,
          P.arjun,
          { action: 'channel.transfer_ownership', channel: C.leadership, to: P.arjun },
          reauthenticated,
        ),
      ).toBe(false)
      expect(
        allows(world, P.arjun, { action: 'audit_readers.change', role: 'ai_admin', op: 'add' }, reauthenticated),
      ).toBe(false)
      expect(
        allows(world, P.arjun, { action: 'audit_readers.change', role: 'leadership', op: 'add' }, reauthenticated),
      ).toBe(true)
    },
  ),
  c0(
    'R9-06b',
    'Rule 9 ACC-10 PRD-85: a stored proposal that names its own proposer as grantee can’t be approved, so no Owner promotes themselves',
    () => {
      // The console refuses such a proposal (R9-06), so one in the store is a fault; approving it
      // would still complete a self-promotion, so it is refused too.
      const selfProposed = changed(
        addProposal({
          id: 'pr-ashton-compliance',
          personId: P.ashton,
          role: 'compliance_officer',
          proposedBy: P.ashton,
        }),
      )
      for (const p of everyone) {
        expect(allows(selfProposed, p, approve('pr-ashton-compliance'), reauthenticated), p).toBe(false)
      }
    },
  ),
  c0(
    'R9-07',
    'Rule 9 ACC-04 ACC-06 ADM-02 PRD-85 T13: an Admin can’t deactivate, reset the PIN of or change the phone of the Owner, the DPO, a Compliance Officer or someone proposed as one, but signs out anyone’s devices',
    () => {
      const takeovers = ['person.deactivate', 'person.reset_pin', 'person.change_phone'] as const
      // Ashton is Owner and DPO and Wei Ling Compliance Officer; Kelvin is made DPO only and Nadia
      // Compliance Officer only, so each role is checked on its own.
      const w = changed(steps(withRole(P.kelvin, 'dpo'), withRole(P.nadia, 'compliance_officer')))
      for (const target of [P.ashton, P.weiling, P.kelvin, P.nadia]) {
        for (const action of takeovers) {
          expect(allows(w, P.arjun, { action, person: target }, reauthenticated), `${action} ${target}`).toBe(false)
          // The Owner may, for anyone but themselves.
          expect(allows(w, P.ashton, { action, person: target }, reauthenticated), `${action} ${target}`).toBe(
            target !== P.ashton,
          )
        }
        expect(allows(w, P.arjun, { action: 'person.sign_out_devices', person: target }, reauthenticated), target).toBe(
          true,
        )
      }
      // Without those roles the same people are the Admin's to handle.
      for (const target of [P.kelvin, P.nadia]) {
        for (const action of takeovers) {
          expect(allows(world, P.arjun, { action, person: target }, reauthenticated), `${action} ${target}`).toBe(true)
        }
      }
      // While Kelvin waits as a proposed DPO, the Admin who could approve them can't take over Kelvin's
      // account first (PRD-85's second approver would then be the account's holder).
      const proposed = changed(f => ({
        ...f,
        roleProposals: [
          ...f.roleProposals,
          {
            id: 'pr-kelvin-dpo',
            personId: P.kelvin,
            role: 'dpo',
            proposedBy: P.ashton,
            approvedAt: null,
            withdrawnAt: null,
          },
        ],
      }))
      for (const action of takeovers) {
        expect(allows(proposed, P.arjun, { action, person: P.kelvin }, reauthenticated), action).toBe(false)
        expect(allows(proposed, P.ashton, { action, person: P.kelvin }, reauthenticated), action).toBe(true)
      }
      expect(allows(proposed, P.arjun, { action: 'role.approve', proposalId: 'pr-kelvin-dpo' }, reauthenticated)).toBe(
        true,
      )
      // Members, Team Admins and the Compliance Officer do none of it, signing out included.
      for (const actor of [P.marcus, P.huimin, P.rachel, P.weiling]) {
        for (const action of [...takeovers, 'person.sign_out_devices'] as const) {
          expect(allows(world, actor, { action, person: P.kelvin }, reauthenticated), `${actor} ${action}`).toBe(false)
        }
      }
      // Everyone signs out their own devices, with no re-authentication (ACC-04).
      for (const p of SEED_PEOPLE) expect(allows(world, p, { action: 'devices.sign_out_own' }), p).toBe(true)
    },
  ),
  c0(
    'R9-07b',
    'Rule 9 §9.4 ACC-10: every admin request is refused without a fresh re-authentication, for the Owner, the DPO and the Compliance Officer too',
    () => {
      const holders: [Id, AdminRequest][] = [
        [P.ashton, DPO_CONSOLE],
        [P.ashton, { action: 'role.grant', person: P.priya, role: 'compliance_officer', teamId: null }],
        [P.ashton, { action: 'person.deactivate', person: P.weiling }],
        [P.ashton, { action: 'room.unrestrict', room: R.people }],
        [P.ashton, { action: 'session.reclassify', session: S.peopleAshton }],
        [P.weiling, COMPLIANCE_CONSOLE],
        [P.weiling, { action: 'room.restrict', room: R.lounge }],
        [P.weiling, { action: 'room.unrestrict', room: R.townhall }],
        [P.arjun, approve(PROPOSAL.priyaDpo)],
        [P.arjun, { action: 'person.sign_out_devices', person: P.ashton }],
        [P.arjun, { action: 'team.create' }],
      ]
      for (const [actor, request] of holders) {
        expect(allows(world, actor, request, reauthenticated), `${actor} ${request.action}`).toBe(true)
        for (const context of [undefined, {}, { reauthenticated: false }]) {
          expect(allows(world, actor, request, context), `${actor} ${request.action}`).toBe(false)
        }
      }
      for (const p of everyone) {
        for (const r of ADMIN_REQUESTS) expect(allows(world, p, r), `${p} ${r.action}`).toBe(false)
      }
    },
  ),
  c0(
    'R9-08',
    'Rule 9 REC-21 RMS-48: the viewed-by list goes only to that session’s participants, never to the DPO, a Compliance Officer or an Admin who wasn’t in it',
    () => {
      for (const session of refsOf('session')) {
        const participants = world.get({ kind: 'session', id: session.id })?.participants ?? []
        for (const p of everyone) {
          const expected = participants.includes(p) && reads(world, p, session)
          expect(can(world, human(p), { action: 'view_viewed_by', resource: session }), `${p} ${session.id}`).toBe(
            expected,
          )
        }
        for (const a of Object.values(AS)) {
          expect(can(world, assistant(a), { action: 'view_viewed_by', resource: session })).toBe(false)
        }
      }
      // Wei Ling was invited to the Q4 review but didn't take part: they read it, not who viewed it.
      expect(reads(world, P.weiling, ref.session(S.q4Review))).toBe(true)
      expect(can(world, human(P.weiling), { action: 'view_viewed_by', resource: ref.session(S.q4Review) })).toBe(false)
      expect(can(world, human(P.ashton), { action: 'view_viewed_by', resource: ref.session(S.peopleFloor) })).toBe(
        false,
      )
      expect(can(world, human(P.farah), { action: 'view_viewed_by', resource: ref.session(S.peopleFloor) })).toBe(true)
    },
  ),
  c0(
    'R9-09',
    'Rule 9 PDPA-13 ADM-06 D45: the DPO and Compliance Officer read the audit log only once the org lists their role, never through holding it',
    () => {
      // No role is on the list at first.
      for (const p of everyone) expect(allows(world, p, { action: 'audit_log.read' }, reauthenticated), p).toBe(false)
      const listed = (roles: Facts['auditLogReaders']) => changed(f => ({ ...f, auditLogReaders: roles }))
      const dpoListed = listed(['dpo'])
      for (const p of everyone) {
        expect(allows(dpoListed, p, { action: 'audit_log.read' }, reauthenticated), p).toBe(p === P.ashton)
      }
      const complianceListed = listed(['compliance_officer'])
      for (const p of everyone) {
        expect(allows(complianceListed, p, { action: 'audit_log.read' }, reauthenticated), p).toBe(p === P.weiling)
      }
      // Only an Owner or an Admin changes the list; the DPO and Compliance Officer as such can't.
      const addDpo = { action: 'audit_readers.change', role: 'dpo', op: 'add' } as const
      expect(allows(world, P.ashton, addDpo, reauthenticated)).toBe(true)
      expect(allows(changed(withoutRole(P.ashton, 'owner')), P.ashton, addDpo, reauthenticated)).toBe(false)
      expect(
        allows(
          world,
          P.weiling,
          { action: 'audit_readers.change', role: 'compliance_officer', op: 'add' },
          reauthenticated,
        ),
      ).toBe(false)
    },
  ),
  core(
    'R9-10',
    'C1.11',
    'Rule 9 ADM-12 PDPA-13: a privileged read needs an allowed case type and a stated reason, and every read is logged',
  ),
  core(
    'R9-11',
    'C1.11',
    'Rule 9 BUILD-PLAN C1.11: the Rule 9 module writes no outbox or index rows, runs on its own database role, and only the DPO and Compliance consoles import it',
  ),
  core(
    'R9-12',
    'C2.10',
    'Rule 9 ADM-12 REC-07: the Rule 9 console reaches sessions, recordings and restricted rooms only against a case',
  ),
  core(
    'R9-13',
    'C2.10',
    'Rule 9 REC-21 Q10: views made under privileged access appear in the viewed-by list only if Q10 is answered yes; until then only in the audit log',
  ),
  core(
    'R9-14',
    'C2.11',
    'Rule 9 REC-18: redacting content outside the actor’s normal access goes through a Rule 9 case',
  ),
  core(
    'R9-15',
    'C6.1',
    'Rule 9 ADM-09 PDPA-05: a whole-org export goes only through the Rule 9 module; a person’s own export holds only what they can open',
  ),
  core('R9-16', 'C0.16', 'Rule 9 PRD-85: a DPO or Compliance Officer grant alerts the DPO and writes an audit event'),
  ai(
    'R9-17',
    'A1.3',
    'Rule 9 PDPA-08: attaching a transcript or AI note to a case shows the machine-generated warning and logs the purpose',
  ),
  ai(
    'R9-18',
    'A2.3, A2.4',
    'Rule 9 B.4: retrieval implements Rules 1 to 8 and never returns content only privileged access can reach',
  ),
]
