// Unit tests for the World snapshot (world.ts; B.4, BUILD-PLAN C0.4): what it refuses to build,
// the lookups every rule reads, and the Drive chain that makes a broken or looping tree readable
// by nobody. A fact the snapshot doesn't hold counts as absent, and an absent fact denies.
import { describe, expect, test } from 'vitest'
import { type Facts, NOBODY, readersOf, World } from './index.ts'
import { AG, AS, C, CV, E, F, FI, fixtureFacts, fixtureWorld, M, ORG, P, R, ref, S, T, TH } from './testing/index.ts'

const world = fixtureWorld()

// The fact lists the World indexes by id, each with its kind's name in the error.
const INDEXED: readonly [keyof Facts, string][] = [
  ['channels', 'channel'],
  ['rooms', 'room'],
  ['threads', 'thread'],
  ['messages', 'message'],
  ['sessions', 'session'],
  ['slideCopies', 'slide_copy'],
  ['events', 'event'],
  ['tasks', 'task'],
  ['suggestedTasks', 'suggested_task'],
  ['folders', 'folder'],
  ['files', 'file'],
  ['comments', 'comment'],
  ['derived', 'derived'],
  ['memberships', 'membership'],
]

describe('World construction (B.4)', () => {
  test('keeps the facts it was given and the org they belong to (ACC-11)', () => {
    const facts = fixtureFacts()
    const w = new World(facts)
    expect(w.facts).toBe(facts)
    expect(w.orgId).toBe(ORG)
  })

  test('refuses two facts of one kind with the same id, so a lookup can’t pick the wrong one', () => {
    for (const [key, kind] of INDEXED) {
      const facts = fixtureFacts()
      const rows = facts[key] as readonly { id: string }[]
      const [first] = rows
      if (!first) throw new Error(`the fixture has no ${key}`)
      const duplicated = { ...facts, [key]: [...rows, { ...first }] } as Facts
      expect(() => new World(duplicated), key).toThrow(`Two ${kind} facts share the id ${first.id}`)
    }
    const facts = fixtureFacts()
    const dm = facts.conversations.find(c => c.kind === 'dm')
    if (!dm) throw new Error('the fixture has no DM')
    expect(() => new World({ ...facts, conversations: [...facts.conversations, { ...dm }] })).toThrow(
      `Two dm facts share the id ${dm.id}`,
    )
  })

  test('decision 10: refuses a membership id used twice, so one era can’t open another group DM', () => {
    // Nadia's membership of a second group DM reuses the id of Priya's era in the Q4 group DM.
    const facts = fixtureFacts()
    const priyaEra = facts.memberships.find(m => m.spaceId === CV.q4 && m.principalId === P.priya)
    if (!priyaEra) throw new Error('the fixture has no Q4 era for Priya')
    const reused: Facts = {
      ...facts,
      conversations: [...facts.conversations, { id: 'gdm-other', kind: 'group_dm', ownerId: null }],
      memberships: [...facts.memberships, { ...priyaEra, spaceId: 'gdm-other', principalId: P.nadia }],
    }
    expect(() => new World(reused)).toThrow(`Two membership facts share the id ${priyaEra.id}`)
  })

  test('refuses two spaces with the same id across kinds, since a message names its space by id alone', () => {
    const cases: [string, (f: Facts) => Facts][] = [
      [
        'a channel and a conversation',
        f => ({ ...f, conversations: [...f.conversations, { id: C.leadership, kind: 'group_dm', ownerId: null }] }),
      ],
      [
        'two conversations of different kinds',
        f => ({ ...f, conversations: [...f.conversations, { id: CV.ashtonPriya, kind: 'group_dm', ownerId: null }] }),
      ],
      [
        'a channel and a standalone room',
        f => ({
          ...f,
          rooms: [
            ...f.rooms,
            {
              id: C.studio,
              kind: 'standalone',
              visibility: 'public',
              restricted: false,
              ownerTeamId: null,
              owners: [],
              archivedAt: null,
            },
          ],
        }),
      ],
      [
        'a conversation and a thread',
        f => ({ ...f, threads: [...f.threads, { id: CV.q4, audience: { kind: 'event', eventId: E.q4 } }] }),
      ],
      [
        'a standalone room and a thread',
        f => ({ ...f, threads: [...f.threads, { id: R.board, audience: { kind: 'call', sessionId: S.q4Call } }] }),
      ],
    ]
    for (const [name, change] of cases) {
      expect(() => new World(change(fixtureFacts())), name).toThrow(/Two spaces share the id/)
    }
  })

  test('lets two different kinds that aren’t spaces share an id: each kind is looked up on its own', () => {
    const w = fixtureWorld(f => ({
      ...f,
      tasks: [
        ...f.tasks,
        { id: 'x-same', creatorId: P.ashton, assignees: [], teamId: null, privateToId: null, sourceRef: null },
      ],
      events: [...f.events, { id: 'x-same', organiserId: P.priya, invitees: [] }],
    }))
    expect(w.get({ kind: 'task', id: 'x-same' })?.creatorId).toBe(P.ashton)
    expect(w.get({ kind: 'event', id: 'x-same' })?.organiserId).toBe(P.priya)
    expect(readersOf(w, ref.task('x-same'))).toEqual([[`p:${P.ashton}`]])
    expect(readersOf(w, ref.event('x-same'))).toEqual([[`p:${P.priya}`]])
  })
})

