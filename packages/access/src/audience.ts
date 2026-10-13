import { canRead } from './can.ts'
import { orgToken, personToken } from './keys.ts'
import type { Id, Ref, SessionStamp, Token } from './model.ts'
import { attendeesOf, readersOf } from './readers.ts'
import type { World } from './world.ts'

// Who sees what is posted in, or kept at, a place (Rule 2, PRD-35, decision 9): the place's own
// readers, kept as tokens so that people who join later count. A public space's audience is the
// whole org; a private channel's or standalone room's is "its members", now and later; a session's
// is its stamp (REC-20). Agents and assistants never count: an audience is people (CHAT-17,
// REC-01).
export interface Audience {
  orgId: Id
  tokens: readonly Token[]
}

// The audience of a place, or null when the snapshot can't say (an unknown place, one nobody can
// read, or one whose readers need several clauses). Every function here treats null as "covers
// nothing", so a missing fact never widens what may be shown.
export function audienceOf(world: World, place: Ref): Audience | null {
  const acl = readersOf(world, place)
  if (acl.length !== 1) return null
  const [tokens] = acl
  return tokens && tokens.length > 0 ? { orgId: world.orgId, tokens } : null
}

// An audience of named people (STU-02's view-as uses the AI Admin as the audience).
export function audienceOfPeople(world: World, people: readonly Id[]): Audience | null {
  const tokens = [...new Set(people)].sort().map(personToken)
  return tokens.length > 0 ? { orgId: world.orgId, tokens } : null
}

// A token whose holders can grow: the org, a team, a team's admins, and a channel's or standalone
// room's members. A person, an era and a conversation's members can't: a DM never gains members,
// and someone added to a group DM later doesn't see what was posted before (decision 10).
export function isOpenToken(world: World, token: Token): boolean {
  if (token.startsWith('o:') || token.startsWith('t:') || token.startsWith('ta:')) return true
  if (token.startsWith('m:')) {
    const space = world.space(token.slice(2))
    return space !== undefined && (space.kind === 'channel' || space.kind === 'room')
  }
  return false
}

// The active people who hold a token now.
export function holdersOf(world: World, token: Token): Id[] {
  const [prefix, ...rest] = token.split(':')
  const id = rest.join(':')
  const active = (ids: readonly Id[]) => ids.filter(p => world.isActivePerson(p))
  switch (prefix) {
    case 'o':
      return id === world.orgId ? world.activePeople() : []
    case 'p':
      return active([id])
    case 't':
      return active(world.membersOf(id))
    case 'ta':
      return active(world.activePeople().filter(p => world.isTeamAdminOf(p, id)))
    case 'm':
      return active(world.currentMembers(id).filter(p => world.principalKind(p) === 'human'))
    case 'e': {
      const era = world.facts.memberships.find(m => m.id === id)
      return era && world.isCurrentMember(era.principalId, era.spaceId) ? active([era.principalId]) : []
    }
    default:
      return []
  }
}

// The people in an audience now.
export function audiencePeople(world: World, audience: Audience | null): Id[] {
  if (!audience || audience.orgId !== world.orgId) return []
  return [...new Set(audience.tokens.flatMap(t => holdersOf(world, t)))].sort()
}

export interface AudienceGap {
  // How many people in the audience now can't read the item, and who (they can all see the
  // place, so naming them reveals nothing; SLIDE-18 shows the count).
  count: number
  people: readonly Id[]
  // Whether people who join the place later won't be able to read it either (SLIDE-18:
  // "including future members").
  includesFuture: boolean
}

// Who in an audience can't read an item: for each open token, the item must be readable by that
// same token or by the whole org, since later members count; for each closed token, everyone who
// holds it now must be able to read it. An unknown audience is all gap.
export function audienceGap(world: World, audience: Audience | null, item: Ref): AudienceGap {
  if (!audience || audience.orgId !== world.orgId || audience.tokens.length === 0) {
    return { count: 0, people: [], includesFuture: true }
  }
  const readers = readersOf(world, item)
  const org = orgToken(world.orgId)
  let includesFuture = false
  for (const token of audience.tokens) {
    if (!isOpenToken(world, token)) continue
    const structural = readers.length > 0 && readers.every(c => c.includes(token) || c.includes(org))
    if (!structural) includesFuture = true
  }
  const people = audiencePeople(world, audience).filter(p => !canRead(world, { kind: 'human', id: p }, item))
  return { count: people.length, people, includesFuture }
}

// Whether everyone who will see a place can read an item (Rule 2's bound; CHAT-14's forward
// warning; Rule 3's insert warning). Strict: false for an unknown or empty audience.
export function covers(world: World, audience: Audience | null, item: Ref): boolean {
  if (!audience || audience.orgId !== world.orgId || audience.tokens.length === 0) return false
  const gap = audienceGap(world, audience, item)
  return gap.count === 0 && !gap.includesFuture
}

// Whether two places are seen by exactly the same people, now and later (REC-13: notes go only
// where the readers exactly match the session's audience).
export function sameAudience(world: World, a: Audience | null, b: Audience | null): boolean {
  if (!a || !b || a.tokens.length === 0 || b.tokens.length === 0) return false
  if (a.orgId !== world.orgId || b.orgId !== world.orgId) return false
  const open = (x: Audience) =>
    x.tokens
      .filter(t => isOpenToken(world, t))
      .sort()
      .join('\n')
  if (open(a) !== open(b)) return false
  return audiencePeople(world, a).join('\n') === audiencePeople(world, b).join('\n')
}

// What C2.4 stamps when a session starts (REC-20), from where it happens: a scheduled meeting
// (in its own room or a team room) → its invitees then, plus whoever takes part; a DM or group-DM
// call → its participants; a room session → the channel's or standalone room's readers, evaluated
// live. The room's restricted flag at the start makes it participants-only (Rule 5). null when
// the place isn't in the snapshot. C2.4 stores this, never audienceOf's output, which would freeze
// the membership (SLIDE-18).
export function stampFor(world: World, place: { roomId?: Id; conversationId?: Id; eventId?: Id }): SessionStamp | null {
  const room = place.roomId === undefined ? undefined : world.get({ kind: 'room', id: place.roomId })
  if (place.roomId !== undefined && !room) return null
  const restricted = room?.restricted ?? false
  const eventId = place.eventId ?? (room?.kind === 'meeting' ? room.eventId : undefined)
  if (eventId !== undefined) {
    const event = world.get({ kind: 'event', id: eventId })
    if (!event) return null
    return { restricted, audience: 'invitees_and_participants', eventId, invitees: attendeesOf(event) }
  }
  if (place.conversationId !== undefined) {
    const space = world.space(place.conversationId)
    if (space?.kind !== 'conversation' || space.fact.kind === 'assistant_chat') return null
    return { restricted, audience: 'participants' }
  }
  if (room?.kind === 'channel_room') return { restricted, audience: 'space', spaceId: room.channelId }
  if (room?.kind === 'standalone') return { restricted, audience: 'space', spaceId: room.id }
  return null
}
