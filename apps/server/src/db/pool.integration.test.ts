// The pool's statement bound against a peer that goes silent (R2RT-1, TECH-SPEC T18 item 7): a
// connection whose statement outlives query_timeout is closed, never handed back, so the next
// transaction gets a fresh connection. A small TCP proxy in front of the Compose stack's Postgres
// (testing/proxy.ts) stands in for the network: freezing it stops every connection open through it,
// as a failover or a dropped path does, while new connections still get through. `npm run
// test:integration` runs it, with the stack up (`docker compose up -d --wait`).
import { sql } from 'kysely'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase, type Database } from '#src/db/database.ts'
import { createPool } from '#src/db/pool.ts'
import { createLogger } from '#src/logger.ts'
import { startProxy, type TcpProxy } from '#src/testing/proxy.ts'

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const host = process.env.PGHOST ?? '127.0.0.1'
const port = Number(process.env.PGPORT ?? 5432)
const user = process.env.PGUSER ?? 'postgres'
const password = process.env.PGPASSWORD ?? 'postgres'
const QUERY_TIMEOUT_MS = 1000

let proxy: TcpProxy
let pool: Pool
let db: Database

async function backendPid(): Promise<number> {
  return db.transaction().execute(async trx => {
    const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx)
    const pid = rows[0]?.pid
    if (pid === undefined) throw new Error('no backend pid')
    return pid
  })
}

beforeAll(async () => {
  if (!LOCAL_HOSTS.has(host))
    throw new Error(`Refusing to use Postgres on ${host}: this test runs on the local stack only.`)
  proxy = await startProxy({ host, port })
  const url = new URL('postgres://127.0.0.1')
  url.port = String(proxy.port)
  url.username = user
  url.password = password
  url.pathname = '/postgres'
  pool = createPool(url.toString(), createLogger({ logLevel: 'silent', role: 'api' }), {
    max: 1,
    queryTimeoutMs: QUERY_TIMEOUT_MS,
  })
  db = createDatabase(pool)
})

afterAll(async () => {
  await pool?.end()
  await proxy?.close()
})

describe('R2RT-1 T18 item 7 a statement that outlives query_timeout gives up its connection', () => {
  it('the next transaction gets a fresh connection and succeeds, rather than queueing behind the dead statement', async () => {
    const before = await backendPid()
    expect(pool.totalCount).toBe(1)
    proxy.freeze()
    const opened = proxy.opened()
    await expect(backendPid()).rejects.toThrow()
    // The pool (max 1) holds no dead client: the next transaction opens a new connection through
    // the proxy, which forwards new connections, and runs at once.
    const after = await backendPid()
    expect(after).not.toBe(before)
    expect(proxy.opened()).toBe(opened + 1)
    expect(pool.totalCount).toBe(1)
    // And again, on the same fresh connection.
    expect(await backendPid()).toBe(after)
  })

  it('a statement inside the transaction that times out fails its ROLLBACK at once, and the next transaction is fresh', async () => {
    const before = await backendPid()
    const started = Date.now()
    await expect(
      db.transaction().execute(async trx => {
        proxy.freeze()
        await sql`select 1`.execute(trx)
      }),
    ).rejects.toThrow()
    // Kysely's ROLLBACK, queued behind the dead statement, didn't wait out a bound of its own.
    expect(Date.now() - started).toBeLessThan(QUERY_TIMEOUT_MS * 1.8)
    expect(await backendPid()).not.toBe(before)
    expect(pool.totalCount).toBe(1)
  })
})
