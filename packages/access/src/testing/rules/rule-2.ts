import { expect } from 'vitest'
import {
  audienceGap,
  audienceOf,
  audienceOfPeople,
  audiencePeople,
  can,
  canRead,
  covers,
  sameAudience,
  sourceAllowed,
  stampFor,
} from '../../index.ts'
import { AG, agent, C, CV, DV, E, FI, human, M, P, R, ref, S, TH } from '../index.ts'
import { ai, c0, core, type RuleCase } from './case.ts'
import { changed, reads, world } from './helpers.ts'

const general = () => audienceOf(world, ref.channel(C.general))
const leadership = () => audienceOf(world, ref.channel(C.leadership))
// A new hire who joins the org later: in the whole-org audience, in no team or space yet.
const withNewHire = (id: string) => changed(f => ({ ...f, people: [...f.people, { id, deactivatedAt: null }] }))

export const RULE_2: readonly RuleCase[] = [
  c0('R2-01', 'Rule 2 §7.2 BUILD-PLAN C0.4: covers(audienceOf(#general), CFO-DM item) = false', () => {
    // The CFO's "Q3 numbers" message to Wei Ling, and the CFO's Q3 sheet, can't go into #general.
    expect(covers(world, general(), ref.message(M.cfoQ3))).toBe(false)
    expect(covers(world, general(), ref.file(FI.q3Numbers))).toBe(false)
    // What the whole org can read can.
    expect(covers(world, general(), ref.message(M.ops1))).toBe(true)
  }),
  c0(
    'R2-02',
    'Rule 2 §7.2: asked by the CFO, the Finance agent may use the Q3 numbers in the CFO’s DM, not in #general',
    () => {
      const asked = (place: ReturnType<typeof ref.channel>) => ({
        run: 'agent_asked' as const,
        agentId: AG.finance,
        asker: human(P.cfo),
        audience: audienceOf(world, place),
      })
      expect(sourceAllowed(world, asked(ref.agentDm(CV.cfoFinance)), ref.file(FI.q3Numbers))).toBe(true)
      expect(sourceAllowed(world, asked(ref.channel(C.general)), ref.file(FI.q3Numbers))).toBe(false)
    },
  ),
  ai('R2-03', 'A5', 'Rule 2 §7.2: the Finance agent answers at #general’s level there and says more in the CFO’s DM'),
  c0(
    'R2-04',
    'Rule 2 PRD-35 decision 9: a public channel’s audience is the whole org, including people who join later',
    () => {
      expect(general()?.tokens).toEqual([`o:${world.orgId}`])
      // A few-member public channel too: #design's audience is everyone.
      expect(audienceOf(world, ref.channel(C.design))?.tokens).toEqual([`o:${world.orgId}`])
      const later = withNewHire('b0000000-0000-4000-8000-000000000099')
      expect(audiencePeople(later, audienceOf(later, ref.channel(C.design)))).toContain(
        'b0000000-0000-4000-8000-000000000099',
      )
      // So something only today's members can read isn't covered.
      expect(covers(world, audienceOf(world, ref.channel(C.design)), ref.file(FI.q4Deck))).toBe(false)
    },
  ),
  c0('R2-05', 'Rule 2 decision 9: a private channel’s audience is its members now and later', () => {
    const a = leadership()
    expect(audiencePeople(world, a)).toEqual([P.ashton, P.priya, P.weiling, P.ahmad, P.huimin].sort())
    // An item every current member can read through person grants isn't covered: a later member
    // couldn't read it.
    const shared = changed(f => ({
      ...f,
      files: f.files.map(x =>
        x.id === FI.rachelNotes
          ? {
              ...x,
              grants: [P.ashton, P.priya, P.weiling, P.ahmad, P.huimin].map(id => ({
                grantee: { kind: 'person' as const, id },
                role: 'viewer' as const,
              })),
            }
          : x,
      ),
    }))
    const gap = audienceGap(shared, audienceOf(shared, ref.channel(C.leadership)), ref.file(FI.rachelNotes))
    expect(gap.count).toBe(0)
    expect(gap.includesFuture).toBe(true)
    expect(covers(shared, audienceOf(shared, ref.channel(C.leadership)), ref.file(FI.rachelNotes))).toBe(false)
    // Posted in the channel itself, it is.
    expect(covers(world, a, ref.message(M.leadership))).toBe(true)
  }),
  c0(
    'R2-06',
    'Rule 2 CHAT-03 ROOM-06: a channel’s room and its threads have the channel’s audience; a standalone room’s panel has the room’s',
    () => {
      expect(audienceOf(world, ref.room(R.ops))).toEqual(audienceOf(world, ref.channel(C.ops)))
      expect(audienceOf(world, ref.message(M.lounge))).toEqual(audienceOf(world, ref.room(R.lounge)))
      expect(audienceOf(world, ref.room(R.board))?.tokens).toEqual([`m:${R.board}`])
    },
  ),
  c0(
    'R2-07',
    'Rule 2 REC-13 CAL-03: a meeting’s thread and a participants-only call thread carry their own audience',
    () => {
      expect(audiencePeople(world, audienceOf(world, ref.thread(TH.q4Event)))).toEqual(
        [P.priya, P.ashton, P.daniel, P.ahmad, P.weiling].sort(),
      )
      expect(audiencePeople(world, audienceOf(world, ref.thread(TH.q4Call)))).toEqual(
        [P.ashton, P.priya, P.daniel].sort(),
      )
    },
  ),
  c0(
    'R2-08',
    'Rule 2 Rule 4 PA-11: a DM’s audience is its people; a DM with an agent has the person as its audience',
    () => {
      expect(audiencePeople(world, audienceOf(world, ref.dm(CV.ashtonPriya)))).toEqual([P.ashton, P.priya].sort())
      expect(audiencePeople(world, audienceOf(world, ref.agentDm(CV.cfoFinance)))).toEqual([P.cfo])
    },
  ),
  c0('R2-09', 'Rule 2 REC-20 RMS-44 C2.4: each kind of session gets its audience from stampFor', () => {
    // A room session in a channel's room: the channel's readers, live.
    expect(stampFor(world, { roomId: R.ops })).toEqual({ restricted: false, audience: 'space', spaceId: C.ops })
    // A standalone room: its own.
    expect(stampFor(world, { roomId: R.board })).toEqual({ restricted: false, audience: 'space', spaceId: R.board })
    // A meeting, in its own room or a team room: the invitees then, plus whoever takes part.
    expect(stampFor(world, { roomId: R.sales, eventId: E.pricing })).toMatchObject({
      audience: 'invitees_and_participants',
      eventId: E.pricing,
    })
    expect(stampFor(world, { roomId: R.q4 })).toMatchObject({ audience: 'invitees_and_participants', eventId: E.q4 })
    // A DM or group-DM call: its participants.
    expect(stampFor(world, { conversationId: CV.q4 })).toEqual({ restricted: false, audience: 'participants' })
    // A restricted room: participants only, whatever the base.
    expect(stampFor(world, { roomId: R.people })).toEqual({ restricted: true, audience: 'space', spaceId: R.people })
    // An unknown place: no stamp.
    expect(stampFor(world, { roomId: 'rm-nowhere' })).toBeNull()
  }),
  c0(
    'R2-10',
    'Rule 2 SLIDE-18 C2.4: a room session’s audience follows its space, so later members join it and leavers drop out',
    () => {
      const joined = changed(f => ({
        ...f,
        channels: f.channels.map(c => (c.id === C.ops ? { ...c, visibility: 'private' as const } : c)),
        memberships: [
          ...f.memberships.map(m => (m.spaceId === C.ops && m.principalId === P.farah ? { ...m, throughSeq: 6 } : m)),
          { id: 'mb-ops-nadia', spaceId: C.ops, principalId: P.nadia, afterSeq: 6, throughSeq: null },
        ],
      }))
      const people = audiencePeople(joined, audienceOf(joined, ref.session(S.standupFri)))
      expect(people).toContain(P.nadia)
      expect(people).not.toContain(P.farah)
    },
  ),
  c0('R2-11', 'Rule 2 CHAT-17 REC-01: agents and assistants in a space neither widen nor narrow its audience', () => {
    // #leadership has the Weekly Digest agent as a member; its audience is its people.
    expect(audiencePeople(world, leadership())).not.toContain(AG.digest)
    const moreAgents = changed(f => ({
      ...f,
      memberships: [
        ...f.memberships,
        { id: 'mb-leadership-it', spaceId: C.leadership, principalId: AG.it, afterSeq: 0, throughSeq: null },
      ],
    }))
    expect(audienceOf(moreAgents, ref.channel(C.leadership))).toEqual(leadership())
    expect(audiencePeople(moreAgents, audienceOf(moreAgents, ref.channel(C.leadership)))).toEqual(
      audiencePeople(world, leadership()),
    )
  }),
  c0(
    'R2-12',
    'Rule 2 AGT-04: a source outside the agent’s scope is left out even when the asker and audience can read it',
    () => {
      const run = { run: 'agent_asked' as const, agentId: AG.finance, asker: human(P.cfo), audience: general() }
      expect(sourceAllowed(world, run, ref.message(M.ops1))).toBe(false)
      expect(sourceAllowed(world, run, ref.message(M.general))).toBe(true)
    },
  ),
  c0('R2-13', 'Rule 2: a source the asker can’t read is left out even when the audience can', () => {
    const audience = audienceOfPeople(world, [P.weiling])
    const run = { run: 'agent_asked' as const, agentId: AG.finance, asker: human(P.rachel), audience }
    expect(sourceAllowed(world, run, ref.file(FI.q3Numbers))).toBe(false)
    expect(sourceAllowed(world, { ...run, asker: human(P.weiling) }, ref.file(FI.q3Numbers))).toBe(true)
  }),
  c0('R2-14', 'Rule 2: a source one member of the audience can\u2019t read is left out even when the asker can', () => {
    // The CFO and Wei Ling can both read the CFO's sheet; with Rachel in the audience it's out.
    const run = (people: string[]) => ({
      run: 'agent_asked' as const,
      agentId: AG.finance,
      asker: human(P.cfo),
      audience: audienceOfPeople(world, people),
    })
    expect(sourceAllowed(world, run([P.cfo, P.weiling]), ref.file(FI.q3Numbers))).toBe(true)
    expect(sourceAllowed(world, run([P.cfo, P.weiling, P.rachel]), ref.file(FI.q3Numbers))).toBe(false)
    // A private room's audience includes its later members, whom no person grant reaches.
    const room = { ...run([]), audience: audienceOf(world, ref.room(R.board)) }
    expect(sourceAllowed(world, room, ref.file(FI.q3Numbers))).toBe(false)
  }),
  c0(
    'R2-15',
    'Rule 2 AGT-10 AGT-11: a scheduled run uses AgentScope ∩ the audience; its owner’s and admins’ access are never used',
    () => {
      // Ashton, the Owner, reads the Q3 pricing review; #leadership as a whole doesn't.
      const run = { run: 'agent_scheduled' as const, agentId: AG.digest, audience: leadership() }
      expect(sourceAllowed(world, run, ref.session(S.pricing))).toBe(false)
      expect(sourceAllowed(world, run, ref.message(M.leadership))).toBe(true)
      // #ops-north-site is outside the digest's scope though all of #leadership reads it: only
      // AgentScope refuses it.
      expect(canRead(world, agent(AG.digest), ref.message(M.ops1))).toBe(false)
      expect(covers(world, leadership(), ref.message(M.ops1))).toBe(true)
      expect(sourceAllowed(world, run, ref.message(M.ops1))).toBe(false)
    },
  ),
  c0('R2-16', 'Rule 2 CHT-50: the Weekly Digest in #leadership can’t use the Q3 pricing review', () => {
    expect(covers(world, leadership(), ref.session(S.pricing))).toBe(false)
    expect(covers(world, leadership(), ref.derived(DV.digest))).toBe(false)
    const gap = audienceGap(world, leadership(), ref.session(S.pricing))
    expect(gap.people).toEqual([P.priya, P.huimin].sort())
  }),
  ai('R2-17', 'A2', 'Rule 2 X3: every AI-authored post in the seed and test data satisfies Rule 2'),
  c0(
    'R2-18',
    'Rule 2 SLIDE-18 PRD-108: audienceGap gives how many and whether later members are affected, never other items',
    () => {
      const gap = audienceGap(world, leadership(), ref.file(FI.q4Deck))
      expect(gap).toEqual({ count: 1, people: [P.huimin], includesFuture: true })
      expect(Object.keys(gap).sort()).toEqual(['count', 'includesFuture', 'people'])
    },
  ),
  c0('R2-19', 'Rule 2 REC-13: notes post only where the readers exactly match the session’s audience', () => {
    const same = (a: Parameters<typeof audienceOf>[1], b: Parameters<typeof audienceOf>[1]) =>
      sameAudience(world, audienceOf(world, a), audienceOf(world, b))
    expect(same(ref.session(S.standupFri), ref.channel(C.ops))).toBe(true)
    expect(same(ref.session(S.pricing), ref.channel(C.sales))).toBe(false)
    expect(same(ref.session(S.pricing), ref.event(E.pricing))).toBe(true)
    expect(same(ref.session(S.dmCall), ref.dm(CV.ashtonPriya))).toBe(true)
    // Ahmad missed the group-DM call: its notes go to a participants-only thread, not the group.
    expect(same(ref.session(S.q4Call), ref.groupDm(CV.q4))).toBe(false)
    expect(same(ref.session(S.q4Call), ref.thread(TH.q4Call))).toBe(true)
    expect(same(ref.session(S.q4Review), ref.thread(TH.q4Event))).toBe(true)
  }),
  core(
    'R2-19b',
    'C2.8',
    'Rule 2 REC-13: the target resolver posts the session card only where the readers exactly match: a channel’s room → its session thread in the channel, a standalone room → a session thread in its panel, a restricted room → the session page only',
  ),
  core(
    'R2-19c',
    'C3.3',
    'Rule 2 REC-13 CAL-03: a scheduled meeting, one held in a team room included, posts to its event thread, never to the room’s channel',
  ),
  ai(
    'R2-19d',
    'A3.1',
    'Rule 2 REC-13: meeting notes post only into the session card or event thread the resolver chose',
  ),
  c0('R2-20', 'Rule 2 CAL-03: a meeting may use a team room only if every invitee can join it', () => {
    const everyInviteeJoins = (room: string, invitees: readonly string[]) =>
      invitees.every(p => can(world, human(p), { action: 'join', resource: ref.room(room) }))
    expect(everyInviteeJoins(R.sales, [P.ashton, P.weiling, P.ahmad, P.rachel])).toBe(true)
    // #leadership's room is restricted and its channel private: Rachel can't join it.
    expect(everyInviteeJoins(R.leadershipOneOnOnes, [P.ashton, P.rachel])).toBe(false)
  }),
  core(
    'R2-20b',
    'C3.3',
    'Rule 2 CAL-03: scheduling refuses a team room unless the organiser and every invitee can join it, decided in packages/access',
  ),
  c0('R2-21', 'Rule 2 STU-02: view-as uses AgentScope ∩ the person ∩ the AI Admin', () => {
    const run = (w: typeof world, asker: string) => ({
      run: 'agent_asked' as const,
      agentId: AG.finance,
      asker: human(asker),
      audience: audienceOfPeople(w, [P.arjun]),
    })
    // The AI Admin leg: Arjun can't open the CFO's sheet, so view-as as the CFO withholds it.
    expect(sourceAllowed(world, run(world, P.cfo), ref.file(FI.q3Numbers))).toBe(false)
    expect(sourceAllowed(world, run(world, P.cfo), ref.message(M.general))).toBe(true)
    // The person leg: with Arjun granted the sheet, view-as as the CFO uses it, as Rachel doesn't.
    const arjunSees = changed(f => ({
      ...f,
      files: f.files.map(x =>
        x.id === FI.q3Numbers
          ? { ...x, grants: [...x.grants, { grantee: { kind: 'person', id: P.arjun }, role: 'viewer' }] }
          : x,
      ),
    }))
    expect(sourceAllowed(arjunSees, run(arjunSees, P.cfo), ref.file(FI.q3Numbers))).toBe(true)
    expect(sourceAllowed(arjunSees, run(arjunSees, P.rachel), ref.file(FI.q3Numbers))).toBe(false)
    // The scope leg: #ops-north-site is outside the Finance agent's scope, though the CFO and
    // Arjun both read it.
    expect(reads(world, P.cfo, ref.message(M.ops1)) && reads(world, P.arjun, ref.message(M.ops1))).toBe(true)
    expect(sourceAllowed(world, run(world, P.cfo), ref.message(M.ops1))).toBe(false)
  }),
  ai('R2-22', 'A5.5', 'Rule 2 STU-02 STU-03: view-as and evaluation sets run on the fixture org by default'),
  ai('R2-23', 'A4', 'Rule 2 PA-11: delegation answers with AgentScope ∩ Access(user) in the user’s DM'),
  ai(
    'R2-24',
    'A4',
    'Rule 2 PA-12: a shared answer is regenerated at the channel’s audience, checking every source used',
  ),
  ai('R2-25', 'A5', 'Rule 2 PRD-100 AGT-06: approval cards show only what the approver can open'),
  ai(
    'R2-26',
    'A5',
    'Rule 2 decision 9 AGT-11: AI posts in private spaces carry an audience override; later members who can’t read the sources don’t see them',
  ),
  core(
    'R2-27',
    'C5.6',
    'Rule 2 SLIDE-18 PRD-68: deck access is re-checked when the audience’s membership changes mid-presentation',
  ),
  core('R2-28', 'C5.6', 'Rule 2 ROOM-11: agents never receive a deck presented live'),
  ai('R2-29', 'A5', 'Rule 2 CHT-66 AGT-09: suggest cards are checked at post time'),
  ai('R2-30', 'A2', 'Rule 2 PRD-111: response caches are keyed by the sources’ ACLs and the audience'),
  c0(
    'R2-31',
    'Rule 2 PRD-35: an unknown audience covers nothing; a private channel with nobody in it still bounds by its later members',
    () => {
      expect(audienceOf(world, ref.channel('ch-unknown'))).toBeNull()
      expect(covers(world, null, ref.message(M.general))).toBe(false)
      expect(
        sourceAllowed(world, { run: 'agent_scheduled', agentId: AG.digest, audience: null }, ref.message(M.leadership)),
      ).toBe(false)
      // #leadership with every person gone and only the agent left still bounds by its later members.
      const empty = changed(f => ({
        ...f,
        memberships: f.memberships.map(m =>
          m.spaceId === C.leadership && m.principalId !== AG.digest ? { ...m, throughSeq: 2 } : m,
        ),
      }))
      const a = audienceOf(empty, ref.channel(C.leadership))
      expect(audiencePeople(empty, a)).toEqual([])
      expect(covers(empty, a, ref.session(S.pricing))).toBe(false)
      expect(covers(empty, a, ref.message(M.leadership))).toBe(true)
      expect(
        sourceAllowed(empty, { run: 'agent_scheduled', agentId: AG.digest, audience: a }, ref.session(S.pricing)),
      ).toBe(false)
    },
  ),
  c0(
    'R2-31b',
    'Rule 2 T13: an audience naming someone, a space or an era the snapshot lacks, people who have all left, or a conversation nobody is in covers nothing',
    () => {
      const restricted = ref.session(S.peopleAshton)
      const scheduled = (w: typeof world, audience: ReturnType<typeof audienceOf>) =>
        sourceAllowed(w, { run: 'agent_scheduled', agentId: AG.digest, audience }, ref.message(M.leadership))
      // A person the snapshot doesn't hold, and one who has left.
      for (const id of ['b9999999-0000-4000-8000-000000000099', P.formerDpo]) {
        const a = audienceOfPeople(world, [id])
        expect(covers(world, a, restricted), id).toBe(false)
        expect(covers(world, a, ref.file(FI.q3Numbers)), id).toBe(false)
        expect(audienceGap(world, a, restricted).includesFuture, id).toBe(true)
        expect(sameAudience(world, a, a), id).toBe(false)
      }
      // A group DM everyone has left.
      const emptied = changed(f => ({
        ...f,
        memberships: f.memberships.map(m =>
          m.spaceId === CV.floor && m.throughSeq === null ? { ...m, throughSeq: 99 } : m,
        ),
      }))
      expect(covers(emptied, audienceOf(emptied, ref.groupDm(CV.floor)), restricted)).toBe(false)
      // The CFO's agent DM once the CFO has left.
      const cfoGone = changed(f => ({
        ...f,
        people: f.people.map(x => (x.id === P.cfo ? { ...x, deactivatedAt: 1 } : x)),
      }))
      const cfoDm = audienceOf(cfoGone, ref.agentDm(CV.cfoFinance))
      expect(covers(cfoGone, cfoDm, ref.file(FI.q3Numbers))).toBe(false)
      expect(
        sourceAllowed(
          cfoGone,
          { run: 'agent_scheduled', agentId: AG.finance, audience: cfoDm },
          ref.file(FI.q3Numbers),
        ),
      ).toBe(false)
      // The Q4 review's event thread in a snapshot missing two attendees' people: the full world
      // refuses the pricing review there (Priya and Daniel can't read it), so the slice must too.
      const thread = ref.thread(TH.q4Event)
      expect(covers(world, audienceOf(world, thread), ref.session(S.pricing))).toBe(false)
      const slice = changed(f => ({ ...f, people: f.people.filter(x => x.id !== P.priya && x.id !== P.daniel) }))
      const sliced = audienceOf(slice, thread)
      expect(covers(slice, sliced, ref.session(S.pricing))).toBe(false)
      expect(
        sourceAllowed(slice, { run: 'agent_scheduled', agentId: AG.digest, audience: sliced }, ref.session(S.pricing)),
      ).toBe(false)
      expect(sameAudience(slice, sliced, audienceOf(slice, ref.session(S.q4Review)))).toBe(false)
      // A space or era the snapshot lacks: the audience is unknown, never smaller.
      const noChannel = changed(f => ({ ...f, channels: f.channels.filter(c => c.id !== C.leadership) }))
      expect(covers(noChannel, leadership(), ref.event(E.allHands))).toBe(false)
      const eraAudience = audienceOf(world, ref.message(M.q4Fifth))
      const danielEra = world.facts.memberships.find(m => m.spaceId === CV.q4 && m.principalId === P.daniel)
      const noEra = changed(f => ({ ...f, memberships: f.memberships.filter(m => m.id !== danielEra?.id) }))
      expect(covers(noEra, eraAudience, ref.message(M.q4First))).toBe(false)
      // A meeting thread's readers include everyone who took part in any session of its event, so
      // the loader holds them all (world.ts): here Daniel, not invited, joined a second pricing
      // session, and the first session's notes don't belong in the thread.
      const pricing = world.get({ kind: 'session', id: S.pricing })
      if (!pricing) throw new Error('the fixture has no pricing session')
      const secondSession = changed(f => ({
        ...f,
        sessions: [...f.sessions, { ...pricing, id: 'ss-pricing-2', participants: [P.ashton, P.daniel] }],
        threads: [...f.threads, { id: 'th-pricing', audience: { kind: 'event', eventId: E.pricing } }],
      }))
      const pricingThread = audienceOf(secondSession, ref.thread('th-pricing'))
      expect(sameAudience(secondSession, audienceOf(secondSession, ref.session(S.pricing)), pricingThread)).toBe(false)
      expect(covers(secondSession, pricingThread, ref.session(S.pricing))).toBe(false)
      // The unchanged fixture still lets the digest use #leadership's own post there.
      expect(scheduled(world, leadership())).toBe(true)
    },
  ),
  c0(
    'R2-32',
    'Rule 2 Rule 4: everyone in a group DM’s audience is a current member, so a later member can’t widen an earlier post',
    () => {
      expect(audiencePeople(world, audienceOf(world, ref.groupDm(CV.q4)))).toEqual(
        [P.ashton, P.priya, P.daniel, P.ahmad].sort(),
      )
    },
  ),
]
