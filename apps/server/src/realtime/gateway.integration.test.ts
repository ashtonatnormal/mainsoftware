// The realtime gateway against the Compose stack (BUILD-PLAN C0.7's "Done when"; TECH-SPEC T19): the
// real api, realtime and worker processes, Postgres and Valkey, through the protocol a browser speaks
// (packages/shared gateway.ts). `npm run test:integration` runs it, with the stack up (`docker
// compose up -d --wait`); the harness (testing/stack.ts) builds a throwaway database and Valkey key
// prefix for the run.
//
// What it proves:
//   - the protocol: hello and welcome, the refusals and their closes, topics decided by can() and
//     refused alike whether missing or forbidden (GW-04, GW-05, GW-12);
//   - Rule 6 (R6-10, ACC-05, PRD-80): an ended session's sockets close, and a lost topic is dropped,
//     within 60 s by each path on its own: the api's push, the worker's revocation jobs (the api's
//     publish off, A6, on an app whose periodic check can't fire: NO_PERIODIC_RECHECK) and the
//     re-check (no subscriptions); and the races (T19 item 6);
//   - fan-out across two realtime processes from the org's Valkey stream (GW-10); re-authorise and
//     refetch (GW-09, the owner's decision for T19 item 9): a reconnect decides every topic again,
//     nothing is replayed, and no frame carries a stream position; the reader's reset of an org's
//     sockets when its stream loses continuity, or is trimmed past it (found from the entries'
//     numbers, even mid-read), and none for another topic's burst past the old count cap, since
//     the stream is trimmed by age; the heartbeat (GW-08), the flags nudge (GW-11),
//     readiness (OD-22, P2), and what happens with Valkey cut or frozen and with Postgres cut (T19
//     item 12, P8);
//   - the latency lines (REG-04, REG-05): each path logs revocation_applied with a latency, and a
//     summary follows; no log line holds a phone number, a token or a person's id.
// Tests that need an org of their own (an empty stream, a reader reset, a nudge) make one, so no
// test reads another's state and `-t` on one test works. Team memberships are written as the
// superuser (C0.16 brings the runtime write path), and a C0.16-style producer is played by
// publishAccess() and appendEvent(). PRD-53 allows each number 3 code requests per 10 minutes: no
// person here signs in more than 3 times.
//
// afterAll sweeps the run: every frame any socket was sent passes the strict ServerFrame (ids, codes
// and ints only, and no field for a position), and none holds the id, or the time, of any entry the
// run appended to an org's stream (T19 item 9); no Node warning fired (the harness's stop() also fails on the two P9 guards); no
// frame handler or upgrade failed; and every write a runtime role committed is exempt or had its
// outbox event (testing/writes.ts).
import { randomUUID } from 'node:crypto'
import { GATEWAY_CLOSE, ServerFrame } from '@hearth/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SESSION_COOKIE } from '#src/auth/cookies.ts'
import { SOCKET_RECHECK_MS } from '#src/auth/policy.ts'
import { createLogger } from '#src/logger.ts'
import type { CheckOrg } from '#src/realtime/checks.ts'
import { GATEWAY_POLICY, gatewayPolicy } from '#src/realtime/policy.ts'
import { PUBLISH_TOPIC_EVENT, publishTopicEvent } from '#src/realtime/stream.ts'
import { publishAccess } from '#src/revocation/channels.ts'
import {
  type Client,
  type GatewaySocket,
  NO_PERIODIC_RECHECK,
  type Person,
  type RealtimeApp,
  type Stack,
  startStack,
} from '#src/testing/stack.ts'
import { everyTestPassed, expectEveryWriteCovered } from '#src/testing/writes.ts'
import { createSubscriber } from '#src/valkey.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

