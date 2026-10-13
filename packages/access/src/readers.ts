import { eraToken, membersToken, orgToken, personToken, teamAdminsToken, teamToken } from './keys.ts'
import type {
  ConversationFact,
  DriveOwner,
  EventFact,
  FileFact,
  FolderFact,
  Grantee,
  Id,
  MessageFact,
  Ref,
  RoomFact,
  SessionFact,
  ThreadFact,
  Token,
} from './model.ts'
import type { Space, World } from './world.ts'

// Who may read a resource, in conjunctive form: a list of clauses, each a list of tokens. A
// subject reads it when its keys meet every clause. Almost every resource has one clause; an item
// derived from several sources has one per source (Rule 3), and an item in the Drive's Trash has
// two (owner, or the trasher while they still hold a grant). No clauses means nobody, and so does
// an empty clause.
export type Acl = readonly (readonly Token[])[]
export const NOBODY: Acl = []

export function allows(acl: Acl, keys: ReadonlySet<Token>): boolean {
  return acl.length > 0 && acl.every(clause => clause.some(token => keys.has(token)))
}

// The single read rule. Every other function in this package that answers "who can see this"
// is built on it, and search rows store it (aclOf), so the in-memory and SQL paths agree.
export function readersOf(world: World, ref: Ref, seen: ReadonlySet<string> = new Set()): Acl {
  switch (ref.kind) {
    case 'channel':
    case 'dm':
    case 'group_dm':
    case 'agent_dm':
    case 'assistant_chat':
    case 'thread': {
      const space = world.space(ref.id)
      if (!space || spaceKind(space) !== ref.kind) return NOBODY
      return spaceReaders(world, space)
    }
    case 'room': {
      const room = world.get({ kind: 'room', id: ref.id })
      return room ? roomReaders(world, room) : NOBODY
    }
    case 'message': {
      const message = world.get({ kind: 'message', id: ref.id })
      return message ? messageReaders(world, message) : NOBODY
    }
    case 'session': {
      const session = world.get({ kind: 'session', id: ref.id })
      return session ? sessionReaders(world, session) : NOBODY
    }
    case 'slide_copy': {
      const copy = world.get({ kind: 'slide_copy', id: ref.id })
      return copy ? readersOf(world, { kind: 'session', id: copy.sessionId }) : NOBODY
    }
    case 'event': {
      const event = world.get({ kind: 'event', id: ref.id })
      return event ? clause(attendeesOf(event).map(personToken)) : NOBODY
    }
    case 'task': {
      const task = world.get({ kind: 'task', id: ref.id })
      if (!task) return NOBODY
      if (task.privateToId !== null) return clause([personToken(task.privateToId)])
      const tokens = [task.creatorId, ...task.assignees].map(personToken)
      if (task.teamId !== null) tokens.push(teamToken(task.teamId))
      return clause(tokens)
    }
    case 'suggested_task': {
      const suggestion = world.get({ kind: 'suggested_task', id: ref.id })
      return suggestion ? clause([personToken(suggestion.ownerId)]) : NOBODY
    }
    case 'folder':
    case 'file':
      return driveReaders(world, ref as { kind: 'folder' | 'file'; id: Id })
    case 'comment': {
      const comment = world.get({ kind: 'comment', id: ref.id })
      if (!comment || comment.deletedAt !== null) return NOBODY
      return readersOf(world, { kind: 'file', id: comment.fileId })
    }
    case 'derived': {
      // Provenance that loops back on itself resolves to nobody, like any chain that doesn't end.
      const key = `derived:${ref.id}`
      const derived = world.get({ kind: 'derived', id: ref.id })
      if (!derived || derived.sources.length === 0 || seen.has(key)) return NOBODY
      const next = new Set(seen).add(key)
      return intersect(
        world,
        derived.sources.map(source => readersOf(world, source, next)),
      )
    }
    default:
      return NOBODY
  }
}

// Spaces.

export function spaceKind(space: Space): Ref['kind'] {
  return space.kind === 'conversation' ? space.fact.kind : space.kind === 'room' ? 'room' : space.kind
}

function spaceReaders(world: World, space: Space): Acl {
  switch (space.kind) {
    case 'channel':
      // A public channel is readable by the whole org, joined or not (CHAT-01, PRD-35); a
      // private one by its current members.
      return space.fact.visibility === 'public'
        ? clause([orgToken(world.orgId)])
        : clause([membersToken(space.fact.id)])
    case 'conversation':
      return conversationReaders(world, space.fact)
    case 'room':
      return roomReaders(world, space.fact)
    case 'thread':
      return threadReaders(world, space.fact)
    default:
      return NOBODY
  }
}

