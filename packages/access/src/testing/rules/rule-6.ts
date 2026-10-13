import { expect } from 'vitest'
import {
  aclOf,
  can,
  canRead,
  type Facts,
  type FileFact,
  type FolderFact,
  filterReadable,
  type Id,
  keysOf,
  listAccessible,
  type OrgRole,
  type Ref,
  type Request,
  type RequestContext,
  type ResourceKind,
  type World,
} from '../../index.ts'
import {
  AG,
  AS,
  agent,
  assistant,
  C,
  CM,
  CV,
  E,
  F,
  FI,
  human,
  M,
  P,
  R,
  ref,
  S,
  SEED_PEOPLE,
  T,
  TH,
  TK,
} from '../index.ts'
import { ai, c0, core, type RuleCase } from './case.ts'
import { allows, changed, expectReaders, reads, refsOf, rowReadable, world } from './helpers.ts'

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

// The changes a case makes to the fixture, as the database would record them.
const same: Change = f => f
const steps =
  (...changes: Change[]): Change =>
  f =>
    changes.reduce((acc, change) => change(acc), f)
// Someone's open span in a space ends after message `at`.
const leave =
  (spaceId: Id, person: Id, at: number): Change =>
  f => ({
    ...f,
    memberships: f.memberships.map(m =>
      m.spaceId === spaceId && m.principalId === person && m.throughSeq === null ? { ...m, throughSeq: at } : m,
    ),
  })
const join =
  (spaceId: Id, person: Id, after: number): Change =>
  f => ({
    ...f,
    memberships: [
      ...f.memberships,
      { id: `mb:${spaceId}:${person}:${after}`, spaceId, principalId: person, afterSeq: after, throughSeq: null },
    ],
  })
const joinTeam =
  (teamId: Id, person: Id): Change =>
  f => ({ ...f, teamMembers: [...f.teamMembers, { teamId, personId: person, removedAt: null }] })
const leaveTeam =
  (teamId: Id, person: Id): Change =>
  f => ({
    ...f,
    teamMembers: f.teamMembers.map(m =>
      m.teamId === teamId && m.personId === person && m.removedAt === null ? { ...m, removedAt: 2 } : m,
    ),
  })
const deactivate =
  (person: Id): Change =>
  f => ({ ...f, people: f.people.map(x => (x.id === person ? { ...x, deactivatedAt: 2 } : x)) })
const grantRole =
  (person: Id, role: OrgRole, teamId: Id | null = null): Change =>
  f => ({ ...f, roles: [...f.roles, { personId: person, role, teamId, revokedAt: null }] })
const revoke =
  (person: Id, role: OrgRole): Change =>
  f => ({
    ...f,
    roles: f.roles.map(r =>
      r.personId === person && r.role === role && r.revokedAt === null ? { ...r, revokedAt: 2 } : r,
    ),
  })
const editFile =
  (id: Id, change: (file: FileFact) => FileFact): Change =>
  f => ({ ...f, files: f.files.map(x => (x.id === id ? change(x) : x)) })
const editFolder =
  (id: Id, change: (folder: FolderFact) => FolderFact): Change =>
  f => ({ ...f, folders: f.folders.map(x => (x.id === id ? change(x) : x)) })
const person = (id: Id) => ({ kind: 'person' as const, id })

const keyOf = (r: Ref) => `${r.kind}:${r.id}`