let s: Stack
// An api app on the same database without its after-commit publish (A6), so only the worker's
// revocation jobs or the re-check close what its requests end.
let quiet: FastifyInstance
// For the test's own publishes, whose failures are thrown (rethrow), not logged.
const log = createLogger({ logLevel: 'silent', role: 'api' })

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
// Long enough for the re-check a revocation message queues for the person's other sessions (100 ms
// of coalescing, then the lane) to have run.
const RECHECK_SETTLE_MS = GATEWAY_POLICY.targetedDelayMs + 400
// Every stream id publish() was answered, for afterAll's sweep: no frame may carry one (T19 item 9).
const published: string[] = []

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}
function deferred(): Deferred {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

// Polls every 20 ms until check passes, for at most `ms`; then fails with what it last saw.
async function eventually<T>(read: () => Promise<T> | T, check: (value: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (check(value)) return value
    if (Date.now() > deadline) throw new Error(`still not as expected after ${ms} ms: ${JSON.stringify(value)}`)
    await sleep(20)
  }
}

// The socket's close, or a failure if it is still open after `ms`.
async function closeOf(socket: GatewaySocket, ms: number) {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  const closed = await Promise.race([socket.closed, late])
  clearTimeout(timer)
  if (closed === undefined) throw new Error(`the socket was still open after ${ms} ms`)
  return closed
}

// Waits until the realtime app listens on both revocation channels (its full readiness, T19 item 12).
async function ready(app: RealtimeApp, ms = 10_000): Promise<void> {
  await eventually(
    async () => {
      try {
        await app.server.check(new AbortController().signal)
        return true
      } catch {
        return false
      }
    },
    ok => ok,
    ms,
  )
}

// The gateway's check failing, with its reason, or undefined while it passes.
async function gatewayFailure(app: RealtimeApp): Promise<string | undefined> {
  try {
    await app.server.check(new AbortController().signal)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const personTopic = (person: Person) => `person:${person.id}`
const orgTopic = (orgId: string) => `org:${orgId}`
const teamTopic = (team: string) => `team:${team}`

// The same browser on another api app (the quiet one), with its session cookie.
function via(app: FastifyInstance, browser: Client): Client {
  const other = s.client({ app })
  const token = browser.cookie(SESSION_COOKIE)
  if (token === undefined) throw new Error('that client has no session')
  other.setCookie(SESSION_COOKIE, token)
  return other
}

async function deactivate(adminBrowser: Client, person: Person): Promise<void> {
  const reply = await adminBrowser.post('/api/admin/people/deactivate', { person: person.id })
  expect([reply.status, reply.error]).toEqual([200, undefined])
}

// An event on the org's stream, as C0.14's inbox or C0.16's team events will publish one. An ev
// carries no stream id, so a test tells its events apart by type. Answers the entry's stream id.
async function publish(orgId: string, topic: string, type = 'it.changed'): Promise<string> {
  const id = await publishTopicEvent(s.valkey, s.prefix, orgId, { topic, type, ids: {} }, log, { rethrow: true })
  if (id === undefined) throw new Error('the event was not appended')
  published.push(id)
  return id
}

// The types of the evs a socket was sent, in order.
const evTypes = (socket: GatewaySocket) => socket.all('ev').map(frame => frame.type)

// A people signal on the access channel, as C0.16's api will publish after a team or role change.
async function pushPeople(orgId: string, people: readonly string[]): Promise<void> {
  await publishAccess(
    s.valkey,
    s.prefix,
    { v: 1, org: orgId, path: 'push', cause: 'keys_changed', at: Date.now(), people: [...people] },
    log,
    { rethrow: true },
  )
}

// A worker with the production consumers, ready and with its revocation checkpoint in each org (a
// consumer that starts at 'now' skips what committed before it, m6), stopped afterwards.
async function withWorker<T>(work: () => Promise<T>, orgs: readonly string[] = [s.org.id]): Promise<T> {
  const worker = await s.startWorker()
  try {
    await worker.ready()
    for (const orgId of orgs) await s.waitForCheckpoint('revocation', orgId)
    return await work()
  } finally {
    await worker.stop()
  }
}

interface RevocationJob {
  state: string
  idempotency_key: string | null
  subject_id: string | null
  payload: { handler: string; cause: string; person?: string; people?: string[]; sessions?: string[] }
}
const revocationJobs = (person: Person) =>
  s.query<RevocationJob>(
    `select state, idempotency_key, subject_id, payload from jobs
     where kind = 'revocation.handler' and (payload->>'person' = $1 or payload->'people' ? $1)
     order by created_at, payload->>'handler'`,
    [person.id],
  )

const sessionsOf = async (person: Person) =>
  (await s.query<{ id: string }>('select id from sessions where user_id = $1 order by id', [person.id])).map(r => r.id)

// The lines one realtime app logged with this event.
const linesOf = (app: RealtimeApp, event: string) =>
  s.logs.filter(line => line.instance === app.instance && line.event === event)

// Every access message published while work runs, as a test subscriber hears them.
async function accessMessages<T>(work: (messages: Record<string, unknown>[]) => Promise<T>): Promise<T> {
  const listener = createSubscriber(s.valkey, log)
  const messages: Record<string, unknown>[] = []
  listener.on('message', (_channel: string, text: string) => messages.push(JSON.parse(text) as Record<string, unknown>))
  await listener.subscribe(s.names.access)
  try {
    return await work(messages)
  } finally {
    listener.disconnect()
  }
}

describe('C0.7 the realtime gateway on the Compose stack (T19, Rule 6, ACC-05)', () => {
  beforeAll(async () => {
    s = await startStack()
    quiet = await s.startApi({ publishRevoked: false })
  })

  // biome-ignore lint/correctness/noEmptyPattern: the hook takes no fixtures.
  afterAll(async ({}, suite) => {
    if (s === undefined) return
    try {
      // Every frame the server sent is a strict ServerFrame: ids, codes and ints only (T19 item 10),
      // with no field beyond its schema, which has none for a position.
      expect(s.gatewayFrames.length).toBeGreaterThan(0)
      for (const text of s.gatewayFrames) {
        expect(ServerFrame.safeParse(JSON.parse(text)).success, text).toBe(true)
      }
      // No frame holds the stream id, or the time, of an entry the run appended (T19 item 9): the
      // stream's positions never leave the reader.
      expect(published.length).toBeGreaterThan(0)
      const sent = s.gatewayFrames.join('\n')
      for (const id of published) if (sent.includes(id)) expect(sent, id).not.toContain(id)
      for (const ms of new Set(published.map(id => id.split('-')[0] ?? id))) {
        if (sent.includes(ms)) expect(sent, ms).not.toContain(ms)
      }
      // No Node warning fired.
      expect(s.warnings.map(warning => `${warning.name}: ${warning.message}`)).toEqual([])
      // Nothing the gateway does failed in a way only a bug could.
      const bugs = ['ws_frame_failed', 'ws_upgrade_failed', 'stream_reader_stopped', 'topic_event_invalid']
      expect(s.logs.filter(line => bugs.includes(String(line.event)))).toEqual([])
      await expectEveryWriteCovered(s.superuser, 'gateway', { allPassed: everyTestPassed(suite) })
    } finally {
      await s.stop()
    }
  })

  it('GW-12 T19 P5 P7: hello gets welcome with the version, limits and spread; a frame before hello, bad JSON and a binary frame close with 1008; a frame over 4 KiB closes with 1009 or 1006; a client speaking only version 2 gets 1013', async () => {
    const p = await s.person({ pin: s.newPin() })
    const browser = await s.signIn(p)

    const socket = await s.gatewaySocket(browser)
    expect(JSON.parse(socket.texts[0] ?? '')).toEqual({
      v: 1,
      t: 'welcome',
      socket: expect.stringMatching(UUID),
      heartbeatMs: 25_000,
      maxTopics: 100,
      maxTopicsPerFrame: 50,
      maxFrameBytes: 4096,
      reconnectSpreadMs: 5000,
    })
    socket.send({ v: 1, t: 'ping' })
    const pong = await socket.next('pong')
    expect(pong).toMatchObject({ v: 1, t: 'pong', reconnectSpreadMs: 5000 })

    const early = await s.gatewaySocket(browser, { hello: false })
    early.send({ v: 1, t: 'ping' })
    expect(await closeOf(early, 2000)).toMatchObject(GATEWAY_CLOSE.badFrame)

    const badJson = await s.gatewaySocket(browser)
    badJson.send('{"v":1,')
    expect(await closeOf(badJson, 2000)).toMatchObject(GATEWAY_CLOSE.badFrame)

    const binary = await s.gatewaySocket(browser)
    binary.ws.send(Buffer.from([1, 2, 3]))
    expect(await closeOf(binary, 2000)).toMatchObject(GATEWAY_CLOSE.badFrame)

    const big = await s.gatewaySocket(browser)
    big.send(JSON.stringify({ v: 1, t: 'ping', pad: 'x'.repeat(5000) }))
    expect([1006, 1009]).toContain((await closeOf(big, 3000)).code)

    const newer = await s.gatewaySocket(browser, { hello: false })
    newer.send({ v: 2, t: 'hello', versions: [2] })
    expect(await closeOf(newer, 2000)).toMatchObject(GATEWAY_CLOSE.tryAgain)
    expect(newer.all('welcome')).toEqual([])

    // The first socket is untouched.
    expect(socket.open()).toBe(true)
  })

  it('GW-04 GW-05 PRD-108 T19: a person subscribes to their person, org and team topics; another person’s, another org’s, a team they’re not in and an unknown team are refused alike', async () => {
    const p = await s.person({ pin: s.newPin() })
    const other = await s.person()
    const elsewhere = await s.person({ org: 'second' })
    const mine = await s.team()
    const theirs = await s.team()
    await s.addMember(mine, p)
    await s.addMember(theirs, other)
    const socket = await s.gatewaySocket(await s.signIn(p))

    const allowed = [personTopic(p), orgTopic(s.org.id), teamTopic(mine)]
    const granted = await socket.sub(allowed)
    expect(granted).toMatchObject({ ok: allowed, refused: [], retry: [] })

    const forbidden = [personTopic(other), orgTopic(elsewhere.orgId), teamTopic(theirs), teamTopic(randomUUID())]
    const refused = await socket.sub(forbidden)
    expect(refused).toMatchObject({ ok: [], retry: [] })
    expect([...refused.refused].sort()).toEqual([...forbidden].sort())
    // Missing and forbidden alike: one list, no reason, and the same frame shape as a grant, which
    // carries nothing about the org's stream.
    expect(Object.keys(JSON.parse(socket.texts.at(-1) ?? '{}')).sort()).toEqual(
      ['id', 'ok', 'refused', 'retry', 't', 'v'].sort(),
    )
    // Asking again for what is held is acked ok, with no new decision needed.
    expect(await socket.sub([personTopic(p)])).toMatchObject({ ok: [personTopic(p)], refused: [] })
    expect(s.realtime.server.counts().topics).toBeGreaterThanOrEqual(3)
  })

  it('R6-10 ACC-05: a deactivation closes every socket of every device of the person within 60 s by the push (under 2 s)', async () => {
    const other = await s.startRealtime({ recheckMs: SOCKET_RECHECK_MS, subscribe: true })
    await ready(other)
    const admin = await s.person({ roles: ['admin'], pin: s.newPin() })
    const d = await s.person({ pin: s.newPin() })
    const one = await s.signIn(d)
    const two = await s.signIn(d)
    // Two devices, two sockets each, on two realtime processes.
    const sockets = [
      await s.gatewaySocket(one),
      await s.gatewaySocket(one, { url: other.url }),
      await s.gatewaySocket(two),
      await s.gatewaySocket(two, { url: other.url }),
    ]
    for (const socket of sockets) await socket.sub([personTopic(d)])
    const before = [s.realtime.server.counts().closedRevoked, other.server.counts().closedRevoked]
    const adminBrowser = await s.signIn(admin)
    const started = Date.now()
    await deactivate(adminBrowser, d)
    for (const socket of sockets) {
      const closed = await closeOf(socket, 5000)
      expect(closed).toMatchObject(GATEWAY_CLOSE.signedOut)
      expect(closed.at - started).toBeLessThan(2000)
    }
    // The push closed them, two on each process.
    expect([s.realtime.server.counts().closedRevoked, other.server.counts().closedRevoked]).toEqual([
      (before[0] ?? 0) + 2,
      (before[1] ?? 0) + 2,
    ])
    // And neither device can open another.
    expect((await s.openSocket(one)).status).toBe(401)
    expect((await s.openSocket(two, { url: other.url })).status).toBe(401)
  })

  it('R6-10 ACC-05 T19 item 4: a deactivation closes the sockets through the worker’s revocation jobs alone when the api doesn’t publish (under 10 s)', async () => {
    // A realtime app of its own, whose periodic check can't close them first (NO_PERIODIC_RECHECK).
    const app = await s.startRealtime({ ...NO_PERIODIC_RECHECK, subscribe: true })
    await ready(app)
    await withWorker(() =>
      accessMessages(async messages => {
        const admin = await s.person({ roles: ['admin'], pin: s.newPin() })
        const d = await s.person({ pin: s.newPin() })
        const sockets = [
          await s.gatewaySocket(await s.signIn(d), { url: app.url }),
          await s.gatewaySocket(await s.signIn(d), { url: app.url }),
        ]
        const before = app.server.counts()
        const started = Date.now()
        await deactivate(via(quiet, await s.signIn(admin)), d)
        for (const socket of sockets) {
          const closed = await closeOf(socket, 10_000)
          expect(closed).toMatchObject(GATEWAY_CLOSE.signedOut)
          expect(closed.at - started).toBeLessThan(10_000)
        }
        // Closed by the durable path, not the push (off) or a periodic check (none in this app's
        // life).
        const after = app.server.counts()
        expect(after.closedDurable - before.closedDurable).toBe(2)
        expect([after.closedRevoked - before.closedRevoked, after.closedRecheck - before.closedRecheck]).toEqual([0, 0])
        // The sockets job, keyed by its first session and naming no subject, succeeded.
        const ended = await sessionsOf(d)
        const jobs = await eventually(
          () => revocationJobs(d),
          rows => rows.some(row => row.payload.handler === 'sockets' && row.state === 'succeeded'),
        )
        const socketsJob = jobs.find(row => row.payload.handler === 'sockets')
        expect(socketsJob).toMatchObject({ subject_id: null, payload: { cause: 'sessions_ended', person: d.id } })
        expect(new Set(socketsJob?.payload.sessions)).toEqual(new Set(ended))
        expect(socketsJob?.idempotency_key).toBe(`sockets:${socketsJob?.payload.sessions?.[0]}`)
        // A test subscriber heard the access message carrying the sessions.
        const carried = await eventually(
          () => messages.filter(m => Array.isArray(m.sessions)),
          list => list.some(m => ended.every(id => (m.sessions as string[]).includes(id))),
        )
        expect(carried.at(-1)).toMatchObject({ v: 1, org: s.org.id, path: 'durable', cause: 'sessions_ended' })
        // The closes logged their latency, from Postgres's own times (P12): the sockets job's
        // message from its signin.ended event (outbox), the topics job's re-check from the base rows
        // (database), whichever came first (T19 item 13).
        const applied = linesOf(app, 'revocation_applied').filter(
          line => line.handler === 'sockets' && line.path === 'durable',
        )
        expect(applied.length).toBeGreaterThan(0)
        for (const line of applied) {
          expect(line).toMatchObject({
            startSource: line.cause === 'sessions_ended' ? 'outbox' : 'database',
            latencyMs: expect.any(Number),
          })
        }
      }),
    )
  })

  it('T19 item 13: the sockets job starts its latency at the revoking transaction’s signin.ended event, after the locks it waited for, not at its start (revoked_at)', async () => {
    // Long enough to tell the two apart at the clock's millisecond, and well inside the 2 s
    // lock_timeout the deactivation waits under.
    const HELD_MS = 600
    await withWorker(() =>
      accessMessages(async messages => {
        const admin = await s.person({ roles: ['admin'], pin: s.newPin() })
        const d = await s.person({ pin: s.newPin() })
        const socket = await s.gatewaySocket(await s.signIn(d))
        const adminBrowser = via(quiet, await s.signIn(admin))
        // D's person row held FOR SHARE keeps the deactivation's UPDATE waiting after its
        // transaction began, as a sign-in in progress would.
        let deactivating: Promise<Awaited<ReturnType<Client['post']>>> | undefined
        await s.query('begin')
        try {
          await s.query('select id from people where id = $1 for share', [d.id])
          deactivating = adminBrowser.post('/api/admin/people/deactivate', { person: d.id })
          await eventually(
            async () => {
              await s.query('select pg_stat_clear_snapshot()')
              const [row] = await s.query<{ n: number }>(
                "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
              )
              return row?.n ?? 0
            },
            n => n >= 1,
          )
          await sleep(HELD_MS)
        } finally {
          await s.query('commit')
        }
        expect((await deactivating)?.body).toEqual({ status: 'deactivated', sessionsEnded: 1 })
        const [ended] = await s.query<{ id: string; revoked_at: Date }>(
          'select id, revoked_at from sessions where user_id = $1',
          [d.id],
        )
        const [event] = await s.query<{ at: Date }>(
          "select at from outbox_events where type = 'signin.ended' and entity_id = $1",
          [d.id],
        )
        if (ended === undefined || event === undefined) throw new Error('the deactivation ended no session')
        // The transaction's start came before the wait; its event, after.
        expect(event.at.getTime() - ended.revoked_at.getTime()).toBeGreaterThanOrEqual(HELD_MS)
        const [carried] = await eventually(
          () => messages.filter(m => Array.isArray(m.sessions) && (m.sessions as string[]).includes(ended.id)),
          list => list.length > 0,
        )
        expect(carried).toMatchObject({ path: 'durable', cause: 'sessions_ended', at: event.at.getTime() })
        expect(await closeOf(socket, 10_000)).toMatchObject(GATEWAY_CLOSE.signedOut)
      }),
    )
  })

  it('R6-10 ACC-05 T14 item 14: a deactivation closes the sockets through the re-check alone (a realtime app with no subscriptions, re-check 0.5 s)', async () => {
    const lone = await s.startRealtime({ recheckMs: 500, subscribe: false })
    const admin = await s.person({ roles: ['admin'], pin: s.newPin() })
    const d = await s.person({ pin: s.newPin() })
    const socket = await s.gatewaySocket(await s.signIn(d), { url: lone.url })
    await socket.sub([personTopic(d), orgTopic(s.org.id)])
    const started = Date.now()
    await deactivate(await s.signIn(admin), d)
    const closed = await closeOf(socket, 5000)
    expect(closed).toMatchObject(GATEWAY_CLOSE.signedOut)
    expect(closed.at - started).toBeLessThan(2000)
    expect(lone.server.counts()).toMatchObject({ closedRecheck: 1, closedRevoked: 0, closedDurable: 0 })
  })

  it('R6-10 ACC-04: POST /api/auth/sign-out closes this device’s sockets, and POST /api/devices/sign-out closes another of one’s own devices’ sockets, leaving the rest open, by push and through the worker alone', async () => {
    // A realtime app of its own, whose periodic check can't close them first (NO_PERIODIC_RECHECK).
    const app = await s.startRealtime({ ...NO_PERIODIC_RECHECK, subscribe: true })
    await ready(app)
    const on = { url: app.url }
    // By the push: M's three devices.
    const m = await s.person({ pin: s.newPin() })
    const [ma, mb, mc] = [await s.signIn(m), await s.signIn(m), await s.signIn(m)]
    const [sa, sb, sc] = [await s.gatewaySocket(ma, on), await s.gatewaySocket(mb, on), await s.gatewaySocket(mc, on)]
    const pushed = app.server.counts().closedRevoked
    let started = Date.now()
    expect((await ma.post('/api/auth/sign-out', {})).body).toEqual({ status: 'signed_out' })
    expect(await closeOf(sa, 5000)).toMatchObject({ ...GATEWAY_CLOSE.signedOut, at: expect.any(Number) })
    expect((await sa.closed).at - started).toBeLessThan(2000)
    // That close queued a re-check of M's other sessions (T19 item 6), which would count as its
    // own (recheck) a session it found ended: it runs first, so the next close is the push's alone.
    await sleep(RECHECK_SETTLE_MS)
    started = Date.now()
    const mbDevice = (await s.sessionOf(mb)).deviceId
    expect((await mc.post('/api/devices/sign-out', { device: mbDevice })).body).toEqual({
      signedOut: 1,
      current: false,
    })
    expect(await closeOf(sb, 5000)).toMatchObject(GATEWAY_CLOSE.signedOut)
    expect((await sb.closed).at - started).toBeLessThan(2000)
    expect(app.server.counts().closedRevoked).toBe(pushed + 2)

    // Through the worker alone: N's three devices, signed out through the quiet api. A device
    // sign-out appends only signin.ended, so this proves the sockets job and the access channel's
    // sessions by themselves.
    await withWorker(async () => {
      const n = await s.person({ pin: s.newPin() })
      const [nx, ny, nz] = [await s.signIn(n), await s.signIn(n), await s.signIn(n)]
      const [sx, sy, sz] = [await s.gatewaySocket(nx, on), await s.gatewaySocket(ny, on), await s.gatewaySocket(nz, on)]
      const durable = app.server.counts().closedDurable
      const nyDevice = (await s.sessionOf(ny)).deviceId
      started = Date.now()
      expect((await via(quiet, nx).post('/api/auth/sign-out', {})).body).toEqual({ status: 'signed_out' })
      expect(await closeOf(sx, 10_000)).toMatchObject(GATEWAY_CLOSE.signedOut)
      expect((await sx.closed).at - started).toBeLessThan(10_000)
      // As above: the re-check of N's other sessions runs before the next sign-out commits, so the
      // worker's job is what closes the next socket.
      await sleep(RECHECK_SETTLE_MS)
      started = Date.now()
      expect((await via(quiet, nz).post('/api/devices/sign-out', { device: nyDevice })).body).toEqual({
        signedOut: 1,
        current: false,
      })
      expect(await closeOf(sy, 10_000)).toMatchObject(GATEWAY_CLOSE.signedOut)
      expect((await sy.closed).at - started).toBeLessThan(10_000)
      expect(app.server.counts().closedDurable).toBe(durable + 2)
      // Both were sockets jobs; no topics job, since nobody's keys changed.
      const jobs = await eventually(
        () => revocationJobs(n),
        rows => rows.filter(row => row.state === 'succeeded').length === 2,
      )
      expect(jobs.map(row => row.payload.handler)).toEqual(['sockets', 'sockets'])
      // The third device's socket stays open, its session still live.
      await sleep(300)
      expect(sz.open()).toBe(true)
    })
    expect(sc.open()).toBe(true)
  })

  it('R6-10 ACC-04 PRD-53: a PIN reset closes every socket of the person', async () => {
    // A PIN belongs to a privileged holder (D46), and only an Owner resets one.
    const admin = await s.person({ roles: ['owner'], pin: s.newPin() })
    const r = await s.person({ roles: ['leadership'], pin: s.newPin() })
    const sockets = [await s.gatewaySocket(await s.signIn(r)), await s.gatewaySocket(await s.signIn(r))]
    const adminBrowser = await s.signIn(admin)
    const started = Date.now()
    const reset = await adminBrowser.post('/api/admin/people/reset-pin', { person: r.id, identityCheck: 'in_person' })
    expect(reset.body).toEqual({ status: 'pin_reset', sessionsEnded: 2 })
    for (const socket of sockets) {
      const closed = await closeOf(socket, 5000)
      expect(closed).toMatchObject(GATEWAY_CLOSE.signedOut)
      expect(closed.at - started).toBeLessThan(2000)
    }
  })

  it('D46 AQ-05/06 T19 item 13: a privileged session that runs out (168 h) closes its socket by the re-check, its latency from expires_at under 60 s', async () => {
    const lone = await s.startRealtime({ recheckMs: 500, subscribe: false })
    const p = await s.person({ roles: ['leadership'] })
    const browser = await s.signIn(p)
    const socket = await s.gatewaySocket(browser, { url: lone.url })
    await socket.sub([personTopic(p)])
    // A few seconds short of 168 hours, so the record's start (expires_at) is recent.
    await s.age((await s.sessionOf(browser)).id, '167 hours 59 minutes 57 seconds')
    const closed = await closeOf(socket, 10_000)
    expect(closed).toMatchObject(GATEWAY_CLOSE.signedOut)
    const [applied] = linesOf(lone, 'revocation_applied')
    expect(applied).toMatchObject({ path: 'recheck' })
    expect(Number(applied?.latencyMs)).toBeLessThan(60_000)
    expect(s.logs.filter(line => line.instance === lone.instance && Number(line.level) >= 50)).toEqual([])
  })

  it('R6-10 ADM-02: an admin’s sign-out of someone’s devices closes their sockets', async () => {
    const admin = await s.person({ roles: ['admin'], pin: s.newPin() })
    const t = await s.person({ pin: s.newPin() })
    const sockets = [await s.gatewaySocket(await s.signIn(t)), await s.gatewaySocket(await s.signIn(t))]
    const adminBrowser = await s.signIn(admin)
    const started = Date.now()
    const out = await adminBrowser.post('/api/admin/people/sign-out-devices', { person: t.id })
    expect(out.body).toEqual({ signedOut: 2 })
    for (const socket of sockets) {
      const closed = await closeOf(socket, 5000)
      expect(closed).toMatchObject(GATEWAY_CLOSE.signedOut)
      expect(closed.at - started).toBeLessThan(2000)
    }
  })

  it('R6-10 PRD-80 ACC-07: leaving a team drops the team topic within 60 s by the push (publishAccess, as C0.16’s api will), keeping the socket and its other topics', async () => {
    const p = await s.person({ pin: s.newPin() })
    const team = await s.team()
    await s.addMember(team, p)
    const socket = await s.gatewaySocket(await s.signIn(p))
    const topics = [personTopic(p), orgTopic(s.org.id), teamTopic(team)]
    expect(await socket.sub(topics)).toMatchObject({ ok: topics })
    const before = s.realtime.server.counts().dropped.push

    await s.removeMember(team, p)
    const started = Date.now()
    await pushPeople(s.org.id, [p.id])
    expect(await socket.next('dropped', 5000)).toMatchObject({ topics: [teamTopic(team)], reason: 'access' })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(s.realtime.server.counts().dropped.push).toBe(before + 1)

    // The socket and its other topics stay: an event on the person topic arrives, one on the team
    // doesn't.
    expect(socket.open()).toBe(true)
    await publish(s.org.id, personTopic(p), 'it.kept')
    expect(await socket.next('ev')).toEqual({ v: 1, t: 'ev', topic: personTopic(p), type: 'it.kept', ids: {} })
    await publish(s.org.id, teamTopic(team), 'it.team')
    await publish(s.org.id, personTopic(p), 'it.person')
    expect(await socket.next('ev')).toMatchObject({ topic: personTopic(p), type: 'it.person' })
    expect(socket.all('ev').map(frame => frame.topic)).toEqual([personTopic(p), personTopic(p)])
  })

  it('R6-10 PRD-80 T19 item 4: leaving a team drops the topic through the worker’s topics job alone (acl.changed keys with C0.16’s reason)', async () => {
    // A realtime app of its own, whose periodic check can't drop it first (NO_PERIODIC_RECHECK).
    const app = await s.startRealtime({ ...NO_PERIODIC_RECHECK, subscribe: true })
    await ready(app)
    await withWorker(async () => {
      const p = await s.person({ pin: s.newPin() })
      const team = await s.team()
      await s.addMember(team, p)
      const socket = await s.gatewaySocket(await s.signIn(p), { url: app.url })
      expect(await socket.sub([teamTopic(team), personTopic(p)])).toMatchObject({
        ok: [teamTopic(team), personTopic(p)],
      })
      const before = app.server.counts().dropped
      await s.removeMember(team, p)
      const started = Date.now()
      // C0.16 appends this beside the membership change; any reason is read (T16 item 14).
      await s.appendEvent('acl.changed', { change: 'keys', reason: 'team_membership' }, [p.id])
      expect(await socket.next('dropped', 10_000)).toMatchObject({ topics: [teamTopic(team)], reason: 'access' })
      expect(Date.now() - started).toBeLessThan(10_000)
      const after = app.server.counts().dropped
      expect([after.durable - before.durable, after.push - before.push, after.recheck - before.recheck]).toEqual([
        1, 0, 0,
      ])
      const [job] = await eventually(
        () => revocationJobs(p),
        rows => rows.length === 1 && rows[0]?.state === 'succeeded',
      )
      expect(job).toMatchObject({
        subject_id: null,
        idempotency_key: null,
        payload: { handler: 'topics', cause: 'keys_changed', people: [p.id] },
      })
      expect(socket.open()).toBe(true)
    })
  })

  it('R6-10 PRD-80 T19 item 8: leaving a team drops the topic through the re-check alone', async () => {
    const lone = await s.startRealtime({ recheckMs: 500, subscribe: false })
    const p = await s.person({ pin: s.newPin() })
    const team = await s.team()
    await s.addMember(team, p)
    const socket = await s.gatewaySocket(await s.signIn(p), { url: lone.url })
    expect(await socket.sub([teamTopic(team), orgTopic(s.org.id)])).toMatchObject({
      ok: [teamTopic(team), orgTopic(s.org.id)],
    })
    await s.removeMember(team, p)
    const started = Date.now()
    expect(await socket.next('dropped', 5000)).toMatchObject({ topics: [teamTopic(team)], reason: 'access' })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(lone.server.counts().dropped).toEqual({ push: 0, durable: 0, recheck: 1 })
    // Its latency is from the removal's own time.
    expect(linesOf(lone, 'revocation_applied')).toEqual([
      expect.objectContaining({ handler: 'topics', path: 'recheck', startSource: 'database', count: 1 }),
    ])
    expect(socket.open()).toBe(true)
  })

  it('T19 item 6: a subscribe decided before a removal committed is re-checked when the people signal arrives during it', async () => {
    // The lane's decision for one sub is held after its read, until the test lets it go.
    let holding: { reached: Deferred; release: Deferred } | undefined
    const wrapCheck =
      (check: CheckOrg): CheckOrg =>
      async (orgId, request) => {
        const result = await check(orgId, request)
        const hold = holding
        // A sub's own decision names no held topic.
        if (hold !== undefined && (request.held?.size ?? 0) === 0 && (request.topics?.size ?? 0) > 0) {
          holding = undefined
          hold.reached.resolve()
          await hold.release.promise
        }
        return result
      }
    const held = await s.startRealtime({ recheckMs: SOCKET_RECHECK_MS, subscribe: true, wrapCheck })
    await ready(held)
    const p = await s.person({ pin: s.newPin() })
    const team = await s.team()
    await s.addMember(team, p)
    const socket = await s.gatewaySocket(await s.signIn(p), { url: held.url })

    const hold = { reached: deferred(), release: deferred() }
    holding = hold
    socket.send({ v: 1, t: 'sub', id: 7, topics: [teamTopic(team)] })
    // The decision has read the membership, and allowed the topic; the removal commits after it.
    await hold.reached.promise
    await s.removeMember(team, p)
    await pushPeople(s.org.id, [p.id])
    // The signal has arrived (its own re-check waits behind the held decision in the lane).
    await sleep(300)
    hold.release.resolve()
    const released = Date.now()
    expect(await socket.next('ack')).toMatchObject({ id: 7, ok: [teamTopic(team)] })
    expect(await socket.next('dropped', 5000)).toMatchObject({ topics: [teamTopic(team)], reason: 'access' })
    expect(Date.now() - released).toBeLessThan(2000)
    // Acked first, then dropped: the client forgets it.
    expect(socket.frames.map(frame => frame.t)).toEqual(['welcome', 'ack', 'dropped'])
    expect(held.server.counts().dropped.push).toBe(1)
  })

  it('S1 m2 T19 item 6: a device signed out with the api’s publish off can’t subscribe: its next sub closes the socket with 4401, and no ack ok arrives', async () => {
    // No subscriptions and a 15 s check: only the lane's own session statement can find it.
    const lone = await s.startRealtime({ recheckMs: SOCKET_RECHECK_MS, subscribe: false })
    const p = await s.person({ pin: s.newPin() })
    const browser = await s.signIn(p)
    const socket = await s.gatewaySocket(browser, { url: lone.url })
    expect((await via(quiet, browser).post('/api/auth/sign-out', {})).body).toEqual({ status: 'signed_out' })
    socket.send({ v: 1, t: 'sub', id: 1, topics: [personTopic(p), orgTopic(s.org.id)] })
    expect(await closeOf(socket, 5000)).toMatchObject(GATEWAY_CLOSE.signedOut)
    expect(socket.all('ack')).toEqual([])
    // Nothing was granted, and the server's side of the socket is gone with its topics.
    await eventually(
      () => lone.server.counts(),
      counts => counts.open === 0,
    )
    expect(lone.server.counts()).toMatchObject({ closedRecheck: 1, topics: 0 })
    expect(linesOf(lone, 'revocation_applied')).toEqual([
      expect.objectContaining({ handler: 'sockets', path: 'recheck', startSource: 'database' }),
    ])
  })

  it('GW-10 T19 item 9 P12: an event published once reaches subscribers of its topic on both realtime processes, as the same ev with no stream id, and nobody else; with process A’s reader stopped, only B’s subscribers get the next one', async () => {
    const org = await s.newOrg()
    const a = await s.startRealtime({ recheckMs: SOCKET_RECHECK_MS, subscribe: true })
    const b = await s.startRealtime({ recheckMs: SOCKET_RECHECK_MS, subscribe: true })
    const [p1, p2, p3] = [
      await s.person({ org, pin: s.newPin() }),
      await s.person({ org, pin: s.newPin() }),
      await s.person({ org, pin: s.newPin() }),
    ]
    const team = await s.team({ org })
    await s.addMember(team, p1)
    await s.addMember(team, p2)
    const onA = await s.gatewaySocket(await s.signIn(p1), { url: a.url })
    const onB = await s.gatewaySocket(await s.signIn(p2), { url: b.url })
    const bystander = await s.gatewaySocket(await s.signIn(p3), { url: a.url })
    expect(await onA.sub([teamTopic(team)])).toMatchObject({ ok: [teamTopic(team)] })
    expect(await onB.sub([teamTopic(team)])).toMatchObject({ ok: [teamTopic(team)] })
    expect(await bystander.sub([personTopic(p3)])).toMatchObject({ ok: [personTopic(p3)] })

    const first = await publish(org.id, teamTopic(team), 'team.members_changed')
    const [evA, evB] = [await onA.next('ev'), await onB.next('ev')]
    expect(evA).toEqual({ v: 1, t: 'ev', topic: teamTopic(team), type: 'team.members_changed', ids: {} })
    expect(evB).toEqual(evA)
    for (const socket of [onA, onB]) expect(socket.texts.join('\n')).not.toContain(first)

    // A's reader stops for good: its sockets get nothing more; B's still do. disconnect() only ends
    // the connection's writing side, so a reply to the XREAD in flight could still arrive until the
    // connection has closed.
    const ended = new Promise(resolve => a.reader.once('end', resolve))
    a.reader.disconnect()
    await ended
    await publish(org.id, teamTopic(team), 'it.second')
    expect(await onB.next('ev')).toMatchObject({ type: 'it.second' })
    await sleep(500)
    expect(onA.all('ev')).toHaveLength(1)
    expect(bystander.all('ev')).toEqual([])
  })

  it('GW-09 T19 item 9 P1: a client that reconnects, to the other realtime process or the same one, resubscribes and each topic is decided again; nothing it missed is replayed, though both readers dispatched it, and what follows the ack arrives; a sub naming a since closes with 1008', async () => {
    const org = await s.newOrg()
    const a = await s.startRealtime({ recheckMs: SOCKET_RECHECK_MS, subscribe: true })
    const b = await s.startRealtime({ recheckMs: SOCKET_RECHECK_MS, subscribe: true })
    const p = await s.person({ org, pin: s.newPin() })
    const other = await s.person({ org, pin: s.newPin() })
    const team = await s.team({ org })
    await s.addMember(team, p)
    const browser = await s.signIn(p)
    const topics = [personTopic(p), teamTopic(team)]
    // Someone else's sockets on the org topic, one on each process, keep both readers on the org's
    // stream: each step first publishes a marker there and waits until both have dispatched it, so
    // every entry before it has been read, and could have been replayed.
    const otherBrowser = await s.signIn(other)
    const watchers = [
      await s.gatewaySocket(otherBrowser, { url: a.url }),
      await s.gatewaySocket(otherBrowser, { url: b.url }),
    ]
    for (const watcher of watchers) await watcher.sub([orgTopic(org.id)])
    const settle = async (): Promise<void> => {
      await publish(org.id, orgTopic(org.id), 'it.marker')
      for (const watcher of watchers) expect(await watcher.next('ev')).toMatchObject({ type: 'it.marker' })
    }

    const away = await s.gatewaySocket(browser, { url: a.url })
    expect(await away.sub(topics)).toEqual({ v: 1, t: 'ack', id: 1, ok: topics, refused: [], retry: [] })
    await publish(org.id, teamTopic(team), 'it.before')
    expect(await away.next('ev')).toMatchObject({ topic: teamTopic(team), type: 'it.before' })
    away.ws.close()
    await away.closed
    // Missed while away.
    await publish(org.id, teamTopic(team), 'it.missed')
    await publish(org.id, personTopic(other), 'it.missed')
    await publish(org.id, personTopic(p), 'it.missed')
    await settle()

    for (const [name, app] of [
      ['the other process', b],
      ['the same process', a],
    ] as const) {
      const back = await s.gatewaySocket(browser, { url: app.url })
      // A new socket holds nothing: both topics are decided by can() again for its sub.
      const held = app.server.counts().topics
      expect(await back.sub(topics), name).toEqual({ v: 1, t: 'ack', id: 1, ok: topics, refused: [], retry: [] })
      expect(app.server.counts().topics, name).toBe(held + topics.length)
      await settle()
      // Nothing missed was replayed: the client refetches each topic acked ok over REST.
      expect(back.all('ev'), name).toEqual([])
      await publish(org.id, personTopic(p), 'it.live')
      expect(await back.next('ev'), name).toEqual({
        v: 1,
        t: 'ev',
        topic: personTopic(p),
        type: 'it.live',
        ids: {},
      })
      expect(
        back.frames.map(frame => frame.t),
        name,
      ).toEqual(['welcome', 'ack', 'ev'])
      back.ws.close()
      await back.closed
    }

    // An older client's resume, naming a since, is no frame of the protocol: 1008 bad_frame.
    const old = await s.gatewaySocket(browser, { url: b.url })
    old.send({
      v: 1,
      t: 'sub',
      id: 1,
      topics,
      since: { epoch: 'e0000000-0000-4000-8000-000000000001', pos: '1800000000000-0' },
    })
    expect(await closeOf(old, 2000)).toMatchObject(GATEWAY_CLOSE.badFrame)
    expect(old.all('ack')).toEqual([])
  })

  it('T19 item 9: realtime appends nothing to an org’s stream (no tick, no script), and an event on a person topic the socket was refused reaches it in no frame: pong and an unsub’s ack read the same before and after, and no frame holds its stream id', async () => {
    const org = await s.newOrg()
    const app = await s.startRealtime({ recheckMs: SOCKET_RECHECK_MS, subscribe: false })
    const [p, other] = [await s.person({ org, pin: s.newPin() }), await s.person({ org, pin: s.newPin() })]
    const socket = await s.gatewaySocket(await s.signIn(p), { url: app.url })
    expect((await socket.sub([personTopic(p)])).ok).toEqual([personTopic(p)])
    expect((await socket.sub([personTopic(other)])).refused).toEqual([personTopic(other)])
    const told = async () => {
      socket.send({ v: 1, t: 'ping' })
      const pong = await socket.next('pong')
      const ack = await socket.unsub([orgTopic(org.id)])
      return { pong, ack: { ...ack, id: 0 } }
    }
    // Several of the reader's blocks later, the org still has no stream: nothing wrote one.
    await sleep(2500)
    expect(await s.valkey.exists(s.names.stream(org.id))).toBe(0)
    const before = await told()
    const theirs = await publish(org.id, personTopic(other), 'it.theirs')
    const mine = await publish(org.id, personTopic(p), 'it.mine')
    // The reader has read past their entry once it sends this socket its own.
    expect(await socket.next('ev')).toMatchObject({ type: 'it.mine' })
    expect(await told()).toEqual(before)
    expect(evTypes(socket)).toEqual(['it.mine'])
    for (const id of [theirs, mine]) {
      expect(socket.texts.join('\n')).not.toContain(id)
      expect(socket.texts.join('\n')).not.toContain(id.split('-')[0])
    }
    // The stream holds the two entries published, and nothing realtime added.
    await sleep(500)
    expect((await s.valkey.xrange(s.names.stream(org.id), '-', '+')).map(([id]) => id)).toEqual([theirs, mine])
  })

  it('T19 item 9 S6: when the org’s stream loses continuity (its epoch lost; its tail lost after the reader read it), the reader resets every socket of the org that holds a topic, naming that socket’s own topics, and events flow again after', async () => {
    const org = await s.newOrg()
    // The reader's gap checks every 0.2 s, and the org's resets at most 0.5 s apart (5 s in
    // production), so the second loss's reset needn't wait out the first's window.
    const app = await s.startRealtime({
      recheckMs: SOCKET_RECHECK_MS,
      subscribe: true,
      policy: { readerEpochCheckMs: 200, readerBlockMs: 500, resetCoalesceMs: 500 },
    })
    const [p, q] = [await s.person({ org, pin: s.newPin() }), await s.person({ org, pin: s.newPin() })]
    const outsider = await s.person({ pin: s.newPin() })
    const pBrowser = await s.signIn(p)
    const holding = await s.gatewaySocket(pBrowser, { url: app.url })
    expect((await holding.sub([personTopic(p), orgTopic(org.id)])).ok).toHaveLength(2)
    const idle = await s.gatewaySocket(pBrowser, { url: app.url })
    const qSocket = await s.gatewaySocket(await s.signIn(q), { url: app.url })
    expect((await qSocket.sub([personTopic(q)])).ok).toEqual([personTopic(q)])
    const elsewhere = await s.gatewaySocket(await s.signIn(outsider), { url: app.url })
    expect((await elsewhere.sub([personTopic(outsider)])).ok).toEqual([personTopic(outsider)])
    await publish(org.id, orgTopic(org.id), 'it.first')
    await holding.next('ev')
    const resets = () => linesOf(app, 'stream_reset').filter(line => line.org === org.id)
    const sentBefore = app.server.counts().resets

    // The epoch lost, as a restart without persistence loses it.
    await s.valkey.del(s.names.epoch(org.id))
    expect(await holding.next('reset', 5000)).toEqual({
      v: 1,
      t: 'reset',
      topics: [personTopic(p), orgTopic(org.id)],
      reason: 'gap',
    })
    expect(await qSocket.next('reset', 5000)).toEqual({ v: 1, t: 'reset', topics: [personTopic(q)], reason: 'gap' })
    expect(resets().map(line => line.reason)).toEqual(['epoch'])

    // The tail lost after the reader read it, as a failover to a replica that lacked it loses it:
    // the entry, and the count of entries added that numbers the next one. The stream is written
    // again in one MULTI with only the entries up to it-second, under their own ids, so its count
    // is back at it-second's number, as on the replica.
    const second = await publish(org.id, orgTopic(org.id), 'it.second')
    await publish(org.id, orgTopic(org.id), 'it.lost')
    expect(await holding.next('ev')).toMatchObject({ type: 'it.second' })
    expect(await holding.next('ev')).toMatchObject({ type: 'it.lost' })
    const stream = s.names.stream(org.id)
    const kept = await s.valkey.xrange(stream, '-', second)
    expect(kept.map(([, fields]) => fields[fields.indexOf('n') + 1])).toEqual(kept.map((_, i) => String(i + 1)))
    const rewrite = s.valkey.multi().del(stream)
    for (const [id, fields] of kept) rewrite.xadd(stream, id, ...fields)
    rewrite.pexpire(stream, GATEWAY_POLICY.streamTtlMs)
    expect(((await rewrite.exec()) ?? []).filter(([error]) => error !== null)).toEqual([])
    expect(await holding.next('reset', 5000)).toMatchObject({ topics: [personTopic(p), orgTopic(org.id)] })
    expect(await qSocket.next('reset', 5000)).toMatchObject({ topics: [personTopic(q)] })
    expect(resets().map(line => line.reason)).toEqual(['epoch', 'tail_lost'])
    expect(app.server.counts().resets).toBe(sentBefore + 4)

    // A socket holding no topic, and another org's, were told nothing.
    expect(idle.all('reset')).toEqual([])
    expect(elsewhere.all('reset')).toEqual([])
    // The reader goes on from the stream's tail.
    await publish(org.id, personTopic(q), 'it.after')
    expect(await qSocket.next('ev')).toMatchObject({ type: 'it.after' })
    for (const socket of [holding, idle, qSocket, elsewhere]) expect(socket.open()).toBe(true)
  })

  it('T19 item 9 GW-10: a burst of 12,000 events on another member’s topic (past the old 10,000 cap, through the production script, concurrently) reaches a member holding only their own topic in no frame: no reset, since the stream is trimmed by age and nothing was; every entry is numbered by the stream’s own count', async () => {
    const org = await s.newOrg()
    const app = await s.startRealtime({
      recheckMs: SOCKET_RECHECK_MS,
      subscribe: true,
      policy: { readerEpochCheckMs: 200, readerBlockMs: 500 },
    })
    const [a, b] = [await s.person({ org, pin: s.newPin() }), await s.person({ org })]
    const socket = await s.gatewaySocket(await s.signIn(a), { url: app.url })
    expect((await socket.sub([personTopic(a)])).ok).toEqual([personTopic(a)])
    const ids = await Promise.all(
      Array.from({ length: 12_000 }, (_, i) =>
        publishTopicEvent(
          s.valkey,
          s.prefix,
          org.id,
          { topic: personTopic(b), type: 'it.burst', ids: { count: i } },
          log,
          { rethrow: true },
        ),
      ),
    )
    for (const id of ids) if (id !== undefined) published.push(id)
    expect(ids.filter(id => id !== undefined)).toHaveLength(12_000)
    await publish(org.id, personTopic(a), 'it.mine')
    // The reader has read every entry before its own once it sends this socket its own, and has
    // checked the org several times meanwhile.
    expect(await socket.next('ev', 10_000)).toMatchObject({ type: 'it.mine' })
    await sleep(1000)
    expect(socket.frames.map(frame => frame.t)).toEqual(['welcome', 'ack', 'ev'])
    expect(linesOf(app, 'stream_reset').filter(line => line.org === org.id)).toEqual([])
    // Nothing trimmed, and each entry numbered one more than the one before: the first 1, the last
    // the stream's entries-added (the script reads it with XINFO STREAM).
    const stream = s.names.stream(org.id)
    expect(await s.valkey.xlen(stream)).toBe(12_001)
    const info = (await s.valkey.xinfo('STREAM', stream)) as unknown[]
    expect(info[info.indexOf('entries-added') + 1]).toBe(12_001)
    const [[, firstFields] = ['', []]] = await s.valkey.xrange(stream, '-', '+', 'COUNT', 1)
    const [[, lastFields] = ['', []]] = await s.valkey.xrevrange(stream, '+', '-', 'COUNT', 1)
    expect([firstFields.slice(0, 2), lastFields.slice(0, 2)]).toEqual([
      ['n', '1'],
      ['n', '12001'],
    ])
  })

  it('T19 item 9 S6: a trim that lands while the reader’s XREAD is blocked in flight (one MULTI of the production script, past a backstop of 100) is found by the read from its entries’ numbers: the member whose own event was trimmed gets a reset, never silence', async () => {
    const org = await s.newOrg()
    const app = await s.startRealtime({ recheckMs: SOCKET_RECHECK_MS, subscribe: true })
    const [a, b] = [await s.person({ org, pin: s.newPin() }), await s.person({ org })]
    const socket = await s.gatewaySocket(await s.signIn(a), { url: app.url })
    expect((await socket.sub([personTopic(a)])).ok).toEqual([personTopic(a)])
    // Also loads the script, so the MULTI's EVALSHAs find it.
    await publish(org.id, personTopic(a), 'it.first')
    expect(await socket.next('ev')).toMatchObject({ type: 'it.first' })
    // The reader is back in XREAD BLOCK, its checks long passed.
    await sleep(500)
    const keys = [s.names.stream(org.id), s.names.epoch(org.id)]
    const backstop = gatewayPolicy({ streamMaxLen: 100 })
    const args = (topic: string, type: string) => [
      backstop.streamMaxAgeMs,
      backstop.streamMaxLen,
      backstop.streamTtlMs,
      randomUUID(),
      JSON.stringify({ v: 1, k: 'ev', topic, type, ids: {} }),
    ]
    const multi = s.valkey.multi()
    multi.evalsha(PUBLISH_TOPIC_EVENT.sha, 2, ...keys, ...args(personTopic(a), 'it.lost'))
    for (let i = 0; i < 1000; i++)
      multi.evalsha(PUBLISH_TOPIC_EVENT.sha, 2, ...keys, ...args(personTopic(b), 'it.bulk'))
    const replies = (await multi.exec()) ?? []
    expect(replies.filter(([error]) => error !== null)).toEqual([])
    for (const [, id] of replies) published.push(String(id))
    expect(await socket.next('reset', 5000)).toEqual({ v: 1, t: 'reset', topics: [personTopic(a)], reason: 'gap' })
    expect(
      linesOf(app, 'stream_reset')
        .filter(line => line.org === org.id)
        .map(line => line.reason),
    ).toEqual(['trimmed'])
    // Its own trimmed event never arrives as an ev: the reset covers it.
    await sleep(500)
    expect(evTypes(socket)).toEqual(['it.first'])
  })

  it('T19 item 9 P4: a reader outrun again and again by other topics’ events (MULTIs of the production script past a backstop of 100) finds a gap at each read, but a member holding only their own topic gets one reset at once and one at the end of the 5 s window, not one a read', async () => {
    const org = await s.newOrg()
    // The production policy: resets coalesced per org over 5 s.
    const app = await s.startRealtime({ recheckMs: SOCKET_RECHECK_MS, subscribe: true })
    const [a, b] = [await s.person({ org, pin: s.newPin() }), await s.person({ org })]
    const socket = await s.gatewaySocket(await s.signIn(a), { url: app.url })
    expect((await socket.sub([personTopic(a)])).ok).toEqual([personTopic(a)])
    const resetAt: number[] = []
    socket.ws.on('message', data => {
      if ((JSON.parse(String(data)) as { t: string }).t === 'reset') resetAt.push(Date.now())
    })
    // Also loads the script, so the MULTIs' EVALSHAs find it.
    await publish(org.id, personTopic(a), 'it.first')
    expect(await socket.next('ev')).toMatchObject({ type: 'it.first' })
    const keys = [s.names.stream(org.id), s.names.epoch(org.id)]
    const backstop = gatewayPolicy({ streamMaxLen: 100 })
    const found = () => linesOf(app, 'stream_reset').filter(line => line.org === org.id)
    // Four overloads in a row on another member's topic, each trimming entries past the reader's
    // position before it reads them, each found by the read after it.
    for (let round = 1; round <= 4; round++) {
      const multi = s.valkey.multi()
      for (let i = 0; i < 1000; i++) {
        multi.evalsha(
          PUBLISH_TOPIC_EVENT.sha,
          2,
          ...keys,
          backstop.streamMaxAgeMs,
          backstop.streamMaxLen,
          backstop.streamTtlMs,
          randomUUID(),
          JSON.stringify({ v: 1, k: 'ev', topic: personTopic(b), type: 'it.bulk', ids: {} }),
        )
      }
      const replies = (await multi.exec()) ?? []
      expect(replies.filter(([error]) => error !== null)).toEqual([])
      for (const [, id] of replies) published.push(String(id))
      await eventually(
        () => found().length,
        n => n === round,
        5000,
      )
    }
    expect(found().map(line => line.reason)).toEqual(['trimmed', 'trimmed', 'trimmed', 'trimmed'])
    // The first gap's reset went at once; the three found within its window go as one at its end.
    await eventually(
      () => resetAt.length,
      n => n === 2,
      GATEWAY_POLICY.resetCoalesceMs + 3000,
    )
    await sleep(1000)
    expect(resetAt).toHaveLength(2)
    expect((resetAt[1] ?? 0) - (resetAt[0] ?? 0)).toBeGreaterThanOrEqual(GATEWAY_POLICY.resetCoalesceMs - 100)
    expect(socket.all('reset')).toEqual([
      { v: 1, t: 'reset', topics: [personTopic(a)], reason: 'gap' },
      { v: 1, t: 'reset', topics: [personTopic(a)], reason: 'gap' },
    ])
    expect(app.server.counts().resets).toBe(2)
    // None of the other member's events reached this socket, and its own flow on.
    expect(evTypes(socket)).toEqual(['it.first'])
    await publish(org.id, personTopic(a), 'it.after')
    expect(await socket.next('ev')).toMatchObject({ type: 'it.after' })
  })

  it('T19 item 9 S6: each append trims entries older than the age limit by Valkey’s clock; a live reader whose own last entry went with them resets nothing, and a reader stalled past the limit (its Valkey frozen) resets with trimmed, a fact about the server', async () => {
    const org = await s.newOrg()
    const valkey = await s.proxy('valkey')
    const fast = {
      recheckMs: SOCKET_RECHECK_MS,
      subscribe: true,
      policy: { readerEpochCheckMs: 200, readerBlockMs: 500 },
    }
    const live = await s.startRealtime(fast)
    const stalled = await s.startRealtime({ ...fast, valkeyUrl: valkey.url })
    const [a, b] = [await s.person({ org, pin: s.newPin() }), await s.person({ org })]
    const browser = await s.signIn(a)
    const onLive = await s.gatewaySocket(browser, { url: live.url })
    const onStalled = await s.gatewaySocket(browser, { url: stalled.url })
    for (const socket of [onLive, onStalled]) expect((await socket.sub([personTopic(a)])).ok).toEqual([personTopic(a)])
    await publish(org.id, personTopic(a), 'it.first')
    for (const socket of [onLive, onStalled]) expect(await socket.next('ev')).toMatchObject({ type: 'it.first' })

    // A 1 s age limit (a producer's policy; the default is 60 s).
    const young = gatewayPolicy({ streamMaxAgeMs: 1000, readerStuckMs: 500 })
    const publishYoung = async (topic: string, type: string) => {
      const id = await publishTopicEvent(s.valkey, s.prefix, org.id, { topic, type, ids: {} }, log, {
        rethrow: true,
        policy: young,
      })
      if (id === undefined) throw new Error('the event was not appended')
      published.push(id)
      return id
    }
    valkey.proxy.freeze({ hold: true })
    await sleep(300)
    for (let i = 0; i < 150; i++) await publishYoung(personTopic(b), 'it.other')
    await sleep(1200)
    await publishYoung(personTopic(a), 'it.after')
    // The head went: entries older than a second, the first among them, were trimmed by this append.
    const stream = s.names.stream(org.id)
    const [[, headFields] = ['', []]] = await s.valkey.xrange(stream, '-', '+', 'COUNT', 1)
    expect(Number(headFields[headFields.indexOf('n') + 1])).toBeGreaterThan(2)

    // The live reader had read everything: its last entry trimmed is no gap.
    expect(await onLive.next('ev')).toMatchObject({ type: 'it.after' })
    expect(onLive.all('reset')).toEqual([])
    // The stalled one finds entries after its position gone once it reads again.
    valkey.proxy.restore()
    expect(await onStalled.next('reset', 8000)).toEqual({ v: 1, t: 'reset', topics: [personTopic(a)], reason: 'gap' })
    expect(await onStalled.next('ev', 5000)).toMatchObject({ type: 'it.after' })
    await sleep(500)
    expect(linesOf(live, 'stream_reset').filter(line => line.org === org.id)).toEqual([])
    expect(
      linesOf(stalled, 'stream_reset')
        .filter(line => line.org === org.id)
        .map(line => line.reason),
    ).toEqual(['trimmed'])
  })

  it('GW-09 Rule 6: a reconnect re-authorises every topic: one lost while away is refused, one left and rejoined is ok again (decided now), none of the missed events is replayed, and later events reach only the topics held', async () => {
    const org = await s.newOrg()
    const p = await s.person({ org, pin: s.newPin() })
    const watching = await s.person({ org, pin: s.newPin() })
    const [left, rejoined] = [await s.team({ org }), await s.team({ org })]
    await s.addMember(left, p)
    await s.addMember(rejoined, p)
    const browser = await s.signIn(p)
    const topics = [teamTopic(left), teamTopic(rejoined), personTopic(p)]
    // Someone else's socket keeps the reader on the org's stream; a marker it has seen means the
    // reader has dispatched everything before it (as in the reconnect test above).
    const watcher = await s.gatewaySocket(await s.signIn(watching))
    await watcher.sub([orgTopic(org.id)])
    const settle = async (): Promise<void> => {
      await publish(org.id, orgTopic(org.id), 'it.marker')
      expect(await watcher.next('ev')).toMatchObject({ type: 'it.marker' })
    }

    const socket = await s.gatewaySocket(browser)
    expect((await socket.sub(topics)).ok).toEqual(topics)
    socket.ws.close()
    await socket.closed

    // While away: removed from one team, out of and back into the other, with events on each.
    await s.removeMember(left, p)
    await publish(org.id, teamTopic(left), 'it.missed')
    await s.removeMember(rejoined, p)
    await publish(org.id, teamTopic(rejoined), 'it.missed')
    await s.addMember(rejoined, p)
    await publish(org.id, personTopic(p), 'it.missed')
    await settle()

    const back = await s.gatewaySocket(browser)
    expect(await back.sub(topics)).toEqual({
      v: 1,
      t: 'ack',
      id: 1,
      ok: [teamTopic(rejoined), personTopic(p)],
      refused: [teamTopic(left)],
      retry: [],
    })
    await settle()
    expect(back.all('ev')).toEqual([])
    // Later events: the held topics' arrive, the refused team's doesn't.
    await publish(org.id, teamTopic(left), 'it.left')
    await publish(org.id, teamTopic(rejoined), 'it.rejoined')
    await publish(org.id, personTopic(p), 'it.person')
    await settle()
    expect(back.all('ev').map(frame => [frame.topic, frame.type])).toEqual([
      [teamTopic(rejoined), 'it.rejoined'],
      [personTopic(p), 'it.person'],
    ])
  })

  it('GW-08 T19 item 12: the server pings; a client that stops answering pongs is terminated after the dead limit (policy 200/550 ms); an app ping gets pong', async () => {
    const app = await s.startRealtime({
      recheckMs: SOCKET_RECHECK_MS,
      subscribe: false,
      policy: { heartbeatMs: 200, deadAfterMs: 550, heartbeatSweepMs: 50 },
    })
    const p = await s.person({ pin: s.newPin() })
    const browser = await s.signIn(p)
    const alive = await s.gatewaySocket(browser, { url: app.url })
    let pings = 0
    alive.ws.on('ping', () => {
      pings++
    })
    const silent = await s.gatewaySocket(browser, { url: app.url, autoPong: false })
    const started = Date.now()
    const dead = await closeOf(silent, 3000)
    expect(dead.code).toBe(1006)
    expect(dead.at - started).toBeGreaterThanOrEqual(400)
    expect(app.server.counts().closedDead).toBe(1)
    // The one that answers stays, pinged all the while.
    await sleep(500)
    expect(pings).toBeGreaterThanOrEqual(3)
    expect(alive.open()).toBe(true)
    alive.send({ v: 1, t: 'ping' })
    expect(await alive.next('pong')).toMatchObject({ t: 'pong', reconnectSpreadMs: 5000 })
  })

  it('GW-11 T17 item 11 P4: changing a client flag through the api nudges every socket of the org, on the trailing edge, with no values; a server-only flag nudges nobody', async () => {
    const org = await s.newOrg()
    const admin = await s.person({ org, roles: ['admin'], pin: s.newPin() })
    const member = await s.person({ org, pin: s.newPin() })
    const outsider = await s.person({ pin: s.newPin() })
    const adminBrowser = await s.signIn(admin)
    const sockets = [await s.gatewaySocket(adminBrowser), await s.gatewaySocket(await s.signIn(member))]
    const elsewhere = await s.gatewaySocket(await s.signIn(outsider))
    // Realtime keeps the org's flags from the first socket on; a change it hadn't loaded yet would be
    // read as the starting value, with nothing to nudge.
    await eventually(
      () => s.realtimeFlags.confirmedAt(org.id),
      at => at !== undefined,
    )
    const set = async (key: string, enabled: boolean) => {
      const reply = await adminBrowser.post('/api/admin/flags/set', { key, enabled })
      expect([reply.status, reply.error]).toEqual([200, undefined])
    }

    await set('it.client', false)
    const first = await Promise.all(sockets.map(socket => socket.next('nudge', 5000)))
    const firstAt = Date.now()
    for (const nudge of first) expect(nudge).toEqual({ v: 1, t: 'nudge', what: 'flags' })
    expect(sockets.map(socket => JSON.parse(socket.texts.at(-1) ?? '{}'))).toEqual([
      { v: 1, t: 'nudge', what: 'flags' },
      { v: 1, t: 'nudge', what: 'flags' },
    ])
    // A second change within the second: one more nudge, a second after the first.
    await set('it.client', true)
    await Promise.all(sockets.map(socket => socket.next('nudge', 5000)))
    expect(Date.now() - firstAt).toBeGreaterThanOrEqual(900)

    // A server-only flag: nobody is nudged.
    await set('it.optional', false)
    await sleep(1500)
    for (const socket of sockets) expect(socket.all('nudge')).toHaveLength(2)
    expect(elsewhere.all('nudge')).toEqual([])
  })

  it('T19 item 12 P2, Valkey down: with the realtime app’s Valkey cut, sockets stay open, a deactivation still closes them by the re-check, a sub is still acked, the full readiness fails and /ready/local stays 200; when Valkey is back the channels are subscribed again, the reader resets the org if its epoch changed, and resets an org whose stream it couldn’t read when its sub was acked', async () => {
    const org = await s.newOrg()
    const valkey = await s.proxy('valkey')
    const app = await s.startRealtime({
      recheckMs: 500,
      subscribe: true,
      valkeyUrl: valkey.url,
      policy: { readerEpochCheckMs: 200 },
    })
    await ready(app)
    const admin = await s.person({ org, roles: ['admin'], pin: s.newPin() })
    const leaver = await s.person({ org, pin: s.newPin() })
    const stays = await s.person({ org, pin: s.newPin() })
    const leaving = await s.gatewaySocket(await s.signIn(leaver), { url: app.url })
    const staying = await s.gatewaySocket(await s.signIn(stays), { url: app.url })
    expect((await staying.sub([personTopic(stays)])).ok).toEqual([personTopic(stays)])
    // Someone of another org, whose first socket arrives while Valkey is cut.
    const lateOrg = await s.newOrg()
    const late = await s.person({ org: lateOrg, pin: s.newPin() })
    const lateBrowser = await s.signIn(late)

    valkey.proxy.cut()
    const full = await eventually(
      () => app.readiness('/ready'),
      r => r.status === 503 && r.body.checks.gateway === 'failed',
    )
    expect(full.body.checks).toMatchObject({ valkey: 'failed', gateway: 'failed', postgres: 'ok' })
    expect((await app.readiness('/ready/local')).status).toBe(200)
    expect([leaving.open(), staying.open()]).toEqual([true, true])

    // The api's push goes to a Valkey this app can't hear: the re-check closes the socket.
    const started = Date.now()
    await deactivate(await s.signIn(admin), leaver)
    const closed = await closeOf(leaving, 5000)
    expect(closed).toMatchObject(GATEWAY_CLOSE.signedOut)
    expect(closed.at - started).toBeLessThan(2000)
    expect(app.server.counts()).toMatchObject({ closedRecheck: 1, closedRevoked: 0 })
    expect(staying.open()).toBe(true)

    // The reader can't read the late org's stream, but its sub is acked: with Valkey cut, ready()
    // answers false at once (against a silent Valkey, within the command client's 1 s timeout).
    const lateSocket = await s.gatewaySocket(lateBrowser, { url: app.url })
    expect(await lateSocket.sub([personTopic(late)])).toMatchObject({ ok: [personTopic(late)], retry: [] })

    // Valkey comes back without the org's epoch, as a restart without persistence would.
    await s.valkey.del(s.names.epoch(org.id))
    valkey.proxy.restore()
    await ready(app)
    // The gateway's check reads the subscriber; /ready's valkey check pings the command client, which
    // reconnects on its own back-off and may still be down when the subscriber is back.
    const back = await eventually(
      () => app.readiness('/ready'),
      r => r.status === 200,
    )
    expect(back.body.checks).toEqual({ postgres: 'ok', valkey: 'ok', gateway: 'ok' })
    expect(await staying.next('reset', 10_000)).toEqual({
      v: 1,
      t: 'reset',
      topics: [personTopic(stays)],
      reason: 'gap',
    })
    expect(staying.open()).toBe(true)
    // The late org's first read of its stream resets its socket, whose sub was acked without one.
    expect(await lateSocket.next('reset', 10_000)).toEqual({
      v: 1,
      t: 'reset',
      topics: [personTopic(late)],
      reason: 'gap',
    })
    const reasons = (orgId: string) =>
      linesOf(app, 'stream_reset')
        .filter(line => line.org === orgId)
        .map(line => line.reason)
    expect(reasons(org.id)).toEqual(['epoch'])
    expect(reasons(lateOrg.id)).toEqual(['late_start'])
    // Its events reach it from then on.
    await publish(lateOrg.id, personTopic(late), 'it.late')
    expect(await lateSocket.next('ev', 5000)).toMatchObject({ type: 'it.late' })
  })

  it('OD-30 P12, a half-open Valkey: with one realtime app’s subscriber and reader frozen (proxy.freeze()), within about 7 s isLive turns false and the full readiness fails while /ready/local passes; after restore() both subscribe again, the reader resumes, and a revoked publish closes a socket', async () => {
    const org = await s.newOrg()
    const valkey = await s.proxy('valkey')
    const app = await s.startRealtime({ recheckMs: SOCKET_RECHECK_MS, subscribe: true, valkeyUrl: valkey.url })
    await ready(app)
    const admin = await s.person({ org, roles: ['admin'], pin: s.newPin() })
    const p = await s.person({ org, pin: s.newPin() })
    const socket = await s.gatewaySocket(await s.signIn(p), { url: app.url })
    await socket.sub([personTopic(p)])

    // Silent, not closed: every link stops forwarding, and so do the ones made while frozen.
    valkey.proxy.freeze({ hold: true })
    const frozenAt = Date.now()
    await eventually(
      () => gatewayFailure(app),
      failure => failure?.includes('listening') === true,
      12_000,
    )
    console.info(`frozen Valkey to a revocation channel found dead: ${Date.now() - frozenAt} ms`)
    expect(Date.now() - frozenAt).toBeLessThan(10_000)
    expect((await app.readiness('/ready')).status).toBe(503)
    expect((await app.readiness('/ready/local')).status).toBe(200)
    expect(socket.open()).toBe(true)

    const subscribedBefore = linesOf(app, 'channel_subscribed').length
    valkey.proxy.restore()
    await ready(app, 15_000)
    const again = linesOf(app, 'channel_subscribed').slice(subscribedBefore)
    expect(new Set(again.map(line => line.channel))).toEqual(new Set(['revoked', 'access', 'flags']))
    // The reader reads again.
    await publish(org.id, personTopic(p), 'it.after_freeze')
    expect(await socket.next('ev', 10_000)).toMatchObject({ type: 'it.after_freeze' })
    // And the push reaches it again.
    const started = Date.now()
    await deactivate(await s.signIn(admin), p)
    const closed = await closeOf(socket, 5000)
    expect(closed).toMatchObject(GATEWAY_CLOSE.signedOut)
    expect(closed.at - started).toBeLessThan(2000)
    expect(app.server.counts().closedRevoked).toBe(1)
  })

  it('T19 item 8 P8, Postgres down: with the realtime app’s database cut, sockets close with 1013 within revokeWithinMs (3 s policy), never 4401; upgrades get 503; a sub during the outage answers retry and closes nothing', async () => {
    const postgres = await s.proxy('postgres')
    const app = await s.startRealtime({
      recheckMs: 500,
      recheckTimeoutMs: 500,
      revokeWithinMs: 3000,
      subscribe: true,
      databaseUrl: postgres.url,
    })
    await ready(app)
    const p = await s.person({ pin: s.newPin() })
    const browser = await s.signIn(p)
    const holding = await s.gatewaySocket(browser, { url: app.url })
    expect(await holding.sub([personTopic(p)])).toMatchObject({ ok: [personTopic(p)] })
    const asking = await s.gatewaySocket(browser, { url: app.url })
    // A check has confirmed both.
    await sleep(600)

    postgres.proxy.cut()
    const cutAt = Date.now()
    const retried = await asking.sub([orgTopic(s.org.id)])
    expect(retried).toMatchObject({ ok: [], refused: [], retry: [orgTopic(s.org.id)] })
    expect([holding.open(), asking.open()]).toEqual([true, true])
    expect((await s.openSocket(browser, { url: app.url })).status).toBe(503)

    for (const socket of [holding, asking]) {
      const closed = await closeOf(socket, 5000)
      expect(closed).toMatchObject(GATEWAY_CLOSE.tryAgain)
      expect(closed.at - cutAt).toBeLessThan(3000)
    }
    expect(app.server.counts()).toMatchObject({ closedRecheck: 0, closedRevoked: 0, closedDurable: 0 })
    expect(app.server.counts().closedUnchecked).toBe(2)
    expect((await app.readiness('/ready/local')).status).toBe(200)

    // Once Postgres is back, the client's reconnect opens.
    postgres.proxy.restore()
    const reopened = await eventually(
      () => s.openSocket(browser, { url: app.url }),
      opened => opened.status === 101,
    )
    if ('ws' in reopened) reopened.ws.close()
  })

  it('REG-04 REG-05 T19 item 13: each path logs revocation_applied with its handler, path and a latency, and a summary follows; no log line holds a phone number, a token or a person’s id', async () => {
    // The push and durable lines come from an app whose periodic check can't close the sockets first
    // (NO_PERIODIC_RECHECK); the re-check's, from one with no subscriptions.
    const pushing = await s.startRealtime({ ...NO_PERIODIC_RECHECK, subscribe: true, policy: { metricsMs: 300 } })
    const checking = await s.startRealtime({ recheckMs: 500, subscribe: false, policy: { metricsMs: 300 } })
    await ready(pushing)
    const people: Person[] = []
    const make = async (roles: 'admin'[] = []) => {
      const made = await s.person({ roles, pin: s.newPin() })
      people.push(made)
      return made
    }
    const admin = await make(['admin'])
    const adminBrowser = await s.signIn(admin)

    await withWorker(async () => {
      // push: a deactivation the api publishes.
      const byPush = await make()
      const pushed = await s.gatewaySocket(await s.signIn(byPush), { url: pushing.url })
      await deactivate(adminBrowser, byPush)
      await closeOf(pushed, 5000)
      // durable: one the api doesn't.
      const byWorker = await make()
      const durable = await s.gatewaySocket(await s.signIn(byWorker), { url: pushing.url })
      await deactivate(via(quiet, adminBrowser), byWorker)
      await closeOf(durable, 10_000)
      // recheck: a sign-out an app with no subscriptions finds.
      const byCheck = await make()
      const checkBrowser = await s.signIn(byCheck)
      const checked = await s.gatewaySocket(checkBrowser, { url: checking.url })
      await checkBrowser.post('/api/auth/sign-out', {})
      await closeOf(checked, 5000)
      // topics, push: a team left.
      const leaver = await make()
      const team = await s.team()
      await s.addMember(team, leaver)
      const leaving = await s.gatewaySocket(await s.signIn(leaver), { url: pushing.url })
      await leaving.sub([teamTopic(team)])
      await s.removeMember(team, leaver)
      await pushPeople(s.org.id, [leaver.id])
      await leaving.next('dropped', 5000)
    })

    const applied = [...linesOf(pushing, 'revocation_applied'), ...linesOf(checking, 'revocation_applied')]
    const seen = (handler: string, path: string, startSource: string) =>
      applied.some(
        line =>
          line.handler === handler &&
          line.path === path &&
          line.startSource === startSource &&
          typeof line.latencyMs === 'number' &&
          line.org === s.org.id &&
          Number(line.count) >= 1,
      )
    expect(seen('sockets', 'push', 'publisher')).toBe(true)
    // The sockets job's message (outbox) or the topics job's re-check (database), whichever came
    // first (T19 item 13).
    expect(seen('sockets', 'durable', 'outbox') || seen('sockets', 'durable', 'database')).toBe(true)
    expect(seen('sockets', 'recheck', 'database')).toBe(true)
    expect(seen('topics', 'push', 'database')).toBe(true)
    for (const line of applied) expect(Number(line.latencyMs)).toBeLessThan(60_000)

    // The summaries follow, one per (handler, path, startSource) with records.
    const summarised = (app: RealtimeApp, handler: string, path: string) =>
      linesOf(app, 'revocation_latency').some(
        line => line.handler === handler && line.path === path && Number(line.count) >= 1,
      )
    await eventually(
      () => [
        summarised(pushing, 'sockets', 'push'),
        summarised(pushing, 'sockets', 'durable'),
        summarised(checking, 'sockets', 'recheck'),
        summarised(pushing, 'topics', 'push'),
      ],
      found => found.every(Boolean),
      5000,
    )
    for (const line of [...linesOf(pushing, 'revocation_latency'), ...linesOf(checking, 'revocation_latency')]) {
      expect(line).toMatchObject({
        p50: expect.any(Number),
        p95: expect.any(Number),
        p99: expect.any(Number),
        max: expect.any(Number),
      })
    }
    expect(linesOf(pushing, 'gateway_gauges').length).toBeGreaterThan(0)

    // No log line of the run holds a phone number, a token, or the id of anyone in this test.
    const secrets = [...s.issued]
    for (const line of s.logs) {
      const { time: _time, pid: _pid, responseTime: _responseTime, ...rest } = line
      const text = JSON.stringify(rest)
      for (const person of people) {
        expect(text.includes(person.id), text).toBe(false)
        expect(text.includes(person.e164) || new RegExp(`(?<![0-9])${person.local}(?![0-9])`).test(text), text).toBe(
          false,
        )
      }
      expect(
        secrets.some(secret => text.includes(secret)),
        text,
      ).toBe(false)
    }
  })

  it('OD-22 P2 T19: realtime is ready, and /ready/local passes, only once it listens on revoked and access', async () => {
    // The stack's own: ready, with no storage check, and its local check alone on /ready/local.
    const full = await s.realtime.readiness('/ready')
    expect(full).toEqual({
      status: 200,
      body: { status: 'ready', checks: { postgres: 'ok', valkey: 'ok', gateway: 'ok' } },
    })
    expect(await s.realtime.readiness('/ready/local')).toEqual({
      status: 200,
      body: { status: 'ready', checks: { gateway_local: 'ok' } },
    })

    // One that can't reach Valkey at start has never listened: neither passes.
    const valkey = await s.proxy('valkey')
    valkey.proxy.cut()
    const app = await s.startRealtime({ recheckMs: SOCKET_RECHECK_MS, subscribe: true, valkeyUrl: valkey.url })
    await sleep(500)
    expect(await app.readiness('/ready')).toMatchObject({ status: 503, body: { checks: { gateway: 'failed' } } })
    expect(await app.readiness('/ready/local')).toEqual({
      status: 503,
      body: { status: 'not ready', checks: { gateway_local: 'failed' } },
    })
    expect(linesOf(app, 'channel_subscribed')).toEqual([])

    valkey.proxy.restore()
    await eventually(
      () => app.readiness('/ready/local'),
      r => r.status === 200,
    )
    await eventually(
      () => app.readiness('/ready'),
      r => r.status === 200,
    )
    const channels = new Set(linesOf(app, 'channel_subscribed').map(line => line.channel))
    expect(channels.has('revoked') && channels.has('access')).toBe(true)
  })
})
