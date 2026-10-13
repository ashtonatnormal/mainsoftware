import { expect } from 'vitest'
import {
  type AclRow,
  can,
  canRead,
  type Facts,
  filterReadable,
  type Id,
  listAccessible,
  type Ref,
  type Request,
  type RequestContext,
  type ResourceKind,
  type Subject,
  type Token,
  type World,
} from '../../index.ts'
import { ALL_REFS, fixtureWorld, human } from '../index.ts'

export { can, canRead, filterReadable, listAccessible }

// The fixture world, built once; a case that changes facts builds its own with fixtureWorld(change).
export const world = fixtureWorld()

export function reads(w: World, subject: Subject | Id, item: Ref): boolean {
  return canRead(w, typeof subject === 'string' ? human(subject) : subject, item)
}

// Asserts who, among the given people, can and can't read an item.
export function expectReaders(w: World, item: Ref, readers: readonly Id[], nonReaders: readonly Id[]): void {
  for (const p of readers) expect(reads(w, p, item), `${p} should read ${item.kind} ${item.id}`).toBe(true)
  for (const p of nonReaders) expect(reads(w, p, item), `${p} should not read ${item.kind} ${item.id}`).toBe(false)
}

export function allows(w: World, subject: Subject | Id, request: Request, context?: RequestContext): boolean {
  return can(w, typeof subject === 'string' ? human(subject) : subject, request, context)
}

// Every ref in the fixture of one kind, or of every kind.
export function refsOf(kind?: ResourceKind): Ref[] {
  return ALL_REFS().filter(r => kind === undefined || r.kind === kind)
}

// The fixture with some facts changed.
export function changed(change: (facts: Facts) => Facts): World {
  return fixtureWorld(change)
}

// The row rule sqlReadableBy (sql.ts) runs in Postgres, in memory: the keys meet a stored row's
// tokens and every clause in its more column. scripts/check-access-sql.ts checks the SQL itself
// against this rule on a real database.
export function rowReadable(row: AclRow, keys: Iterable<Token>): boolean {
  const held = new Set(keys)
  return row.tokens.some(t => held.has(t)) && row.more.every(clause => clause.some(t => held.has(t)))
}
