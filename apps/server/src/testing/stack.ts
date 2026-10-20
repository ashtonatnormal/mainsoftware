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
// From C0.7 each realtime app (the stack's, and each startRealtime() makes) is built as main.ts
// builds the role, with /ready (postgres, valkey and the gateway's own check) and /ready/local, and
// logs with its instance name; one given its own Valkey or Postgres URL (through a proxy,
// testing/proxy.ts) gets its own connections and pool, so a test can cut or freeze them alone.
// gatewaySocket() opens a socket that speaks the gateway's protocol and keeps every frame; team(),
// addMember() and removeMember() write teams as the superuser (whose writes the outbox sweep skips:
// C0.16 brings the runtime write path), and appendEvent() appends an outbox event as Hearth. stop()
// fails on any MaxListenersExceededWarning or TimeoutNegativeWarning the process emitted (P9).
//
// The org has nobody in it at the start: each test makes its own people, so a test reads no
// other test's state, and `-t` on one test works. newOrg() makes another, for a test that needs an
// org of its own (an empty event stream, say). Requests go through Fastify's inject from
// 127.0.0.1, the one trusted proxy, so each client's X-Forwarded-For sets request.ip. Sockets go
// to the realtime app listening on a random local port. Every log line both apps write is kept,
// and so is every reply, every secret the clients were given and every PIN they typed, for the
// test's sweeps.
import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { Writable } from 'node:stream'
import { PIN_ROLES } from '@hearth/access'
import { FLAGS, type FlagSpec, pinProblem } from '@hearth/shared'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { Client as PgClient } from 'pg'
import type { Logger } from 'pino'
import { WebSocket } from 'ws'
import { buildApp } from '#src/app.ts'
import { type AuthKeys, deriveKeys, hashPin, newSecret, sha256 } from '#src/auth/crypto.ts'
import { SOCKET_RECHECK_MS } from '#src/auth/policy.ts'
import { FakeVerify } from '#src/auth/sms/fake.ts'
import { type ValkeyKeys, valkeyKeys } from '#src/auth/valkey-keys.ts'
import { createDatabase, type Database } from '#src/db/database.ts'
import { migrate } from '#src/db/migrations.ts'
import { appRoleCheck, createPool } from '#src/db/pool.ts'
import type { JobRole } from '#src/db/roles.ts'
import { FlagCache } from '#src/flags/cache.ts'
import { AfterResponse } from '#src/http.ts'
import type { JobKind, RetiredSchedule, ScheduleDef } from '#src/jobs/kinds.ts'
import { JOB_POLICY, SCHEDULER_POLICY, WORKER_POLICY, type WorkerPolicy } from '#src/jobs/policy.ts'
import { createLogger } from '#src/logger.ts'
import type { OutboxConsumer } from '#src/outbox/consumers.ts'
import { Subscriptions } from '#src/pubsub.ts'
import type { CheckOrg } from '#src/realtime/checks.ts'
import { type Gateway, registerRealtime } from '#src/realtime/index.ts'
import { GATEWAY_POLICY, type GatewayPolicy } from '#src/realtime/policy.ts'
import { TestClient } from '#src/testing/gateway.ts'
import { startProxy, type TcpProxy } from '#src/testing/proxy.ts'
import { installWriteTracking } from '#src/testing/writes.ts'
import { closeValkey, createBlockingReader, createSubscriber, createValkey, valkeyCheck } from '#src/valkey.ts'
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