// R6-09's inputs. A membership, team, role or deactivation change changes people's keys and no
// stored row; a grant, visibility, move, trash or restore changes the rows named, and only those.
// Each names someone whose access to one item it flips, so no input passes with nothing to check.
interface Input {
  input: string
  before: Change
  after: Change
  person: Id
  flips: Ref
}
const TRASH_Q4: Change = editFolder(F.q4, x => ({ ...x, trashedAt: 2, trashedById: P.priya }))
const NADIA_TRASHES_CHECKLIST: Change = steps(
  joinTeam(T.people, P.nadia),
  editFile(FI.checklist, x => ({ ...x, trashedAt: 2, trashedById: P.nadia })),
)
const KEY_INPUTS: readonly Input[] = [
  {
    input: 'leaving a private channel',
    before: same,
    after: leave(C.leadership, P.huimin, 2),
    person: P.huimin,
    flips: ref.message(M.leadership),
  },
  {
    input: 'joining a private channel',
    before: same,
    after: join(C.leadership, P.nadia, 2),
    person: P.nadia,
    flips: ref.message(M.leadership),
  },
  {
    input: 'leaving a private standalone room',
    before: same,
    after: leave(R.board, P.weiling, 0),
    person: P.weiling,
    flips: ref.room(R.board),
  },
  {
    input: 'leaving a group DM',
    before: same,
    after: leave(CV.q4, P.ahmad, 6),
    person: P.ahmad,
    flips: ref.message(M.q4First),
  },
  {
    input: 'rejoining a group DM',
    before: leave(CV.q4, P.ahmad, 6),
    after: join(CV.q4, P.ahmad, 7),
    person: P.ahmad,
    flips: ref.message(M.q4First),
  },
  {
    input: 'leaving a team',
    before: same,
    after: leaveTeam(T.q4, P.weiling),
    person: P.weiling,
    flips: ref.file(FI.q4Deck),
  },
  {
    input: 'joining a team',
    before: same,
    after: joinTeam(T.q4, P.nadia),
    person: P.nadia,
    flips: ref.file(FI.q4Deck),
  },
  {
    input: 'a Team Admin role granted',
    before: same,
    after: grantRole(P.nadia, 'team_admin', T.people),
    person: P.nadia,
    flips: ref.file(FI.checklist),
  },
  {
    input: 'a Team Admin role revoked',
    before: grantRole(P.nadia, 'team_admin', T.people),
    after: revoke(P.nadia, 'team_admin'),
    person: P.nadia,
    flips: ref.file(FI.checklist),
  },
  {
    input: 'deactivation',
    before: same,
    after: deactivate(P.daniel),
    person: P.daniel,
    flips: ref.file(FI.q4Proposal),
  },
  {
    input: 'the person who trashed an item leaving the team that gave them access',
    before: NADIA_TRASHES_CHECKLIST,
    after: leaveTeam(T.people, P.nadia),
    person: P.nadia,
    flips: ref.file(FI.checklist),
  },
]
const Q4_TREE: readonly Ref[] = [
  ref.folder(F.q4),
  ref.folder(F.q4Contract),
  ref.file(FI.q4Proposal),
  ref.file(FI.forecast),
  ref.file(FI.q4Deck),
  ref.file(FI.msa),
  ref.comment(CM.q4Daniel),
  ref.comment(CM.q4Ahmad),
  // Made from the forecast and an #ops-north-site message (Rule 3), so its row follows the sheet's.
  ref.derived('dv-ops-and-forecast'),
]
const ACL_INPUTS: readonly (Input & { rows: readonly Ref[] })[] = [
  {
    input: 'a person’s grant removed',
    before: same,
    after: editFile(FI.q3Numbers, x => ({ ...x, grants: x.grants.filter(g => g.grantee.id !== P.weiling) })),
    rows: [ref.file(FI.q3Numbers)],
    person: P.weiling,
    flips: ref.file(FI.q3Numbers),
  },
  {
    input: 'a team grant added',
    before: same,
    after: editFile(FI.rachelNotes, x => ({
      ...x,
      grants: [{ grantee: { kind: 'team', id: T.sales }, role: 'viewer' }],
    })),
    rows: [ref.file(FI.rachelNotes)],
    person: P.ahmad,
    flips: ref.file(FI.rachelNotes),
  },
  {
    input: 'a folder grant removed',
    before: same,
    after: editFolder(F.board, x => ({ ...x, grants: [] })),
    rows: [ref.folder(F.board), ref.file(FI.boardUpdate), ref.file(FI.q3Pdf)],
    person: P.cfo,
    flips: ref.file(FI.boardUpdate),
  },
  {
    input: 'a public channel made private',
    before: same,
    after: f => ({
      ...f,
      channels: f.channels.map(c => (c.id === C.design ? { ...c, visibility: 'private' as const } : c)),
    }),
    rows: [ref.channel(C.design), ref.room(R.design), ref.message(M.design), ref.session(S.designShort)],
    person: P.nadia,
    flips: ref.message(M.design),
  },
  {
    input: 'a file moved out of its folder',
    before: same,
    after: editFile(FI.q4Proposal, x => ({ ...x, parent: { kind: 'root' } })),
    rows: [ref.file(FI.q4Proposal), ref.comment(CM.q4Daniel), ref.comment(CM.q4Ahmad)],
    person: P.weiling,
    flips: ref.file(FI.q4Proposal),
  },
  {
    input: 'a folder moved',
    before: same,
    after: editFolder(F.q4Contract, x => ({ ...x, parentId: null })),
    rows: [ref.folder(F.q4Contract), ref.file(FI.msa)],
    person: P.weiling,
    flips: ref.file(FI.msa),
  },
  {
    input: 'a folder trashed',
    before: same,
    after: TRASH_Q4,
    rows: Q4_TREE,
    person: P.weiling,
    flips: ref.file(FI.q4Deck),
  },
  {
    input: 'a folder restored',
    before: TRASH_Q4,
    after: editFolder(F.q4, x => ({ ...x, trashedAt: null, trashedById: null })),
    rows: Q4_TREE,
    person: P.weiling,
    flips: ref.file(FI.q4Deck),
  },
]

// Whether a request is allowed before and after a change.
function beforeAfter(
  w0: World,
  w1: World,
  subject: Id,
  request: Request,
  context: RequestContext = reauthenticated,
): boolean[] {
  return [allows(w0, subject, request, context), allows(w1, subject, request, context)]
}

