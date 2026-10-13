import { expect } from 'vitest'
import {
  aclOf,
  audienceOfPeople,
  can,
  canRead,
  covers,
  type Facts,
  filterReadable,
  type Grant,
  type Id,
  indexClassOf,
  keysOf,
  listAccessible,
  type OrgRole,
  type Ref,
  type ResourceKind,
  readersOf,
  type Subject,
  sourceAllowed,
  World,
} from '../../index.ts'
import {
  AS,
  assistant,
  C,
  CM,
  CV,
  E,
  F,
  FI,
  fixtureFacts,
  human,
  M,
  ORG_2_IDS,
  ORG_2_PEOPLE,
  otherOrgFacts,
  P,
  R,
  ROLE_HOLDERS,
  ref,
  S,
  SEED_PEOPLE,
  T,
  TK,
} from '../index.ts'
import { ai, c0, core, type RuleCase } from './case.ts'
import { allows, changed, expectReaders, reads, refsOf, rowReadable, world } from './helpers.ts'

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
const everyone = [...SEED_PEOPLE, P.cfo, P.formerDpo, P.formerAdmin]
const subjects: Subject[] = [...everyone.map(human), assistant(AS.ashton), assistant(AS.daniel)]
const key = (r: Ref) => `${r.kind}:${r.id}`

function withoutRoles(facts: Facts, person: Id): Facts {
  return { ...facts, roles: facts.roles.filter(r => r.personId !== person) }
}
const ALL_ROLES: OrgRole[] = ['owner', 'admin', 'ai_admin', 'leadership', 'dpo', 'compliance_officer']

// Items a subject can't read, added to the fixture: a DM between two other people, a private
// channel and a restricted session without them, and a doc nobody shared with them.
function withUnreadableFor(facts: Facts, me: Id): Facts {
  const others = SEED_PEOPLE.filter(p => p !== me)
  const [a = P.farah, b = P.kelvin] = others
  const tag = `x-${me.slice(-2)}`
  return {
    ...facts,
    conversations: [...facts.conversations, { id: `${tag}-dm`, kind: 'dm', ownerId: null }],
    channels: [
      ...facts.channels,
      { id: `${tag}-ch`, visibility: 'private', ownerTeamId: null, owners: [a], archivedAt: null },
    ],
    memberships: [
      ...facts.memberships,
      ...[a, b].map(p => ({
        id: `${tag}-dm-${p}`,
        spaceId: `${tag}-dm`,
        principalId: p,
        afterSeq: 0,
        throughSeq: null,
      })),
      { id: `${tag}-ch-${a}`, spaceId: `${tag}-ch`, principalId: a, afterSeq: 0, throughSeq: null },
    ],
    messages: [
      ...facts.messages,
      { id: `${tag}-dm-1`, spaceId: `${tag}-dm`, seq: 1, authorId: a, deletedAt: null },
      { id: `${tag}-ch-1`, spaceId: `${tag}-ch`, seq: 1, authorId: a, deletedAt: null },
    ],
    sessions: [
      ...facts.sessions,
      {
        id: `${tag}-ss`,
        place: { kind: 'room', roomId: R.people },
        participants: [a, b],
        stamp: { restricted: true, audience: 'space', spaceId: R.people },
      },
    ],
    files: [
      ...facts.files,
      {
        id: `${tag}-doc`,
        subtype: 'doc',
        parent: { kind: 'root' },
        owner: { kind: 'person', id: a },
        grants: [],
        editingLimitedTo: null,
        editorsCanShare: true,
        trashedAt: null,
        trashedById: null,
      },
    ],
  }
}

