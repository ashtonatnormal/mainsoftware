import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { postgresCheck } from '#src/db/pool.ts'

function pool(rows: unknown[]): Pick<Pool, 'query'> {
  return { query: (async () => ({ rows })) as unknown as Pool['query'] }
}

describe('C0.3 readiness refuses a connection that skips row level security (CLAUDE.md, Database)', () => {
  const signal = new AbortController().signal

  it('passes for a role held to row level security, such as hearth_app', async () => {
    await expect(postgresCheck(pool([{ bypasses_rls: false }]))(signal)).resolves.toBeUndefined()
  })

  it('fails for a superuser, a BYPASSRLS role, the owner or a member of it', async () => {
    await expect(postgresCheck(pool([{ bypasses_rls: true }]))(signal)).rejects.toThrow(/bypasses row level security/)
  })

  it('fails when the role check returns nothing', async () => {
    await expect(postgresCheck(pool([]))(signal)).rejects.toThrow(/bypasses row level security/)
  })
})