// The flags only tests have (A5): the harness inserts each org's rows at these defaults (it.optional,
// it.essential and it.client on, it.ai off, none locked), and every flag cache in the run knows them,
// the flags route included. it.ai names an AI purpose outside ai.*, which only a test registry can:
// the purpose gate refuses to turn it on. it.client is the one the browser may see (client: true), so
// a change to it nudges the gateway's sockets (C0.7, T19 item 10); no production flag is one yet.
const testFlag = (
  description: string,
  flagClass: FlagSpec['class'],
  purposes: FlagSpec['purposes'],
  on: boolean,
  client = false,
): FlagSpec => ({
  description,
  class: flagClass,
  default: on,
  locked: false,
  purposes,
  client,
  stage: client ? 'C0.7' : 'C0.6',
})
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
  'it.client': testFlag(
    'A test feature the browser may see, whose changes nudge the gateway’s sockets',
    'optional',
    ['service_operation'],
    true,
    true,
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
  // Whether the production consumers (offboarding and revocation) run too: true unless a test turns
  // them off.
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

// The roles a test person may hold. person() makes a team for a Team Admin, with them in it.
export type PersonRole = 'owner' | 'admin' | 'ai_admin' | 'leadership' | 'dpo' | 'compliance_officer' | 'team_admin'

export interface Person {
  id: string
  orgId: string
  e164: string
  // The digits after the country code, which the sweeps look for in logs and audit rows.
  local: string
  phoneNumberId: string
  // The PIN they sign in with, once they have one; signIn() sets it when it sets a new PIN. Only a
  // PIN-role holder is asked for it (D46).
  pin: string | undefined
  // Whether they were made holding a PIN role (PIN_ROLES: the roles only an Owner grants), so
  // signIn() expects the PIN step, and anyone else a sign-in on the code alone (D46).
  holdsPinRole: boolean
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

// An org of the run, and its Hearth system principal.
export interface Org {
  id: string
  system: string
}

export interface Readiness {
  status: number
  body: { status: string; checks: Record<string, string> }
}

export interface RealtimeApp {
  app: FastifyInstance
  url: string
  // The gateway: its counts and its readiness checks.
  server: Gateway
  // The name its log lines carry (instance), realtime-1 being the stack's own.
  instance: string
  // Its blocking reader's connection: disconnect() stops its reads for good.
  reader: Redis
  // GET /ready (postgres, valkey and the gateway) and GET /ready/local (gateway_local), as main.ts
  // serves them for the realtime role.
  readiness(path: '/ready' | '/ready/local'): Promise<Readiness>
}

export interface RealtimeOptions {
  // How often every socket is checked.
  recheckMs: number
  // Whether it listens on the revocation channels (revoked and access) and the flags channel.
  subscribe: boolean
  // Its own Valkey and Postgres (through a proxy, say): with valkeyUrl it gets its own command,
  // subscriber and reader connections; with databaseUrl its own pool of GATEWAY_POLICY.poolSize, as
  // hearth_app. Its flag cache reads through the stack's pool.
  valkeyUrl?: string
  databaseUrl?: string
  // Shorter timings (realtime/index.ts RealtimeDeps).
  policy?: Partial<GatewayPolicy>
  revokeWithinMs?: number
  recheckTimeoutMs?: number
  // Wraps each org's check, so a test can hold a decision after its read.
  wrapCheck?: (check: CheckOrg) => CheckOrg
}

// For a test that proves one path alone by its counter (counts().closedDurable, dropped.durable):
// timings under which a realtime app's periodic re-check never runs during the test, its first tick
// coming ten minutes after the app starts, past the integration mode's 120 s test timeout. The
// stack's own app ticks every SOCKET_RECHECK_MS from the suite's start, at a phase the earlier tests
// set, and a tick whose read lands between the revoking commit and that path's message closes the
// socket, or drops the topic, as its own (recheck) first. A test that proves a sub's own refusal
// (GW-04, GW-09) needs it too: a tick that reads the refusal while the sub is still deciding drops
// the topic, and the ack names it in no list. The deadline is lengthened with the interval, since
// the start-up guard holds the interval plus its timeout under it (socket.ts timings); with no
// periodic check to fail, nothing else reads it. The same tick's pruning and refusal summary wait
// too, which no such test reads. The targeted re-checks a message queues still run, counted under
// that message's path.
export const NO_PERIODIC_RECHECK = { recheckMs: 10 * 60_000, revokeWithinMs: 11 * 60_000 } as const

type Frame = TestClient['frames'][number]

// A socket that speaks the gateway's protocol (testing/gateway.ts TestClient): every frame it gets,
// parsed leniently as a client reads them (frames) and as sent (texts), and its close, with the
// time it arrived.
export class GatewaySocket {
  readonly ws: WebSocket
  readonly closed: Promise<Closed>
  readonly texts: string[] = []
  // The welcome hello was answered with, once it has been.
  welcome: (Frame & { t: 'welcome' }) | undefined
  readonly #client: TestClient

  constructor(ws: WebSocket, closed: Promise<Closed>) {
    this.ws = ws
    this.closed = closed
    ws.on('message', data => this.texts.push(String(data)))
    this.#client = new TestClient(ws)
  }

  get frames(): readonly Frame[] {
    return this.#client.frames
  }

  send(frame: unknown): void {
    this.#client.send(frame)
  }

  async hello(versions: number[] = [1]): Promise<Frame & { t: 'welcome' }> {
    const welcome = await this.#client.hello(versions)
    this.welcome = welcome
    return welcome
  }

  // The next frame not yet taken, of type t if given, within ms (3 s unless given).
  next<T extends string>(t?: T, ms?: number): Promise<Frame & { t: T }> {
    return this.#client.next(t, ms)
  }

  // Sends a sub and answers its ack.
  sub(topics: string[]): Promise<Frame & { t: 'ack' }> {
    return this.#client.sub(topics)
  }

  unsub(topics: string[]): Promise<Frame & { t: 'ack' }> {
    return this.#client.unsub(topics)
  }

  // The frames of type t so far.
  all(t: string): Frame[] {
    return this.#client.all(t)
  }

  // Whether the socket is still open.
  open(): boolean {
    return this.ws.readyState === WebSocket.OPEN
  }
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
  sms: FakeVerify
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
    org?: 'second' | Org
    e164?: string
  }): Promise<Person>
  // Another org with its system principal and the test flags, and nobody in it.
  newOrg(): Promise<Org>
  // A role row inserted (or revoked) as the superuser and nothing else: no session is ended, so it
  // models a grant that skipped C0.16's rule of ending the grantee's sessions first (D46 I3).
  // Answers the person as signIn() should now treat them.
  grantRole(person: Person, role: Exclude<PersonRole, 'team_admin'>): Promise<Person>
  revokeRole(person: Person, role: Exclude<PersonRole, 'team_admin'>): Promise<Person>
  // A Singapore mobile number nobody in this run holds.
  number(): string
  // A PIN the policy accepts, recorded as typed.
  newPin(): string
  client(options?: { ip?: string; userAgent?: string; origin?: string; app?: FastifyInstance }): Client
  signIn(person: Person, options?: { ip?: string; userAgent?: string }): Promise<Client>
  // Re-authenticates a signed-in client by the method its session was issued under (D46, AQ-01):
  // the PIN for a PIN-role holder, a fresh SMS code to their own number for anyone else. Follows
  // person.holdsPinRole, so a role granted or removed since the sign-in needs the routes themselves.
  reauth(client: Client, person: Person): Promise<void>
  // The client's live session and device, by its cookie's token.
  sessionOf(client: Client): Promise<{ id: string; deviceId: string }>
  // Moves a session's times (and its device's) back together, as though it were that old.
  age(sessionId: string, interval: string): Promise<void>
  query<Row>(text: string, values?: unknown[]): Promise<Row[]>
  settled(): Promise<void>
  openSocket(
    client: Client,
    options?: { origin?: string; url?: string; cookie?: string; autoPong?: boolean },
  ): Promise<Opened>
  // A socket on the gateway (the stack's realtime app unless url says another) that has said hello
  // (unless hello is false; versions are the ones it says it speaks), or a failure if the upgrade is
  // refused.
  gatewaySocket(
    client: Client,
    options?: { url?: string; hello?: boolean; versions?: number[]; autoPong?: boolean },
  ): Promise<GatewaySocket>
  // Every frame any gateway socket of the run was sent, as sent, for the gateway suite's sweep.
  gatewayFrames: string[]
  // A team in the org (the stack's unless given), and memberships of it, written as the superuser.
  team(options?: { org?: Org }): Promise<string>
  addMember(team: string, person: Person): Promise<void>
  removeMember(team: string, person: Person): Promise<void>
  // Appends an outbox event as the superuser, Hearth acting, about the first subject (or entity).
  appendEvent(
    type: string,
    ids: Record<string, unknown>,
    subjects: readonly string[],
    options?: { org?: Org; entity?: string },
  ): Promise<void>
  // A TCP proxy (testing/proxy.ts) in front of the stack's Postgres or Valkey, and the URL through it
  // (as hearth_app to the run's database, for Postgres), closed when the stack stops.
  proxy(to: 'postgres' | 'valkey'): Promise<{ proxy: TcpProxy; url: string }>
  // Another api app on the same database, with its own Valkey URL (an unreachable one, say), and
  // optionally without its after-commit publish of the sessions a commit ended (A6), so only the
  // worker's revocation consumer (C0.7) or the re-check closes their sockets; or with its own SMS
  // provider (one that needs a transfer-register entry, say).
  // realTiming: production's 2 s floor on refused code checks (the harness's apps answer at once).
  startApi(options: {
    valkeyUrl?: string
    publishRevoked?: boolean
    sms?: FakeVerify
    realTiming?: boolean
  }): Promise<FastifyInstance>
  // Another realtime app: a shorter re-check, and optionally no revocation subscriber, its own
  // connections, shorter timings or a wrapped check.
  startRealtime(options: RealtimeOptions): Promise<RealtimeApp>
  // A worker instance (worker/index.ts), stopped when the stack stops.
  startWorker(options?: WorkerInstanceOptions): Promise<WorkerInstance>
  // Waits, polling as the superuser, until the outbox consumer has its checkpoint in the org. A
  // consumer that starts at 'now' (C0.7's revocation) skips whatever committed before its checkpoint
  // was made, and a worker can be ready before then, so a test waits for it before its first
  // revocation (m6).
  waitForCheckpoint(consumer: string, orgId: string, ms?: number): Promise<void>
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

// The warnings no suite may cause (P9): a socket that gathers close listeners, and a timer given a
// negative delay. Node prints both as plain text, which scripts/check-server.sh refuses.
const GUARDED_WARNINGS = new Set(['MaxListenersExceededWarning', 'TimeoutNegativeWarning'])

function setCookiesOf(header: unknown): string[] {
  if (header === undefined) return []
  return Array.isArray(header) ? header.map(String) : [String(header)]
}

// passkeysForTests switches the dormant passkeys on for the stack's main api (D46; the dormant
// suite only, scripts/guards/api-test-overrides.test.ts).
export async function startStack(options: { recheckMs?: number; passkeysForTests?: boolean } = {}): Promise<Stack> {
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
    const guarded = warnings.filter(warning => GUARDED_WARNINGS.has(warning.name))
    if (guarded.length > 0) {
      errors.push(
        new Error(`the run emitted ${guarded.map(warning => `${warning.name}: ${warning.message}`).join('; ')}`),
      )
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

    // Every org of the run, by id; the stack's own has nobody in it but its Hearth system principal.
    const orgs = new Map<string, Org>()
    async function newOrg(name = 'Another org'): Promise<Org> {
      const made: Org = { id: randomUUID(), system: randomUUID() }
      await query('insert into orgs (id, name) values ($1, $2)', [made.id, name])
      await query("insert into principals (id, org_id, kind, system_key) values ($1, $2, 'system', 'hearth')", [
        made.system,
        made.id,
      ])
      await query(
        `insert into feature_flags (org_id, key, enabled, locked) select $1, f.key, f.enabled, false from (${TEST_FLAG_ROWS}) f (key, enabled)`,
        [made.id],
      )
      orgs.set(made.id, made)
      return made
    }
    const org = await newOrg('Integration test')
    let second: Org | undefined

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
    const sms = new FakeVerify()

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
      o: { publishRevoked?: boolean; sms?: FakeVerify; realTiming?: boolean; passkeysForTests?: boolean } = {},
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
          sms: o.sms ?? sms,
          keyPrefix: prefix,
          flags,
          afterResponse,
          ...(o.publishRevoked === undefined ? {} : { publishRevoked: o.publishRevoked }),
          // No floor on refused code checks (the suites make dozens), unless a test asks for the
          // real one; production's breaker either way, each app its own (T20).
          ...(o.realTiming ? {} : { otpForTests: { verifyFloorMs: 0 } }),
          ...(o.passkeysForTests ? { passkeysForTests: true } : {}),
        },
      })
      closers.push(() => app.close())
      await app.ready()
      queues.set(app, afterResponse)
      return { app, flags }
    }

    // A realtime app, built as main.ts builds the role: /ready with postgres, valkey and the gateway's
    // own check, and /ready/local with the gateway's local one (app.ts names them so). It is
    // registered here rather than through buildApp's realtime option, so the harness holds the
    // gateway; the checks reach it once it is.
    let realtimeCount = 0
    async function startRealtimeApp(o: RealtimeOptions): Promise<RealtimeApp & { flags: FlagCache }> {
      realtimeCount++
      const instance = `realtime-${realtimeCount}`
      const appLogger = realtimeLogger.child({ instance })
      let appValkey = valkey
      if (o.valkeyUrl !== undefined) {
        const own = createValkey(o.valkeyUrl, appLogger)
        closers.push(() => closeValkey(own))
        appValkey = own
      }
      let appPool = pool
      let appDb = db
      if (o.databaseUrl !== undefined) {
        const own = createPool(o.databaseUrl, appLogger, {
          max: GATEWAY_POLICY.poolSize,
          applicationName: `hearth-${instance}-it`,
        })
        closers.push(() => own.end())
        appPool = own
        appDb = createDatabase(own)
      }
      let gateway: Gateway | undefined
      const gatewayOf = (): Gateway => {
        if (gateway === undefined) throw new Error('the gateway is not registered yet')
        return gateway
      }
      const app = buildApp({
        appOrigin: APP_ORIGIN,
        logger: appLogger,
        checks: {
          postgres: appRoleCheck(appPool),
          valkey: valkeyCheck(appValkey),
          gateway: signal => gatewayOf().check(signal),
        },
        localChecks: { gateway_local: signal => gatewayOf().localCheck(signal) },
      })
      const flags = flagCache({ logger: appLogger })
      const subscriptions = o.subscribe ? subscribed(appValkey, flags, appLogger) : undefined
      // Its own blocking reader connection for the org streams, as main.ts makes one per process.
      // Cut rather than quit when the app has stopped: a QUIT would wait behind the reader's XREAD.
      const reader = createBlockingReader(appValkey, appLogger)
      closers.push(async () => reader.disconnect())
      gateway = registerRealtime(app, {
        appOrigin: APP_ORIGIN,
        logger: appLogger,
        db: appDb,
        valkey: appValkey,
        reader,
        keyPrefix: prefix,
        recheckMs: o.recheckMs,
        flags,
        ...(subscriptions === undefined ? {} : { subscriptions }),
        ...(o.policy === undefined ? {} : { policy: o.policy }),
        ...(o.revokeWithinMs === undefined ? {} : { revokeWithinMs: o.revokeWithinMs }),
        ...(o.recheckTimeoutMs === undefined ? {} : { recheckTimeoutMs: o.recheckTimeoutMs }),
        ...(o.wrapCheck === undefined ? {} : { wrapCheck: o.wrapCheck }),
      })
      closers.push(() => app.close())
      await app.listen({ host: '127.0.0.1', port: 0 })
      const { port } = app.server.address() as AddressInfo
      return {
        app,
        server: gateway,
        url: `ws://127.0.0.1:${port}/ws`,
        instance,
        reader,
        flags,
        readiness: async path => {
          const reply = await app.inject({ method: 'GET', url: path })
          return { status: reply.statusCode, body: reply.json() }
        },
      }
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

    const { app: api, flags: apiFlags } = await startApiOn(valkey, logger, {
      ...(options.passkeysForTests ? { passkeysForTests: true } : {}),
    })
    const realtime = await startRealtimeApp({ recheckMs: options.recheckMs ?? SOCKET_RECHECK_MS, subscribe: true })
    // The realtime app subscribes to both revocation channels in the background; a revocation
    // published before it has would be caught only by the re-check. Its full readiness says when it
    // listens on both (T19 item 12).
    for (let tries = 0; ; tries++) {
      try {
        await realtime.server.check(new AbortController().signal)
        break
      } catch (error) {
        if (tries > 250) throw new Error('the realtime app never became ready', { cause: error })
      }
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
      // Someone with no PIN role is signed in on the code alone, and a PIN-role holder goes on to the
      // PIN step (D46).
      const answer = verified.json<{ status: 'signed_in' } | { status: 'code_verified'; next: 'set_pin' | 'step_up' }>()
      if ((answer.status === 'signed_in') === person.holdsPinRole) {
        throw new Error(`signIn: a ${person.holdsPinRole ? 'PIN-role' : 'code-only'} person got ${answer.status}`)
      }
      if (answer.status === 'signed_in') return browser
      if (answer.next === 'set_pin') {
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

    async function reauth(browser: Client, person: Person): Promise<void> {
      if (person.holdsPinRole) {
        if (person.pin === undefined) throw new Error('reauth: the person has a PIN the test never gave')
        const checked = await browser.post('/api/auth/reauth/pin', { pin: person.pin })
        if (checked.status !== 200) fail('reauth/pin', checked)
        return
      }
      const requested = await browser.post('/api/auth/reauth/code/request', {})
      if (requested.status !== 200) fail('reauth/code/request', requested)
      const code = await sms.nextCode(person.e164)
      const verified = await browser.post('/api/auth/reauth/code/verify', { code })
      if (verified.status !== 200) fail('reauth/code/verify', verified)
    }

    async function person(
      o: { roles?: PersonRole[]; left?: boolean; pin?: string; org?: 'second' | Org; e164?: string } = {},
    ): Promise<Person> {
      let inOrg = org
      if (o.org === 'second') {
        second ??= await newOrg('Second org')
        inOrg = second
      } else if (o.org !== undefined) {
        inOrg = o.org
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
        // A Team Admin needs a team: a new one, with them in it.
        let teamId: string | null = null
        if (role === 'team_admin') {
          teamId = await team({ org: inOrg })
          await query('insert into team_memberships (org_id, team_id, person_id, created_by) values ($1, $2, $3, $4)', [
            inOrg.id,
            teamId,
            id,
            inOrg.system,
          ])
        }
        await query(
          'insert into role_assignments (org_id, person_id, role, team_id, created_by) values ($1, $2, $3, $4, $5)',
          [inOrg.id, id, role, teamId, inOrg.system],
        )
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
      const holdsPinRole = (o.roles ?? []).some(role => PIN_ROLES.includes(role))
      return { id, orgId: inOrg.id, e164, local: e164.slice(3), phoneNumberId: phone.id, pin: o.pin, holdsPinRole }
    }

    // Whether the person holds a PIN role now, read from their unrevoked role rows.
    async function holdsPinRoleNow(person: Person): Promise<boolean> {
      const rows = await query<{ role: PersonRole }>(
        'select role from role_assignments where person_id = $1 and revoked_at is null',
        [person.id],
      )
      return rows.some(row => PIN_ROLES.includes(row.role))
    }

    async function grantRole(person: Person, role: Exclude<PersonRole, 'team_admin'>): Promise<Person> {
      const [org] = await query<{ system: string }>(
        "select id as system from principals where org_id = $1 and kind = 'system'",
        [person.orgId],
      )
      await query(
        'insert into role_assignments (org_id, person_id, role, team_id, created_by) values ($1, $2, $3, null, $4)',
        [person.orgId, person.id, role, org?.system],
      )
      return { ...person, holdsPinRole: await holdsPinRoleNow(person) }
    }

    async function revokeRole(person: Person, role: Exclude<PersonRole, 'team_admin'>): Promise<Person> {
      const [org] = await query<{ system: string }>(
        "select id as system from principals where org_id = $1 and kind = 'system'",
        [person.orgId],
      )
      await query(
        `update role_assignments set revoked_at = now(), revoked_by = $3
         where person_id = $1 and role = $2 and revoked_at is null`,
        [person.id, role, org?.system],
      )
      return { ...person, holdsPinRole: await holdsPinRoleNow(person) }
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

    function openSocket(
      browser: Client,
      o: { origin?: string; url?: string; cookie?: string; autoPong?: boolean } = {},
    ): Promise<Opened> {
      return new Promise((resolve, reject) => {
        const cookie = o.cookie ?? browser.cookieHeader()
        const ws = new WebSocket(o.url ?? realtime.url, {
          headers: { origin: o.origin ?? APP_ORIGIN, ...(cookie === '' ? {} : { cookie }) },
          perMessageDeflate: false,
          // A client that stops answering the server's pings (the heartbeat's dead limit) sets false.
          autoPong: o.autoPong ?? true,
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

    const gatewayFrames: string[] = []
    async function gatewaySocket(
      browser: Client,
      o: { url?: string; hello?: boolean; versions?: number[]; autoPong?: boolean } = {},
    ): Promise<GatewaySocket> {
      const opened = await openSocket(browser, {
        ...(o.url === undefined ? {} : { url: o.url }),
        ...(o.autoPong === undefined ? {} : { autoPong: o.autoPong }),
      })
      if (!('ws' in opened)) throw new Error(`the gateway refused the upgrade: ${opened.status}`)
      const socket = new GatewaySocket(opened.ws, opened.closed)
      opened.ws.on('message', data => gatewayFrames.push(String(data)))
      if (o.hello !== false) await socket.hello(o.versions)
      return socket
    }

    const orgOf = (orgId: string): Org => {
      const found = orgs.get(orgId)
      if (found === undefined) throw new Error('that org is not one of the run’s')
      return found
    }

    async function team(o: { org?: Org } = {}): Promise<string> {
      const inOrg = o.org ?? org
      const [made] = await query<{ id: string }>(
        'insert into teams (org_id, name, created_by) values ($1, $2, $3) returning id',
        [inOrg.id, `Team ${randomBytes(4).toString('hex')}`, inOrg.system],
      )
      if (made === undefined) throw new Error('the team was not returned')
      return made.id
    }

    async function addMember(teamId: string, member: Person): Promise<void> {
      await query(
        `insert into team_memberships (org_id, team_id, person_id, created_by)
         values ($1, $2, $3, $4)`,
        [member.orgId, teamId, member.id, orgOf(member.orgId).system],
      )
    }

    async function removeMember(teamId: string, member: Person): Promise<void> {
      const removed = await query(
        `update team_memberships set removed_at = now(), removed_by = $4
         where org_id = $1 and team_id = $2 and person_id = $3 and removed_at is null returning id`,
        [member.orgId, teamId, member.id, orgOf(member.orgId).system],
      )
      if (removed.length !== 1) throw new Error('removeMember: that person is not a member of that team')
    }

    // As the jobs suite's forged event: the superuser, acting as Hearth, in a transaction of its own.
    async function appendEvent(
      type: string,
      ids: Record<string, unknown>,
      subjects: readonly string[],
      o: { org?: Org; entity?: string } = {},
    ): Promise<void> {
      const inOrg = o.org ?? org
      const entity = o.entity ?? subjects[0]
      if (entity === undefined) throw new Error('appendEvent: an event names its entity or a subject')
      await query('begin')
      try {
        await query("select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [
          inOrg.id,
          inOrg.system,
        ])
        await query(
          `insert into outbox_events (org_id, type, entity_type, entity_id, actor_id, actor_kind, subject_ids, purpose, ids)
           values ($1, $2, 'person', $3, $4, 'system', $5::uuid[], 'accounts', $6::jsonb)`,
          [inOrg.id, type, entity, inOrg.system, subjects, JSON.stringify(ids)],
        )
        await query('commit')
      } catch (error) {
        await query('rollback')
        throw error
      }
    }

    async function proxy(to: 'postgres' | 'valkey'): Promise<{ proxy: TcpProxy; url: string }> {
      if (to === 'postgres') {
        const made = await startProxy({ host: c.host, port: c.port })
        closers.push(() => made.close())
        return {
          proxy: made,
          url: url({ ...c, host: '127.0.0.1', port: made.port }, database, 'hearth_app', APP_PASSWORD),
        }
      }
      const target = new URL(valkeyUrl)
      const made = await startProxy({ host: target.hostname, port: Number(target.port || 6379) })
      closers.push(() => made.close())
      const through = new URL(valkeyUrl)
      through.hostname = '127.0.0.1'
      through.port = String(made.port)
      return { proxy: made, url: through.toString() }
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
      grantRole,
      revokeRole,
      newOrg: () => newOrg(),
      number,
      newPin,
      client,
      signIn,
      reauth,
      sessionOf,
      age,
      query,
      settled,
      openSocket,
      gatewaySocket,
      gatewayFrames,
      team,
      addMember,
      removeMember,
      appendEvent,
      proxy,
      startApi: async ({ valkeyUrl, publishRevoked, sms: otherSms, realTiming }) => {
        let apiValkey = valkey
        if (valkeyUrl !== undefined) {
          const other = createValkey(valkeyUrl, logger)
          closers.push(() => closeValkey(other))
          apiValkey = other
        }
        const o = {
          ...(publishRevoked === undefined ? {} : { publishRevoked }),
          ...(otherSms === undefined ? {} : { sms: otherSms }),
          ...(realTiming === undefined ? {} : { realTiming }),
        }
        return (await startApiOn(apiValkey, logger, o)).app
      },
      startRealtime: startRealtimeApp,
      startWorker: startWorkerInstance,
      waitForCheckpoint: async (consumer, orgId, ms = 10_000) => {
        const deadline = Date.now() + ms
        for (;;) {
          const rows = await query('select 1 from outbox_checkpoints where consumer = $1 and org_id = $2', [
            consumer,
            orgId,
          ])
          if (rows.length > 0) return
          if (Date.now() > deadline) throw new Error(`the ${consumer} consumer made no checkpoint in ${ms} ms`)
          await new Promise(resolve => setTimeout(resolve, 20))
        }
      },
      track,
      stop: stopAll,
    }
  } catch (error) {
    // Whatever was made before the failure goes, so the Vitest worker can exit.
    await stopAll().catch(() => {})
    throw error
  }
}
