import type {
  AgentFact,
  AssistantFact,
  ChannelFact,
  CommentFact,
  ConversationFact,
  DerivedFact,
  EventFact,
  Facts,
  FileFact,
  FolderFact,
  Id,
  MembershipFact,
  MessageFact,
  OrgRole,
  PersonFact,
  Ref,
  ResourceKind,
  RoleFact,
  RoleProposalFact,
  RoomFact,
  SessionFact,
  SlideCopyFact,
  SuggestedTaskFact,
  TaskFact,
  TeamFact,
  ThreadFact,
} from './model.ts'

// A space messages are posted in, resolved from a message's spaceId.
export type Space =
  | { kind: 'channel'; fact: ChannelFact }
  | { kind: 'conversation'; fact: ConversationFact }
  | { kind: 'room'; fact: RoomFact }
  | { kind: 'thread'; fact: ThreadFact }

// An immutable, indexed snapshot of the facts a decision needs. Every function in this package
// takes one. A fact the snapshot doesn't hold counts as absent, and every rule is written so that
// an absent fact denies: an unknown resource, person, team or space is never readable, and a
// resource whose chain (message → space, file → folders, session → room) doesn't resolve is
// readable by nobody. Missing and unreadable give the same answer, so nothing reveals what exists.
//
// A snapshot may hold only the facts one request needs, with two obligations on whoever loads it,
// for the facts whose presence (not absence) narrows an answer:
// - for every space, event and session it holds: all of that place's memberships, its attendees'
//   and members' people and the session's stamp; and for every event it holds, and the event of
//   every meeting thread it holds, every session of that event with its participants' people,
//   since a meeting thread's readers include everyone who took part in one (readers.ts). The
//   audience functions (audience.ts) refuse an audience naming a person, space or era the
//   snapshot lacks, but a partly loaded membership or session list would shrink an audience
//   rather than deny.
// - for every person an admin request names, as actor or target: all of their role rows and every
//   open role proposal naming them, since an Owner-only target and an Admin's own roles are
//   refused by those rows being there (admin.ts, T13 items 5 and 8).
export class World {
  readonly orgId: Id
  readonly facts: Facts
  private readonly people = new Map<Id, PersonFact>()
  private readonly rolesByPerson = new Map<Id, RoleFact[]>()
  private readonly proposals = new Map<Id, RoleProposalFact>()
  private readonly teams = new Map<Id, TeamFact>()
  private readonly teamsByPerson = new Map<Id, Id[]>()
  private readonly membersByTeam = new Map<Id, Id[]>()
  private readonly agents = new Map<Id, AgentFact>()
  private readonly assistants = new Map<Id, AssistantFact>()
  private readonly spaces = new Map<Id, Space>()
  private readonly memberships = new Map<Id, MembershipFact>()
  private readonly membershipsBySpace = new Map<Id, MembershipFact[]>()
  private readonly membershipsByPrincipal = new Map<Id, MembershipFact[]>()
  private readonly byKind = new Map<ResourceKind, Map<Id, unknown>>()

