import type { Ref } from './model.ts'
import { conversationShapeOk } from './readers.ts'
import type { World } from './world.ts'

// Which index an item may go into (C0.6 stamps it on outbox events; C1.7 and A2 read it):
// - normal: indexed under its own readers (BRAIN-02).
// - dm: a human DM or group DM and what's in it, including DM calls: searchable by its members,
//   and for AI only by their own assistants; never by a specialist agent (Rule 4).
// - agent_dm: a DM with an agent: its person, their assistant, and that agent (Rule 4).
// - personal: an assistant conversation, a suggested task or a private task: its owner only
//   (§7.4, TASK-06, Rule 5).
// - playback_only: slides shown to an audience some of whom couldn't open the deck: kept with the
//   session, never indexed (SLIDE-34).
// - restricted: a restricted session and everything made from it: never indexed (Rule 5,
//   decision 13). Also anything this snapshot can't resolve, so an unknown item is never indexed.
export type IndexClass = 'normal' | 'dm' | 'agent_dm' | 'personal' | 'playback_only' | 'restricted'

// Strictest first: an item made from several sources takes the strictest of their classes.
const STRICTNESS: readonly IndexClass[] = ['restricted', 'personal', 'dm', 'agent_dm', 'playback_only', 'normal']
export function strictest(classes: readonly IndexClass[]): IndexClass {
  if (classes.length === 0) return 'restricted'
  return STRICTNESS.find(c => classes.includes(c)) ?? 'restricted'
}

// The classes keyword search (C1.7) may hold: never restricted or playback-only items.
export const SEARCHABLE_CLASSES: readonly IndexClass[] = ['normal', 'dm', 'agent_dm', 'personal']

export function indexClassOf(world: World, ref: Ref, seen: ReadonlySet<string> = new Set()): IndexClass {
  const key = `${ref.kind}:${ref.id}`
  if (seen.has(key)) return 'restricted'
  const visit = new Set(seen).add(key)
  const of = (next: Ref) => indexClassOf(world, next, visit)
  switch (ref.kind) {
    case 'channel':
      return world.get({ kind: 'channel', id: ref.id }) ? 'normal' : 'restricted'
    case 'dm':
    case 'group_dm':
    case 'agent_dm':
    case 'assistant_chat': {
      const conversation = world.get({ kind: ref.kind, id: ref.id })
      if (!conversation || !conversationShapeOk(world, conversation)) return 'restricted'
      return conversation.kind === 'assistant_chat' ? 'personal' : conversation.kind === 'agent_dm' ? 'agent_dm' : 'dm'
    }
    case 'room': {
      const room = world.get({ kind: 'room', id: ref.id })
      if (!room) return 'restricted'
      return room.restricted ? 'restricted' : 'normal'
    }
    case 'thread': {
      const thread = world.get({ kind: 'thread', id: ref.id })
      if (!thread) return 'restricted'
      return thread.audience.kind === 'call' ? of({ kind: 'session', id: thread.audience.sessionId }) : 'normal'
    }
    case 'message': {
      const message = world.get({ kind: 'message', id: ref.id })
      const space = message ? world.space(message.spaceId) : undefined
      if (!message || !space) return 'restricted'
      const kind = space.kind === 'conversation' ? space.fact.kind : space.kind
      return of({ kind, id: space.fact.id })
    }
    case 'session': {
      const session = world.get({ kind: 'session', id: ref.id })
      if (!session) return 'restricted'
      // Stamped at the start: a later change to the room's flag doesn't reclassify it
      // (decision 13; only an audited DPO or Compliance action does, C2.4).
      if (session.stamp.restricted) return 'restricted'
      if (session.place.kind === 'conversation') {
        const conversation = world.space(session.place.conversationId)
        if (conversation?.kind !== 'conversation') return 'restricted'
        return of({ kind: conversation.fact.kind, id: conversation.fact.id })
      }
      return world.get({ kind: 'room', id: session.place.roomId }) ? 'normal' : 'restricted'
    }
    case 'slide_copy': {
      const copy = world.get({ kind: 'slide_copy', id: ref.id })
      if (!copy) return 'restricted'
      const session = of({ kind: 'session', id: copy.sessionId })
      return strictest([session, copy.playbackOnly ? 'playback_only' : 'normal'])
    }
    case 'event':
      return world.get({ kind: 'event', id: ref.id }) ? 'normal' : 'restricted'
    case 'task': {
      const task = world.get({ kind: 'task', id: ref.id })
      if (!task) return 'restricted'
      // A task made from a message keeps its source's class (C2.1); a private one is personal,
      // and one made from a restricted session stays restricted (Rule 5).
      const own: IndexClass = task.privateToId !== null ? 'personal' : 'normal'
      return task.sourceRef ? strictest([own, of(task.sourceRef)]) : own
    }
    case 'suggested_task': {
      const suggestion = world.get({ kind: 'suggested_task', id: ref.id })
      if (!suggestion) return 'restricted'
      return suggestion.sourceRef ? strictest(['personal', of(suggestion.sourceRef)]) : 'personal'
    }
    case 'folder':
      return world.driveChain({ kind: 'folder', id: ref.id }) ? 'normal' : 'restricted'
    case 'file': {
      const file = world.get({ kind: 'file', id: ref.id })
      if (!file || !world.driveChain({ kind: 'file', id: ref.id })) return 'restricted'
      // A chat attachment is classed with its message (CHAT-06).
      return file.parent.kind === 'message' ? of({ kind: 'message', id: file.parent.id }) : 'normal'
    }
    case 'comment': {
      const comment = world.get({ kind: 'comment', id: ref.id })
      return comment ? of({ kind: 'file', id: comment.fileId }) : 'restricted'
    }
    case 'derived': {
      const derived = world.get({ kind: 'derived', id: ref.id })
      if (!derived || derived.sources.length === 0) return 'restricted'
      return strictest(derived.sources.map(of))
    }
    default:
      return 'restricted'
  }
}
