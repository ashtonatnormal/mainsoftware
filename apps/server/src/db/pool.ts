// The Postgres connection pools: the api's and realtime's as hearth_app (DATABASE_URL), and the
// worker's two, control and work, as hearth_worker (WORKER_DATABASE_URL; TECH-SPEC T18). Queries go
// through withOrg() in database.ts, which sets the org and user inside a transaction (CLAUDE.md,
// Database); the readiness checks below are the only queries outside it, and they read only the
// system catalogues.
import { Client, type ClientConfig, Pool } from 'pg'
import type { Logger } from 'pino'
import { JOB_ROLES, type JobRole } from '#src/db/roles.ts'
import { CHECK_TIMEOUT_MS, type Check } from '#src/ready.ts'

export interface PoolOptions {
  // At most this many connections (10 by default).
  max?: number
  // What pg_stat_activity shows for its connections (hearth-api, hearth-worker-control, …), so an
  // operator can see whose transaction holds the outbox's horizon.
  applicationName?: string
  // QUERY_TIMEOUT_MS unless set; the integration tests shorten it.
  queryTimeoutMs?: number
}

// How long the client waits for any one statement: a little more than the 30 s transaction_timeout,
// which Postgres enforces first whenever it can still answer. This bound is for when it can't: a
// connection whose peer has gone silent (a failover, a dropped network path) never hears Postgres's
// error, and without it the call would wait until TCP gives up, about 15 minutes. The client then
// ends itself and closes its socket (BoundedClient below), so the pool opens a fresh connection for
// the next transaction. A statement on its own fails with 'Query read timeout'; inside a
// transaction the caller sees the ROLLBACK's error instead ('Client was closed and is not
// queryable'), which sqlstate.ts counts as a lost connection. That
// doesn't stop the statement on the server, which runs on until its transaction's own timeout ends
// it (database.ts), or until Postgres finds the socket gone. So read-only work that raises its
// transaction past 30 s must keep each statement under 31 s, or the client gives up on it.
export const QUERY_TIMEOUT_MS = 31_000
// TCP keepalive probes start after a connection has been quiet this long, so the OS notices a
// silent peer of an idle connection and the pool drops it. They aren't sent while a statement's
// bytes go unacknowledged, so they don't free a connection with a statement in flight; the
// query_timeout above does.
export const KEEPALIVE_DELAY_MS = 10_000

// pg's message when a statement outlives query_timeout (node_modules/pg/lib/client.js).
const READ_TIMEOUT = 'Query read timeout'

// A pg Client that ends itself when a statement outlives query_timeout (R2RT-1). pg on its own only
// fails the statement's promise: the statement stays the client's active one, every later statement
// queues behind it, and Kysely, which releases a connection with no error, hands the client back to
// the pool, so each later transaction waits behind the dead statement and times out in turn, and the
// pool never opens a connection to a database that has moved. end() marks the client as ending at
// once, so pg-pool drops it when it's released (whether Kysely releases it straight away, after a
// timed-out BEGIN, or after its ROLLBACK), refuses any statement sent to it after, and, with a
// statement in flight, closes the socket, which fails whatever is queued (that ROLLBACK).
export class BoundedClient extends Client {
  constructor(config?: string | ClientConfig) {
    super(config)
    const query = this.query.bind(this) as (...args: unknown[]) => unknown
    // pg's query() takes a callback last or returns a promise; either way a read timeout ends the
    // client before, or as, the caller hears of it.
    this.query = ((...args: unknown[]) => {
      const callback = args.at(-1)
      if (typeof callback === 'function') {
        args[args.length - 1] = (error: unknown, result: unknown) => {
          this.#timedOut(error)
          return callback(error, result)
        }
      }
      const result = query(...args)
      if (result instanceof Promise) void result.catch(error => this.#timedOut(error))
      return result
    }) as Client['query']
  }

  #timedOut(error: unknown): void {
    if (error instanceof Error && error.message === READ_TIMEOUT) void this.end()
  }
}

export function createPool(databaseUrl: string, logger: Logger, options: PoolOptions = {}): Pool {
  // A new connection that can't be made in 2 s fails rather than queueing behind /ready.
  const pool = new Pool({
    Client: BoundedClient,
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2000,
    query_timeout: options.queryTimeoutMs ?? QUERY_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: KEEPALIVE_DELAY_MS,
    max: options.max ?? 10,
    ...(options.applicationName === undefined ? {} : { application_name: options.applicationName }),
  })
  // A connection that breaks (Postgres restarts, a failover, pg_terminate_backend) emits 'error'
  // on its client, and without a listener that would crash the process (main.ts). pg-pool listens
  // only while a client is idle, so every client gets a listener of its own, which also covers the
  // time it's checked out (in a withOrg() transaction, say). The query in flight still rejects: a
  // request in a withOrg() transaction then answers 500 internal (api.ts), the session lookup
  // before it answers 503 unavailable (auth/sessions.ts), and the pool drops the broken client
  // when it comes back.
  pool.on('connect', client => {
    client.on('error', error => logger.warn({ err: error }, 'postgres connection failed'))
  })
  // pg-pool also reports an idle client's failure on the pool, and throws without a listener. The
  // client's own listener has logged it already, and the pool replaces the client on next use.
  pool.on('error', () => {})
  return pool
}

