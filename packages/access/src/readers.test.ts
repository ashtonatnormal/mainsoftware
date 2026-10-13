// Unit tests for the single read rule (readers.ts; PRD §7.2, B.4; BUILD-PLAN C0.4): the clause
// algebra, readersOf for every resource kind on the fixture org, and the conversation shapes that
// make a conversation readable by nobody (Rule 4). The Rule 1-9 suite (rules.test.ts) tests the
// rules end to end; these pin the building blocks it rests on.
import { describe, expect, test } from 'vitest'
import {
  type Acl,
  allows,
  eraToken,
  type Facts,
  keysOf,
  membersToken,
  NOBODY,
  orgToken,
  personToken,
  type Ref,
  type ResourceKind,
  readersOf,
  type Subject,
  teamAdminsToken,
  teamToken,
} from './index.ts'
import { conversationShapeOk, normalise } from './readers.ts'
import {
  AG,
  ALL_REFS,
  AS,
  assistant,
  C,
  CM,
  CV,
  DV,
  E,
  F,
  FI,
  fixtureWorld,
  human,
  M,
  ORG,
  ORG_2,
  P,
  R,
  ref,
  S,
  SC,
  ST,
  T,
  TH,
  TK,
} from './testing/index.ts'

const world = fixtureWorld()
const o = orgToken(ORG)
const p = personToken
const t = teamToken
const ta = teamAdminsToken
const m = membersToken
// The group DM's membership eras, as the fixture names them.
const q4Era = (person: string, n?: number) => eraToken(`mb:${CV.q4}:${person}${n === undefined ? '' : `:${n}`}`)
const people = (...ids: string[]) => [...new Set(ids)].map(p).sort()
const sorted = (...tokens: string[]) => [...tokens].sort()
const keys = (...tokens: string[]) => new Set(tokens)
const subjects: Subject[] = [
  ...world.facts.people.map(person => human(person.id)),
  assistant(AS.ashton),
  assistant(AS.daniel),
]

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

describe('allows: a subject reads when its keys meet every clause (B.4, Rule 3)', () => {
  test('no clauses, or an empty clause, is nobody whatever the keys', () => {
    const all = keys(o, p(P.ashton), m(C.leadership))
    expect(allows(NOBODY, all)).toBe(false)
    expect(allows([[]], all)).toBe(false)
    expect(allows([[o], []], all)).toBe(false)
  })

  test('one clause: any one of its tokens is enough', () => {
    expect(allows([[p(P.ashton), p(P.priya)]], keys(p(P.priya)))).toBe(true)
    expect(allows([[p(P.ashton), p(P.priya)]], keys(p(P.daniel), o))).toBe(false)
  })

  test('several clauses: the keys must meet each of them (Rule 3)', () => {
    const acl: Acl = [[m(C.leadership)], [p(P.ashton), p(P.weiling)]]
    expect(allows(acl, keys(m(C.leadership), p(P.ashton)))).toBe(true)
    expect(allows(acl, keys(m(C.leadership), p(P.priya)))).toBe(false)
    expect(allows(acl, keys(p(P.ashton)))).toBe(false)
  })

  test('no keys read nothing, not even what the whole org reads', () => {
    expect(allows([[o]], new Set())).toBe(false)
  })
})

