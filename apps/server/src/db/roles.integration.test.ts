// withOrg()'s job roles, read-only transactions and timeouts, listOrgs() and the readiness role
// checks against the Compose stack's Postgres (TECH-SPEC T16 item 2, T18): the statements the unit
// tests pin, run for real as hearth_app and hearth_worker. It builds a throwaway database with
// production's migrator, as the integration harness does, and drops it at the end. `npm run
// test:integration` runs it, with the stack up (`docker compose up -d --wait`).
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { sql } from 'kysely'
import { Client as PgClient, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase, type Database, listOrgs, withOrg } from '#src/db/database.ts'
import { migrate } from '#src/db/migrations.ts'
import { appRoleCheck, createPool, workerRoleCheck, workerRolesCheck } from '#src/db/pool.ts'
import { JOB_ROLES, type JobRole } from '#src/db/roles.ts'
import { createLogger } from '#src/logger.ts'

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const PASSWORD = 'hearth-local'
const host = process.env.PGHOST ?? '127.0.0.1'
const port = Number(process.env.PGPORT ?? 5432)
const superuser = { host, port, user: process.env.PGUSER ?? 'postgres', password: process.env.PGPASSWORD ?? 'postgres' }
const database = `roles_it_${randomBytes(4).toString('hex')}`
const signal = new AbortController().signal

function url(user: string, password: string): string {
  const result = new URL(`postgres://${host.includes(':') ? `[${host}]` : host}`)
  result.port = String(port)
  result.username = user
  result.password = password
  result.pathname = `/${database}`
  return result.toString()
}

const logger = createLogger({ logLevel: 'silent', role: 'worker' })
const orgs = [randomUUID(), randomUUID()]
let admin: PgClient
let appPool: Pool
let workerPool: Pool
let ownerPool: Pool
let app: Database
let worker: Database
let created = false

beforeAll(async () => {
  if (!LOCAL_HOSTS.has(host))
    throw new Error(`Refusing to use Postgres on ${host}: this test runs on the local stack only.`)
  const server = new PgClient({ ...superuser, database: 'postgres' })
  await server.connect()
  try {
    await server.query('set client_min_messages = warning')
    await server.query(
      'do $$ begin create role hearth_owner nologin createrole; exception when duplicate_object then null; end $$',
    )
    await server.query('alter role hearth_owner nosuperuser nobypassrls createrole')
    await server.query(`create database ${database} owner hearth_owner template template0`)
    created = true
  } finally {
    await server.end()
  }
  const { error } = await migrate({ databaseUrl: url(superuser.user, superuser.password), role: 'hearth_owner' })
  if (error) throw error
  admin = new PgClient({ ...superuser, database })
  await admin.connect()
  await admin.query(`alter role hearth_app login password '${PASSWORD}'`)
  await admin.query(`alter role hearth_worker login password '${PASSWORD}'`)
  for (const [i, id] of orgs.entries()) {
    await admin.query('insert into orgs (id, name) values ($1, $2)', [id, `Roles test ${i}`])
    await admin.query("insert into principals (id, org_id, kind, system_key) values ($1, $2, 'system', 'hearth')", [
      randomUUID(),
      id,
    ])
  }
  // One connection each, so every transaction below reuses the connection the last one used.
  appPool = createPool(url('hearth_app', PASSWORD), logger, { max: 1, applicationName: 'hearth-api' })
  workerPool = createPool(url('hearth_worker', PASSWORD), logger, { max: 1, applicationName: 'hearth-worker-control' })
  ownerPool = createPool(url(superuser.user, superuser.password), logger, { max: 1 })
  app = createDatabase(appPool)
  worker = createDatabase(workerPool)
})

afterAll(async () => {
  await Promise.allSettled([appPool?.end(), workerPool?.end(), ownerPool?.end(), admin?.end()])
  if (created) {
    const server = new PgClient({ ...superuser, database: 'postgres' })
    await server.connect()
    await server.query(`drop database if exists ${database} with (force)`)
    await server.end()
  }
})

// The SQLSTATE the work failed with ('none' when it didn't fail, 'no code' for another error).
const sqlstate = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work
    return 'none'
  } catch (error) {
    return (error as { code?: string }).code ?? 'no code'
  }
}

