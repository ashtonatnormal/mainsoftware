import type { Id, Subject, Token } from './model.ts'
import type { World } from './world.ts'

// Token constructors. A reader set (readers.ts) and a subject's keys use the same strings, so a
// subject reads a resource when its keys meet the resource's readers.
export const orgToken = (id: Id): Token => `o:${id}`
export const teamToken = (id: Id): Token => `t:${id}`
export const teamAdminsToken = (id: Id): Token => `ta:${id}`
export const membersToken = (spaceId: Id): Token => `m:${spaceId}`
export const eraToken = (membershipId: Id): Token => `e:${membershipId}`
export const personToken = (id: Id): Token => `p:${id}`

// The tokens a subject holds now.
// - A person on the roster who hasn't left: the org, themselves, each team they're in (an
//   archived team's too, for content granted to it), each team they're a current Team Admin of
//   while it isn't archived, each space they're a current member of, and, in each group DM they
//   are in now, every era of theirs in it (so they read the messages of their own spans only, and
//   none after they leave, decision 10).
// - An assistant: exactly its owner's keys, while it and its owner are active (PA-02, §7.1).
// - An agent or a system principal: none. Agents read by scope (can.ts); system jobs read nothing
//   through this package (PRD-112).
// - Anyone the snapshot doesn't hold, or who has left: none.
export function keysOf(world: World, subject: Subject): Token[] {
  switch (subject.kind) {
    case 'human':
      return personKeys(world, subject.id)
    case 'assistant': {
      const assistant = world.assistant(subject.id)
      if (!assistant || assistant.archivedAt !== null) return []
      return personKeys(world, assistant.ownerId)
    }
    case 'agent':
    case 'system':
      return []
    default:
      return []
  }
}

function personKeys(world: World, personId: Id): Token[] {
  if (!world.isActivePerson(personId)) return []
  const keys = new Set<Token>([orgToken(world.orgId), personToken(personId)])
  for (const teamId of world.teamsOf(personId)) keys.add(teamToken(teamId))
  for (const role of world.rolesOf(personId)) {
    if (role.role === 'team_admin' && role.teamId !== null) keys.add(teamAdminsToken(role.teamId))
  }
  const memberships = world.membershipsOfPrincipal(personId)
  for (const m of memberships) {
    if (m.throughSeq !== null) continue
    const space = world.space(m.spaceId)
    if (!space) continue
    keys.add(membersToken(m.spaceId))
    if (space.kind === 'conversation' && space.fact.kind === 'group_dm') {
      for (const era of memberships) if (era.spaceId === m.spaceId) keys.add(eraToken(era.id))
    }
  }
  return [...keys].sort()
}
