// The integration harness (test-only; the image leaves testing/ out): the real api and realtime
// apps on the Compose stack's Postgres and Valkey, for the server's integration tests
// (`*.integration.test.ts`, which `npm run test:integration` runs in Vitest's integration mode).
//
// Each run builds its own throwaway database (auth_it_<random>, migrated with production's
// migrator, owned by hearth_owner, the server connecting as hearth_app) and its own Valkey key
// prefix (it:<random>:), and removes both when it stops, so a run can follow another at once and
// leaves the local `hearth` database alone. It sets up hearth_owner and the local password of
// hearth_app and hearth_worker (the worker's login, 0007) itself, as scripts/db-local.sh does, so it
// needs only `docker compose up -d --wait`.
// It connects as the stack's superuser through the PG* variables (default
// postgres:postgres@127.0.0.1:5432) and refuses any host but this machine.
//
// From C0.6 every write a runtime role commits is recorded for the outbox's contract sweep
// (testing/writes.ts), and each org also has the test flags (TEST_FLAGS: it.*), which every flag
// cache in the run knows (A5). startWorker() runs a worker instance (worker/index.ts) on its own
// two pools as hearth_worker and its own Valkey subscriber, with the production kinds and consumers,
// the test's own, and the production schedules only when a test asks for them (so the 03:17 and
// 03:47 schedules can't fire mid-run), at the test policy's short intervals.
//
// The org has nobody in it at the start: each test makes its own people, so a test reads no
// other test's state, and `-t` on one test works. Requests go through Fastify's inject from
// 127.0.0.1, the one trusted proxy, so each client's X-Forwarded-For sets request.ip. Sockets go
// to the realtime app listening on a random local port. Every log line both apps write is kept,
// and so is every reply, every secret the clients were given and every PIN they typed, for the
// test's sweeps.
import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { Writable } from 'node:stream'
import { FLAGS, type FlagSpec } from '@hearth/shared'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { Client as PgClient } from 'pg'
import type { Logger } from 'pino'
import { WebSocket } from 'ws'
import { buildApp } from '#src/app.ts'
import { type AuthKeys, deriveKeys, hashPin, newSecret, sha256 } from '#src/auth/crypto.ts'
import { pinProblem } from '#src/auth/pin-policy.ts'
import { SOCKET_RECHECK_MS } from '#src/auth/policy.ts'
import { type ValkeyKeys, valkeyKeys } from '#src/auth/valkey-keys.ts'
import { createDatabase, type Database } from '#src/db/database.ts'
import { migrate } from '#src/db/migrations.ts'
import { createPool } from '#src/db/pool.ts'
import type { JobRole } from '#src/db/roles.ts'
import { FlagCache } from '#src/flags/cache.ts'
import { AfterResponse } from '#src/http.ts'
import type { JobKind, RetiredSchedule, ScheduleDef } from '#src/jobs/kinds.ts'
import { JOB_POLICY, SCHEDULER_POLICY, WORKER_POLICY, type WorkerPolicy } from '#src/jobs/policy.ts'
import { createLogger } from '#src/logger.ts'
import type { OutboxConsumer } from '#src/outbox/consumers.ts'
import { Subscriptions } from '#src/pubsub.ts'
import { registerRealtime } from '#src/realtime/index.ts'
import type { SocketServer } from '#src/realtime/socket.ts'
import { MemorySms } from '#src/testing/sms.ts'
import { installWriteTracking } from '#src/testing/writes.ts'
import { closeValkey, createSubscriber, createValkey } from '#src/valkey.ts'
import { CONTROL_POOL_SIZE, productionRegistries, startWorker, type Worker, workPoolSize } from '#src/worker/index.ts'

// The app's origin in every test. Passkeys are bound to its host name, hearth.test.
export const APP_ORIGIN = 'https://hearth.test'

// The User-Agent a client sends unless told otherwise; its device label is 'iPhone · Safari'.
export const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
// The password scripts/db-local.sh gives hearth_app and hearth_worker on the local stack: not a
// secret.
const APP_PASSWORD = 'hearth-local'

