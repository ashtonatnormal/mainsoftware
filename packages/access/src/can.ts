import { adminCan, isAdmin } from './admin.ts'
import {
  atLeast,
  granteeInOrg,
  isItemOwner,
  maySetSharing,
  ownerAsGrantee,
  roleOn,
  sameGrantee,
  trashState,
} from './drive.ts'
import { indexClassOf } from './index-class.ts'
import { keysOf } from './keys.ts'
import type { Id, Ref, Subject, Token } from './model.ts'
import { allows, readersOf } from './readers.ts'
import type { ContentRequest, CreateRequest, Request, RequestContext } from './requests.ts'
import { isAdminRequest } from './requests.ts'
import type { World } from './world.ts'

// Whether a subject may do what it asks, decided from the snapshot alone. Every access check in
// Hearth comes here (Principle 1). An unknown subject, resource or target gives false, the same
// answer as a refusal, so the result never shows whether something exists (CHT-57, PRD-108).
export function can(world: World, subject: Subject, request: Request, context: RequestContext = {}): boolean {
  if (request.action === 'devices.sign_out_own') return subject.kind === 'human' && world.isActivePerson(subject.id)
  if (isAdminRequest(request)) return subject.kind === 'human' && adminCan(world, subject.id, request, context)
  if (request.action === 'create') return canCreate(world, subject, request)
  return canContent(world, subject, request)
}

// Reading through a subject's keys, the one read rule (readers.ts).
export function canRead(world: World, subject: Subject, ref: Ref): boolean {
  if (subject.kind === 'agent') return agentReads(world, subject.id, ref)
  return allows(readersOf(world, ref), new Set(keysOf(world, subject)))
}

function canContent(world: World, subject: Subject, request: ContentRequest): boolean {
  const ref = request.resource
  if (request.action === 'read') return canRead(world, subject, ref)
  // Only a person acts on content. An assistant suggests and drafts and never writes (D16, PA-03);
  // agents' writes arrive with A5 (AGT-05, AGT-06); system jobs don't come through here.
  if (subject.kind !== 'human') return false
  const me = subject.id
  const keys = new Set(keysOf(world, subject))
  // Every action on content needs an active person who can read it now (Rule 6), so a refusal
  // never depends on anything the person couldn't see.
  if (keys.size === 0 || !allows(readersOf(world, ref), keys)) return false
  switch (ref.kind) {
    case 'channel':
      return channelAction(world, me, ref.id, request)
    case 'room':
      return roomAction(world, me, ref.id, request)
    case 'dm':
    case 'group_dm':
    case 'agent_dm':
    case 'assistant_chat':
      return conversationAction(world, me, ref, request)
    case 'thread':
      return request.action === 'post'
    case 'message': {
      const message = world.get({ kind: 'message', id: ref.id })
      // Your own messages, while you can still read them (CHAT-05). Moderation removal is C1.10.
      return (
        message !== undefined && (request.action === 'edit' || request.action === 'delete') && message.authorId === me
      )
    }
    case 'session': {
      const session = world.get({ kind: 'session', id: ref.id })
      if (!session) return false
      // Participants correct notes and transcripts and see who viewed them (REC-15, REC-21);
      // nobody deletes a session record here (REC-23).
      return (request.action === 'correct' || request.action === 'view_viewed_by') && session.participants.includes(me)
    }
    case 'slide_copy':
      // Slide copies belong to the session and can't be deleted by participants (SLIDE-19, REC-23).
      return false
    case 'event': {
      const event = world.get({ kind: 'event', id: ref.id })
      return (
        event !== undefined && (request.action === 'edit' || request.action === 'cancel') && event.organiserId === me
      )
    }
    case 'task':
      return taskAction(world, me, ref.id, request)
    case 'suggested_task': {
      const suggestion = world.get({ kind: 'suggested_task', id: ref.id })
      return (
        suggestion !== undefined &&
        (request.action === 'accept' || request.action === 'dismiss') &&
        suggestion.ownerId === me
      )
    }
    case 'folder':
    case 'file':
      return driveAction(world, me, keys, ref as { kind: 'folder' | 'file'; id: Id }, request)
    case 'comment':
      return commentAction(world, me, keys, ref.id, request)
    default:
      return false
  }
}

