// The server's entry point: `node src/main.ts`, with ROLE choosing api, realtime or worker (T2).
// All three roles come from one image and serve /health and /ready. The api role adds the
// sign-in, device and admin routes under /api, with its SMS provider (C0.5), and the flags route
// (C0.6); the realtime role adds the WebSocket on /ws, which closes a session's sockets when the
// api says it has ended (C0.5; C0.7's gateway grows from it). Both keep the flags of the orgs they
// serve, polled and told of changes on Valkey (C0.6, T17). The worker connects as hearth_worker;
// its loops come with C0.6's queue. Each role serves only its own routes (scripts/check-server.sh).
import { setTimeout as delay } from 'node:timers/promises'
import type { ApiDeps } from '#src/api.ts'
import { buildApp } from '#src/app.ts'
import { deriveKeys } from '#src/auth/crypto.ts'
import { createLogSmsProvider } from '#src/auth/sms/log.ts'
import { valkeyKeys, valkeyPrefix } from '#src/auth/valkey-keys.ts'
import { ConfigError, loadConfig } from '#src/config.ts'
import { createDatabase } from '#src/db/database.ts'
import { appRoleCheck, createPool, workerRoleCheck, workerRolesCheck } from '#src/db/pool.ts'
import { FlagCache } from '#src/flags/cache.ts'
import { createLogger } from '#src/logger.ts'
import { Subscriptions } from '#src/pubsub.ts'
import type { RealtimeDeps } from '#src/realtime/index.ts'
import { createS3, storageCheck } from '#src/storage/s3.ts'
import { closeValkey, createSubscriber, createValkey, valkeyCheck } from '#src/valkey.ts'

// ECS stops a task with SIGTERM and kills it after its stop timeout (30 s by default). Requests
// in flight get up to SHUTDOWN_TIMEOUT_MS to finish, and closing the connections after them at
// most CLOSE_TIMEOUT_MS, so a dependency that has stopped answering can't hold the process.
const SHUTDOWN_TIMEOUT_MS = 10_000
const CLOSE_TIMEOUT_MS = 3000

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
// itself in pg_stat_activity; the worker's second pool (work) comes with its loops.
const pool = createPool(config.databaseUrl, logger, {
  applicationName: config.role === 'worker' ? 'hearth-worker-control' : `hearth-${config.role}`,
})
const db = createDatabase(pool)
const valkey = createValkey(config.valkeyUrl, logger)
// h:<DEPLOY_ENV>:, so environments that ever share a Valkey never see each other's keys.
const keyPrefix = valkeyPrefix(config.deployEnv)
const s3 = createS3(config.s3)

let api: ApiDeps | undefined
let realtime: RealtimeDeps | undefined
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
if (config.role === 'api' && flags !== undefined) {
  // loadConfig refuses the api role without AUTH_SECRET, so this holds.
  if (config.auth === undefined) throw new Error('the api role has no sign-in settings')
  api = {
    db,
    valkey,
    keys: deriveKeys(config.auth.secret),
    // Unset: no code can be sent, so code requests answer 503 unavailable.
    sms:
      config.auth.smsProvider === 'log'
        ? createLogSmsProvider({ deployEnv: config.deployEnv, appOrigin: config.appOrigin })
        : undefined,
    keyPrefix,
    flags,
  }
} else if (config.role === 'realtime' && flags !== undefined) {
  realtime = { db, subscriptions, flags, keyPrefix }
}

const app = buildApp({
  appOrigin: config.appOrigin,
  logger,
  checks: {
    // Each login is held to its role's rule: hearth_app skips no row level security and can't act
    // as a job role; hearth_worker can become nothing that skips it, and can still take every job
    // role.
    ...(config.role === 'worker'
      ? { postgres: workerRoleCheck(pool), worker_roles: workerRolesCheck(pool) }
      : { postgres: appRoleCheck(pool) }),
    valkey: valkeyCheck(valkey),
    storage: storageCheck(s3, config.s3.bucket),
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
  // Stop taking requests and let those in flight finish, then close the connections they used.
  // The api waits (at most 5 s) for work queued after its responses; the realtime role closes its
  // sockets with 1001 first, so this returns promptly.
  await app.close()
  flags?.stop()
  await Promise.race([
    Promise.allSettled([
      pool.end(),
      closeValkey(valkey),
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
