// The server's entry point: `node src/main.ts`, with ROLE choosing api, realtime or worker (T2).
// All three roles come from one image and serve /health and /ready; what each adds arrives with
// later steps (the api routes from C0.5, the realtime gateway in C0.7, the worker's jobs as they
// are needed).
import { setTimeout as delay } from 'node:timers/promises'
import { buildApp } from '#src/app.ts'
import { ConfigError, loadConfig } from '#src/config.ts'
import { createPool, postgresCheck } from '#src/db/pool.ts'
import { createLogger } from '#src/logger.ts'
import { createS3, storageCheck } from '#src/storage/s3.ts'
import { closeValkey, createValkey, valkeyCheck } from '#src/valkey.ts'

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

const pool = createPool(config.databaseUrl, logger)
const valkey = createValkey(config.valkeyUrl, logger)
const s3 = createS3(config.s3)

const app = buildApp({
  appOrigin: config.appOrigin,
  logger,
  checks: {
    postgres: postgresCheck(pool),
    valkey: valkeyCheck(valkey),
    storage: storageCheck(s3, config.s3.bucket),
  },
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
  await app.close()
  await Promise.race([
    Promise.allSettled([pool.end(), closeValkey(valkey)]),
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
