// The Postgres connection pool, as hearth_app. Queries go through withOrg() in database.ts, which
// sets the org and user inside a transaction (CLAUDE.md, Database); the readiness check below is
// the one query outside it, and it reads no table.
import { Pool } from 'pg'
import type { Logger } from 'pino'
import { CHECK_TIMEOUT_MS, type Check } from '#src/ready.ts'

export function createPool(databaseUrl: string, logger: Logger): Pool {
  // A new connection that can't be made in 2 s fails rather than queueing behind /ready.
  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2000, max: 10 })
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
// a connection made as such a role (a DATABASE_URL left over from before C0.3, say).
const ROLE_CHECK = `
  select r.rolsuper or r.rolbypassrls
      or exists (select 1 from pg_class c where c.relowner = r.oid)
      or exists (select 1 from pg_database d where d.datname = current_database() and d.datdba = r.oid)
      or exists (select 1 from pg_roles o where o.rolname = 'hearth_owner' and pg_has_role(r.oid, o.oid, 'member'))
    as bypasses_rls
  from pg_roles r where r.rolname = current_user`

export function postgresCheck(pool: Pick<Pool, 'query'>): Check {
  // pg can't abort a query, so this one gives up by itself when /ready does, and the pool then
  // discards its connection instead of leaving it waiting on a database that isn't answering.
  const query = { text: ROLE_CHECK, query_timeout: CHECK_TIMEOUT_MS }
  return async () => {
    const result = await pool.query<{ bypasses_rls: boolean }>(query)
    if (result.rows[0]?.bypasses_rls !== false) {
      throw new Error('DATABASE_URL connects as a role that bypasses row level security; it must be hearth_app')
    }
  }
}
