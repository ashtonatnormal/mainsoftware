// The server's way into Postgres (CLAUDE.md, Database). Every query runs inside withOrg(), except
// the two sign-in lookups that run before the org is known (pre-org.ts), and the readiness check.
// withOrg() opens a transaction, sets the org and the acting principal for it, runs the work, and
// commits or rolls back before the connection goes back to the pool:
//
//   BEGIN; select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true),
//                 set_config('lock_timeout', '2s', true); …; COMMIT
//
// Row level security reads app.org_id, so a query outside withOrg() sees and writes nothing, and
// the settings end with the transaction, so a pooled connection never carries one request's org
// into the next. Both ids come from the server-side session (C0.5), or for a job or a WebSocket
// handler from its own org and principal, never from the request. The transaction is READ
// COMMITTED whatever the database default, which tree changes need (the reporting-line trigger
// refuses any other level).
//
// Acting as the system principal ({ orgId, system: true }) reads the org's `hearth` principal in
// the same transaction, after the org is set, and acts as it. The sign-in steps before a session
// exists use it, because the person hasn't proved anything yet and app.user_id mustn't name them;
// so do the realtime re-check and the offboarding handlers (C0.5).
//
// A row lock is waited for at most 2 s (lock_timeout): one long transaction on a person's row
// can't then hold that person's requests and fill the pool. Postgres answers 55P03, which the api
// turns into 409 try_again (auth/errors.ts). A job that must wait longer sets its own
// `set local lock_timeout` first.
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely'
import type { Pool } from 'pg'
import type { DB } from '#src/db/schema.ts'

export type Database = Kysely<DB>
export type InOrg = Transaction<DB>

// Who a transaction acts for: the org, and the principal acting, whose id SECURITY DEFINER
// functions read from app.user_id. A person (or an agent) by id, or Hearth's own system
// principal for the org.
export type Acting = { orgId: string; userId: string } | { orgId: string; system: true }

// How long a request's transaction waits for a row lock (pre-org.ts uses it too).
export const LOCK_TIMEOUT = '2s'

export class NoSystemPrincipal extends Error {
  override name = 'NoSystemPrincipal'
  constructor() {
    super("withOrg: the org has no 'hearth' system principal")
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function createDatabase(pool: Pool): Database {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) })
}

export async function withOrg<T>(db: Database, acting: Acting, work: (trx: InOrg) => Promise<T>): Promise<T> {
  // A malformed id would make every policy's ::uuid cast fail; refuse it before taking a
  // connection.
  if (!UUID.test(acting.orgId)) throw new Error('withOrg: orgId is not a lower-case UUID')
  if ('userId' in acting && !UUID.test(acting.userId)) throw new Error('withOrg: userId is not a lower-case UUID')
  return db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async trx => {
      if ('userId' in acting) {
        await sql`select set_config('app.org_id', ${acting.orgId}, true), set_config('app.user_id', ${acting.userId}, true), set_config('lock_timeout', ${sql.lit(LOCK_TIMEOUT)}, true)`.execute(
          trx,
        )
      } else {
        await sql`select set_config('app.org_id', ${acting.orgId}, true), set_config('lock_timeout', ${sql.lit(LOCK_TIMEOUT)}, true)`.execute(
          trx,
        )
        // RLS lets this read only the org just set.
        const { rows } = await sql<{
          id: string
        }>`select id from principals where org_id = ${acting.orgId} and kind = 'system' and system_key = 'hearth'`.execute(
          trx,
        )
        const system = rows[0]?.id
        if (rows.length !== 1 || system === undefined) throw new NoSystemPrincipal()
        await sql`select set_config('app.user_id', ${system}, true)`.execute(trx)
      }
      return work(trx)
    })
}
