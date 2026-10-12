// The Valkey client: ElastiCache for Valkey in AWS, the Compose stack's Valkey locally. C0.5's
// rate limiter and C0.7's realtime fan-out use it; until then it only answers the readiness
// check.
import { Redis } from 'ioredis'
import type { Check } from '#src/ready.ts'

export function createValkey(url: string): Redis {
  return new Redis(url, {
    // Connect on first use, and fail a command at once while disconnected instead of queueing it,
    // so /ready reports an outage rather than waiting for a reconnect.
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
  })
}

export function valkeyCheck(client: Redis): Check {
  return async () => {
    if (client.status === 'wait' || client.status === 'end') await client.connect()
    await client.ping()
  }
}

// Closes the connection and stops any reconnect attempts, which would otherwise keep the process
// alive after SIGTERM while Valkey is down.
export async function closeValkey(client: Redis): Promise<void> {
  if (client.status === 'ready') await client.quit().catch(() => {})
  client.disconnect()
}
