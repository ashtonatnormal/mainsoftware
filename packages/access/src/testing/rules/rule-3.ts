import { expect } from 'vitest'
import {
  type AclRow,
  aclOf,
  audienceGap,
  audienceOf,
  can,
  canRead,
  covers,
  type Facts,
  filterReadable,
  type Id,
  type IndexClass,
  indexClassOf,
  keysOf,
  type Ref,
  readersOf,
  SEARCHABLE_CLASSES,
  type Subject,
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
  DV,
  E,
  F,
  FI,
  human,
  M,
  P,
  R,
  ref,
  S,
  SC,
  SEED_PEOPLE,
  ST,
  T,
  TH,
  TK,
} from '../index.ts'
import { ai, c0, core, type RuleCase } from './case.ts'
import { changed, expectReaders, reads, world } from './helpers.ts'

const everyone = [...SEED_PEOPLE, P.cfo, P.formerDpo, P.formerAdmin]
const subjects: Subject[] = [...everyone.map(human), assistant(AS.ashton), assistant(AS.daniel)]

type DerivedRow = { id: Id; sources: readonly Ref[] }
const derivedFrom = (id: Id, sources: readonly Ref[]): DerivedRow => ({ id, sources })

// The fixture with some derived items added, and optionally other facts changed.
function withDerived(items: readonly DerivedRow[], also: (facts: Facts) => Facts = f => f): World {
  return changed(f => also({ ...f, derived: [...f.derived, ...items] }))
}

// The in-memory form of sqlReadableBy (sql.ts): the keys meet a row's tokens and every clause in
// its more column.
function rowReadable(row: AclRow, keys: ReadonlySet<string>): boolean {
  return row.tokens.some(t => keys.has(t)) && row.more.every(clause => clause.some(t => keys.has(t)))
}

// Membership changes: they change who holds which keys, never a stored row.
const leaveSpace =
  (spaceId: Id, person: Id, atSeq: number) =>
  (f: Facts): Facts => ({
    ...f,
    memberships: f.memberships.map(m =>
      m.spaceId === spaceId && m.principalId === person && m.throughSeq === null ? { ...m, throughSeq: atSeq } : m,
    ),
  })
const leaveTeam =
  (teamId: Id, person: Id) =>
  (f: Facts): Facts => ({
    ...f,
    teamMembers: f.teamMembers.map(m => (m.teamId === teamId && m.personId === person ? { ...m, removedAt: 2 } : m)),
  })
const joinTeam =
  (teamId: Id, person: Id) =>
  (f: Facts): Facts => ({ ...f, teamMembers: [...f.teamMembers, { teamId, personId: person, removedAt: null }] })
const deactivate =
  (person: Id) =>
  (f: Facts): Facts => ({
    ...f,
    people: f.people.map(p => (p.id === person ? { ...p, deactivatedAt: 2 } : p)),
  })

// A doc, sheet or deck at the root of someone's My Drive, shared as given.
function rootFile(
  id: Id,
  subtype: 'doc' | 'sheet' | 'deck',
  owner: Id,
  grants: Facts['files'][number]['grants'],
): Facts['files'][number] {
  return {
    id,
    subtype,
    parent: { kind: 'root' },
    owner: { kind: 'person', id: owner },
    grants,
    editingLimitedTo: null,
    editorsCanShare: true,
    trashedAt: null,
    trashedById: null,
  }
}

