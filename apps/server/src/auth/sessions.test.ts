import { describe, expect, it, vi } from 'vitest'
import type { Api } from '#src/api.ts'
import { sha256 } from '#src/auth/crypto.ts'
import { AttemptStale, inSession, issueSession, stampReauth } from '#src/auth/sessions.ts'
import { withOrg } from '#src/db/database.ts'
import type { ReqInfo } from '#src/http.ts'
import { staticFlags } from '#src/testing/flags.ts'
import { appended, pgError, type Statement, scriptedPool } from '#src/testing/pool.ts'

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
  privileged: true,
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

describe('C0.5 T5 C0.6 T16 D46 issuing a session at the end of a sign-in', () => {
  it('re-reads the number, then makes a device and a session the database stamps, appends signin.started and audits the sign-in', async () => {
    const { db, statements } = issuing()
    const issued = await withOrg(db, { orgId: ORG, userId: PERSON }, trx => issueSession(trx, input))
    expect(issued).toEqual({
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      sessionId: SESSION,
      deviceId: DEVICE,
      label: 'iPhone · Safari',
      maxAgeSeconds: 604_800,
    })
    const work = statements.filter(
      s => !/^(start transaction|commit|select set_config|select id from principals)/.test(s.text),
    )
    expect(work.map(s => s.text)).toEqual([
      'select 1 from phone_numbers where org_id = $1 and id = $2 and person_id = $3 and removed_at is null for share',
      'insert into "devices" ("org_id", "user_id", "label") values ($1, $2, $3) returning "id"',
      'insert into sessions (org_id, user_id, device_id, token_hash, expires_at) values ($1, $2, $3, $4, now() + $5::interval) returning id',
      expect.stringMatching(/^insert into outbox_events /),
      expect.stringMatching(/^insert into "audit_events"/),
    ])
    const [number, device, session, , audit] = work
    // Before a session exists the transaction acts as Hearth, so the event names the person as its
    // actor, as the audit row does (T16 item 10).
    expect(appended(statements)).toEqual([
      {
        type: 'signin.started',
        entity: PERSON,
        subjects: [PERSON],
        ids: { device: DEVICE, session: SESSION, method: 'sms_pin', privileged: true },
        actor: PERSON,
      },
    ])
    expect(number?.values).toEqual([ORG, NUMBER, PERSON])
    expect(device?.values).toEqual([ORG, PERSON, 'iPhone · Safari'])
    // Only the token's hash is stored, and a privileged holder's session lasts 7 days (D46).
    expect(session?.values).toEqual([ORG, PERSON, DEVICE, sha256(issued.token), '168 hours'])
    expect(JSON.stringify(statements)).not.toContain(issued.token)
    expect(audit?.values).toContain('auth.sign_in')
    expect(audit?.values).toContainEqual({ method: 'sms_pin', privileged: true })
  })

  it('D46 AQ-05: a code-only session lasts 90 days and says so on signin.started and auth.sign_in', async () => {
    const { db, statements } = issuing()
    const issued = await withOrg(db, { orgId: ORG, userId: PERSON }, trx =>
      issueSession(trx, { ...input, method: 'sms', privileged: false }),
    )
    expect(issued.maxAgeSeconds).toBe(7_776_000)
    const session = statements.find(s => s.text.startsWith('insert into sessions'))
    expect(session?.values.at(-1)).toBe('2160 hours')
    expect(appended(statements)[0]?.ids).toEqual({ device: DEVICE, session: SESSION, method: 'sms', privileged: false })
    const audit = statements.find(s => s.text.startsWith('insert into "audit_events"'))
    expect(audit?.values).toContainEqual({ method: 'sms', privileged: false })
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

describe("C0.5 T5 a session's last use (and C0.6: the org's flags kept)", () => {
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
    const flags = staticFlags()
    const api = { db, flags } as unknown as Api
    // A session id of its own, since the once-a-minute memory is per process.
    const session = { sessionId: 'b0000000-0000-4000-8000-0000000000e9', orgId: ORG, userId: PERSON, deviceId: DEVICE }
    expect(await inSession(api, info, session, async () => 'done')).toBe('done')
    expect(await inSession(api, info, session, async () => 'again')).toBe('again')
    expect(tasks).toHaveLength(2)
    // C0.6: the process keeps the org's flags from its first signed-in request on.
    expect(flags.track).toHaveBeenCalledWith(ORG)
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

describe('C0.8 T21 item 10 OD-14 inSession for the web shell’s GETs', () => {
  const info = (tasks: (() => Promise<void>)[]): ReqInfo => ({
    ip: '198.51.100.7',
    requestId: 'f0000000-0000-4000-8000-000000000003',
    userAgent: undefined,
    log: { warn: vi.fn() } as unknown as ReqInfo['log'],
    after: task => tasks.push(task),
  })

  it('OD-14 C-23: runs the work read only when asked, and queues no touch with touch: false, keeping the org’s flags either way', async () => {
    const { db, texts } = scriptedPool()
    const flags = staticFlags()
    const api = { db, flags } as unknown as Api
    const session = { sessionId: 'b0000000-0000-4000-8000-0000000000ea', orgId: ORG, userId: PERSON, deviceId: DEVICE }
    const tasks: (() => Promise<void>)[] = []
    expect(await inSession(api, info(tasks), session, async () => 'read', { touch: false, readOnly: true })).toBe(
      'read',
    )
    expect(texts()[0]).toBe('start transaction isolation level read committed read only')
    expect(tasks).toHaveLength(0)
    expect(flags.track).toHaveBeenCalledWith(ORG)
    // Read only, still use of the session: one touch queued, in a transaction of its own.
    expect(await inSession(api, info(tasks), session, async () => 'used', { readOnly: true })).toBe('used')
    expect(tasks).toHaveLength(1)
    // With no options, as before: read-write, touched.
    const before = texts().length
    await inSession(api, info(tasks), session, async () => 'default')
    expect(texts()[before]).toBe('start transaction isolation level read committed')
    expect(tasks).toHaveLength(2)
  })
})
