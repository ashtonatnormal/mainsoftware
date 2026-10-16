// Telling the realtime role who has lost access (T5, ACC-05; TECH-SPEC T19 item 5), on two Valkey
// pub/sub channels:
//   revoked  (C0.5, v1, unchanged on the wire) the api's push after a commit that ended sessions (a
//            sign-out, a deactivation, a PIN reset): their ids, and the api's clock just after the
//            commit. Every realtime process closes those sessions' sockets at once.
//   access   (C0.7, v1) everything new: the worker's revocation jobs (revocation/registry.ts) publish
//            the sessions they re-read as ended, with their revoked_at, and the people whose keys
//            changed, whom realtime re-checks against Postgres; from C0.16 the api's push for team,
//            role and phone changes too. Each message says which path sent it (push or durable) and
//            why (a cause code).
// Both are read tolerantly: a reader ignores fields it doesn't know, so a later step can add one
// once every running reader is from C0.7 or later, and on access an unknown cause is read as a
// re-check of the people it names. A publish is best effort for the api: a lost message is caught
// by the realtime role's re-check of every open socket (every 15 s, and with Postgres down too:
// realtime/socket.ts closes what it can't confirm within T5's 60 s), so a failure is logged and
// swallowed, never turned into an error for the person who signed out; a job's publish rethrows,
// so the job is tried again. Messages hold ids, codes and numbers (v and at) only, never a token.
// The same commits append signin.ended and acl.changed to the outbox (T16), which the worker's
// revocation consumer reads without missing any.
import { Code } from '@hearth/shared'
import type { Redis } from 'ioredis'
import type { Logger } from 'pino'
import { z } from 'zod'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'
import type { Subscriptions } from '#src/pubsub.ts'

// At most this many ids per message, so one message stays small whatever was ended.
export const REVOKED_CHUNK = 500

// v1, unchanged on the wire. From C0.7 every reader ignores fields it doesn't know (z.object
// strips them), so a later step can add one once every running reader is from C0.7 or later.
export const RevokedMessage = z.object({
  v: z.literal(1),
  // When the api published it (epoch ms), just after its commit: the push path's start time. The
  // durable path carries its own on access (the sessions' revoked_at).
  at: z.number(),
  sessions: z.array(z.uuid()).max(REVOKED_CHUNK),
})
export type RevokedMessage = z.infer<typeof RevokedMessage>

// At most this many sessions, and this many people, per access message.
export const ACCESS_CHUNK = 500

// v1, read tolerantly from the start. A message with v other than 1 is ignored (logged at debug),
// and an unknown cause is treated as a re-check of the people it names.
export const AccessMessage = z
  .object({
    v: z.literal(1),
    org: z.uuid(),
    path: z.enum(['push', 'durable']),
    // 'sessions_ended' or 'keys_changed' now (registry.ts REVOCATION_CAUSES).
    cause: Code,
    // When the change happened (epoch ms), if the publisher knows: a durable sessions message
    // carries the sessions' revoked_at; the api's push its clock just after its commit.
    at: z.number().int().positive().optional(),
    // Sessions that have ended: their sockets close at once with 4401.
    sessions: z.array(z.uuid()).max(ACCESS_CHUNK).optional(),
    // People whose access changed: realtime re-checks them against Postgres.
    people: z.array(z.uuid()).max(ACCESS_CHUNK).optional(),
  })
  .refine(m => (m.sessions?.length ?? 0) + (m.people?.length ?? 0) > 0, 'an access message names someone')
export type AccessMessage = z.infer<typeof AccessMessage>

type LogTo = Pick<Logger, 'warn' | 'error'>

// With rethrow, a failed publish is logged and then thrown, for a caller that is a retried job, so
// the job tries again with back-off and goes dead in the end, rather than finishing as though the
// message went out. The api's publish after its commit stays best effort.
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