export const RULE_3: readonly RuleCase[] = [
  c0('R3-01', 'Rule 3 BRAIN-08 C0.10: a derived item is readable only by people who can read all its sources', () => {
    // The fixture's mixed summary draws on a public #ops-north-site message and Wei Ling's Q4
    // forecast: the whole org reads the message, so the forecast's readers are the summary's.
    expectReaders(
      world,
      ref.derived(DV.mixed),
      [P.ashton, P.priya, P.weiling, P.daniel, P.ahmad],
      [P.nadia, P.marcus, P.rachel, P.cfo, P.formerDpo],
    )
    // Every source alone and every pair of sources, across the kinds a summary can draw on: a
    // public and a private channel, a DM, group-DM messages either side of Daniel's join, a DM
    // with an agent, an assistant conversation, a deleted message, sessions (a meeting, a
    // restricted one, a group-DM call), a slide copy, an event, tasks (a private one too), a
    // suggested task, Drive items, a chat attachment, a comment, another derived item, and one
    // the snapshot doesn't hold. For every person and assistant, the derived item is readable
    // exactly when every source is, in memory and through its stored row.
    const sources: Ref[] = [
      ref.message(M.general),
      ref.message(M.leadership),
      ref.message(M.studio),
      ref.message(M.priya1),
      ref.message(M.q4First),
      ref.message(M.q4Fourth),
      ref.message(M.itHelp1),
      ref.message(M.assistant),
      ref.message(M.opsDeleted),
      ref.session(S.pricing),
      ref.session(S.peopleAshton),
      ref.session(S.q4Call),
      ref.slideCopy(SC.standupPlayback),
      ref.event(E.q4),
      ref.task(TK.board),
      ref.task(TK.private),
      ref.suggestedTask(ST.board),
      ref.file(FI.forecast),
      ref.file(FI.nightRota),
      ref.file(FI.q4Attachment),
      ref.folder(F.board),
      ref.comment(CM.q4Ahmad),
      ref.room(R.board),
      ref.thread(TH.q4Event),
      ref.derived(DV.mixed),
      ref.message('m-not-loaded'),
    ]
    const items = sources.flatMap((a, i) => [
      derivedFrom(`dv-one-${i}`, [a]),
      ...sources.slice(i + 1).map((b, j) => derivedFrom(`dv-pair-${i}-${j}`, [a, b])),
    ])
    const w = withDerived(items)
    let readable = 0
    let unreadable = 0
    for (const item of items) {
      const derived = ref.derived(item.id)
      const row = aclOf(w, derived)
      for (const s of subjects) {
        const expected = item.sources.every(source => canRead(w, s, source))
        const label = `${s.kind} ${s.id}: ${item.sources.map(r => r.id).join(' + ')}`
        expect(canRead(w, s, derived), label).toBe(expected)
        expect(rowReadable(row, new Set(keysOf(w, s))), label).toBe(expected)
        if (expected) readable++
        else unreadable++
      }
    }
    // The loop saw both answers many times, so it checks something both ways.
    expect(readable).toBeGreaterThan(100)
    expect(unreadable).toBeGreaterThan(100)
  }),
  core(
    'R3-01b',
    'C0.10',
    'Rule 3 BRAIN-08 C0.10: the provenance registry stores every derived row’s sources, and its outbox ACL snapshot is the intersection of theirs',
  ),
  c0(
    'R3-02',
    'Rule 3 Rule 6 T3: a derived item disappears for a reader who loses any source, with no re-ACL of its stored row',
    () => {
      // One item drawn from private #leadership and the Q4 forecast (shared with the Q4 team), one
      // from a group-DM message and a public one. Each source keeps its own tokens as a clause of
      // the stored row, never a list of people, so a membership change only changes who holds
      // which keys.
      const items = [
        derivedFrom('dv-leadership-forecast', [ref.message(M.leadership), ref.file(FI.forecast)]),
        derivedFrom('dv-q4-thread', [ref.message(M.q4Third), ref.message(M.ops1)]),
      ]
      const lf = ref.derived('dv-leadership-forecast')
      const q4 = ref.derived('dv-q4-thread')
      const mixed = ref.derived(DV.mixed)
      const w0 = withDerived(items)
      expect(aclOf(w0, lf)).toEqual({
        tokens: [`m:${C.leadership}`],
        more: [[`p:${P.ashton}`, `p:${P.priya}`, `p:${P.weiling}`, `t:${T.q4}`]],
        indexClass: 'normal',
      })
      expectReaders(w0, lf, [P.ashton, P.priya, P.weiling, P.ahmad], [P.huimin, P.daniel, P.nadia])
      expectReaders(w0, q4, [P.ashton, P.priya, P.daniel, P.ahmad], [P.weiling, P.rachel])
      const rows = [lf, q4, mixed].map(item => ({ item, row: aclOf(w0, item) }))

      const changes: { what: string; w: World; person: Id; expected: [Ref, boolean][] }[] = [
        {
          // Ahmad leaves #leadership: he loses the item drawn from it, not the one drawn from the
          // forecast alone.
          what: 'Ahmad leaves #leadership',
          w: withDerived(items, leaveSpace(C.leadership, P.ahmad, 2)),
          person: P.ahmad,
          expected: [
            [lf, false],
            [mixed, true],
          ],
        },
        {
          // Ahmad reads the forecast only through the Q4 team, so leaving the team loses both.
          what: 'Ahmad leaves the Q4 team',
          w: withDerived(items, leaveTeam(T.q4, P.ahmad)),
          person: P.ahmad,
          expected: [
            [lf, false],
            [mixed, false],
          ],
        },
        {
          // Leaving the group DM ends every era of Daniel's in it (decision 10).
          what: 'Daniel leaves the Q4 group DM',
          w: withDerived(items, leaveSpace(CV.q4, P.daniel, 6)),
          person: P.daniel,
          expected: [
            [q4, false],
            [mixed, true],
          ],
        },
        {
          // Joining works the same way: Hui Min, already in #leadership, gains the item when she
          // joins the Q4 team, from the same row.
          what: 'Hui Min joins the Q4 team',
          w: withDerived(items, joinTeam(T.q4, P.huimin)),
          person: P.huimin,
          expected: [
            [lf, true],
            [mixed, true],
          ],
        },
        {
          what: 'Wei Ling leaves the org',
          w: withDerived(items, deactivate(P.weiling)),
          person: P.weiling,
          expected: [
            [lf, false],
            [mixed, false],
          ],
        },
      ]
      for (const { what, w, person, expected } of changes) {
        for (const [item, readsIt] of expected) expect(reads(w, person, item), `${what}: ${item.id}`).toBe(readsIt)
        // The rows stored before the change, read with the keys after it, answer exactly as
        // can() does after it.
        for (const s of subjects) {
          const keys = new Set(keysOf(w, s))
          for (const { item, row } of rows) {
            expect(rowReadable(row, keys), `${what}: ${s.id} ${item.id}`).toBe(canRead(w, s, item))
          }
        }
      }
    },
  ),
  ai(
    'R3-02b',
    'A2.4',
    'Rule 3 Rule 6 A2.4: summaries, notes and digests drop out of answers within the revocation target once a reader loses any source',
  ),
  c0(
    'R3-03',
    'Rule 3 DOC-09 DOC-10 SHEET-40 SLIDE-30: accepted AI output takes the target item’s permissions, as if typed',
    () => {
      // A suggestion for the Q4 proposal drawn from the Q3 pricing review is, until accepted, a
      // derived item: only people who read the review see the preview. Once accepted it is the
      // proposal's own text, so nothing about who reads, edits or indexes the proposal (or a sheet
      // or deck taking such text) depends on the suggestion's sources.
      const suggestion = derivedFrom('dv-q4-suggestion', [ref.session(S.pricing)])
      const w = withDerived([suggestion])
      for (const target of [ref.file(FI.q4Proposal), ref.file(FI.otRoster), ref.file(FI.q4Deck)]) {
        expect(aclOf(w, target)).toEqual(aclOf(world, target))
        for (const s of subjects) expect(canRead(w, s, target)).toBe(canRead(world, s, target))
      }
      expect(readersOf(w, ref.derived(suggestion.id))).toEqual(readersOf(w, ref.session(S.pricing)))
      // Daniel can't see the preview, but reads and edits the proposal, accepted text included.
      expect(reads(w, P.daniel, ref.derived(suggestion.id))).toBe(false)
      expect(reads(w, P.daniel, ref.file(FI.q4Proposal))).toBe(true)
      expect(can(w, human(P.daniel), { action: 'edit', resource: ref.file(FI.q4Proposal) })).toBe(true)
      // A preview drawn from a restricted session (SLIDE-30 lets a participant pick one) is
      // restricted; the item it is accepted into keeps its own class.
      expect(indexClassOf(world, ref.derived(DV.restrictedNote))).toBe('restricted')
      expect(indexClassOf(world, ref.file(FI.q4Proposal))).toBe('normal')
    },
  ),
  c0(
    'R3-04',
    'Rule 3 X2 DOC-09 SHEET-40 SLIDE-30: audienceGap(target, source) is non-empty when the target is shared wider than a source',
    () => {
      const warn = (target: Ref, source: Ref) => audienceGap(world, audienceOf(world, target), source)
      // A deck (the all-hands deck, open to the whole org) from the CFO's Q3 numbers (three people).
      const deck = warn(ref.file(FI.allHandsDeck), ref.file(FI.q3Numbers))
      expect(deck.count).toBeGreaterThan(0)
      expect(deck.includesFuture).toBe(true)
      expect(deck.people).toContain(P.nadia)
      for (const p of [P.cfo, P.weiling, P.ashton]) expect(deck.people).not.toContain(p)
      // A doc (the Q4 proposal, open to the Q4 team) from the same numbers.
      const doc = warn(ref.file(FI.q4Proposal), ref.file(FI.q3Numbers))
      expect(doc).toEqual({ count: 3, people: [P.priya, P.ahmad, P.daniel].sort(), includesFuture: true })
      // A sheet (the OT roster, open to the whole org) from private #leadership.
      const sheet = warn(ref.file(FI.otRoster), ref.message(M.leadership))
      expect(sheet.people).toContain(P.marcus)
      expect(sheet.includesFuture).toBe(true)
      // No warning the other way: the board update (Ashton and the CFO) from a public message.
      expect(warn(ref.file(FI.boardUpdate), ref.message(M.ops1))).toEqual({
        count: 0,
        people: [],
        includesFuture: false,
      })
      expect(covers(world, audienceOf(world, ref.file(FI.boardUpdate)), ref.message(M.ops1))).toBe(true)
      expect(covers(world, audienceOf(world, ref.file(FI.allHandsDeck)), ref.file(FI.q3Numbers))).toBe(false)
    },
  ),
  ai(
    'R3-04b',
    'A3.5, A3.6, A3.7',
    'Rule 3 X2 DOC-09 SHEET-40 SLIDE-30: the inline-AI preview says how many people who can open the item can’t open its sources, before Insert',
  ),
  c0(
    'R3-05',
    'Rule 3 DRV-50 X2: #ops-north-site and Q3-pricing content going into the Q4 proposal flags Daniel',
    () => {
      // A paragraph drafted from an #ops-north-site message and the Q3 pricing review.
      const paragraph = derivedFrom('dv-q4-paragraph', [ref.message(M.ops1), ref.session(S.pricing)])
      const w = withDerived([paragraph])
      const gap = audienceGap(w, audienceOf(w, ref.file(FI.q4Proposal)), ref.derived(paragraph.id))
      expect(gap.people).toContain(P.daniel)
      // In the fixture #ops-north-site is public, so the pricing review alone opens the gap: Daniel
      // and Priya weren't in it, and nor will be anyone who joins the Q4 team later.
      expect(gap).toEqual({ count: 2, people: [P.priya, P.daniel].sort(), includesFuture: true })
      // As in the demo, with #ops-north-site private and Daniel not in it, each source flags him.
      const demo = withDerived([paragraph], f => ({
        ...f,
        channels: f.channels.map(c => (c.id === C.ops ? { ...c, visibility: 'private' as const } : c)),
      }))
      const audience = audienceOf(demo, ref.file(FI.q4Proposal))
      for (const source of [ref.message(M.ops1), ref.session(S.pricing)]) {
        expect(audienceGap(demo, audience, source).people).toContain(P.daniel)
      }
      expect(audienceGap(demo, audience, ref.derived(paragraph.id)).people).toEqual(
        [P.priya, P.weiling, P.ahmad, P.daniel].sort(),
      )
    },
  ),
  ai(
    'R3-05b',
    'A3.5',
    'Rule 3 DRV-50 DOC-09: AI in Docs warns before inserting the Q4 paragraph that Daniel can’t open its sources',
  ),
  c0('R3-06', 'Rule 3 SLD-01 SLIDE-30: drafting from the board update into the all-hands deck is flagged', () => {
    const audience = audienceOf(world, ref.file(FI.allHandsDeck))
    const gap = audienceGap(world, audience, ref.file(FI.boardUpdate))
    expect(covers(world, audience, ref.file(FI.boardUpdate))).toBe(false)
    expect(gap.includesFuture).toBe(true)
    // Everyone active but Ashton and the CFO, the deck's own owner Hui Min included.
    expect(gap.count).toBe(12)
    expect(gap.people).toContain(P.huimin)
    for (const p of [P.ashton, P.cfo]) expect(gap.people).not.toContain(p)
    // A draft drawn from it is itself readable by those two only.
    const draft = withDerived([derivedFrom('dv-all-hands-draft', [ref.file(FI.boardUpdate)])])
    expect(everyone.filter(p => reads(draft, p, ref.derived('dv-all-hands-draft')))).toEqual([P.ashton, P.cfo])
  }),
  ai(
    'R3-06b',
    'A3.7',
    'Rule 3 SLD-01 SLIDE-30: AI in Slides warns before drafting the board update into the all-hands deck',
  ),
  c0('R3-07', 'Rule 3 CHAT-14 PRD-106: forwarding into a wider audience is flagged', () => {
    const into = (place: Ref, message: Id) => audienceGap(world, audienceOf(world, place), ref.message(message))
    // #leadership into #general: most of the org can't read it, nor will anyone who joins.
    const general = into(ref.channel(C.general), M.leadership)
    expect(general.includesFuture).toBe(true)
    expect(general.people).toContain(P.nadia)
    expect(general.people).not.toContain(P.priya)
    // A DM into #leadership: the channel's other members now, and its later ones.
    expect(into(ref.channel(C.leadership), M.priya1)).toEqual({
      count: 3,
      people: [P.weiling, P.ahmad, P.huimin].sort(),
      includesFuture: true,
    })
    // A group-DM message from before Daniel joined, forwarded back into the group, flags him.
    expect(into(ref.groupDm(CV.q4), M.q4First)).toEqual({ count: 1, people: [P.daniel], includesFuture: false })
    // Into a narrower or equal audience: no warning.
    expect(covers(world, audienceOf(world, ref.dm(CV.ashtonPriya)), ref.message(M.leadership))).toBe(true)
    expect(covers(world, audienceOf(world, ref.channel(C.leadership)), ref.message(M.ops1))).toBe(true)
    expect(covers(world, audienceOf(world, ref.groupDm(CV.q4)), ref.message(M.q4Fifth))).toBe(true)
  }),
  core(
    'R3-07b',
    'C1.14',
    'Rule 3 CHAT-14 PRD-106 ADM-06: the forward sheet shows the warning, and a forward into a wider audience is logged as a share',
  ),
  c0(
    'R3-08',
    'Rule 3 SHEET-23 SLIDE-07 SLIDE-29: copying a chart, a Drive image or a range into a more widely shared item is flagged',
    () => {
      const gap = (target: Ref, source: Ref) => audienceGap(world, audienceOf(world, target), source)
      // A chart from the CFO's Q3 numbers into the all-hands deck.
      const chart = gap(ref.file(FI.allHandsDeck), ref.file(FI.q3Numbers))
      expect(chart.count).toBe(11)
      expect(chart.includesFuture).toBe(true)
      for (const p of [P.cfo, P.weiling, P.ashton]) expect(chart.people).not.toContain(p)
      // A Drive image (the Kranji quote) into the Q4 review deck: Wei Ling, Ahmad and Daniel can't
      // open it, nor can anyone who joins the Q4 team later.
      expect(gap(ref.file(FI.q4Deck), ref.file(FI.kranji))).toEqual({
        count: 3,
        people: [P.weiling, P.ahmad, P.daniel].sort(),
        includesFuture: true,
      })
      // A range from the OT roster, open to the whole org, goes anywhere without a warning; so does
      // the forecast into the Q4 proposal, both open to the Q4 team.
      expect(covers(world, audienceOf(world, ref.file(FI.allHandsDeck)), ref.file(FI.otRoster))).toBe(true)
      expect(covers(world, audienceOf(world, ref.file(FI.q4Proposal)), ref.file(FI.forecast))).toBe(true)
    },
  ),
  core(
    'R3-08b',
    'C5.7',
    'Rule 3 SHEET-23 SLIDE-07 SLIDE-29: embedding a chart, Drive image or range shows the warning before insert',
  ),
  c0('R3-09', 'Rule 3 DRV-23 DRV-58 FILE-03: a move that widens access reports how many people gain it', () => {
    // Rachel's notes, shared with nobody, moved from My Drive into the Q4 launch folder: the
    // folder's people who can't read them now gain them, and so will anyone who joins the Q4 team.
    const notes = ref.file(FI.rachelNotes)
    const gap = audienceGap(world, audienceOf(world, ref.folder(F.q4)), notes)
    expect(gap.count).toBe(5)
    expect(gap.includesFuture).toBe(true)
    const moved = changed(f => ({
      ...f,
      files: f.files.map(x => (x.id === FI.rachelNotes ? { ...x, parent: { kind: 'folder' as const, id: F.q4 } } : x)),
    }))
    const gained = everyone.filter(p => reads(moved, p, notes) && !reads(world, p, notes))
    expect(gained.sort()).toEqual([...gap.people].sort())
    // Into a folder whose people can all read it already: nothing to report.
    expect(audienceGap(world, audienceOf(world, ref.folder(F.q4Contract)), ref.file(FI.q4Proposal))).toEqual({
      count: 0,
      people: [],
      includesFuture: false,
    })
  }),
  core(
    'R3-09b',
    'C4.1',
    'Rule 3 DRV-23 DRV-58: the move dialog says how many more people will be able to open the item before it moves',
  ),
  c0(
    'R3-10',
    'Rule 3 SLIDE-19 REC-20 REC-23: slide copies take the session’s audience, not the deck’s, and participants can’t delete them',
    () => {
      const pairs: [Id, Id][] = [
        [SC.pricing, S.pricing],
        [SC.people, S.peopleAshton],
        [SC.standupPlayback, S.standupFri],
      ]
      for (const [copy, session] of pairs) {
        expect(readersOf(world, ref.slideCopy(copy))).toEqual(readersOf(world, ref.session(session)))
        for (const s of subjects) {
          expect(canRead(world, s, ref.slideCopy(copy)), `${s.id} ${copy}`).toBe(
            canRead(world, s, ref.session(session)),
          )
        }
      }
      // Say the Q4 review deck was shown in the Q3 pricing review: Rachel, who took part, reads the
      // copies though she can't open the deck; Priya, who owns the deck but wasn't there, can't.
      expect(reads(world, P.rachel, ref.slideCopy(SC.pricing))).toBe(true)
      expect(reads(world, P.rachel, ref.file(FI.q4Deck))).toBe(false)
      expect(reads(world, P.priya, ref.file(FI.q4Deck))).toBe(true)
      expect(reads(world, P.priya, ref.slideCopy(SC.pricing))).toBe(false)
      // A copy from a restricted session is for its participants only, and never indexed (Rule 5).
      expectReaders(world, ref.slideCopy(SC.people), [P.huimin, P.ashton], [P.marcus, P.farah, P.kelvin])
      expect(indexClassOf(world, ref.slideCopy(SC.people))).toBe('restricted')
      // Copies belong to the session: no participant deletes, edits or trashes one.
      for (const action of ['delete', 'edit', 'trash'] as const) {
        expect(can(world, human(P.ashton), { action, resource: ref.slideCopy(SC.pricing) })).toBe(false)
      }
    },
  ),
  c0(
    'R3-11',
    'Rule 3 SLIDE-18 SLIDE-25 SLIDE-34 Q20: every role presents; only people who can share a deck present it anyway, and those copies are playback only',
    () => {
      const deck = ref.file(FI.q4Deck)
      const asks = (w: World, p: Id, action: 'present' | 'present_anyway', resource = deck) =>
        can(w, human(p), { action, resource })
      // Priya owns the deck, Daniel and Ashton edit it, Wei Ling and Ahmad comment through the Q4 team.
      const roles = [P.priya, P.daniel, P.ashton, P.weiling, P.ahmad]
      expect(roles.map(p => asks(world, p, 'present'))).toEqual([true, true, true, true, true])
      expect(roles.map(p => asks(world, p, 'present_anyway'))).toEqual([true, true, true, false, false])
      // Once Priya stops Editors sharing it, only she may present it anyway.
      const noSharing = changed(f => ({
        ...f,
        files: f.files.map(x => (x.id === FI.q4Deck ? { ...x, editorsCanShare: false } : x)),
      }))
      expect(roles.map(p => asks(noSharing, p, 'present_anyway'))).toEqual([true, false, false, false, false])
      // Someone who can't open the deck presents nothing, and a doc isn't presented.
      expect(asks(world, P.rachel, 'present')).toBe(false)
      expect(asks(world, P.priya, 'present', ref.file(FI.q4Proposal))).toBe(false)

      // #leadership: a deck shared by name with exactly its current members still leaves out its
      // later members, so presenting it there needs present_anyway; the same with a team grant
      // to a team whose members are the channel's.
      const brief = 'dk-leadership-brief'
      const byName = changed(f => ({
        ...f,
        files: [
          ...f.files,
          rootFile(
            brief,
            'deck',
            P.ashton,
            [P.priya, P.weiling, P.ahmad, P.huimin].map(id => ({
              grantee: { kind: 'person' as const, id },
              role: 'viewer' as const,
            })),
          ),
        ],
      }))
      expect(audienceGap(byName, audienceOf(byName, ref.channel(C.leadership)), ref.file(brief))).toEqual({
        count: 0,
        people: [],
        includesFuture: true,
      })
      expect(asks(byName, P.huimin, 'present', ref.file(brief))).toBe(true)
      expect(asks(byName, P.huimin, 'present_anyway', ref.file(brief))).toBe(false)
      expect(asks(byName, P.ashton, 'present_anyway', ref.file(brief))).toBe(true)
      const byTeam = changed(f =>
        joinTeam(
          T.leadership,
          P.huimin,
        )({
          ...f,
          files: [
            ...f.files,
            rootFile(brief, 'deck', P.ashton, [{ grantee: { kind: 'team', id: T.leadership }, role: 'viewer' }]),
          ],
        }),
      )
      expect(audienceGap(byTeam, audienceOf(byTeam, ref.channel(C.leadership)), ref.file(brief))).toEqual({
        count: 0,
        people: [],
        includesFuture: true,
      })
      // A deck the whole org can open needs no override there.
      expect(covers(world, audienceOf(world, ref.channel(C.leadership)), ref.file(FI.allHandsDeck))).toBe(true)
      // Copies kept from a presentation like that are playback only: they go with the session's
      // audience, and are never indexed.
      expect(indexClassOf(world, ref.slideCopy(SC.standupPlayback))).toBe('playback_only')
      expect(SEARCHABLE_CLASSES).not.toContain('playback_only')
      expect(reads(world, P.nadia, ref.slideCopy(SC.standupPlayback))).toBe(true)
    },
  ),
  c0(
    'R3-12',
    'Rule 3 TASK-04 C2.1: a task made from a message keeps its source’s index class, and wider task readers are flagged',
    () => {
      expect(indexClassOf(world, ref.task(TK.fromDm))).toBe('dm')
      expect(indexClassOf(world, ref.task(TK.ot))).toBe('normal')
      expect(indexClassOf(world, ref.task(TK.private))).toBe('restricted')
      // A task's readers are its own (creator, assignees, team list), so assigning someone who
      // can't read the source opens a gap.
      const gap = (w: World, task: Id, source: Ref) => audienceGap(w, audienceOf(w, ref.task(task)), source)
      expect(gap(world, TK.fromDm, ref.message(M.priya2))).toEqual({ count: 0, people: [], includesFuture: false })
      const toMarcus = changed(f => ({
        ...f,
        tasks: f.tasks.map(t => (t.id === TK.fromDm ? { ...t, assignees: [P.ashton, P.marcus] } : t)),
      }))
      expect(gap(toMarcus, TK.fromDm, ref.message(M.priya2))).toEqual({
        count: 1,
        people: [P.marcus],
        includesFuture: false,
      })
      // A team list grows: a task from the Q3 pricing review put on the Finance list flags the CFO,
      // and everyone who joins Finance later.
      const onFinance = changed(f => ({
        ...f,
        tasks: f.tasks.map(t => (t.id === TK.sheet ? { ...t, teamId: T.finance } : t)),
      }))
      expect(gap(onFinance, TK.sheet, ref.session(S.pricing))).toEqual({
        count: 1,
        people: [P.cfo],
        includesFuture: true,
      })
    },
  ),
  core(
    'R3-12b',
    'C2.1',
    'Rule 3 TASK-04 C2.1: creating a task from a message stores its source and class, and warns when its readers are wider',
  ),
  c0('R3-13', 'Rule 3 BRAIN-07: a summary computed from one channel only has exactly that channel’s readers', () => {
    const w = withDerived([
      derivedFrom('dv-leadership-weekly', [ref.message(M.digest), ref.message(M.leadership)]),
      derivedFrom('dv-ops-daily', [ref.message(M.ops1), ref.message(M.ops4), ref.session(S.standupFri)]),
      derivedFrom('dv-leadership-and-studio', [ref.message(M.leadership), ref.message(M.studio)]),
    ])
    expect(aclOf(w, ref.derived('dv-leadership-weekly'))).toEqual(aclOf(w, ref.channel(C.leadership)))
    expect(aclOf(w, ref.derived('dv-ops-daily'))).toEqual(aclOf(w, ref.channel(C.ops)))
    // So it follows the channel: Ahmad leaving #leadership loses the weekly summary with it.
    const left = withDerived(
      [derivedFrom('dv-leadership-weekly', [ref.message(M.digest), ref.message(M.leadership)])],
      leaveSpace(C.leadership, P.ahmad, 2),
    )
    expect(reads(left, P.ahmad, ref.derived('dv-leadership-weekly'))).toBe(false)
    // A summary across two private channels is for people in both: here, nobody.
    expect(everyone.filter(p => reads(w, p, ref.derived('dv-leadership-and-studio')))).toEqual([])
  }),
  ai(
    'R3-13b',
    'A3.4',
    'Rule 3 BRAIN-07: channel and team summaries are generated per scope, from that scope’s sources only',
  ),
  ai('R3-14', 'A3', 'Rule 3 BRAIN-08: every derived artefact the AI writes records its provenance'),
  ai(
    'R3-15',
    'A3.6',
    'Rule 3 SHT-55 SHEET-39 PDPA-15: Ask-about-sheet history hides once the asker loses access to the sheet',
  ),
  ai(
    'R3-16',
    'A3.5, A3.6, A3.7',
    'Rule 3 PRD-106 ADM-06: accepting AI output into an item shared wider than its sources is logged as a share',
  ),
  c0(
    'R3-17',
    'Rule 3 BRAIN-08 B.4: a derived item with no recorded sources, or a source the snapshot can’t find, is readable by nobody and never indexed',
    () => {
      // The fixture's dv-no-sources records no provenance.
      const empty = ref.derived(DV.empty)
      expect(readersOf(world, empty)).toEqual([])
      expect(aclOf(world, empty)).toEqual({ tokens: [], more: [], indexClass: 'restricted' })
      expect(subjects.filter(s => canRead(world, s, empty))).toEqual([])
      // Sources the snapshot doesn't hold: alone, or beside one the whole org reads.
      const items = [
        derivedFrom('dv-unloaded', [ref.message('m-not-loaded')]),
        derivedFrom('dv-half-loaded', [ref.message(M.general), ref.session('ss-not-loaded')]),
      ]
      // The Finance agent's scope lists everything involved, so only the missing fact refuses it.
      const w = withDerived(items, f => ({
        ...f,
        agents: f.agents.map(a =>
          a.id === AG.finance
            ? { ...a, scope: [...a.scope, ref.session('ss-not-loaded'), ref.message('m-not-loaded'), empty] }
            : a,
        ),
      }))
      for (const { id } of [...items, { id: DV.empty }]) {
        const item = ref.derived(id)
        expect(readersOf(w, item), id).toEqual([])
        expect(indexClassOf(w, item), id).toBe('restricted')
        expect(
          subjects.filter(s => canRead(w, s, item)),
          id,
        ).toEqual([])
        expect(canRead(w, agent(AG.finance), item), id).toBe(false)
      }
      // A task whose source message isn't loaded is never indexed either.
      const task = changed(f => ({
        ...f,
        tasks: [
          ...f.tasks,
          {
            id: 'tk-unloaded',
            creatorId: P.ashton,
            assignees: [P.ashton],
            teamId: null,
            privateToId: null,
            sourceRef: ref.message('m-not-loaded'),
          },
        ],
      }))
      expect(indexClassOf(task, ref.task('tk-unloaded'))).toBe('restricted')
    },
  ),
  c0('R3-18', 'Rule 3 AGT-04: an agent reads a derived item only when every source is in its scope', () => {
    // The Finance agent's scope is the Q3 numbers and #general.
    const items = [
      derivedFrom('dv-finance-in', [ref.message(M.general), ref.file(FI.q3Numbers)]),
      derivedFrom('dv-finance-out', [ref.message(M.general), ref.message(M.ops1)]),
    ]
    const w = withDerived(items)
    expect(canRead(w, agent(AG.finance), ref.derived('dv-finance-in'))).toBe(true)
    expect(canRead(w, agent(AG.finance), ref.derived('dv-finance-out'))).toBe(false)
    // Listing the derived item itself doesn't reach the source outside the scope.
    const listed = withDerived(items, f => ({
      ...f,
      agents: f.agents.map(a =>
        a.id === AG.finance ? { ...a, scope: [...a.scope, ref.derived('dv-finance-out')] } : a,
      ),
    }))
    expect(canRead(listed, agent(AG.finance), ref.derived('dv-finance-out'))).toBe(false)
    // Another agent with neither source in scope reads neither.
    expect(canRead(w, agent(AG.it), ref.derived('dv-finance-in'))).toBe(false)
    // People still need every source: only the Q3 numbers' readers read the first.
    expectReaders(w, ref.derived('dv-finance-in'), [P.cfo, P.weiling, P.ashton], [P.priya, P.nadia])
  }),
  c0('R3-19', 'Rule 3 Rule 4 Rule 5 SLIDE-34: a derived item takes the strictest index class of its sources', () => {
    const cases: [Ref[], IndexClass][] = [
      [[ref.message(M.ops1), ref.message(M.ops2)], 'normal'],
      [[ref.message(M.ops1), ref.slideCopy(SC.standupPlayback)], 'playback_only'],
      [[ref.message(M.ops1), ref.message(M.itHelp1)], 'agent_dm'],
      [[ref.message(M.itHelp1), ref.message(M.priya1)], 'dm'],
      [[ref.message(M.q4Fifth), ref.file(FI.forecast)], 'dm'],
      [[ref.message(M.priya1), ref.message(M.assistant)], 'personal'],
      [[ref.message(M.assistant), ref.session(S.peopleAshton)], 'restricted'],
      [[ref.derived(DV.mixed), ref.derived(DV.restrictedNote)], 'restricted'],
    ]
    const w = withDerived(cases.map(([sources], i) => derivedFrom(`dv-class-${i}`, sources)))
    for (const [i, [sources, expected]] of cases.entries()) {
      const item = ref.derived(`dv-class-${i}`)
      expect(indexClassOf(w, item), sources.map(s => s.id).join(' + ')).toBe(expected)
      expect(aclOf(w, item).indexClass).toBe(expected)
    }
    expect(indexClassOf(world, ref.derived(DV.digest))).toBe('normal')
    expect(indexClassOf(world, ref.derived(DV.restrictedNote))).toBe('restricted')
  }),
  c0(
    'R3-20',
    'Rule 3 BRAIN-08 B.4: a derived item whose sources lead back to itself is readable by nobody and never indexed',
    () => {
      // Provenance that loops (a corrupt or hand-made row) must fail closed, as a Drive folder
      // loop does, and must not take a whole list down with it.
      const w = withDerived([
        derivedFrom('dv-loop-a', [ref.message(M.general), ref.derived('dv-loop-b')]),
        derivedFrom('dv-loop-b', [ref.derived('dv-loop-a')]),
        derivedFrom('dv-self', [ref.derived('dv-self')]),
      ])
      for (const id of ['dv-loop-a', 'dv-loop-b', 'dv-self']) {
        const item = ref.derived(id)
        expect(() => readersOf(w, item), id).not.toThrow()
        expect(readersOf(w, item), id).toEqual([])
        expect(indexClassOf(w, item), id).toBe('restricted')
        expect(reads(w, P.ashton, item), id).toBe(false)
      }
      expect(filterReadable(w, human(P.ashton), [ref.derived('dv-self'), ref.derived(DV.mixed)])).toEqual([
        ref.derived(DV.mixed),
      ])
    },
  ),
]