function channelAction(world: World, me: Id, id: Id, request: ContentRequest): boolean {
  const channel = world.get({ kind: 'channel', id })
  if (!channel) return false
  const open = channel.archivedAt === null
  const member = world.isCurrentMember(me, id)
  const owner = channel.owners.includes(me) && member
  switch (request.action) {
    case 'post':
      return open && member
    case 'join':
      // Public channels: anyone finds and joins them; private ones are invite only (CHAT-01).
      return open && channel.visibility === 'public' && !member
    case 'leave':
      return member
    case 'manage':
      return open && owner
    case 'member.add':
      return (
        open && addsSomeoneElse(world, me, id, request.principal) && (channel.visibility === 'public' ? member : owner)
      )
    case 'member.remove':
      return open && owner && request.principal.id !== me && world.isCurrentMember(request.principal.id, id)
    case 'set_visibility':
      // Making a space private narrows it; making it public would open its whole history and its
      // sessions, so it's refused until the owner decides who may (T13).
      return open && owner && request.to === 'private' && channel.visibility === 'public'
    default:
      return false
  }
}

// Adding a person other than yourself who can take part (an agent joins with A5; ROOM-11).
function addsSomeoneElse(world: World, me: Id, spaceId: Id, principal: { kind: 'human' | 'agent'; id: Id }): boolean {
  return (
    principal.kind === 'human' &&
    principal.id !== me &&
    world.isActivePerson(principal.id) &&
    !world.isCurrentMember(principal.id, spaceId)
  )
}

function roomAction(world: World, me: Id, id: Id, request: ContentRequest): boolean {
  const room = world.get({ kind: 'room', id })
  if (!room || room.archivedAt !== null) return false
  switch (room.kind) {
    case 'channel_room': {
      const channel = world.get({ kind: 'channel', id: room.channelId })
      if (!channel || channel.archivedAt !== null) return false
      if (request.action === 'join') {
        // Only members of a channel join its room, and joining a public channel's room joins the
        // channel (ROOM-01). A restricted room on a public channel can't be joined by anyone
        // until RMS-58 says who may (T13).
        return !(room.restricted && channel.visibility === 'public')
      }
      if (request.action === 'manage') return channel.owners.includes(me) && world.isCurrentMember(me, channel.id)
      return false
    }
    case 'meeting': {
      // A meeting's own room: its attendees join; its organiser manages it (CAL-03).
      const event = world.get({ kind: 'event', id: room.eventId })
      if (!event) return false
      if (request.action === 'join') return true
      return request.action === 'manage' && event.organiserId === me
    }
    case 'standalone': {
      const member = world.isCurrentMember(me, id)
      const owner = room.owners.includes(me) && member
      switch (request.action) {
        case 'join':
          // A public room is open to the org, unless it's restricted (RMS-58, T13); a private one
          // to its members.
          return room.visibility === 'public' ? !room.restricted : member
        case 'post':
          return member
        case 'leave':
          return member
        case 'manage':
          return owner
        case 'member.add':
          return addsSomeoneElse(world, me, id, request.principal) && (room.visibility === 'public' ? member : owner)
        case 'member.remove':
          return owner && request.principal.id !== me && world.isCurrentMember(request.principal.id, id)
        case 'set_visibility':
          return owner && request.to === 'private' && room.visibility === 'public'
        default:
          return false
      }
    }
    default:
      return false
  }
}

const GROUP_DM_LIMIT = 20 // CHAT-02

