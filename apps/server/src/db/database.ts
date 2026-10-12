// The server's way into Postgres (CLAUDE.md, Database). Every query runs inside withOrg(), which
// opens a transaction, sets the org and the acting principal for it, runs the work, and commits
// or rolls back before the connection goes back to the pool:
//
//   BEGIN; select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true); …; COMMIT
//
// Row level security reads app.org_id, so a query outside withOrg() sees and writes nothing, and
// the settings end with the transaction, so a pooled connection never carries one request's org
// into the next. Both ids come from the server-side session (C0.5), or for a job or a WebSocket
// handler from its own org and principal, never from the request. The transaction is READ
// COMMITTED whatever the database default, which tree changes need (the reporting-line trigger
// refuses any other level).
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely'
import type { Pool } from 'pg'
import type { DB } from '#src/db/schema.ts'

export type Database = Kysely<DB>
export type InOrg = Transaction<DB>

// Who a transaction acts for: the org, and the principal acting (a person, or for a job Hearth's
// system principal), whose id SECURITY DEFINER functions read from app.user_id.
export interface Acting {
  orgId: string
  userId: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function createDatabase(pool: Pool): Database {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) })
}

export async function withOrg<T>(db: Database, acting: Acting, work: (trx: InOrg) => Promise<T>): Promise<T> {
  // A malformed id would make every policy's ::uuid cast fail; refuse it before taking a
  // connection.
  if (!UUID.test(acting.orgId)) throw new Error('withOrg: orgId is not a lower-case UUID')
  if (!UUID.test(acting.userId)) throw new Error('withOrg: userId is not a lower-case UUID')
  return db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async trx => {
      await sql`select set_config('app.org_id', ${acting.orgId}, true), set_config('app.user_id', ${acting.userId}, true)`.execute(
        trx,
      )
      return work(trx)
    })
}
