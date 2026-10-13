// Unit tests for audiences (audience.ts; Rule 2, Rule 3, PRD-35, decision 9, SLIDE-18, REC-13,
// REC-20): which tokens can gain holders, who holds a token now, and the edges of audienceGap,
// covers and sameAudience (an unknown, empty or other org's audience covers nothing).
import { describe, expect, test } from 'vitest'
import {
  type Audience,
  audienceGap,
  audienceOf,
  audienceOfPeople,
  audiencePeople,
  covers,
  eraToken,
  holdersOf,
  isOpenToken,
  keysOf,
  membersToken,
  orgToken,
  personToken,
  type Ref,
  readersOf,
  sameAudience,
  stampFor,
  teamAdminsToken,
  teamToken,
  type World,
} from './index.ts'
import {
  AG,
  ALL_REFS,
  C,
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
  ORG_2_PEOPLE,
  P,
  R,
  ref,
  S,
  T,
  TH,
} from './testing/index.ts'

const world = fixtureWorld()
const o = orgToken(ORG)
const p = personToken
const t = teamToken
const ta = teamAdminsToken
const m = membersToken
const q4Era = (person: string, n?: number) => eraToken(`mb:${CV.q4}:${person}${n === undefined ? '' : `:${n}`}`)
const sortedIds = (...ids: string[]) => [...new Set(ids)].sort()
const audience = (...tokens: string[]): Audience => ({ orgId: ORG, tokens })
const leadershipMembers = sortedIds(P.ashton, P.priya, P.weiling, P.ahmad, P.huimin)
// Ahmad leaves the group DM after its last message.
const ahmadLeft = () =>
  fixtureWorld(f => ({
    ...f,
    memberships: f.memberships.map(x => (x.id === `mb:${CV.q4}:${P.ahmad}:2` ? { ...x, throughSeq: 6 } : x)),
  }))

describe('audienceOf: a place’s readers, kept as tokens (Rule 2, decision 9)', () => {
  test('a public place is the whole org; a private one its members token; a DM its members', () => {
    expect(audienceOf(world, ref.channel(C.general))).toEqual({ orgId: ORG, tokens: [o] })
    expect(audienceOf(world, ref.channel(C.leadership))).toEqual({ orgId: ORG, tokens: [m(C.leadership)] })
    expect(audienceOf(world, ref.room(R.board))).toEqual({ orgId: ORG, tokens: [m(R.board)] })
    expect(audienceOf(world, ref.groupDm(CV.q4))).toEqual({ orgId: ORG, tokens: [m(CV.q4)] })
  })

  test('null when the place is unknown, readable by nobody, or needs several clauses', () => {
    expect(audienceOf(world, ref.channel('ch-missing'))).toBeNull()
    expect(audienceOf(world, ref.message(M.opsDeleted))).toBeNull()
    expect(audienceOf(world, ref.derived(DV.empty))).toBeNull()
    const w = fixtureWorld(f => ({
      ...f,
      derived: [...f.derived, { id: 'dv-two', sources: [ref.message(M.leadership), ref.file(FI.q3Numbers)] }],
    }))
    expect(readersOf(w, ref.derived('dv-two'))).toHaveLength(2)
    expect(audienceOf(w, ref.derived('dv-two'))).toBeNull()
  })

  test('STU-02: audienceOfPeople names people once each, sorted; no people is null', () => {
    expect(audienceOfPeople(world, [P.priya, P.ashton, P.priya])).toEqual({
      orgId: ORG,
      tokens: [p(P.ashton), p(P.priya)],
    })
    expect(audienceOfPeople(world, [])).toBeNull()
  })
})

