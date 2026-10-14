import { sql } from 'kysely'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createDatabase, listOrgs, NoSystemPrincipal, withOrg } from '#src/db/database.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const USER = 'b0000000-0000-4000-8000-000000000001'
const SYSTEM = 'c0000000-0000-4000-8000-000000000001'

// A pool whose one client records what it's sent, so the tests see the exact statements and
// when the connection goes back. `answer` gives the rows for a statement that matches it.
function recordingPool(answer: (text: string) => unknown[] = () => []) {
  const log: string[] = []
  const client = {
    query: async (text: string, values: unknown[] = []) => {
      log.push(values.length > 0 ? `${text} ${JSON.stringify(values)}` : text)
      const rows = answer(text)
      return { command: 'SELECT', rowCount: rows.length, rows }
    },
    release: () => log.push('(released)'),
  }
  const pool = { connect: async () => client, end: async () => {}, options: {} } as unknown as Pool
  return { db: createDatabase(pool), log }
}

describe('C0.3 withOrg (CLAUDE.md, Database: the one helper that sets the org and user)', () => {
  it('sets the org and user for the transaction only, runs the work, commits and releases', async () => {
    const { db, log } = recordingPool()
    const result = await withOrg(db, { orgId: ORG, userId: USER }, async trx => {
      await sql`select 1`.execute(trx)
      return 'done'
    })
    expect(result).toBe('done')
    expect(log).toEqual([
      'start transaction isolation level read committed',
      `select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true), set_config('lock_timeout', '2s', true), set_config('transaction_timeout', '30s', true) ${JSON.stringify([ORG, USER])}`,
      'select 1',
      'commit',
      '(released)',
    ])
  })

  it("acting as the system principal, reads the org's `hearth` principal after setting the org, then acts as it (C0.5)", async () => {
    const { db, log } = recordingPool(text => (text.includes('from principals') ? [{ id: SYSTEM }] : []))
    await withOrg(db, { orgId: ORG, system: true }, async trx => {
      await sql`select 1`.execute(trx)
    })
    expect(log).toEqual([
      'start transaction isolation level read committed',
      `select set_config('app.org_id', $1, true), set_config('lock_timeout', '2s', true), set_config('transaction_timeout', '30s', true) ${JSON.stringify([ORG])}`,
      `select id from principals where org_id = $1 and kind = 'system' and system_key = 'hearth' ${JSON.stringify([ORG])}`,
      `select set_config('app.user_id', $1, true) ${JSON.stringify([SYSTEM])}`,
      'select 1',
      'commit',
      '(released)',
    ])
  })

  it('refuses to act for an org with no system principal, and rolls back before any work', async () => {
    const { db, log } = recordingPool()
    let ran = false
    await expect(
      withOrg(db, { orgId: ORG, system: true }, async () => {
        ran = true
      }),
    ).rejects.toBeInstanceOf(NoSystemPrincipal)
    expect(ran).toBe(false)
    expect(log.some(line => line.includes("'app.user_id'"))).toBe(false)
    expect(log.slice(-2)).toEqual(['rollback', '(released)'])
  })

  it('rolls back and rethrows when the work fails, and still releases the connection', async () => {
    const { db, log } = recordingPool()
    const failure = new Error('work failed')
    await expect(
      withOrg(db, { orgId: ORG, userId: USER }, async () => {
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(log.slice(-2)).toEqual(['rollback', '(released)'])
    expect(log).not.toContain('commit')
  })

  it('refuses an id that is not a lower-case UUID before taking a connection', async () => {
    const { db, log } = recordingPool()
    for (const acting of [
      { orgId: 'not-a-uuid', userId: USER },
      { orgId: ORG, userId: '' },
      { orgId: ORG.toUpperCase(), userId: USER },
      { orgId: `${ORG}'; drop table people; --`, userId: USER },
      { orgId: 'not-a-uuid', system: true as const },
    ]) {
      await expect(withOrg(db, acting, async () => 'never')).rejects.toThrow(/not a lower-case UUID/)
    }
    expect(log).toEqual([])
  })
})

describe('C0.6 T18 withOrg as a job role, read only, and bounded (TECH-SPEC T16 item 2, T18 items 1 and 7)', () => {
  const principal = (text: string) => (text.includes('from principals') ? [{ id: SYSTEM }] : [])

  it('takes the job role in its first statement, before the principal lookup, so everything runs under it', async () => {
    const { db, log } = recordingPool(principal)
    await withOrg(db, { orgId: ORG, system: true, as: 'hearth_job_purge' }, async trx => {
      await sql`select 1`.execute(trx)
    })
    expect(log).toEqual([
      'start transaction isolation level read committed',
      `select set_config('role', $1, true), set_config('app.org_id', $2, true), set_config('lock_timeout', '2s', true), set_config('transaction_timeout', '30s', true) ${JSON.stringify(['hearth_job_purge', ORG])}`,
      `select id from principals where org_id = $1 and kind = 'system' and system_key = 'hearth' ${JSON.stringify([ORG])}`,
      `select set_config('app.user_id', $1, true) ${JSON.stringify([SYSTEM])}`,
      'select 1',
      'commit',
      '(released)',
    ])
  })

  it('refuses a role that is not a job role before taking a connection', async () => {
    const { db, log } = recordingPool(principal)
    for (const as of ['hearth_owner', 'hearth_app', 'postgres', "hearth_queue', true); --"]) {
      await expect(
        withOrg(db, { orgId: ORG, system: true, as: as as 'hearth_queue' }, async () => 'never'),
      ).rejects.toThrow(/not a job role/)
    }
    expect(log).toEqual([])
  })

  it('opens a read-only transaction, which alone may last up to 5 minutes', async () => {
    const { db, log } = recordingPool(principal)
    await withOrg(db, { orgId: ORG, system: true, as: 'hearth_queue' }, async () => {}, {
      readOnly: true,
      transactionTimeout: '5min',
    })
    expect(log.slice(0, 2)).toEqual([
      'start transaction isolation level read committed read only',
      `select set_config('role', $1, true), set_config('app.org_id', $2, true), set_config('lock_timeout', '2s', true), set_config('transaction_timeout', '5min', true) ${JSON.stringify(['hearth_queue', ORG])}`,
    ])
    const person = recordingPool()
    await withOrg(person.db, { orgId: ORG, userId: USER }, async () => {}, { readOnly: true })
    expect(person.log[0]).toBe('start transaction isolation level read committed read only')
    expect(person.log[1]).toContain("set_config('transaction_timeout', '30s', true)")
  })

  it('refuses a longer timeout for work that can write, one over 5 minutes, and one it cannot read', async () => {
    const { db, log } = recordingPool(principal)
    const refused: [Parameters<typeof withOrg>[3], RegExp][] = [
      [{ transactionTimeout: '31s' }, /only a read-only transaction/],
      [{ transactionTimeout: '1min', readOnly: false }, /only a read-only transaction/],
      [{ transactionTimeout: '301s', readOnly: true }, /at most 5 minutes/],
      [{ transactionTimeout: '6min', readOnly: true }, /at most 5 minutes/],
      [{ transactionTimeout: '0s' }, /must be written/],
      [{ transactionTimeout: '30 s' }, /must be written/],
      [{ transactionTimeout: "1s', false); --" }, /must be written/],
      [{ transactionTimeout: '30h', readOnly: true }, /must be written/],
    ]
    for (const [options, error] of refused) {
      await expect(
        withOrg(db, { orgId: ORG, userId: USER }, async () => 'never', options),
        JSON.stringify(options),
      ).rejects.toThrow(error)
    }
    expect(log).toEqual([])
    // A shorter one is fine for any work.
    await withOrg(db, { orgId: ORG, userId: USER }, async () => {}, { transactionTimeout: '500ms' })
    expect(log[1]).toContain("set_config('transaction_timeout', '500ms', true)")
  })

  it("lists every org's id as hearth_queue, in a short read-only transaction of its own", async () => {
    const OTHER = 'a0000000-0000-4000-8000-000000000002'
    const { db, log } = recordingPool(text => (text.includes('worker_org_ids') ? [{ id: ORG }, { id: OTHER }] : []))
    expect(await listOrgs(db)).toEqual([ORG, OTHER])
    expect(log).toEqual([
      'start transaction isolation level read committed read only',
      "select set_config('role', 'hearth_queue', true), set_config('transaction_timeout', '30s', true)",
      'select id from public.worker_org_ids() as id',
      'commit',
      '(released)',
    ])
    expect(log.join('\n')).not.toContain('app.')
  })
})