// The flags only tests have (A5): the harness inserts each org's rows at these defaults (it.optional
// and it.essential on, it.ai off, none locked), and every flag cache in the run knows them, the
// flags route included. it.ai names an AI purpose outside ai.*, which only a test registry can:
// the purpose gate refuses to turn it on.
const testFlag = (
  description: string,
  flagClass: FlagSpec['class'],
  purposes: FlagSpec['purposes'],
  on: boolean,
): FlagSpec => ({ description, class: flagClass, default: on, locked: false, purposes, client: false, stage: 'C0.6' })
export const TEST_FLAGS: Readonly<Record<string, FlagSpec>> = {
  'it.optional': testFlag(
    'A test feature whose work is dropped when it is off',
    'optional',
    ['service_operation'],
    true,
  ),
  'it.essential': testFlag('A test feature whose work waits while it is off', 'essential', ['service_operation'], true),
  'it.ai': testFlag(
    'A test feature with an AI purpose, which the purpose gate refuses',
    'optional',
    ['org_brain'],
    false,
  ),
}
export const TEST_REGISTRY: Readonly<Record<string, FlagSpec>> = { ...FLAGS, ...TEST_FLAGS }
const TEST_FLAG_ROWS = `values ${Object.entries(TEST_FLAGS)
  .map(([key, spec]) => `('${key}', ${spec.default})`)
  .join(', ')}`

// The worker's intervals in the integration tests: leases of 2 s renewed every 0.5 s,
// the lease sweep (the scheduler's tick) every 0.5 s, polls every 100 ms, metrics every 200 ms and a
// 1 s drain; the 5 s stop deadline and everything else as in production.
export const TEST_WORKER_POLICY: WorkerPolicy = {
  ...WORKER_POLICY,
  jobs: { ...JOB_POLICY, leaseMs: 2000, heartbeatMs: 500, pollMs: 100, watchdogMs: 100, drainMs: 1000 },
  scheduler: { ...SCHEDULER_POLICY, tickMs: 500 },
  consumerPollMs: 100,
  metricsMs: 200,
  orgsMs: 1000,
}

export interface WorkerInstanceOptions {
  // The test's own kinds, consumers and schedules, beside the production kinds and consumers.
  kinds?: readonly JobKind[]
  consumers?: readonly OutboxConsumer[]
  schedules?: readonly (ScheduleDef | RetiredSchedule)[]
  // Whether the production schedules (03:17 partitions, 03:47 clean-up) are written too.
  productionSchedules?: boolean
  // Whether the production consumers (offboarding) run too: true unless a test turns them off.
  productionConsumers?: boolean
  policy?: WorkerPolicy
  // The worker's flag cache's poll and staleness.
  flags?: { pollMs?: number; staleMs?: number }
  concurrency?: number
}

export interface WorkerInstance {
  worker: Worker
  // Its pools' application_name, which kill() ends the connections of.
  name: string
  // Resolves once every loop has run a round (the worker's readiness check passes).
  ready(): Promise<void>
  // A graceful stop (the worker's own, within its 5 s), then its pools and subscriber close.
  stop(): Promise<void>
  // A crash: its loops and timers stop at once, its connections are ended, and its leases are left
  // to expire.
  kill(): Promise<void>
  // A zombie: its jobs run on, but their leases aren't renewed.
  pauseHeartbeats(paused?: boolean): void
}

// The roles a test person may hold (a Team Admin would need a team, which no test here makes).
export type PersonRole = 'owner' | 'admin' | 'ai_admin' | 'leadership' | 'dpo' | 'compliance_officer'

export interface Person {
  id: string
  orgId: string
  e164: string
  // The digits after the country code, which the sweeps look for in logs and audit rows.
  local: string
  phoneNumberId: string
  // The PIN they sign in with, once they have one; signIn() sets it when it sets a new PIN.
  pin: string | undefined
}

export interface Reply {
  status: number
  headers: Record<string, unknown>
  text: string
  body: unknown
  // The body's error code, if it has one.
  error: string | undefined
  setCookies: string[]
  json<T>(): T
}

export interface Client {
  readonly ip: string
  readonly userAgent: string
  post(url: string, body?: unknown, headers?: Record<string, string>): Promise<Reply>
  get(url: string, headers?: Record<string, string>): Promise<Reply>
  // The cookie jar, as a browser keeps it: Set-Cookie with Max-Age=0 removes a cookie.
  cookie(name: string): string | undefined
  setCookie(name: string, value: string): void
  cookieHeader(): string
}

export interface Closed {
  code: number
  reason: string
  // When the close arrived (epoch ms).
  at: number
}

export type Opened = { status: 101; ws: WebSocket; closed: Promise<Closed> } | { status: number }

