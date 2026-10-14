import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { writeAudit } from '#src/auth/audit.ts'
import { createDatabase, withOrg } from '#src/db/database.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const PERSON = 'b0000000-0000-4000-8000-000000000001'
const DEVICE = 'b0000000-0000-4000-8000-0000000000d1'

function recordingPool() {
  const statements: { text: string; values: unknown[] }[] = []
  const client = {
    query: async (text: string, values: unknown[] = []) => {
      statements.push({ text, values })
      return { command: 'INSERT', rowCount: 1, rows: [] }
    },
    release: () => {},
  }
  const pool = { connect: async () => client, end: async () => {}, options: {} } as unknown as Pool
  return { db: createDatabase(pool), statements }
}

describe('ADM-06 T14 writing an auth audit row', () => {
  it('is a plain INSERT, never INSERT … RETURNING, which hearth_app has no SELECT for', async () => {
    const { db, statements } = recordingPool()
    await withOrg(db, { orgId: ORG, userId: PERSON }, trx =>
      writeAudit(trx, {
        orgId: ORG,
        actorId: PERSON,
        action: 'auth.sign_in',
        targetType: 'person',
        targetId: PERSON,
        deviceId: DEVICE,
        ip: '198.51.100.4',
        requestId: 'c0000000-0000-4000-8000-000000000001',
        details: { method: 'sms_pin' },
      }),
    )
    const insert = statements.find(s => s.text.startsWith('insert'))
    expect(insert?.text).toBe(
      'insert into "audit_events" ("org_id", "actor_id", "action", "target_type", "target_id", "reason", "device_id", "ip", "request_id", "details") values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
    )
    expect(insert?.text).not.toMatch(/returning/i)
    expect(insert?.values).toEqual([
      ORG,
      PERSON,
      'auth.sign_in',
      'person',
      PERSON,
      null,
      DEVICE,
      '198.51.100.4',
      'c0000000-0000-4000-8000-000000000001',
      { method: 'sms_pin' },
    ])
  })

  it('writes an empty details object and a null actor when none is given', async () => {
    const { db, statements } = recordingPool()
    await withOrg(db, { orgId: ORG, userId: PERSON }, trx =>
      writeAudit(trx, {
        orgId: ORG,
        actorId: null,
        action: 'auth.code_failed',
        targetType: 'person',
        targetId: PERSON,
        deviceId: null,
        ip: null,
        requestId: 'r-1',
      }),
    )
    const insert = statements.find(s => s.text.startsWith('insert'))
    expect(insert?.values).toEqual([ORG, null, 'auth.code_failed', 'person', PERSON, null, null, null, 'r-1', {}])
  })
})
