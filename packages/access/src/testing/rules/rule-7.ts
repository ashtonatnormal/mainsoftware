import { expect } from 'vitest'
import {
  aclOf,
  audienceOf,
  can,
  canRead,
  type Facts,
  type FileFact,
  type FolderFact,
  filterReadable,
  type Id,
  isLive,
  keysOf,
  listAccessible,
  type MessageFact,
  type Ref,
  readersOf,
  type Subject,
  sourceAllowed,
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
  F,
  FI,
  human,
  M,
  P,
  ref,
  SC,
  SEED_PEOPLE,
  system,
  T,
} from '../index.ts'
import { ai, c0, core, type RuleCase } from './case.ts'
import { changed, expectReaders, reads, refsOf, rowReadable, world } from './helpers.ts'

type Change = (facts: Facts) => Facts

const everyone = [...SEED_PEOPLE, P.cfo, P.formerDpo, P.formerAdmin]
const agents = Object.values(AG).map(agent)
const assistants = Object.values(AS).map(assistant)
// Everyone who could ask to read something: each person, each assistant, each agent and Hearth.
const askers: Subject[] = [...everyone.map(human), ...assistants, ...agents, system]
const key = (r: Ref) => `${r.kind}:${r.id}`
const label = (s: Subject) => `${s.kind} ${s.id}`

// The changes a case makes, as the database would record them.
const steps =
  (...changes: Change[]): Change =>
  f =>
    changes.reduce((acc, change) => change(acc), f)
const editFile =
  (id: Id, edit: (x: FileFact) => FileFact): Change =>
  f => ({ ...f, files: f.files.map(x => (x.id === id ? edit(x) : x)) })
const editFolder =
  (id: Id, edit: (x: FolderFact) => FolderFact): Change =>
  f => ({ ...f, folders: f.folders.map(x => (x.id === id ? edit(x) : x)) })
const editMessage =
  (id: Id, edit: (x: MessageFact) => MessageFact): Change =>
  f => ({ ...f, messages: f.messages.map(x => (x.id === id ? edit(x) : x)) })
const deleteMessage = (id: Id): Change => editMessage(id, m => ({ ...m, deletedAt: 2 }))
const trashFile = (id: Id, by: Id): Change => editFile(id, x => ({ ...x, trashedAt: 2, trashedById: by }))
const trashFolder = (id: Id, by: Id): Change => editFolder(id, x => ({ ...x, trashedAt: 2, trashedById: by }))
const restoreFolder = (id: Id): Change => editFolder(id, x => ({ ...x, trashedAt: null, trashedById: null }))
const addFiles =
  (...files: FileFact[]): Change =>
  f => ({ ...f, files: [...f.files, ...files] })
const attachment = (id: Id, messageId: Id, owner: Id, sharedWith: Id[] = []): FileFact => ({
  id,
  subtype: 'upload',
  parent: { kind: 'message', id: messageId },
  owner: { kind: 'person', id: owner },
  grants: sharedWith.map(p => ({ grantee: { kind: 'person', id: p }, role: 'viewer' })),
  editingLimitedTo: null,
  editorsCanShare: true,
  trashedAt: null,
  trashedById: null,
})

// Whether a person's keys read the row aclOf stores for an item, under the SQL row rule.
function storedRowReads(w: World, item: Ref, person: Id): boolean {
  return rowReadable(aclOf(w, item), keysOf(w, human(person)))
}

// Everything a Drive item could be asked for besides being read, restored or purged.
const DRIVE_CHANGES = [
  'edit',
  'comment',
  'view_history',
  'share',
  'present',
  'present_anyway',
  'trash',
  'set_editors_can_share',
  'limit_editing',
] as const

// The Q4 launch folder and everything in it, with each item's own owner (Priya trashes the folder
// in several cases below).
const Q4_TREE: readonly [Ref, Id][] = [
  [ref.folder(F.q4), P.priya],
  [ref.file(FI.q4Proposal), P.priya],
  [ref.file(FI.q4Deck), P.priya],
  [ref.file(FI.forecast), P.weiling],
  [ref.folder(F.q4Contract), P.ahmad],
  [ref.file(FI.msa), P.ahmad],
]

