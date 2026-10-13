import { type Audience, covers } from './audience.ts'
import { canRead } from './can.ts'
import { type IndexClass, indexClassOf } from './index-class.ts'
import type { Id, Ref, ResourceKind, Subject, Token } from './model.ts'
import { readersOf } from './readers.ts'
import type { World } from './world.ts'

// The items a subject can read, in the order given (C1.7's live re-check after the SQL
// pre-filter; PRD-99's re-check of anything precomputed, at render). The result depends only on
// what the subject can read, never on what else was asked about (SRCH-04, PRD-107).
export function filterReadable(world: World, subject: Subject, refs: readonly Ref[]): Ref[] {
  return refs.filter(ref => canRead(world, subject, ref))
}

// Every item of a kind in the snapshot that a subject can read.
export function listAccessible(world: World, subject: Subject, kind: ResourceKind): Ref[] {
  return world
    .all(kind)
    .map(fact => ({ kind, id: (fact as { id: Id }).id }))
    .filter(ref => canRead(world, subject, ref))
}

// The row shape an outbox event's ACL snapshot (C0.6) and a search row (C1.7) store for an item:
// its readers' first clause as `tokens` (the GIN-indexed pre-filter), any further clauses in
// `more`, and its index class. sqlReadableBy (sql.ts) reads exactly this shape. A membership
// change (joining, leaving, a team change, a role change) changes subjects' keys, not stored
// rows; a grant, visibility, move, trash or restore changes the rows of the item and everything
// under it, which C4.1's re-ACL job rewrites.
export interface AclRow {
  tokens: readonly Token[]
  more: readonly (readonly Token[])[]
  indexClass: IndexClass
}
export function aclOf(world: World, ref: Ref): AclRow {
  const [first = [], ...more] = readersOf(world, ref)
  return { tokens: first, more, indexClass: indexClassOf(world, ref) }
}

// Who reads an item and what an AI answer may use from it (Rule 2, §7.1). Every arm names
// everyone whose access bounds the answer, so leaving one out is a type error, never a wider
// answer:
// - agent_asked: AgentScope ∩ Access(asker) ∩ the audience of the place it answers in.
// - agent_scheduled: AgentScope ∩ the audience; the agent's owner and admins are never consulted.
// - built_in: the viewer's access ∩ the audience.
// The functions are pure set algebra and run in C0; the AI that uses them arrives in A2-A5.
export type SourceRun =
  | { run: 'agent_asked'; agentId: Id; asker: Subject; audience: Audience | null }
  | { run: 'agent_scheduled'; agentId: Id; audience: Audience | null }
  | { run: 'built_in'; viewer: Subject; audience: Audience | null }

export function sourceAllowed(world: World, run: SourceRun, source: Ref): boolean {
  switch (run.run) {
    case 'agent_asked':
      return (
        canRead(world, { kind: 'agent', id: run.agentId }, source) &&
        run.asker.kind !== 'agent' &&
        canRead(world, run.asker, source) &&
        covers(world, run.audience, source)
      )
    case 'agent_scheduled':
      return canRead(world, { kind: 'agent', id: run.agentId }, source) && covers(world, run.audience, source)
    case 'built_in':
      return run.viewer.kind !== 'agent' && canRead(world, run.viewer, source) && covers(world, run.audience, source)
    default:
      return false
  }
}
