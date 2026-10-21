// The server's entry point: `node src/main.ts`, with ROLE choosing api, realtime or worker (T2).
// All three roles come from one image and serve /health and /ready. The api role adds the
// sign-in, device and admin routes under /api, with its SMS provider (C0.5), the flags route
// (C0.6) and the web shell's reads (C0.8, web/routes.ts); the realtime role adds the gateway on
// /ws (C0.7, TECH-SPEC T19): topics, fan-out from each org's Valkey stream on a blocking reader
// connection of its own, and sockets closed within 60 s of their access ending, plus /ready/local
// for the load balancer. Both keep the flags of the orgs they serve, polled and told of changes on
// Valkey (C0.6, T17). The worker connects as hearth_worker and runs the job queue, the scheduler
// and the outbox consumers (C0.6, T15-T18; worker/index.ts). Each role serves only its own routes
// (scripts/check-server.sh).
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import type { Redis } from 'ioredis'
import type { Pool } from 'pg'
import type { ApiDeps } from '#src/api.ts'
import { buildApp } from '#src/app.ts'
import { deriveKeys } from '#src/auth/crypto.ts'
import { createFakeVerify } from '#src/auth/sms/fake.ts'
import type { SmsProvider } from '#src/auth/sms/provider.ts'
import { createTwilioVerify } from '#src/auth/sms/twilio.ts'
import { valkeyKeys, valkeyPrefix } from '#src/auth/valkey-keys.ts'
import { ConfigError, loadConfig } from '#src/config.ts'
import { createDatabase } from '#src/db/database.ts'
import { appRoleCheck, createPool, workerRoleCheck, workerRolesCheck } from '#src/db/pool.ts'
import { FlagCache } from '#src/flags/cache.ts'
import { C06_GATE } from '#src/jobs/gate.ts'
import { createLogger } from '#src/logger.ts'
import { Subscriptions } from '#src/pubsub.ts'
import type { RealtimeDeps } from '#src/realtime/index.ts'
import { GATEWAY_POLICY } from '#src/realtime/policy.ts'
import { createS3, storageCheck } from '#src/storage/s3.ts'
import { closeValkey, createBlockingReader, createSubscriber, createValkey, valkeyCheck } from '#src/valkey.ts'
import { CONTROL_POOL_SIZE, productionRegistries, startWorker, type Worker, workPoolSize } from '#src/worker/index.ts'

// ECS stops a task with SIGTERM and kills it after its stop timeout (30 s by default). Requests
// in flight get up to SHUTDOWN_TIMEOUT_MS to finish, and closing the connections after them at
// most CLOSE_TIMEOUT_MS, so a dependency that has stopped answering can't hold the process. The
// worker first stops its loops within WORKER_STOP_MS (T15 item 12): about 8.5 s in all.
const SHUTDOWN_TIMEOUT_MS = 10_000
const CLOSE_TIMEOUT_MS = 3000
const WORKER_STOP_MS = 5000

let config: ReturnType<typeof loadConfig>
try {
  config = loadConfig()
} catch (error) {
  if (!(error instanceof ConfigError)) throw error
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
}

const logger = createLogger(config)

// Anything thrown and not caught ends the process, as Node would, but logged as JSON first.
process.on('uncaughtException', error => {
  logger.fatal({ err: error }, 'uncaught exception')
  process.exit(1)
})
process.on('unhandledRejection', error => {
  logger.fatal({ err: error }, 'unhandled promise rejection')
  process.exit(1)
})

// The api and realtime roles connect as hearth_app (DATABASE_URL), the worker as hearth_worker
// (WORKER_DATABASE_URL), which takes a job role per transaction (TECH-SPEC T18). Each pool names
// itself in pg_stat_activity. The worker's is its control pool, for its loops; its work pool, for
// jobs' and consumers' transactions, is made below (T18 item 8). Realtime's holds 12: up to 5 session
// lookups, the decision lane, the periodic check, 3 flag reads, /ready's role check and a spare, so
// neither /ready nor the check waits behind a storm of lookups (T19 item 11). The api's stays at 10.
const pool = createPool(config.databaseUrl, logger, {
  applicationName: config.role === 'worker' ? 'hearth-worker-control' : `hearth-${config.role}`,
  ...(config.role === 'worker'
    ? { max: CONTROL_POOL_SIZE }
    : config.role === 'realtime'
      ? { max: GATEWAY_POLICY.poolSize }
      : {}),
})
const db = createDatabase(pool)
const valkey = createValkey(config.valkeyUrl, logger)
// h:<DEPLOY_ENV>:, so environments that ever share a Valkey never see each other's keys.
const keyPrefix = valkeyPrefix(config.deployEnv)
const s3 = createS3(config.s3)