export const RULE_7: readonly RuleCase[] = [
  c0(
    'R7-01',
    'Rule 7 CHAT-05 DOC-05: a deleted message or comment is readable by nobody, its author and every agent included',
    () => {
      // Marcus's deleted message in #ops-north-site, Priya's in the Q4 group DM, Arjun's in
      // #it-help (inside the IT agent's scope) and Priya's deleted comment on the Q4 proposal.
      const deleted = [
        ref.message(M.opsDeleted),
        ref.message(M.q4Deleted),
        ref.message(M.itDeleted),
        ref.comment(CM.q4Deleted),
      ]
      for (const item of deleted) {
        expect(readersOf(world, item), item.id).toEqual([])
        expect(aclOf(world, item).tokens, item.id).toEqual([])
        expect(isLive(world, item), item.id).toBe(false)
        for (const s of askers) expect(canRead(world, s, item), `${label(s)} ${item.id}`).toBe(false)
      }
      // Their live neighbours are read by the same people, so the refusal comes from the deletion.
      expectReaders(world, ref.message(M.ops4), [P.marcus, P.nadia], [P.formerDpo])
      expectReaders(world, ref.message(M.q4Fifth), [P.priya, P.ahmad], [P.weiling])
      expectReaders(world, ref.comment(CM.q4Daniel), [P.priya, P.daniel], [P.nadia])
      // Review 11: the IT agent reads #it-help, which is in its scope, but not the message deleted there.
      expect(canRead(world, agent(AG.it), ref.message(M.it))).toBe(true)
      expect(canRead(world, agent(AG.it), ref.message(M.itDeleted))).toBe(false)
      // No list or filter returns them, so search and the Org Brain never see them.
      for (const s of askers) expect(filterReadable(world, s, deleted), label(s)).toEqual([])
      for (const p of everyone) {
        const messages = listAccessible(world, human(p), 'message').map(key)
        for (const item of deleted) expect(messages).not.toContain(key(item))
      }
    },
  ),
  c0(
    'R7-01b',
    'Rule 7 CHAT-05 Rule 4: a message deleted in a DM with an agent is closed to the agent and the person alike, and to any AI run',
    () => {
      const first = ref.message(M.itHelp1)
      const w = changed(deleteMessage(M.itHelp1))
      for (const s of [human(P.ashton), assistant(AS.ashton), agent(AG.it)]) {
        expect(canRead(world, s, first), label(s)).toBe(true)
        expect(canRead(w, s, first), label(s)).toBe(false)
        // The rest of the conversation stays open to them.
        expect(canRead(w, s, ref.message(M.itHelp2)), label(s)).toBe(true)
      }
      // The set algebra A2 runs on: a deleted message is no source for a scheduled agent run or for
      // built-in AI, though the live message beside it is.
      const audience = audienceOf(world, ref.channel(C.it))
      const scheduled = { run: 'agent_scheduled' as const, agentId: AG.it, audience }
      const builtIn = { run: 'built_in' as const, viewer: human(P.arjun), audience }
      expect(sourceAllowed(world, scheduled, ref.message(M.it))).toBe(true)
      expect(sourceAllowed(world, scheduled, ref.message(M.itDeleted))).toBe(false)
      expect(sourceAllowed(world, builtIn, ref.message(M.it))).toBe(true)
      expect(sourceAllowed(world, builtIn, ref.message(M.itDeleted))).toBe(false)
    },
  ),
  c0(
    'R7-01c',
    'Rule 7 CHAT-05 CHAT-06: an attachment of a deleted message is readable by nobody, its owner and anyone it was shared with included',
    () => {
      // Arjun attached a screenshot to the #it-help message they later deleted, and shared it with
      // Nadia; Arjun attached a log to the message that is still there.
      const screenshot = ref.file('up-it-screenshot')
      const log = ref.file('up-it-log')
      const w = changed(
        addFiles(attachment(screenshot.id, M.itDeleted, P.arjun, [P.nadia]), attachment(log.id, M.it, P.arjun)),
      )
      expect(readersOf(w, screenshot)).toEqual([])
      expect(isLive(w, screenshot)).toBe(false)
      for (const s of askers) expect(canRead(w, s, screenshot), label(s)).toBe(false)
      expectReaders(w, log, [P.arjun, P.nadia, P.cfo], [P.formerDpo])
      expect(canRead(w, agent(AG.it), log)).toBe(true)
      // Marcus deletes the #ops-north-site message that carries the OT roster PDF they own: the PDF
      // goes for everyone, Marcus included, and nothing more can be done with it.
      const otPdf = ref.file(FI.otPdf)
      expectReaders(world, otPdf, [P.marcus, P.nadia], [P.formerDpo])
      const gone = changed(deleteMessage(M.opsFile))
      expect(isLive(gone, otPdf)).toBe(false)
      for (const s of askers) expect(canRead(gone, s, otPdf), label(s)).toBe(false)
      for (const action of ['edit', 'share', 'trash', 'restore', 'purge'] as const) {
        expect(can(gone, human(P.marcus), { action, resource: otPdf }), action).toBe(false)
      }
    },
  ),
  c0('R7-01d', 'Rule 7 BRAIN-04 Rule 3: anything made from a deleted message is withdrawn from everyone', () => {
    // The ops summary is made from two #ops-north-site messages; the mixed digest from one of
    // them and the Q4 forecast. Marcus deletes the message both use.
    const w = changed(deleteMessage(M.ops2))
    for (const item of [ref.derived(DV.opsSummary), ref.derived(DV.mixed)]) {
      expect(reads(world, P.priya, item), item.id).toBe(true)
      expect(isLive(world, item), item.id).toBe(true)
      expect(readersOf(w, item), item.id).toEqual([])
      expect(isLive(w, item), item.id).toBe(false)
      for (const s of askers) expect(canRead(w, s, item), `${label(s)} ${item.id}`).toBe(false)
    }
    // Something made only from other sources is untouched.
    expect(readersOf(w, ref.derived(DV.digest))).toEqual(readersOf(world, ref.derived(DV.digest)))
    expect(reads(w, P.weiling, ref.derived(DV.digest))).toBe(true)
  }),
  c0(
    'R7-02',
    'Rule 7 CHAT-05 ADM-08: no request opens a message’s earlier versions, its author’s included, so held versions stay reachable only through Rule 9',
    () => {
      // Messages keep no history anyone can open (CHAT-05); under a hold the earlier versions are
      // kept, out of view, and only the Rule 9 module reaches them.
      for (const item of refsOf('message')) {
        for (const p of everyone) {
          expect(can(world, human(p), { action: 'view_history', resource: item }), `${p} ${item.id}`).toBe(false)
        }
      }
      // Once deleted, a message refuses its own author every request.
      const deleted: [Id, Id][] = [
        [M.opsDeleted, P.marcus],
        [M.q4Deleted, P.priya],
        [M.itDeleted, P.arjun],
      ]
      for (const [id, author] of deleted) {
        expect(world.get({ kind: 'message', id })?.authorId).toBe(author)
        for (const action of ['read', 'edit', 'delete', 'view_history'] as const) {
          expect(can(world, human(author), { action, resource: ref.message(id) }), `${author} ${action}`).toBe(false)
        }
      }
    },
  ),
  core(
    'R7-02b',
    'C0.10, C1.2',
    'Rule 7 CHAT-05 ADM-08: editing or deleting a held message keeps the original and every earlier version out of view until the hold ends',
  ),
  c0(
    'R7-03',
    'Rule 7 REC-23 SLIDE-19: no participant deletes a session record or a slide copy kept with it, the DPO included',
    () => {
      for (const session of refsOf('session')) {
        const participants = world.get({ kind: 'session', id: session.id })?.participants ?? []
        expect(participants.length, session.id).toBeGreaterThan(0)
        for (const p of participants) {
          // They read it and may correct it (REC-15), so the refusal isn't for want of access.
          expect(reads(world, p, session), `${p} ${session.id}`).toBe(true)
          expect(can(world, human(p), { action: 'correct', resource: session }), `${p} ${session.id}`).toBe(true)
          for (const action of ['delete', 'edit', 'trash', 'purge'] as const) {
            expect(can(world, human(p), { action, resource: session }), `${p} ${action} ${session.id}`).toBe(false)
          }
        }
      }
      // Slide copies belong to the session: nobody deletes, changes or shares one through can().
      for (const copy of refsOf('slide_copy')) {
        for (const p of everyone) {
          for (const action of ['delete', 'edit', 'trash', 'purge', 'share'] as const) {
            expect(can(world, human(p), { action, resource: copy }), `${p} ${action} ${copy.id}`).toBe(false)
          }
        }
      }
      // Ashton, the DPO, took part in the restricted People 1:1: being DPO adds no delete here; a
      // DPO deletion acts on a request, through the deletion code (R7-10).
      expect(can(world, human(P.ashton), { action: 'delete', resource: ref.slideCopy(SC.people) })).toBe(false)
    },
  ),
  c0(
    'R7-04',
    'Rule 7 SLIDE-19 REC-20: slide copies keep their session’s readers whatever happens to the decks they came from',
    () => {
      const decks = refsOf('file').filter(r => world.get({ kind: 'file', id: r.id })?.subtype === 'deck')
      expect(decks.length).toBeGreaterThan(0)
      // Every deck trashed and stripped of its grants, or gone from the Drive altogether.
      const trashed = changed(f => ({
        ...f,
        files: f.files.map(x => (x.subtype === 'deck' ? { ...x, grants: [], trashedAt: 2, trashedById: P.priya } : x)),
      }))
      const gone = changed(f => ({ ...f, files: f.files.filter(x => x.subtype !== 'deck') }))
      for (const copy of refsOf('slide_copy')) {
        const sessionId = world.get({ kind: 'slide_copy', id: copy.id })?.sessionId ?? 'none'
        const before = aclOf(world, copy)
        expect(before.tokens.length, copy.id).toBeGreaterThan(0)
        expect(readersOf(world, copy), copy.id).toEqual(readersOf(world, ref.session(sessionId)))
        for (const w of [trashed, gone]) {
          expect(aclOf(w, copy), copy.id).toEqual(before)
          for (const p of everyone) expect(reads(w, p, copy), `${p} ${copy.id}`).toBe(reads(world, p, copy))
        }
      }
      // Rachel took part in the pricing review, so they read its slide copy, though they can't open
      // the Q4 deck; Nadia, who wasn't there, can open the all-hands deck but not the copy.
      expect(reads(world, P.rachel, ref.slideCopy(SC.pricing))).toBe(true)
      expect(reads(world, P.rachel, ref.file(FI.q4Deck))).toBe(false)
      expect(reads(world, P.nadia, ref.file(FI.allHandsDeck))).toBe(true)
      expect(reads(world, P.nadia, ref.slideCopy(SC.pricing))).toBe(false)
    },
  ),
  c0(
    'R7-05',
    'Rule 7 FILE-02 DRV-01 DRV-57: an item in the Trash is readable only by its owner and whoever trashed it',
    () => {
      // The safety runbook is Marcus's, in the Operations wiki the whole org reads; Farah, one of
      // its Editors, trashes it.
      const runbook = ref.file(FI.runbook)
      expectReaders(world, runbook, [P.marcus, P.farah, P.priya, P.kelvin, P.nadia, P.ashton], [P.formerDpo])
      expect(can(world, human(P.farah), { action: 'trash', resource: runbook })).toBe(true)
      const w = changed(trashFile(FI.runbook, P.farah))
      expectReaders(w, runbook, [P.marcus, P.farah], [P.priya, P.kelvin, P.nadia, P.ashton, P.arjun, P.weiling])
      expect(isLive(w, runbook)).toBe(false)
      expect(aclOf(w, runbook)).toEqual({
        tokens: [`p:${P.farah}`, `p:${P.marcus}`].sort(),
        more: [],
        indexClass: 'normal',
      })
      for (const s of [...agents, ...assistants, system]) expect(canRead(w, s, runbook), label(s)).toBe(false)
      expect(filterReadable(w, human(P.nadia), refsOf('file')).map(key)).not.toContain(key(runbook))
    },
  ),
  c0(
    'R7-05b',
    'Rule 7 FILE-02 DRV-01: trashing a folder sends everything in it to the Trash, each item readable only by its own owner and whoever trashed the folder',
    () => {
      // Priya trashes the Q4 launch folder, shared with the Q4 team as Commenters. Daniel and
      // Ashton are named Editors of the proposal and the deck inside it.
      const w = changed(trashFolder(F.q4, P.priya))
      const q4Team = [P.ashton, P.priya, P.daniel, P.ahmad, P.weiling]
      for (const [item, owner] of [...Q4_TREE, [ref.comment(CM.q4Daniel), P.priya] as const]) {
        const readers = [...new Set([owner, P.priya])]
        const lost = q4Team.filter(p => !readers.includes(p))
        for (const p of lost) expect(reads(world, p, item), `${p} read ${item.id} before`).toBe(true)
        expectReaders(w, item, readers, [...lost, P.nadia])
        expect(isLive(w, item), item.id).toBe(false)
        // The stored row no longer carries the Q4 team or any grant from the folder above.
        const row = aclOf(w, item)
        expect([...row.tokens, ...row.more.flat()], item.id).not.toContain(`t:${T.q4}`)
        for (const p of lost) expect(storedRowReads(w, item, p), `${p} row ${item.id}`).toBe(false)
        for (const p of readers) expect(storedRowReads(w, item, p), `${p} row ${item.id}`).toBe(true)
      }
      expect(aclOf(world, ref.file(FI.q4Proposal)).tokens).toContain(`t:${T.q4}`)
      // Ahmad still reads the MSA as its owner; Daniel loses the proposal and the deck from every list.
      expect(reads(w, P.ahmad, ref.file(FI.msa))).toBe(true)
      const daniels = (x: World) => listAccessible(x, human(P.daniel), 'file').map(key)
      expect(daniels(world)).toEqual(expect.arrayContaining([key(ref.file(FI.q4Proposal)), key(ref.file(FI.q4Deck))]))
      expect(daniels(w)).not.toContain(key(ref.file(FI.q4Proposal)))
      expect(daniels(w)).not.toContain(key(ref.file(FI.q4Deck)))
      // Restoring the folder brings back every inherited reader and the same stored rows.
      const restored = changed(steps(trashFolder(F.q4, P.priya), restoreFolder(F.q4)))
      for (const [item] of Q4_TREE) {
        expect(aclOf(restored, item), item.id).toEqual(aclOf(world, item))
        for (const p of everyone) expect(reads(restored, p, item), `${p} ${item.id}`).toBe(reads(world, p, item))
      }
    },
  ),
  c0(
    'R7-05c',
    'Rule 7 DRV-01: a whole-org share on a folder stops reaching what is inside once the folder is in the Trash, in can() and in the stored rows',
    () => {
      // Ashton shares their vendor-quotes folder with the whole org; Priya's quotes sit in it. Then
      // Ashton trashes the folder.
      const shared = editFolder(F.vendor, x => ({
        ...x,
        grants: [...x.grants, { grantee: { kind: 'org', id: world.orgId }, role: 'viewer' }],
      }))
      const before = changed(shared)
      const w = changed(steps(shared, trashFolder(F.vendor, P.ashton)))
      const kranji = ref.file(FI.kranji)
      expect(reads(before, P.nadia, kranji)).toBe(true)
      expect(storedRowReads(before, kranji, P.nadia)).toBe(true)
      expectReaders(w, kranji, [P.priya, P.ashton], [P.nadia, P.kelvin, P.arjun, P.weiling])
      expect(storedRowReads(w, kranji, P.nadia)).toBe(false)
      expect(filterReadable(w, human(P.nadia), refsOf('file')).map(key)).not.toContain(key(kranji))
      // Ashton's own movers sheet goes with the folder: Priya, its Editor, can't open it there.
      expectReaders(w, ref.file(FI.movers), [P.ashton], [P.priya, P.nadia])
      // Restored, the org reads the quote again.
      const restored = changed(steps(shared, trashFolder(F.vendor, P.ashton), restoreFolder(F.vendor)))
      expect(reads(restored, P.nadia, kranji)).toBe(true)
      expect(storedRowReads(restored, kranji, P.nadia)).toBe(true)
    },
  ),
  c0(
    'R7-05d',
    'Rule 7 DRV-01: an agent reads nothing in the Trash, even inside its scope, so no AI run uses it',
    () => {
      // The HR agent's scope is the HR wiki; the Finance agent's holds the CFO's Q3 numbers.
      const wiki = ref.folder(F.hr)
      const policy = ref.file(FI.leavePolicy)
      const numbers = ref.file(FI.q3Numbers)
      expect(canRead(world, agent(AG.hr), wiki)).toBe(true)
      expect(canRead(world, agent(AG.hr), policy)).toBe(true)
      expect(canRead(world, agent(AG.finance), numbers)).toBe(true)
      // Hui Min trashes the wiki and the CFO trashes the sheet.
      const w = changed(steps(trashFolder(F.hr, P.huimin), trashFile(FI.q3Numbers, P.cfo)))
      for (const a of agents) {
        for (const item of [wiki, policy, numbers]) expect(canRead(w, a, item), `${label(a)} ${item.id}`).toBe(false)
      }
      // Their owners still read them, so the refusal comes from the Trash, not from lost access.
      expect(reads(w, P.huimin, policy)).toBe(true)
      expect(reads(w, P.cfo, numbers)).toBe(true)
      // Asked by the CFO in their DM, the Finance agent may use the sheet until it is trashed.
      const asked = (x: World) => ({
        run: 'agent_asked' as const,
        agentId: AG.finance,
        asker: human(P.cfo),
        audience: audienceOf(x, ref.agentDm(CV.cfoFinance)),
      })
      expect(sourceAllowed(world, asked(world), numbers)).toBe(true)
      expect(sourceAllowed(w, asked(w), numbers)).toBe(false)
    },
  ),
  c0(
    'R7-05e',
    'Rule 7 FILE-02 DRV-17: nothing in the Trash is edited, commented on, shared, presented, handed over or added to, by its owner or anyone',
    () => {
      const w = changed(trashFolder(F.q4, P.priya))
      // Before, each owner could change their own item, and Daniel, a named Editor, could edit and
      // present the deck.
      for (const [item, owner] of Q4_TREE) {
        expect(can(world, human(owner), { action: 'edit', resource: item }), `${owner} ${item.id}`).toBe(true)
      }
      for (const action of ['edit', 'present', 'share'] as const) {
        expect(can(world, human(P.daniel), { action, resource: ref.file(FI.q4Deck) }), action).toBe(true)
      }
      for (const [item] of Q4_TREE) {
        for (const p of everyone) {
          for (const action of DRIVE_CHANGES) {
            expect(can(w, human(p), { action, resource: item }), `${p} ${action} ${item.id}`).toBe(false)
          }
          const share = {
            action: 'share.set' as const,
            resource: item,
            grantee: { kind: 'person' as const, id: P.nadia },
          }
          expect(can(w, human(p), { ...share, role: 'viewer' }), `${p} share ${item.id}`).toBe(false)
          expect(
            can(w, human(p), { action: 'transfer_ownership', resource: item, to: { kind: 'person', id: P.nadia } }),
            `${p} transfer ${item.id}`,
          ).toBe(false)
        }
      }
      // Nothing new goes into a folder in the Trash.
      expect(can(world, human(P.priya), { action: 'create', kind: 'file', in: ref.folder(F.q4) })).toBe(true)
      expect(can(world, human(P.ahmad), { action: 'create', kind: 'folder', in: ref.folder(F.q4Contract) })).toBe(true)
      expect(can(w, human(P.priya), { action: 'create', kind: 'file', in: ref.folder(F.q4) })).toBe(false)
      expect(can(w, human(P.ahmad), { action: 'create', kind: 'folder', in: ref.folder(F.q4Contract) })).toBe(false)
      // The proposal's comments go with it: its owner still reads them, nobody resolves, edits or
      // deletes them.
      expect(can(world, human(P.priya), { action: 'resolve', resource: ref.comment(CM.q4Daniel) })).toBe(true)
      expect(can(world, human(P.daniel), { action: 'delete', resource: ref.comment(CM.q4Daniel) })).toBe(true)
      expect(reads(w, P.priya, ref.comment(CM.q4Daniel))).toBe(true)
      for (const comment of [CM.q4Daniel, CM.q4Ahmad]) {
        for (const p of everyone) {
          for (const action of ['resolve', 'edit', 'delete'] as const) {
            expect(can(w, human(p), { action, resource: ref.comment(comment) }), `${p} ${action} ${comment}`).toBe(
              false,
            )
          }
        }
      }
    },
  ),
  c0(
    'R7-05f',
    'Rule 7 FILE-02 DRV-01 DRV-18: only the owner, or whoever trashed it while still an Editor, restores an item, and only from where it was trashed',
    () => {
      // Farah, an Editor, trashes Marcus's runbook. Priya, also an Editor, didn't.
      const runbook = ref.file(FI.runbook)
      const w = changed(trashFile(FI.runbook, P.farah))
      for (const p of everyone) {
        expect(can(w, human(p), { action: 'restore', resource: runbook }), p).toBe(p === P.marcus || p === P.farah)
      }
      // Priya trashes the Q4 folder: it comes back whole. Nothing inside is restored on its own,
      // by its own owner either (Wei Ling owns the forecast, Ahmad the contract folder and MSA).
      const q4 = changed(trashFolder(F.q4, P.priya))
      for (const p of everyone) {
        expect(can(q4, human(p), { action: 'restore', resource: ref.folder(F.q4) }), p).toBe(p === P.priya)
      }
      for (const [item] of Q4_TREE.slice(1)) {
        for (const p of everyone) {
          expect(can(q4, human(p), { action: 'restore', resource: item }), `${p} ${item.id}`).toBe(false)
        }
      }
      // Something that isn't in the Trash has nothing to restore.
      expect(can(world, human(P.marcus), { action: 'restore', resource: runbook })).toBe(false)
    },
  ),
  c0(
    'R7-05g',
    'Rule 7 FILE-02 DRV-01 DRV-67: only an item’s own owner purges it; owning the folder it is in, trashing it or holding an org role isn’t enough',
    () => {
      const kranji = ref.file(FI.kranji)
      // Ashton owns the vendor folder, so they may edit and trash Priya's Kranji quote inside it.
      expect(can(world, human(P.ashton), { action: 'trash', resource: kranji })).toBe(true)
      for (const by of [P.ashton, P.priya]) {
        const w = changed(trashFile(FI.kranji, by))
        for (const p of everyone) {
          expect(can(w, human(p), { action: 'purge', resource: kranji }), `${p}, trashed by ${by}`).toBe(p === P.priya)
        }
        expect(
          can(w, human(P.ashton), {
            action: 'transfer_ownership',
            resource: kranji,
            to: { kind: 'person', id: P.ashton },
          }),
        ).toBe(false)
      }
      // Ashton, who trashed it, still restores it as its Editor; they just can't destroy it.
      expect(
        can(changed(trashFile(FI.kranji, P.ashton)), human(P.ashton), { action: 'restore', resource: kranji }),
      ).toBe(true)
      // Nothing outside the Trash is purged, by its owner either.
      expect(can(world, human(P.priya), { action: 'purge', resource: kranji })).toBe(false)
      // A folder in the Trash is purged by the folder's owner; the items others own inside it aren't
      // purged one by one (R7-05i moves them to their owners).
      const vendor = changed(trashFolder(F.vendor, P.ashton))
      expect(can(vendor, human(P.ashton), { action: 'purge', resource: ref.folder(F.vendor) })).toBe(true)
      expect(can(vendor, human(P.priya), { action: 'purge', resource: ref.folder(F.vendor) })).toBe(false)
      for (const p of everyone) expect(can(vendor, human(p), { action: 'purge', resource: kranji }), p).toBe(false)
      // A team-owned item is purged by the team's Team Admin, not by its members (T13).
      const policy = ref.file(FI.opsPolicy)
      const teamTrash = changed(trashFile(FI.opsPolicy, P.marcus))
      expect(can(teamTrash, human(P.marcus), { action: 'purge', resource: policy })).toBe(true)
      for (const member of [P.priya, P.farah, P.kelvin]) {
        expect(can(teamTrash, human(member), { action: 'purge', resource: policy }), member).toBe(false)
      }
    },
  ),
  core(
    'R7-05h',
    'C0.10, C4.1',
    'Rule 7 FILE-02 ADM-08 DRV-57: purge and the Trash clean-up are refused while the item, a folder above it, its owner or its container is on legal hold (isHeld)',
  ),
  core(
    'R7-05i',
    'C4.1',
    'Rule 7 DRV-01 DRV-67: purging a folder deletes only what its owner owns; everyone else’s items inside go back to their owners’ My Drive',
  ),
  core(
    'R7-05j',
    'C4.1',
    'Rule 7 FILE-02 PDPA-09: items left in the Trash for 30 days are deleted by the deletion code, which logs each one',
  ),
  core('R7-06', 'C1.7', 'Rule 7 CHAT-05: a deleted or edited message leaves the keyword index within 5 minutes'),
  core(
    'R7-07',
    'C5.8',
    'Rule 7 SHEET-44 SLIDE-34 SLIDE-35: only a sheet’s current version is indexed, and deleting a deck spares its slide copies',
  ),
  ai(
    'R7-08',
    'A2.2, A2.4',
    'Rule 7 BRAIN-04 PRD-44 PRD-110: the Org Brain drops deletes and edits within 5 minutes; derived items are regenerated or withdrawn, keeping human edits',
  ),
  ai('R7-09', 'C6.1, A2.4', 'Rule 7 PDPA-07: a correction stops the old data resurfacing in AI answers'),
  core(
    'R7-10',
    'C2.9',
    'Rule 7 REC-23 PDPA-09: recordings, transcripts, notes and slide copies are deleted only by the retention engine, the DPO on a request or redaction, each deletion logged',
  ),
  core(
    'R7-11',
    'C0.10',
    'Rule 7 PDPA-09 BRAIN-08: deleting a source deletes or marks stale what was made from it, and the deletion log replays after a restore',
  ),
  c0(
    'R7-12',
    'Rule 7 CHAT-05 DOC-05: only a message’s or comment’s author deletes it, for everyone; a channel owner, the Owner and the DPO can’t',
    () => {
      // Marcus's message in #ops-north-site, which Priya owns; Ashton is the Owner and DPO.
      const message = ref.message(M.ops2)
      for (const p of everyone) {
        expect(can(world, human(p), { action: 'delete', resource: message }), p).toBe(p === P.marcus)
      }
      for (const s of [...assistants, ...agents, system]) {
        expect(can(world, s, { action: 'delete', resource: message }), label(s)).toBe(false)
      }
      // Once deleted, nobody reads, edits or deletes it again, Marcus included.
      const w = changed(deleteMessage(M.ops2))
      for (const p of everyone) {
        for (const action of ['read', 'edit', 'delete'] as const) {
          expect(can(w, human(p), { action, resource: message }), `${p} ${action}`).toBe(false)
        }
      }
      // Daniel deletes their own comment on the Q4 proposal; its owner Priya can't.
      for (const p of everyone) {
        expect(can(world, human(p), { action: 'delete', resource: ref.comment(CM.q4Daniel) }), p).toBe(p === P.daniel)
      }
    },
  ),
  core(
    'R7-12b',
    'C1.10',
    'Rule 7 CHAT-05: a moderator’s removal of a message propagates exactly as its author’s delete does',
  ),
]