describe('people and roles (ACC-10, T13)', () => {
  test('a deactivated or unknown person isn’t active; a revoked Admin still is', () => {
    expect(world.isActivePerson(P.ashton)).toBe(true)
    expect(world.isActivePerson(P.formerDpo)).toBe(false)
    expect(world.isActivePerson('b0000000-0000-4000-8000-000000000099')).toBe(false)
    expect(world.isActivePerson(P.formerAdmin)).toBe(true)
    expect(world.activePeople()).not.toContain(P.formerDpo)
    expect(world.activePeople()).toContain(P.formerAdmin)
    expect(world.activePeople()).toHaveLength(world.facts.people.length - 1)
    expect(world.person('x-unknown')).toBeUndefined()
  })

  test('roles count only while unrevoked, held by an active person, and for a Team Admin while the team is live', () => {
    expect(
      world
        .rolesOf(P.ashton)
        .map(r => r.role)
        .sort(),
    ).toEqual(['dpo', 'owner'])
    expect(world.rolesOf(P.formerDpo)).toEqual([])
    expect(world.rolesOf(P.formerAdmin)).toEqual([])
    // Farah's Team Admin row is for the archived Night shift team.
    expect(world.rolesOf(P.farah)).toEqual([])
    expect(world.holds(P.arjun, 'admin')).toBe(true)
    expect(world.holds(P.formerAdmin, 'admin')).toBe(false)
    expect(world.holds(P.formerDpo, 'dpo')).toBe(false)
    expect(world.isTeamAdminOf(P.marcus, T.operations)).toBe(true)
    expect(world.isTeamAdminOf(P.marcus, T.people)).toBe(false)
    expect(world.isTeamAdminOf(P.farah, T.nightShift)).toBe(false)
    // A Team Admin row whose team isn't in the snapshot counts for nothing.
    const w = fixtureWorld(f => ({
      ...f,
      roles: [...f.roles, { personId: P.kelvin, role: 'team_admin', teamId: 'x-team-missing', revokedAt: null }],
    }))
    expect(w.rolesOf(P.kelvin)).toEqual([])
  })

  test('principalKind tells people, agents and assistants apart, and knows nothing else', () => {
    expect(world.principalKind(P.ashton)).toBe('human')
    expect(world.principalKind(P.formerDpo)).toBe('human')
    expect(world.principalKind(AG.it)).toBe('agent')
    expect(world.principalKind(AS.ashton)).toBe('assistant')
    expect(world.principalKind('x-unknown')).toBeUndefined()
    expect(world.agent(AG.finance)?.scope.length).toBeGreaterThan(0)
    expect(world.assistant(AS.daniel)?.ownerId).toBe(P.daniel)
  })
})

