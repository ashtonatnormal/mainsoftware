// The Postgres connection pool. C0.3 adds the helper every query goes through, which sets the
// org and user inside a transaction (CLAUDE.md, Database); until then the pool only answers the
// readiness check.
import { Pool } from 'pg'
import type { Check } from '#src/ready.ts'

export function createPool(databaseUrl: string): Pool {
  // A new connection that can't be made in 2 s fails rather than queueing behind /ready.
  return new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2000, max: 10 })
}

export function postgresCheck(pool: Pool): Check {
  return async () => {
    await pool.query('select 1')
  }
}
