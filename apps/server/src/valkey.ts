// The Valkey client: ElastiCache for Valkey in AWS, the Compose stack's Valkey locally. C0.5's
// rate limiter and C0.7's realtime fan-out use it; until then it only answers the readiness
// check. Blocking commands, long scripts and any job queue need connections of their own,
// because every command on this one gives up after a second.
import { Redis } from 'ioredis'
import type { Logger } from 'pino'
import type { Check } from '#src/ready.ts'

export function createValkey(url: string, logger: Logger): Redis {
  const client = new Redis(url, {
    connectionName: 'hearth-server',
    // Bound every wait to a second, and fail a command at once while disconnected instead of
    // queueing it, so /ready reports an outage promptly. ioredis keeps reconnecting in the
    // background and recovers by itself.
    connectTimeout: 1000,
    commandTimeout: 1000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  })
  // ioredis reports why a connection failed only through this event; a command just fails with
  // "Connection is closed". Without a listener the error would crash the process. It fires on
  // every reconnect attempt, so a repeat of the same error isn't logged again.
  let lastError: string | undefined
  client.on('error', (error: Error) => {
    if (error.message === lastError) return
    lastError = error.message
    logger.warn({ err: error }, 'valkey connection error')
  })
  client.on('ready', () => {
    if (lastError !== undefined) logger.info('valkey connection restored')
    lastError = undefined
  })
  return client
}

export function valkeyCheck(client: Redis): Check {
  return async () => {
    const reply = await client.ping()
    if (reply !== 'PONG') throw new Error(`valkey answered PING with ${reply}`)
  }
}

// Closes the connection and stops reconnecting, which would otherwise keep the process alive
// after SIGTERM while Valkey is down.
export async function closeValkey(client: Redis): Promise<void> {
  if (client.status === 'ready') {
    await client.quit().catch(() => client.disconnect())
  } else {
    client.disconnect()
  }
}