describe('C0.6 T18 one login, a job role per transaction', () => {
  it.each(JOB_ROLES)(
    'the worker acts as %s for the transaction only, and is hearth_worker again after it',
    async role => {
      const [org = ''] = orgs
      const inside = await withOrg(worker, { orgId: org, system: true, as: role }, async trx => {
        const { rows } = await sql<{
          me: string
          app: string
        }>`select current_user as me, current_setting('application_name') as app`.execute(trx)
        return rows[0]
      })
      expect(inside).toEqual({ me: role, app: 'hearth-worker-control' })
      const after = await workerPool.query<{ me: string }>('select current_user as me')
      expect(after.rows[0]?.me).toBe('hearth_worker')
    },
  )

  it('with no role taken, the worker’s login reads nothing, not even its org’s system principal', async () => {
    const [org = ''] = orgs
    expect(await sqlstate(withOrg(worker, { orgId: org, system: true }, async () => {}))).toBe('42501')
  })

  it('hearth_app can take no job role, so the api’s credential never acts as the worker', async () => {
    const [org = ''] = orgs
    for (const role of JOB_ROLES) {
      expect(await sqlstate(withOrg(app, { orgId: org, system: true, as: role }, async () => {})), role).toBe('42501')
    }
  })

  it('T18 item 2: listOrgs gives the worker every org’s id, and refuses the api’s login', async () => {
    expect((await listOrgs(worker)).sort()).toEqual([...orgs].sort())
    expect(await sqlstate(listOrgs(app))).toBe('42501')
    const after = await workerPool.query<{ me: string }>('select current_user as me')
    expect(after.rows[0]?.me).toBe('hearth_worker')
  })
})

describe('C0.6 T16 item 2 T18 item 7: every transaction is bounded, and only read-only work may run longer', () => {
  const timeoutIn = (db: Database, acting: Parameters<typeof withOrg>[1], options?: Parameters<typeof withOrg>[3]) =>
    withOrg(
      db,
      acting,
      async trx =>
        (await sql<{ t: string }>`select current_setting('transaction_timeout') as t`.execute(trx)).rows[0]?.t,
      options,
    )

  it('sets 30 s for a person, the system principal and a job role, and 5 minutes when read-only work asks', async () => {
    const [org = ''] = orgs
    expect(await timeoutIn(app, { orgId: org, system: true })).toBe('30s')
    expect(await timeoutIn(worker, { orgId: org, system: true, as: 'hearth_queue' })).toBe('30s')
    expect(
      await timeoutIn(
        worker,
        { orgId: org, system: true, as: 'hearth_queue' },
        { readOnly: true, transactionTimeout: '5min' },
      ),
    ).toBe('5min')
    // The setting ends with the transaction.
    expect(
      (await workerPool.query<{ t: string }>("select current_setting('transaction_timeout') as t")).rows[0]?.t,
    ).toBe('0')
  })

  it('a read-only transaction writes nothing and takes no xid', async () => {
    const [org = ''] = orgs
    const xid = await withOrg(
      worker,
      { orgId: org, system: true, as: 'hearth_queue' },
      async trx =>
        (await sql<{ x: string | null }>`select pg_current_xact_id_if_assigned()::text as x`.execute(trx)).rows[0]?.x,
      { readOnly: true },
    )
    expect(xid).toBeNull()
    expect(
      await sqlstate(
        withOrg(
          app,
          { orgId: org, system: true },
          async trx => {
            await sql`insert into audit_events (org_id, actor_id, action) values (${org}, ${org}, 'x')`.execute(trx)
          },
          { readOnly: true },
        ),
      ),
    ).toBe('25006')
  })

  it('Postgres ends a transaction that runs past its timeout, connection and all', async () => {
    const [org = ''] = orgs
    const started = performance.now()
    // 25P04 is FATAL, so the connection is gone and the rollback after it fails too, which is the
    // error withOrg() passes on.
    await expect(
      withOrg(
        worker,
        { orgId: org, system: true, as: 'hearth_queue' },
        async trx => {
          await sql`select pg_sleep(2)`.execute(trx)
        },
        { transactionTimeout: '200ms' },
      ),
    ).rejects.toThrow()
    expect(performance.now() - started).toBeLessThan(1500)
    // The pool drops the ended connection and makes another.
    expect((await listOrgs(worker)).length).toBe(2)
  })
})

