import { expect } from 'vitest'
import {
  aclOf,
  audienceOf,
  audienceOfPeople,
  audiencePeople,
  type ConversationKind,
  can,
  canRead,
  containersOf,
  covers,
  type Facts,
  type Id,
  type IndexClass,
  indexClassOf,
  inScope,
  listAccessible,
  OWNER_ONLY_ROLES,
  type Ref,
  readersOf,
  SEARCHABLE_CLASSES,
  sourceAllowed,
  stampFor,
  type World,
} from '../../index.ts'
import {
  AG,
  ALL_REFS,
  AS,
  agent,
  assistant,
  C,
  CV,
  FI,
  human,
  M,
  P,
  ROLE_HOLDERS,
  ref,
  S,
  SEED_PEOPLE,
  T,
  TH,
  TK,
} from '../index.ts'
import { ai, c0, core, type RuleCase } from './case.ts'
import { changed, expectReaders, reads, world } from './helpers.ts'

const everyone = [...SEED_PEOPLE, P.cfo, P.formerDpo, P.formerAdmin]
const AGENTS = Object.values(AG)
const ASSISTANTS: [Id, Id][] = [
  [AS.ashton, P.ashton],
  [AS.daniel, P.daniel],
]
const CONVERSATION_KINDS: readonly ConversationKind[] = ['dm', 'group_dm', 'agent_dm', 'assistant_chat']

// Every agent's scope widened to every item in the fixture, so scope never stands in the way and
// only Rule 4 can refuse.
function allSeeing(f: Facts): Facts {
  const everything = ALL_REFS()
  return { ...f, agents: f.agents.map(a => ({ ...a, scope: everything })) }
}

// The people, among everyone in the fixture, who can read an item.
const readersAmong = (w: World, item: Ref): Id[] => everyone.filter(p => reads(w, p, item))

// A principal added to a conversation after the given message sequence number.
const addMember =
  (spaceId: Id, principalId: Id, afterSeq: number) =>
  (f: Facts): Facts => ({
    ...f,
    memberships: [
      ...f.memberships,
      { id: `mb-extra:${spaceId}:${principalId}`, spaceId, principalId, afterSeq, throughSeq: null },
    ],
  })

const EXPECTED_CLASS: Record<ConversationKind, IndexClass> = {
  dm: 'dm',
  group_dm: 'dm',
  agent_dm: 'agent_dm',
  assistant_chat: 'personal',
}