describe('isOpenToken: a token whose holders can grow (decision 9, decision 10)', () => {
  test('the org, a team and a team’s admins are open', () => {
    expect(isOpenToken(world, o)).toBe(true)
    expect(isOpenToken(world, t(T.q4))).toBe(true)
    expect(isOpenToken(world, ta(T.operations))).toBe(true)
  })

  test('the members of a channel or a standalone room, public or private, are open', () => {
    for (const id of [C.general, C.leadership, C.studio, R.lounge, R.board, R.people]) {
      expect(isOpenToken(world, m(id)), id).toBe(true)
    }
  })

  test('a person, an era, and the members of a DM, group DM, agent DM, assistant chat or thread are closed', () => {
    // A DM never gains members, and someone added to a group DM later doesn't see what was posted
    // before.
    for (const id of [CV.ashtonPriya, CV.q4, CV.floor, CV.itHelpdesk, CV.ashtonAssistant, TH.q4Event]) {
      expect(isOpenToken(world, m(id)), id).toBe(false)
    }
    expect(isOpenToken(world, p(P.ashton))).toBe(false)
    expect(isOpenToken(world, q4Era(P.ashton))).toBe(false)
  })

  test('the members of something that isn’t a space, or an unknown kind of token, are closed', () => {
    // A channel's room and a meeting room aren't spaces of their own.
    for (const id of [R.ops, R.q4, 'x-missing']) expect(isOpenToken(world, m(id)), id).toBe(false)
    expect(isOpenToken(world, 'x:anything')).toBe(false)
    expect(isOpenToken(world, '')).toBe(false)
  })
})

describe('holdersOf: the active people who hold a token now', () => {
  test('o: is every active person in this org, and nobody for another org', () => {
    expect(holdersOf(world, o).sort()).toEqual(world.activePeople().sort())
    expect(holdersOf(world, o)).not.toContain(P.formerDpo)
    expect(holdersOf(world, orgToken(ORG_2))).toEqual([])
  })

  test('p: is that person while active', () => {
    expect(holdersOf(world, p(P.ashton))).toEqual([P.ashton])
    expect(holdersOf(world, p(P.formerDpo))).toEqual([])
    expect(holdersOf(world, p('x-unknown'))).toEqual([])
  })

  test('t: is a team’s current active members, an archived team’s included', () => {
    expect(holdersOf(world, t(T.q4)).sort()).toEqual(sortedIds(P.ashton, P.priya, P.daniel, P.ahmad, P.weiling))
    expect(holdersOf(world, t(T.nightShift)).sort()).toEqual(sortedIds(P.kelvin, P.farah))
    expect(holdersOf(world, t('x-team'))).toEqual([])
    const w = fixtureWorld(f => ({
      ...f,
      people: f.people.map(x => (x.id === P.daniel ? { ...x, deactivatedAt: 1 } : x)),
      teamMembers: f.teamMembers.map(x => (x.teamId === T.q4 && x.personId === P.weiling ? { ...x, removedAt: 1 } : x)),
    }))
    expect(holdersOf(w, t(T.q4)).sort()).toEqual(sortedIds(P.ashton, P.priya, P.ahmad))
  })

  test('ta: is a live team’s current Team Admins; an archived team has none (T13)', () => {
    expect(holdersOf(world, ta(T.operations))).toEqual([P.marcus])
    expect(holdersOf(world, ta(T.people))).toEqual([P.huimin])
    expect(holdersOf(world, ta(T.nightShift))).toEqual([])
    expect(holdersOf(world, ta(T.q4))).toEqual([])
  })

  test('m: is a space’s current human members: agents and people who have left don’t count (CHAT-17)', () => {
    expect(holdersOf(world, m(C.leadership)).sort()).toEqual(leadershipMembers)
    expect(holdersOf(world, m(C.leadership))).not.toContain(AG.digest)
    expect(holdersOf(world, m(C.it))).not.toContain(AG.it)
    expect(holdersOf(world, m(CV.itHelpdesk))).toEqual([P.ashton])
    expect(holdersOf(world, m('x-missing'))).toEqual([])
    expect(holdersOf(ahmadLeft(), m(CV.q4))).not.toContain(P.ahmad)
  })

  test('e: is an era’s person while they are a current member of its group DM (decision 10)', () => {
    expect(holdersOf(world, q4Era(P.ashton))).toEqual([P.ashton])
    // Ahmad's first era closed, but they rejoined: Ahmad still reads the messages it covers.
    expect(holdersOf(world, q4Era(P.ahmad, 1))).toEqual([P.ahmad])
    expect(holdersOf(ahmadLeft(), q4Era(P.ahmad, 1))).toEqual([])
    expect(holdersOf(ahmadLeft(), q4Era(P.ahmad, 2))).toEqual([])
    expect(holdersOf(world, eraToken('x-missing'))).toEqual([])
  })

  test('an unknown kind of token is held by nobody', () => {
    expect(holdersOf(world, `x:${P.ashton}`)).toEqual([])
    expect(holdersOf(world, P.ashton)).toEqual([])
  })

  test('agrees with keysOf: a token’s holders are exactly the active people whose keys hold it', () => {
    for (const w of [world, ahmadLeft()]) {
      const tokens = new Set<string>()
      for (const r of ALL_REFS()) for (const clause of readersOf(w, r)) for (const token of clause) tokens.add(token)
      const keyed = w.facts.people.map(x => ({ id: x.id, keys: new Set(keysOf(w, human(x.id))) }))
      for (const x of keyed) for (const token of x.keys) tokens.add(token)
      for (const token of tokens) {
        const expected = keyed
          .filter(x => x.keys.has(token))
          .map(x => x.id)
          .sort()
        expect(holdersOf(w, token).sort(), token).toEqual(expected)
      }
    }
  })
})