describe('C0.6 T18 item 4 /ready: each login is held to its role’s rule', () => {
  it('the api’s check passes hearth_app and refuses the worker’s login (a member of job roles) and the superuser', async () => {
    await expect(appRoleCheck(appPool)(signal)).resolves.toBeUndefined()
    await expect(appRoleCheck(workerPool)(signal)).rejects.toThrow(/job role/)
    await expect(appRoleCheck(ownerPool)(signal)).rejects.toThrow(/bypasses row level security/)
  })

  it('the worker’s check passes hearth_worker and refuses hearth_app, the superuser and a login that can become the owner', async () => {
    await expect(workerRoleCheck(workerPool)(signal)).resolves.toBeUndefined()
    await expect(workerRoleCheck(appPool)(signal)).rejects.toThrow(/hearth_worker/)
    await expect(workerRoleCheck(ownerPool)(signal)).rejects.toThrow(/hearth_worker/)
    // A login with no rights of its own that can SET hearth_owner (the migrate login's shape) skips
    // RLS as soon as it takes the role, so it is refused too.
    const login = `roles_it_owner_${randomBytes(3).toString('hex')}`
    await admin.query(`create role ${login} login noinherit password '${PASSWORD}'`)
    await admin.query(`grant hearth_owner to ${login} with inherit false, set true`)
    const pool = createPool(url(login, PASSWORD), logger, { max: 1 })
    try {
      await expect(workerRoleCheck(pool)(signal)).rejects.toThrow(/hearth_worker/)
    } finally {
      await pool.end()
      await admin.query(`drop role ${login}`)
    }
  })

  it('SQL-3: the worker’s check refuses a login that can take a predefined role, such as pg_write_all_data', async () => {
    // pg_write_all_data has none of the powers the other clauses look for (superuser, BYPASSRLS,
    // ownership), but writes every row an RLS policy lets through, in every table.
    const login = `roles_it_predef_${randomBytes(3).toString('hex')}`
    await admin.query(`create role ${login} login noinherit password '${PASSWORD}'`)
    await admin.query(`grant pg_write_all_data to ${login} with inherit false, set true`)
    const pool = createPool(url(login, PASSWORD), logger, { max: 1 })
    try {
      await expect(workerRoleCheck(pool)(signal)).rejects.toThrow(/hearth_worker/)
    } finally {
      await pool.end()
      await admin.query(`drop role ${login}`)
    }
  })

  it('SQL-3: 0007 refuses an existing hearth_worker that holds anything but the job roles, by SET', async () => {
    // The migration's role block, run again over the roles it made: as they are, it passes; with a
    // predefined role that has none of the powers a deny-list would look for, it refuses. Each run
    // is rolled back, so the grant never leaves this transaction.
    const migration = await readFile(
      new URL('../../../../db/migrations/0007_queue_outbox_flags.sql', import.meta.url),
      'utf8',
    )
    const block = /^do \$\$\n[\s\S]*?^\$\$;$/m.exec(migration)?.[0]
    expect(block).toContain('hearth_worker already exists and is a member of')
    const run = async (grant: string): Promise<string> => {
      await admin.query('begin')
      try {
        if (grant !== '') await admin.query(grant)
        await admin.query(block ?? '')
        return 'passed'
      } catch (error) {
        return (error as Error).message
      } finally {
        await admin.query('rollback')
      }
    }
    expect(await run('')).toBe('passed')
    for (const role of ['pg_write_all_data', 'pg_read_all_data', 'pg_signal_backend']) {
      expect(await run(`grant ${role} to hearth_worker with inherit false, set true`)).toBe(
        `hearth_worker already exists and is a member of ${role}; it may only hold job roles, by SET`,
      )
    }
  })

  it('worker_roles passes while the worker’s login can take every job role, and names any it can’t', async () => {
    await expect(workerRolesCheck(workerPool)(signal)).resolves.toBeUndefined()
    await expect(workerRolesCheck(appPool)(signal)).rejects.toThrow(`can't take ${JOB_ROLES.join(', ')}`)
    await expect(
      workerRolesCheck(workerPool, ['hearth_queue', 'hearth_job_nothing' as JobRole])(signal),
    ).rejects.toThrow("can't take hearth_job_nothing")
  })
})