describe('normalise: the clause algebra behind derived items and the Trash (Rule 3, DRV-01)', () => {
  test('sorts and dedupes tokens within a clause, and drops repeated clauses', () => {
    expect(
      normalise(world, [
        [p(P.priya), p(P.ashton), p(P.priya)],
        [p(P.ashton), p(P.priya)],
      ]),
    ).toEqual([[p(P.ashton), p(P.priya)]])
  })

  test('drops a clause holding the org token beside a narrower one: it holds for every active person', () => {
    expect(normalise(world, [[o], [p(P.ashton)]])).toEqual([[p(P.ashton)]])
    expect(normalise(world, [[o, t(T.q4)], [m(C.leadership)]])).toEqual([[m(C.leadership)]])
  })

  test('keeps the whole org when no clause is narrower', () => {
    expect(normalise(world, [[o], [o]])).toEqual([[o]])
    expect(normalise(world, [[o], [o, t(T.q4)]])).toEqual([[o]])
  })

  test('drops a clause that holds every token of another clause, since it holds whenever that one does', () => {
    expect(normalise(world, [[p(P.ashton)], [p(P.ashton), p(P.priya)]])).toEqual([[p(P.ashton)]])
    expect(
      normalise(world, [
        [p(P.ashton), p(P.priya), t(T.q4)],
        [p(P.priya), t(T.q4)],
      ]),
    ).toEqual([[p(P.priya), t(T.q4)]])
  })

  test('keeps clauses neither of which contains the other, shortest first', () => {
    expect(normalise(world, [[t(T.q4), p(P.priya)], [m(C.leadership)]])).toEqual([
      [m(C.leadership)],
      [p(P.priya), t(T.q4)],
    ])
  })

  test('an empty clause, or no clauses at all, is nobody', () => {
    expect(normalise(world, [[p(P.ashton)], []])).toEqual(NOBODY)
    expect(normalise(world, [])).toEqual(NOBODY)
  })

  test('ACC-11: another org’s token is not this org’s whole org, so it is never simplified away', () => {
    const acl = normalise(world, [[orgToken(ORG_2)], [p(P.ashton)]])
    expect(acl).toEqual([[orgToken(ORG_2)], [p(P.ashton)]])
    expect(allows(acl, new Set(keysOf(world, human(P.ashton))))).toBe(false)
  })

  test('never changes who reads: for any two fixture reader sets, normalising their clauses keeps the same readers', () => {
    // Every distinct non-empty reader set in the fixture, combined in pairs as a derived item's
    // sources would be, checked against every subject's keys.
    const distinct = [
      ...new Map(
        ALL_REFS()
          .map(r => readersOf(world, r))
          .filter(acl => acl.length > 0)
          .map(acl => [JSON.stringify(acl), acl] as const),
      ).values(),
    ]
    const keySets = subjects.map(s => new Set(keysOf(world, s)))
    let pairs = 0
    for (const a of distinct) {
      for (const b of distinct) {
        const clauses = [...a, ...b]
        const acl = normalise(world, clauses)
        for (const k of keySets) expect(allows(acl, k)).toBe(allows(clauses, k))
        pairs += 1
      }
    }
    expect(pairs).toBeGreaterThan(100)
  })
})

