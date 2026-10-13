import { type RawBuilder, type SqlBool, sql } from 'kysely'
import type { Token } from './model.ts'

// The access filter for SQL (C1.7 keyword search, A2 retrieval; TECH-SPEC T3), kept apart from the
// rest of the package (exported as @hearth/access/sql) so the web app never bundles Kysely.
//
// It reads the row shape aclOf (lists.ts) produces: `tokens` (text[]) holds the readers' first
// clause, and `more` (jsonb, an array of token arrays, '[]' when there is none) any further
// clauses. A row is readable when the keys meet `tokens` and every clause in `more`, which is
// exactly the in-memory rule (readers.ts), so filterReadable and this predicate agree. A table
// that stores these declares `acl_tokens text[] not null` and `acl_more jsonb not null default
// '[]' check (jsonb_typeof(acl_more) = 'array')`; should `more` still be NULL, it reads as one
// clause nobody meets, so the row is nobody's rather than losing its other clauses.
//
// Use it in the WHERE of the same query that pages and counts (never after a LIMIT or a count),
// then re-check each row with filterReadable; a row the re-check drops is refilled from the next
// rows rather than returned as a short page, and totals count only rows that pass both (SRCH-04,
// PRD-107). `keys` are keysOf(world, subject) for the person or assistant asking. An agent holds no
// keys (it reads by its scope, AGT-04), so this selects nothing for one; A2's retrieval layer
// brings the agents' filter.
export interface AclColumns {
  tokens: string
  more: string
}
export const DEFAULT_ACL_COLUMNS: AclColumns = { tokens: 'acl_tokens', more: 'acl_more' }

export function sqlReadableBy(keys: readonly Token[], columns: AclColumns = DEFAULT_ACL_COLUMNS): RawBuilder<SqlBool> {
  const held = sql`${sql.val([...keys])}::text[]`
  return sql<SqlBool>`(${sql.ref(columns.tokens)} && ${held} and not exists (
    select 1 from jsonb_array_elements(coalesce(${sql.ref(columns.more)}, '[[]]'::jsonb)) as clause (tokens)
    where not (array(select jsonb_array_elements_text(clause.tokens)) && ${held})
  ))`
}