describe('teams (ACC-05, T13)', () => {
  test('an archived, unknown or null team isn’t live', () => {
    expect(world.isLiveTeam(T.q4)).toBe(true)
    expect(world.isLiveTeam(T.nightShift)).toBe(false)
    expect(world.isLiveTeam('x-team')).toBe(false)
    expect(world.isLiveTeam(null)).toBe(false)
  })

  test('membership of an archived team still counts; a removed membership or a team the snapshot lacks doesn’t', () => {
    expect(world.teamsOf(P.kelvin).sort()).toEqual([T.operations, T.fleet, T.nightShift].sort())
    expect(world.membersOf(T.nightShift).sort()).toEqual([P.kelvin, P.farah].sort())
    expect(world.isTeamMember(P.farah, T.nightShift)).toBe(true)
    const w = fixtureWorld(f => ({
      ...f,
      teams: f.teams.filter(team => team.id !== T.fleet),
      teamMembers: f.teamMembers.map(x =>
        x.teamId === T.operations && x.personId === P.kelvin ? { ...x, removedAt: 1 } : x,
      ),
    }))
    expect(w.teamsOf(P.kelvin)).toEqual([T.nightShift])
    expect(w.membersOf(T.fleet)).toEqual([])
    expect(w.membersOf(T.operations)).not.toContain(P.kelvin)
    expect(w.isTeamMember(P.kelvin, T.operations)).toBe(false)
  })
})

describe('spaces and memberships (decision 10)', () => {
  test('channels, conversations, standalone rooms and threads are spaces; a channel’s room and a meeting room aren’t', () => {
    expect(world.space(C.general)?.kind).toBe('channel')
    expect(world.space(CV.q4)?.kind).toBe('conversation')
    expect(world.space(R.lounge)?.kind).toBe('room')
    expect(world.space(TH.q4Event)?.kind).toBe('thread')
    // A channel room's panel is the channel itself (CHAT-03); a meeting room's chat is its thread.
    expect(world.space(R.ops)).toBeUndefined()
    expect(world.space(R.q4)).toBeUndefined()
    expect(world.space('x-missing')).toBeUndefined()
  })

  test('a current member holds an open span; someone who left and rejoined is current, someone who left isn’t', () => {
    expect(world.isCurrentMember(P.ahmad, CV.q4)).toBe(true)
    expect(world.isCurrentMember(P.daniel, CV.q4)).toBe(true)
    expect(world.isCurrentMember(P.daniel, C.leadership)).toBe(false)
    const left = fixtureWorld(f => ({
      ...f,
      memberships: f.memberships.map(x => (x.id === `mb:${CV.q4}:${P.ahmad}:2` ? { ...x, throughSeq: 6 } : x)),
    }))
    expect(left.isCurrentMember(P.ahmad, CV.q4)).toBe(false)
    expect(left.membershipsOf(CV.q4).filter(x => x.principalId === P.ahmad)).toHaveLength(2)
    expect(left.membershipsOfPrincipal(P.ahmad).filter(x => x.spaceId === CV.q4)).toHaveLength(2)
  })

  test('currentMembers lists each principal once, agents included, and none who has left', () => {
    expect(world.currentMembers(CV.q4).sort()).toEqual([P.ashton, P.priya, P.daniel, P.ahmad].sort())
    expect(world.currentMembers(C.leadership)).toContain(AG.digest)
    expect(world.currentMembers('x-missing')).toEqual([])
    const left = fixtureWorld(f => ({
      ...f,
      memberships: f.memberships.map(x => (x.id === `mb:${CV.q4}:${P.ahmad}:2` ? { ...x, throughSeq: 6 } : x)),
    }))
    expect(left.currentMembers(CV.q4)).not.toContain(P.ahmad)
  })
})