function conversationAction(world: World, me: Id, ref: Ref, request: ContentRequest): boolean {
  const conversation = world.get({ kind: ref.kind as 'dm', id: ref.id })
  if (!conversation) return false
  const member =
    conversation.kind === 'assistant_chat' ? conversation.ownerId === me : world.isCurrentMember(me, ref.id)
  switch (request.action) {
    case 'post':
      return member
    case 'leave':
      return conversation.kind === 'group_dm' && member
    case 'member.add': {
      // Only a group DM gains members, and only people (Rule 4: an agent never joins a human
      // conversation; a DM that needs a third person becomes a new group). History before they
      // joined stays closed to them (decision 10).
      if (conversation.kind !== 'group_dm' || !member) return false
      const humans = world.currentMembers(ref.id).filter(id => world.principalKind(id) === 'human')
      return humans.length < GROUP_DM_LIMIT && addsSomeoneElse(world, me, ref.id, request.principal)
    }
    default:
      return false
  }
}

function taskAction(world: World, me: Id, id: Id, request: ContentRequest): boolean {
  const task = world.get({ kind: 'task', id })
  if (!task) return false
  // A private task is its owner's alone until they share it (Rule 5).
  if (task.privateToId !== null) {
    return (
      (request.action === 'edit' || request.action === 'delete' || request.action === 'share') &&
      task.privateToId === me
    )
  }
  const involved =
    task.creatorId === me ||
    task.assignees.includes(me) ||
    (task.teamId !== null && world.isTeamMember(me, task.teamId))
  switch (request.action) {
    case 'edit':
      return involved
    case 'delete':
      return task.creatorId === me
    default:
      return false
  }
}

function driveAction(
  world: World,
  me: Id,
  keys: ReadonlySet<Token>,
  ref: { kind: 'folder' | 'file'; id: Id },
  request: ContentRequest,
): boolean {
  const item = ref.kind === 'folder' ? world.folder(ref.id) : world.get({ kind: 'file', id: ref.id })
  if (!item) return false
  const file = ref.kind === 'file' ? world.get({ kind: 'file', id: ref.id }) : undefined
  const trash = trashState(world, ref)
  if (trash.inTrash) {
    // In the Trash only its own owner, and whoever trashed it while they could still edit it,
    // restore it, and only from where it was trashed; only the owner purges (DRV-01, DRV-18).
    // Legal holds are checked by the deletion code, not here (ADM-08, C0.10).
    if (trash.root !== item) return false
    if (request.action === 'restore') {
      return (
        isItemOwner(item, keys) || (trash.root.trashedById === me && atLeast(roleOn(world, ref, me, keys), 'editor'))
      )
    }
    return request.action === 'purge' && isItemOwner(item, keys)
  }
  const role = roleOn(world, ref, me, keys)
  switch (request.action) {
    case 'comment':
      return file !== undefined && atLeast(role, 'commenter')
    case 'edit':
    case 'trash':
      return atLeast(role, 'editor')
    case 'view_history':
      // Earlier versions only for people who can edit (SHEET-26, SLIDE-24, decision 17; docs
      // pending D40).
      return file !== undefined && atLeast(role, 'editor')
    case 'share':
      return maySetSharing(world, ref, me, keys)
    case 'share.set': {
      // Up to Editor, on this item's own grants, to someone in the org, never touching the owner
      // (FILE-03). A grant from a folder above is changed on that folder.
      if (!maySetSharing(world, ref, me, keys) || !granteeInOrg(world, request.grantee)) return false
      if (sameGrantee(request.grantee, ownerAsGrantee(item))) return false
      return request.role !== null || item.grants.some(g => sameGrantee(g.grantee, request.grantee))
    }
    case 'present':
      return file?.subtype === 'deck'
    case 'present_anyway':
      // Only people who can share the deck show it to an audience that can't open it (SLIDE-18).
      return file?.subtype === 'deck' && maySetSharing(world, ref, me, keys)
    case 'set_editors_can_share':
    case 'limit_editing':
      return file !== undefined && isItemOwner(item, keys)
    case 'transfer_ownership': {
      if (!isItemOwner(item, keys)) return false
      const to = request.to
      if (to.kind === item.owner.kind && to.id === item.owner.id) return false
      return to.kind === 'person' ? world.isActivePerson(to.id) : world.isLiveTeam(to.id)
    }
    default:
      return false
  }
}

