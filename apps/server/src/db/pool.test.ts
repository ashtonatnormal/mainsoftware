import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createPool, postgresCheck } from '#src/db/pool.ts'
import { createLogger } from '#src/logger.ts'

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

describe('C0.5 T3 a Postgres connection that breaks never ends the process', () => {
  it('a client that fails while checked out (in a withOrg() transaction) is logged, not thrown', async () => {
    const lines: Record<string, unknown>[] = []
    const stream = new Writable({
      write(chunk, _encoding, done) {
        for (const line of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(line))
        done()
      },
    })
    // Nothing connects until a query, so no Postgres is needed.
    const made = createPool(
      'postgres://nobody@127.0.0.1:1/none',
      createLogger({ logLevel: 'info', role: 'api' }, stream),
    )
    try {
      // A new client, as pg-pool announces it, and then checked out: pg-pool's own listener is
      // off it, so this one is all there is.
      const client = new EventEmitter()
      made.emit('connect', client)
      expect(() => client.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow()
      // An idle client's failure, as pg-pool reports it on the pool.
      expect(() => made.emit('error', new Error('Connection terminated unexpectedly'), client)).not.toThrow()
      expect(lines.map(line => line.msg)).toEqual(['postgres connection failed'])
    } finally {
      await made.end()
    }
  })
})
