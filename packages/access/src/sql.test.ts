// Unit tests for the SQL access filter (sql.ts; B.4, T3; SRCH-04, PRD-107; BUILD-PLAN C0.4 R1-04).
// They compile queries with Kysely's Postgres compiler and no database: the predicate must sit in
// the WHERE of the same query that pages and counts (never after a LIMIT or a count), carry the
// keys only as parameters, and name its columns as quoted identifiers. That the predicate admits
// exactly what filterReadable does is proved on a real Postgres by scripts/check-access-sql.ts (CI's
// migrations job).
import {
  type CompiledQuery,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely'
import { describe, expect, test } from 'vitest'
import { keysOf } from './index.ts'
import { DEFAULT_ACL_COLUMNS, sqlReadableBy } from './sql.ts'
import { fixtureWorld, human, P } from './testing/index.ts'

interface SearchRow {
  id: string
  kind: string
  title: string
  acl_tokens: string[]
  acl_more: unknown
}
interface Database {
  search_rows: SearchRow
}

// A Kysely that compiles Postgres SQL and never connects.
const db = new Kysely<Database>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: kysely => new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
})

const world = fixtureWorld()
const ashton = keysOf(world, human(P.ashton))
const flat = (text: string) => text.replace(/\s+/g, ' ').trim()
// The predicate's own SQL, compiled alone.
const predicate = (keys: readonly string[], columns = DEFAULT_ACL_COLUMNS) =>
  flat(sqlReadableBy(keys, columns).compile(db).sql)
const page = (keys: readonly string[]): CompiledQuery =>
  db.selectFrom('search_rows').selectAll().where(sqlReadableBy(keys)).orderBy('id').limit(20).compile()

describe('sqlReadableBy (B.4, T3)', () => {
  test('is exactly the clause rule over acl_tokens and acl_more, which scripts/check-access-sql.ts proves on Postgres', () => {
    // Changing this text means running node scripts/check-access-sql.ts again (the local stack up).
    // A NULL acl_more is one clause nobody meets, never "no further clauses".
    expect(predicate(ashton)).toBe(
      flat(`("acl_tokens" && $1::text[] and not exists (
        select 1 from jsonb_array_elements(coalesce("acl_more", '[[]]'::jsonb)) as clause (tokens)
        where not (array(select jsonb_array_elements_text(clause.tokens)) && $2::text[])
      ))`),
    )
    expect(DEFAULT_ACL_COLUMNS).toEqual({ tokens: 'acl_tokens', more: 'acl_more' })
  })

  test('SRCH-04 PRD-107 R1-04: filters in the WHERE of the paged query, before ORDER BY and LIMIT', () => {
    const compiled = page(ashton)
    const text = flat(compiled.sql)
    const where = predicate(ashton)
    expect(text).toBe(`select * from "search_rows" where ${where} order by "id" limit $3`)
    // One outer query: the only FROM on the table is the one the WHERE and LIMIT belong to.
    expect(text.split('from "search_rows"')).toHaveLength(2)
    expect(text.indexOf(' where ')).toBeLessThan(text.indexOf(where))
    expect(text.indexOf(where)).toBeLessThan(text.lastIndexOf(' order by '))
    expect(text.lastIndexOf(' order by ')).toBeLessThan(text.lastIndexOf(' limit '))
    expect(compiled.parameters).toEqual([ashton, ashton, 20])
  })

  test('SRCH-04 PRD-107 R1-04: a count query carries the same predicate, so totals count only readable rows', () => {
    const compiled = db
      .selectFrom('search_rows')
      .select(eb => eb.fn.countAll().as('total'))
      .where(sqlReadableBy(ashton))
      .compile()
    expect(flat(compiled.sql)).toBe(`select count(*) as "total" from "search_rows" where ${predicate(ashton)}`)
    expect(compiled.parameters).toEqual([ashton, ashton])
  })

  test('passes the keys as parameters and never puts them in the SQL text', () => {
    const hostile = ["p:x'); drop table search_rows; --", 'o:$1', 'm:"acl_tokens"', 'e:\\', 't:\u2019']
    const compiled = page(hostile)
    for (const key of hostile) expect(compiled.sql, key).not.toContain(key)
    expect(compiled.parameters).toEqual([hostile, hostile, 20])
  })

  test('takes a copy of the keys when built, so changing the caller’s list later changes nothing', () => {
    const keys = [...ashton]
    const built = sqlReadableBy(keys)
    keys.push('o:another-org')
    keys[0] = 'p:someone-else'
    const compiled = db.selectFrom('search_rows').selectAll().where(built).compile()
    expect(compiled.parameters).toEqual([ashton, ashton])
  })

  test('no keys bind an empty array, which no row’s tokens overlap', () => {
    const compiled = page([])
    expect(compiled.parameters).toEqual([[], [], 20])
    expect(flat(compiled.sql)).toContain('"acl_tokens" && $1::text[]')
  })

  test('names custom columns as quoted identifiers, a table-qualified one too, never as raw SQL', () => {
    const qualified = predicate(ashton, { tokens: 'r.readers', more: 'r.extra' })
    expect(qualified).toContain('"r"."readers" && $1::text[]')
    expect(qualified).toContain(`jsonb_array_elements(coalesce("r"."extra", '[[]]'::jsonb))`)
    // A name that tries to break out of the identifier stays one identifier.
    const hostile = predicate(ashton, { tokens: 'acl_tokens) or (true', more: 'we"ird' })
    expect(hostile).toContain('"acl_tokens) or (true" && $1::text[]')
    expect(hostile).toContain(`jsonb_array_elements(coalesce("we""ird", '[[]]'::jsonb))`)
    expect(hostile).not.toMatch(/\bor \(true\b(?!")/)
  })

  test('is wrapped in parentheses, so it stays one condition beside others', () => {
    const and = flat(
      db.selectFrom('search_rows').selectAll().where(sqlReadableBy(ashton)).where('kind', '=', 'message').compile().sql,
    )
    expect(and).toBe(`select * from "search_rows" where ${predicate(ashton)} and "kind" = $3`)
    // Inside an OR, its own AND can't bind to a neighbour.
    const or = db
      .selectFrom('search_rows')
      .selectAll()
      .where(eb => eb.and([eb('kind', '=', 'message'), eb.or([eb('title', '=', 'Q4'), sqlReadableBy(ashton)])]))
      .compile()
    expect(flat(or.sql)).toContain(`("title" = $2 or ("acl_tokens" && $3::text[] and not exists (`)
    expect(or.parameters).toEqual(['message', 'Q4', ashton, ashton])
  })
})