export const RULE_6: readonly RuleCase[] = [
  c0(
    'R6-01',
    'Rule 6 CHAT-01: leaving a private channel or room ends reading it, its messages and its room on the next call',
    () => {
      // Hui Min leaves #leadership.
      const left = changed(leave(C.leadership, P.huimin, 2))
      for (const item of [
        ref.channel(C.leadership),
        ref.message(M.leadership),
        ref.message(M.digest),
        ref.room(R.leadershipOneOnOnes),
      ]) {
        expect(reads(world, P.huimin, item), item.id).toBe(true)
        expect(reads(left, P.huimin, item), item.id).toBe(false)
        expect(reads(left, P.priya, item), item.id).toBe(true)
      }
      expect(can(left, human(P.huimin), { action: 'post', resource: ref.channel(C.leadership) })).toBe(false)
      expect(can(left, human(P.huimin), { action: 'join', resource: ref.room(R.leadershipOneOnOnes) })).toBe(false)
      // Wei Ling leaves the private Board room.
      const roomLeft = changed(leave(R.board, P.weiling, 0))
      expect(reads(world, P.weiling, ref.room(R.board))).toBe(true)
      expect(reads(roomLeft, P.weiling, ref.room(R.board))).toBe(false)
      expect(can(roomLeft, human(P.weiling), { action: 'join', resource: ref.room(R.board) })).toBe(false)
    },
  ),
  c0(
    'R6-01b',
    'Rule 6 REC-15 REC-21: a participant who leaves a private channel or room can no longer read, correct or see who viewed its sessions',
    () => {
      const actions = ['read', 'correct', 'view_viewed_by'] as const
      // The design crit's short session, held in #design's room, with #design made private; Rachel leaves.
      const privateDesign: Change = f => ({
        ...f,
        channels: f.channels.map(c => (c.id === C.design ? { ...c, visibility: 'private' as const } : c)),
      })
      const stayed = changed(privateDesign)
      const left = changed(steps(privateDesign, leave(C.design, P.rachel, 1)))
      const crit = ref.session(S.designShort)
      for (const action of actions) {
        expect(can(stayed, human(P.rachel), { action, resource: crit }), action).toBe(true)
        expect(can(left, human(P.rachel), { action, resource: crit }), action).toBe(false)
        expect(can(left, human(P.daniel), { action, resource: crit }), action).toBe(true)
      }
      // Marcus leaves the People 1:1s room, where they took part in a session recorded before the
      // room was restricted.
      const roomLeft = changed(leave(R.people, P.marcus, 1))
      const before = ref.session(S.peopleBefore)
      for (const action of actions) {
        expect(can(world, human(P.marcus), { action, resource: before }), action).toBe(true)
        expect(can(roomLeft, human(P.marcus), { action, resource: before }), action).toBe(false)
        expect(can(roomLeft, human(P.huimin), { action, resource: before }), action).toBe(true)
      }
      // Participants who can still read their sessions keep correcting them, in a meeting and a call;
      // an invitee who didn't take part reads but doesn't correct.
      expect(can(world, human(P.rachel), { action: 'correct', resource: ref.session(S.pricing) })).toBe(true)
      expect(can(world, human(P.daniel), { action: 'correct', resource: ref.session(S.q4Call) })).toBe(true)
      expect(reads(world, P.ahmad, ref.session(S.q4Review))).toBe(true)
      expect(can(world, human(P.ahmad), { action: 'correct', resource: ref.session(S.q4Review) })).toBe(false)
    },
  ),
  c0(
    'R6-01c',
    'Rule 6 CHAT-01 PRD-35: a public channel stays readable by the whole org, so leaving it ends posting, not reading',
    () => {
      // Kelvin leaves #ops-north-site, which anyone in the org may read or rejoin.
      const left = changed(leave(C.ops, P.kelvin, 6))
      expect(can(world, human(P.kelvin), { action: 'post', resource: ref.channel(C.ops) })).toBe(true)
      expect(can(left, human(P.kelvin), { action: 'post', resource: ref.channel(C.ops) })).toBe(false)
      expect(reads(left, P.kelvin, ref.message(M.ops1))).toBe(true)
      expect(can(left, human(P.kelvin), { action: 'join', resource: ref.channel(C.ops) })).toBe(true)
    },
  ),
  c0('R6-02', 'Rule 6 FILE-03 DOC-03: removal from a doc, sheet or deck ends access on the next call', () => {
    // A doc: Rachel shares their notes with Nadia as an Editor, then takes it back.
    const notes = ref.file(FI.rachelNotes)
    const shared = changed(
      editFile(FI.rachelNotes, x => ({ ...x, grants: [{ grantee: person(P.nadia), role: 'editor' }] })),
    )
    for (const action of ['read', 'comment', 'edit'] as const) {
      expect(can(shared, human(P.nadia), { action, resource: notes }), action).toBe(true)
      expect(can(world, human(P.nadia), { action, resource: notes }), action).toBe(false)
    }
    // A sheet: the CFO removes Wei Ling from the Q3 numbers; Ashton's own grant stays.
    const sheet = ref.file(FI.q3Numbers)
    const unshared = changed(
      editFile(FI.q3Numbers, x => ({ ...x, grants: x.grants.filter(g => g.grantee.id !== P.weiling) })),
    )
    expect(reads(world, P.weiling, sheet)).toBe(true)
    expectReaders(unshared, sheet, [P.cfo, P.ashton], [P.weiling])
    // A deck: the all-hands deck stops being shared with the whole org; its owner and Ashton keep it.
    const deck = ref.file(FI.allHandsDeck)
    const closed = changed(
      editFile(FI.allHandsDeck, x => ({ ...x, grants: x.grants.filter(g => g.grantee.kind !== 'org') })),
    )
    expect(reads(world, P.nadia, deck)).toBe(true)
    expectReaders(closed, deck, [P.huimin, P.ashton], [P.nadia, P.kelvin, P.cfo])
    expect(can(closed, human(P.nadia), { action: 'present', resource: deck })).toBe(false)
  }),
  c0('R6-03', 'Rule 6 ACC-05: deactivation ends all access and every role power at once', () => {
    // Arjun, Admin and AI Admin, is offboarded.
    const gone = changed(deactivate(P.arjun))
    expect(keysOf(gone, human(P.arjun))).toEqual([])
    expect(listAccessible(world, human(P.arjun), 'channel').length).toBeGreaterThan(0)
    for (const kind of KINDS) expect(listAccessible(gone, human(P.arjun), kind), kind).toEqual([])
    const powers: Request[] = [
      { action: 'team.create' },
      { action: 'room.restrict', room: R.lounge },
      { action: 'recording_policy.set' },
      { action: 'person.deactivate', person: P.nadia },
      { action: 'role.grant', person: P.nadia, role: 'team_admin', teamId: T.sales },
    ]
    for (const request of powers)
      expect(beforeAfter(world, gone, P.arjun, request), request.action).toEqual([true, false])
    expect(beforeAfter(world, gone, P.arjun, { action: 'devices.sign_out_own' }, {})).toEqual([true, false])
    // Ashton, Owner and DPO, is offboarded: their assistant goes dark and the DPO console closes to them.
    const ownerGone = changed(deactivate(P.ashton))
    expect(keysOf(world, assistant(AS.ashton)).length).toBeGreaterThan(0)
    expect(keysOf(ownerGone, assistant(AS.ashton))).toEqual([])
    const ownerPowers: Request[] = [
      { action: 'privileged_console.open', console: 'dpo' },
      { action: 'session.reclassify', session: S.peopleAshton },
      { action: 'role.grant', person: P.nadia, role: 'leadership', teamId: null },
      { action: 'room.unrestrict', room: R.people },
    ]
    for (const request of ownerPowers) {
      expect(beforeAfter(world, ownerGone, P.ashton, request), request.action).toEqual([true, false])
    }
    // Someone who left with their DPO role never revoked holds none of its powers.
    expect(allows(world, P.formerDpo, { action: 'privileged_console.open', console: 'dpo' }, reauthenticated)).toBe(
      false,
    )
  }),
  c0(
    'R6-03b',
    'Rule 6 ACC-05 T13: a deactivated participant, organiser, task creator, channel owner or item owner is refused every action they had',
    () => {
      // Priya organises the Q4 review, owns #ops-north-site and the Q4 proposal, posted in
      // #ops-north-site and took part in its standup; Wei Ling created the price-sheet task.
      const gone = changed(steps(deactivate(P.priya), deactivate(P.weiling)))
      const theirs: [Id, Request][] = [
        [P.priya, { action: 'correct', resource: ref.session(S.standupFri) }],
        [P.priya, { action: 'view_viewed_by', resource: ref.session(S.standupFri) }],
        [P.priya, { action: 'edit', resource: ref.event(E.q4) }],
        [P.priya, { action: 'cancel', resource: ref.event(E.q4) }],
        [P.priya, { action: 'manage', resource: ref.channel(C.ops) }],
        [P.priya, { action: 'post', resource: ref.channel(C.ops) }],
        [P.priya, { action: 'edit', resource: ref.message(M.ops4) }],
        [P.priya, { action: 'edit', resource: ref.file(FI.q4Proposal) }],
        [P.priya, { action: 'share', resource: ref.file(FI.q4Proposal) }],
        [P.priya, { action: 'trash', resource: ref.file(FI.q4Proposal) }],
        [P.priya, { action: 'create', kind: 'task' }],
        [P.weiling, { action: 'delete', resource: ref.task(TK.sheet) }],
        [P.weiling, { action: 'edit', resource: ref.file(FI.forecast) }],
      ]
      for (const [who, request] of theirs) {
        expect(beforeAfter(world, gone, who, request, {}), `${who} ${request.action}`).toEqual([true, false])
      }
    },
  ),
  c0('R6-04', 'Rule 6 ACC-07 DOC-03: leaving a team ends what was shared with the team, at once', () => {
    // Kelvin leaves Operations: Editor on the Operations wiki drops to the org's Viewer, and the
    // team's task closes to them.
    const kelvin = changed(leaveTeam(T.operations, P.kelvin))
    expect(keysOf(kelvin, human(P.kelvin))).not.toContain(`t:${T.operations}`)
    expect(beforeAfter(world, kelvin, P.kelvin, { action: 'edit', resource: ref.file(FI.otRoster) }, {})).toEqual([
      true,
      false,
    ])
    expect(beforeAfter(world, kelvin, P.kelvin, { action: 'create', kind: 'file', in: ref.folder(F.ops) }, {})).toEqual(
      [true, false],
    )
    expect(reads(kelvin, P.kelvin, ref.file(FI.otRoster))).toBe(true)
    expect(reads(world, P.kelvin, ref.task(TK.ot))).toBe(true)
    expect(reads(kelvin, P.kelvin, ref.task(TK.ot))).toBe(false)
    // Wei Ling leaves the Q4 launch team: the Q4 folder's grant no longer reaches them, though they
    // still own their forecast in it.
    const weiling = changed(leaveTeam(T.q4, P.weiling))
    for (const file of [FI.q4Proposal, FI.q4Deck, FI.msa]) {
      expect(reads(world, P.weiling, ref.file(file)), file).toBe(true)
      expect(reads(weiling, P.weiling, ref.file(file)), file).toBe(false)
    }
    expect(reads(weiling, P.weiling, ref.file(FI.forecast))).toBe(true)
    // Farah leaves the archived Night shift team: its rota closes to them, not to Kelvin.
    const farah = changed(leaveTeam(T.nightShift, P.farah))
    expect(reads(world, P.farah, ref.file(FI.nightRota))).toBe(true)
    expectReaders(farah, ref.file(FI.nightRota), [P.kelvin], [P.farah])
  }),
  core('R6-04b', 'C1.1', 'Rule 6 ACC-07: leaving a team leaves its private default channels and rooms'),
  c0(
    'R6-05',
    'Rule 6 FILE-03 DRV-02: removing a folder’s grant, or moving an item out of the folder, ends what the folder gave',
    () => {
      // The CFO edits the board pack through the folder's grant; Ashton removes it.
      const ungranted = changed(editFolder(F.board, x => ({ ...x, grants: [] })))
      for (const file of [FI.boardUpdate, FI.q3Pdf]) {
        expect(reads(world, P.cfo, ref.file(file)), file).toBe(true)
        expectReaders(ungranted, ref.file(file), [P.ashton], [P.cfo])
      }
      // The Q4 proposal moves to Priya's My Drive: the Q4 team's grant no longer reaches it, nor its
      // comments; Daniel's and Ashton's own grants still do.
      const moved = changed(editFile(FI.q4Proposal, x => ({ ...x, parent: { kind: 'root' } })))
      expectReaders(world, ref.file(FI.q4Proposal), [P.weiling, P.ahmad], [])
      expectReaders(moved, ref.file(FI.q4Proposal), [P.priya, P.daniel, P.ashton], [P.weiling, P.ahmad])
      expect(reads(moved, P.weiling, ref.comment(CM.q4Daniel))).toBe(false)
      // A folder moved out takes its contents with it: Ahmad's contract folder leaves the Q4 folder,
      // and Priya, who owns the Q4 folder, is no longer an Editor of what it held.
      const folderMoved = changed(editFolder(F.q4Contract, x => ({ ...x, parentId: null })))
      expectReaders(folderMoved, ref.file(FI.msa), [P.ahmad], [P.priya, P.weiling, P.daniel, P.ashton])
      expect(beforeAfter(world, folderMoved, P.priya, { action: 'edit', resource: ref.file(FI.msa) }, {})).toEqual([
        true,
        false,
      ])
    },
  ),
  c0(
    'R6-05b',
    'Rule 6 DRV-01 DRV-18: whoever trashed an item can’t read or restore it once their grant is removed; its owner still can',
    () => {
      // Priya, an Editor of Ashton's movers sheet (directly and through the vendor folder), trashes it.
      const sheet = ref.file(FI.movers)
      const trashed: Change = editFile(FI.movers, x => ({ ...x, trashedAt: 2, trashedById: P.priya }))
      const w = changed(trashed)
      expectReaders(w, sheet, [P.ashton, P.priya], [P.nadia, P.weiling])
      expect(can(w, human(P.priya), { action: 'restore', resource: sheet })).toBe(true)
      // Ashton removes both of Priya's grants.
      const ungranted = changed(
        steps(
          trashed,
          editFile(FI.movers, x => ({ ...x, grants: [] })),
          editFolder(F.vendor, x => ({ ...x, grants: [] })),
        ),
      )
      expect(reads(ungranted, P.priya, sheet)).toBe(false)
      expect(can(ungranted, human(P.priya), { action: 'restore', resource: sheet })).toBe(false)
      for (const action of ['read', 'restore', 'purge'] as const) {
        expect(can(ungranted, human(P.ashton), { action, resource: sheet }), action).toBe(true)
      }
    },
  ),
  c0(
    'R6-05c',
    'Rule 6 DRV-18: whoever trashed an item and is moved down to Viewer still reads it but can’t restore it',
    () => {
      const sheet = ref.file(FI.movers)
      const viewer = [{ grantee: person(P.priya), role: 'viewer' as const }]
      const w = changed(
        steps(
          editFile(FI.movers, x => ({ ...x, trashedAt: 2, trashedById: P.priya, grants: viewer })),
          editFolder(F.vendor, x => ({ ...x, grants: viewer })),
        ),
      )
      expect(reads(w, P.priya, sheet)).toBe(true)
      expect(can(w, human(P.priya), { action: 'restore', resource: sheet })).toBe(false)
      expect(can(w, human(P.priya), { action: 'purge', resource: sheet })).toBe(false)
    },
  ),
  c0(
    'R6-05d',
    'Rule 6 ACC-07 DRV-01: whoever trashed an item through a team’s grant loses it when they leave the team',
    () => {
      // Nadia joins People, trashes Hui Min's day-one checklist from the People folder, then leaves.
      const checklist = ref.file(FI.checklist)
      const w = changed(NADIA_TRASHES_CHECKLIST)
      expectReaders(w, checklist, [P.nadia, P.huimin], [P.ashton, P.kelvin])
      expect(can(w, human(P.nadia), { action: 'restore', resource: checklist })).toBe(true)
      const left = changed(steps(NADIA_TRASHES_CHECKLIST, leaveTeam(T.people, P.nadia)))
      expect(reads(left, P.nadia, checklist)).toBe(false)
      expect(can(left, human(P.nadia), { action: 'restore', resource: checklist })).toBe(false)
      expect(can(left, human(P.huimin), { action: 'restore', resource: checklist })).toBe(true)
    },
  ),
  c0('R6-06', 'Rule 6 ACC-10 ADM-02: a revoked role’s powers end on the next request', () => {
    // Arjun's Admin role is revoked; they keep AI Admin, which grants nothing yet.
    const admin = changed(revoke(P.arjun, 'admin'))
    const adminPowers: Request[] = [
      { action: 'team.create' },
      { action: 'room.restrict', room: R.lounge },
      { action: 'person.deactivate', person: P.nadia },
      { action: 'public_creation.set' },
      { action: 'team.members.change', team: T.sales, person: P.nadia, op: 'add' },
    ]
    for (const request of adminPowers) {
      expect(beforeAfter(world, admin, P.arjun, request), request.action).toEqual([true, false])
      // The fixture's revoked Admin holds none of them either.
      expect(allows(world, P.formerAdmin, request, reauthenticated), request.action).toBe(false)
    }
    // Creating a public channel went with the role (the fixture lets Admins only).
    expect(beforeAfter(world, admin, P.arjun, { action: 'create', kind: 'channel', visibility: 'public' }, {})).toEqual(
      [true, false],
    )
    // Wei Ling's Compliance Officer role is revoked.
    const co = changed(revoke(P.weiling, 'compliance_officer'))
    const coPowers: Request[] = [
      { action: 'room.unrestrict', room: R.people },
      { action: 'room.restrict', room: R.lounge },
      { action: 'session.reclassify', session: S.peopleFloor },
      { action: 'privileged_console.open', console: 'compliance' },
    ]
    for (const request of coPowers) {
      expect(beforeAfter(world, co, P.weiling, request), request.action).toEqual([true, false])
    }
    // Marcus's Team Admin role for Operations is revoked: they no longer act as Owner of the team's
    // items or change its members.
    const ta = changed(revoke(P.marcus, 'team_admin'))
    expect(keysOf(ta, human(P.marcus))).not.toContain(`ta:${T.operations}`)
    expect(beforeAfter(world, ta, P.marcus, { action: 'limit_editing', resource: ref.file(FI.opsPolicy) }, {})).toEqual(
      [true, false],
    )
    expect(
      beforeAfter(world, ta, P.marcus, {
        action: 'team.members.change',
        team: T.operations,
        person: P.nadia,
        op: 'add',
      }),
    ).toEqual([true, false])
    // A revoked role can't be revoked again.
    expect(
      beforeAfter(world, admin, P.ashton, { action: 'role.revoke', person: P.arjun, role: 'admin', teamId: null }),
    ).toEqual([true, false])
  }),
  c0(
    'R6-07',
    'Rule 6 decision 10 PRD-79: leaving a group DM ends every era of it at once; rejoining reopens only the person’s own eras',
    () => {
      const q4 = [M.q4First, M.q4Second, M.q4Third, M.q4Fourth, M.q4Fifth].map(ref.message)
      // Ahmad, in their second era (their first ran to message 3), leaves after message 6.
      const left = changed(leave(CV.q4, P.ahmad, 6))
      expect(q4.map(m => reads(world, P.ahmad, m))).toEqual([true, true, true, false, true])
      expect(q4.map(m => reads(left, P.ahmad, m))).toEqual([false, false, false, false, false])
      expect(reads(left, P.ahmad, ref.groupDm(CV.q4))).toBe(false)
      expect(reads(left, P.ahmad, ref.file(FI.q4Attachment))).toBe(false)
      expect(keysOf(left, human(P.ahmad)).filter(t => t.startsWith('e:') || t === `m:${CV.q4}`)).toEqual([])
      expect(can(left, human(P.ahmad), { action: 'post', resource: ref.groupDm(CV.q4) })).toBe(false)
      expect(q4.map(m => reads(left, P.priya, m))).toEqual([true, true, true, true, true])
      // Ahmad is added back later: their own earlier eras open again; what was posted while they were out
      // stays closed.
      const back = changed(steps(leave(CV.q4, P.ahmad, 6), join(CV.q4, P.ahmad, 7)))
      expect(q4.map(m => reads(back, P.ahmad, m))).toEqual([true, true, true, false, true])
      expect(reads(back, P.ahmad, ref.file(FI.q4Attachment))).toBe(true)
      // Neither the leave nor the rejoin rewrote a stored message row.
      for (const m of q4) {
        expect(aclOf(left, m), m.id).toEqual(aclOf(world, m))
        expect(aclOf(back, m), m.id).toEqual(aclOf(world, m))
      }
    },
  ),
  c0(
    'R6-08',
    'Rule 6 BRAIN-02 SRCH-04: a stored row written before a grant was removed is dropped by the live re-check',
    () => {
      // Rachel shared their notes with Nadia, and the row was stored then; Rachel has since removed Nadia.
      const doc = ref.file(FI.rachelNotes)
      const shared = changed(
        editFile(FI.rachelNotes, x => ({ ...x, grants: [{ grantee: person(P.nadia), role: 'viewer' }] })),
      )
      const stale = aclOf(shared, doc)
      const nadiaNow = keysOf(world, human(P.nadia))
      // Until C4.1's re-ACL job rewrites it, the row still names Nadia, so the SQL pre-filter alone
      // would let it through ...
      expect(rowReadable(stale, nadiaNow)).toBe(true)
      // ... and the live re-check after it drops it, so Nadia never sees it.
      expect(filterReadable(world, human(P.nadia), [doc])).toEqual([])
      expect(filterReadable(world, human(P.rachel), [doc])).toEqual([doc])
      // Rewritten, the row agrees.
      expect(rowReadable(aclOf(world, doc), nadiaNow)).toBe(false)
    },
  ),
  c0(
    'R6-09',
    'Rule 6 BRAIN-02 C4.1 T3: a membership, team, role or deactivation change changes keysOf, and the stored rows already refuse leavers',
    () => {
      const refs = refsOf()
      for (const { input, before, after, person: who, flips } of KEY_INPUTS) {
        const w0 = changed(before)
        const w1 = changed(steps(before, after))
        expect(reads(w1, who, flips), input).not.toBe(reads(w0, who, flips))
        expect(keysOf(w1, human(who)), input).not.toEqual(keysOf(w0, human(who)))
        const keys = new Map(everyone.map(p => [p, keysOf(w1, human(p))]))
        for (const r of refs) {
          // No stored row changes, so no re-ACL is needed ...
          const row = aclOf(w0, r)
          expect(aclOf(w1, r), `${input}: ${keyOf(r)}`).toEqual(row)
          // ... because the old rows, read with the new keys, already give the live answer.
          for (const p of everyone) {
            expect(rowReadable(row, keys.get(p) ?? []), `${input}: ${p} ${keyOf(r)}`).toBe(canRead(w1, human(p), r))
          }
        }
      }
    },
  ),
  c0(
    'R6-09b',
    'Rule 6 BRAIN-02 C4.1 T3: a grant, visibility, move, trash or restore changes aclOf for the item, everything under it and everything made from it, and no one’s keys',
    () => {
      const refs = refsOf()
      for (const { input, before, after, rows, person: who, flips } of ACL_INPUTS) {
        const w0 = changed(before)
        const w1 = changed(steps(before, after))
        expect(reads(w1, who, flips), input).not.toBe(reads(w0, who, flips))
        const keys = new Map(everyone.map(p => [p, keysOf(w1, human(p))]))
        for (const p of everyone) expect(keys.get(p), `${input}: ${p}`).toEqual(keysOf(w0, human(p)))
        // Exactly these rows change: the ones C4.1's re-ACL job must rewrite.
        const rewritten = refs.filter(r => JSON.stringify(aclOf(w1, r)) !== JSON.stringify(aclOf(w0, r)))
        expect(rewritten.map(keyOf).sort(), input).toEqual(rows.map(keyOf).sort())
        // Until it does, the old row gives the old answer, which the live re-check corrects (R6-08).
        expect(rowReadable(aclOf(w0, flips), keysOf(w1, human(who))), input).toBe(reads(w0, who, flips))
        // Rewritten, every row agrees with can().
        for (const r of refs) {
          const row = aclOf(w1, r)
          for (const p of everyone) {
            expect(rowReadable(row, keys.get(p) ?? []), `${input}: ${p} ${keyOf(r)}`).toBe(canRead(w1, human(p), r))
          }
        }
      }
    },
  ),
  core('R6-10', 'C0.7', 'Rule 6 ACC-05: sockets and topics drop within 60 s of losing access'),
  core('R6-11', 'C1.8', 'Rule 6 PRD-74: offline stores on the device are wiped on revocation'),
  core(
    'R6-12',
    'C1.9, C1.14',
    'Rule 6 PRD-99 CHAT-13: Today items, reminders, scheduled messages and link previews re-check access at render or send',
  ),
  core('R6-13', 'C2.2', 'Rule 6 ACC-05: LiveKit removes someone who loses access to a room within 60 s'),
  core(
    'R6-14',
    'C4.3',
    'Rule 6 NFR-04 PRD-62: revoked editors are dropped; their offline edits are refused and offered as a copy',
  ),
  core('R6-15', 'C4.1', 'Rule 6 PRD-99: thumbnails and previews are purged when access is revoked'),
  core('R6-16', 'C5.6', 'Rule 6 SLIDE-18: a presentation ends within 60 s of the presenter losing the deck'),
  core('R6-17', 'C6.3', 'Rule 6 C4.1: re-ACL of a 10,000-item folder finishes within 60 s'),
  ai('R6-18', 'A2.4', 'Rule 6 §9.2: AI stops using content within 60 s of someone losing access to it'),
  ai('R6-19', 'A4.1', 'Rule 6 PRD-98: assistant follow-up turns re-check the sources of earlier turns'),
  c0(
    'R6-20',
    'Rule 6 CAL-03 REC-13: someone taken off a meeting can no longer join its room or read its event or thread, with no membership to end',
    () => {
      const removed = changed(f => ({
        ...f,
        events: f.events.map(e => (e.id === E.q4 ? { ...e, invitees: e.invitees.filter(i => i !== P.weiling) } : e)),
      }))
      for (const [w, expected] of [
        [world, true],
        [removed, false],
      ] as const) {
        expect(can(w, human(P.weiling), { action: 'join', resource: ref.room(R.q4) })).toBe(expected)
        expect(reads(w, P.weiling, ref.room(R.q4))).toBe(expected)
        expect(reads(w, P.weiling, ref.event(E.q4))).toBe(expected)
        expect(reads(w, P.weiling, ref.thread(TH.q4Event))).toBe(expected)
        expect(reads(w, P.weiling, ref.message(M.q4EventThread))).toBe(expected)
      }
      expect(can(removed, human(P.ahmad), { action: 'join', resource: ref.room(R.q4) })).toBe(true)
    },
  ),
  c0(
    'R6-21',
    'Rule 6 AGT-04 AGT-14: narrowing an agent’s scope or archiving it ends what it reads on the next call',
    () => {
      // The IT helpdesk agent reads #it-help and the IT wiki, and its DM with Ashton.
      const narrowed = changed(f => ({
        ...f,
        agents: f.agents.map(a => (a.id === AG.it ? { ...a, scope: [ref.folder(F.it)] } : a)),
      }))
      expect(canRead(world, agent(AG.it), ref.message(M.it))).toBe(true)
      expect(canRead(narrowed, agent(AG.it), ref.message(M.it))).toBe(false)
      expect(canRead(narrowed, agent(AG.it), ref.folder(F.it))).toBe(true)
      const archived = changed(f => ({
        ...f,
        agents: f.agents.map(a => (a.id === AG.it ? { ...a, archivedAt: 2 } : a)),
      }))
      expect(canRead(world, agent(AG.it), ref.agentDm(CV.itHelpdesk))).toBe(true)
      for (const item of refsOf()) expect(canRead(archived, agent(AG.it), item), keyOf(item)).toBe(false)
    },
  ),
]