describe('readersOf: every resource kind (B.4)', () => {
  test('gives every kind at least one fixture item someone reads, in clauses that are sorted, unique and non-empty', () => {
    const refs = ALL_REFS()
    for (const kind of KINDS) {
      expect(
        refs.some(r => r.kind === kind && readersOf(world, r).length > 0),
        kind,
      ).toBe(true)
    }
    for (const r of refs) {
      for (const clause of readersOf(world, r)) {
        expect(clause.length, `${r.kind} ${r.id}`).toBeGreaterThan(0)
        expect(clause, `${r.kind} ${r.id}`).toEqual([...new Set(clause)].sort())
      }
    }
  })

  test('an unknown id of every kind, or an unknown kind, is nobody (CHT-57, PRD-108)', () => {
    for (const kind of KINDS) expect(readersOf(world, { kind, id: 'x-missing' }), kind).toEqual(NOBODY)
    expect(readersOf(world, { kind: 'mailbox' as ResourceKind, id: C.general })).toEqual(NOBODY)
  })

  test('CHAT-01 PRD-35: a public channel is the whole org’s, a private one its current members’', () => {
    expect(readersOf(world, ref.channel(C.general))).toEqual([[o]])
    expect(readersOf(world, ref.channel(C.leadership))).toEqual([[m(C.leadership)]])
    expect(readersOf(world, ref.channel(C.studio))).toEqual([[m(C.studio)]])
  })

  test('Rule 4 PA-01: DMs, group DMs and agent DMs are their current members’; an assistant chat its owner’s', () => {
    expect(readersOf(world, ref.dm(CV.ashtonPriya))).toEqual([[m(CV.ashtonPriya)]])
    expect(readersOf(world, ref.groupDm(CV.q4))).toEqual([[m(CV.q4)]])
    expect(readersOf(world, ref.agentDm(CV.itHelpdesk))).toEqual([[m(CV.itHelpdesk)]])
    expect(readersOf(world, ref.assistantChat(CV.ashtonAssistant))).toEqual([[p(P.ashton)]])
  })

  test('a space asked for as another kind is nobody, so a kind can’t be swapped to widen a read', () => {
    const wrong: Ref[] = [
      { kind: 'dm', id: CV.q4 },
      { kind: 'group_dm', id: CV.ashtonPriya },
      { kind: 'channel', id: CV.ashtonPriya },
      { kind: 'assistant_chat', id: CV.ashtonPriya },
      { kind: 'agent_dm', id: CV.cfoWeiling },
      { kind: 'thread', id: C.general },
      { kind: 'channel', id: R.lounge },
      { kind: 'room', id: C.general },
    ]
    for (const r of wrong) expect(readersOf(world, r), `${r.kind} ${r.id}`).toEqual(NOBODY)
  })

  test('ROOM-01 CAL-03 REC-07: a room takes its channel’s, its own or its meeting’s readers, restricted or not', () => {
    expect(readersOf(world, ref.room(R.ops))).toEqual(readersOf(world, ref.channel(C.ops)))
    expect(readersOf(world, ref.room(R.leadershipOneOnOnes))).toEqual([[m(C.leadership)]])
    expect(readersOf(world, ref.room(R.lounge))).toEqual([[o]])
    expect(readersOf(world, ref.room(R.board))).toEqual([[m(R.board)]])
    expect(readersOf(world, ref.room(R.people))).toEqual([[m(R.people)]])
    expect(readersOf(world, ref.room(R.townhall))).toEqual([[o]])
    // A meeting's own room: its organiser and invitees.
    expect(readersOf(world, ref.room(R.q4))).toEqual([people(P.priya, P.ashton, P.daniel, P.ahmad, P.weiling)])
  })

  test('a room whose channel or meeting is missing is nobody', () => {
    const w = fixtureWorld(f => ({
      ...f,
      rooms: f.rooms.map(r =>
        r.id === R.ops
          ? { ...r, kind: 'channel_room' as const, channelId: 'ch-missing' }
          : r.id === R.q4
            ? { ...r, kind: 'meeting' as const, eventId: 'ev-missing' }
            : r,
      ),
    }))
    expect(readersOf(w, ref.room(R.ops))).toEqual(NOBODY)
    expect(readersOf(w, ref.room(R.q4))).toEqual(NOBODY)
  })

  test('REC-13 C3.3: a meeting thread is its attendees and whoever took part in one of its sessions', () => {
    expect(readersOf(world, ref.thread(TH.q4Event))).toEqual([people(P.priya, P.ashton, P.daniel, P.ahmad, P.weiling)])
    // Nadia, not invited, took part in the review: Nadia joins the thread. Rachel took part in the
    // pricing review, another event's session, and doesn't.
    const w = fixtureWorld(f => ({
      ...f,
      sessions: f.sessions.map(s => (s.id === S.q4Review ? { ...s, participants: [...s.participants, P.nadia] } : s)),
    }))
    const readers = readersOf(w, ref.thread(TH.q4Event))
    expect(readers).toEqual([people(P.priya, P.ashton, P.daniel, P.ahmad, P.weiling, P.nadia)])
    expect(readers[0]).not.toContain(p(P.rachel))
    // A call thread is the call's participants.
    expect(readersOf(world, ref.thread(TH.q4Call))).toEqual([people(P.ashton, P.priya, P.daniel)])
  })

  test('a thread whose event or call is missing is nobody', () => {
    const w = fixtureWorld(f => ({
      ...f,
      events: f.events.filter(e => e.id !== E.q4),
      sessions: f.sessions.filter(s => s.id !== S.q4Call),
    }))
    expect(readersOf(w, ref.thread(TH.q4Event))).toEqual(NOBODY)
    expect(readersOf(w, ref.thread(TH.q4Call))).toEqual(NOBODY)
  })

  test('CHAT-03 CHAT-05: a message takes its space’s readers; a deleted one, or one whose space is missing, is nobody', () => {
    expect(readersOf(world, ref.message(M.ops1))).toEqual([[o]])
    expect(readersOf(world, ref.message(M.leadership))).toEqual([[m(C.leadership)]])
    expect(readersOf(world, ref.message(M.priya1))).toEqual([[m(CV.ashtonPriya)]])
    expect(readersOf(world, ref.message(M.finance))).toEqual([[m(CV.cfoFinance)]])
    expect(readersOf(world, ref.message(M.assistant))).toEqual([[p(P.ashton)]])
    expect(readersOf(world, ref.message(M.lounge))).toEqual([[o]])
    expect(readersOf(world, ref.message(M.peopleRoom))).toEqual([[m(R.people)]])
    expect(readersOf(world, ref.message(M.q4EventThread))).toEqual(readersOf(world, ref.thread(TH.q4Event)))
    expect(readersOf(world, ref.message(M.opsDeleted))).toEqual(NOBODY)
    expect(readersOf(world, ref.message(M.q4Deleted))).toEqual(NOBODY)
    const orphan = fixtureWorld(f => ({
      ...f,
      messages: f.messages.map(x => (x.id === M.ops1 ? { ...x, spaceId: 'ch-missing' } : x)),
    }))
    expect(readersOf(orphan, ref.message(M.ops1))).toEqual(NOBODY)
  })

  test('decision 10 PRD-79: a group-DM message goes to the membership eras open at its sequence number', () => {
    // Daniel joined after message 2; Ahmad was out between messages 3 and 5.
    expect(readersOf(world, ref.message(M.q4First))).toEqual([
      sorted(q4Era(P.ashton), q4Era(P.priya), q4Era(P.ahmad, 1)),
    ])
    expect(readersOf(world, ref.message(M.q4Third))).toEqual([
      sorted(q4Era(P.ashton), q4Era(P.priya), q4Era(P.ahmad, 1), q4Era(P.daniel)),
    ])
    expect(readersOf(world, ref.message(M.q4Fourth))).toEqual([
      sorted(q4Era(P.ashton), q4Era(P.priya), q4Era(P.daniel)),
    ])
    expect(readersOf(world, ref.message(M.q4Fifth))).toEqual([
      sorted(q4Era(P.ashton), q4Era(P.priya), q4Era(P.ahmad, 2), q4Era(P.daniel)),
    ])
  })

  test('REC-20 Rule 5: a session’s readers follow its stamp, and a restricted stamp is its participants only', () => {
    expect(readersOf(world, ref.session(S.peopleAshton))).toEqual([people(P.huimin, P.ashton)])
    // Stamped restricted in a room that isn't restricted any more: still participants only.
    expect(readersOf(world, ref.session(S.opsRestricted))).toEqual([people(P.marcus, P.farah)])
    // A room session: its space's readers, live (SLIDE-18).
    expect(readersOf(world, ref.session(S.standupFri))).toEqual([[o]])
    expect(readersOf(world, ref.session(S.peopleBefore))).toEqual([[m(R.people)]])
    // A meeting: the invitees stamped at the start and whoever took part.
    expect(readersOf(world, ref.session(S.pricing))).toEqual([people(P.ashton, P.weiling, P.ahmad, P.rachel)])
    const w = fixtureWorld(f => ({
      ...f,
      sessions: f.sessions.map(s => (s.id === S.pricing ? { ...s, participants: [...s.participants, P.nadia] } : s)),
    }))
    expect(readersOf(w, ref.session(S.pricing))).toEqual([people(P.ashton, P.weiling, P.ahmad, P.rachel, P.nadia)])
    // A DM call: its participants.
    expect(readersOf(world, ref.session(S.dmCall))).toEqual([people(P.ashton, P.priya)])
  })

  test('a space stamp naming a conversation, a thread or a missing space is nobody', () => {
    for (const spaceId of [CV.ashtonPriya, TH.q4Event, 'ch-missing']) {
      const w = fixtureWorld(f => ({
        ...f,
        sessions: f.sessions.map(s =>
          s.id === S.standupFri ? { ...s, stamp: { restricted: false, audience: 'space' as const, spaceId } } : s,
        ),
      }))
      expect(readersOf(w, ref.session(S.standupFri)), spaceId).toEqual(NOBODY)
    }
  })

  test('SLIDE-19 Rule 3: a slide copy has its session’s readers; one whose session is missing is nobody', () => {
    expect(readersOf(world, ref.slideCopy(SC.pricing))).toEqual(readersOf(world, ref.session(S.pricing)))
    expect(readersOf(world, ref.slideCopy(SC.people))).toEqual(readersOf(world, ref.session(S.peopleAshton)))
    const w = fixtureWorld(f => ({ ...f, sessions: f.sessions.filter(s => s.id !== S.pricing) }))
    expect(readersOf(w, ref.slideCopy(SC.pricing))).toEqual(NOBODY)
  })

  test('CAL-02: an event is its organiser and invitees, each once', () => {
    expect(readersOf(world, ref.event(E.priyaOneOnOne))).toEqual([people(P.ashton, P.priya)])
    const w = fixtureWorld(f => ({
      ...f,
      events: f.events.map(e => (e.id === E.priyaOneOnOne ? { ...e, invitees: [P.priya, P.ashton, P.priya] } : e)),
    }))
    expect(readersOf(w, ref.event(E.priyaOneOnOne))).toEqual([people(P.ashton, P.priya)])
  })

  test('TASK-01 TASK-06 Rule 5: a private task is its owner’s alone; a shared one its creator’s, assignees’ and team’s', () => {
    // Marcus is assigned the private task but can't read it until Hui Min shares it.
    expect(readersOf(world, ref.task(TK.private))).toEqual([[p(P.huimin)]])
    expect(readersOf(world, ref.task(TK.ot))).toEqual([sorted(p(P.ashton), t(T.operations))])
    expect(readersOf(world, ref.task(TK.board))).toEqual([sorted(p(P.ashton), p(P.weiling), t(T.leadership))])
    expect(readersOf(world, ref.task(TK.sheet))).toEqual([[p(P.weiling)]])
    expect(readersOf(world, ref.suggestedTask(ST.board))).toEqual([[p(P.ashton)]])
  })

  test('FILE-03 DRV-02 T13: a Drive item is its owner’s, its folders’ owners’ and every grant’s on it or above', () => {
    // A team owner reads through its Team Admins.
    expect(readersOf(world, ref.folder(F.ops))).toEqual([sorted(o, t(T.operations), ta(T.operations))])
    expect(readersOf(world, ref.file(FI.runbook))).toEqual([
      sorted(o, p(P.marcus), p(P.farah), p(P.priya), t(T.operations), ta(T.operations)),
    ])
    // Two folders up: Ahmad owns the file and its folder, Priya the folder above, shared with the
    // Q4 team.
    expect(readersOf(world, ref.file(FI.msa))).toEqual([sorted(p(P.ahmad), p(P.priya), t(T.q4))])
    expect(readersOf(world, ref.file(FI.q3Numbers))).toEqual([people(P.cfo, P.weiling, P.ashton)])
    expect(readersOf(world, ref.file(FI.rachelNotes))).toEqual([[p(P.rachel)]])
  })

  test('ACC-11: a Drive grant to another org’s id names nobody here', () => {
    const w = fixtureWorld(f => ({
      ...f,
      files: f.files.map(x =>
        x.id === FI.rachelNotes
          ? { ...x, grants: [{ grantee: { kind: 'org' as const, id: ORG_2 }, role: 'viewer' as const }] }
          : x,
      ),
    }))
    expect(readersOf(w, ref.file(FI.rachelNotes))).toEqual([[p(P.rachel)]])
  })

  test('CHAT-06: an attachment is its message’s readers plus anyone it was shared with since', () => {
    expect(readersOf(world, ref.file(FI.otPdf))).toEqual([[o]])
    expect(readersOf(world, ref.file(FI.q4Attachment))).toEqual(readersOf(world, ref.message(M.q4First)))
    const shared = fixtureWorld(f => ({
      ...f,
      files: f.files.map(x =>
        x.id === FI.q4Attachment
          ? { ...x, grants: [{ grantee: { kind: 'person' as const, id: P.nadia }, role: 'viewer' as const }] }
          : x,
      ),
    }))
    expect(readersOf(shared, ref.file(FI.q4Attachment))).toEqual([
      sorted(q4Era(P.ashton), q4Era(P.priya), q4Era(P.ahmad, 1), p(P.nadia)),
    ])
  })

  test('CHAT-05 Rule 7: an attachment whose message is deleted or missing is nobody', () => {
    const deleted = fixtureWorld(f => ({
      ...f,
      messages: f.messages.map(x => (x.id === M.q4First ? { ...x, deletedAt: 1 } : x)),
    }))
    expect(readersOf(deleted, ref.file(FI.q4Attachment))).toEqual(NOBODY)
    const missing = fixtureWorld(f => ({ ...f, messages: f.messages.filter(x => x.id !== M.opsFile) }))
    expect(readersOf(missing, ref.file(FI.otPdf))).toEqual(NOBODY)
  })

  test('DRV-01 Rule 6: in the Trash, an item is its owner’s, and the trasher’s while they still hold a grant', () => {
    const trashedBy = (by: string, removeGrantsOf?: string) =>
      fixtureWorld(f => ({
        ...f,
        folders: f.folders.map(x =>
          x.id === F.vendor && removeGrantsOf
            ? { ...x, grants: x.grants.filter(g => g.grantee.id !== removeGrantsOf) }
            : x,
        ),
        files: f.files.map(x =>
          x.id === FI.movers
            ? {
                ...x,
                trashedAt: 1,
                trashedById: by,
                grants: x.grants.filter(g => g.grantee.id !== removeGrantsOf),
              }
            : x,
        ),
      }))
    expect(readersOf(trashedBy(P.priya), ref.file(FI.movers))).toEqual([people(P.ashton, P.priya)])
    // Priya loses their grants on the sheet and its folder: only the owner is left.
    expect(readersOf(trashedBy(P.priya, P.priya), ref.file(FI.movers))).toEqual([[p(P.ashton)]])
    // Nobody recorded as the trasher: the owner only.
    const noTrasher = fixtureWorld(f => ({
      ...f,
      files: f.files.map(x => (x.id === FI.movers ? { ...x, trashedAt: 1, trashedById: null } : x)),
    }))
    expect(readersOf(noTrasher, ref.file(FI.movers))).toEqual([[p(P.ashton)]])
  })

  test('DRV-01: a trashed item whose trasher reads it only through another grant needs two clauses', () => {
    // Daniel trashed the proposal and then lost their own grant on it; they still read it through the
    // Q4 team's grant on the folder, Ashton (an Editor, not the trasher) doesn't.
    const w = fixtureWorld(f => ({
      ...f,
      files: f.files.map(x =>
        x.id === FI.q4Proposal
          ? { ...x, trashedAt: 1, trashedById: P.daniel, grants: x.grants.filter(g => g.grantee.id !== P.daniel) }
          : x,
      ),
    }))
    const acl = readersOf(w, ref.file(FI.q4Proposal))
    expect(acl).toEqual([people(P.priya, P.daniel), sorted(p(P.ashton), p(P.priya), t(T.q4))])
    const reads = (id: string) => allows(acl, new Set(keysOf(w, human(id))))
    expect(reads(P.priya)).toBe(true)
    expect(reads(P.daniel)).toBe(true)
    expect(reads(P.ashton)).toBe(false)
    expect(reads(P.weiling)).toBe(false)
    // Its comments follow it.
    expect(readersOf(w, ref.comment(CM.q4Daniel))).toEqual(acl)
  })

  test('DRV-01: inside a trashed folder, an item is its own owner’s and the folder’s trasher’s; nothing flows down', () => {
    const w = fixtureWorld(f => ({
      ...f,
      folders: f.folders.map(x => (x.id === F.q4 ? { ...x, trashedAt: 1, trashedById: P.priya } : x)),
    }))
    expect(readersOf(w, ref.folder(F.q4))).toEqual([[p(P.priya)]])
    expect(readersOf(w, ref.file(FI.q4Deck))).toEqual([[p(P.priya)]])
    expect(readersOf(w, ref.file(FI.forecast))).toEqual([people(P.weiling, P.priya)])
    expect(readersOf(w, ref.folder(F.q4Contract))).toEqual([people(P.ahmad, P.priya)])
    expect(readersOf(w, ref.file(FI.msa))).toEqual([people(P.ahmad, P.priya)])
  })

  test('DOC-05: a comment has its file’s readers; a deleted one, or one on a missing file, is nobody', () => {
    expect(readersOf(world, ref.comment(CM.q4Daniel))).toEqual(readersOf(world, ref.file(FI.q4Proposal)))
    expect(readersOf(world, ref.comment(CM.q4Deleted))).toEqual(NOBODY)
    const w = fixtureWorld(f => ({ ...f, files: f.files.filter(x => x.id !== FI.q4Proposal) }))
    expect(readersOf(w, ref.comment(CM.q4Daniel))).toEqual(NOBODY)
  })

  test('Rule 3: a derived item is every source’s clauses, normalised; no source, or a missing or deleted one, is nobody', () => {
    // The ops message is the whole org's, so only the forecast's readers are left.
    expect(readersOf(world, ref.derived(DV.mixed))).toEqual([sorted(p(P.ashton), p(P.priya), p(P.weiling), t(T.q4))])
    expect(readersOf(world, ref.derived(DV.opsSummary))).toEqual([[o]])
    expect(readersOf(world, ref.derived(DV.digest))).toEqual(readersOf(world, ref.session(S.pricing)))
    expect(readersOf(world, ref.derived(DV.empty))).toEqual(NOBODY)
    const w = fixtureWorld(f => ({
      ...f,
      derived: [
        ...f.derived,
        { id: 'dv-two', sources: [ref.message(M.leadership), ref.file(FI.q3Numbers)] },
        { id: 'dv-missing', sources: [ref.message(M.ops1), ref.message('m-missing')] },
        { id: 'dv-deleted', sources: [ref.message(M.ops1), ref.message(M.opsDeleted)] },
        { id: 'dv-nested', sources: [ref.derived(DV.mixed), ref.message(M.leadership)] },
      ],
    }))
    const two = readersOf(w, ref.derived('dv-two'))
    expect(two).toEqual([[m(C.leadership)], people(P.cfo, P.weiling, P.ashton)])
    const reads = (id: string) => allows(two, new Set(keysOf(w, human(id))))
    // Only people in #leadership who also hold the Q3 numbers.
    expect([P.ashton, P.weiling].map(reads)).toEqual([true, true])
    expect([P.priya, P.cfo, P.ahmad].map(reads)).toEqual([false, false, false])
    expect(readersOf(w, ref.derived('dv-missing'))).toEqual(NOBODY)
    expect(readersOf(w, ref.derived('dv-deleted'))).toEqual(NOBODY)
    expect(readersOf(w, ref.derived('dv-nested'))).toEqual([
      [m(C.leadership)],
      sorted(p(P.ashton), p(P.priya), p(P.weiling), t(T.q4)),
    ])
  })

  test('C0.6 C1.7: membership, team and role changes change no item’s readers, only subjects’ keys', () => {
    // Someone leaves a group DM and someone joins it, a member leaves a private channel and
    // another joins, a team loses and gains members, and a Team Admin is replaced: no stored
    // ACL changes, so nothing needs re-ACL (lists.ts).
    const after = fixtureWorld(f => ({
      ...f,
      memberships: [
        ...f.memberships.map(x =>
          x.id === `mb:${CV.q4}:${P.ahmad}:2`
            ? { ...x, throughSeq: 6 }
            : x.id === `mb:${C.leadership}:${P.priya}`
              ? { ...x, throughSeq: 2 }
              : x,
        ),
        { id: 'mb-q4-nadia', spaceId: CV.q4, principalId: P.nadia, afterSeq: 6, throughSeq: null },
        { id: 'mb-leadership-kelvin', spaceId: C.leadership, principalId: P.kelvin, afterSeq: 2, throughSeq: null },
      ],
      teamMembers: [
        ...f.teamMembers.map(x => (x.teamId === T.q4 && x.personId === P.weiling ? { ...x, removedAt: 1 } : x)),
        { teamId: T.q4, personId: P.nadia, removedAt: null },
      ],
      roles: [
        ...f.roles.map(r => (r.personId === P.marcus && r.role === 'team_admin' ? { ...r, revokedAt: 1 } : r)),
        { personId: P.farah, role: 'team_admin', teamId: T.operations, revokedAt: null },
      ],
    }))
    for (const r of ALL_REFS()) expect(readersOf(after, r), `${r.kind} ${r.id}`).toEqual(readersOf(world, r))
    // And the keys did change.
    expect(keysOf(after, human(P.ahmad))).not.toContain(q4Era(P.ahmad, 1))
    expect(keysOf(after, human(P.priya))).not.toContain(m(C.leadership))
    expect(keysOf(after, human(P.weiling))).not.toContain(t(T.q4))
    expect(keysOf(after, human(P.marcus))).not.toContain(ta(T.operations))
    expect(keysOf(after, human(P.farah))).toContain(ta(T.operations))
  })
})

