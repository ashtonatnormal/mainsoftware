import { sql } from 'kysely'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createDatabase, withOrg } from '#src/db/database.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const USER = 'b0000000-0000-4000-8000-000000000001'

// A pool whose one client records what it's sent, so the tests see the exact statements and
// when the connection goes back.
function recordingPool() {
  const log: string[] = []
  const client = {
    query: async (text: string, values: unknown[] = []) => {
      log.push(values.length > 0 ? `${text} ${JSON.stringify(values)}` : text)
      return { command: 'SELECT', rowCount: 0, rows: [] }
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
      `select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true) ${JSON.stringify([ORG, USER])}`,
      'select 1',
      'commit',
      '(released)',
    ])
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
    ]) {
      await expect(withOrg(db, acting, async () => 'never')).rejects.toThrow(/not a lower-case UUID/)
    }
    expect(log).toEqual([])
  })
})
