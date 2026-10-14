// The Postgres connection pools: the api's and realtime's as hearth_app (DATABASE_URL), and the
// worker's two, control and work, as hearth_worker (WORKER_DATABASE_URL; TECH-SPEC T18). Queries go
// through withOrg() in database.ts, which sets the org and user inside a transaction (CLAUDE.md,
// Database); the readiness checks below are the only queries outside it, and they read only the
// system catalogues.
import { Pool } from 'pg'
import type { Logger } from 'pino'
import { JOB_ROLES, type JobRole } from '#src/db/roles.ts'
import { CHECK_TIMEOUT_MS, type Check } from '#src/ready.ts'

export interface PoolOptions {
  // At most this many connections (10 by default).
  max?: number
  // What pg_stat_activity shows for its connections (hearth-api, hearth-worker-control, …), so an
  // operator can see whose transaction holds the outbox's horizon.
  applicationName?: string
}

export function createPool(databaseUrl: string, logger: Logger, options: PoolOptions = {}): Pool {
  // A new connection that can't be made in 2 s fails rather than queueing behind /ready.
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2000,
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
// hearth_app, so WORKER_DATABASE_URL can't act as the api.
const WORKER_ROLE_CHECK = `
  with skips as (
    select o.oid from pg_roles o
    where o.rolsuper or o.rolbypassrls or o.rolname = 'hearth_owner'
       or exists (select 1 from pg_class c where c.relowner = o.oid)
       or exists (select 1 from pg_database d where d.datname = current_database() and d.datdba = o.oid))
  select exists (select 1 from skips s where pg_has_role(r.oid, s.oid, 'usage') or pg_has_role(r.oid, s.oid, 'set'))
      or exists (select 1 from pg_roles a where a.rolname = 'hearth_app' and pg_has_role(r.oid, a.oid, 'member'))
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
    'WORKER_DATABASE_URL connects as a role that can bypass row level security or act as hearth_app; it must be hearth_worker',
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