describe('audiencePeople', () => {
  test('lists the people of an audience once each, sorted; agents never', () => {
    expect(audiencePeople(world, audienceOf(world, ref.channel(C.leadership)))).toEqual(leadershipMembers)
    expect(audiencePeople(world, audience(m(C.leadership), p(P.ashton), t(T.leadership)))).toEqual(
      sortedIds(...leadershipMembers),
    )
  })

  test('a null or other org’s audience has no people (ACC-11)', () => {
    expect(audiencePeople(world, null)).toEqual([])
    expect(audiencePeople(world, { orgId: ORG_2, tokens: [orgToken(ORG_2)] })).toEqual([])
    // Even if its tokens name this org.
    expect(audiencePeople(world, { orgId: ORG_2, tokens: [o] })).toEqual([])
  })
})

describe('audienceGap and covers (Rule 2, Rule 3, SLIDE-18)', () => {
  const unknown = { count: 0, people: [], includesFuture: true }

  test('a null, empty or other org’s audience is all gap and covers nothing', () => {
    const item = ref.message(M.ops1)
    expect(audienceGap(world, null, item)).toEqual(unknown)
    expect(audienceGap(world, audience(), item)).toEqual(unknown)
    expect(audienceGap(world, { orgId: ORG_2, tokens: [o] }, item)).toEqual(unknown)
    expect(audienceGap(world, { orgId: ORG_2, tokens: [orgToken(ORG_2)] }, item)).toEqual(unknown)
    expect(covers(world, null, item)).toBe(false)
    expect(covers(world, audience(), item)).toBe(false)
    expect(covers(world, { orgId: ORG_2, tokens: [o] }, item)).toBe(false)
    // ORG_2's own handbook, shared with its whole org, isn't in this snapshot either.
    expect(covers(world, { orgId: ORG_2, tokens: [orgToken(ORG_2)] }, ref.file('d-org2-handbook'))).toBe(false)
    expect(covers(world, { orgId: ORG_2, tokens: [p(ORG_2_PEOPLE.owner)] }, item)).toBe(false)
  })

  test('the whole org covers only what the whole org reads, and the gap counts everyone who can’t', () => {
    const general = audienceOf(world, ref.channel(C.general))
    expect(audienceGap(world, general, ref.message(M.ops1))).toEqual({ count: 0, people: [], includesFuture: false })
    expect(covers(world, general, ref.folder(F.ops))).toBe(true)
    const gap = audienceGap(world, general, ref.message(M.leadership))
    const outside = world.activePeople().filter(x => !leadershipMembers.includes(x))
    expect(gap.people).toEqual(outside.sort())
    expect(gap.count).toBe(outside.length)
    expect(gap.includesFuture).toBe(true)
    // Shared by name with everyone active today still leaves out the next hire.
    expect(covers(world, general, ref.event(E.allHands))).toBe(false)
  })

  test('a private channel covers its own messages and what the whole org reads, now and later', () => {
    const leadership = audienceOf(world, ref.channel(C.leadership))
    expect(audienceGap(world, leadership, ref.message(M.leadership))).toEqual({
      count: 0,
      people: [],
      includesFuture: false,
    })
    expect(covers(world, leadership, ref.channel(C.general))).toBe(true)
    expect(covers(world, leadership, ref.room(R.leadershipOneOnOnes))).toBe(true)
    // A derived item whose only clause is the channel's own token.
    const w = fixtureWorld(f => ({
      ...f,
      derived: [...f.derived, { id: 'dv-lead', sources: [ref.message(M.digest), ref.message(M.leadership)] }],
    }))
    expect(covers(w, audienceOf(w, ref.channel(C.leadership)), ref.derived('dv-lead'))).toBe(true)
  })

  test('an open token is covered only by the same token or the whole org, so person grants leave a future gap', () => {
    const leadership = audienceOf(world, ref.channel(C.leadership))
    // Hui Min, a member, can't read the Q4 deck (the others do, by name or through the Q4 team);
    // later members couldn't either.
    const gap = audienceGap(world, leadership, ref.file(FI.q4Deck))
    expect(gap.people).toEqual([P.huimin])
    expect(gap.includesFuture).toBe(true)
    // A second clause the channel's token doesn't satisfy is a future gap too.
    const w = fixtureWorld(f => ({
      ...f,
      derived: [...f.derived, { id: 'dv-two', sources: [ref.message(M.leadership), ref.file(FI.q3Numbers)] }],
    }))
    const two = audienceGap(w, audienceOf(w, ref.channel(C.leadership)), ref.derived('dv-two'))
    expect(two.includesFuture).toBe(true)
    expect(two.people).toEqual(sortedIds(P.priya, P.ahmad, P.huimin))
    // Nothing anyone can read: every holder is in the gap, and so is anyone later.
    const none = audienceGap(world, leadership, ref.message(M.opsDeleted))
    expect(none).toEqual({ count: leadershipMembers.length, people: leadershipMembers, includesFuture: true })
  })

  test('a team audience is covered by the team’s own grant, not by grants to each of its people', () => {
    const team = audience(t(T.q4))
    expect(covers(world, team, ref.folder(F.q4))).toBe(true)
    expect(covers(world, team, ref.file(FI.forecast))).toBe(true)
    expect(covers(world, team, ref.derived(DV.mixed))).toBe(true)
    const gap = audienceGap(world, team, ref.file(FI.q3Numbers))
    expect(gap.people).toEqual(sortedIds(P.priya, P.daniel, P.ahmad))
    expect(gap.includesFuture).toBe(true)
    expect(covers(world, audience(ta(T.operations)), ref.file(FI.opsPolicy))).toBe(true)
  })

  test('a closed audience is covered when everyone who holds it now can read the item, with no future gap', () => {
    const dm = audienceOf(world, ref.dm(CV.ashtonPriya))
    expect(audienceGap(world, dm, ref.file(FI.movers))).toEqual({ count: 0, people: [], includesFuture: false })
    expect(covers(world, dm, ref.file(FI.movers))).toBe(true)
    // Priya can't read the board update.
    expect(audienceGap(world, dm, ref.file(FI.boardUpdate))).toEqual({
      count: 1,
      people: [P.priya],
      includesFuture: false,
    })
    expect(covers(world, dm, ref.file(FI.boardUpdate))).toBe(false)
    // A group DM's audience is its members now: a later joiner doesn't see earlier messages anyway.
    const group = audienceOf(world, ref.groupDm(CV.q4))
    expect(covers(world, group, ref.file(FI.q4Deck))).toBe(true)
    expect(audienceGap(world, group, ref.file(FI.movers))).toEqual({
      count: 2,
      people: sortedIds(P.daniel, P.ahmad),
      includesFuture: false,
    })
    expect(covers(world, audienceOfPeople(world, [P.ashton, P.priya]), ref.file(FI.movers))).toBe(true)
  })

  test('an audience whose only holders have left covers nothing, unless the item has its own token', () => {
    // Everyone has left #design-crit: nobody to check person by person, but later members would
    // still see what is posted there.
    const w = fixtureWorld(f => ({
      ...f,
      memberships: f.memberships.map(x => (x.spaceId === C.studio ? { ...x, throughSeq: 1 } : x)),
    }))
    const studio = audienceOf(w, ref.channel(C.studio))
    expect(audiencePeople(w, studio)).toEqual([])
    expect(covers(w, studio, ref.file(FI.rachelNotes))).toBe(false)
    expect(audienceGap(w, studio, ref.file(FI.rachelNotes))).toEqual({ count: 0, people: [], includesFuture: true })
    expect(covers(w, studio, ref.message(M.studio))).toBe(true)
  })
})

