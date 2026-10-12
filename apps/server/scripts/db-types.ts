// Writes apps/server/src/db/schema.ts, the Kysely types for every table, from the database the
// migrations build (T3: types generated from the database, regenerated after each migration). It
// reads Postgres's catalogue itself rather than using kysely-codegen, whose dependencies fail
// the audit gate (docs/TECH-SPEC.md, T3).
//
//   npm run db:types        after scripts/check-migrations.sh has built the scratch database
//
// Connects with PGHOST, PGPORT, PGUSER and PGPASSWORD (default: the local stack) to the database
// CHECK_DB names (default hearth_check), as scripts/check-migrations.sh does, and refuses any host
// but this machine. CI regenerates the file and fails if it differs from
// the one committed. Tables come in name order and columns in table order, so the output only
// changes when the schema does.
import { writeFile } from 'node:fs/promises'
import { Client } from 'pg'

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const OUT = new URL('../src/db/schema.ts', import.meta.url)
// The migrator's ledger, which Kysely itself reads and writes.
const SKIPPED_TABLES = new Set(['kysely_migration', 'kysely_migration_lock'])

interface Column {
  table_name: string
  column_name: string
  type_name: string
  element_type: string | null
  not_null: boolean
  has_default: boolean
  identity: string
  generated: string
}

// What Kysely's pg driver returns for each Postgres type, and what it accepts.
const TYPES: Record<string, string> = {
  bool: 'boolean',
  bytea: 'Buffer',
  date: 'Timestamp',
  float4: 'number',
  float8: 'number',
  inet: 'string',
  int2: 'number',
  int4: 'number',
  int8: 'Int8',
  json: 'Json',
  jsonb: 'Json',
  numeric: 'Numeric',
  text: 'string',
  time: 'string',
  timestamp: 'Timestamp',
  timestamptz: 'Timestamp',
  uuid: 'string',
  varchar: 'string',
}

function pascal(name: string): string {
  return name.replace(/(^|_)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase())
}

// A check of the form `column = ANY (ARRAY['a'::text, 'b'::text])` (what `column in ('a', 'b')`
// becomes) gives that column a union of its values.
function checkUnions(definitions: Array<{ table_name: string; definition: string }>): Map<string, string[]> {
  const unions = new Map<string, string[]>()
  for (const { table_name, definition } of definitions) {
    const match = /^CHECK \(\((\w+) = ANY \(ARRAY\[(.+)\]\)\)\)$/.exec(definition)
    if (!match?.[1] || !match[2]) continue
    const values = [...match[2].matchAll(/'((?:[^']|'')*)'::text/g)].map(m => (m[1] ?? '').replaceAll("''", "'"))
    if (values.length > 0) unions.set(`${table_name}.${match[1]}`, values)
  }
  return unions
}

function columnType(column: Column, unions: Map<string, string[]>): string {
  const union = unions.get(`${column.table_name}.${column.column_name}`)
  let type: string | undefined
  if (union) {
    type = union.map(value => `'${value.replaceAll("'", "\\'")}'`).join(' | ')
  } else if (column.element_type) {
    const element = TYPES[column.element_type]
    type = element && `${element.includes('<') || element.includes('|') ? `(${element})` : element}[]`
  } else {
    type = TYPES[column.type_name]
  }
  if (!type) {
    throw new Error(
      `${column.table_name}.${column.column_name}: no TypeScript type for ${column.type_name}; add it to TYPES`,
    )
  }
  if (!column.not_null) type = `${type} | null`
  // Generated always (identity or computed): never inserted or updated. A default or a
  // by-default identity: optional on insert.
  if (column.identity === 'a' || column.generated === 's') return `GeneratedAlways<${type}>`
  if (column.has_default || column.identity === 'd') return `Generated<${type}>`
  return type
}

async function main(): Promise<void> {
  const host = process.env.PGHOST ?? '127.0.0.1'
  if (!LOCAL_HOSTS.has(host)) throw new Error(`refusing to read the schema from ${host}: point PG* at the local stack`)
  const client = new Client({
    host,
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? 'postgres',
    database: process.env.CHECK_DB ?? 'hearth_check',
  })
  await client.connect()
  try {
    const columns = await client.query<Column>(`
      select c.relname as table_name, a.attname as column_name, t.typname as type_name,
             e.typname as element_type, a.attnotnull as not_null, a.atthasdef as has_default,
             a.attidentity as identity, a.attgenerated as generated
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      join pg_type t on t.oid = a.atttypid
      left join pg_type e on e.oid = t.typelem and t.typcategory = 'A'
      where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
      order by c.relname, a.attnum`)
    const checks = await client.query<{ table_name: string; definition: string }>(`
      select c.relname as table_name, pg_get_constraintdef(k.oid) as definition
      from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and k.contype = 'c'
      order by c.relname, k.conname`)
    const unions = checkUnions(checks.rows)

    const tables = new Map<string, string[]>()
    for (const column of columns.rows) {
      if (SKIPPED_TABLES.has(column.table_name)) continue
      const lines = tables.get(column.table_name) ?? []
      lines.push(`  ${column.column_name}: ${columnType(column, unions)}`)
      tables.set(column.table_name, lines)
    }

    const out = [
      '// The database schema as Kysely types. Generated by apps/server/scripts/db-types.ts from the',
      "// database db/migrations/ builds: don't edit it, run `npm run db:types` after a migration.",
      "import type { ColumnType, Generated, GeneratedAlways } from 'kysely'",
      '',
      '// Postgres bigint arrives as a string (it can exceed a JavaScript number).',
      'export type Int8 = ColumnType<string, bigint | number | string, bigint | number | string>',
      'export type Numeric = ColumnType<string, number | string, number | string>',
      'export type Timestamp = ColumnType<Date, Date | string, Date | string>',
      'export type Json = JsonValue',
      'export type JsonValue = JsonArray | JsonObject | JsonPrimitive',
      'export type JsonArray = JsonValue[]',
      'export type JsonObject = { [key: string]: JsonValue | undefined }',
      'export type JsonPrimitive = boolean | number | string | null',
      '',
    ]
    for (const [table, lines] of tables) {
      out.push(`export interface ${pascal(table)} {`, ...lines, '}', '')
    }
    out.push('export interface DB {', ...[...tables.keys()].map(table => `  ${table}: ${pascal(table)}`), '}', '')
    await writeFile(OUT, out.join('\n'))
    console.log(`db:types: wrote ${tables.size} tables to apps/server/src/db/schema.ts`)
  } finally {
    await client.end()
  }
}

await main()