function commentAction(world: World, me: Id, keys: ReadonlySet<Token>, id: Id, request: ContentRequest): boolean {
  const comment = world.get({ kind: 'comment', id })
  if (!comment) return false
  const fileRef = { kind: 'file' as const, id: comment.fileId }
  if (trashState(world, fileRef).inTrash) return false
  // Everyone who opens the item reads its comments; Commenters and up add, reply and resolve
  // (DOC-05).
  const role = roleOn(world, fileRef, me, keys)
  if (!atLeast(role, 'commenter')) return false
  switch (request.action) {
    case 'resolve':
      return true
    case 'edit':
    case 'delete':
      return comment.authorId === me
    default:
      return false
  }
}

function canCreate(world: World, subject: Subject, request: CreateRequest): boolean {
  // Only a person creates (D16, PA-03; agents with approval in A5, AGT-06).
  if (subject.kind !== 'human' || !world.isActivePerson(subject.id)) return false
  const me = subject.id
  switch (request.kind) {
    case 'channel':
      if (request.visibility === undefined) return false
      return request.visibility === 'private' || publicCreation(world, me)
    case 'room':
      // Who may create standalone rooms follows the public-channel creation setting (ROOM-01).
      return request.visibility !== undefined && publicCreation(world, me)
    case 'dm':
    case 'group_dm':
    case 'event':
    case 'task':
      return true
    case 'folder':
    case 'file': {
      // "Anyone can create … in the current folder" (FILE-01): anyone who can add to it, meaning
      // Editor and up; My Drive is everyone's own (T13).
      if (request.in === undefined) return true
      if (request.in.kind !== 'folder') return false
      const folder = { kind: 'folder' as const, id: request.in.id }
      if (trashState(world, folder).inTrash) return false
      const keys = new Set(keysOf(world, subject))
      return allows(readersOf(world, folder), keys) && atLeast(roleOn(world, folder, me, keys), 'editor')
    }
    default:
      return false
  }
}

function publicCreation(world: World, me: Id): boolean {
  return world.facts.settings.publicCreation === 'everyone' || isAdmin(world, me)
}

// Agents (A5). An agent reads only what is live, never a human DM or group DM, a restricted
// session, an assistant conversation or a personal item, and otherwise only inside its scope
// (Rules 1, 2, 4, 5; AGT-04); a DM with the agent itself is visible to it (Rule 4). Its scope is
// the published version's, from the snapshot.
function agentReads(world: World, agentId: Id, ref: Ref): boolean {
  const agent = world.agent(agentId)
  if (!agent || agent.archivedAt !== null || !isLive(world, ref)) return false
  const ownDm = agentDmOf(world, ref)
  if (ownDm !== undefined) return world.isCurrentMember(agentId, ownDm)
  if (indexClassOf(world, ref) !== 'normal') return false
  return inScope(world, agent.scope, ref)
}

// Whether an item is still there: not deleted, not in the Trash, its chain resolving, and for
// something derived, every source live (Rule 7).
export function isLive(world: World, ref: Ref, seen: ReadonlySet<string> = new Set()): boolean {
  if (readersOf(world, ref).length === 0) return false
  switch (ref.kind) {
    case 'folder':
    case 'file':
      return !trashState(world, ref as { kind: 'folder' | 'file'; id: Id }).inTrash
    case 'comment': {
      const comment = world.get({ kind: 'comment', id: ref.id })
      return comment !== undefined && isLive(world, { kind: 'file', id: comment.fileId })
    }
    case 'derived': {
      const key = `derived:${ref.id}`
      const derived = world.get({ kind: 'derived', id: ref.id })
      if (seen.has(key)) return false
      const next = new Set(seen).add(key)
      return derived?.sources.every(source => isLive(world, source, next)) === true
    }
    default:
      return true
  }
}

