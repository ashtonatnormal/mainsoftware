import type { AddressInfo } from 'node:net'
import { pino } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { buildApp } from '#src/app.ts'
import { sha256 } from '#src/auth/crypto.ts'
import { Subscriptions } from '#src/pubsub.ts'
import { liveSessions, registerRealtime } from '#src/realtime/index.ts'
import { pgError, type Statement, scriptedPool } from '#src/testing/pool.ts'
import { fakeSubscriber } from '#src/testing/subscriber.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const OTHER_ORG = 'a0000000-0000-4000-8000-000000000002'
const SYSTEM = 'c0000000-0000-4000-8000-000000000001'
const APP_ORIGIN = 'https://hearth.example.com'
const TOKEN = 't'.repeat(43)
const session = (n: number, orgId = ORG) => ({
  sessionId: `b0000000-0000-4000-8000-0000000000e${n}`,
  orgId,
  userId: `b0000000-0000-4000-8000-00000000000${n}`,
  deviceId: `b0000000-0000-4000-8000-0000000000d${n}`,
})

const isPrincipalRead = (statement: Statement) => statement.text.includes('from principals where org_id = $1')
const isRecheck = (statement: Statement) => statement.text.startsWith('select s.id from sessions s')

describe('C0.5 T5 ACC-05 the realtime re-check: which sessions are still live', () => {
  it('reads each org’s sessions in its own transaction, as its system principal, by the session_by_token rules', async () => {
    const pool = scriptedPool(statement => {
      if (isPrincipalRead(statement)) return [{ id: SYSTEM }]
      if (isRecheck(statement)) return statement.values[0] === ORG ? [{ id: session(1).sessionId }] : []
      return []
    })
    const live = await liveSessions(pool.db, [session(1), session(2), session(3, OTHER_ORG)], { error: vi.fn() })
    expect(live).toEqual(new Set([session(1).sessionId]))
    const rechecks = pool.statements.filter(isRecheck)
    expect(rechecks.map(statement => statement.values)).toEqual([
      [ORG, [session(1).sessionId, session(2).sessionId], '30 days'],
      [OTHER_ORG, [session(3, OTHER_ORG).sessionId], '30 days'],
    ])
    const [query] = rechecks
    for (const rule of [
      's.org_id = $1 and s.id = any($2::uuid[])',
      's.revoked_at is null',
      's.expires_at > now()',
      's.last_seen_at > now() - $3::interval',
      'd.signed_out_at is null',
      'p.deactivated_at is null',
    ]) {
      expect(query?.text).toContain(rule)
    }
    // No row locks: it's a periodic re-check, not a refusal.
    expect(query?.text).not.toContain('for share')
    // Each org: its own transaction, acting as its system principal.
    expect(pool.texts().filter(text => text === 'commit')).toHaveLength(2)
    expect(
      pool.statements.filter(s => s.text.startsWith("select set_config('app.user_id'")).map(s => s.values),
    ).toEqual([[SYSTEM], [SYSTEM]])
  })

  it('fails closed for an org with no system principal: its sessions count as ended', async () => {
    const pool = scriptedPool(statement => {
      if (isPrincipalRead(statement)) return statement.values[0] === ORG ? [{ id: SYSTEM }] : []
      if (isRecheck(statement)) return [{ id: session(1).sessionId }]
      return []
    })
    const error = vi.fn()
    const live = await liveSessions(pool.db, [session(1), session(3, OTHER_ORG)], { error })
    expect(live).toEqual(new Set([session(1).sessionId]))
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ws_recheck_no_system_principal', orgId: OTHER_ORG }),
      expect.any(String),
    )
  })

  it('throws any other failure, so the re-check counts as failed and closes only what it can no longer confirm in time (socket.ts)', async () => {
    const pool = scriptedPool(statement => {
      if (isPrincipalRead(statement)) return [{ id: SYSTEM }]
      if (isRecheck(statement)) return pgError('57P01')
      return []
    })
    await expect(liveSessions(pool.db, [session(1)], { error: vi.fn() })).rejects.toMatchObject({ code: '57P01' })
  })
})

describe('C0.5 T5 ACC-05 the realtime role, wired', () => {
  it('opens a socket for a live session, keeps its org’s flags, and closes it when the api says the session ended', async () => {
    const pool = scriptedPool(statement =>
      statement.text.includes('public.session_by_token') && sha256(TOKEN).equals(statement.values[0] as Buffer)
        ? [
            {
              session_id: session(1).sessionId,
              org_id: ORG,
              user_id: session(1).userId,
              device_id: session(1).deviceId,
            },
          ]
        : [],
    )
    const sub = fakeSubscriber()
    const subscriptions = new Subscriptions(sub.asRedis, pino({ level: 'silent' }))
    const flags = { track: vi.fn(async (_orgId: string) => {}) }
    const app = buildApp({ appOrigin: APP_ORIGIN, logger: pino({ level: 'silent' }), checks: {} })
    const server = registerRealtime(app, {
      appOrigin: APP_ORIGIN,
      logger: pino({ level: 'silent' }),
      db: pool.db,
      subscriptions,
      flags,
      keyPrefix: 'it:unit:',
    })
    await app.listen({ host: '127.0.0.1', port: 0 })
    try {
      const { port } = app.server.address() as AddressInfo
      // The session lookup is the pre-org function, with the idle limit as its argument.
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { origin: APP_ORIGIN, cookie: `__Host-hearth_session=${TOKEN}` },
      })
      const closed = new Promise<number>(resolve => ws.once('close', code => resolve(code)))
      await new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
      expect(pool.statements.find(s => s.text.includes('public.session_by_token'))?.values[1]).toBe('30 days')
      expect(sub.subscribe).toHaveBeenCalledWith('it:unit:revoked')
      // C0.6: the socket's org's flags are kept from its first upgrade on.
      expect(flags.track).toHaveBeenCalledWith(ORG)
      // What publishRevoked sends, as the subscriber delivers it.
      sub.events.emit(
        'message',
        'it:unit:revoked',
        JSON.stringify({ v: 1, at: Date.now(), sessions: [session(1).sessionId] }),
      )
      expect(await closed).toBe(4401)
      expect(server.counts().closedRevoked).toBe(1)
    } finally {
      await app.close()
      await subscriptions.close()
    }
  })

  it('only an app built with the realtime role listens for upgrades; elsewhere Node treats one as a request', async () => {
    const plain = buildApp({ appOrigin: APP_ORIGIN, logger: pino({ level: 'silent' }), checks: {} })
    expect(plain.server.listenerCount('upgrade')).toBe(0)
    const realtime = buildApp({
      appOrigin: APP_ORIGIN,
      logger: pino({ level: 'silent' }),
      checks: {},
      realtime: { db: scriptedPool().db, keyPrefix: 'it:unit:' },
    })
    expect(realtime.server.listenerCount('upgrade')).toBe(1)
    await Promise.all([plain.close(), realtime.close()])
  })
})