  constructor(facts: Facts) {
    this.facts = facts
    this.orgId = facts.org.id
    for (const p of facts.people) once(this.people, 'person', p.id, p)
    for (const r of facts.roles) push(this.rolesByPerson, r.personId, r)
    for (const p of facts.roleProposals) once(this.proposals, 'role proposal', p.id, p)
    for (const t of facts.teams) once(this.teams, 'team', t.id, t)
    for (const m of facts.teamMembers) {
      if (m.removedAt !== null) continue
      push(this.teamsByPerson, m.personId, m.teamId)
      push(this.membersByTeam, m.teamId, m.personId)
    }
    for (const a of facts.agents) once(this.agents, 'agent', a.id, a)
    for (const a of facts.assistants) once(this.assistants, 'assistant', a.id, a)
    // A group-DM era is a token named by its membership id alone (keys.ts), so the id is unique.
    for (const m of facts.memberships) {
      once(this.memberships, 'membership', m.id, m)
      push(this.membershipsBySpace, m.spaceId, m)
      push(this.membershipsByPrincipal, m.principalId, m)
    }
    const index = (kind: ResourceKind, rows: readonly { id: Id }[]) => {
      const map = new Map<Id, unknown>()
      for (const row of rows) {
        if (map.has(row.id)) throw new Error(`Two ${kind} facts share the id ${row.id}`)
        map.set(row.id, row)
      }
      this.byKind.set(kind, map)
    }
    index('channel', facts.channels)
    for (const kind of ['dm', 'group_dm', 'agent_dm', 'assistant_chat'] as const) {
      index(
        kind,
        facts.conversations.filter(c => c.kind === kind),
      )
    }
    index('room', facts.rooms)
    index('thread', facts.threads)
    index('message', facts.messages)
    index('session', facts.sessions)
    index('slide_copy', facts.slideCopies)
    index('event', facts.events)
    index('task', facts.tasks)
    index('suggested_task', facts.suggestedTasks)
    index('folder', facts.folders)
    index('file', facts.files)
    index('comment', facts.comments)
    index('derived', facts.derived)
    // A message names its space by id alone, so a space id must be unique across the space kinds.
    const addSpace = (id: Id, space: Space) => {
      if (this.spaces.has(id)) throw new Error(`Two spaces share the id ${id}`)
      this.spaces.set(id, space)
    }
    for (const fact of facts.channels) addSpace(fact.id, { kind: 'channel', fact })
    for (const fact of facts.conversations) addSpace(fact.id, { kind: 'conversation', fact })
    for (const fact of facts.rooms) if (fact.kind === 'standalone') addSpace(fact.id, { kind: 'room', fact })
    for (const fact of facts.threads) addSpace(fact.id, { kind: 'thread', fact })
  }

  // People and roles.

  person(id: Id): PersonFact | undefined {
    return this.people.get(id)
  }
  isActivePerson(id: Id): boolean {
    const person = this.people.get(id)
    return person !== undefined && person.deactivatedAt === null
  }
  activePeople(): Id[] {
    return this.facts.people.filter(p => p.deactivatedAt === null).map(p => p.id)
  }
  // The roles a person holds now: unrevoked rows of an active person. A Team Admin row counts
  // only while its team is in the snapshot and not archived (T13: an archived team's Team Admin
  // powers end).
  rolesOf(personId: Id): RoleFact[] {
    if (!this.isActivePerson(personId)) return []
    return (this.rolesByPerson.get(personId) ?? []).filter(
      r => r.revokedAt === null && (r.role !== 'team_admin' || this.isLiveTeam(r.teamId)),
    )
  }
  holds(personId: Id, role: OrgRole): boolean {
    return this.rolesOf(personId).some(r => r.role === role)
  }
  isTeamAdminOf(personId: Id, teamId: Id): boolean {
    return this.rolesOf(personId).some(r => r.role === 'team_admin' && r.teamId === teamId)
  }
  proposal(id: Id): RoleProposalFact | undefined {
    return this.proposals.get(id)
  }

  // Teams.

  team(id: Id): TeamFact | undefined {
    return this.teams.get(id)
  }
  isLiveTeam(id: Id | null): boolean {
    if (id === null) return false
    const team = this.teams.get(id)
    return team !== undefined && team.archivedAt === null
  }
  // Teams the person currently belongs to. Membership of an archived team still counts for
  // content grants to it until an Admin removes the member (T13 item 14).
  teamsOf(personId: Id): Id[] {
    return (this.teamsByPerson.get(personId) ?? []).filter(id => this.teams.has(id))
  }
  membersOf(teamId: Id): Id[] {
    return this.teams.has(teamId) ? (this.membersByTeam.get(teamId) ?? []) : []
  }
  isTeamMember(personId: Id, teamId: Id): boolean {
    return this.teamsOf(personId).includes(teamId)
  }

  // Principals other than people.