// The agent DM an item sits in, if any: the conversation itself, a message in it, or an attachment
// of such a message.
function agentDmOf(world: World, ref: Ref): Id | undefined {
  if (ref.kind === 'agent_dm') return ref.id
  if (ref.kind === 'message') {
    const message = world.get({ kind: 'message', id: ref.id })
    const space = message ? world.space(message.spaceId) : undefined
    return space?.kind === 'conversation' && space.fact.kind === 'agent_dm' ? space.fact.id : undefined
  }
  if (ref.kind === 'file') {
    const file = world.get({ kind: 'file', id: ref.id })
    return file?.parent.kind === 'message' ? agentDmOf(world, { kind: 'message', id: file.parent.id }) : undefined
  }
  return undefined
}

// Whether an item is inside an agent's scope: it, or something that contains it, is listed. An
// item made from several sources is in scope only if every source is (AGT-04).
export function inScope(world: World, scope: readonly Ref[], ref: Ref, seen: ReadonlySet<string> = new Set()): boolean {
  if (ref.kind === 'derived') {
    const key = `derived:${ref.id}`
    const derived = world.get({ kind: 'derived', id: ref.id })
    if (!derived || derived.sources.length === 0 || seen.has(key)) return false
    const next = new Set(seen).add(key)
    return derived.sources.every(s => inScope(world, scope, s, next))
  }
  const listed = (r: Ref) => scope.some(s => s.kind === r.kind && s.id === r.id)
  return containersOf(world, ref).some(listed)
}

// An item and everything that contains it, nearest first.
export function containersOf(world: World, ref: Ref, depth = 0): Ref[] {
  if (depth > 64) return []
  const up = (next: Ref | undefined): Ref[] => [ref, ...(next ? containersOf(world, next, depth + 1) : [])]
  switch (ref.kind) {
    case 'message': {
      const message = world.get({ kind: 'message', id: ref.id })
      const space = message ? world.space(message.spaceId) : undefined
      if (!space) return [ref]
      const kind = space.kind === 'conversation' ? space.fact.kind : space.kind
      return up({ kind, id: space.fact.id })
    }
    case 'room': {
      const room = world.get({ kind: 'room', id: ref.id })
      return up(room?.kind === 'channel_room' ? { kind: 'channel', id: room.channelId } : undefined)
    }
    case 'session': {
      const session = world.get({ kind: 'session', id: ref.id })
      if (!session) return [ref]
      if (session.place.kind === 'room') return up({ kind: 'room', id: session.place.roomId })
      const space = world.space(session.place.conversationId)
      return up(space?.kind === 'conversation' ? { kind: space.fact.kind, id: space.fact.id } : undefined)
    }
    case 'slide_copy': {
      const copy = world.get({ kind: 'slide_copy', id: ref.id })
      return up(copy ? { kind: 'session', id: copy.sessionId } : undefined)
    }
    case 'thread': {
      const thread = world.get({ kind: 'thread', id: ref.id })
      if (!thread) return [ref]
      return up(
        thread.audience.kind === 'event'
          ? { kind: 'event', id: thread.audience.eventId }
          : { kind: 'session', id: thread.audience.sessionId },
      )
    }
    case 'file': {
      const file = world.get({ kind: 'file', id: ref.id })
      if (!file) return [ref]
      if (file.parent.kind === 'message') return up({ kind: 'message', id: file.parent.id })
      return up(file.parent.kind === 'folder' ? { kind: 'folder', id: file.parent.id } : undefined)
    }
    case 'folder': {
      const folder = world.folder(ref.id)
      return up(folder?.parentId ? { kind: 'folder', id: folder.parentId } : undefined)
    }
    case 'comment': {
      const comment = world.get({ kind: 'comment', id: ref.id })
      return up(comment ? { kind: 'file', id: comment.fileId } : undefined)
    }
    default:
      return [ref]
  }
}
