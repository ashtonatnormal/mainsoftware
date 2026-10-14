import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { appRoleCheck, createPool, workerRoleCheck, workerRolesCheck } from '#src/db/pool.ts'
import { JOB_ROLES } from '#src/db/roles.ts'
import { createLogger } from '#src/logger.ts'

// A pool that answers every query with `rows` and keeps what it was sent.
function pool(rows: unknown[], sent: { text: string; values: unknown[] }[] = []): Pick<Pool, 'query'> {
  return {
    query: (async (query: { text: string; values: unknown[] }) => {
      sent.push(query)
      return { rows }
    }) as unknown as Pool['query'],
  }
}

describe('C0.3 readiness refuses a connection that skips row level security (CLAUDE.md, Database)', () => {
  const signal = new AbortController().signal

  it('passes for a role held to row level security, such as hearth_app', async () => {
    await expect(appRoleCheck(pool([{ bypasses_rls: false }]))(signal)).resolves.toBeUndefined()
  })

  it('fails for a superuser, a BYPASSRLS role, the owner or a member of it', async () => {
    await expect(appRoleCheck(pool([{ bypasses_rls: true }]))(signal)).rejects.toThrow(/bypasses row level security/)
  })

  it('fails when the role check returns nothing', async () => {
    await expect(appRoleCheck(pool([]))(signal)).rejects.toThrow(/bypasses row level security/)
  })

  it('C0.6 T18: also asks whether the login is a member of any job role, so DATABASE_URL never acts as the worker', async () => {
    const sent: { text: string; values: unknown[] }[] = []
    await appRoleCheck(pool([{ bypasses_rls: false }], sent))(signal)
    expect(sent[0]?.values).toEqual([JOB_ROLES])
    expect(sent[0]?.text).toMatch(/rolname = any\(\$1::text\[\]\) and pg_has_role\(r\.oid, j\.oid, 'member'\)/)
  })
})

describe('C0.6 T18 the worker’s readiness: its login skips no row level security and can take every job role', () => {
  const signal = new AbortController().signal

  it('passes for a login that can become nothing that skips RLS and is no member of hearth_app', async () => {
    await expect(workerRoleCheck(pool([{ bypasses_rls: false }]))(signal)).resolves.toBeUndefined()
    for (const rows of [[{ bypasses_rls: true }], []]) {
      await expect(workerRoleCheck(pool(rows))(signal)).rejects.toThrow(/WORKER_DATABASE_URL .*hearth_worker/)
    }
  })

  it('asks about every role it can use by SET or INHERIT, not only itself', async () => {
    const sent: { text: string; values: unknown[] }[] = []
    await workerRoleCheck(pool([{ bypasses_rls: false }], sent))(signal)
    expect(sent[0]?.text).toContain("pg_has_role(r.oid, s.oid, 'usage') or pg_has_role(r.oid, s.oid, 'set')")
    expect(sent[0]?.text).toContain("a.rolname = 'hearth_app' and pg_has_role(r.oid, a.oid, 'member')")
  })

  it('SQL-3: refuses a login that belongs to any of Postgres’s predefined roles (pg_write_all_data and the like)', async () => {
    const sent: { text: string; values: unknown[] }[] = []
    await workerRoleCheck(pool([{ bypasses_rls: false }], sent))(signal)
    expect(sent[0]?.text).toContain("p.rolname like 'pg\\_%' and pg_has_role(r.oid, p.oid, 'member')")
  })

  it('names each job role the login can no longer take', async () => {
    const all = JOB_ROLES.map(role => ({ role, can_set: true }))
    await expect(workerRolesCheck(pool(all))(signal)).resolves.toBeUndefined()
    const lost = all.map(row => (row.role === 'hearth_job_purge' ? { ...row, can_set: false } : row))
    await expect(workerRolesCheck(pool(lost))(signal)).rejects.toThrow(/can't take hearth_job_purge$/)
    await expect(workerRolesCheck(pool(all.slice(1)))(signal)).rejects.toThrow(/can't take hearth_queue$/)
    const sent: { text: string; values: unknown[] }[] = []
    await workerRolesCheck(pool(all, sent), ['hearth_queue'])(signal)
    expect(sent[0]?.values).toEqual([['hearth_queue']])
  })
})

describe('C0.6 T18 item 8 pools', () => {
  it('take a size and the name pg_stat_activity shows', async () => {
    const logger = createLogger({ logLevel: 'silent', role: 'worker' })
    const named = createPool('postgres://nobody@127.0.0.1:1/none', logger, {
      max: 3,
      applicationName: 'hearth-worker-work',
    })
    const plain = createPool('postgres://nobody@127.0.0.1:1/none', logger)
    try {
      expect(named.options).toMatchObject({
        max: 3,
        application_name: 'hearth-worker-work',
        connectionTimeoutMillis: 2000,
      })
      expect(plain.options.max).toBe(10)
      expect(plain.options).not.toHaveProperty('application_name')
    } finally {
      await Promise.all([named.end(), plain.end()])
    }
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
