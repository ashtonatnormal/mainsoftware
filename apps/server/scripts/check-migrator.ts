// Checks the migrator (apps/server/src/db/migrations.ts, T3) against a real Postgres: each case
// writes a few migration files to a temporary folder, builds a throwaway database owned by
// hearth_owner (migrator_<case>_check), runs migrate() on it and checks what happened. CI's
// migrations job runs it after scripts/check-migrations.sh, which creates hearth_owner.
//
//   node apps/server/scripts/check-migrator.ts
//
// Connects with the PG* variables as a superuser (default: the local stack) and refuses any host
// but this machine. Exits 1 if any case fails.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client } from 'pg'
import { type MigrateOptions, migrate, TransactionEndedError } from '#src/db/migrations.ts'

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const host = process.env.PGHOST ?? '127.0.0.1'
const connection = {
  host,
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'postgres',
}

async function admin<T>(database: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ ...connection, database })
  await client.connect()
  try {
    return await work(client)
  } finally {
    await client.end()
  }
}

// A throwaway database and a folder of migration files, given as name → SQL.
async function setUp(name: string, files: Record<string, string>): Promise<{ db: string; dir: URL; path: string }> {
  const db = `migrator_${name}_check`
  await admin('postgres', async client => {
    await client.query(`drop database if exists ${db} with (force)`)
    await client.query(`create database ${db} owner hearth_owner template template0`)
  })
  const path = await mkdtemp(join(tmpdir(), 'hearth-migrator-'))
  for (const [file, text] of Object.entries(files)) await writeFile(join(path, file), text)
  return { db, dir: pathToFileURL(`${path}/`), path }
}

async function tearDown(db: string, path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
  await admin('postgres', client => client.query(`drop database if exists ${db} with (force)`))
}

function run(db: string, dir: URL, extra: Partial<MigrateOptions> = {}) {
  const url = new URL(`postgres://${connection.host.includes(':') ? `[${connection.host}]` : connection.host}`)
  url.port = String(connection.port)
  url.username = connection.user
  url.password = connection.password
  url.pathname = `/${db}`
  return migrate({ databaseUrl: url.toString(), role: 'hearth_owner', dir, ...extra })
}

async function tables(db: string): Promise<string[]> {
  return admin(db, async client => {
    const result = await client.query<{ name: string; owner: string }>(
      `select c.relname as name, pg_get_userbyid(c.relowner) as owner from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and c.relname not like 'kysely%' order by 1`,
    )
    return result.rows.map(row => `${row.name} (${row.owner})`)
  })
}