export const RULE_1: readonly RuleCase[] = [
  c0('R1-01', 'Rule 1 SRCH-04 BRAIN-02: filterReadable and listAccessible keep exactly what can(read) allows', () => {
    const refs = refsOf()
    for (const s of subjects) {
      const allowed = refs.filter(r => can(world, s, { action: 'read', resource: r }))
      expect(filterReadable(world, s, refs)).toEqual(allowed)
      for (const kind of KINDS) {
        expect(listAccessible(world, s, kind)).toEqual(allowed.filter(r => r.kind === kind))
      }
    }
  }),
  c0(
    'R1-02',
    'Rule 1 SRCH-04 T3: under sqlReadableBy’s row rule, the stored ACL rows select exactly what filterReadable keeps (scripts/check-access-sql.ts runs the SQL itself)',
    () => {
      // Rows with several clauses too: derived items whose sources different people read (Rule 3),
      // and a doc in the Trash whose trasher reads it only through a team grant (DRV-01).
      const w = changed(f => ({
        ...f,
        derived: [
          ...f.derived,
          { id: 'dv-r102-q3', sources: [ref.message(M.leadership), ref.file(FI.q3Numbers)] },
          { id: 'dv-r102-q4', sources: [ref.message(M.q4Third), ref.message(M.leadership)] },
        ],
        files: f.files.map(x =>
          x.id === FI.q4Proposal
            ? { ...x, trashedAt: 1, trashedById: P.daniel, grants: x.grants.filter(g => g.grantee.id !== P.daniel) }
            : x,
        ),
      }))
      const refs = [...refsOf(), ref.derived('dv-r102-q3'), ref.derived('dv-r102-q4')]
      expect(refs.filter(r => aclOf(w, r).more.length > 0).length).toBeGreaterThanOrEqual(3)
      for (const s of subjects) {
        const keys = keysOf(w, s)
        const byRow = refs.filter(r => rowReadable(aclOf(w, r), keys))
        expect(byRow.map(key), s.id).toEqual(filterReadable(w, s, refs).map(key))
      }
    },
  ),
  core('R1-03', 'C1.7', 'Rule 1 SRCH-04: keyword search over the real search tables returns what filterReadable keeps'),
  c0('R1-04', 'Rule 1 SRCH-04 PRD-107: counts never reveal unreadable items', () => {
    // Adding items someone can't read changes nothing they can list or count, for every kind.
    const base = fixtureFacts()
    for (const me of SEED_PEOPLE) {
      const before = new World(base)
      const after = new World(withUnreadableFor(base, me))
      const s = human(me)
      for (const kind of KINDS) {
        expect(listAccessible(after, s, kind), `${me} ${kind}`).toEqual(listAccessible(before, s, kind))
      }
      const all = KINDS.flatMap(kind => after.all(kind).map(f => ({ kind, id: (f as { id: Id }).id })))
      expect(all.length).toBeGreaterThan(refsOf().length)
      expect(filterReadable(after, s, all)).toEqual(filterReadable(before, s, refsOf()))
    }
  }),
  core(
    'R1-04b',
    'C1.7',
    "Rule 1 SRCH-04 PRD-107: a search page, its total and its timing don't depend on unreadable matches (pre-filter in SQL; a dropped row is refilled, never a short page)",
  ),
  ai('R1-04c', 'A2', 'Rule 1 PRD-107: vector search pre-filters by ACL partition and never exposes similarity scores'),
  c0(
    'R1-05',
    'Rule 1 PRD-108 CHT-57: an item you can’t read answers every content request exactly as a missing one does',
    () => {
      const actions = ['read', 'post', 'join', 'edit', 'delete', 'comment', 'share', 'view_history', 'trash'] as const
      for (const me of SEED_PEOPLE) {
        for (const item of refsOf().filter(r => !reads(world, me, r))) {
          const missing = { kind: item.kind, id: `missing-${item.id}` }
          for (const action of actions) {
            expect(can(world, human(me), { action, resource: item })).toBe(
              can(world, human(me), { action, resource: missing }),
            )
          }
        }
      }
    },
  ),
  c0('R1-06', 'Rule 1 ACC-10 Rule 9: no org-wide role widens what anyone can read, through any kind of item', () => {
    // For every holder of an org-wide role, and for a member given every org-wide role, the
    // fixture with those role rows removed reads exactly the same. (A Team Admin acts as Owner of
    // their own team's items, by design: R1-36.)
    const base = fixtureFacts()
    const synthetic = {
      ...base,
      roles: [...base.roles, ...ALL_ROLES.map(role => ({ personId: P.kelvin, role, teamId: null, revokedAt: null }))],
    }
    for (const [facts, person] of [...ROLE_HOLDERS.map(p => [base, p] as const), [synthetic, P.kelvin] as const]) {
      const withRoles = new World(facts)
      const plain = new World(withoutRoles(facts, person))
      for (const kind of KINDS) {
        expect(listAccessible(withRoles, human(person), kind), `${person} ${kind}`).toEqual(
          listAccessible(plain, human(person), kind),
        )
      }
    }
  }),
  c0(
    'R1-06b',
    'Rule 1 ACC-10: each role holder has a private channel, DM, group DM, restricted session, unshared item and assistant chat they can’t read',
    () => {
      // So R1-06 can't pass with nothing to check: for every role holder, and for Kelvin, whom
      // R1-06 gives every role, at least one item of each kind is out of reach.
      const kinds: [string, Ref[]][] = [
        ['private channel', [ref.channel(C.studio), ref.channel(C.leadership)]],
        ['DM', [ref.dm(CV.farahKelvin), ref.dm(CV.ashtonPriya)]],
        ['group DM', [ref.groupDm(CV.floor), ref.groupDm(CV.q4)]],
        ['restricted session', [ref.session(S.peopleFloor), ref.session(S.peopleAshton)]],
        ['unshared item', [ref.file(FI.rachelNotes), ref.file(FI.q3Numbers)]],
        ['assistant chat', [ref.assistantChat(CV.danielAssistant), ref.assistantChat(CV.ashtonAssistant)]],
      ]
      for (const person of [...ROLE_HOLDERS, P.kelvin]) {
        for (const [kind, items] of kinds) {
          expect(
            items.some(item => !reads(world, person, item)),
            `${person} ${kind}`,
          ).toBe(true)
        }
      }
    },
  ),
  c0(
    'R1-07',
    'Rule 1 ACC-11: someone in another org can’t read anything here, an item shared with the whole org included',
    () => {
      const org2 = new World(otherOrgFacts())
      const theirKeys = new Set(keysOf(org2, human(ORG_2_PEOPLE.owner)))
      for (const item of refsOf()) {
        expect(
          readersOf(world, item).some(clause => clause.some(t => theirKeys.has(t))),
          item.id,
        ).toBe(false)
        expect(reads(world, ORG_2_PEOPLE.owner, item)).toBe(false)
      }
      // And the other way: nobody here reads org 2's whole-org doc.
      for (const me of SEED_PEOPLE) {
        const mine = new Set(keysOf(world, human(me)))
        for (const item of [ref.file(ORG_2_IDS.doc), ref.message(ORG_2_IDS.message)]) {
          expect(readersOf(org2, item).some(clause => clause.some(t => mine.has(t)))).toBe(false)
        }
      }
    },
  ),
  c0(
    'R1-08',
    'Rule 1 ACC-05: someone who has left reads nothing, though a role and memberships were never ended',
    () => {
      for (const kind of KINDS) expect(listAccessible(world, human(P.formerDpo), kind)).toEqual([])
      expect(keysOf(world, human(P.formerDpo))).toEqual([])
    },
  ),
  c0('R1-09', 'Rule 1 DOC-03: a grant to a team reaches its current members only', () => {
    // The Q4 launch folder is shared with the Q4 team; Wei Ling reads the proposal through it.
    expectReaders(world, ref.file(FI.q4Proposal), [P.weiling, P.ahmad], [P.nadia, P.rachel, P.marcus])
    const left = changed(f => ({
      ...f,
      teamMembers: f.teamMembers.map(m => (m.teamId === T.q4 && m.personId === P.weiling ? { ...m, removedAt: 2 } : m)),
    }))
    expect(reads(left, P.weiling, ref.file(FI.q4Proposal))).toBe(false)
  }),
  c0('R1-10', 'Rule 1 DOC-03: a grant to the whole org reaches every active person in it', () => {
    expectReaders(world, ref.file(FI.leavePolicy), [...SEED_PEOPLE, P.cfo, P.formerAdmin], [P.formerDpo])
  }),
  c0('R1-11', 'Rule 1 FILE-03 DRV-02 DRV-58: roles on a folder pass down to what is inside it', () => {
    // The CFO edits the board update through the board-pack folder's grant.
    expect(can(world, human(P.cfo), { action: 'edit', resource: ref.file(FI.boardUpdate) })).toBe(true)
    // Owning the vendor folder makes Ashton an Editor of Priya's quote, not its Owner.
    expect(can(world, human(P.ashton), { action: 'edit', resource: ref.file(FI.kranji) })).toBe(true)
    expect(can(world, human(P.ashton), { action: 'trash', resource: ref.file(FI.kranji) })).toBe(true)
    expect(
      can(world, human(P.ashton), {
        action: 'transfer_ownership',
        resource: ref.file(FI.kranji),
        to: { kind: 'person', id: P.ashton },
      }),
    ).toBe(false)
    expect(can(world, human(P.ashton), { action: 'limit_editing', resource: ref.file(FI.kranji) })).toBe(false)
    expect(can(world, human(P.ashton), { action: 'purge', resource: ref.file(FI.kranji) })).toBe(false)
  }),
  c0(
    'R1-12',
    'Rule 1 DRV-09: an item’s own grants add to its folder’s, and a folder’s grant is changed on the folder',
    () => {
      // Daniel edits the Q4 proposal through their own grant on top of the Q4 team's Commenter.
      expect(can(world, human(P.daniel), { action: 'edit', resource: ref.file(FI.q4Proposal) })).toBe(true)
      // Removing Daniel's own grant leaves the folder's: they can still comment, not edit.
      const removed = changed(f => ({
        ...f,
        files: f.files.map(x =>
          x.id === FI.q4Proposal ? { ...x, grants: x.grants.filter(g => g.grantee.id !== P.daniel) } : x,
        ),
      }))
      expect(can(removed, human(P.daniel), { action: 'edit', resource: ref.file(FI.q4Proposal) })).toBe(false)
      expect(can(removed, human(P.daniel), { action: 'comment', resource: ref.file(FI.q4Proposal) })).toBe(true)
      // The Q4 team's grant comes from the folder, so it can't be removed on the file.
      const teamGrantee = { kind: 'team' as const, id: T.q4 }
      expect(
        can(world, human(P.priya), {
          action: 'share.set',
          resource: ref.file(FI.q4Proposal),
          grantee: teamGrantee,
          role: null,
        }),
      ).toBe(false)
      expect(
        can(world, human(P.priya), {
          action: 'share.set',
          resource: ref.folder(F.q4),
          grantee: teamGrantee,
          role: null,
        }),
      ).toBe(true)
    },
  ),
  c0(
    'R1-13',
    'Rule 1 CHAT-01 PRD-35: anyone in the org reads a public channel, joined or not; only members read a private one',
    () => {
      expectReaders(world, ref.message(M.ops1), [P.nadia, P.daniel, P.cfo], [P.formerDpo])
      expectReaders(
        world,
        ref.message(M.leadership),
        [P.ashton, P.priya, P.weiling, P.ahmad, P.huimin],
        [P.arjun, P.nadia, P.cfo, P.formerDpo],
      )
    },
  ),
  c0(
    'R1-14',
    'Rule 1 CHAT-02 PRD-79 decision 10: a group-DM member reads only messages from their own spans in it',
    () => {
      // Daniel joined after message 2; Ahmad left after 3 and rejoined after 4.
      const q4 = [M.q4First, M.q4Second, M.q4Third, M.q4Fourth, M.q4Fifth].map(ref.message)
      expect(q4.map(m => reads(world, P.daniel, m))).toEqual([false, false, true, true, true])
      expect(q4.map(m => reads(world, P.ahmad, m))).toEqual([true, true, true, false, true])
      expect(q4.map(m => reads(world, P.priya, m))).toEqual([true, true, true, true, true])
      // The conversation itself is open to its current members.
      expectReaders(world, ref.groupDm(CV.q4), [P.ashton, P.priya, P.daniel, P.ahmad], [P.weiling, P.rachel])
    },
  ),
  c0(
    'R1-14b',
    'Rule 1 decision 10: a message sequenced at a member’s join is closed to them; one at their leave is open',
    () => {
      // Daniel's span is (2, now]: message 2 (at their join) is closed, 3 is open. Ahmad's first span
      // is (0, 3]: message 3 (at their leave) is open, 4 is closed.
      expect(reads(world, P.daniel, ref.message(M.q4Second))).toBe(false)
      expect(reads(world, P.daniel, ref.message(M.q4Third))).toBe(true)
      expect(reads(world, P.ahmad, ref.message(M.q4Third))).toBe(true)
      expect(reads(world, P.ahmad, ref.message(M.q4Fourth))).toBe(false)
    },
  ),
  c0(
    'R1-15',
    'Rule 1 CHAT-06 FILE-03 FILE-08 T13: a chat attachment’s readers are its message’s, plus only those its owner shares it with',
    () => {
      const attachment = ref.file(FI.q4Attachment)
      for (const me of everyone) {
        expect(reads(world, me, attachment), me).toBe(reads(world, me, ref.message(M.q4First)))
        expect(reads(world, me, ref.file(FI.otPdf)), me).toBe(reads(world, me, ref.message(M.opsFile)))
      }
      expect(reads(world, P.daniel, attachment)).toBe(false)
      // A reader of the message is a Viewer of the attachment, so only its owner shares it further.
      const rachel = { kind: 'person' as const, id: P.rachel }
      expect(
        allows(world, P.priya, { action: 'share.set', resource: attachment, grantee: rachel, role: 'viewer' }),
      ).toBe(false)
      expect(
        allows(world, P.ashton, { action: 'share.set', resource: attachment, grantee: rachel, role: 'viewer' }),
      ).toBe(true)
      const shared = changed(f => ({
        ...f,
        files: f.files.map(x =>
          x.id === FI.q4Attachment ? { ...x, grants: [{ grantee: rachel, role: 'viewer' }] } : x,
        ),
      }))
      // The share reaches only Rachel: they read the attachment, not the message, and it stays a DM item.
      expect(reads(shared, P.rachel, attachment)).toBe(true)
      expect(reads(shared, P.rachel, ref.message(M.q4First))).toBe(false)
      expect(reads(shared, P.marcus, attachment)).toBe(false)
      expect(indexClassOf(shared, attachment)).toBe('dm')
    },
  ),
  c0('R1-16', 'Rule 1 SHEET-29: knowing an item’s id or link opens nothing', () => {
    // Rachel asks for the CFO's sheet by id; nothing about holding the id lets Rachel in.
    expect(reads(world, P.rachel, ref.file(FI.q3Numbers))).toBe(false)
    expect(can(world, human(P.rachel), { action: 'comment', resource: ref.file(FI.q3Numbers) })).toBe(false)
  }),
  c0(
    'R1-17',
    'Rule 1 DOC-05 SHEET-24 SLIDE-23: everyone who opens an item reads its comments; Commenters and up add and resolve',
    () => {
      const viewer = changed(f => ({
        ...f,
        files: f.files.map(x =>
          x.id === FI.q4Proposal
            ? {
                ...x,
                grants: [...x.grants, { grantee: { kind: 'person' as const, id: P.rachel }, role: 'viewer' as const }],
              }
            : x,
        ),
      }))
      expect(reads(viewer, P.rachel, ref.comment(CM.q4Daniel))).toBe(true)
      expect(can(viewer, human(P.rachel), { action: 'comment', resource: ref.file(FI.q4Proposal) })).toBe(false)
      expect(can(viewer, human(P.rachel), { action: 'resolve', resource: ref.comment(CM.q4Daniel) })).toBe(false)
      // Wei Ling is a Commenter through the Q4 team.
      expect(can(world, human(P.weiling), { action: 'comment', resource: ref.file(FI.q4Proposal) })).toBe(true)
      expect(can(world, human(P.weiling), { action: 'resolve', resource: ref.comment(CM.q4Daniel) })).toBe(true)
      expect(can(world, human(P.weiling), { action: 'edit', resource: ref.comment(CM.q4Daniel) })).toBe(false)
      expect(can(world, human(P.daniel), { action: 'edit', resource: ref.comment(CM.q4Daniel) })).toBe(true)
    },
  ),
  c0(
    'R1-18',
    'Rule 1 SHEET-27 SLIDE-11: there is no access below an item, so its comments, hidden parts and notes go with opening it',
    () => {
      expect(aclOf(world, ref.comment(CM.q4Daniel)).tokens).toEqual(aclOf(world, ref.file(FI.q4Proposal)).tokens)
      expect(reads(world, P.ashton, ref.comment(CM.q4Deleted))).toBe(false)
    },
  ),
  c0(
    'R1-19',
    'Rule 1 SHEET-26 SLIDE-24 Q19 decision 17: earlier versions are for Editors and the Owner only (docs pending D40)',
    () => {
      expect(can(world, human(P.weiling), { action: 'view_history', resource: ref.file(FI.q4Proposal) })).toBe(false)
      expect(can(world, human(P.daniel), { action: 'view_history', resource: ref.file(FI.q4Proposal) })).toBe(true)
      expect(can(world, human(P.priya), { action: 'view_history', resource: ref.file(FI.q4Proposal) })).toBe(true)
      expect(can(world, human(P.nadia), { action: 'view_history', resource: ref.file(FI.allHandsDeck) })).toBe(false)
    },
  ),
  c0(
    'R1-20',
    'Rule 1 §7.1 PA-02: an assistant reads exactly what its owner reads, and nothing once either is gone',
    () => {
      for (const item of refsOf()) {
        expect(canRead(world, assistant(AS.daniel), item), item.id).toBe(reads(world, P.daniel, item))
      }
      const archived = changed(f => ({ ...f, assistants: f.assistants.map(a => ({ ...a, archivedAt: 2 })) }))
      const ownerLeft = changed(f => ({
        ...f,
        people: f.people.map(p => (p.id === P.daniel ? { ...p, deactivatedAt: 2 } : p)),
      }))
      for (const w of [archived, ownerLeft]) expect(keysOf(w, assistant(AS.daniel))).toEqual([])
      expect(keysOf(world, assistant('as-nobody'))).toEqual([])
    },
  ),
  c0('R1-21', 'Rule 1 §7.1: built-in AI for a viewer uses only what that viewer can read', () => {
    const own = audienceOfPeople(world, [P.rachel])
    expect(
      sourceAllowed(world, { run: 'built_in', viewer: human(P.rachel), audience: own }, ref.file(FI.rachelNotes)),
    ).toBe(true)
    // Wei Ling, the audience, can open the CFO's sheet; Rachel, the viewer, can't, so it's out.
    const weiling = audienceOfPeople(world, [P.weiling])
    expect(covers(world, weiling, ref.file(FI.q3Numbers))).toBe(true)
    expect(
      sourceAllowed(world, { run: 'built_in', viewer: human(P.rachel), audience: weiling }, ref.file(FI.q3Numbers)),
    ).toBe(false)
    expect(
      sourceAllowed(world, { run: 'built_in', viewer: human(P.weiling), audience: weiling }, ref.file(FI.q3Numbers)),
    ).toBe(true)
  }),
  ai('R1-22', 'A2', 'Rule 1 SRCH-03 BRAIN-02: an AI answer uses only sources the asker can open at answer time'),
  core('R1-23', 'C5.3', 'Rule 1 SHEET-29: a sheet link shows "Sheet · no access" to anyone who can’t open it'),
  core('R1-24', 'C5.3', 'Rule 1 SHEET-42: Viewers and Commenters see where a sheet changed, never old values'),
  core(
    'R1-25',
    'C4.2',
    'Rule 1 PRD-103 FILE-06: hidden parts of an uploaded Office file go to every opener; deleted tracked text is never extracted',
  ),
  core('R1-26', 'C5.1', 'Rule 1 B.7: computed sheet values and thumbnails carry only their sheet’s access'),
  core(
    'R1-27',
    'C5.2',
    'Rule 1 SHEET-19: personal filters stay private; named filter views take the sheet’s permissions',
  ),
  core('R1-28', 'C1.7', 'Rule 1 SRCH-06 PRD-108 CHT-38: jump-to and autocomplete list only readable items'),
  core('R1-29', 'C2.3', 'Rule 1 ROOM-02 CHAT-10: presence names a room only to people who can see it'),
  core('R1-30', 'C3.3', 'Rule 1 CAL-08: a meeting page links only artefacts the viewer can open'),
  core('R1-31', 'C0.14', 'Rule 1 PRD-73: push payloads carry ids only and are checked when opened'),
  ai('R1-32', 'A3', 'Rule 1 BRAIN-05: entity views show only what the viewer can open'),
  ai('R1-33', 'A3', 'Rule 1 SRCH-05: "Who knows about X" draws only on content the asker can see'),
  c0(
    'R1-34',
    'Rule 1 TASK-01 T13: a task is read by its creator, assignees and team list; a private one by its owner only',
    () => {
      expectReaders(world, ref.task(TK.board), [P.ashton, P.weiling, P.priya, P.ahmad], [P.rachel, P.nadia])
      expectReaders(world, ref.task(TK.private), [P.huimin], [P.marcus, P.ashton])
      expect(can(world, human(P.weiling), { action: 'edit', resource: ref.task(TK.board) })).toBe(true)
      expect(can(world, human(P.priya), { action: 'edit', resource: ref.task(TK.board) })).toBe(true)
      expect(can(world, human(P.weiling), { action: 'delete', resource: ref.task(TK.board) })).toBe(false)
      expect(can(world, human(P.ashton), { action: 'delete', resource: ref.task(TK.board) })).toBe(true)
      expect(can(world, assistant(AS.ashton), { action: 'edit', resource: ref.task(TK.board) })).toBe(false)
    },
  ),
  c0(
    'R1-35',
    'Rule 1 CAL-02 T13: an event is read by its organiser and invitees; only the organiser edits or cancels it',
    () => {
      expectReaders(world, ref.event(E.q4), [P.priya, P.ashton, P.daniel, P.ahmad, P.weiling], [P.rachel, P.marcus])
      expect(can(world, human(P.priya), { action: 'cancel', resource: ref.event(E.q4) })).toBe(true)
      expect(can(world, human(P.ashton), { action: 'edit', resource: ref.event(E.q4) })).toBe(false)
    },
  ),
  c0(
    'R1-36',
    'Rule 1 FILE-03 ACC-05 T13: a team-owned item’s Team Admins act as its Owner; its members have what they’re granted',
    () => {
      const policy = ref.file(FI.opsPolicy)
      // Marcus is the Operations Team Admin; Priya, Farah and Kelvin are members with the folder's
      // Editor grant, held to Commenter because editing is limited to Marcus.
      for (const action of ['limit_editing', 'set_editors_can_share', 'edit'] as const) {
        expect(can(world, human(P.marcus), { action, resource: policy }), action).toBe(true)
      }
      for (const member of [P.priya, P.farah, P.kelvin]) {
        expect(can(world, human(member), { action: 'comment', resource: policy })).toBe(true)
        expect(can(world, human(member), { action: 'edit', resource: policy })).toBe(false)
        expect(can(world, human(member), { action: 'limit_editing', resource: policy })).toBe(false)
      }
      expect(can(world, human(P.huimin), { action: 'limit_editing', resource: policy })).toBe(false)
      // Marcus shares a team-owned item with the team itself, and narrows or removes that grant;
      // the team's members are grantees like anyone else, never its Owner.
      const operations = { kind: 'team' as const, id: T.operations }
      const withDoc = (grants: Grant[]) =>
        changed(f => ({
          ...f,
          files: [
            ...f.files,
            {
              id: 'd-ops-fresh',
              subtype: 'doc',
              parent: { kind: 'root' },
              owner: { kind: 'team', id: T.operations },
              grants,
              editingLimitedTo: null,
              editorsCanShare: true,
              trashedAt: null,
              trashedById: null,
            },
          ],
        }))
      const doc = ref.file('d-ops-fresh')
      const fresh = withDoc([])
      expect(reads(fresh, P.farah, doc)).toBe(false)
      expect(allows(fresh, P.marcus, { action: 'share.set', resource: doc, grantee: operations, role: 'viewer' })).toBe(
        true,
      )
      expect(allows(fresh, P.huimin, { action: 'share.set', resource: doc, grantee: operations, role: 'viewer' })).toBe(
        false,
      )
      const granted = withDoc([{ grantee: operations, role: 'viewer' }])
      expect(reads(granted, P.farah, doc)).toBe(true)
      // The Operations wiki folder grants the team Editor: Marcus narrows it or removes it.
      const wiki = ref.folder(F.ops)
      expect(
        allows(world, P.marcus, { action: 'share.set', resource: wiki, grantee: operations, role: 'viewer' }),
      ).toBe(true)
      expect(allows(world, P.marcus, { action: 'share.set', resource: wiki, grantee: operations, role: null })).toBe(
        true,
      )
      expect(allows(world, P.huimin, { action: 'share.set', resource: wiki, grantee: operations, role: null })).toBe(
        false,
      )
    },
  ),
  c0(
    'R1-37',
    'Rule 1 T13: a grant to an archived team still reaches its members; its Team Admin no longer acts',
    () => {
      expectReaders(world, ref.file(FI.nightRota), [P.kelvin, P.farah, P.rachel], [P.marcus, P.nadia])
      expect(keysOf(world, human(P.farah)).some(t => t === `ta:${T.nightShift}`)).toBe(false)
    },
  ),
  c0(
    'R1-38',
    'Rule 1 FILE-03 decision 17: Editors share up to Editor unless the Owner turns it off, and never touch the Owner',
    () => {
      const doc = ref.file(FI.q4Proposal)
      const rachel = { kind: 'person' as const, id: P.rachel }
      const priyaAsGrantee = { kind: 'person' as const, id: P.priya }
      expect(can(world, human(P.daniel), { action: 'share.set', resource: doc, grantee: rachel, role: 'editor' })).toBe(
        true,
      )
      expect(
        can(world, human(P.daniel), {
          action: 'share.set',
          resource: doc,
          grantee: { kind: 'org', id: world.orgId },
          role: 'viewer',
        }),
      ).toBe(true)
      // The Owner isn't a grant: an Editor can't change or remove them.
      expect(
        can(world, human(P.daniel), { action: 'share.set', resource: doc, grantee: priyaAsGrantee, role: null }),
      ).toBe(false)
      expect(
        can(world, human(P.daniel), { action: 'share.set', resource: doc, grantee: priyaAsGrantee, role: 'viewer' }),
      ).toBe(false)
      expect(
        can(world, human(P.daniel), {
          action: 'transfer_ownership',
          resource: doc,
          to: { kind: 'person', id: P.daniel },
        }),
      ).toBe(false)
      // Not to someone outside the org.
      expect(
        can(world, human(P.daniel), {
          action: 'share.set',
          resource: doc,
          grantee: { kind: 'person', id: ORG_2_PEOPLE.owner },
          role: 'viewer',
        }),
      ).toBe(false)
      // Once the Owner turns Editors' sharing off.
      const off = changed(f => ({
        ...f,
        files: f.files.map(x => (x.id === FI.q4Proposal ? { ...x, editorsCanShare: false } : x)),
      }))
      expect(can(off, human(P.daniel), { action: 'share.set', resource: doc, grantee: rachel, role: 'viewer' })).toBe(
        false,
      )
      expect(can(off, human(P.priya), { action: 'share.set', resource: doc, grantee: rachel, role: 'viewer' })).toBe(
        true,
      )
      expect(can(world, human(P.daniel), { action: 'set_editors_can_share', resource: doc })).toBe(false)
      // An Editor held to Commenter by restricted editing can't share either.
      expect(can(world, human(P.priya), { action: 'share', resource: ref.file(FI.opsPolicy) })).toBe(false)
      // A Commenter can't.
      expect(
        can(world, human(P.weiling), { action: 'share.set', resource: doc, grantee: rachel, role: 'viewer' }),
      ).toBe(false)
    },
  ),
  c0(
    'R1-38b',
    'Rule 1 FILE-03 decision 17 T13: a folder’s Owner turns its Editors’ sharing off as a file’s does',
    () => {
      // Ashton owns the vendor quotes folder; Priya is its Editor.
      const folder = ref.folder(F.vendor)
      const org = { kind: 'org' as const, id: world.orgId }
      expect(allows(world, P.ashton, { action: 'set_editors_can_share', resource: folder })).toBe(true)
      expect(allows(world, P.priya, { action: 'set_editors_can_share', resource: folder })).toBe(false)
      expect(allows(world, P.priya, { action: 'share.set', resource: folder, grantee: org, role: 'viewer' })).toBe(true)
      const off = changed(f => ({
        ...f,
        folders: f.folders.map(x => (x.id === F.vendor ? { ...x, editorsCanShare: false } : x)),
      }))
      expect(allows(off, P.priya, { action: 'share.set', resource: folder, grantee: org, role: 'viewer' })).toBe(false)
      expect(allows(off, P.priya, { action: 'share', resource: folder })).toBe(false)
      expect(allows(off, P.ashton, { action: 'share.set', resource: folder, grantee: org, role: 'viewer' })).toBe(true)
      // Restricted editing stays a file setting.
      expect(allows(world, P.ashton, { action: 'limit_editing', resource: folder })).toBe(false)
    },
  ),
  c0(
    'R1-39',
    'Rule 1 FILE-01 ADM-03 T13: anyone creates in My Drive or where they can edit; public channels follow the org setting',
    () => {
      expect(can(world, human(P.nadia), { action: 'create', kind: 'file' })).toBe(true)
      expect(can(world, human(P.nadia), { action: 'create', kind: 'file', in: ref.folder(F.hr) })).toBe(false)
      expect(can(world, human(P.weiling), { action: 'create', kind: 'file', in: ref.folder(F.q4) })).toBe(false)
      expect(can(world, human(P.kelvin), { action: 'create', kind: 'file', in: ref.folder(F.ops) })).toBe(true)
      expect(can(world, human(P.nadia), { action: 'create', kind: 'channel', visibility: 'private' })).toBe(true)
      // The fixture lets Admins only create public channels and standalone rooms.
      expect(can(world, human(P.nadia), { action: 'create', kind: 'channel', visibility: 'public' })).toBe(false)
      expect(can(world, human(P.arjun), { action: 'create', kind: 'channel', visibility: 'public' })).toBe(true)
      expect(can(world, human(P.ashton), { action: 'create', kind: 'room', visibility: 'private' })).toBe(true)
      const open = changed(f => ({ ...f, settings: { publicCreation: 'everyone' } }))
      expect(can(open, human(P.nadia), { action: 'create', kind: 'channel', visibility: 'public' })).toBe(true)
      expect(can(world, assistant(AS.ashton), { action: 'create', kind: 'task' })).toBe(false)
    },
  ),
  c0(
    'R1-40',
    'Rule 1 CHAT-01 ROOM-01: only the owners of a private channel or room add, remove and manage its members',
    () => {
      const rachel = { kind: 'human' as const, id: P.rachel }
      // Ashton owns private #leadership and the private Board room; Wei Ling is a member of both
      // and owns neither.
      for (const space of [ref.channel(C.leadership), ref.room(R.board)]) {
        expect(allows(world, P.ashton, { action: 'member.add', resource: space, principal: rachel }), space.id).toBe(
          true,
        )
        expect(allows(world, P.weiling, { action: 'member.add', resource: space, principal: rachel }), space.id).toBe(
          false,
        )
        expect(allows(world, P.ashton, { action: 'manage', resource: space }), space.id).toBe(true)
        expect(allows(world, P.weiling, { action: 'manage', resource: space }), space.id).toBe(false)
      }
      const leadership = ref.channel(C.leadership)
      const priya = { kind: 'human' as const, id: P.priya }
      expect(allows(world, P.ashton, { action: 'member.remove', resource: leadership, principal: priya })).toBe(true)
      expect(allows(world, P.weiling, { action: 'member.remove', resource: leadership, principal: priya })).toBe(false)
      const board = ref.room(R.board)
      const cfo = { kind: 'human' as const, id: P.cfo }
      expect(allows(world, P.ashton, { action: 'member.remove', resource: board, principal: cfo })).toBe(true)
      expect(allows(world, P.weiling, { action: 'member.remove', resource: board, principal: cfo })).toBe(false)
      // In a public channel or room, any current member may add someone; a non-member can't.
      const newHire = 'b0000000-0000-4000-8000-0000000000e1'
      const open = changed(f => ({
        ...f,
        people: [...f.people, { id: newHire, deactivatedAt: null }],
        memberships: [
          ...f.memberships,
          { id: `mb:${R.lounge}:${P.farah}`, spaceId: R.lounge, principalId: P.farah, afterSeq: 0, throughSeq: null },
        ],
      }))
      const hire = { kind: 'human' as const, id: newHire }
      // Wei Ling is in #general and Farah in the lounge; neither owns it.
      expect(allows(open, P.weiling, { action: 'member.add', resource: ref.channel(C.general), principal: hire })).toBe(
        true,
      )
      expect(allows(open, P.farah, { action: 'member.add', resource: ref.room(R.lounge), principal: rachel })).toBe(
        true,
      )
      expect(allows(open, P.nadia, { action: 'member.add', resource: ref.room(R.lounge), principal: rachel })).toBe(
        false,
      )
    },
  ),
]