// A conversation's members must match its kind, or nobody reads it: a DM is two people and never
// gains members, an agent DM is one person and one agent, a group DM holds only people, and an
// assistant conversation is its owner's (Rule 4, PA-01).
export function conversationShapeOk(world: World, conversation: ConversationFact): boolean {
  const ever = [...new Set(world.membershipsOf(conversation.id).map(m => m.principalId))]
  const kinds = ever.map(id => world.principalKind(id))
  const humans = kinds.filter(k => k === 'human').length
  const agents = kinds.filter(k => k === 'agent').length
  const others = kinds.length - humans - agents
  switch (conversation.kind) {
    case 'dm':
      return humans === 2 && agents === 0 && others === 0
    case 'agent_dm':
      return humans === 1 && agents === 1 && others === 0
    case 'group_dm':
      return agents === 0 && others === 0 && humans >= 1
    case 'assistant_chat':
      return conversation.ownerId !== null
    default:
      return false
  }
}

function conversationReaders(world: World, conversation: ConversationFact): Acl {
  if (!conversationShapeOk(world, conversation)) return NOBODY
  if (conversation.kind === 'assistant_chat') {
    return conversation.ownerId === null ? NOBODY : clause([personToken(conversation.ownerId)])
  }
  // The conversation itself (opening it, its topic, its audience): its current members. A group
  // DM's messages are narrower: each member reads only their own eras (messageReaders).
  return clause([membersToken(conversation.id)])
}

export function roomReaders(world: World, room: RoomFact): Acl {
  switch (room.kind) {
    case 'channel_room':
      return readersOf(world, { kind: 'channel', id: room.channelId })
    case 'standalone':
      return room.visibility === 'public' ? clause([orgToken(world.orgId)]) : clause([membersToken(room.id)])
    case 'meeting': {
      // A meeting's own room is private to the event's attendees (CAL-03).
      const event = world.get({ kind: 'event', id: room.eventId })
      return event ? clause(attendeesOf(event).map(personToken)) : NOBODY
    }
    default:
      return NOBODY
  }
}

function threadReaders(world: World, thread: ThreadFact): Acl {
  if (thread.audience.kind === 'event') {
    // A meeting's thread: its attendees and everyone who took part in one of its sessions
    // (REC-13, REC-20, C3.3).
    const eventId = thread.audience.eventId
    const event = world.get({ kind: 'event', id: eventId })
    if (!event) return NOBODY
    const people = new Set(attendeesOf(event))
    for (const session of world.all('session')) {
      if (session.stamp.audience === 'invitees_and_participants' && session.stamp.eventId === eventId) {
        for (const p of session.participants) people.add(p)
      }
    }
    return clause([...people].map(personToken))
  }
  // A participants-only thread for a call (REC-13).
  const session = world.get({ kind: 'session', id: thread.audience.sessionId })
  return session ? clause(session.participants.map(personToken)) : NOBODY
}

// The people an event is for: its organiser and its invitees (CAL-02).
export function attendeesOf(event: EventFact): Id[] {
  return [...new Set([event.organiserId, ...event.invitees])]
}

// Messages.

function messageReaders(world: World, message: MessageFact): Acl {
  if (message.deletedAt !== null) return NOBODY
  const space = world.space(message.spaceId)
  if (!space) return NOBODY
  if (space.kind === 'conversation' && space.fact.kind === 'group_dm') {
    if (!conversationShapeOk(world, space.fact)) return NOBODY
    // A group-DM message goes to the eras open when it was sequenced: someone added later can't
    // read it, and leaving ends every era until they rejoin (decision 10, PRD-79).
    const eras = world
      .membershipsOf(space.fact.id)
      .filter(m => m.afterSeq < message.seq && (m.throughSeq === null || message.seq <= m.throughSeq))
    return clause(eras.map(m => eraToken(m.id)))
  }
  return spaceReaders(world, space)
}

// Sessions (REC-20).

function sessionReaders(world: World, session: SessionFact): Acl {
  // A session whose room or conversation isn't in the snapshot is readable by nobody.
  const place =
    session.place.kind === 'room'
      ? world.get({ kind: 'room', id: session.place.roomId })
      : world.space(session.place.conversationId)
  if (!place) return NOBODY
  const participants = session.participants.map(personToken)
  const stamp = session.stamp
  // A restricted session is for the people who took part, whatever its base audience (Rule 5).
  if (stamp.restricted) return clause(participants)
  switch (stamp.audience) {
    case 'space': {
      // A room session: the channel's or standalone room's readers, now (SLIDE-18, Rule 6).
      const space = world.space(stamp.spaceId)
      if (!space || (space.kind !== 'channel' && space.kind !== 'room')) return NOBODY
      return spaceReaders(world, space)
    }
    case 'invitees_and_participants':
      // A scheduled meeting, in a team room too: who was invited at the start, and who took part.
      return clause([...stamp.invitees.map(personToken), ...participants])
    case 'participants':
      return clause(participants)
    default:
      return NOBODY
  }
}