describe('sameAudience (REC-13: notes go only where the readers exactly match)', () => {
  test('a null or empty audience is never the same as anything', () => {
    const general = audienceOf(world, ref.channel(C.general))
    expect(sameAudience(world, null, general)).toBe(false)
    expect(sameAudience(world, general, null)).toBe(false)
    expect(sameAudience(world, null, null)).toBe(false)
    expect(sameAudience(world, audience(), audience())).toBe(false)
  })

  test('two whole-org places are the same; a whole-org and a private place aren’t', () => {
    const general = audienceOf(world, ref.channel(C.general))
    expect(sameAudience(world, general, audienceOf(world, ref.channel(C.design)))).toBe(true)
    expect(sameAudience(world, general, audienceOf(world, ref.channel(C.leadership)))).toBe(false)
    // Everyone active, named one by one, will miss the next hire.
    expect(sameAudience(world, general, audienceOfPeople(world, world.activePeople()))).toBe(false)
  })

  test('two private channels with the same members today aren’t the same: their members will diverge', () => {
    const w = fixtureWorld(f => ({
      ...f,
      channels: [
        ...f.channels,
        { id: 'ch-leadership-copy', visibility: 'private', ownerTeamId: null, owners: [P.ashton], archivedAt: null },
      ],
      memberships: [
        ...f.memberships,
        ...leadershipMembers.map(id => ({
          id: `mb-copy-${id}`,
          spaceId: 'ch-leadership-copy',
          principalId: id,
          afterSeq: 0,
          throughSeq: null,
        })),
      ],
    }))
    const a = audienceOf(w, ref.channel(C.leadership))
    const b = audienceOf(w, ref.channel('ch-leadership-copy'))
    expect(audiencePeople(w, a)).toEqual(audiencePeople(w, b))
    expect(sameAudience(w, a, b)).toBe(false)
    expect(sameAudience(w, a, a)).toBe(true)
  })

  test('a DM call where both took part has the DM’s audience; a group-DM call someone missed doesn’t', () => {
    expect(
      sameAudience(world, audienceOf(world, ref.session(S.dmCall)), audienceOf(world, ref.dm(CV.ashtonPriya))),
    ).toBe(true)
    const call = (w: World) => audienceOf(w, ref.session(S.q4Call))
    const group = (w: World) => audienceOf(w, ref.groupDm(CV.q4))
    expect(sameAudience(world, call(world), group(world))).toBe(false)
    // Once Ahmad, who missed the call, has left, the call's people are the group's.
    const left = ahmadLeft()
    expect(sameAudience(left, call(left), group(left))).toBe(true)
  })

  test('a person named beside an open token isn’t the same as the open token alone: they stay after leaving it', () => {
    const lead = m(C.leadership)
    expect(sameAudience(world, audience(lead, p(P.priya)), audience(lead))).toBe(false)
    expect(sameAudience(world, audience(lead, p(P.priya)), audience(p(P.priya), lead))).toBe(true)
  })

  test('T13: an audience naming someone the snapshot lacks, or people who have all left, is never the same', () => {
    const unknown = audience(p('b9999999-0000-4000-8000-000000000099'))
    expect(sameAudience(world, unknown, unknown)).toBe(false)
    const gone = audienceOfPeople(world, [P.formerDpo])
    expect(sameAudience(world, gone, gone)).toBe(false)
    expect(sameAudience(world, audience(m('ch-unknown')), audience(m('ch-unknown')))).toBe(false)
  })

  test('ACC-11: audiences from another org are never the same, whoever they name', () => {
    const owner = { orgId: ORG_2, tokens: [p(ORG_2_PEOPLE.owner)] }
    const someoneElse = { orgId: ORG_2, tokens: [p('b2000000-0000-4000-8000-000000000002')] }
    expect(sameAudience(world, owner, someoneElse)).toBe(false)
    expect(sameAudience(world, owner, audienceOfPeople(world, [P.formerDpo]))).toBe(false)
  })
})

