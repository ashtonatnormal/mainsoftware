import type { AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { FLAGS, type FlagSpec, type NoticeStanding } from '@hearth/shared'
import { pino } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { buildApp } from '#src/app.ts'
import { sha256 } from '#src/auth/crypto.ts'
import { Subscriptions } from '#src/pubsub.ts'
import { type RealtimeDeps, registerRealtime } from '#src/realtime/index.ts'
import { captureLogger } from '#src/testing/logs.ts'
import { type Statement, scriptedPool, standingsOf, systemPrincipal } from '#src/testing/pool.ts'
import { fakeStreams } from '#src/testing/streams.ts'
import { fakeSubscriber } from '#src/testing/subscriber.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const SYSTEM = 'c0000000-0000-4000-8000-000000000001'
const APP_ORIGIN = 'https://hearth.example.com'
const TOKEN = 't'.repeat(43)
const session = (n: number, orgId = ORG) => ({
  sessionId: `b0000000-0000-4000-8000-0000000000e${n}`,
  orgId,
  userId: `b0000000-0000-4000-8000-00000000000${n}`,
  deviceId: `b0000000-0000-4000-8000-0000000000d${n}`,
})
const isSessionCheck = (statement: Statement) => statement.text.startsWith('select s.id, s.user_id,')
const isStandingRead = (statement: Statement) => statement.text.startsWith('select x.person,')

// The database as realtime reads it: TOKEN is session 1's, every session asked about is live, and
// the org has its system principal; the notice's standing read (C0.9 PD-45) finds `standing` for
// everyone it asks about, or the scripted pool's default (acknowledged).
function database(standing?: NoticeStanding) {
  return scriptedPool(statement => {
    if (standing !== undefined && statement.text.startsWith('select x.person,')) {
      return standingsOf(statement.values.find(Array.isArray) as string[], standing)
    }
    if (statement.text.includes('public.session_by_token')) {
      return sha256(TOKEN).equals(statement.values[0] as Buffer)
        ? [
            {
              session_id: session(1).sessionId,
              org_id: ORG,
              user_id: session(1).userId,
              device_id: session(1).deviceId,
            },
          ]
        : []
    }
    if (isSessionCheck(statement)) {
      return (statement.values.find(Array.isArray) as string[]).map(id => ({
        id,
        user_id: session(1).userId,
        live: true,
        ended_at: null,
      }))
    }
    return systemPrincipal(SYSTEM)(statement)
  })
}

// The realtime role on a scripted pool. Admission is off ('none', C0.7's behaviour) unless a test
// says otherwise, since these cases are about sessions, channels and flags (C-07); NTS-04 below runs
// it on, as production always does. 'unset' leaves admissionForTests out.
async function wired(
  options: {
    flags?: Parameters<typeof registerRealtime>[1]['flags']
    admission?: RealtimeDeps['admissionForTests'] | 'unset'
    standing?: NoticeStanding
  } = {},
) {
  const pool = database(options.standing)
  const admission = options.admission ?? 'none'
  const sub = fakeSubscriber()
  const subscriptions = new Subscriptions(sub.asRedis, pino({ level: 'silent' }))
  const { logger, events } = captureLogger('realtime')
  const app = buildApp({ appOrigin: APP_ORIGIN, logger: pino({ level: 'silent' }), checks: {} })
  const streams = fakeStreams()
  const gateway = registerRealtime(app, {
    appOrigin: APP_ORIGIN,
    logger,
    db: pool.db,
    subscriptions,
    valkey: streams.asClient,
    reader: streams.asReader,
    keyPrefix: 'it:unit:',
    ...(options.flags === undefined ? {} : { flags: options.flags }),
    ...(admission === 'unset' ? {} : { admissionForTests: admission }),
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const { port } = app.server.address() as AddressInfo
  const socket = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { origin: APP_ORIGIN, cookie: `__Host-hearth_session=${TOKEN}` },
    })
    const closed = new Promise<number>(resolve => ws.once('close', code => resolve(code)))
    const frames: Record<string, unknown>[] = []
    ws.on('message', data => frames.push(JSON.parse(String(data))))
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    ws.send(JSON.stringify({ v: 1, t: 'hello', versions: [1] }))
    return { ws, closed, frames }
  }
  const stop = async () => {
    await app.close()
    await subscriptions.close()
  }
  return { pool, sub, subscriptions, gateway, events, socket, stop }
}

