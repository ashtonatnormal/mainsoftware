// The pub/sub channels a process listens on, all on one Valkey connection of its own (valkey.ts
// createSubscriber), since a subscribed connection can run nothing else: the realtime role's
// revocation channels (C0.5's revoked and C0.7's access, revocation/channels.ts) and the flags
// channel (C0.6, flags/channel.ts).
//
// Valkey forgets a subscription with the connection that made it, so each channel is subscribed
// again on every new connection after a reconnect. ioredis would do that itself, but nothing could
// handle its subscribe failing, which would end the process (main.ts), so valkey.ts turns that off
// and this does it instead: a subscribe that fails, or one sent while Valkey is down, is tried again
// every SUBSCRIBE_RETRY_MS until it works. Whatever a channel misses meanwhile, its listener's own
// fallback covers: the realtime role's re-check of every socket for revocations, the 2 s poll for
// flags (T14, T17).
import type { Redis } from 'ioredis'
import type { Logger } from 'pino'
import { failureFields } from '#src/db/sqlstate.ts'
import { closeValkey } from '#src/valkey.ts'

// How long to wait before subscribing to a channel again after a failed try.
export const SUBSCRIBE_RETRY_MS = 1000

type LogTo = Pick<Logger, 'info' | 'warn'>

interface Channel {
  // The channel itself, and a short name for the logs ('revoked', 'flags').
  channel: string
  name: string
  onMessage: (text: string) => void
  // True from a subscribe being sent until one succeeds, retries included.
  pending: boolean
  // Whether a failure has been logged since the last success.
  failed: boolean
  timer: NodeJS.Timeout | undefined
  subscribed: () => void
}

export class Subscriptions {
  readonly #subscriber: Redis
  readonly #logger: LogTo
  readonly #retryMs: number
  readonly #channels = new Map<string, Channel>()
  #stopped = false

  constructor(subscriber: Redis, logger: LogTo, options: { retryMs?: number } = {}) {
    this.#subscriber = subscriber
    this.#logger = logger
    this.#retryMs = options.retryMs ?? SUBSCRIBE_RETRY_MS
    subscriber.on('message', (channel: string, text: string) => {
      if (!this.#stopped) this.#channels.get(channel)?.onMessage(text)
    })
    // A new connection. The first one finds each first subscribe still pending, as does one that
    // comes back while a retry waits; only the subscribe is repeated, the listener stays.
    subscriber.on('ready', () => {
      for (const entry of this.#channels.values()) if (!entry.pending) this.#subscribe(entry)
    })
  }

  // Hands each message on the channel to onMessage, from now on. Resolves once the channel's first
  // subscribe has succeeded; never rejects, since it keeps trying until close().
  add(channel: string, name: string, onMessage: (text: string) => void): Promise<void> {
    if (this.#channels.has(channel)) throw new Error(`already listening on the ${name} channel`)
    return new Promise(resolve => {
      const entry: Channel = {
        channel,
        name,
        onMessage,
        pending: true,
        failed: false,
        timer: undefined,
        subscribed: resolve,
      }
      this.#channels.set(channel, entry)
      this.#subscribe(entry)
    })
  }

  // Stops retrying, drops whatever still arrives and closes the connection.
  async close(): Promise<void> {
    this.#stopped = true
    for (const entry of this.#channels.values()) clearTimeout(entry.timer)
    await closeValkey(this.#subscriber)
  }

  #subscribe(entry: Channel): void {
    if (this.#stopped) return
    entry.pending = true
    this.#subscriber.subscribe(entry.channel).then(
      () => {
        entry.pending = false
        entry.failed = false
        this.#logger.info({ event: 'channel_subscribed', channel: entry.name }, `listening on ${entry.name}`)
        entry.subscribed()
      },
      (error: unknown) => {
        // Logged once until it works; the connection's own errors are logged by valkey.ts.
        if (!entry.failed) {
          entry.failed = true
          this.#logger.warn(
            { event: 'channel_subscribe_failed', channel: entry.name, failure: failureFields(error) },
            `could not listen on ${entry.name} yet`,
          )
        }
        clearTimeout(entry.timer)
        if (this.#stopped) return
        entry.timer = setTimeout(() => {
          entry.timer = undefined
          this.#subscribe(entry)
        }, this.#retryMs)
        entry.timer.unref()
      },
    )
  }
}