export interface RealtimeApp {
  app: FastifyInstance
  url: string
  server: SocketServer
}

// What every reply to a client looked like, for the sweeps.
export interface Seen {
  method: string
  url: string
  status: number
  cacheControl: unknown
  text: string
  error: string | undefined
}

export interface Stack {
  db: Database
  // A pool logged in as hearth_worker, which takes a job role per transaction (T18).
  worker: Database
  superuser: PgClient
  valkey: Redis
  prefix: string
  names: ValkeyKeys
  keys: AuthKeys
  sms: MemorySms
  org: { id: string; system: string }
  logs: Record<string, unknown>[]
  warnings: Error[]
  replies: Seen[]
  // Every session token and attempt id a client was given, every PIN typed, every number used.
  issued: Set<string>
  pins: Set<string>
  numbers: Set<string>
  api: FastifyInstance
  realtime: RealtimeApp
  // The flags the api and realtime apps keep (T17), with the test registry.
  apiFlags: FlagCache
  realtimeFlags: FlagCache
  // Another flag cache with the test registry, read as hearth_app, or as a job role on the
  // worker's login (as the worker's reads hearth_queue), stopped when the stack stops; with
  // `subscribe`, on a subscriber connection of its own listening on the flags channel, as every
  // process's is.
  flagCache(options?: { as?: JobRole; pollMs?: number; subscribe?: boolean }): FlagCache
  person(options?: {
    roles?: PersonRole[]
    left?: boolean
    pin?: string
    org?: 'second'
    e164?: string
  }): Promise<Person>
  // A Singapore mobile number nobody in this run holds.
  number(): string
  // A PIN the policy accepts, recorded as typed.
  newPin(): string
  client(options?: { ip?: string; userAgent?: string; origin?: string; app?: FastifyInstance }): Client
  signIn(person: Person, options?: { ip?: string; userAgent?: string }): Promise<Client>
  // The client's live session and device, by its cookie's token.
  sessionOf(client: Client): Promise<{ id: string; deviceId: string }>
  // Moves a session's times (and its device's) back together, as though it were that old.
  age(sessionId: string, interval: string): Promise<void>
  query<Row>(text: string, values?: unknown[]): Promise<Row[]>
  settled(): Promise<void>
  openSocket(client: Client, options?: { origin?: string; url?: string; cookie?: string }): Promise<Opened>
  // Another api app on the same database, with its own Valkey URL (an unreachable one, say), and
  // optionally without its after-commit publish of a deactivation's sessions (A6).
  startApi(options: { valkeyUrl?: string; publishDeactivated?: boolean }): Promise<FastifyInstance>
  // Another realtime app: a shorter re-check, and optionally no revocation subscriber.
  startRealtime(options: { recheckMs: number; subscribe: boolean }): Promise<RealtimeApp>
  // A worker instance (worker/index.ts), stopped when the stack stops.
  startWorker(options?: WorkerInstanceOptions): Promise<WorkerInstance>
  track(resource: { close(): Promise<unknown> }): void
  stop(): Promise<void>
}

const connection = () => {
  const host = process.env.PGHOST ?? '127.0.0.1'
  return {
    host,
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? 'postgres',
  }
}

function url(c: ReturnType<typeof connection>, database: string, user = c.user, password = c.password): string {
  const result = new URL(`postgres://${c.host.includes(':') ? `[${c.host}]` : c.host}`)
  result.port = String(c.port)
  result.username = user
  result.password = password
  result.pathname = `/${database}`
  return result.toString()
}

// A log stream that keeps every line as an object.
function captureLogs(logs: Record<string, unknown>[]): Writable {
  return new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() !== '') logs.push(JSON.parse(line) as Record<string, unknown>)
      }
      done()
    },
  })
}

function setCookiesOf(header: unknown): string[] {
  if (header === undefined) return []
  return Array.isArray(header) ? header.map(String) : [String(header)]
}