describe('C0.5 T5 ACC-05 C0.7 T19: the realtime role, wired', () => {
  it('opens a socket for a live session, keeps its org’s flags, and closes it with 4401 on revoked, path push', async () => {
    const flags = { track: vi.fn(async (_orgId: string) => {}), onChange: vi.fn(() => () => {}), registry: FLAGS }
    const { pool, sub, gateway, events, socket, stop } = await wired({ flags })
    try {
      const { closed } = await socket()
      // The session lookup is the pre-org function, with the idle limit as its argument.
      expect(pool.statements.find(s => s.text.includes('public.session_by_token'))?.values[1]).toBe('30 days')
      expect(sub.subscribe.mock.calls.map(([channel]) => channel)).toEqual(['it:unit:revoked', 'it:unit:access'])
      // C0.6: the socket's org's flags are kept from its first upgrade on.
      expect(flags.track).toHaveBeenCalledWith(ORG)
      // What publishRevoked sends, as the subscriber delivers it.
      sub.events.emit(
        'message',
        'it:unit:revoked',
        JSON.stringify({ v: 1, at: Date.now(), sessions: [session(1).sessionId] }),
      )
      expect(await closed).toBe(4401)
      expect(gateway.counts().closedRevoked).toBe(1)
      expect(events('revocation_applied')).toEqual([
        expect.objectContaining({
          handler: 'sockets',
          path: 'push',
          cause: 'sessions_ended',
          startSource: 'publisher',
        }),
      ])
    } finally {
      await stop()
    }
  })

  it('P12 T19 items 5 and 13: an access message’s sessions close at once, labelled handler sockets, path durable, cause sessions_ended, startSource outbox', async () => {
    const { sub, gateway, events, socket, stop } = await wired()
    try {
      const { ws, closed } = await socket()
      const access = (message: object) => sub.events.emit('message', 'it:unit:access', JSON.stringify(message))
      // Another version's message, and another session: nothing closes.
      access({ v: 2, org: ORG, path: 'durable', cause: 'sessions_ended', sessions: [session(1).sessionId] })
      access({ v: 1, org: ORG, path: 'durable', cause: 'sessions_ended', sessions: [session(2).sessionId] })
      await delay(50)
      expect(ws.readyState).toBe(WebSocket.OPEN)
      // What the worker's sockets job publishes (revocation/registry.ts).
      access({
        v: 1,
        org: ORG,
        path: 'durable',
        cause: 'sessions_ended',
        at: Date.now() - 1000,
        sessions: [session(1).sessionId],
      })
      expect(await closed).toBe(4401)
      expect(gateway.counts()).toMatchObject({ closedDurable: 1, closedRevoked: 0 })
      expect(events('revocation_applied')).toEqual([
        expect.objectContaining({
          handler: 'sockets',
          path: 'durable',
          cause: 'sessions_ended',
          startSource: 'outbox',
          latencyMs: expect.any(Number),
        }),
      ])
    } finally {
      await stop()
    }
  })

  it('T19 item 5 §8.1: an access message’s people are re-checked against Postgres in the lane, acting as the system principal', async () => {
    const { pool, sub, socket, stop } = await wired()
    try {
      const { ws } = await socket()
      const checksBefore = pool.statements.filter(isSessionCheck).length
      sub.events.emit(
        'message',
        'it:unit:access',
        JSON.stringify({ v: 1, org: ORG, path: 'durable', cause: 'keys_changed', people: [session(1).userId] }),
      )
      for (let i = 0; i < 100 && pool.statements.filter(isSessionCheck).length === checksBefore; i++) await delay(10)
      const check = pool.statements.filter(isSessionCheck).at(-1)
      expect(check?.values).toContainEqual([session(1).sessionId])
      // Read only, as the org's system principal.
      expect(pool.texts()).toContain('start transaction isolation level read committed read only')
      expect(ws.readyState).toBe(WebSocket.OPEN)
    } finally {
      await stop()
    }
  })

  it('GW-11 P4 T17 item 11: a change to a client flag nudges the org’s sockets with no values; a server-only flag nudges nobody', async () => {
    let listener: (orgId: string, keys: readonly string[]) => void = () => {}
    const registry: Readonly<Record<string, FlagSpec>> = {
      ...FLAGS,
      'it.client': { ...(FLAGS['core.system'] as FlagSpec), client: true },
    }
    const flags = {
      track: vi.fn(async (_orgId: string) => {}),
      onChange: vi.fn((given: typeof listener) => {
        listener = given
        return () => {}
      }),
      registry,
    }
    const { socket, stop } = await wired({ flags })
    try {
      const { frames } = await socket()
      for (let i = 0; i < 50 && frames.length === 0; i++) await delay(10)
      listener(ORG, ['core.system'])
      await delay(50)
      expect(frames.filter(frame => frame.t === 'nudge')).toEqual([])
      listener(ORG, ['it.client'])
      for (let i = 0; i < 50 && !frames.some(frame => frame.t === 'nudge'); i++) await delay(10)
      expect(frames.filter(frame => frame.t === 'nudge')).toEqual([{ v: 1, t: 'nudge', what: 'flags' }])
    } finally {
      await stop()
    }
  })

  it('T17 item 11: the gateway stops listening for flag changes when it stops, since the flag cache outlives it', async () => {
    // Like FlagCache's, the remover answers whether it removed anything.
    const remove = vi.fn(() => true)
    const flags = { track: vi.fn(async (_orgId: string) => {}), onChange: vi.fn(() => remove), registry: FLAGS }
    const { stop } = await wired({ flags })
    expect(flags.onChange).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()
    await stop()
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('OD-22 P2 T19 item 12: the full readiness and the local one pass only once both channels are subscribed, and fail while the gateway stops', async () => {
    const sub = fakeSubscriber({ failures: 1 })
    const subscriptions = new Subscriptions(sub.asRedis, pino({ level: 'silent' }), { retryMs: 50 })
    const app = buildApp({ appOrigin: APP_ORIGIN, logger: pino({ level: 'silent' }), checks: {} })
    const gateway = registerRealtime(app, {
      appOrigin: APP_ORIGIN,
      logger: pino({ level: 'silent' }),
      db: database().db,
      subscriptions,
      keyPrefix: 'it:unit:',
      // No socket opens here, so admission is never asked; off, as in wired() (C-07).
      admissionForTests: 'none',
    })
    const signal = new AbortController().signal
    try {
      // The first subscribe failed: neither passes yet.
      await expect(gateway.check(signal)).rejects.toThrow(/listening/)
      await expect(gateway.localCheck(signal)).rejects.toThrow(/listened/)
      for (let i = 0; i < 100 && !(subscriptions.isLive('revoked') && subscriptions.isLive('access')); i++) {
        await delay(10)
      }
      await gateway.check(signal)
      await gateway.localCheck(signal)
      // The subscriber's connection closes: the full readiness fails, the local one doesn't (P2).
      sub.events.emit('close')
      await expect(gateway.check(signal)).rejects.toThrow(/listening/)
      await gateway.localCheck(signal)
      await app.close()
      await expect(gateway.localCheck(signal)).rejects.toThrow(/stopping/)
      await expect(gateway.check(signal)).rejects.toThrow(/stopping/)
    } finally {
      await app.close()
      await subscriptions.close()
    }
  })

  it('only an app built with the realtime role listens for upgrades, and serves /ready/local; elsewhere Node treats an upgrade as a request', async () => {
    const plain = buildApp({ appOrigin: APP_ORIGIN, logger: pino({ level: 'silent' }), checks: {} })
    expect(plain.server.listenerCount('upgrade')).toBe(0)
    expect((await plain.inject('/ready/local')).statusCode).toBe(404)
    const realtime = buildApp({
      appOrigin: APP_ORIGIN,
      logger: pino({ level: 'silent' }),
      checks: {},
      realtime: { db: scriptedPool().db, keyPrefix: 'it:unit:' },
    })
    expect(realtime.server.listenerCount('upgrade')).toBe(1)
    // With no subscriptions it never listens on the revocation channels, so neither readiness passes.
    const ready = await realtime.inject('/ready')
    expect(ready.json()).toEqual({ status: 'not ready', checks: { gateway: 'failed' } })
    const local = await realtime.inject('/ready/local')
    expect(local.json()).toEqual({ status: 'not ready', checks: { gateway_local: 'failed' } })
    await Promise.all([plain.close(), realtime.close()])
  })
})

describe('NTS-04 C0.9 PD-45 B-07 C-07 T22 item 30: the gateway’s admission is always wired', () => {
  it('NTS-04: unset, admission is on: a socket whose person hasn’t acknowledged the latest notice, or of an org with none, closes 4403 at accept, after the standing is read read only', async () => {
    for (const standing of ['required', 'unpublished'] as const) {
      const { pool, socket, stop } = await wired({ admission: 'unset', standing })
      try {
        const { closed } = await socket()
        expect(await closed, standing).toBe(4403)
        const read = pool.statements.find(isStandingRead)
        expect(read?.values, standing).toEqual([ORG, [session(1).userId], ORG])
        const texts = pool.texts()
        const begun = texts.lastIndexOf(
          'start transaction isolation level read committed read only',
          texts.indexOf(read?.text ?? ''),
        )
        expect(begun, standing).toBeGreaterThan(-1)
      } finally {
        await stop()
      }
    }
  })

  it('NTS-04: unset, someone who has acknowledged it is admitted and stays open', async () => {
    const { pool, socket, stop } = await wired({ admission: 'unset', standing: 'acknowledged' })
    try {
      const { ws } = await socket()
      for (let i = 0; i < 100 && !pool.statements.some(isStandingRead); i++) await delay(10)
      expect(pool.statements.some(isStandingRead)).toBe(true)
      await delay(50)
      expect(ws.readyState).toBe(WebSocket.OPEN)
    } finally {
      await stop()
    }
  })

  it('NTS-04: admissionForTests replaces the hook, and none turns admission off and reads nothing (C0.7)', async () => {
    const admits = vi.fn(async () => new Set<string>())
    const replaced = await wired({ admission: { admits }, standing: 'acknowledged' })
    try {
      const { closed } = await replaced.socket()
      expect(await closed).toBe(4403)
      expect(admits).toHaveBeenCalledWith(expect.anything(), ORG, [session(1).userId])
      expect(replaced.pool.statements.some(isStandingRead)).toBe(false)
    } finally {
      await replaced.stop()
    }
    const none = await wired({ admission: 'none', standing: 'required' })
    try {
      const { ws } = await none.socket()
      await delay(100)
      expect(ws.readyState).toBe(WebSocket.OPEN)
      expect(none.pool.statements.some(isStandingRead)).toBe(false)
    } finally {
      await none.stop()
    }
  })
})
