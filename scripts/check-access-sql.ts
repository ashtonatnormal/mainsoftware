// Proves on a real Postgres 17 that the SQL access filter (sql.ts, sqlReadableBy) admits exactly
// the rows the in-memory rule does (filterReadable; B.4, T3, BUILD-PLAN C0.4). C1.7's search and
// A2's retrieval pre-filter with it, so a difference would show or hide items (SRCH-04, PRD-107).
//
// It lives in scripts/ (Node types, pg) so that packages/access keeps a typecheck with no Node
// globals. It builds a throwaway database (access_sql_check) holding one row per item, as aclOf stores it
// (C0.6, C1.7), and checks:
// - edge rows (empty tokens, an empty clause, ragged clauses) against allows() for several key sets;
// - the fixture org, plus items whose readers need several clauses (the fixture's own all
//   normalise to one, so acl_more would otherwise go untested): for every person (those who have
//   left included), both assistants and the system principal, the rows, the count and every page
//   SQL returns equal filterReadable;
// - after membership, team-membership and role changes only: the rows stored before the changes,
//   queried with each subject's new keys, equal filterReadable on the changed world, so a
//   membership change needs no re-ACL (lists.ts; review finding 12).
// Agents read by scope, not by keys (can.ts), so A2's retrieval layer owns their SQL; they aren't
// checked here.
//
//   node scripts/check-access-sql.ts
//
// Connects with the PG* variables as a superuser (default: the local stack) and refuses any host
// but this machine. Exits 1 if any check fails.

import {
  aclOf,
  allows,
  type Facts,
  filterReadable,
  keysOf,
  type Ref,
  type Subject,
  type Token,
  World,
} from '@hearth/access'
import { sqlReadableBy } from '@hearth/access/sql'
import { ALL_REFS, AS, assistant, C, CV, FI, fixtureFacts, human, M, P, R, system, T } from '@hearth/access/testing'
import { type ColumnType, Kysely, PostgresDialect, sql } from 'kysely'
import { Client, Pool } from 'pg'

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const DB = 'access_sql_check'
const PAGE = 7
const host = process.env.PGHOST ?? '127.0.0.1'
const connection = {
  host,
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'postgres',
}

interface AclTable {
  kind: string
  id: string
  acl_tokens: string[]
  acl_more: ColumnType<unknown, string | undefined, string>
}
interface Database {
  rows: AclTable
  edge_rows: AclTable
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Items whose readers need several clauses: derived items whose sources are read by different
// sets (Rule 3), and a doc in the Trash whose trasher reads it only through a team grant (DRV-01).
const EXTRA_DERIVED = [
  { id: 'dv-check-leadership-q3', sources: [ref('message', M.leadership), ref('file', FI.q3Numbers)] },
  { id: 'dv-check-leadership-forecast', sources: [ref('message', M.leadership), ref('file', FI.forecast)] },
  { id: 'dv-check-q4-leadership', sources: [ref('message', M.q4Third), ref('message', M.leadership)] },
]
function ref(kind: Ref['kind'], id: string): Ref {
  return { kind, id }
}
function withSeveralClauses(facts: Facts): Facts {
  return {
    ...facts,
    derived: [...facts.derived, ...EXTRA_DERIVED],
    files: facts.files.map(file =>
      file.id === FI.q4Proposal
        ? {
            ...file,
            trashedAt: 1,
            trashedById: P.daniel,
            grants: file.grants.filter(g => g.grantee.id !== P.daniel),
          }
        : file,
    ),
  }
}

// Membership, team-membership and role changes only (no grant, visibility, move or trash change):
// - Ahmad leaves the Q4 group DM after its last message, and Nadia joins it;
// - Farah leaves the floor group DM and rejoins it;
// - Priya leaves private #leadership, and Kelvin joins it;
// - Priya joins private #design-crit (Daniel is in it already), and Wei Ling leaves the private
//   board room;
// - Wei Ling and Daniel are removed from the Q4 team, and Nadia is added;
// - Marcus's Team Admin role for Operations is revoked, and Kelvin becomes Team Admin of People.
function withMembershipChanges(facts: Facts): Facts {
  const close = (id: string, throughSeq: number) => (m: Facts['memberships'][number]) =>
    m.id === id ? { ...m, throughSeq } : m
  const join = (spaceId: string, principalId: string, afterSeq: number) => ({
    id: `mb-check:${spaceId}:${principalId}:${afterSeq}`,
    spaceId,
    principalId,
    afterSeq,
    throughSeq: null,
  })
  const memberships = [
    close(`mb:${CV.q4}:${P.ahmad}:2`, 6),
    close(`mb:${CV.floor}:${P.farah}`, 1),
    close(`mb:${C.leadership}:${P.priya}`, 2),
    close(`mb:${R.board}:${P.weiling}`, 0),
  ].reduce((rows, change) => rows.map(change), [...facts.memberships])
  return {
    ...facts,
    memberships: [
      ...memberships,
      join(CV.q4, P.nadia, 6),
      join(CV.floor, P.farah, 1),
      join(C.leadership, P.kelvin, 2),
      join(C.studio, P.priya, 1),
    ],
    teamMembers: [
      ...facts.teamMembers.map(m =>
        m.teamId === T.q4 && (m.personId === P.weiling || m.personId === P.daniel) ? { ...m, removedAt: 2 } : m,
      ),
      { teamId: T.q4, personId: P.nadia, removedAt: null },
    ],
    roles: [
      ...facts.roles.map(r =>
        r.personId === P.marcus && r.role === 'team_admin' && r.teamId === T.operations ? { ...r, revokedAt: 2 } : r,
      ),
      { personId: P.kelvin, role: 'team_admin', teamId: T.people, revokedAt: null },
    ],
  }
}

const key = (r: { kind: string; id: string }) => `${r.kind}:${r.id}`
// Code-unit order, which is Postgres's "C" collation for these ASCII ids.
const byKey = (a: Ref, b: Ref) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)

