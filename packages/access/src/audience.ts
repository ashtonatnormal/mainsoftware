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
// read, or one whose readers need several clauses). Every function here treats null, and an
// audience naming something the snapshot doesn't hold or nobody at all, as "covers nothing", so a
// missing fact never widens what may be shown.
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
      const era = world.membership(id)
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

// Whether the snapshot can say who an audience is (T13: a fact it doesn't hold denies). Every
// org, person, team, space and era it names must be in the snapshot, and it must hold someone now
// or be able to gain someone later: an audience of people who have all left, or of a conversation
// nobody is in any more, is unknown, never empty. A partly loaded membership or meeting-session
// list can't be seen here; the loader's obligation in world.ts covers it.
function resolvable(world: World, audience: Audience | null): audience is Audience {
  if (!audience || audience.orgId !== world.orgId || audience.tokens.length === 0) return false
  for (const token of audience.tokens) {
    const [prefix, ...rest] = token.split(':')
    const id = rest.join(':')
    const known =
      prefix === 'o'
        ? id === world.orgId
        : prefix === 'p'
          ? world.person(id) !== undefined
          : prefix === 't' || prefix === 'ta'
            ? world.team(id) !== undefined
            : prefix === 'm'
              ? world.space(id) !== undefined
              : prefix === 'e'
                ? world.membership(id) !== undefined
                : false
    if (!known) return false
  }
  return audience.tokens.some(t => isOpenToken(world, t)) || audiencePeople(world, audience).length > 0
}

// Who in an audience can't read an item: for each open token, the item must be readable by that
// same token or by the whole org, since later members count; for each closed token, everyone who
// holds it now must be able to read it. An audience the snapshot can't resolve names nobody and
// sets includesFuture, so covers() is false; don't show its count.
export function audienceGap(world: World, audience: Audience | null, item: Ref): AudienceGap {
  if (!resolvable(world, audience)) return { count: 0, people: [], includesFuture: true }
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
// warning; Rule 3's insert warning). Strict: false for an audience the snapshot can't resolve.
export function covers(world: World, audience: Audience | null, item: Ref): boolean {
  if (!resolvable(world, audience)) return false
  const gap = audienceGap(world, audience, item)
  return gap.count === 0 && !gap.includesFuture
}

// Whether two places are seen by exactly the same people, now and later (REC-13: notes go only
// where the readers exactly match the session's audience).
export function sameAudience(world: World, a: Audience | null, b: Audience | null): boolean {
  if (!resolvable(world, a) || !resolvable(world, b)) return false
  const tokens = (x: Audience, open: boolean) =>
    x.tokens
      .filter(t => isOpenToken(world, t) === open)
      .sort()
      .join('\n')
  const open = tokens(a, true)
  if (open !== tokens(b, true)) return false
  // Beside an open token, a closed one keeps someone in after they leave the open one, so the
  // closed tokens must match too; beside the whole org they add nobody. With no open token,
  // nobody joins later, so today's people decide.
  const org = orgToken(world.orgId)
  if (open !== '' && !open.split('\n').includes(org) && tokens(a, false) !== tokens(b, false)) return false
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