export const RULE_4: readonly RuleCase[] = [
  c0(
    'R4-01',
    'Rule 4 PA-02 C1.7: a human DM or group DM, and everything in it, is class dm: read by its members and their assistants, never by an agent',
    () => {
      const w = changed(allSeeing)
      const dmClass = ALL_REFS().filter(item => indexClassOf(w, item) === 'dm')
      // The human DMs and group DMs, their messages, an attachment, both calls, the call's thread
      // and its message, and the task made from a DM message.
      expect(dmClass).toEqual(
        expect.arrayContaining([
          ref.dm(CV.ashtonPriya),
          ref.dm(CV.farahKelvin),
          ref.groupDm(CV.q4),
          ref.groupDm(CV.floor),
          ref.message(M.priya1),
          ref.message(M.q4First),
          ref.file(FI.q4Attachment),
          ref.session(S.dmCall),
          ref.session(S.q4Call),
          ref.thread(TH.q4Call),
          ref.message(M.q4CallThread),
          ref.task(TK.fromDm),
        ]),
      )
      // Searchable by the people who can read it (C1.7).
      expect(SEARCHABLE_CLASSES).toContain('dm')
      for (const item of dmClass) {
        for (const a of AGENTS) expect(canRead(w, agent(a), item), `${a} ${item.id}`).toBe(false)
        for (const [as, owner] of ASSISTANTS) {
          expect(canRead(w, assistant(as), item), `${as} ${item.id}`).toBe(reads(w, owner, item))
        }
        // Every person who reads it is a current member of the conversation it sits in.
        const conversation = containersOf(w, item).find(c => c.kind === 'dm' || c.kind === 'group_dm')
        if (conversation) {
          for (const p of readersAmong(w, item)) {
            expect(w.isCurrentMember(p, conversation.id), `${p} ${item.id}`).toBe(true)
          }
        }
      }
      // The same agents read ordinary items now in their scope, so the refusals are Rule 4's.
      expect(canRead(w, agent(AG.finance), ref.message(M.ops1))).toBe(true)
    },
  ),
  c0(
    'R4-02',
    'Rule 4 CHAT-17 PA-02: a DM with an agent is class agent_dm: read by its person, their assistant and that agent only',
    () => {
      const w = changed(allSeeing)
      for (const item of [ref.agentDm(CV.itHelpdesk), ref.message(M.itHelp1), ref.message(M.itHelp2)]) {
        expect(indexClassOf(w, item)).toBe('agent_dm')
        expect(aclOf(w, item)).toEqual({ tokens: [`m:${CV.itHelpdesk}`], more: [], indexClass: 'agent_dm' })
        expect(readersAmong(w, item)).toEqual([P.ashton])
        expect(canRead(w, assistant(AS.ashton), item)).toBe(true)
        expect(canRead(w, assistant(AS.daniel), item)).toBe(false)
        expect(AGENTS.filter(a => canRead(w, agent(a), item))).toEqual([AG.it])
      }
      // The CFO's DM with the Finance agent likewise.
      for (const item of [ref.agentDm(CV.cfoFinance), ref.message(M.finance)]) {
        expect(indexClassOf(w, item)).toBe('agent_dm')
        expect(readersAmong(w, item)).toEqual([P.cfo])
        expect(AGENTS.filter(a => canRead(w, agent(a), item))).toEqual([AG.finance])
        for (const [as] of ASSISTANTS) expect(canRead(w, assistant(as), item)).toBe(false)
      }
      expect(SEARCHABLE_CLASSES).toContain('agent_dm')
    },
  ),
  c0(
    'R4-03',
    'Rule 4 AGT-04 PA-11: a specialist agent never reads a human DM or group DM, even in its scope or asked by a member',
    () => {
      const w = changed(allSeeing)
      const items = [
        ref.dm(CV.ashtonPriya),
        ref.message(M.priya1),
        ref.dm(CV.cfoWeiling),
        ref.message(M.cfoQ3),
        ref.groupDm(CV.q4),
        ref.message(M.q4Fifth),
        ref.file(FI.q4Attachment),
        ref.session(S.dmCall),
        ref.session(S.q4Call),
        ref.thread(TH.q4Call),
        ref.task(TK.fromDm),
      ]
      for (const a of AGENTS) {
        const scope = w.agent(a)?.scope ?? []
        for (const item of items) {
          expect(inScope(w, scope, item), `${a} ${item.id}`).toBe(true)
          expect(canRead(w, agent(a), item), `${a} ${item.id}`).toBe(false)
        }
      }
      // Asked by Ashton, a member, with the DM itself as the audience: still out.
      expect(
        sourceAllowed(
          w,
          {
            run: 'agent_asked',
            agentId: AG.it,
            asker: human(P.ashton),
            audience: audienceOf(w, ref.dm(CV.ashtonPriya)),
          },
          ref.message(M.priya1),
        ),
      ).toBe(false)
      // Delegated by Ashton's assistant (PA-11), answering in Ashton's assistant conversation: still out.
      expect(
        sourceAllowed(
          w,
          {
            run: 'agent_asked',
            agentId: AG.it,
            asker: assistant(AS.ashton),
            audience: audienceOf(w, ref.assistantChat(CV.ashtonAssistant)),
          },
          ref.message(M.priya1),
        ),
      ).toBe(false)
      // The CFO asks the Finance agent in their own DM with it: the Q3 numbers in its scope are in,
      // the CFO's DM with Wei Ling about them is out.
      const cfoAsks = {
        run: 'agent_asked' as const,
        agentId: AG.finance,
        asker: human(P.cfo),
        audience: audienceOf(world, ref.agentDm(CV.cfoFinance)),
      }
      expect(sourceAllowed(world, cfoAsks, ref.file(FI.q3Numbers))).toBe(true)
      expect(sourceAllowed(world, cfoAsks, ref.message(M.cfoQ3))).toBe(false)
      // With the same scope the agents read ordinary items, so the refusal is Rule 4's.
      expect(canRead(w, agent(AG.it), ref.message(M.ops1))).toBe(true)
    },
  ),
  c0(
    'R4-04',
    'Rule 4 CHAT-17: a DM with an agent is visible to that agent without being in its scope, and to no other agent',
    () => {
      // The IT helpdesk agent's scope is #it-help and the IT wiki; its DM with Ashton isn't listed.
      expect(world.agent(AG.it)?.scope).not.toContainEqual(ref.agentDm(CV.itHelpdesk))
      expect(canRead(world, agent(AG.it), ref.agentDm(CV.itHelpdesk))).toBe(true)
      expect(canRead(world, agent(AG.it), ref.message(M.itHelp1))).toBe(true)
      expect(canRead(world, agent(AG.it), ref.message(M.finance))).toBe(false)
      // Listing the DM in the Finance agent's scope doesn't let it in.
      const listed = changed(f => ({
        ...f,
        agents: f.agents.map(a =>
          a.id === AG.finance ? { ...a, scope: [...a.scope, ref.agentDm(CV.itHelpdesk)] } : a,
        ),
      }))
      expect(canRead(listed, agent(AG.finance), ref.agentDm(CV.itHelpdesk))).toBe(false)
      expect(canRead(listed, agent(AG.finance), ref.message(M.itHelp1))).toBe(false)
      // An archived agent, or one taken out of the DM, reads nothing in it; Ashton still does.
      const archived = changed(f => ({
        ...f,
        agents: f.agents.map(a => (a.id === AG.it ? { ...a, archivedAt: 2 } : a)),
      }))
      const removed = changed(f => ({
        ...f,
        memberships: f.memberships.map(m =>
          m.spaceId === CV.itHelpdesk && m.principalId === AG.it ? { ...m, throughSeq: 2 } : m,
        ),
      }))
      for (const w of [archived, removed]) {
        expect(canRead(w, agent(AG.it), ref.message(M.itHelp1))).toBe(false)
        expect(reads(w, P.ashton, ref.message(M.itHelp1))).toBe(true)
      }
      // An attachment in the DM goes with its message.
      const attached = changed(f => ({
        ...f,
        files: [
          ...f.files,
          {
            id: 'up-it-screenshot',
            subtype: 'upload',
            parent: { kind: 'message', id: M.itHelp1 },
            owner: { kind: 'person', id: P.ashton },
            grants: [],
            editingLimitedTo: null,
            editorsCanShare: true,
            trashedAt: null,
            trashedById: null,
          },
        ],
      }))
      expect(canRead(attached, agent(AG.it), ref.file('up-it-screenshot'))).toBe(true)
      expect(canRead(attached, agent(AG.finance), ref.file('up-it-screenshot'))).toBe(false)
      expect(indexClassOf(attached, ref.file('up-it-screenshot'))).toBe('agent_dm')
    },
  ),
  c0(
    'R4-05',
    'Rule 4 Rule 9 ACC-10: no one outside a conversation reads it, or anything in it, through can(), whatever roles they hold',
    () => {
      const check = (w: World, person: Id) => {
        for (const kind of CONVERSATION_KINDS) {
          for (const conversation of w.all(kind)) {
            const item = { kind, id: conversation.id }
            const inIt =
              kind === 'assistant_chat' ? conversation.ownerId === person : w.isCurrentMember(person, conversation.id)
            expect(reads(w, person, item), `${person} ${conversation.id}`).toBe(inIt)
            if (inIt) continue
            // Nor its messages, calls or their threads, nor any action on it.
            for (const m of w.all('message').filter(m => m.spaceId === conversation.id)) {
              expect(reads(w, person, ref.message(m.id)), `${person} ${m.id}`).toBe(false)
            }
            for (const s of w.all('session')) {
              if (s.place.kind !== 'conversation' || s.place.conversationId !== conversation.id) continue
              expect(reads(w, person, ref.session(s.id)), `${person} ${s.id}`).toBe(false)
            }
            for (const action of ['post', 'join', 'leave'] as const) {
              expect(can(w, human(person), { action, resource: item }), `${person} ${action} ${conversation.id}`).toBe(
                false,
              )
            }
            const self = { kind: 'human' as const, id: person }
            expect(can(w, human(person), { action: 'member.add', resource: item, principal: self })).toBe(false)
          }
        }
      }
      for (const person of [...ROLE_HOLDERS, P.cfo, P.formerAdmin]) {
        check(world, person)
        // Each of them is outside at least one human DM and one group DM, so the check isn't empty.
        expect(world.all('dm').some(c => !world.isCurrentMember(person, c.id))).toBe(true)
        expect(world.all('group_dm').some(c => !world.isCurrentMember(person, c.id))).toBe(true)
      }
      // Nadia, given every org role and Team Admin of every team, is in no conversation and reads
      // none.
      const allRoles = changed(f => ({
        ...f,
        roles: [
          ...f.roles,
          ...OWNER_ONLY_ROLES.map(role => ({ personId: P.nadia, role, teamId: null, revokedAt: null })),
          ...Object.values(T).map(teamId => ({
            personId: P.nadia,
            role: 'team_admin' as const,
            teamId,
            revokedAt: null,
          })),
        ],
      }))
      check(allRoles, P.nadia)
      for (const kind of CONVERSATION_KINDS) expect(listAccessible(allRoles, human(P.nadia), kind)).toEqual([])
      const dmContent = ALL_REFS().filter(item => ['dm', 'agent_dm', 'personal'].includes(indexClassOf(allRoles, item)))
      expect(dmContent.filter(item => reads(allRoles, P.nadia, item))).toEqual([])
    },
  ),
  c0('R4-06', 'Rule 4 PA-02 §7.1: a participant’s assistant reads the DM; a non-participant’s can’t', () => {
    expect(canRead(world, assistant(AS.ashton), ref.dm(CV.ashtonPriya))).toBe(true)
    expect(canRead(world, assistant(AS.ashton), ref.message(M.priya2))).toBe(true)
    expect(canRead(world, assistant(AS.daniel), ref.dm(CV.ashtonPriya))).toBe(false)
    expect(canRead(world, assistant(AS.daniel), ref.message(M.priya2))).toBe(false)
    expect(canRead(world, assistant(AS.ashton), ref.message(M.farahKelvin))).toBe(false)
    // Answering its owner privately, in their assistant conversation, it may use their DMs and
    // nobody else's.
    const privately = (viewer: Id) => ({
      run: 'built_in' as const,
      viewer: assistant(viewer),
      audience: audienceOf(world, ref.assistantChat(CV.ashtonAssistant)),
    })
    expect(sourceAllowed(world, privately(AS.ashton), ref.message(M.priya2))).toBe(true)
    expect(sourceAllowed(world, privately(AS.ashton), ref.message(M.farahKelvin))).toBe(false)
    expect(sourceAllowed(world, privately(AS.daniel), ref.message(M.priya2))).toBe(false)
    // Shown where others can see it, the DM is out even for a member's assistant (Rule 2).
    const inGeneral = { ...privately(AS.ashton), audience: audienceOf(world, ref.channel(C.general)) }
    expect(sourceAllowed(world, inGeneral, ref.message(M.priya2))).toBe(false)
  }),
  ai(
    'R4-06b',
    'A4.1',
    'Rule 4 PA-02: the assistant answers from its owner’s DMs and group DMs, and never from anyone else’s',
  ),
  c0('R4-07', 'Rule 4 PA-01 §7.4 PDPA-15: an assistant conversation is its owner’s only, and their assistant’s', () => {
    const w = changed(allSeeing)
    const chat = ref.assistantChat(CV.ashtonAssistant)
    for (const item of [chat, ref.message(M.assistant)]) {
      expect(indexClassOf(w, item)).toBe('personal')
      expect(readersAmong(w, item)).toEqual([P.ashton])
      expect(canRead(w, assistant(AS.ashton), item)).toBe(true)
      expect(canRead(w, assistant(AS.daniel), item)).toBe(false)
      for (const a of AGENTS) expect(canRead(w, agent(a), item), a).toBe(false)
    }
    expect(readersAmong(world, ref.assistantChat(CV.danielAssistant))).toEqual([P.daniel])
    // Only the owner posts, and nobody is added.
    expect(can(world, human(P.ashton), { action: 'post', resource: chat })).toBe(true)
    expect(can(world, human(P.priya), { action: 'post', resource: chat })).toBe(false)
    expect(
      can(world, human(P.ashton), { action: 'member.add', resource: chat, principal: { kind: 'human', id: P.priya } }),
    ).toBe(false)
    // A stray membership row lets nobody else in.
    const stray = changed(addMember(CV.ashtonAssistant, P.priya, 0))
    expect(reads(stray, P.priya, ref.message(M.assistant))).toBe(false)
    // One without an owner is nobody's, and once its owner leaves, nobody reads it.
    const ownerless = changed(f => ({
      ...f,
      conversations: f.conversations.map(c => (c.id === CV.ashtonAssistant ? { ...c, ownerId: null } : c)),
    }))
    expect(readersAmong(ownerless, chat)).toEqual([])
    expect(indexClassOf(ownerless, chat)).toBe('restricted')
    const left = changed(f => ({
      ...f,
      people: f.people.map(p => (p.id === P.ashton ? { ...p, deactivatedAt: 2 } : p)),
    }))
    expect(readersAmong(left, chat)).toEqual([])
    expect(canRead(left, assistant(AS.ashton), chat)).toBe(false)
  }),
  c0(
    'R4-08',
    'Rule 4 REC-20 REC-13 C2.4: a DM call’s audience is the people who took part, and the call is class dm',
    () => {
      expect(stampFor(world, { conversationId: CV.ashtonPriya })).toEqual({
        restricted: false,
        audience: 'participants',
      })
      expect(stampFor(world, { conversationId: CV.q4 })).toEqual({ restricted: false, audience: 'participants' })
      // No call is held in an assistant conversation.
      expect(stampFor(world, { conversationId: CV.ashtonAssistant })).toBeNull()
      expect(audiencePeople(world, audienceOf(world, ref.session(S.dmCall)))).toEqual([P.ashton, P.priya].sort())
      expect(readersOf(world, ref.session(S.dmCall))).toEqual([[`p:${P.ashton}`, `p:${P.priya}`].sort()])
      // Ahmad, in the Q4 group DM but not on its call, can't read the call or its thread.
      expectReaders(world, ref.session(S.q4Call), [P.ashton, P.priya, P.daniel], [P.ahmad, P.weiling])
      expectReaders(world, ref.thread(TH.q4Call), [P.ashton, P.priya, P.daniel], [P.ahmad])
      const w = changed(allSeeing)
      for (const item of [
        ref.session(S.dmCall),
        ref.session(S.q4Call),
        ref.thread(TH.q4Call),
        ref.message(M.q4CallThread),
      ]) {
        expect(indexClassOf(w, item), item.id).toBe('dm')
        for (const a of AGENTS) expect(canRead(w, agent(a), item), `${a} ${item.id}`).toBe(false)
      }
    },
  ),
  core(
    'R4-08b',
    'C2.7',
    'Rule 4 REC-20 REC-13: DM and group calls stamp their participants and post notes only where the readers match',
  ),
  c0(
    'R4-09',
    'Rule 4 CHAT-02 CHAT-17 T13: nobody adds an agent to a human DM or group DM, and a 1:1 DM gains no members',
    () => {
      const add = (w: World, who: Id, conversation: Ref, principal: { kind: 'human' | 'agent'; id: Id }) =>
        can(w, human(who), { action: 'member.add', resource: conversation, principal })
      const anAgent = { kind: 'agent' as const, id: AG.it }
      const q4 = ref.groupDm(CV.q4)
      // A current member adds a person to a group DM; never an agent.
      expect(add(world, P.ashton, q4, { kind: 'human', id: P.rachel })).toBe(true)
      expect(add(world, P.ashton, q4, anAgent)).toBe(false)
      // Not someone already in it, nor someone who has left the org; and a non-member adds nobody.
      expect(add(world, P.ashton, q4, { kind: 'human', id: P.priya })).toBe(false)
      expect(add(world, P.ashton, q4, { kind: 'human', id: P.formerDpo })).toBe(false)
      expect(add(world, P.rachel, q4, { kind: 'human', id: P.nadia })).toBe(false)
      // A 1:1 DM and a DM with an agent gain nobody, person or agent: a third person means a new
      // group.
      for (const conversation of [ref.dm(CV.ashtonPriya), ref.agentDm(CV.itHelpdesk)]) {
        expect(add(world, P.ashton, conversation, { kind: 'human', id: P.rachel })).toBe(false)
        expect(add(world, P.ashton, conversation, anAgent)).toBe(false)
      }
      // CHAT-02: up to 20 people. The Q4 group has 4; with 15 more there is room for one.
      const crowd = (extra: number) =>
        changed(f => {
          const ids = Array.from(
            { length: extra },
            (_, i) => `b0000000-0000-4000-8000-0000000002${`${i}`.padStart(2, '0')}`,
          )
          return ids.reduce<Facts>((g, id) => addMember(CV.q4, id, 6)(g), {
            ...f,
            people: [...f.people, ...ids.map(id => ({ id, deactivatedAt: null }))],
          })
        })
      expect(add(crowd(15), P.ashton, q4, { kind: 'human', id: P.rachel })).toBe(true)
      expect(add(crowd(16), P.ashton, q4, { kind: 'human', id: P.rachel })).toBe(false)
      // Facts that put an agent in a group DM anyway close it to everyone (T13: what doesn't fit fails closed).
      const withAgent = changed(addMember(CV.q4, AG.digest, 6))
      expect(readersAmong(withAgent, q4)).toEqual([])
      expect(readersAmong(withAgent, ref.message(M.q4Fifth))).toEqual([])
      expect(canRead(withAgent, agent(AG.digest), ref.message(M.q4Fifth))).toBe(false)
      expect(indexClassOf(withAgent, q4)).toBe('restricted')
    },
  ),
  c0(
    'R4-10',
    'Rule 4 decision 10 PA-02: a later group-DM member’s assistant reads only the messages of their own spans',
    () => {
      const q4 = [M.q4First, M.q4Second, M.q4Third, M.q4Fourth, M.q4Fifth].map(ref.message)
      // Daniel joined after message 2.
      expect(q4.map(m => canRead(world, assistant(AS.daniel), m))).toEqual([false, false, true, true, true])
      expect(q4.map(m => canRead(world, assistant(AS.ashton), m))).toEqual([true, true, true, true, true])
      expect(canRead(world, assistant(AS.daniel), ref.file(FI.q4Attachment))).toBe(false)
      // Once Daniel leaves, their assistant reads none of it.
      const left = changed(f => ({
        ...f,
        memberships: f.memberships.map(m =>
          m.spaceId === CV.q4 && m.principalId === P.daniel ? { ...m, throughSeq: 6 } : m,
        ),
      }))
      expect(q4.map(m => canRead(left, assistant(AS.daniel), m))).toEqual([false, false, false, false, false])
    },
  ),
  ai(
    'R4-10b',
    'A2.2',
    'Rule 4 decision 10: a later group-DM member’s assistant indexes only the messages of their eras',
  ),
  ai('R4-11', 'A5.3', 'Rule 4 D7 AGT-09: agents never speak unprompted in DMs'),
  ai('R4-12', 'A5', 'Rule 4 PA-11: delegation passes only the user’s question to an agent, never DM content'),
  ai('R4-13', 'A4.3', 'Rule 4 PRD-105: agent output never seeds drafts that carry DM content to other people'),
  ai('R4-14', 'A4.4', 'Rule 4 PA-10 §7.4: personal memory is its owner’s only'),
  c0('R4-15', 'Rule 4 TASK-04 C2.1: a task or summary made from a DM keeps its class, so no agent reads it', () => {
    const summary = { id: 'dv-dm-and-ops', sources: [ref.message(M.priya1), ref.message(M.ops1)] }
    const w = changed(f =>
      allSeeing({
        ...f,
        derived: [...f.derived, summary],
        suggestedTasks: [...f.suggestedTasks, { id: 'st-from-dm', ownerId: P.priya, sourceRef: ref.message(M.priya1) }],
      }),
    )
    const task = ref.task(TK.fromDm)
    const derived = ref.derived(summary.id)
    expect(indexClassOf(w, task)).toBe('dm')
    expect(indexClassOf(w, derived)).toBe('dm')
    expect(readersAmong(w, task)).toEqual([P.ashton])
    expect(readersAmong(w, derived)).toEqual([P.ashton, P.priya])
    for (const a of AGENTS) {
      expect(canRead(w, agent(a), task), a).toBe(false)
      expect(canRead(w, agent(a), derived), a).toBe(false)
    }
    // A suggested task from a DM is its owner's only (TASK-06).
    expect(indexClassOf(w, ref.suggestedTask('st-from-dm'))).toBe('personal')
    expectReaders(w, ref.suggestedTask('st-from-dm'), [P.priya], [P.ashton])
  }),
  c0(
    'R4-16',
    'Rule 4 AGT-11: a scheduled agent run never uses a group-DM message, even when its whole audience can read it',
    () => {
      const w = changed(f => ({
        ...f,
        agents: f.agents.map(a => (a.id === AG.digest ? { ...a, scope: [...a.scope, ref.groupDm(CV.q4)] } : a)),
      }))
      const message = ref.message(M.q4Fifth)
      for (const audience of [audienceOfPeople(w, [P.ashton, P.priya]), audienceOf(w, ref.groupDm(CV.q4))]) {
        expect(covers(w, audience, message)).toBe(true)
        expect(sourceAllowed(w, { run: 'agent_scheduled', agentId: AG.digest, audience }, message)).toBe(false)
      }
      // The same run may use a #leadership message in its scope, so the refusal is Rule 4's.
      expect(
        sourceAllowed(
          w,
          { run: 'agent_scheduled', agentId: AG.digest, audience: audienceOfPeople(w, [P.ashton, P.priya]) },
          ref.message(M.leadership),
        ),
      ).toBe(true)
    },
  ),
  c0(
    'R4-17',
    'Rule 4 Rule 5 C0.6 C1.7: every conversation kind has its index class, and a conversation the snapshot can’t resolve is never indexed',
    () => {
      for (const conversation of world.facts.conversations) {
        const expected = EXPECTED_CLASS[conversation.kind]
        const item = { kind: conversation.kind, id: conversation.id }
        expect(indexClassOf(world, item), conversation.id).toBe(expected)
        expect(aclOf(world, item).indexClass, conversation.id).toBe(expected)
        for (const m of world.facts.messages.filter(m => m.spaceId === conversation.id)) {
          expect(indexClassOf(world, ref.message(m.id)), m.id).toBe(expected)
        }
      }
      // A ref naming the wrong kind, or a conversation that isn't there: readable by nobody, never
      // indexed.
      for (const item of [
        ref.dm(CV.q4),
        ref.groupDm(CV.ashtonPriya),
        ref.agentDm(CV.ashtonPriya),
        ref.dm('dm-unknown'),
      ]) {
        expect(readersOf(world, item), item.id).toEqual([])
        expect(indexClassOf(world, item), item.id).toBe('restricted')
      }
      expect(SEARCHABLE_CLASSES).not.toContain('restricted')
      // A DM message, and the task made from it, when the DM itself wasn't loaded.
      const unloaded = changed(f => ({
        ...f,
        conversations: f.conversations.filter(c => c.id !== CV.ashtonPriya),
      }))
      expect(readersOf(unloaded, ref.message(M.priya1))).toEqual([])
      expect(indexClassOf(unloaded, ref.message(M.priya1))).toBe('restricted')
      expect(readersAmong(unloaded, ref.message(M.priya1))).toEqual([])
      expect(canRead(unloaded, assistant(AS.ashton), ref.message(M.priya1))).toBe(false)
      expect(indexClassOf(unloaded, ref.task(TK.fromDm))).toBe('restricted')
      expect(indexClassOf(unloaded, ref.session(S.dmCall))).toBe('restricted')
    },
  ),
  c0(
    'R4-18',
    'Rule 4 decision 10 T13: a conversation whose members don’t fit its kind is readable by nobody and never indexed',
    () => {
      const closed = (w: World, items: readonly Ref[]) => {
        for (const item of items) {
          expect(readersAmong(w, item), item.id).toEqual([])
          for (const a of AGENTS) expect(canRead(w, agent(a), item), `${a} ${item.id}`).toBe(false)
          for (const [as] of ASSISTANTS) expect(canRead(w, assistant(as), item), `${as} ${item.id}`).toBe(false)
          expect(indexClassOf(w, item), item.id).toBe('restricted')
        }
      }
      const itDm = [ref.agentDm(CV.itHelpdesk), ref.message(M.itHelp1)]
      // An agent DM with a second person in it: the agent is refused, and so is everyone.
      closed(changed(addMember(CV.itHelpdesk, P.priya, 2)), itDm)
      // An agent DM with a second agent in it.
      closed(changed(addMember(CV.itHelpdesk, AG.finance, 2)), itDm)
      // A 1:1 DM with a third person who joined later: they don't get its history, and the DM
      // closes to everyone rather than guess.
      const third = changed(addMember(CV.ashtonPriya, P.rachel, 2))
      expect(reads(third, P.rachel, ref.message(M.priya1))).toBe(false)
      closed(third, [ref.dm(CV.ashtonPriya), ref.message(M.priya1), ref.message(M.priya2)])
      // A DM with an agent in it, labelled as a human DM: no agent reads it, nor anyone else.
      const labelled = changed(f => {
        const withDm: Facts = {
          ...f,
          conversations: [...f.conversations, { id: 'dm-mislabelled', kind: 'dm', ownerId: null }],
          messages: [
            ...f.messages,
            { id: 'm-mislabelled-1', spaceId: 'dm-mislabelled', seq: 1, authorId: P.ashton, deletedAt: null },
          ],
        }
        return [P.ashton, AG.it].reduce((g, principal) => addMember('dm-mislabelled', principal, 0)(g), withDm)
      })
      closed(labelled, [ref.dm('dm-mislabelled'), ref.message('m-mislabelled-1')])
      // An assistant as a member of a human DM closes it too.
      closed(changed(addMember(CV.ashtonPriya, AS.daniel, 2)), [ref.dm(CV.ashtonPriya), ref.message(M.priya2)])
    },
  ),
]
