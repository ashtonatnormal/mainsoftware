// The pub/sub channels a process listens on, all on one Valkey connection of its own (valkey.ts
// createSubscriber): the realtime role's revocation channels (C0.5's revoked and C0.7's access,
// revocation/channels.ts) and the flags channel (C0.6, flags/channel.ts). A separate connection, not
// because a subscribed connection can run nothing else (true only of RESP2; ioredis 6 speaks RESP3),
// but so pushes never queue behind a command, and so it can keep its offline queue while the
// command client fails fast.
//
// Valkey forgets a subscription with the connection that made it, so each channel is subscribed
// again on every new connection after a reconnect. ioredis would do that itself, but nothing could
// handle its subscribe failing, which would end the process (main.ts), so valkey.ts turns that off
// and this does it instead: a subscribe that fails, or one sent while Valkey is down, is tried again
// every SUBSCRIBE_RETRY_MS until it works. Whatever a channel misses meanwhile, its listener's own
// fallback covers: the realtime role's re-check of every socket for revocations, the 2 s poll for
// flags (T14, T17).
//
// An idle subscriber whose peer has vanished (a failover, a partition) would stay "ready" until TCP
// keepalive gave up, minutes later, since the connection's 2 s socket timeout runs only while a
// reply is awaited. So it sends PING every SUBSCRIBER_PING_MS: the reply arms that timeout, a dead
// connection is dropped within about 7 s, ioredis reconnects, and every channel is subscribed again
// (T19 item 12). PING is valid while subscribed under RESP3 and RESP2. isLive() says whether a
// channel is subscribed on the connection now, for the realtime role's readiness (T19 item 12).
import type { Redis } from 'ioredis'
import type { Logger } from 'pino'
import { failureFields } from '#src/db/sqlstate.ts'
import { closeValkey } from '#src/valkey.ts'

// How long to wait before subscribing to a channel again after a failed try.
export const SUBSCRIBE_RETRY_MS = 1000

// How often a ready subscriber connection sends PING, so a dead one is found within about 7 s.
export const SUBSCRIBER_PING_MS = 5000

type LogTo = Pick<Logger, 'debug' | 'info' | 'warn'>

interface Channel {
  // The channel itself, and a short name for the logs ('revoked', 'flags').
  channel: string
  name: string
  onMessage: (text: string) => void
  // True from a subscribe being sent until one succeeds, retries included.
  pending: boolean
  // True from a successful subscribe until the connection next closes.
  live: boolean
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
  readonly #pinger: NodeJS.Timeout
  #pinging = false
  #stopped = false

  constructor(subscriber: Redis, logger: LogTo, options: { retryMs?: number; pingMs?: number } = {}) {
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
    // The connection went: Valkey has forgotten every subscription it made.
    subscriber.on('close', () => {
      for (const entry of this.#channels.values()) entry.live = false
    })
    this.#pinger = setInterval(() => this.#ping(), options.pingMs ?? SUBSCRIBER_PING_MS)
    this.#pinger.unref()
  }

  // Whether the channel named name ('revoked', 'access', 'flags') is subscribed on the connection
  // now: from its subscribe succeeding until the connection next closes.
  isLive(name: string): boolean {
    for (const entry of this.#channels.values()) if (entry.name === name) return entry.live
    return false
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
        live: false,
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
    clearInterval(this.#pinger)
    for (const entry of this.#channels.values()) clearTimeout(entry.timer)
    await closeValkey(this.#subscriber)
  }

  // One PING at a time, only while the connection is ready (one sent otherwise would wait in the
  // offline queue). Its failure needs nothing: the connection's own error is logged by valkey.ts,
  // and its reconnect subscribes every channel again.
  #ping(): void {
    if (this.#stopped || this.#pinging || this.#subscriber.status !== 'ready') return
    this.#pinging = true
    this.#subscriber
      .ping()
      .catch((error: unknown) => {
        this.#logger.debug({ event: 'subscriber_ping_failed', failure: failureFields(error) })
      })
      .finally(() => {
        this.#pinging = false
      })
  }

  #subscribe(entry: Channel): void {
    if (this.#stopped) return
    entry.pending = true
    this.#subscriber.subscribe(entry.channel).then(
      () => {
        entry.pending = false
        entry.live = true
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