  agent(id: Id): AgentFact | undefined {
    return this.agents.get(id)
  }
  assistant(id: Id): AssistantFact | undefined {
    return this.assistants.get(id)
  }
  // The kind of a principal the snapshot holds, whether or not it is still active.
  principalKind(id: Id): 'human' | 'agent' | 'assistant' | undefined {
    if (this.people.has(id)) return 'human'
    if (this.agents.has(id)) return 'agent'
    if (this.assistants.has(id)) return 'assistant'
    return undefined
  }

  // Spaces and memberships.

  space(id: Id): Space | undefined {
    return this.spaces.get(id)
  }
  membership(id: Id): MembershipFact | undefined {
    return this.memberships.get(id)
  }
  membershipsOf(spaceId: Id): MembershipFact[] {
    return this.membershipsBySpace.get(spaceId) ?? []
  }
  membershipsOfPrincipal(principalId: Id): MembershipFact[] {
    return this.membershipsByPrincipal.get(principalId) ?? []
  }
  // A principal's current membership of a space: an open span.
  isCurrentMember(principalId: Id, spaceId: Id): boolean {
    return this.membershipsOf(spaceId).some(m => m.principalId === principalId && m.throughSeq === null)
  }
  // The principals currently in a space.
  currentMembers(spaceId: Id): Id[] {
    return [
      ...new Set(
        this.membershipsOf(spaceId)
          .filter(m => m.throughSeq === null)
          .map(m => m.principalId),
      ),
    ]
  }

  // Resources by kind.

  get<K extends ResourceKind>(ref: { kind: K; id: Id }): FactOf<K> | undefined {
    return this.byKind.get(ref.kind)?.get(ref.id) as FactOf<K> | undefined
  }
  all<K extends ResourceKind>(kind: K): FactOf<K>[] {
    return [...(this.byKind.get(kind)?.values() ?? [])] as FactOf<K>[]
  }
  folder(id: Id): FolderFact | undefined {
    return this.get({ kind: 'folder', id })
  }

  // A folder or file and its ancestor folders, nearest first. undefined when the chain doesn't
  // resolve (a missing folder) or loops, so the item is readable by nobody.
  driveChain(ref: { kind: 'folder' | 'file'; id: Id }): (FolderFact | FileFact)[] | undefined {
    const start = ref.kind === 'folder' ? this.folder(ref.id) : this.get({ kind: 'file', id: ref.id })
    if (!start) return undefined
    const chain: (FolderFact | FileFact)[] = [start]
    const seen = new Set<Id>([`${ref.kind}:${ref.id}`])
    let parentId: Id | null =
      'subtype' in start ? (start.parent.kind === 'folder' ? start.parent.id : null) : start.parentId
    while (parentId !== null) {
      if (seen.has(`folder:${parentId}`)) return undefined
      seen.add(`folder:${parentId}`)
      const parent = this.folder(parentId)
      if (!parent) return undefined
      chain.push(parent)
      parentId = parent.parentId
    }
    return chain
  }
}

export type FactOf<K extends ResourceKind> = K extends 'channel'
  ? ChannelFact
  : K extends 'dm' | 'group_dm' | 'agent_dm' | 'assistant_chat'
    ? ConversationFact
    : K extends 'room'
      ? RoomFact
      : K extends 'thread'
        ? ThreadFact
        : K extends 'message'
          ? MessageFact
          : K extends 'session'
            ? SessionFact
            : K extends 'slide_copy'
              ? SlideCopyFact
              : K extends 'event'
                ? EventFact
                : K extends 'task'
                  ? TaskFact
                  : K extends 'suggested_task'
                    ? SuggestedTaskFact
                    : K extends 'folder'
                      ? FolderFact
                      : K extends 'file'
                        ? FileFact
                        : K extends 'comment'
                          ? CommentFact
                          : K extends 'derived'
                            ? DerivedFact
                            : never

// Two facts for one id would let the snapshot answer differently depending on which is read, so a
// snapshot like that is refused outright (the database's primary keys never produce one).
function once<V>(map: Map<Id, V>, what: string, id: Id, value: V): void {
  if (map.has(id)) throw new Error(`Two ${what} facts share the id ${id}`)
  map.set(id, value)
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

export const refOf = (kind: ResourceKind, id: Id): Ref => ({ kind, id })
