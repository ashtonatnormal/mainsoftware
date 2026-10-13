import { expect } from 'vitest'
import {
  type Audience,
  aclOf,
  audienceGap,
  audienceOf,
  audienceOfPeople,
  can,
  canRead,
  covers,
  type Facts,
  type Id,
  indexClassOf,
  keysOf,
  listAccessible,
  type OrgRole,
  readersOf,
  SEARCHABLE_CLASSES,
  type SessionFact,
  type SessionStamp,
  sourceAllowed,
  stampFor,
  strictest,
  type World,
} from '../../index.ts'
import {
  AG,
  AS,
  agent,
  assistant,
  C,
  DV,
  human,
  M,
  P,
  R,
  ROLE_HOLDERS,
  ref,
  S,
  SC,
  SEED_PEOPLE,
  ST,
  T,
  TK,
} from '../index.ts'
import { ai, c0, core, type RuleCase } from './case.ts'
import { allows, changed, expectReaders, reads, rowReadable, world } from './helpers.ts'

const everyone = [...SEED_PEOPLE, P.cfo, P.formerDpo, P.formerAdmin]
const ORG_ROLES: OrgRole[] = ['owner', 'admin', 'ai_admin', 'leadership', 'dpo', 'compliance_officer']
const reauthenticated = { reauthenticated: true }
const p = (id: Id) => `p:${id}`

// What C2.4 will store when a session starts (stampFor), failing the case if there is no stamp.
function stamped(w: World, place: Parameters<typeof stampFor>[1]): SessionStamp {
  const stamp = stampFor(w, place)
  if (stamp === null) throw new Error('stampFor gave no stamp')
  return stamp
}
const withSession =
  (session: SessionFact) =>
  (f: Facts): Facts => ({ ...f, sessions: [...f.sessions, session] })
const withStamp =
  (id: Id, change: (stamp: SessionStamp) => SessionStamp) =>
  (f: Facts): Facts => ({
    ...f,
    sessions: f.sessions.map(s => (s.id === id ? { ...s, stamp: change(s.stamp) } : s)),
  })
// The participants of a fixture session.
function participantsOf(id: Id): readonly Id[] {
  return world.get({ kind: 'session', id })?.participants ?? []
}