describe('stampFor: what a session stamps at its start (REC-20, C2.4)', () => {
  test('a restricted room stamps restricted, whatever the base audience (Rule 5)', () => {
    expect(stampFor(world, { roomId: R.leadershipOneOnOnes })).toEqual({
      restricted: true,
      audience: 'space',
      spaceId: C.leadership,
    })
    const meeting = stampFor(world, { roomId: R.people, eventId: E.q4 })
    expect(meeting).toMatchObject({ restricted: true, audience: 'invitees_and_participants', eventId: E.q4 })
    expect(meeting?.audience === 'invitees_and_participants' ? [...meeting.invitees].sort() : []).toEqual(
      sortedIds(P.priya, P.ashton, P.daniel, P.ahmad, P.weiling),
    )
  })

  test('a meeting stamps its organiser and invitees at the start', () => {
    const stamp = stampFor(world, { roomId: R.q4 })
    expect(stamp).toMatchObject({ restricted: false, audience: 'invitees_and_participants', eventId: E.q4 })
    expect(stamp?.audience === 'invitees_and_participants' ? [...stamp.invitees].sort() : []).toEqual(
      sortedIds(P.priya, P.ashton, P.daniel, P.ahmad, P.weiling),
    )
  })

  test('no stamp for an unknown room, conversation or event, an assistant chat, a channel given as a conversation, or nowhere', () => {
    const nowhere: Parameters<typeof stampFor>[1][] = [
      { roomId: 'rm-missing' },
      { roomId: 'rm-missing', eventId: E.q4 },
      { conversationId: 'dm-missing' },
      { conversationId: CV.ashtonAssistant },
      { conversationId: C.general },
      { eventId: 'ev-missing' },
      {},
    ]
    for (const place of nowhere) expect(stampFor(world, place), JSON.stringify(place)).toBeNull()
  })

  test('a DM or group-DM call stamps its participants', () => {
    for (const conversationId of [CV.ashtonPriya, CV.q4, CV.itHelpdesk]) {
      expect(stampFor(world, { conversationId }), conversationId).toEqual({
        restricted: false,
        audience: 'participants',
      })
    }
  })

  test('every stamp it makes gives a session readers someone holds', () => {
    // The stamps for the fixture's rooms, used as a session's stamp, never leave it unreadable.
    for (const room of world.facts.rooms) {
      const stamp = stampFor(world, { roomId: room.id })
      expect(stamp, room.id).not.toBeNull()
      if (!stamp) continue
      const w = fixtureWorld(f => ({
        ...f,
        sessions: [
          ...f.sessions,
          { id: 'ss-new', place: { kind: 'room', roomId: room.id }, participants: [P.ashton], stamp },
        ],
      }))
      const item: Ref = ref.session('ss-new')
      expect(readersOf(w, item).length, room.id).toBe(1)
    }
  })
})
