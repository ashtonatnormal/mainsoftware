// Telling the realtime role which sessions have ended (T5, ACC-05). After a commit that ended
// sessions (a sign-out, a deactivation, a PIN reset), the api publishes their ids on one Valkey
// channel, and every realtime process closes those sessions' sockets at once. It is best effort:
// a lost message is caught by the realtime role's re-check of every open socket (every 15 s, and
// with Postgres down too: realtime/socket.ts closes what it can't confirm within T5's 60 s), so a
// failure here is logged and swallowed, never turned into an error for the person who signed out.
// The message holds session ids only, never a token.
import type { Redis } from 'ioredis'
import type { Logger } from 'pino'
import { z } from 'zod'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'

// At most this many ids per message, so one message stays small whatever was ended.
export const REVOKED_CHUNK = 500

export const RevokedMessage = z.strictObject({
  v: z.literal(1),
  // When the api published it (epoch ms), for C0.7's revoke-to-close metric.
  at: z.number(),
  sessions: z.array(z.uuid()).max(REVOKED_CHUNK),
})
export type RevokedMessage = z.infer<typeof RevokedMessage>

type LogTo = Pick<Logger, 'warn' | 'error'>

export async function publishRevoked(
  valkey: Pick<Redis, 'publish'>,
  keyPrefix: string,
  sessionIds: readonly string[],
  logger: LogTo,
): Promise<void> {
  if (sessionIds.length === 0) return
  const channel = valkeyKeys(keyPrefix).revoked
  for (let start = 0; start < sessionIds.length; start += REVOKED_CHUNK) {
    const message: RevokedMessage = { v: 1, at: Date.now(), sessions: sessionIds.slice(start, start + REVOKED_CHUNK) }
    try {
      await valkey.publish(channel, JSON.stringify(message))
    } catch (error) {
      // The sessions have ended in Postgres already; the realtime re-check closes their sockets.
      logger.warn({ err: error, event: 'revocation_publish_failed', sessions: message.sessions.length })
    }
  }
}

// Subscribes the realtime role's own Valkey connection (valkey.ts createSubscriber) to the channel.
// Resolves once subscribed; realtime/index.ts keepSubscribed subscribes again after a reconnect. A
// message that isn't one of ours is logged and dropped.
export async function subscribeRevoked(
  subscriber: Pick<Redis, 'subscribe' | 'on'>,
  keyPrefix: string,
  onRevoked: (sessionIds: string[], at: number) => void,
  logger: LogTo,
): Promise<void> {
  const channel = valkeyKeys(keyPrefix).revoked
  subscriber.on('message', (from: string, text: string) => {
    if (from !== channel) return
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      value = undefined
    }
    const parsed = RevokedMessage.safeParse(value)
    if (!parsed.success) {
      logger.warn({ event: 'revocation_message_unreadable' })
      return
    }
    onRevoked(parsed.data.sessions, parsed.data.at)
  })
  await subscriber.subscribe(channel)
}