// Publishes the message on the access channel, split so each part holds at most ACCESS_CHUNK
// sessions and ACCESS_CHUNK people; nothing when it names nobody. Best effort unless rethrow, as
// publishRevoked. A message the schema refuses is a bug in the caller: it is logged at error level
// and not sent (thrown with rethrow).
export async function publishAccess(
  valkey: Pick<Redis, 'publish'>,
  keyPrefix: string,
  message: AccessMessage,
  logger: LogTo,
  options: { rethrow?: boolean } = {},
): Promise<void> {
  const sessions = message.sessions ?? []
  const people = message.people ?? []
  const parts = Math.max(Math.ceil(sessions.length / ACCESS_CHUNK), Math.ceil(people.length / ACCESS_CHUNK))
  const channel = valkeyKeys(keyPrefix).access
  for (let part = 0; part < parts; part++) {
    const from = part * ACCESS_CHUNK
    const chunk = {
      v: message.v,
      org: message.org,
      path: message.path,
      cause: message.cause,
      ...(message.at === undefined ? {} : { at: message.at }),
      ...(from < sessions.length ? { sessions: sessions.slice(from, from + ACCESS_CHUNK) } : {}),
      ...(from < people.length ? { people: people.slice(from, from + ACCESS_CHUNK) } : {}),
    }
    const counts = { sessions: chunk.sessions?.length ?? 0, people: chunk.people?.length ?? 0 }
    const parsed = AccessMessage.safeParse(chunk)
    if (!parsed.success) {
      // zod's message would echo the ids.
      logger.error({ event: 'revocation_message_invalid', channel: 'access', ...counts })
      if (options.rethrow === true) throw new Error('an access message must match AccessMessage')
      return
    }
    try {
      await valkey.publish(channel, JSON.stringify(parsed.data))
    } catch (error) {
      // What ended has ended in Postgres already; the realtime re-check finds it.
      logger.warn({ err: error, event: 'revocation_publish_failed', channel: 'access', ...counts })
      if (options.rethrow === true) throw error
    }
  }
}

// Reads a message's JSON, or undefined for text that isn't JSON.
function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// Hands the ids of each well-formed message on the revoked channel to onRevoked, on the process's
// subscriber connection (pubsub.ts, which subscribes again after a reconnect). Resolves once
// subscribed. A message that isn't one of ours (another version included) is logged and dropped.
export function listenRevoked(
  subscriptions: Pick<Subscriptions, 'add'>,
  keyPrefix: string,
  onRevoked: (sessionIds: string[], at: number) => void,
  logger: LogTo,
): Promise<void> {
  return subscriptions.add(valkeyKeys(keyPrefix).revoked, 'revoked', text => {
    const parsed = RevokedMessage.safeParse(jsonOf(text))
    if (!parsed.success) {
      logger.warn({ event: 'revocation_message_unreadable' })
      return
    }
    onRevoked(parsed.data.sessions, parsed.data.at)
  })
}

// Hands each well-formed message on the access channel to onAccess, as listenRevoked does. A
// message of another version is ignored at debug, since a later publisher may send one before
// every reader knows it; anything else that isn't one of ours is logged at warn and dropped.
export function listenAccess(
  subscriptions: Pick<Subscriptions, 'add'>,
  keyPrefix: string,
  onAccess: (message: AccessMessage) => void,
  logger: Pick<Logger, 'debug' | 'warn' | 'error'>,
): Promise<void> {
  return subscriptions.add(valkeyKeys(keyPrefix).access, 'access', text => {
    const value = jsonOf(text)
    if (typeof value === 'object' && value !== null && 'v' in value && value.v !== 1) {
      logger.debug({ event: 'access_message_ignored', reason: 'version' })
      return
    }
    const parsed = AccessMessage.safeParse(value)
    if (!parsed.success) {
      logger.warn({ event: 'revocation_message_unreadable', channel: 'access' })
      return
    }
    onAccess(parsed.data)
  })
}