let api: ApiDeps | undefined
let realtime: RealtimeDeps | undefined
// Realtime's blocking reader connection, only for XREAD BLOCK on the org streams (valkey.ts).
let reader: Redis | undefined
// The api's and realtime's pub/sub channels, on a second Valkey connection of their own, and the
// flags they keep (T17): read as hearth_app, polled every 2 s and reloaded at once when the flags
// channel says an org changed.
let subscriptions: Subscriptions | undefined
let flags: FlagCache | undefined
if (config.role === 'api' || config.role === 'realtime') {
  subscriptions = new Subscriptions(createSubscriber(valkey, logger), logger)
  flags = new FlagCache({ db, logger })
  void flags.listen(subscriptions, valkeyKeys(keyPrefix).flags)
}
// The SMS provider config names (T20). Unset: no code can be sent, so code requests answer 503
// unavailable. Each factory refuses the wrong machine again, independently of config.ts.
function smsProvider(auth: NonNullable<typeof config.auth>): SmsProvider | undefined {
  if (auth.smsProvider === 'fake') return createFakeVerify({ deployEnv: config.deployEnv, appOrigin: config.appOrigin })
  if (auth.smsProvider === 'twilio') {
    if (auth.twilio === undefined) throw new Error('SMS_PROVIDER=twilio has no Twilio settings')
    return createTwilioVerify({ deployEnv: config.deployEnv, appOrigin: config.appOrigin, ...auth.twilio })
  }
  return undefined
}

if (config.role === 'api' && flags !== undefined) {
  // loadConfig refuses the api role without AUTH_SECRET, so this holds.
  if (config.auth === undefined) throw new Error('the api role has no sign-in settings')
  api = {
    db,
    valkey,
    keys: deriveKeys(config.auth.secret),
    sms: smsProvider(config.auth),
    // No provider is cleared in the transfer register until C0.9 passes the real gate here
    // (PDPA-10), so Twilio sends nothing before then.
    gate: C06_GATE,
    keyPrefix,
    flags,
  }
} else if (config.role === 'realtime' && flags !== undefined) {
  reader = createBlockingReader(valkey, logger)
  realtime = { db, valkey, reader, subscriptions, flags, keyPrefix }
}

// The worker: its work pool, its own pub/sub connection for the flags channel, and its loops: the
// org list first, then every other loop with its first round at once (worker/index.ts).
let workPool: Pool | undefined
let worker: Worker | undefined
if (config.role === 'worker') {
  // loadConfig gives the worker role its settings, so this holds.
  if (config.worker === undefined) throw new Error('the worker role has no worker settings')
  const registries = productionRegistries({ valkey, keyPrefix, logger })
  workPool = createPool(config.databaseUrl, logger, {
    max: workPoolSize(config.worker.concurrency, registries),
    applicationName: 'hearth-worker-work',
  })
  subscriptions = new Subscriptions(createSubscriber(valkey, logger), logger)
  worker = startWorker({
    control: db,
    work: createDatabase(workPool),
    subscriptions,
    keyPrefix,
    logger,
    concurrency: config.worker.concurrency,
    registries,
  })
}

const app = buildApp({
  appOrigin: config.appOrigin,
  logger,
  checks: {
    // Each login is held to its role's rule: hearth_app skips no row level security and can't act
    // as a job role; hearth_worker can become nothing that skips it, and can still take every job
    // role. The worker is ready once each of its loops has run a round.
    ...(worker !== undefined
      ? { postgres: workerRoleCheck(pool), worker_roles: workerRolesCheck(pool), worker: worker.check }
      : { postgres: appRoleCheck(pool) }),
    valkey: valkeyCheck(valkey),
    // Realtime never touches object storage, so an S3 outage doesn't fail its readiness (P2); its
    // gateway adds its own checks, and /ready/local.
    ...(config.role === 'realtime' ? {} : { storage: storageCheck(s3, config.s3.bucket) }),
  },
  trustProxy: config.trustProxy,
  api,
  realtime,
})

// Fastify logs "Server listening at …" with the role, from the logger's base fields.
const listening = app.listen({ host: config.host, port: config.port })

let stopping = false
async function stop(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return
  stopping = true
  logger.info({ signal }, 'stopping')
  setTimeout(() => {
    logger.error('shutdown took too long, exiting')
    process.exit(1)
  }, SHUTDOWN_TIMEOUT_MS).unref()
  // A server still binding its address can't be closed cleanly, so let listen() settle first.
  await listening.catch(() => {})
  // The worker stops claiming, firing and consuming, gives running jobs 3 s to finish and gives the
  // rest back; anything still in flight at 5 s is left to lease expiry.
  await worker?.stop(performance.now() + WORKER_STOP_MS)
  // Stop taking requests and let those in flight finish, then close the connections they used.
  // The api waits (at most 5 s) for work queued after its responses; the realtime role drains: it
  // refuses upgrades and closes its sockets with 1001 first, so this returns promptly.
  await app.close()
  flags?.stop()
  await Promise.race([
    Promise.allSettled([
      pool.end(),
      ...(workPool === undefined ? [] : [workPool.end()]),
      closeValkey(valkey),
      // Cut, not quit: a QUIT would wait behind the reader's XREAD, which the drain has made its last.
      ...(reader === undefined ? [] : [Promise.resolve(reader.disconnect())]),
      ...(subscriptions === undefined ? [] : [subscriptions.close()]),
    ]),
    delay(CLOSE_TIMEOUT_MS, undefined, { ref: false }),
  ])
  s3.destroy()
  logger.info('stopped')
  // Sockets that are still closing would otherwise keep the process alive for a while.
  process.exit(0)
}
process.once('SIGTERM', signal => void stop(signal))
process.once('SIGINT', signal => void stop(signal))

try {
  await listening
} catch (error) {
  logger.fatal({ err: error }, 'could not listen')
  process.exit(1)
}
