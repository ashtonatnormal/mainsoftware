// The schema's migrations (T3, INF-MIGRATE; CLAUDE.md, Database): the plain SQL files in
// db/migrations/, applied by Kysely's migrator. It applies everything not yet applied in name
// order, in one transaction on one connection, and records each in its kysely_migration table;
// a failure rolls the whole batch back. It refuses a new file that sorts before one already
// applied (allowUnorderedMigrations stays false), so two PRs whose migrations merge out of order
// fail here as well as in CI.
//
// Every migration runs as the owner role (hearth_owner), which the connection takes at start-up,
// so a RESET ROLE in a file goes back to it. The provider below checks, around each file, that
// the session is still that role and still in the batch's transaction, so a migration that ends
// the transaction itself (COMMIT, ROLLBACK) or leaves another role in place fails, naming the
// file. A file that switches role and back again is caught only where the login has no rights of
// its own: CI's (scripts/check-migrations.sh) has none, and production's must not either
// (hearth_owner itself, or a NOINHERIT login whose only membership is hearth_owner).
// Kysely 0.29 has no transactionMode setting; one transaction per run is how it always works on
// Postgres. From 0.30, set transactionMode: 'per-run' here explicitly.
import { readdir, readFile } from 'node:fs/promises'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { type Migration, type MigrationProvider, type MigrationResultSet, Migrator } from 'kysely/migration'
import { Pool } from 'pg'

// <NNNN>_<name>.sql, lower case. The four digits order them.
export const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/

// The folder the migrations live in: db/migrations/ at the repo root, which the image copies to
// the same place relative to the server's source.
export const MIGRATIONS_DIR = new URL('../../../../db/migrations/', import.meta.url)

export class MigrationFilesError extends Error {
  override name = 'MigrationFilesError'
}

// A migration ended the batch's transaction itself (COMMIT or ROLLBACK). The statements after it
// in that file ran outside the batch and are committed; after a COMMIT, so is everything before
// it in the run, and after a ROLLBACK, that was undone. The file isn't recorded as applied.
export class TransactionEndedError extends Error {
  override name = 'TransactionEndedError'
}

// Lists db/migrations/ and refuses anything Kysely would skip or apply wrongly: a name that isn't
// <NNNN>_<name>.sql, two files with one number, or anything that isn't a plain file (a folder,
// a link, a hidden file). Returns the names in the order they apply.
export async function migrationFiles(dir: URL): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const problems: string[] = []
  const byNumber = new Map<string, string>()
  const names: string[] = []
  for (const entry of entries) {
    const match = MIGRATION_FILE.exec(entry.name)
    if (!entry.isFile()) {
      problems.push(`${entry.name} is not a plain file (nothing in db/migrations/ but migration files is applied)`)
    } else if (!match) {
      problems.push(`${entry.name} is not named <NNNN>_<name>.sql in lower case`)
    } else {
      const number = match[1] ?? ''
      const other = byNumber.get(number)
      if (other) problems.push(`${entry.name} and ${other} share the number ${number}`)
      byNumber.set(number, entry.name)
      names.push(entry.name)
    }
  }
  if (problems.length > 0) throw new MigrationFilesError(`db/migrations/ has a problem:\n  ${problems.join('\n  ')}`)
  // Plain code-unit order, which is how Kysely sorts them too.
  return names.sort()
}

interface SessionState {
  txn: string
  role: string
}

async function sessionState(db: Kysely<unknown>): Promise<SessionState> {
  // The transaction's start as a number, which a migration's SET TIME ZONE or DateStyle can't
  // change the way it changes a timestamp's text.
  const result =
    await sql<SessionState>`select extract(epoch from transaction_timestamp())::text as txn, current_user::text as role`.execute(
      db,
    )
  const state = result.rows[0]
  if (!state) throw new Error('Postgres returned no row for the session check')
  return state
}

// Where in the file a Postgres error points, as "line N", from the character offset it reports.
function located(error: unknown, file: string, text: string): Error {
  const position = Number((error as { position?: unknown }).position)
  const where =
    Number.isInteger(position) && position > 0 ? `, line ${text.slice(0, position - 1).split('\n').length}` : ''
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`${file}${where}: ${message}`, { cause: error })
}