// RLS is the second line of defence (CLAUDE.md, Database), and a superuser, a role with
// BYPASSRLS, the tables' owner or any member of it skips it silently. So readiness also refuses
// a connection made as such a role (a DATABASE_URL left over from before C0.3, say). The api's and
// realtime's login must also be no member of a job role, by any route, so DATABASE_URL can't act
// as the worker (T18).
const APP_ROLE_CHECK = `
  select r.rolsuper or r.rolbypassrls
      or exists (select 1 from pg_class c where c.relowner = r.oid)
      or exists (select 1 from pg_database d where d.datname = current_database() and d.datdba = r.oid)
      or exists (select 1 from pg_roles o where o.rolname = 'hearth_owner' and pg_has_role(r.oid, o.oid, 'member'))
      or exists (select 1 from pg_roles j where j.rolname = any($1::text[]) and pg_has_role(r.oid, j.oid, 'member'))
    as bypasses_rls
  from pg_roles r where r.rolname = current_user`

// The worker's login holds nothing itself and takes job roles by SET, so the question is wider:
// nothing it is, or can become by SET or use by INHERIT, may skip row level security (a superuser,
// BYPASSRLS, hearth_owner, an owner of a table or of the database), and it may not be a member of
// hearth_app, so WORKER_DATABASE_URL can't act as the api, nor of any of Postgres's predefined roles
// (pg_read_all_data, pg_write_all_data and the like, which read or write every table their RLS
// policies let through). And, as 0007 refuses when hearth_worker already exists, every role it is
// a member of must be rds_iam (powerless, which IAM sign-in on RDS needs) or shaped like a job role,
// held by SET and never INHERIT or ADMIN: hearth_queue or a hearth_job_ name, with no power, a
// member of no role and owning nothing, so a job role a later migration adds passes.
const WORKER_ROLE_CHECK = `
  with skips as (
    select o.oid from pg_roles o
    where o.rolsuper or o.rolbypassrls or o.rolname = 'hearth_owner'
       or exists (select 1 from pg_class c where c.relowner = o.oid)
       or exists (select 1 from pg_database d where d.datname = current_database() and d.datdba = o.oid))
  select exists (select 1 from skips s where pg_has_role(r.oid, s.oid, 'usage') or pg_has_role(r.oid, s.oid, 'set'))
      or exists (select 1 from pg_roles a where a.rolname = 'hearth_app' and pg_has_role(r.oid, a.oid, 'member'))
      or exists (select 1 from pg_roles p where p.rolname like 'pg\\_%' and pg_has_role(r.oid, p.oid, 'member'))
      or exists (
        select 1 from pg_auth_members m join pg_roles g on g.oid = m.roleid
        where m.member = r.oid
          and not (g.rolname = 'rds_iam' and not g.rolsuper and not g.rolbypassrls
                   and not exists (select 1 from pg_auth_members x where x.member = g.oid))
          and not ((g.rolname = 'hearth_queue' or g.rolname like 'hearth\\_job\\_%')
                   and not (g.rolcanlogin or g.rolsuper or g.rolbypassrls or g.rolcreaterole or g.rolcreatedb
                            or g.rolreplication)
                   and not exists (select 1 from pg_auth_members x where x.member = g.oid)
                   and not exists (select 1 from pg_shdepend d
                                   where d.refclassid = 'pg_authid'::regclass and d.refobjid = g.oid
                                     and d.deptype = 'o'
                                     and d.dbid in (0, (select o.oid from pg_database o
                                                        where o.datname = current_database())))
                   and not m.inherit_option and not m.admin_option))
    as bypasses_rls
  from pg_roles r where r.rolname = current_user`

// The worker's other check (worker_roles): its login can still take every job role, so a login that
// lost a grant isn't ready, rather than failing in its loops. A role that doesn't exist counts as
// one it can't take (pg_has_role by name would throw).
const WORKER_ROLES_CHECK = `
  select r as role,
         coalesce((select pg_has_role(current_user, o.oid, 'set') from pg_roles o where o.rolname = r), false)
           as can_set
  from unnest($1::text[]) as r`

// pg can't abort a query, so each check gives up by itself when /ready does, and the pool then
// discards its connection instead of leaving it waiting on a database that isn't answering.
function roleCheck(pool: Pick<Pool, 'query'>, text: string, values: unknown[], message: string): Check {
  const query = { text, values, query_timeout: CHECK_TIMEOUT_MS }
  return async () => {
    const result = await pool.query<{ bypasses_rls: boolean }>(query)
    if (result.rows[0]?.bypasses_rls !== false) throw new Error(message)
  }
}

export function appRoleCheck(pool: Pick<Pool, 'query'>): Check {
  return roleCheck(
    pool,
    APP_ROLE_CHECK,
    [JOB_ROLES],
    'DATABASE_URL connects as a role that bypasses row level security or can act as a job role; it must be hearth_app',
  )
}

export function workerRoleCheck(pool: Pick<Pool, 'query'>): Check {
  return roleCheck(
    pool,
    WORKER_ROLE_CHECK,
    [],
    'WORKER_DATABASE_URL connects as a role that can bypass row level security, act as hearth_app or hold a role other than a job role by SET; it must be hearth_worker',
  )
}

export function workerRolesCheck(pool: Pick<Pool, 'query'>, roles: readonly JobRole[] = JOB_ROLES): Check {
  const query = { text: WORKER_ROLES_CHECK, values: [roles], query_timeout: CHECK_TIMEOUT_MS }
  return async () => {
    const result = await pool.query<{ role: string; can_set: boolean }>(query)
    const missing = roles.filter(role => !result.rows.some(row => row.role === role && row.can_set === true))
    if (missing.length > 0) {
      throw new Error(`WORKER_DATABASE_URL connects as a role that can't take ${missing.join(', ')}`)
    }
  }
}
