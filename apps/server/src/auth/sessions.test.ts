import { describe, expect, it, vi } from 'vitest'
import type { Api } from '#src/api.ts'
import { sha256 } from '#src/auth/crypto.ts'
import { AttemptStale, inSession, issueSession, stampReauth } from '#src/auth/sessions.ts'
import { withOrg } from '#src/db/database.ts'
import type { ReqInfo } from '#src/http.ts'
import { pgError, type Statement, scriptedPool } from '#src/testing/pool.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const PERSON = 'b0000000-0000-4000-8000-000000000001'
const NUMBER = 'b0000000-0000-4000-8000-0000000000f1'
const DEVICE = 'b0000000-0000-4000-8000-0000000000d1'
const SESSION = 'b0000000-0000-4000-8000-0000000000e1'

const input = {
  orgId: ORG,
  personId: PERSON,
  phoneNumberId: NUMBER,
  label: 'iPhone · Safari',
  method: 'sms_pin',
  ip: '198.51.100.7',
  requestId: 'f0000000-0000-4000-8000-000000000001',
} as const

// The rows a sign-in's statements get: the number still the person's, then the new device and
// session ids.
function issuing(change: (statement: Statement) => unknown[] | Error | undefined = () => undefined) {
  return scriptedPool(statement => {
    const changed = change(statement)
    if (changed !== undefined) return changed
    if (statement.text.startsWith('select 1 from phone_numbers')) return [{ '?column?': 1 }]
    if (statement.text.startsWith('insert into "devices"')) return [{ id: DEVICE }]
    if (statement.text.startsWith('insert into sessions')) return [{ id: SESSION }]
    return []
  })
}

describe('C0.5 T5 issuing a session at the end of a sign-in', () => {
  it('re-reads the number, then makes a device and a session the database stamps, and audits the sign-in', async () => {
    const { db, statements } = issuing()
    const issued = await withOrg(db, { orgId: ORG, userId: PERSON }, trx => issueSession(trx, input))
    expect(issued).toEqual({
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      sessionId: SESSION,
      deviceId: DEVICE,
      label: 'iPhone · Safari',
      maxAgeSeconds: 7_776_000,
    })
    const work = statements.filter(
      s => !/^(start transaction|commit|select set_config|select id from principals)/.test(s.text),
    )
    expect(work.map(s => s.text)).toEqual([
      'select 1 from phone_numbers where org_id = $1 and id = $2 and person_id = $3 and removed_at is null for share',
      'insert into "devices" ("org_id", "user_id", "label") values ($1, $2, $3) returning "id"',
      'insert into sessions (org_id, user_id, device_id, token_hash, expires_at) values ($1, $2, $3, $4, now() + $5::interval) returning id',
      expect.stringMatching(/^insert into "audit_events"/),
    ])
    const [number, device, session, audit] = work
    expect(number?.values).toEqual([ORG, NUMBER, PERSON])
    expect(device?.values).toEqual([ORG, PERSON, 'iPhone · Safari'])
    // Only the token's hash is stored, and the session lasts 90 days.
    expect(session?.values).toEqual([ORG, PERSON, DEVICE, sha256(issued.token), '2160 hours'])
    expect(JSON.stringify(statements)).not.toContain(issued.token)
    expect(audit?.values).toContain('auth.sign_in')
    expect(audit?.values).toContainEqual({ method: 'sms_pin' })
  })

  it('refuses with AttemptStale when the number was removed or moved since the code was sent', async () => {
    const { db, texts } = issuing(s => (s.text.startsWith('select 1 from phone_numbers') ? [] : undefined))
    await expect(withOrg(db, { orgId: ORG, userId: PERSON }, trx => issueSession(trx, input))).rejects.toBeInstanceOf(
      AttemptStale,
    )
    expect(texts().some(text => text.startsWith('insert'))).toBe(false)
    expect(texts().at(-1)).toBe('rollback')
  })

  it("turns the triggers' refusal of someone who has left into AttemptStale, and rethrows anything else", async () => {
    const left = issuing(s => (s.text.startsWith('insert into sessions') ? pgError('23514') : undefined))
    await expect(
      withOrg(left.db, { orgId: ORG, userId: PERSON }, trx => issueSession(trx, input)),
    ).rejects.toBeInstanceOf(AttemptStale)
    const named = issuing(s =>
      s.text.startsWith('insert into "devices"') ? pgError('23514', 'devices_label_check') : undefined,
    )
    await expect(
      withOrg(named.db, { orgId: ORG, userId: PERSON }, trx => issueSession(trx, input)),
    ).rejects.toMatchObject({ code: '23514', constraint: 'devices_label_check' })
  })

  it('§9.4 stamps a re-authentication on the session, naming the org', async () => {
    const { db, statements } = scriptedPool()
    const session = { sessionId: SESSION, orgId: ORG, userId: PERSON, deviceId: DEVICE }
    await withOrg(db, { orgId: ORG, userId: PERSON }, trx => stampReauth(trx, session))
    const stamp = statements.find(s => s.text.startsWith('update sessions'))
    expect(stamp).toEqual({
      text: 'update sessions set reauthenticated_at = now() where org_id = $1 and id = $2',
      values: [ORG, SESSION],
    })
  })
})

describe("C0.5 T5 a session's last use", () => {
  it('is written after the response, device first, at most once a minute per session, never to ended rows', async () => {
    const { db, statements } = scriptedPool()
    const tasks: (() => Promise<void>)[] = []
    const info: ReqInfo = {
      ip: '198.51.100.7',
      requestId: 'f0000000-0000-4000-8000-000000000002',
      userAgent: undefined,
      log: { warn: vi.fn() } as unknown as ReqInfo['log'],
      after: task => tasks.push(task),
    }
    const api = { db } as Api
    // A session id of its own, since the once-a-minute memory is per process.
    const session = { sessionId: 'b0000000-0000-4000-8000-0000000000e9', orgId: ORG, userId: PERSON, deviceId: DEVICE }
    expect(await inSession(api, info, session, async () => 'done')).toBe('done')
    expect(await inSession(api, info, session, async () => 'again')).toBe('again')
    expect(tasks).toHaveLength(2)
    expect(statements.some(s => s.text.startsWith('update'))).toBe(false)
    for (const task of tasks) await task()
    const updates = statements.filter(s => s.text.startsWith('update'))
    expect(updates.map(s => s.text)).toEqual([
      "update devices set last_seen_at = now() where org_id = $1 and id = $2 and signed_out_at is null and last_seen_at < now() - interval '1 minute'",
      "update sessions set last_seen_at = now() where org_id = $1 and id = $2 and revoked_at is null and last_seen_at < now() - interval '1 minute'",
    ])
    expect(updates.map(s => s.values)).toEqual([
      [ORG, DEVICE],
      [ORG, session.sessionId],
    ])
  })
})