export const RULE_5: readonly RuleCase[] = [
  c0(
    'R5-01',
    'Rule 5 REC-07 REC-20 RMS-55: a restricted session is readable by its participants only; a room member who wasn’t there is refused',
    () => {
      // Hui Min's 1:1 with Ashton in the People 1:1s room, a private restricted room whose other
      // members are Marcus, Farah and Kelvin. Its stamp keeps the room as its base audience.
      const session = ref.session(S.peopleAshton)
      expect(world.get({ kind: 'session', id: S.peopleAshton })?.stamp).toEqual({
        restricted: true,
        audience: 'space',
        spaceId: R.people,
      })
      expect(readersOf(world, session)).toEqual([[p(P.ashton), p(P.huimin)].sort()])
      expectReaders(
        world,
        session,
        [P.huimin, P.ashton],
        [P.marcus, P.farah, P.kelvin, P.priya, P.nadia, P.cfo, P.formerDpo],
      )
      expect(indexClassOf(world, session)).toBe('restricted')
      // A session started there now, stamped as C2.4 will (stampFor), is restricted the same way.
      const stamp = stamped(world, { roomId: R.people })
      expect(stamp).toEqual({ restricted: true, audience: 'space', spaceId: R.people })
      const later = changed(
        withSession({
          id: 'ss-people-later',
          place: { kind: 'room', roomId: R.people },
          participants: [P.huimin, P.kelvin],
          stamp,
        }),
      )
      expectReaders(later, ref.session('ss-people-later'), [P.huimin, P.kelvin], [P.ashton, P.marcus, P.farah])
      expect(indexClassOf(later, ref.session('ss-people-later'))).toBe('restricted')
    },
  ),
  c0(
    'R5-01b',
    'Rule 5 REC-07 REC-20 CAL-03: a meeting held in a restricted room is for the people who took part, not every invitee',
    () => {
      // The Q4 launch review's own room is made restricted; Priya and Ashton attend a new occurrence.
      const w = changed(f => ({ ...f, rooms: f.rooms.map(r => (r.id === R.q4 ? { ...r, restricted: true } : r)) }))
      const stamp = stamped(w, { roomId: R.q4 })
      expect(stamp).toMatchObject({ restricted: true, audience: 'invitees_and_participants' })
      const met = changed(f =>
        withSession({
          id: 'ss-q4-restricted',
          place: { kind: 'room', roomId: R.q4 },
          participants: [P.priya, P.ashton],
          stamp,
        })({ ...f, rooms: f.rooms.map(r => (r.id === R.q4 ? { ...r, restricted: true } : r)) }),
      )
      // Daniel, Ahmad and Wei Ling were invited but didn't attend: refused.
      expectReaders(met, ref.session('ss-q4-restricted'), [P.priya, P.ashton], [P.daniel, P.ahmad, P.weiling])
      expect(indexClassOf(met, ref.session('ss-q4-restricted'))).toBe('restricted')
      // The earlier, unrestricted review still goes to its invitees.
      expect(reads(met, P.ahmad, ref.session(S.q4Review))).toBe(true)
    },
  ),
  c0(
    'R5-01c',
    'Rule 5 REC-20 decision 13: the restricted flag holds on every kind of stamp: a room session, a meeting and a call',
    () => {
      // The same three sessions stamped restricted: each is its participants' only, and never indexed.
      for (const id of [S.standupFri, S.q4Review, S.q4Call]) {
        const w = changed(withStamp(id, stamp => ({ ...stamp, restricted: true })))
        expect(readersOf(w, ref.session(id)), id).toEqual([[...participantsOf(id)].map(p).sort()])
        expect(indexClassOf(w, ref.session(id)), id).toBe('restricted')
      }
      // Who that leaves out: an #ops-north-site member who missed the standup, an invitee who missed
      // the review, and the group-DM member who missed the call.
      const standup = changed(withStamp(S.standupFri, stamp => ({ ...stamp, restricted: true })))
      expect(reads(world, P.kelvin, ref.session(S.standupFri))).toBe(true)
      expect(reads(standup, P.kelvin, ref.session(S.standupFri))).toBe(false)
      const review = changed(withStamp(S.q4Review, stamp => ({ ...stamp, restricted: true })))
      expect(reads(world, P.weiling, ref.session(S.q4Review))).toBe(true)
      expect(reads(review, P.weiling, ref.session(S.q4Review))).toBe(false)
      // Every stamp states whether it is restricted; leaving it out doesn't typecheck.
      // @ts-expect-error: `restricted` is required on every variant
      const unstated: SessionStamp = { audience: 'participants' }
      expect(unstated.audience).toBe('participants')
    },
  ),
  c0(
    'R5-02',
    'Rule 5 Rule 9 ACC-10 RMS-55: no Owner, Admin, DPO, Compliance Officer or other role holder reads a restricted session they weren’t in',
    () => {
      // Farah and Kelvin's session in the People 1:1s room has no role holder in it. Ashton is the
      // Owner and DPO, Arjun the Admin, Wei Ling the Compliance Officer, and Hui Min owns the room
      // and is Team Admin of the team that owns it.
      const floor = ref.session(S.peopleFloor)
      for (const holder of [...ROLE_HOLDERS, P.formerDpo, P.formerAdmin]) {
        for (const action of ['read', 'correct', 'view_viewed_by'] as const) {
          expect(can(world, human(holder), { action, resource: floor }), `${holder} ${action}`).toBe(false)
        }
        expect(listAccessible(world, human(holder), 'session')).not.toContainEqual(floor)
        // The stored row refuses them too, so the SQL path agrees.
        expect(rowReadable(aclOf(world, floor), keysOf(world, human(holder))), holder).toBe(false)
      }
      // A member of the room given every org role, Team Admin of People and ownership of the room.
      const everything = changed(f => ({
        ...f,
        roles: [
          ...f.roles,
          ...ORG_ROLES.map(role => ({ personId: P.nadia, role, teamId: null, revokedAt: null })),
          { personId: P.nadia, role: 'team_admin' as const, teamId: T.people, revokedAt: null },
        ],
        rooms: f.rooms.map(r => (r.id === R.people ? { ...r, owners: [...r.owners, P.nadia] } : r)),
        memberships: [
          ...f.memberships,
          { id: 'mb-people-nadia', spaceId: R.people, principalId: P.nadia, afterSeq: 1, throughSeq: null },
        ],
      }))
      expect(reads(everything, P.nadia, floor)).toBe(false)
      // The DPO and the Compliance Officer may open their consoles, the only way in (Rule 9); can()
      // itself never opens the session for them.
      expect(can(world, human(P.ashton), { action: 'privileged_console.open', console: 'dpo' }, reauthenticated)).toBe(
        true,
      )
      expect(
        can(world, human(P.weiling), { action: 'privileged_console.open', console: 'compliance' }, reauthenticated),
      ).toBe(true)
      expectReaders(world, floor, [P.farah, P.kelvin], [])
    },
  ),
  c0('R5-03', 'Rule 5 BRAIN-03 decision 13: a restricted session and everything made from it are never indexed', () => {
    const items = [
      ref.session(S.peopleAshton),
      ref.session(S.peopleFloor),
      ref.session(S.opsRestricted),
      ref.slideCopy(SC.people),
      ref.derived(DV.restrictedNote),
      ref.task(TK.private),
      ref.suggestedTask(ST.people),
    ]
    for (const item of items) {
      expect(indexClassOf(world, item), item.id).toBe('restricted')
      expect(aclOf(world, item).indexClass, item.id).toBe('restricted')
    }
    expect(SEARCHABLE_CLASSES).not.toContain('restricted')
    // Items made from an ordinary session are indexed under their own readers.
    expect(indexClassOf(world, ref.session(S.standupFri))).toBe('normal')
    expect(indexClassOf(world, ref.task(TK.ot))).toBe('normal')
    expect(indexClassOf(world, ref.derived(DV.digest))).toBe('normal')
  }),
  c0(
    'R5-04',
    'Rule 5 Rule 3 RMS-55: anything made from a restricted session is restricted, and readable only by people who can read the session',
    () => {
      // What the fixture made from Hui Min's 1:1: a note, their private task, their suggested task and a slide copy.
      const madeFrom = [
        ref.derived(DV.restrictedNote),
        ref.task(TK.private),
        ref.suggestedTask(ST.people),
        ref.slideCopy(SC.people),
      ]
      const session = ref.session(S.peopleAshton)
      for (const item of madeFrom) {
        for (const person of everyone) {
          if (reads(world, person, item)) expect(reads(world, person, session), `${person} ${item.id}`).toBe(true)
        }
      }
      expectReaders(world, ref.derived(DV.restrictedNote), [P.huimin, P.ashton], [P.marcus, P.farah, P.kelvin, P.arjun])
      // A note made from a public #ops-north-site message and that 1:1 together: restricted, and only
      // the 1:1's participants read it, though the whole org reads the message.
      const mixed = changed(f => ({
        ...f,
        derived: [...f.derived, { id: 'dv-ops-and-1on1', sources: [ref.message(M.ops1), session] }],
        tasks: [
          ...f.tasks,
          {
            id: 'tk-from-floor',
            creatorId: P.farah,
            assignees: [P.farah],
            teamId: null,
            privateToId: P.farah,
            sourceRef: ref.session(S.peopleFloor),
          },
        ],
      }))
      expect(indexClassOf(mixed, ref.derived('dv-ops-and-1on1'))).toBe('restricted')
      expectReaders(mixed, ref.derived('dv-ops-and-1on1'), [P.huimin, P.ashton], [P.marcus, P.priya, P.nadia])
      expect(indexClassOf(mixed, ref.task('tk-from-floor'))).toBe('restricted')
      // The strictest source wins whatever else is mixed in.
      expect(strictest(['normal', 'dm', 'playback_only', 'restricted'])).toBe('restricted')
    },
  ),
  c0(
    'R5-04b',
    'Rule 5 Rule 3 AGT-04: an item made from a restricted session that the snapshot doesn’t hold is still restricted, and no agent reads it',
    () => {
      // A snapshot that left out Hui Min's 1:1 (a partial load), with the HR agent's scope naming
      // the note and the task made from it.
      const partial = changed(f => ({
        ...f,
        sessions: f.sessions.filter(s => s.id !== S.peopleAshton),
        agents: f.agents.map(a =>
          a.id === AG.hr ? { ...a, scope: [...a.scope, ref.derived(DV.restrictedNote), ref.task(TK.private)] } : a,
        ),
      }))
      for (const item of [ref.derived(DV.restrictedNote), ref.task(TK.private), ref.suggestedTask(ST.people)]) {
        expect(indexClassOf(partial, item), item.id).toBe('restricted')
        expect(canRead(partial, agent(AG.hr), item), item.id).toBe(false)
      }
      // The note's readers can't be worked out, so nobody reads it.
      expect(readersOf(partial, ref.derived(DV.restrictedNote))).toEqual([])
      for (const person of everyone) expect(reads(partial, person, ref.derived(DV.restrictedNote))).toBe(false)
    },
  ),
  c0(
    'R5-05',
    'Rule 5 REC-14 TASK-06 T13: a suggested task from a restricted session is its owner’s only; accepted, it is private until the owner shares it, and never indexed, even then',
    () => {
      // Hui Min's suggested task from their 1:1: Ashton took part in the session but can't see it.
      const suggestion = ref.suggestedTask(ST.people)
      expectReaders(world, suggestion, [P.huimin], [P.ashton, P.marcus])
      expect(can(world, human(P.huimin), { action: 'accept', resource: suggestion })).toBe(true)
      expect(can(world, human(P.ashton), { action: 'accept', resource: suggestion })).toBe(false)
      expect(can(world, human(P.ashton), { action: 'dismiss', resource: suggestion })).toBe(false)
      // Hui Min's accepted task names Marcus as an assignee, but stays Hui Min's alone until shared.
      const task = ref.task(TK.private)
      expectReaders(world, task, [P.huimin], [P.marcus, P.ashton])
      for (const action of ['edit', 'share', 'delete'] as const) {
        expect(can(world, human(P.huimin), { action, resource: task }), action).toBe(true)
        expect(can(world, human(P.marcus), { action, resource: task }), action).toBe(false)
      }
      expect(indexClassOf(world, task)).toBe('restricted')
      // Once Hui Min shares it, its assignees read it.
      const shared = changed(f => ({
        ...f,
        tasks: f.tasks.map(t => (t.id === TK.private ? { ...t, privateToId: null } : t)),
      }))
      expectReaders(shared, task, [P.huimin, P.marcus], [P.ashton, P.farah])
      // Sharing widens its readers only: made from a restricted session, it stays restricted.
      expect(indexClassOf(shared, task)).toBe('restricted')
      expect(aclOf(shared, task).indexClass).toBe('restricted')
    },
  ),
  core(
    'R5-05b',
    'C3.5',
    'Rule 5 REC-14 TASK-06: accepting a suggested task from a restricted session creates a task private to its owner',
  ),
  c0(
    'R5-06',
    'Rule 5 ROOM-11 AGT-04: an agent can’t join a restricted room or read its sessions, even with the room in its scope',
    () => {
      // The Weekly Digest is a member of #leadership, whose room is restricted.
      expect(can(world, agent(AG.digest), { action: 'join', resource: ref.room(R.leadershipOneOnOnes) })).toBe(false)
      // Hui Min owns the People 1:1s room and can't add an agent to it.
      expect(
        can(world, human(P.huimin), {
          action: 'member.add',
          resource: ref.room(R.people),
          principal: { kind: 'agent', id: AG.hr },
        }),
      ).toBe(false)
      // With the restricted rooms in its scope, the HR agent reads none of their restricted sessions or
      // what was made from them. With #ops-north-site in its scope, the IT agent reads the ordinary
      // standup there, not the session stamped restricted.
      const scoped = changed(f => ({
        ...f,
        agents: f.agents.map(a =>
          a.id === AG.hr
            ? { ...a, scope: [...a.scope, ref.room(R.people), ref.room(R.townhall)] }
            : a.id === AG.it
              ? { ...a, scope: [...a.scope, ref.channel(C.ops)] }
              : a,
        ),
      }))
      for (const item of [
        ref.session(S.peopleAshton),
        ref.session(S.peopleFloor),
        ref.slideCopy(SC.people),
        ref.derived(DV.restrictedNote),
      ]) {
        expect(canRead(scoped, agent(AG.hr), item), item.id).toBe(false)
      }
      expect(canRead(scoped, agent(AG.it), ref.session(S.standupFri))).toBe(true)
      expect(canRead(scoped, agent(AG.it), ref.session(S.opsRestricted))).toBe(false)
    },
  ),
  ai(
    'R5-06b',
    'A5.3',
    'Rule 5 ROOM-11 AGT-07: once agents can be added to rooms, a restricted room still refuses them and they never hear its sessions',
  ),
  c0(
    'R5-07',
    'Rule 5 decision 13 C2.4: a session keeps the class and audience stamped at its start when the room’s flag changes',
    () => {
      // Recorded before the People 1:1s room was restricted: still the room's members, still indexed.
      const before = ref.session(S.peopleBefore)
      expect(indexClassOf(world, before)).toBe('normal')
      expect(readersOf(world, before)).toEqual([[`m:${R.people}`]])
      expectReaders(world, before, [P.huimin, P.marcus, P.ashton, P.farah, P.kelvin], [P.priya, P.nadia])
      // Stamped restricted in #ops-north-site's room, which isn't restricted now: still participants only.
      const ops = ref.session(S.opsRestricted)
      expect(indexClassOf(world, ops)).toBe('restricted')
      expectReaders(world, ops, [P.marcus, P.farah], [P.ashton, P.priya, P.kelvin, P.nadia])
      // Flip both rooms' flags: no recorded session changes; only sessions started afterwards follow.
      const flipped = changed(f => ({
        ...f,
        rooms: f.rooms.map(r =>
          r.id === R.people ? { ...r, restricted: false } : r.id === R.ops ? { ...r, restricted: true } : r,
        ),
      }))
      for (const id of Object.values(S)) {
        expect(indexClassOf(flipped, ref.session(id)), id).toBe(indexClassOf(world, ref.session(id)))
        expect(readersOf(flipped, ref.session(id)), id).toEqual(readersOf(world, ref.session(id)))
      }
      expect(stamped(flipped, { roomId: R.ops }).restricted).toBe(true)
      expect(stamped(flipped, { roomId: R.people }).restricted).toBe(false)
    },
  ),
  c0(
    'R5-08',
    'Rule 5 REC-07 ADM-04 C2.3 decision 13: Admins and Compliance Officers restrict a room; only the DPO or a Compliance Officer lifts it, after re-authenticating',
    () => {
      const restrict = { action: 'room.restrict' as const, room: R.lounge }
      const unrestrict = { action: 'room.unrestrict' as const, room: R.people }
      // Arjun is an Admin, Ashton the Owner and DPO, Wei Ling a Compliance Officer. Kelvin owns the
      // Lounge and Hui Min the People 1:1s room: owning a room isn't enough.
      const mayRestrict: Id[] = [P.arjun, P.ashton, P.weiling]
      const mayUnrestrict: Id[] = [P.ashton, P.weiling]
      for (const person of everyone) {
        expect(allows(world, person, restrict, reauthenticated), `${person} restrict`).toBe(
          mayRestrict.includes(person),
        )
        expect(allows(world, person, unrestrict, reauthenticated), `${person} unrestrict`).toBe(
          mayUnrestrict.includes(person),
        )
        expect(allows(world, person, restrict), `${person} restrict without re-auth`).toBe(false)
        expect(allows(world, person, unrestrict), `${person} unrestrict without re-auth`).toBe(false)
      }
      // A room already in that state, or one that doesn't exist, can't be switched.
      expect(allows(world, P.arjun, { action: 'room.restrict', room: R.people }, reauthenticated)).toBe(false)
      expect(allows(world, P.ashton, { action: 'room.unrestrict', room: R.lounge }, reauthenticated)).toBe(false)
      expect(allows(world, P.arjun, { action: 'room.restrict', room: 'rm-nowhere' }, reauthenticated)).toBe(false)
      // Never an assistant or an agent.
      expect(can(world, assistant(AS.ashton), restrict, reauthenticated)).toBe(false)
      expect(can(world, agent(AG.hr), unrestrict, reauthenticated)).toBe(false)
    },
  ),
  c0('R5-09', 'Rule 5 CHT-57 PRD-108: a refusal never confirms a restricted session exists', () => {
    const actions = ['read', 'correct', 'view_viewed_by', 'edit', 'delete'] as const
    const restricted = [ref.session(S.peopleAshton), ref.session(S.peopleFloor), ref.session(S.opsRestricted)]
    const madeFrom = [ref.slideCopy(SC.people), ref.derived(DV.restrictedNote)]
    for (const person of everyone) {
      for (const item of [...restricted, ...madeFrom]) {
        if (reads(world, person, item)) continue
        const missing = { kind: item.kind, id: `missing-${item.id}` }
        for (const action of actions) {
          expect(can(world, human(person), { action, resource: item }), `${person} ${action} ${item.id}`).toBe(
            can(world, human(person), { action, resource: missing }),
          )
        }
      }
    }
    // Lists don't change either: for people in none of them, the fixture without its restricted
    // sessions lists exactly the same sessions, slide copies, notes, tasks and threads.
    const without = changed(f => ({ ...f, sessions: f.sessions.filter(s => !s.stamp.restricted) }))
    const inSome = new Set(restricted.flatMap(s => participantsOf(s.id)))
    for (const person of everyone.filter(x => !inSome.has(x))) {
      for (const kind of ['session', 'slide_copy', 'derived', 'task', 'suggested_task', 'thread'] as const) {
        expect(listAccessible(without, human(person), kind), `${person} ${kind}`).toEqual(
          listAccessible(world, human(person), kind),
        )
      }
    }
  }),
  c0(
    'R5-10',
    'Rule 5 PRD-36 SLIDE-18: audienceGap names who couldn’t read a restricted session in any audience wider than its participants',
    () => {
      const session = ref.session(S.peopleAshton)
      expect(covers(world, audienceOfPeople(world, [P.huimin, P.ashton]), session)).toBe(true)
      // The People 1:1s room itself: Marcus, Farah and Kelvin now, and whoever joins later.
      const room = audienceOf(world, ref.room(R.people))
      expect(audienceGap(world, room, session)).toEqual({
        count: 3,
        people: [P.marcus, P.farah, P.kelvin].sort(),
        includesFuture: true,
      })
      expect(covers(world, room, session)).toBe(false)
      // One extra person is enough.
      expect(audienceGap(world, audienceOfPeople(world, [P.huimin, P.ashton, P.priya]), session)).toEqual({
        count: 1,
        people: [P.priya],
        includesFuture: false,
      })
      // A built-in feature working for Hui Min may use it only where the audience took part.
      const builtIn = (audience: Audience | null) => ({ run: 'built_in' as const, viewer: human(P.huimin), audience })
      expect(sourceAllowed(world, builtIn(audienceOfPeople(world, [P.huimin, P.ashton])), session)).toBe(true)
      expect(sourceAllowed(world, builtIn(audienceOfPeople(world, [P.huimin])), session)).toBe(true)
      expect(sourceAllowed(world, builtIn(room), session)).toBe(false)
      expect(
        sourceAllowed(world, builtIn(audienceOf(world, ref.channel(C.leadership))), ref.derived(DV.restrictedNote)),
      ).toBe(false)
    },
  ),
  ai(
    'R5-10b',
    'A3.5',
    'Rule 5 PRD-36 ADM-06 DOC-10: inserting restricted output into an item shared beyond the participants needs a confirmation naming the source, and is logged',
  ),
  core(
    'R5-11',
    'C2.10',
    'Rule 5 ROOM-02 REC-07: restricted rooms are hidden from presence, Live now and search for people not taking part',
  ),
  core('R5-12', 'C2.10', 'Rule 5 decision 13: participants search a restricted session only on its own page'),
  c0(
    'R5-13',
    'Rule 5 decision 13 C2.4: only the DPO or a Compliance Officer may reclassify a past session, after re-authenticating',
    () => {
      // Hui Min took part in their 1:1 and owns the room; Arjun is an Admin: neither may.
      for (const id of [S.peopleAshton, S.peopleBefore, S.opsRestricted]) {
        for (const person of everyone) {
          expect(
            allows(world, person, { action: 'session.reclassify', session: id }, reauthenticated),
            `${person} ${id}`,
          ).toBe(person === P.ashton || person === P.weiling)
        }
        expect(allows(world, P.ashton, { action: 'session.reclassify', session: id })).toBe(false)
      }
      // An unknown session can't be named, even by the DPO.
      expect(allows(world, P.ashton, { action: 'session.reclassify', session: 'ss-nowhere' }, reauthenticated)).toBe(
        false,
      )
      // The DPO role alone, without Owner, is enough.
      const dpoOnly = changed(f => ({
        ...f,
        roles: [...f.roles, { personId: P.nadia, role: 'dpo' as const, teamId: null, revokedAt: null }],
      }))
      expect(allows(dpoOnly, P.nadia, { action: 'session.reclassify', session: S.peopleFloor }, reauthenticated)).toBe(
        true,
      )
    },
  ),
  core(
    'R5-13b',
    'C2.4',
    'Rule 5 decision 13 ADM-06: a reclassification writes an audit event and keeps the session’s base audience',
  ),
  c0(
    'R5-14',
    'Rule 5 SLIDE-19 SLIDE-34 REC-23: slide copies shown in a restricted session follow it: participants only, never indexed, never deleted by a participant',
    () => {
      const copy = ref.slideCopy(SC.people)
      expect(readersOf(world, copy)).toEqual(readersOf(world, ref.session(S.peopleAshton)))
      expectReaders(world, copy, [P.huimin, P.ashton], [P.marcus, P.farah, P.kelvin, P.arjun])
      expect(indexClassOf(world, copy)).toBe('restricted')
      expect(can(world, human(P.huimin), { action: 'delete', resource: copy })).toBe(false)
      // A copy kept for playback only is still restricted when its session is.
      const playback = changed(f => ({
        ...f,
        slideCopies: f.slideCopies.map(c => (c.id === SC.people ? { ...c, playbackOnly: true } : c)),
      }))
      expect(indexClassOf(playback, copy)).toBe('restricted')
    },
  ),
  core(
    'R5-14b',
    'C5.6',
    'Rule 5 SLIDE-19 SLIDE-34: presenting a deck in a restricted room stores its copies under the session’s restricted stamp',
  ),
  core('R5-15', 'C6.10', 'Rule 5 PDPA-18 ADM-14: people insights leave out restricted sessions'),
  ai('R5-16', 'A3.1', 'Rule 5 REC-13: notes of a restricted session are never posted, only shown on its page'),
  ai(
    'R5-17',
    'A3.5, A3.7',
    'Rule 5 DOC-10 SLIDE-31: accepted output from a restricted session goes into a new item shared only with that person',
  ),
  ai(
    'R5-18',
    'A3.7',
    'Rule 5 SLIDE-30: Slides AI uses a restricted session only when the person took part and picked it',
  ),
  ai(
    'R5-19',
    'A4.1',
    'Rule 5 PA-02: an assistant uses a restricted session only when its participant opens it and asks',
  ),
  ai('R5-20', 'A4.3', 'Rule 5 PA-06: meeting prep briefs never include restricted content on their own'),
  ai('R5-21', 'A4.4', 'Rule 5 PRD-98 PA-10: restricted content is never saved to memory automatically'),
  ai('R5-22', 'A1.3', 'Rule 5 REC-15: vocabulary proposals from a restricted session show admins only the term'),
  ai('R5-23', 'A1.5', 'Rule 5 D44: the governed back-fill leaves restricted sessions out'),
  ai('R5-24', 'A2.2', 'Rule 5 BRAIN-03: the Org Brain never holds restricted content'),
  c0(
    'R5-25',
    'Rule 5 RMS-58 REC-07 T13: nobody joins a restricted room whose base is public; a private one only its members; agents never',
    () => {
      const join = (w: World, who: Parameters<typeof can>[1], room: Id) =>
        can(w, who, { action: 'join', resource: ref.room(room) })
      const peopleRoom: Id[] = [P.huimin, P.ashton, P.marcus, P.farah, P.kelvin]
      const leadership: Id[] = [P.ashton, P.priya, P.weiling, P.ahmad, P.huimin]
      for (const person of everyone) {
        // The Town hall room is public and restricted: not even Hui Min, its owner and only member.
        expect(join(world, human(person), R.townhall), `${person} town hall`).toBe(false)
        expect(join(world, human(person), R.people), `${person} people`).toBe(peopleRoom.includes(person))
        expect(join(world, human(person), R.leadershipOneOnOnes), `${person} leadership`).toBe(
          leadership.includes(person),
        )
      }
      for (const room of [R.townhall, R.people, R.leadershipOneOnOnes]) {
        for (const id of Object.values(AG)) expect(join(world, agent(id), room), `${id} ${room}`).toBe(false)
        expect(join(world, assistant(AS.ashton), room)).toBe(false)
      }
      // An unrestricted public room stays open to everyone.
      expect(join(world, human(P.nadia), R.lounge)).toBe(true)
    },
  ),
  c0(
    'R5-26',
    'Rule 5 RMS-58 T13: making a restricted room’s base public closes it to everyone, its channel’s members included',
    () => {
      // #leadership is made public while its room stays restricted.
      const opened = changed(f => ({
        ...f,
        channels: f.channels.map(c => (c.id === C.leadership ? { ...c, visibility: 'public' as const } : c)),
      }))
      for (const person of everyone) {
        expect(can(opened, human(person), { action: 'join', resource: ref.room(R.leadershipOneOnOnes) }), person).toBe(
          false,
        )
      }
      // #ops-north-site's room restricted: its channel's members can't join it either.
      const ops = changed(f => ({ ...f, rooms: f.rooms.map(r => (r.id === R.ops ? { ...r, restricted: true } : r)) }))
      expect(can(world, human(P.marcus), { action: 'join', resource: ref.room(R.ops) })).toBe(true)
      expect(can(ops, human(P.marcus), { action: 'join', resource: ref.room(R.ops) })).toBe(false)
      // The People 1:1s room made public while restricted: closed to its own members.
      const people = changed(f => ({
        ...f,
        rooms: f.rooms.map(r =>
          r.id === R.people && r.kind === 'standalone' ? { ...r, visibility: 'public' as const } : r,
        ),
      }))
      for (const member of [P.huimin, P.ashton, P.kelvin]) {
        expect(can(people, human(member), { action: 'join', resource: ref.room(R.people) }), member).toBe(false)
      }
    },
  ),
]