function describeSubject(subject: Subject): string {
  const name = Object.entries({ ...P, ...AS }).find(([, id]) => id === subject.id)?.[0] ?? subject.id
  return `${subject.kind} ${name}`
}

function difference(expected: readonly string[], actual: readonly string[]): string {
  const want = new Set(expected)
  const got = new Set(actual)
  const missing = expected.filter(x => !got.has(x))
  const extra = actual.filter(x => !want.has(x))
  return `missing [${missing.join(', ')}], extra [${extra.join(', ')}]`
}

async function readable(db: Kysely<Database>, keys: readonly Token[]): Promise<string[]> {
  const rows = await db.selectFrom('rows').select(['kind', 'id']).where(sqlReadableBy(keys)).execute()
  return rows.map(key).sort()
}

async function total(db: Kysely<Database>, keys: readonly Token[]): Promise<number> {
  const row = await db
    .selectFrom('rows')
    .select(eb => eb.fn.countAll<string>().as('total'))
    .where(sqlReadableBy(keys))
    .executeTakeFirstOrThrow()
  return Number(row.total)
}

// Every page of PAGE rows, in a fixed order, filtered in the same query that pages.
async function pages(db: Kysely<Database>, keys: readonly Token[]): Promise<string[]> {
  const all: string[] = []
  for (let offset = 0; ; offset += PAGE) {
    const rows = await db
      .selectFrom('rows')
      .select(['kind', 'id'])
      .where(sqlReadableBy(keys))
      .orderBy(sql`kind collate "C"`)
      .orderBy(sql`id collate "C"`)
      .limit(PAGE)
      .offset(offset)
      .execute()
    all.push(...rows.map(key))
    if (rows.length < PAGE) return all
  }
}

// Compares SQL with filterReadable for every subject; returns the failures.
async function compare(
  db: Kysely<Database>,
  world: World,
  subjects: readonly Subject[],
  refs: readonly Ref[],
): Promise<string[]> {
  const failures: string[] = []
  for (const subject of subjects) {
    const keys = keysOf(world, subject)
    const expected = filterReadable(world, subject, refs)
    const expectedKeys = expected.map(key).sort()
    const got = await readable(db, keys)
    if (got.join('\n') !== expectedKeys.join('\n')) {
      failures.push(`${describeSubject(subject)}: rows ${difference(expectedKeys, got)}`)
    }
    const count = await total(db, keys)
    if (count !== expected.length)
      failures.push(`${describeSubject(subject)}: count ${count}, expected ${expected.length}`)
    const paged = await pages(db, keys)
    const inOrder = [...expected].sort(byKey).map(key)
    if (paged.join('\n') !== inOrder.join('\n')) failures.push(`${describeSubject(subject)}: pages differ`)
  }
  return failures
}

async function checkEdgeRows(db: Kysely<Database>): Promise<string> {
  const rows: { id: string; acl: Token[][] }[] = [
    { id: 'no-clauses', acl: [] },
    { id: 'empty-first', acl: [[]] },
    { id: 'one', acl: [['a']] },
    { id: 'one-of-two', acl: [['a', 'b']] },
    { id: 'two', acl: [['a'], ['b']] },
    { id: 'empty-second', acl: [['a'], []] },
    { id: 'ragged', acl: [['a', 'b', 'c'], ['d'], ['b', 'e']] },
    { id: 'quoted', acl: [["p:it's"], ['m:"x"', 'e:a,b']] },
  ]
  await db
    .insertInto('edge_rows')
    .values(
      rows.map(({ id, acl: [first = [], ...more] }) => ({
        kind: 'edge',
        id,
        acl_tokens: first,
        acl_more: JSON.stringify(more),
      })),
    )
    .execute()
  const keySets: Token[][] = [[], ['a'], ['b'], ['a', 'b'], ['a', 'd', 'e'], ['b', 'd'], ["p:it's", 'e:a,b'], ['z']]
  const failures: string[] = []
  for (const keys of keySets) {
    const got = (await db.selectFrom('edge_rows').select('id').where(sqlReadableBy(keys)).execute()).map(r => r.id)
    const expected = rows.filter(row => allows(row.acl, new Set(keys))).map(row => row.id)
    if ([...got].sort().join() !== [...expected].sort().join()) {
      failures.push(`keys [${keys.join(', ')}]: ${difference(expected, got)}`)
    }
  }
  if (failures.length > 0) throw new Error(failures.join('; '))
  return `${rows.length} rows x ${keySets.length} key sets agree with allows()`
}

