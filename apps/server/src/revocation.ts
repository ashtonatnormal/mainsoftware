// Telling the realtime role which sessions have ended (T5, ACC-05). After a commit that ended
// sessions (a sign-out, a deactivation, a PIN reset), the api publishes their ids on one Valkey
// channel, and every realtime process closes those sessions' sockets at once. The publish is best
// effort: a lost message is caught by the realtime role's re-check of every open socket (every
// 15 s, and with Postgres down too: realtime/socket.ts closes what it can't confirm within T5's
// 60 s), so a failure here is logged and swallowed, never turned into an error for the person who
// signed out (the offboarding job's publish, below, is the exception). The message holds session ids only, never a token. From C0.6 the same commit also
// appends signin.ended to the outbox (T16), which its consumers read without missing any.
import type { Redis } from 'ioredis'
import type { Logger } from 'pino'
import { z } from 'zod'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'
import type { Subscriptions } from '#src/pubsub.ts'

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

// With rethrow, a failed publish is logged and then thrown, for a caller that is a retried job
// (the offboarding sockets handler, offboarding.ts), so the job tries again with back-off and goes
// dead in the end, rather than finishing as though the message went out. The api's publish after
// its commit stays best effort.
export async function publishRevoked(
  valkey: Pick<Redis, 'publish'>,
  keyPrefix: string,
  sessionIds: readonly string[],
  logger: LogTo,
  options: { rethrow?: boolean } = {},
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
      if (options.rethrow === true) throw error
    }
  }
}

// Hands the ids of each well-formed message on the revocation channel to onRevoked, on the
// process's subscriber connection (pubsub.ts, which subscribes again after a reconnect). Resolves
// once subscribed. A message that isn't one of ours is logged and dropped.
export function listenRevoked(
  subscriptions: Pick<Subscriptions, 'add'>,
  keyPrefix: string,
  onRevoked: (sessionIds: string[], at: number) => void,
  logger: LogTo,
): Promise<void> {
  return subscriptions.add(valkeyKeys(keyPrefix).revoked, 'revoked', text => {
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
}