export async function startStack(options: { recheckMs?: number } = {}): Promise<Stack> {
  const c = connection()
  if (!LOCAL_HOSTS.has(c.host)) {
    throw new Error(`Refusing to use Postgres on ${c.host}: the integration tests run on the local stack only.`)
  }
  const closers: Array<() => Promise<unknown>> = []
  const track = (resource: { close(): Promise<unknown> }) => {
    closers.push(() => resource.close())
  }
  const warnings: Error[] = []
  const onWarning = (warning: Error) => warnings.push(warning)
  process.on('warning', onWarning)
  closers.push(async () => process.off('warning', onWarning))

  const database = `auth_it_${randomBytes(4).toString('hex')}`
  let created = false
  const stopAll = async () => {
    const errors: unknown[] = []
    for (const close of closers.splice(0).reverse()) {
      try {
        await close()
      } catch (error) {
        errors.push(error)
      }
    }
    if (created) {
      const admin = new PgClient({ ...c, database: 'postgres' })
      try {
        await admin.connect()
        await admin.query(`drop database if exists ${database} with (force)`)
      } catch (error) {
        errors.push(error)
      } finally {
        await admin.end().catch(() => {})
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'the integration stack did not stop cleanly')
  }

  try {
    // hearth_owner and the throwaway database, as scripts/db-local.sh makes the local one.
    const admin = new PgClient({ ...c, database: 'postgres' })
    try {
      await admin.connect()
    } catch {
      throw new Error(
        `Can't connect to Postgres on ${c.host}:${c.port}. Is the local stack up (docker compose up -d --wait)?`,
      )
    }
    try {
      await admin.query('set client_min_messages = warning')
      await admin.query(
        'do $$ begin create role hearth_owner nologin createrole; exception when duplicate_object then null; end $$',
      )
      await admin.query('alter role hearth_owner nosuperuser nobypassrls createrole')
      await admin.query(`create database ${database} owner hearth_owner template template0`)
      created = true
    } finally {
      await admin.end()
    }
    const { error } = await migrate({ databaseUrl: url(c, database), role: 'hearth_owner' })
    if (error) throw error
    const superuser = new PgClient({ ...c, database })
    await superuser.connect()
    closers.push(() => superuser.end())
    // The migrations made hearth_app and hearth_worker without a login; locally they sign in with a
    // password.
    await superuser.query(`alter role hearth_app login password '${APP_PASSWORD}'`)
    await superuser.query(`alter role hearth_worker login password '${APP_PASSWORD}'`)
    // Every write a runtime role commits from here on, for the outbox's contract sweep.
    await installWriteTracking(superuser)

    const query = async <Row>(text: string, values: unknown[] = []): Promise<Row[]> =>
      (await superuser.query(text, values)).rows as Row[]

    // One org and its Hearth system principal; nobody else.
    const org: { id: string; system: string } = { id: randomUUID(), system: randomUUID() }
    await query("insert into orgs (id, name) values ($1, 'Integration test')", [org.id])
    await query("insert into principals (id, org_id, kind, system_key) values ($1, $2, 'system', 'hearth')", [
      org.system,
      org.id,
    ])
    const addTestFlags = (orgId: string) =>
      query(
        `insert into feature_flags (org_id, key, enabled, locked) select $1, f.key, f.enabled, false from (${TEST_FLAG_ROWS}) f (key, enabled)`,
        [orgId],
      )
    await addTestFlags(org.id)
    let second: { id: string; system: string } | undefined

    const logs: Record<string, unknown>[] = []
    const logger = createLogger({ logLevel: 'debug', role: 'api' }, captureLogs(logs))
    const realtimeLogger = createLogger({ logLevel: 'debug', role: 'realtime' }, captureLogs(logs))

    const pool = createPool(url(c, database, 'hearth_app', APP_PASSWORD), logger)
    closers.push(() => pool.end())
    const db = createDatabase(pool)
    const workerPool = createPool(url(c, database, 'hearth_worker', APP_PASSWORD), logger, {
      applicationName: 'hearth-worker-it',
    })
    closers.push(() => workerPool.end())
    const worker = createDatabase(workerPool)

    const valkeyUrl = process.env.VALKEY_URL ?? 'redis://127.0.0.1:6379'
    const valkey = createValkey(valkeyUrl, logger)
    const prefix = `it:${randomBytes(6).toString('hex')}:`
    closers.push(async () => {
      // Every key this run made, then the connection.
      if (valkey.status === 'ready') {
        let cursor = '0'
        do {
          const [next, keys] = await valkey.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 1000)
          cursor = next
          if (keys.length > 0) await valkey.del(...keys)
        } while (cursor !== '0')
      }
      await closeValkey(valkey)
    })
    // Commands fail at once until the connection is ready (enableOfflineQueue is off).
    if (valkey.status !== 'ready') {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Can't connect to Valkey at ${valkeyUrl}. Is the local stack up?`)),
          5000,
        )
        valkey.once('ready', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    const names = valkeyKeys(prefix)
    const keys = deriveKeys(newSecret())
    const sms = new MemorySms()

    // Each api app's after-response queue, so a client can wait for its work.
    const queues = new Map<FastifyInstance, AfterResponse>()

    // A flag cache with the test registry, stopped when the stack stops.
    function flagCache(o: { as?: JobRole; pollMs?: number; logger?: Logger } = {}): FlagCache {
      const cache = new FlagCache({
        db: o.as === undefined ? db : worker,
        ...(o.as === undefined ? {} : { as: o.as }),
        ...(o.pollMs === undefined ? {} : { pollMs: o.pollMs }),
        registry: TEST_REGISTRY,
        logger: o.logger ?? logger,
      })
      closers.push(async () => cache.stop())
      return cache
    }

    // A process's pub/sub channels on a subscriber connection of its own, with its flags listening.
    function subscribed(from: Redis, cache: FlagCache, subscriberLogger: Logger): Subscriptions {
      const subscriptions = new Subscriptions(createSubscriber(from, subscriberLogger), subscriberLogger)
      closers.push(() => subscriptions.close())
      void cache.listen(subscriptions, names.flags)
      return subscriptions
    }

    async function startApiOn(
      apiValkey: Redis,
      apiLogger: Logger,
      o: { publishDeactivated?: boolean } = {},
    ): Promise<{ app: FastifyInstance; flags: FlagCache }> {
      const afterResponse = new AfterResponse()
      const flags = flagCache({ logger: apiLogger })
      subscribed(apiValkey, flags, apiLogger)
      const app = buildApp({
        appOrigin: APP_ORIGIN,
        logger: apiLogger,
        checks: {},
        trustProxy: ['127.0.0.1'],
        api: {
          db,
          valkey: apiValkey,
          keys,
          sms,
          keyPrefix: prefix,
          flags,
          afterResponse,
          ...(o.publishDeactivated === undefined ? {} : { publishDeactivated: o.publishDeactivated }),
        },
      })
      closers.push(() => app.close())
      await app.ready()
      queues.set(app, afterResponse)
      return { app, flags }
    }

    async function startRealtimeApp(
      recheckMs: number,
      subscribe: boolean,
    ): Promise<RealtimeApp & { flags: FlagCache }> {
      const app = buildApp({ appOrigin: APP_ORIGIN, logger: realtimeLogger, checks: {} })
      const flags = flagCache({ logger: realtimeLogger })
      const subscriptions = subscribe ? subscribed(valkey, flags, realtimeLogger) : undefined
      const server = registerRealtime(app, {
        appOrigin: APP_ORIGIN,
        logger: realtimeLogger,
        db,
        keyPrefix: prefix,
        recheckMs,
        flags,
        ...(subscriptions === undefined ? {} : { subscriptions }),
      })
      closers.push(() => app.close())
      await app.listen({ host: '127.0.0.1', port: 0 })
      const { port } = app.server.address() as AddressInfo
      return { app, server, url: `ws://127.0.0.1:${port}/ws`, flags }
    }

    // Worker instances, each on its own pools and subscriber, logging into the run's lines with its
    // name.
    const workerLogger = createLogger({ logLevel: 'debug', role: 'worker' }, captureLogs(logs))
    let workerCount = 0
    async function startWorkerInstance(o: WorkerInstanceOptions = {}): Promise<WorkerInstance> {
      workerCount++
      const name = `hearth-worker-it-${workerCount}`
      const instanceLogger = workerLogger.child({ instance: name })
      const production = productionRegistries({ valkey, keyPrefix: prefix, logger: instanceLogger })
      const registries = {
        kinds: [...production.kinds, ...(o.kinds ?? [])],
        schedules: [...(o.productionSchedules === true ? production.schedules : []), ...(o.schedules ?? [])],
        consumers: [...(o.productionConsumers === false ? [] : production.consumers), ...(o.consumers ?? [])],
      }
      const concurrency = o.concurrency ?? 4
      const workerUrl = url(c, database, 'hearth_worker', APP_PASSWORD)
      const control = createPool(workerUrl, instanceLogger, { max: CONTROL_POOL_SIZE, applicationName: name })
      const work = createPool(workerUrl, instanceLogger, {
        max: workPoolSize(concurrency, registries),
        applicationName: name,
      })
      // Named for the instance and the run (its Valkey key prefix), as CLIENT LIST shows it.
      const subscriber = createSubscriber(valkey, instanceLogger, `${name}:${prefix}`)
      const subscriptions = new Subscriptions(subscriber, instanceLogger)
      let closed: Promise<void> | undefined
      const close = () => {
        closed ??= (async () => {
          await subscriptions.close()
          await Promise.allSettled([control.end(), work.end()])
        })()
        return closed
      }
      let worker: Worker
      try {
        worker = startWorker({
          control: createDatabase(control),
          work: createDatabase(work),
          subscriptions,
          keyPrefix: prefix,
          logger: instanceLogger,
          concurrency,
          registries,
          flagRegistry: TEST_REGISTRY,
          policy: o.policy ?? TEST_WORKER_POLICY,
          ...(o.flags === undefined ? {} : { flags: o.flags }),
        })
      } catch (error) {
        // Nothing started: the pools and the subscriber close, so a refused start leaks nothing.
        await close()
        throw error
      }
      const instance: WorkerInstance = {
        worker,
        name,
        async ready() {
          const deadline = Date.now() + 10_000
          for (;;) {
            try {
              await worker.check(new AbortController().signal)
              return
            } catch (error) {
              if (Date.now() > deadline) throw error
            }
            await new Promise(resolve => setTimeout(resolve, 20))
          }
        },
        async stop() {
          await worker.stop()
          await close()
        },
        async kill() {
          worker.halt()
          await query('select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1', [name])
          await close()
        },
        pauseHeartbeats(paused = true) {
          worker.runner.pauseHeartbeats(paused)
        },
      }
      closers.push(() => instance.stop())
      return instance
    }

    const { app: api, flags: apiFlags } = await startApiOn(valkey, logger)
    const realtime = await startRealtimeApp(options.recheckMs ?? SOCKET_RECHECK_MS, true)
    // The realtime app subscribes in the background; a revocation published before it has would
    // be caught only by the re-check.
    for (let tries = 0; ; tries++) {
      const reply = (await valkey.call('PUBSUB', 'NUMSUB', names.revoked)) as [string, number]
      if (Number(reply[1]) >= 1) break
      if (tries > 250) throw new Error('the realtime app never subscribed to the revocation channel')
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    const replies: Seen[] = []
    const issued = new Set<string>()
    const pins = new Set<string>()
    const numbers = new Set<string>()

    function number(): string {
      for (;;) {
        const e164 = `+659${String(randomInt(0, 10_000_000)).padStart(7, '0')}`
        if (!numbers.has(e164)) {
          numbers.add(e164)
          return e164
        }
      }
    }

    function newPin(): string {
      for (;;) {
        const pin = String(randomInt(0, 1_000_000)).padStart(6, '0')
        if (pinProblem(pin) === undefined) {
          pins.add(pin)
          return pin
        }
      }
    }

    async function settled(): Promise<void> {
      await Promise.all([...queues.values()].map(queue => queue.idle()))
    }

    // Test addresses (RFC 5737): 198.51.100.x, then 203.0.113.x, one per client. Tests that name
    // an address use 192.0.2.x, so they never collide with these.
    let clients = 0
    function nextIp(): string {
      clients++
      if (clients <= 254) return `198.51.100.${clients}`
      if (clients <= 508) return `203.0.113.${clients - 254}`
      throw new Error('the harness ran out of test addresses')
    }

    function client(o: { ip?: string; userAgent?: string; origin?: string; app?: FastifyInstance } = {}): Client {
      const ip = o.ip ?? nextIp()
      const userAgent = o.userAgent ?? IPHONE_SAFARI
      const origin = o.origin ?? APP_ORIGIN
      const app = o.app ?? api
      const found = queues.get(app)
      if (found === undefined) throw new Error('that app is not one of the harness api apps')
      const queue: AfterResponse = found
      const jar = new Map<string, string>()
      const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ')

      async function request(
        method: 'GET' | 'POST',
        path: string,
        body: unknown,
        headers: Record<string, string>,
      ): Promise<Reply> {
        if (typeof body === 'object' && body !== null && 'pin' in body && typeof body.pin === 'string') {
          pins.add(body.pin)
        }
        const cookie = cookieHeader()
        const response = await app.inject({
          method,
          url: path,
          headers: {
            origin,
            'user-agent': userAgent,
            'x-forwarded-for': ip,
            ...(cookie === '' ? {} : { cookie }),
            ...headers,
          },
          ...(body === undefined ? {} : { payload: body as object }),
        })
        // What the request queued for after its reply (the text, an audit row) has run.
        await queue.idle()
        const setCookies = setCookiesOf(response.headers['set-cookie'])
        for (const line of setCookies) {
          const [pair = ''] = line.split(';')
          const name = pair.slice(0, pair.indexOf('='))
          const value = pair.slice(pair.indexOf('=') + 1)
          if (/Max-Age=0(;|$)/.test(line) || value === '') jar.delete(name)
          else {
            jar.set(name, value)
            issued.add(value)
          }
        }
        const text = response.payload
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = undefined
        }
        const code =
          typeof parsed === 'object' && parsed !== null && 'error' in parsed && typeof parsed.error === 'string'
            ? parsed.error
            : undefined
        replies.push({
          method,
          url: path,
          status: response.statusCode,
          cacheControl: response.headers['cache-control'],
          text,
          error: code,
        })
        return {
          status: response.statusCode,
          headers: response.headers,
          text,
          body: parsed,
          error: code,
          setCookies,
          json: <T>() => parsed as T,
        }
      }

      return {
        ip,
        userAgent,
        post: (path, body, headers = {}) => request('POST', path, body, headers),
        get: (path, headers = {}) => request('GET', path, undefined, headers),
        cookie: name => jar.get(name),
        setCookie: (name, value) => {
          jar.set(name, value)
        },
        cookieHeader,
      }
    }

    function fail(step: string, reply: Reply): never {
      throw new Error(`${step} answered ${reply.status} ${reply.error ?? ''}`.trim())
    }

    async function signIn(person: Person, o: { ip?: string; userAgent?: string } = {}): Promise<Client> {
      const browser = client(o)
      const requested = await browser.post('/api/auth/otp/request', { phone: person.e164 })
      if (requested.status !== 200) fail('otp/request', requested)
      const code = await sms.nextCode(person.e164)
      const verified = await browser.post('/api/auth/otp/verify', { code })
      if (verified.status !== 200) fail('otp/verify', verified)
      const { next } = verified.json<{ next: 'set_pin' | 'step_up' }>()
      if (next === 'set_pin') {
        const pin = newPin()
        const set = await browser.post('/api/auth/pin/set', { pin })
        if (set.status !== 200) fail('pin/set', set)
        person.pin = pin
      } else {
        if (person.pin === undefined) throw new Error('signIn: the person has a PIN the test never gave')
        const checked = await browser.post('/api/auth/pin/verify', { pin: person.pin })
        if (checked.status !== 200) fail('pin/verify', checked)
      }
      return browser
    }

    async function person(
      o: { roles?: PersonRole[]; left?: boolean; pin?: string; org?: 'second'; e164?: string } = {},
    ): Promise<Person> {
      let inOrg = org
      if (o.org === 'second') {
        if (second === undefined) {
          second = { id: randomUUID(), system: randomUUID() }
          await query("insert into orgs (id, name) values ($1, 'Second org')", [second.id])
          await query("insert into principals (id, org_id, kind, system_key) values ($1, $2, 'system', 'hearth')", [
            second.system,
            second.id,
          ])
          await addTestFlags(second.id)
        }
        inOrg = second
      }
      const id = randomUUID()
      const e164 = o.e164 ?? number()
      numbers.add(e164)
      await query("insert into principals (id, org_id, kind) values ($1, $2, 'human')", [id, inOrg.id])
      await query('insert into people (id, org_id, full_name, created_by) values ($1, $2, $3, $4)', [
        id,
        inOrg.id,
        `Person ${id.slice(0, 8)}`,
        inOrg.system,
      ])
      const [phone] = await query<{ id: string }>(
        'insert into phone_numbers (org_id, person_id, e164, created_by) values ($1, $2, $3, $4) returning id',
        [inOrg.id, id, e164, inOrg.system],
      )
      if (phone === undefined) throw new Error('the phone number was not returned')
      for (const role of o.roles ?? []) {
        await query('insert into role_assignments (org_id, person_id, role, created_by) values ($1, $2, $3, $4)', [
          inOrg.id,
          id,
          role,
          inOrg.system,
        ])
      }
      if (o.pin !== undefined) {
        pins.add(o.pin)
        await query('insert into users (id, org_id, pin_hash, pin_key_id, pin_set_at) values ($1, $2, $3, $4, now())', [
          id,
          inOrg.id,
          await hashPin(o.pin, keys),
          keys.pinKeyId,
        ])
      }
      if (o.left) {
        await query('update people set deactivated_at = now(), deactivated_by = $2 where id = $1', [id, inOrg.system])
      }
      return { id, orgId: inOrg.id, e164, local: e164.slice(3), phoneNumberId: phone.id, pin: o.pin }
    }

    async function sessionOf(browser: Client): Promise<{ id: string; deviceId: string }> {
      const token = browser.cookie('__Host-hearth_session')
      if (token === undefined) throw new Error('that client has no session cookie')
      const [row] = await query<{ id: string; device_id: string }>(
        'select id, device_id from sessions where token_hash = $1',
        [sha256(token)],
      )
      if (row === undefined) throw new Error("that client's session isn't in the database")
      return { id: row.id, deviceId: row.device_id }
    }

    // All four session times move together, so 0006's checks (a start before the re-auth, at
    // most 90 days to expiry) still hold, with the stamping trigger off for the one statement.
    // The device's times move too, so its last-seen time can be seen to update.
    async function age(sessionId: string, interval: string): Promise<void> {
      await query('begin')
      try {
        await query('set local session_replication_role = replica')
        const [moved] = await query<{ device_id: string }>(
          `update sessions set created_at = created_at - $2::interval, last_seen_at = last_seen_at - $2::interval,
             reauthenticated_at = reauthenticated_at - $2::interval, expires_at = expires_at - $2::interval
           where id = $1 returning device_id`,
          [sessionId, interval],
        )
        if (moved === undefined) throw new Error('age: no such session')
        await query(
          `update devices set created_at = created_at - $2::interval, last_seen_at = last_seen_at - $2::interval
           where id = $1`,
          [moved.device_id, interval],
        )
        await query('commit')
      } catch (error) {
        await query('rollback')
        throw error
      }
    }

    function openSocket(browser: Client, o: { origin?: string; url?: string; cookie?: string } = {}): Promise<Opened> {
      return new Promise((resolve, reject) => {
        const cookie = o.cookie ?? browser.cookieHeader()
        const ws = new WebSocket(o.url ?? realtime.url, {
          headers: { origin: o.origin ?? APP_ORIGIN, ...(cookie === '' ? {} : { cookie }) },
          perMessageDeflate: false,
        })
        // Listened for from the start, so no close is missed.
        const closed = new Promise<Closed>(done => {
          ws.once('close', (code, reason) => done({ code, reason: reason.toString(), at: Date.now() }))
        })
        ws.on('error', error => reject(error))
        ws.once('open', () => {
          closers.push(async () => ws.terminate())
          resolve({ status: 101, ws, closed })
        })
        ws.once('unexpected-response', (_request, response) => {
          response.resume()
          resolve({ status: response.statusCode ?? 0 })
          ws.terminate()
        })
      })
    }

    return {
      db,
      worker,
      superuser,
      valkey,
      prefix,
      names,
      keys,
      sms,
      org,
      logs,
      warnings,
      replies,
      issued,
      pins,
      numbers,
      api,
      realtime,
      apiFlags,
      realtimeFlags: realtime.flags,
      flagCache: (o = {}) => {
        const cache = flagCache(o)
        if (o.subscribe === true) subscribed(valkey, cache, logger)
        return cache
      },
      person,
      number,
      newPin,
      client,
      signIn,
      sessionOf,
      age,
      query,
      settled,
      openSocket,
      startApi: async ({ valkeyUrl, publishDeactivated }) => {
        let apiValkey = valkey
        if (valkeyUrl !== undefined) {
          const other = createValkey(valkeyUrl, logger)
          closers.push(() => closeValkey(other))
          apiValkey = other
        }
        const o = publishDeactivated === undefined ? {} : { publishDeactivated }
        return (await startApiOn(apiValkey, logger, o)).app
      },
      startRealtime: ({ recheckMs, subscribe }) => startRealtimeApp(recheckMs, subscribe),
      startWorker: startWorkerInstance,
      track,
      stop: stopAll,
    }
  } catch (error) {
    // Whatever was made before the failure goes, so the Vitest worker can exit.
    await stopAll().catch(() => {})
    throw error
  }
}