async function main(): Promise<number> {
  if (!LOCAL_HOSTS.has(host)) {
    console.error(`check-access-sql: refusing ${host}: point PG* at the local stack or CI's service`)
    return 2
  }
  const admin = new Client({ ...connection, database: 'postgres' })
  await admin.connect()
  try {
    await admin.query(`drop database if exists ${DB} with (force)`)
    await admin.query(`create database ${DB} template template0`)
  } finally {
    await admin.end()
  }

  let failed = 0
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new Pool({ ...connection, database: DB, max: 2 }) }),
  })
  const run = async (name: string, check: () => Promise<string>) => {
    try {
      console.log(`ok    ${name}: ${await check()}`)
    } catch (error) {
      failed += 1
      console.error(`FAIL  ${name}: ${message(error)}`)
    }
  }
  try {
    for (const table of ['rows', 'edge_rows'] as const) {
      await db.schema
        .createTable(table)
        .addColumn('kind', 'text', c => c.notNull())
        .addColumn('id', 'text', c => c.notNull())
        .addColumn('acl_tokens', sql`text[]`, c => c.notNull())
        .addColumn('acl_more', 'jsonb', c => c.notNull().defaultTo(sql`'[]'::jsonb`))
        .addPrimaryKeyConstraint(`${table}_pkey`, ['kind', 'id'])
        .execute()
    }

    const before = new World(withSeveralClauses(fixtureFacts()))
    const after = new World(withMembershipChanges(withSeveralClauses(fixtureFacts())))
    const refs = [...ALL_REFS(), ...EXTRA_DERIVED.map(d => ref('derived', d.id))]
    const subjects: Subject[] = [
      ...before.facts.people.map(person => human(person.id)),
      assistant(AS.ashton),
      assistant(AS.daniel),
      system,
    ]
    const stored = refs.map(r => ({ ref: r, row: aclOf(before, r) }))
    await db
      .insertInto('rows')
      .values(
        stored.map(({ ref: r, row }) => ({
          kind: r.kind,
          id: r.id,
          acl_tokens: [...row.tokens],
          acl_more: JSON.stringify(row.more),
        })),
      )
      .execute()
    const severalClauses = stored.filter(s => s.row.more.length > 0).length

    await run('edge rows', () => checkEdgeRows(db))

    await run('fixture rows', async () => {
      if (severalClauses === 0) throw new Error('no row has more than one clause, so acl_more went untested')
      const failures = await compare(db, before, subjects, refs)
      if (failures.length > 0) throw new Error(failures.join('; '))
      return `${refs.length} rows (${severalClauses} with several clauses), ${subjects.length} subjects: rows, counts and pages of ${PAGE} equal filterReadable`
    })

    await run('membership changes need no re-ACL', async () => {
      const changed = stored.filter(s => JSON.stringify(aclOf(after, s.ref)) !== JSON.stringify(s.row))
      if (changed.length > 0) throw new Error(`stored rows changed: ${changed.map(s => key(s.ref)).join(', ')}`)
      return `aclOf gives the same row for all ${refs.length} items after the changes`
    })

    await run('stored rows with new keys', async () => {
      const moved = subjects.filter(
        s => filterReadable(before, s, refs).map(key).join('\n') !== filterReadable(after, s, refs).map(key).join('\n'),
      )
      if (moved.length === 0) throw new Error('the changes moved nobody’s access, so the check proves nothing')
      const failures = await compare(db, after, subjects, refs)
      if (failures.length > 0) throw new Error(failures.join('; '))
      return `rows stored before the changes, queried with keys after them, equal filterReadable for ${subjects.length} subjects (${moved.length} of whom gained or lost access)`
    })
  } finally {
    await db.destroy()
    const cleanup = new Client({ ...connection, database: 'postgres' })
    await cleanup.connect()
    await cleanup.query(`drop database if exists ${DB} with (force)`)
    await cleanup.end()
  }
  return failed === 0 ? 0 : 1
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(`check-access-sql: ${message(error)}`)
  return 1
})
