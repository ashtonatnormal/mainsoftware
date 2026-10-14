import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { createDatabase } from '#src/db/database.ts'
import { personByPhone, sessionByToken } from '#src/db/pre-org.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const PERSON = 'b0000000-0000-4000-8000-000000000001'
const DEVICE = 'b0000000-0000-4000-8000-0000000000d1'
const SESSION = 'b0000000-0000-4000-8000-0000000000e1'
const NUMBER = 'b0000000-0000-4000-8000-0000000000f1'

// A pool whose one client records each statement (without its values, which hold a token hash or
// a number) and answers the lookup with `rows`.
function recordingPool(rows: unknown[] = []) {
  const log: string[] = []
  const values: unknown[][] = []
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      log.push(text)
      if (/from public\./.test(text)) {
        values.push(params)
        return { command: 'SELECT', rowCount: rows.length, rows }
      }
      return { command: 'SELECT', rowCount: 0, rows: [] }
    },
    release: () => log.push('(released)'),
  }
  const pool = { connect: async () => client, end: async () => {}, options: {} } as unknown as Pool
  return { db: createDatabase(pool), log, values }
}

const TRANSACTION = [
  'start transaction isolation level read committed',
  "select set_config('lock_timeout', '2s', true), set_config('synchronous_commit', 'off', true)",
]

describe('C0.5 the pre-org lookups (CLAUDE.md, Database: sign-in before the org is known)', () => {
  it('looks a session up in a short transaction of its own, with no app. setting', async () => {
    const { db, log, values } = recordingPool([
      { session_id: SESSION, org_id: ORG, user_id: PERSON, device_id: DEVICE },
    ])
    const hash = Buffer.alloc(32, 7)
    expect(await sessionByToken(db, hash, '30 days')).toEqual({
      sessionId: SESSION,
      orgId: ORG,
      userId: PERSON,
      deviceId: DEVICE,
    })
    expect(log).toEqual([
      ...TRANSACTION,
      'select session_id, org_id, user_id, device_id from public.session_by_token($1, $2::interval)',
      'commit',
      '(released)',
    ])
    expect(values).toEqual([[hash, '30 days']])
    expect(log.join('\n')).not.toContain('app.')
  })

  it('answers undefined for no session, and for a hash of the wrong length without a query', async () => {
    const none = recordingPool([])
    expect(await sessionByToken(none.db, Buffer.alloc(32), '30 days')).toBeUndefined()
    const short = recordingPool([])
    expect(await sessionByToken(short.db, Buffer.alloc(31), '30 days')).toBeUndefined()
    expect(short.log).toEqual([])
  })

  it('throws if a token hash ever matched two sessions', async () => {
    const row = { session_id: SESSION, org_id: ORG, user_id: PERSON, device_id: DEVICE }
    const { db, log } = recordingPool([row, row])
    await expect(sessionByToken(db, Buffer.alloc(32), '30 days')).rejects.toThrow(/more than one row/)
    expect(log.at(-1)).toBe('(released)')
  })

  it('looks a phone number up the same way, returning every org that holds it', async () => {
    const { db, log, values } = recordingPool([{ phone_number_id: NUMBER, org_id: ORG, person_id: PERSON }])
    expect(await personByPhone(db, '+6580000001')).toEqual([{ phoneNumberId: NUMBER, orgId: ORG, personId: PERSON }])
    expect(log).toEqual([
      ...TRANSACTION,
      'select phone_number_id, org_id, person_id from public.person_by_phone($1)',
      'commit',
      '(released)',
    ])
    expect(values).toEqual([['+6580000001']])
    expect(log.join('\n')).not.toContain('app.')
  })
})
