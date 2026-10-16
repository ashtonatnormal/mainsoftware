// Telling every process that an org's flags changed (TECH-SPEC T17 item 6). After a change commits,
// the api publishes { v: 1, org, key, revision, at } on the flags channel (h:<DEPLOY_ENV>:flags),
// and every process that keeps that org's flags reloads them from Postgres at once (cache.ts).
// Postgres holds the truth: the message only says when to look, so a lost one costs at most the
// 2 s poll, and a stray one (another local run, say) costs one reload. It holds ids, a flag key and
// numbers, never a person. Publishing is best effort, as the api's revocation publish is.
import { FLAG_KEY, FLAG_KEY_MAX } from '@hearth/shared'
import type { Redis } from 'ioredis'
import type { Logger } from 'pino'
import { z } from 'zod'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'
import { failureFields } from '#src/db/sqlstate.ts'

export const FlagsMessage = z.strictObject({
  v: z.literal(1),
  org: z.uuid(),
  key: z.string().max(FLAG_KEY_MAX).regex(FLAG_KEY),
  revision: z.number().int().positive(),
  // When the api published it (epoch ms).
  at: z.number(),
})
export type FlagsMessage = z.infer<typeof FlagsMessage>

export async function publishFlags(
  valkey: Pick<Redis, 'publish'>,
  keyPrefix: string,
  message: FlagsMessage,
  logger: Pick<Logger, 'warn'>,
): Promise<void> {
  try {
    await valkey.publish(valkeyKeys(keyPrefix).flags, JSON.stringify(FlagsMessage.parse(message)))
  } catch (error) {
    // The change is in Postgres already; every process sees it at its next poll.
    logger.warn({ event: 'flags_publish_failed', failure: failureFields(error) }, 'could not announce a flag change')
  }
}

// The message, or undefined for one that isn't ours.
export function readFlagsMessage(text: string): FlagsMessage | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  const parsed = FlagsMessage.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
