// The server's way into Postgres (CLAUDE.md, Database). Every query runs inside withOrg(), except
// the two sign-in lookups that run before the org is known (pre-org.ts), the worker's org list
// (listOrgs() below), and the readiness checks (pool.ts). withOrg() opens a transaction, sets the
// org and the acting principal for it, runs the work, and commits or rolls back before the
// connection goes back to the pool:
//
//   BEGIN; select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true),
//                 set_config('lock_timeout', '2s', true), set_config('transaction_timeout', '30s', true);
//   …; COMMIT
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
// so do the realtime re-check, the worker's jobs and the offboarding handlers (C0.5, C0.6).
//
// The worker logs in as hearth_worker, which can read nothing itself, and takes one job role for
// each transaction ({ orgId, system: true, as: 'hearth_queue' }; TECH-SPEC T18): set_config('role',
// …, true) in the first statement, the transaction-local SET LOCAL ROLE, so the role ends with the
// transaction and the pooled connection is hearth_worker again. withOrg() and listOrgs() are the
// only code that sets a role (scripts/guards/db-entry.test.ts).
//
// A row lock is waited for at most 2 s (lock_timeout): one long transaction on a person's row
// can't then hold that person's requests and fill the pool. Postgres answers 55P03, which the api
// turns into 409 try_again (auth/errors.ts). A job that must wait longer sets its own
// `set local lock_timeout` first.
//
// Every transaction lasts at most 30 s (transaction_timeout). Postgres then ends the session
// (25P04, FATAL), so the caller sees a lost connection, with no SQLSTATE. Any transaction holding an xid holds every outbox consumer back (T16 item 2), so none
// may run long. Only read-only work, which takes no xid, may ask for up to 5 minutes, still in
// statements of at most 31 s each (the pool's query_timeout, pool.ts). It is set per transaction,
// not on the connection, because a timer already running can't then be raised.
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely'
import type { Pool } from 'pg'
import { isJobRole, type JobRole } from '#src/db/roles.ts'
import type { DB } from '#src/db/schema.ts'

export type Database = Kysely<DB>
export type InOrg = Transaction<DB>

// Who a transaction acts for: the org, and the principal acting, whose id SECURITY DEFINER
// functions read from app.user_id. A person (or an agent) by id, or Hearth's own system
// principal for the org, which in the worker also takes a job role (only the worker's login can).
export type Acting = { orgId: string; userId: string } | { orgId: string; system: true; as?: JobRole }

export interface TransactionOptions {
  // `start transaction … read only`: a job's reads and the flag poll.
  readOnly?: boolean
  // How long the transaction may last, as '<n>ms', '<n>s' or '<n>min'. TRANSACTION_TIMEOUT unless
  // set; at most 5 minutes, and more than 30 s only for read-only work.
  transactionTimeout?: string
}

// How long a request's transaction waits for a row lock (pre-org.ts uses it too).
export const LOCK_TIMEOUT = '2s'
// How long any transaction the server opens may last (pre-org.ts uses it too; T18 item 7).
export const TRANSACTION_TIMEOUT = '30s'
const TRANSACTION_TIMEOUT_MS = 30_000
const READ_ONLY_TIMEOUT_MAX_MS = 5 * 60_000

// The timeout in milliseconds, or undefined if it isn't written as Postgres and this file expect.
function timeoutMs(value: string): number | undefined {
  const match = /^([1-9][0-9]{0,6})(ms|s|min)$/.exec(value)
  if (!match) return undefined
  return Number(match[1]) * { ms: 1, s: 1000, min: 60_000 }[match[2] as 'ms' | 's' | 'min']
}

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

export async function withOrg<T>(
  db: Database,
  acting: Acting,
  work: (trx: InOrg) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  // A malformed id would make every policy's ::uuid cast fail; refuse it before taking a
  // connection, and the same for a role or a timeout this file doesn't know.
  if (!UUID.test(acting.orgId)) throw new Error('withOrg: orgId is not a lower-case UUID')
  if ('userId' in acting && !UUID.test(acting.userId)) throw new Error('withOrg: userId is not a lower-case UUID')
  const role = 'system' in acting ? acting.as : undefined
  if (role !== undefined && !isJobRole(role)) throw new Error('withOrg: as is not a job role')
  const timeout = options.transactionTimeout ?? TRANSACTION_TIMEOUT
  const ms = timeoutMs(timeout)
  if (ms === undefined) throw new Error("withOrg: transactionTimeout must be written as '<n>ms', '<n>s' or '<n>min'")
  if (ms > READ_ONLY_TIMEOUT_MAX_MS) throw new Error('withOrg: transactionTimeout is at most 5 minutes')
  // A transaction that can write takes an xid, which holds every outbox consumer back while it
  // runs, so only read-only work may run past 30 s.
  if (ms > TRANSACTION_TIMEOUT_MS && options.readOnly !== true) {
    throw new Error('withOrg: only a read-only transaction may last more than 30 s')
  }
  let transaction = db.transaction().setIsolationLevel('read committed')
  if (options.readOnly === true) transaction = transaction.setAccessMode('read only')
  return transaction.execute(async trx => {
    if ('userId' in acting) {
      await sql`select set_config('app.org_id', ${acting.orgId}, true), set_config('app.user_id', ${acting.userId}, true), set_config('lock_timeout', ${sql.lit(LOCK_TIMEOUT)}, true), set_config('transaction_timeout', ${sql.lit(timeout)}, true)`.execute(
        trx,
      )
    } else {
      if (role === undefined) {
        await sql`select set_config('app.org_id', ${acting.orgId}, true), set_config('lock_timeout', ${sql.lit(LOCK_TIMEOUT)}, true), set_config('transaction_timeout', ${sql.lit(timeout)}, true)`.execute(
          trx,
        )
      } else {
        // The role first, so everything after it, the principal lookup included, runs as the job
        // role and under its grants.
        await sql`select set_config('role', ${role}, true), set_config('app.org_id', ${acting.orgId}, true), set_config('lock_timeout', ${sql.lit(LOCK_TIMEOUT)}, true), set_config('transaction_timeout', ${sql.lit(timeout)}, true)`.execute(
          trx,
        )
      }
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

// The worker's org list (TECH-SPEC T18 item 2): the id of every org, from worker_org_ids(), which
// only hearth_queue may call, in a short read-only transaction of its own as that role. It is the
// one read across orgs besides the sign-in lookups; everything the worker does with an id runs in
// withOrg() for that org, under row level security. Only the worker's login can take the role.
export async function listOrgs(db: Database): Promise<string[]> {
  return db
    .transaction()
    .setIsolationLevel('read committed')
    .setAccessMode('read only')
    .execute(async trx => {
      await sql`select set_config('role', 'hearth_queue', true), set_config('transaction_timeout', ${sql.lit(TRANSACTION_TIMEOUT)}, true)`.execute(
        trx,
      )
      const { rows } = await sql<{ id: string }>`select id from public.worker_org_ids() as id`.execute(trx)
      return rows.map(row => row.id)
    })
}