// Applies one file's SQL as it is. It goes to Postgres in one simple-protocol query (no
// parameters), so a file may hold any number of statements, DO blocks included, and a psql
// meta-command is a syntax error, as it should be.
async function apply(db: Kysely<unknown>, file: string, text: string, role: string): Promise<void> {
  const before = await sessionState(db)
  if (before.role !== role) {
    throw new Error(`${file}: the migration session is ${before.role}, not ${role}`)
  }
  try {
    await sql.raw(text).execute(db)
  } catch (error) {
    throw located(error, file, text)
  }
  const after = await sessionState(db)
  if (after.txn !== before.txn) {
    throw new TransactionEndedError(
      `${file} ended its own transaction (COMMIT or ROLLBACK); migrations run in one transaction`,
    )
  }
  if (after.role !== role) {
    throw new Error(`${file} left the session as ${after.role}; migrations run as ${role} and never change role`)
  }
}

export class SqlFileMigrationProvider implements MigrationProvider {
  readonly #dir: URL
  readonly #role: string

  constructor(dir: URL, role: string) {
    this.#dir = dir
    this.#role = role
  }

  async getMigrations(): Promise<Record<string, Migration>> {
    const migrations: Record<string, Migration> = {}
    for (const file of await migrationFiles(this.#dir)) {
      const text = await readFile(new URL(file, this.#dir), 'utf8')
      migrations[file.slice(0, -'.sql'.length)] = { up: db => apply(db, file, text, this.#role) }
    }
    return migrations
  }
}

export interface MigrateOptions {
  // A connection that may act as the owner role (hearth_owner itself, or a login that is a member
  // of it). Without one, the standard PG* variables say where to connect.
  databaseUrl?: string
  // The role that owns the schema and runs every migration (CLAUDE.md: hearth_owner).
  role: string
  dir?: URL
  // Apply only the migrations numbered below this one (for an upgrade test, UP_TO in
  // scripts/check-migrations.sh). The database must not have applied it or any later one.
  before?: string
}

// The role names this accepts, so one can go into SET ROLE as it is.
export const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/

export async function migrate(options: MigrateOptions): Promise<MigrationResultSet> {
  const { role, before } = options
  const dir = options.dir ?? MIGRATIONS_DIR
  if (!ROLE_NAME.test(role)) throw new Error(`Not a role name: ${role}`)
  // One connection, so the ledger setup, the lock and the batch all run as the owner role in one
  // session. The role and the lock timeout are start-up options, so a login that can't take the
  // role fails to connect, with Postgres's reason, rather than leaving a half-set-up session. A
  // migration waits at most 10 s for a lock, rather than queue the app's queries behind it in
  // production; Kysely raises it for its own lock.
  const pool = new Pool({
    ...(options.databaseUrl === undefined ? {} : { connectionString: options.databaseUrl }),
    max: 1,
    options: `-c role=${role} -c lock_timeout=10s`,
  })
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  try {
    const migrator = new Migrator({
      db,
      provider: new SqlFileMigrationProvider(dir, role),
      migrationTableSchema: 'public',
      allowUnorderedMigrations: false,
    })
    if (before === undefined) return await migrator.migrateToLatest()
    const files = await migrationFiles(dir)
    if (!files.some(file => file.startsWith(`${before}_`))) {
      return { error: new Error(`No migration numbered ${before} in db/migrations/`) }
    }
    const applied = (await migrator.getMigrations()).filter(m => m.executedAt !== undefined)
    const late = applied.find(m => m.name.slice(0, 4) >= before)
    if (late)
      return { error: new Error(`${late.name} is already applied, so this database can't stop before ${before}`) }
    const target = files.filter(file => file.slice(0, 4) < before).at(-1)
    if (target === undefined) return { results: [] }
    return await migrator.migrateTo(target.slice(0, -'.sql'.length))
  } finally {
    await db.destroy()
  }
}