describe('conversationShapeOk: a conversation whose members don’t match its kind is nobody’s (Rule 4)', () => {
  // Adds members to a conversation, as spans that started before its first message.
  const withMembers = (conversationId: string, principals: readonly string[], change?: (f: Facts) => Facts) =>
    fixtureWorld(f => {
      const next = {
        ...f,
        memberships: [
          ...f.memberships,
          ...principals.map(principalId => ({
            id: `mb-x:${conversationId}:${principalId}`,
            spaceId: conversationId,
            principalId,
            afterSeq: 0,
            throughSeq: null,
          })),
        ],
      }
      return change ? change(next) : next
    })
  const shapeOk = (w: ReturnType<typeof fixtureWorld>, id: string) => {
    const conversation = w.facts.conversations.find(c => c.id === id)
    if (!conversation) throw new Error(`no conversation ${id}`)
    return conversationShapeOk(w, conversation)
  }

  test('every fixture conversation has the shape its kind needs', () => {
    for (const c of world.facts.conversations) expect(conversationShapeOk(world, c), c.id).toBe(true)
  })

  test('a DM with a third person, even one who has since left, is nobody’s: a DM never gains members', () => {
    const third = withMembers(CV.ashtonPriya, [P.daniel])
    expect(shapeOk(third, CV.ashtonPriya)).toBe(false)
    expect(readersOf(third, ref.dm(CV.ashtonPriya))).toEqual(NOBODY)
    expect(readersOf(third, ref.message(M.priya1))).toEqual(NOBODY)
    const left = fixtureWorld(f => ({
      ...f,
      memberships: [
        ...f.memberships,
        { id: 'mb-x-left', spaceId: CV.ashtonPriya, principalId: P.daniel, afterSeq: 0, throughSeq: 1 },
      ],
    }))
    expect(shapeOk(left, CV.ashtonPriya)).toBe(false)
    expect(readersOf(left, ref.dm(CV.ashtonPriya))).toEqual(NOBODY)
  })

  test('a DM with an agent, or with one person only, is nobody’s', () => {
    const agentIn = withMembers(CV.ashtonMarcus, [AG.it])
    expect(shapeOk(agentIn, CV.ashtonMarcus)).toBe(false)
    expect(readersOf(agentIn, ref.dm(CV.ashtonMarcus))).toEqual(NOBODY)
    expect(readersOf(agentIn, ref.message(M.marcus))).toEqual(NOBODY)
    const alone = fixtureWorld(f => ({
      ...f,
      memberships: f.memberships.filter(x => !(x.spaceId === CV.ashtonMarcus && x.principalId === P.marcus)),
    }))
    expect(shapeOk(alone, CV.ashtonMarcus)).toBe(false)
  })

  test('an agent DM with two people, or two agents, is nobody’s', () => {
    const twoPeople = withMembers(CV.itHelpdesk, [P.marcus])
    expect(shapeOk(twoPeople, CV.itHelpdesk)).toBe(false)
    expect(readersOf(twoPeople, ref.agentDm(CV.itHelpdesk))).toEqual(NOBODY)
    expect(readersOf(twoPeople, ref.message(M.itHelp1))).toEqual(NOBODY)
    // Two people and no agent at all.
    const noAgent = withMembers(CV.itHelpdesk, [P.marcus], f => ({
      ...f,
      memberships: f.memberships.filter(x => x.principalId !== AG.it || x.spaceId !== CV.itHelpdesk),
    }))
    expect(shapeOk(noAgent, CV.itHelpdesk)).toBe(false)
    const twoAgents = withMembers(CV.itHelpdesk, [AG.hr])
    expect(shapeOk(twoAgents, CV.itHelpdesk)).toBe(false)
  })

  test('R4-09: a group DM with an agent, an assistant or an unknown principal is nobody’s, messages included', () => {
    for (const principal of [AG.digest, AS.daniel, 'x-unknown']) {
      const w = withMembers(CV.q4, [principal])
      expect(shapeOk(w, CV.q4), principal).toBe(false)
      expect(readersOf(w, ref.groupDm(CV.q4)), principal).toEqual(NOBODY)
      expect(readersOf(w, ref.message(M.q4First)), principal).toEqual(NOBODY)
      expect(readersOf(w, ref.file(FI.q4Attachment)), principal).toEqual(NOBODY)
    }
  })

  test('a group DM with no members is nobody’s; one with people alone, however many, is fine', () => {
    const empty = fixtureWorld(f => ({ ...f, memberships: f.memberships.filter(x => x.spaceId !== CV.floor) }))
    expect(shapeOk(empty, CV.floor)).toBe(false)
    const more = withMembers(CV.floor, [P.nadia, P.kelvin, P.arjun])
    expect(shapeOk(more, CV.floor)).toBe(true)
  })

  test('PA-01: an assistant conversation with no owner is nobody’s', () => {
    const w = fixtureWorld(f => ({
      ...f,
      conversations: f.conversations.map(c => (c.id === CV.ashtonAssistant ? { ...c, ownerId: null } : c)),
    }))
    expect(shapeOk(w, CV.ashtonAssistant)).toBe(false)
    expect(readersOf(w, ref.assistantChat(CV.ashtonAssistant))).toEqual(NOBODY)
  })
})
