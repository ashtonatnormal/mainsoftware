// The Postgres connection pool, as hearth_app. Queries go through withOrg() in database.ts, which
// sets the org and user inside a transaction (CLAUDE.md, Database); the readiness check below is
// the one query outside it, and it reads no table.
import { Pool } from 'pg'
import type { Logger } from 'pino'
import { CHECK_TIMEOUT_MS, type Check } from '#src/ready.ts'

export function createPool(databaseUrl: string, logger: Logger): Pool {
  // A new connection that can't be made in 2 s fails rather than queueing behind /ready.
  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2000, max: 10 })
  // An idle connection that breaks (Postgres restarts, a failover) is reported here; without a
  // listener the error would crash the process. The pool replaces it on next use.
  pool.on('error', error => logger.warn({ err: error }, 'idle postgres connection failed'))
  return pool
}

export function postgresCheck(pool: Pool): Check {
  // pg can't abort a query, so this one gives up by itself when /ready does, and the pool then
  // discards its connection instead of leaving it waiting on a database that isn't answering.
  const query = { text: 'select 1', query_timeout: CHECK_TIMEOUT_MS }
  return async () => {
    await pool.query(query)
  }
}
