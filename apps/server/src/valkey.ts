// The Valkey client: ElastiCache for Valkey in AWS, the Compose stack's Valkey locally. It answers
// the readiness check, and from C0.5 holds the rate limiter's windows and sign-in state between
// steps (auth/), and carries the revocation channel the realtime role subscribes to on a second
// connection (createSubscriber); C0.7's realtime fan-out uses it too. Blocking commands, long
// scripts and any job queue need connections of their own, because every command on this one
// gives up after a second.
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
    // A connection whose peer vanished without closing it (a failover, a network partition)
    // would otherwise stay "ready" with every command timing out until the kernel gives up,
    // about 15 minutes. This drops it when a reply is 2 s late; idle and subscribed
    // connections aren't affected, since the timer runs only while a reply is awaited.
    socketTimeout: 2000,
    // Reconnect at least once a second, so service resumes soon after an outage ends (the default
    // backs off to 5 s).
    retryStrategy: times => Math.min(2 ** times * 50, 1000),
  })
  watch(client, logger, 'valkey')
  return client
}

// A second connection for the revocation channel: a subscribed connection can run nothing else.
// Commands queue while it connects (enableOfflineQueue), and ioredis re-subscribes after a reconnect;
// the realtime re-check covers any message missed in between (T14).
export function createSubscriber(client: Redis, logger: Logger): Redis {
  const sub = client.duplicate({ connectionName: 'hearth-revocations', enableOfflineQueue: true })
  watch(sub, logger, 'valkey subscriber')
  return sub
}

// ioredis reports why a connection failed only through the error event; a command just fails
// with "Connection is closed". Without a listener the error would crash the process. It fires on
// every reconnect attempt, so a repeat of the same error isn't logged again.
function watch(client: Redis, logger: Logger, name: string): void {
  let lastError: string | undefined
  client.on('error', (error: Error) => {
    if (error.message === lastError) return
    lastError = error.message
    logger.warn({ err: error, connection: name }, `${name} connection error`)
  })
  client.on('ready', () => {
    if (lastError !== undefined) logger.info({ connection: name }, `${name} connection restored`)
    lastError = undefined
  })
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