describe('resources by kind', () => {
  test('get finds a fact only under its own kind; all lists a kind', () => {
    expect(world.get({ kind: 'group_dm', id: CV.q4 })?.kind).toBe('group_dm')
    expect(world.get({ kind: 'dm', id: CV.q4 })).toBeUndefined()
    expect(world.get({ kind: 'message', id: M.ops1 })?.spaceId).toBe(C.ops)
    expect(world.get({ kind: 'file', id: F.q4 })).toBeUndefined()
    expect(
      world
        .all('dm')
        .map(c => c.id)
        .sort(),
    ).toEqual([CV.ashtonPriya, CV.ashtonMarcus, CV.cfoWeiling, CV.farahKelvin].sort())
    expect(world.folder(F.q4)?.owner).toEqual({ kind: 'person', id: P.priya })
  })
})

describe('driveChain: an item and its folders, nearest first (DRV-02)', () => {
  test('walks up to the root', () => {
    expect(world.driveChain({ kind: 'file', id: FI.msa })?.map(x => x.id)).toEqual([FI.msa, F.q4Contract, F.q4])
    expect(world.driveChain({ kind: 'folder', id: F.q4Contract })?.map(x => x.id)).toEqual([F.q4Contract, F.q4])
    expect(world.driveChain({ kind: 'file', id: FI.q3Numbers })?.map(x => x.id)).toEqual([FI.q3Numbers])
    // An attachment's parent is its message, not a folder (CHAT-06).
    expect(world.driveChain({ kind: 'file', id: FI.otPdf })?.map(x => x.id)).toEqual([FI.otPdf])
    expect(world.driveChain({ kind: 'file', id: 'x-missing' })).toBeUndefined()
    expect(world.driveChain({ kind: 'folder', id: FI.msa })).toBeUndefined()
  })

  test('a loop makes the chain undefined, and everything on it readable by nobody', () => {
    const loop = fixtureWorld(f => ({
      ...f,
      folders: f.folders.map(x => (x.id === F.q4 ? { ...x, parentId: F.q4Contract } : x)),
    }))
    expect(loop.driveChain({ kind: 'folder', id: F.q4 })).toBeUndefined()
    expect(loop.driveChain({ kind: 'file', id: FI.msa })).toBeUndefined()
    expect(readersOf(loop, ref.folder(F.q4))).toEqual(NOBODY)
    expect(readersOf(loop, ref.folder(F.q4Contract))).toEqual(NOBODY)
    expect(readersOf(loop, ref.file(FI.msa))).toEqual(NOBODY)
    expect(readersOf(loop, ref.file(FI.q4Deck))).toEqual(NOBODY)
    const self = fixtureWorld(f => ({
      ...f,
      folders: f.folders.map(x => (x.id === F.board ? { ...x, parentId: F.board } : x)),
    }))
    expect(self.driveChain({ kind: 'folder', id: F.board })).toBeUndefined()
    expect(readersOf(self, ref.file(FI.boardUpdate))).toEqual(NOBODY)
  })

  test('a missing parent folder makes the chain undefined, and the item readable by nobody', () => {
    const orphanFolder = fixtureWorld(f => ({
      ...f,
      folders: f.folders.map(x => (x.id === F.q4 ? { ...x, parentId: 'f-missing' } : x)),
    }))
    expect(orphanFolder.driveChain({ kind: 'folder', id: F.q4 })).toBeUndefined()
    expect(readersOf(orphanFolder, ref.file(FI.q4Proposal))).toEqual(NOBODY)
    expect(readersOf(orphanFolder, ref.file(FI.msa))).toEqual(NOBODY)
    const orphanFile = fixtureWorld(f => ({ ...f, folders: f.folders.filter(x => x.id !== F.vendor) }))
    expect(orphanFile.driveChain({ kind: 'file', id: FI.movers })).toBeUndefined()
    expect(readersOf(orphanFile, ref.file(FI.movers))).toEqual(NOBODY)
    // The rest of the Drive is untouched.
    expect(readersOf(orphanFile, ref.file(FI.q3Numbers)).length).toBe(1)
  })
})