async function ledger(db: string): Promise<string[]> {
  return admin(db, async client => {
    const result = await client.query<{ name: string }>('select name from public.kysely_migration order by name')
    return result.rows.map(row => row.name)
  })
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function expect(ok: boolean, what: string): void {
  if (!ok) throw new Error(what)
}

const CASES: Array<[string, () => Promise<void>]> = [
  [
    'a batch applies in order and records each file',
    async () => {
      const { db, dir, path } = await setUp('ok', {
        '0002_b.sql': 'create table public.b (org_id uuid);',
        '0001_a.sql': 'create table public.a (org_id uuid);',
      })
      try {
        const { error, results = [] } = await run(db, dir)
        expect(error === undefined, `failed: ${message(error)}`)
        expect(results.map(r => r.migrationName).join() === '0001_a,0002_b', 'wrong order')
        expect((await ledger(db)).join() === '0001_a,0002_b', 'ledger wrong')
        expect((await tables(db)).join() === 'a (hearth_owner),b (hearth_owner)', 'tables not owned by hearth_owner')
      } finally {
        await tearDown(db, path)
      }
    },
  ],
  [
    'a failing migration rolls the whole batch back',
    async () => {
      const { db, dir, path } = await setUp('fail', {
        '0001_a.sql': 'create table public.a (org_id uuid);',
        '0002_b.sql': '-- one\n-- two\nselec 1;\n',
      })
      try {
        const { error } = await run(db, dir)
        expect(message(error).startsWith('0002_b.sql, line 3: syntax error'), `wrong error: ${message(error)}`)
        expect((await tables(db)).length === 0, 'the first migration was kept')
        expect((await ledger(db)).length === 0, 'the ledger records a rolled-back migration')
      } finally {
        await tearDown(db, path)
      }
    },
  ],
  [
    'a migration that commits is refused, naming it',
    async () => {
      const { db, dir, path } = await setUp('commit', {
        '0001_a.sql': 'create table public.a (org_id uuid); commit; create table public.b (org_id uuid);',
      })
      try {
        const { error } = await run(db, dir)
        expect(
          error instanceof TransactionEndedError && message(error).startsWith('0001_a.sql ended its own transaction'),
          `wrong error: ${message(error)}`,
        )
      } finally {
        await tearDown(db, path)
      }
    },
  ],
  [
    'a migration that rolls back is refused',
    async () => {
      const { db, dir, path } = await setUp('rollback', { '0001_a.sql': 'rollback;' })
      try {
        const { error } = await run(db, dir)
        expect(error instanceof TransactionEndedError, `wrong error: ${message(error)}`)
      } finally {
        await tearDown(db, path)
      }
    },
  ],
  [
    "a migration that sets its own time zone or date style isn't mistaken for a commit",
    async () => {
      const { db, dir, path } = await setUp('settings', {
        '0001_a.sql':
          "set local time zone 'Pacific/Kiritimati'; set local datestyle = 'German'; create table public.a (org_id uuid);",
      })
      try {
        const { error } = await run(db, dir)
        expect(error === undefined, `failed: ${message(error)}`)
      } finally {
        await tearDown(db, path)
      }
    },
  ],
  [
    'RESET ROLE goes back to hearth_owner; a migration left as another role is refused',
    async () => {
      const { db, dir, path } = await setUp('role', {
        '0001_a.sql': 'reset role; create table public.a (org_id uuid);',
      })
      try {
        const reset = await run(db, dir)
        expect(reset.error === undefined, `reset role failed: ${message(reset.error)}`)
        expect((await tables(db)).join() === 'a (hearth_owner)', 'reset role ran as another role')
        await writeFile(join(path, '0002_b.sql'), `set role ${connection.user};`)
        const left = await run(db, dir)
        expect(
          message(left.error).startsWith(`0002_b.sql left the session as ${connection.user}`),
          `wrong error: ${message(left.error)}`,
        )
      } finally {
        await tearDown(db, path)
      }
    },
  ],
  [
    "a role the login can't take fails at once, rather than hang",
    async () => {
      const { db, dir, path } = await setUp('badrole', { '0001_a.sql': 'select 1;' })
      try {
        const outcome = await Promise.race([
          run(db, dir, { role: 'no_such_role' }),
          new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 10_000).unref()),
        ])
        expect(outcome !== 'hung', 'migrate hung for 10 s')
        expect(
          outcome !== 'hung' && /no_such_role/.test(message(outcome.error)),
          `wrong error: ${message(outcome !== 'hung' && outcome.error)}`,
        )
      } finally {
        await tearDown(db, path)
      }
    },
  ],
  [
    '--before stops below the number, and refuses a database already past it',
    async () => {
      const { db, dir, path } = await setUp('before', {
        '0001_a.sql': 'create table public.a (org_id uuid);',
        '0002_b.sql': 'create table public.b (org_id uuid);',
        '0003_c.sql': 'create table public.c (org_id uuid);',
      })
      try {
        const first = await run(db, dir, { before: '0003' })
        expect(first.error === undefined, `failed: ${message(first.error)}`)
        expect((await ledger(db)).join() === '0001_a,0002_b', 'did not stop before 0003')
        const again = await run(db, dir, { before: '0002' })
        expect(/0002_b is already applied/.test(message(again.error)), `wrong error: ${message(again.error)}`)
        const missing = await run(db, dir, { before: '0009' })
        expect(/No migration numbered 0009/.test(message(missing.error)), `wrong error: ${message(missing.error)}`)
      } finally {
        await tearDown(db, path)
      }
    },
  ],
  [
    'a new migration numbered below one already applied is refused',
    async () => {
      const { db, dir, path } = await setUp('order', {
        '0001_a.sql': 'create table public.a (org_id uuid);',
        '0003_c.sql': 'create table public.c (org_id uuid);',
      })
      try {
        const first = await run(db, dir)
        expect(first.error === undefined, `failed: ${message(first.error)}`)
        await writeFile(join(path, '0002_b.sql'), 'create table public.b (org_id uuid);')
        const late = await run(db, dir)
        expect(/corrupted migrations/.test(message(late.error)), `wrong error: ${message(late.error)}`)
        expect(!(await tables(db)).some(t => t.startsWith('b ')), 'the late migration ran')
      } finally {
        await tearDown(db, path)
      }
    },
  ],
]

async function main(): Promise<number> {
  if (!LOCAL_HOSTS.has(host)) {
    console.error(`check-migrator: refusing ${host}: point PG* at the local stack or CI's service`)
    return 2
  }
  let failed = 0
  for (const [name, check] of CASES) {
    try {
      await check()
      console.log(`ok    ${name}`)
    } catch (error) {
      failed += 1
      console.error(`FAIL  ${name}: ${message(error)}`)
    }
  }
  return failed === 0 ? 0 : 1
}

process.exitCode = await main()