// The Drive.

export function ownerTokens(owner: DriveOwner): Token[] {
  return owner.kind === 'person' ? [personToken(owner.id)] : [teamAdminsToken(owner.id)]
}

export function granteeToken(world: World, grantee: Grantee): Token | undefined {
  switch (grantee.kind) {
    case 'person':
      return personToken(grantee.id)
    case 'team':
      return teamToken(grantee.id)
    case 'org':
      // A grant to another org's id names nobody here (ACC-11).
      return grantee.id === world.orgId ? orgToken(world.orgId) : undefined
    default:
      return undefined
  }
}

// The nearest item in the Trash on the path from an item up to the root, itself first: an item is
// in the Trash when it or a folder above it is (DRV-01).
export function trashRoot(chain: readonly (FolderFact | FileFact)[]): FolderFact | FileFact | undefined {
  return chain.find(item => item.trashedAt !== null)
}

// The tokens that read a Drive item as if nothing were in the Trash: its owner, the owners of the
// folders above it, every grant on it or on a folder above it, and for a chat attachment the
// readers of its message (CHAT-06, FILE-03, DRV-02). undefined when the item doesn't resolve.
export function liveDriveTokens(world: World, ref: { kind: 'folder' | 'file'; id: Id }): Token[] | undefined {
  const chain = world.driveChain(ref)
  if (!chain) return undefined
  const [item] = chain
  if (!item) return undefined
  const tokens: Token[] = []
  if ('subtype' in item && item.parent.kind === 'message') {
    // An attachment is readable exactly when its message is, plus anyone it's shared with since.
    const message = world.get({ kind: 'message', id: item.parent.id })
    if (!message) return undefined
    const acl = messageReaders(world, message)
    if (acl.length !== 1) return undefined
    tokens.push(...(acl[0] ?? []))
  } else {
    for (const node of chain) tokens.push(...ownerTokens(node.owner))
  }
  for (const node of chain) {
    for (const grant of node.grants) {
      const token = granteeToken(world, grant.grantee)
      if (token) tokens.push(token)
    }
  }
  return tokens
}

function driveReaders(world: World, ref: { kind: 'folder' | 'file'; id: Id }): Acl {
  const chain = world.driveChain(ref)
  const live = liveDriveTokens(world, ref)
  if (!chain || !live) return NOBODY
  const [item] = chain
  if (!item) return NOBODY
  const root = trashRoot(chain)
  if (!root) return clause(live)
  // In the Trash: the item's own owner, and whoever trashed it (or the folder above it) while
  // they still hold one of its grants (DRV-01, Rule 6). Nothing flows down from folders.
  const owner = ownerTokens(item.owner)
  const trasher = root.trashedById === null ? [] : [personToken(root.trashedById)]
  return normalise(world, [
    [...owner, ...trasher],
    [...owner, ...live],
  ])
}

// Clause algebra.

function clause(tokens: readonly Token[]): Acl {
  const unique = [...new Set(tokens)].sort()
  return unique.length === 0 ? NOBODY : [unique]
}

// Every clause of every source must hold: a derived item is readable only by people who can read
// all of its sources (Rule 3). An unreadable source makes the whole item unreadable.
function intersect(world: World, acls: readonly Acl[]): Acl {
  if (acls.length === 0 || acls.some(acl => acl.length === 0)) return NOBODY
  return normalise(world, acls.flat())
}

// Sorts and dedupes, drops a clause another clause makes redundant (a clause holding the org
// token holds for every active person, so it adds nothing beside a narrower clause), and keeps an
// empty clause as nobody.
export function normalise(world: World, clauses: readonly (readonly Token[])[]): Acl {
  const org = orgToken(world.orgId)
  const sorted = clauses.map(c => [...new Set(c)].sort())
  if (sorted.some(c => c.length === 0)) return NOBODY
  const keyOf = (c: readonly Token[]) => c.join('\n')
  const unique = [...new Map(sorted.map(c => [keyOf(c), c])).values()]
  const narrow = unique.filter(c => !c.includes(org))
  // A clause that contains every token of another clause holds whenever that one does.
  const minimal = narrow.filter(
    c => !narrow.some(other => other !== c && other.length < c.length && other.every(t => c.includes(t))),
  )
  const kept = minimal.length > 0 ? minimal : unique.length > 0 ? [[org]] : []
  return kept.sort((a, b) => a.length - b.length || keyOf(a).localeCompare(keyOf(b)))
}
