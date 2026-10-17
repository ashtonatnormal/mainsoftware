// Fan-out for the realtime gateway (BUILD-PLAN C0.7, TECH-SPEC T19 item 9). Topic events go into one
// Valkey Stream per org, h:<env>:rt:{<org>}, which carries them between processes and is never
// replayed to a client:
//   - The producer, publishTopicEvent(), runs one script that numbers and appends an entry (at most
//     2 KiB, ids only), trims entries older than a minute by Valkey's clock (MINID ~), keeps a cap of
//     about 100,000 entries only as a memory backstop (MAXLEN ~), creates the org's epoch key if it's
//     missing, and refreshes both keys' 24 h expiry. An entry's number (its n field) is the stream's
//     own count of entries ever added (XINFO STREAM's entries-added) once it is in, so each entry is
//     numbered one more than the entry before it for as long as the stream lasts. Callers publish
//     after their commit (api) or from a job (worker). C0.7 has no production caller: C0.14's inbox,
//     C0.16's team events, C0.18's banner and C1.1's chat are the first.
//   - Every realtime process reads the streams of the orgs it has sockets in (StreamReader), with
//     XREAD BLOCK on a connection of its own (valkey.ts createBlockingReader), and sends each entry
//     as an ev frame to the sockets holding its topic live. An ev carries the entry's topic, type and
//     ids, never its stream id or number: nothing a client is sent is read from the org's stream as a
//     whole.
//   - Resume is re-authorise and refetch (the owner's decision; T19 item 9). A reconnecting client
//     resubscribes, every topic is decided again by can(), and the client refetches each topic acked
//     ok over REST. So the gateway acks a sub once the reader follows the org's stream (it has read
//     the stream's tail, ready()): every entry appended after the ack is then dispatched, and
//     everything before it is in the client's fetch, which starts after the ack. If Valkey can't be
//     reached the ack goes anyway, and the reader resets the org once it reads the tail (late_start).
//   - Where the reader can't be sure it dispatched every entry of an org, it tells the gateway
//     (resetOrg), which sends each socket of the org a reset naming the topics it holds live, and the
//     clients refetch them (coalesced per org: below). It never moves past a gap it can detect
//     without that reset:
//       - Each entry a read returns is checked against the number of the entry before it, so a trim
//         is found whenever it landed, before the read or while the read was in flight. Numbered more
//         than one past it, entries after the reader's position were trimmed before it read them
//         (trimmed); at or below it, the stream lost entries the reader had read and was written
//         again (tail_lost). Either way the reader asks for the org's reset before it dispatches
//         the entry, and goes on from it. An entry with no number isn't the producer's: it isn't dispatched,
//         and the next numbered entry resets the org (unnumbered).
//       - The epoch, a random uuid beside the stream, names its continuity. A Valkey restart or
//         failover that loses the key gives a new one, and a reader that finds its epoch changed
//         resets the org (epoch). The checks, every 2 s and after a reconnect or a failure, also find
//         a lost tail: the stream's last entry below the reader's position, or the entry at its
//         position missing although the head is at or below it, which finds a failover's lost tail
//         even when a producer appended on the new primary first (tail_lost). The check reads the
//         head, the last entry and the entry at the position in one MULTI, so an ordinary append
//         that trims by age between separate reads can't make the reader's own last entry seem lost
//         (a reset timed by an event on another topic). A lost tail is lost for every reader, so the
//         reader that finds it, at a check or a read, also replaces the epoch, and every other
//         reader of the org resets too. An org whose due check failed isn't read until one passes.
//       - A read of an org's tail that succeeds after one failed resets the org (late_start),
//         whether the failed one was the read watch() starts at a socket's accept or one a sub
//         waited for (Valkey down: the ack waited no longer than the command client's 1 s timeout),
//         and whether or not a sub was acked between: one may have been, while the reader followed
//         nothing.
//       - An absent stream under the same epoch is no gap: nothing was written after the reader's
//         position (S6). Entries lost before any reader read them (a failover that keeps the epoch
//         and drops entries no reader had read) can't be found.
//     While realtime has sockets in an org it refreshes both keys every 60 s, so a quiet org's
//     stream doesn't expire under its readers.
//   - What a reset says. Every socket of the org that holds a topic gets it at the same moment,
//     naming only its own topics, so it never says which topic had events. The gateway coalesces an
//     org's resets on the trailing edge (realtime/socket.ts): the first goes at once, and any the
//     reader asks for in the next 5 s go as one at the end of that window. Trimming by age, not
//     count, makes a trim past a reader mean the reader fell a minute behind. That is a fact about
//     the server when the reader stalled or was cut off from Valkey (the full readiness fails after
//     7 s without a read; stuck() measures time since the last read, not how old the reader's
//     position is). The one way left for a reset to follow from the org's volume on topics a socket
//     doesn't hold is a reader that keeps reading but falls behind: a burst of more than about
//     100,000 entries that outruns it before it reads them. An
//     outrun reader finds a gap at every read while the burst lasts, so the sockets get a reset at
//     once and then one for each 5 s window the overload goes on (T19 item 9, What's left): they
//     learn that the org had such a burst, roughly when, and roughly how long it lasted, to within
//     5 s, but not how many events or on which topic.
// Every entry and frame holds ids, codes and whole numbers only (T19 item 9): clients read content
// over REST, which checks access. A topic is decided by can() before anything of it is sent. Stream
// ids compare as (ms, seq) pairs of 64-bit numbers, never as strings (compareIds). Neither an
// entry's id nor its number ever reaches a client (publishTopicEvent answers the id to its api or
// worker caller only).
import { randomUUID } from 'node:crypto'
import { Code, IdsValues, LowerUuid, parseTopic, Topic, UUID_PATTERN } from '@hearth/shared'
import type { Redis } from 'ioredis'
import type { Logger } from 'pino'
import { z } from 'zod'
import { runScript, script } from '#src/auth/limiter.ts'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'
import { failureFields } from '#src/db/sqlstate.ts'
import { GATEWAY_POLICY, type GatewayPolicy } from '#src/realtime/policy.ts'

// One stream entry: its one field, f, holds this as JSON. v1, read tolerantly: an entry with
// another v or k is skipped (counted, and logged at debug at most once a minute), and fields a
// later version adds are ignored.
export const StreamEntry = z.object({
  v: z.literal(1),
  k: z.literal('ev'),
  topic: Topic,
  // e.g. 'inbox.changed' (C0.14), 'team.members_changed' (C0.16).
  type: Code,
  ids: IdsValues,
})
export type StreamEntry = z.infer<typeof StreamEntry>

// The producer's one script: create the epoch if it's missing, number and append the entry, trim by
// age and then by the backstop cap, and refresh both keys' expiry. KEYS[1] the stream, KEYS[2] its
// epoch (one hash slot, {<org>}); ARGV[1] the age in ms past which entries are trimmed, ARGV[2] the
// cap, ARGV[3] the expiry in ms, ARGV[4] a new epoch, ARGV[5] the entry. The number is the stream's
// entries-added (0 for an absent stream) plus one, the count the XADD then makes it; the age is
// measured on Valkey's clock (TIME), which also makes the entries' ids. Answers the new entry's id.
export const PUBLISH_TOPIC_EVENT = script(`
redis.call('SET', KEYS[2], ARGV[4], 'NX', 'PX', ARGV[3])
local added = 0
if redis.call('EXISTS', KEYS[1]) == 1 then
  added = nil
  local info = redis.call('XINFO', 'STREAM', KEYS[1])
  for i = 1, #info, 2 do
    if info[i] == 'entries-added' then added = info[i + 1] end
  end
  if type(added) ~= 'number' then return redis.error_reply('ERR the stream has no entries-added') end
end
local now = redis.call('TIME')
local oldest = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000) - tonumber(ARGV[1])
if oldest < 0 then oldest = 0 end
local id = redis.call('XADD', KEYS[1], 'MINID', '~', string.format('%.0f-0', oldest), '*', 'n', string.format('%.0f', added + 1), 'f', ARGV[5])
redis.call('XTRIM', KEYS[1], 'MAXLEN', '~', ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
return id`)

const STREAM_ID = /^(\d{1,20})-(\d{1,20})$/
// An entry's number: a positive whole number, short enough to stay exact as a JS number.
const ENTRY_NUMBER = /^[1-9]\d{0,14}$/

function idParts(id: string): [bigint, bigint] {
  const [, ms, seq] = STREAM_ID.exec(id) ?? []
  if (ms === undefined || seq === undefined) throw new Error('not a stream id')
  return [BigInt(ms), BigInt(seq)]
}

// Orders two stream ids by (ms, seq), each a 64-bit number: '10-0' comes after '9-5', which a
// string comparison would get wrong.
export function compareIds(a: string, b: string): -1 | 0 | 1 {
  const [aMs, aSeq] = idParts(a)
  const [bMs, bSeq] = idParts(b)
  if (aMs !== bMs) return aMs < bMs ? -1 : 1
  if (aSeq !== bSeq) return aSeq < bSeq ? -1 : 1
  return 0
}

// The ev frame for an entry, serialised once for every socket it goes to (§6.3): the entry's own
// topic, type and ids, and nothing org-wide (no stream id).
export function evFrame(topic: string, type: string, ids: IdsValues): string {
  return JSON.stringify({ v: 1, t: 'ev', topic, type, ids })
}

// The entry's JSON, or why it can't go on the org's stream.
function entryText(orgId: string, entry: unknown, policy: GatewayPolicy): { reason: string } | { text: string } {
  if (!LowerUuid.safeParse(orgId).success) return { reason: 'org' }
  const parsed = StreamEntry.safeParse(entry)
  if (!parsed.success) return { reason: 'not_ids' }
  // An org topic names the org whose stream it goes on (NOT-03).
  const topic = parseTopic(parsed.data.topic)
  if (topic?.kind === 'org' && topic.id !== orgId) return { reason: 'other_org' }
  const text = JSON.stringify(parsed.data)
  if (Buffer.byteLength(text) > policy.entryMaxBytes) return { reason: 'too_large' }
  return { text }
}

// Appends an event to the org's stream, and answers its id (undefined if it wasn't appended). Best
// effort, as the revocation channels are for the api: a frame is a nudge to refetch, and a client
// that misses one refetches at its next reset or reconnect. With rethrow (a job), a failure is
// thrown after it is logged, so the job is tried again. An entry that isn't ids only, names another
// org's org topic, or is over 2 KiB is a bug in the caller: it is logged at error level and not
// appended (thrown with rethrow).
export async function publishTopicEvent(
  valkey: Pick<Redis, 'evalsha' | 'eval'>,
  keyPrefix: string,
  orgId: string,
  event: { topic: string; type: string; ids: Record<string, unknown> },
  logger: Pick<Logger, 'warn' | 'error'>,
  options: { rethrow?: boolean; policy?: GatewayPolicy } = {},
): Promise<string | undefined> {
  const policy = options.policy ?? GATEWAY_POLICY
  const entry = { v: 1, k: 'ev', topic: event.topic, type: event.type, ids: event.ids }
  const checked = entryText(orgId, entry, policy)
  if ('reason' in checked) {
    // zod's message would echo the values.
    logger.error({ event: 'topic_event_invalid', reason: checked.reason })
    if (options.rethrow === true) throw new Error(`a topic event must be ids only, at most 2 KiB (${checked.reason})`)
    return undefined
  }
  const keys = valkeyKeys(keyPrefix)
  try {
    const id = await runScript(
      valkey,
      PUBLISH_TOPIC_EVENT,
      [keys.stream(orgId), keys.epoch(orgId)],
      [policy.streamMaxAgeMs, policy.streamMaxLen, policy.streamTtlMs, randomUUID(), checked.text],
    )
    if (typeof id !== 'string' || !STREAM_ID.test(id)) throw new Error('the topic event script answered unexpectedly')
    return id
  } catch (error) {
    logger.warn({ err: error, event: 'topic_event_publish_failed', org: orgId })
    if (options.rethrow === true) throw error
    return undefined
  }
}

// What the reader needs of the gateway (realtime/socket.ts): S is its socket type.
export interface StreamTarget<S> {
  // The orgs with at least one socket on this process: only their streams are read.
  orgsWithSockets(): Iterable<string>
  // The sockets holding the topic live: the gateway's byTopic index, which holds a topic only from
  // the moment its decision makes it live (frames.ts), so a deciding topic gets nothing (its client
  // fetches it after its ack).
  byTopic(orgId: string, topic: string): Iterable<S>
  // Sends an ev frame (never shed: it isn't droppable).
  send(socket: S, text: string): void
  // The reader can't be sure every entry of the org reached the sockets holding its topics: tell
  // every socket of the org at the same moment (§5.5) to refetch the topics it holds live. The
  // gateway coalesces these per org on the trailing edge, so one asked for soon after another goes
  // at the end of its window, after the entries dispatched meanwhile.
  resetOrg(orgId: string): void
}

export interface StreamReaderOptions<S> {
  // The command client, for what never blocks (GET, SET, PEXPIRE, XREVRANGE, and the check's MULTI
  // of XRANGE and XREVRANGE): 1 s is enough.
  valkey: Pick<Redis, 'get' | 'set' | 'pexpire' | 'xrevrange' | 'multi'>
  // The blocking reader's own connection (valkey.ts createBlockingReader), only for XREAD BLOCK.
  reader: Pick<Redis, 'xread' | 'on'>
  keyPrefix: string
  target: StreamTarget<S>
  logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>
  policy?: GatewayPolicy
  // The monotonic clock for the reader's own deadlines (performance.now unless a test sets one).
  now?: () => number
}

// What the reader keeps of an org, forgotten when the org's last socket on this process closes (P1).
// Its position (lastId and lastN) and epoch never leave the reader.
interface OrgState {
  stream: string
  epochKey: string
  epoch: string | undefined
  // The id of the last entry read: where the next read starts. Undefined until the first read of the
  // stream's tail; 0-0 when the stream was absent or empty then.
  lastId: string | undefined
  // That entry's number: 0 when the stream was absent or empty at the tail's read, undefined when the
  // entry had none (it isn't the producer's). The next entry read must be numbered one more.
  lastN: number | undefined
  // A read found a lost tail: the next check, due at once, replaces the epoch before anything else,
  // so every other reader of the org resets too. Until it has, the org isn't read again.
  epochLost: boolean
  // A read of the tail failed: once one succeeds, the org's sockets are reset, since a sub may have
  // been acked meanwhile while the reader followed nothing.
  owesReset: boolean
  initialising: Promise<void> | undefined
  // When the epoch and gaps are next checked, and both keys' expiry next refreshed.
  checkAt: number
  refreshAt: number
}

type Step = 'init' | 'read' | 'check' | 'refresh'
type ResetReason = 'epoch' | 'trimmed' | 'tail_lost' | 'unnumbered' | 'late_start'

// How often skipped entries are logged at most.
const SKIPPED_LOG_MS = 60_000

// The stream reader of one realtime process: one loop, one XREAD at a time across every org it
// has sockets in.
export class StreamReader<S> {
  readonly #valkey: StreamReaderOptions<S>['valkey']
  readonly #reader: StreamReaderOptions<S>['reader']
  readonly #keys: ReturnType<typeof valkeyKeys>
  readonly #target: StreamTarget<S>
  readonly #logger: StreamReaderOptions<S>['logger']
  readonly #policy: GatewayPolicy
  readonly #now: () => number
  readonly #orgs = new Map<string, OrgState>()
  #running: Promise<void> | undefined
  #stopped = false
  #wake: (() => void) | undefined
  #lastGoodAt: number
  // Failures in a row, cleared by a successful read.
  #streak = 0
  #resets = 0
  #skipped = 0
  #skippedLogged = 0
  #skippedLoggedAt = Number.NEGATIVE_INFINITY

  constructor(options: StreamReaderOptions<S>) {
    this.#valkey = options.valkey
    this.#reader = options.reader
    this.#keys = valkeyKeys(options.keyPrefix)
    this.#target = options.target
    this.#logger = options.logger
    this.#policy = options.policy ?? GATEWAY_POLICY
    this.#now = options.now ?? (() => performance.now())
    this.#lastGoodAt = this.#now()
    // A new connection after a reconnect: the stream may have lost entries or its epoch meanwhile,
    // so every org is checked for a gap before long.
    this.#reader.on('ready', () => this.#checkAllSoon())
  }

  // Starts the loop (once).
  start(): void {
    this.#running ??= this.#run().catch(error => {
      // Nothing in the loop should throw; if something does, readiness reports the reader stuck.
      this.#logger.error({ err: error, event: 'stream_reader_stopped' }, 'the stream reader stopped')
    })
  }

  // Stops the loop, which ends after its current XREAD (at most a block, or at once once the
  // reader's connection is closed). Resolves when the loop has ended.
  async stop(): Promise<void> {
    this.#stopped = true
    this.#wake?.()
    await this.#running
  }

  // An org now has a socket here (the gateway's accept): read its stream's tail now, so its first
  // ack needn't wait, and read its stream from the next loop.
  watch(orgId: string): void {
    if (this.#stopped) return
    void this.#initialised(orgId)
    this.#wake?.()
  }

  // Whether the reader follows the org's stream: true once it has read the stream's tail, waiting
  // for that first read; false if Valkey can't be reached, so a subscribe never waits on Valkey for
  // longer than the command client's timeouts. After a false, the read that succeeds resets the
  // org's sockets.
  async ready(orgId: string): Promise<boolean> {
    return this.#initialised(orgId)
  }

  // How long since the reader last read (or, with no orgs, last looked): the gauges' readerLagMs.
  lagMs(): number {
    return Math.max(0, this.#now() - this.#lastGoodAt)
  }

  // Whether the reader has orgs and hasn't read for readerStuckMs: the full readiness fails (§11).
  stuck(): boolean {
    return this.#orgs.size > 0 && this.lagMs() > this.#policy.readerStuckMs
  }

  stats(): { orgs: number; lagMs: number; resets: number; skipped: number } {
    return { orgs: this.#orgs.size, lagMs: this.lagMs(), resets: this.#resets, skipped: this.#skipped }
  }

  async #run(): Promise<void> {
    while (!this.#stopped) {
      const orgs = new Set(this.#target.orgsWithSockets())
      for (const orgId of this.#orgs.keys()) if (!orgs.has(orgId)) this.#orgs.delete(orgId)
      if (orgs.size === 0) {
        this.#lastGoodAt = this.#now()
        await this.#sleep(this.#policy.readerIdleMs)
        continue
      }
      await Promise.all([...orgs].map(orgId => this.#initialised(orgId)))
      if (this.#stopped) break
      const ready: [string, OrgState][] = []
      for (const orgId of orgs) {
        const state = this.#orgs.get(orgId)
        if (state?.lastId !== undefined) ready.push([orgId, state])
      }
      if (ready.length === 0) {
        await this.#sleep(this.#policy.readerRetryMs)
        continue
      }
      // The epoch and tail checks and refreshes that are due, before the read: a failover that lost
      // the tail may leave nothing after the reader's position to read, or ids the new primary gave
      // at or below it, so a lost tail is found by comparing the stream with the position the read
      // would start from. An org whose due check failed waits for one that passes. (A trim is found
      // by the read itself: #take.)
      const readable = await this.#maintain(ready)
      if (this.#stopped) break
      if (readable.length === 0) {
        await this.#sleep(this.#policy.readerRetryMs)
        continue
      }
      let reply: [stream: string, entries: [id: string, fields: string[]][]][] | null
      try {
        reply = await this.#reader.xread(
          'COUNT',
          this.#policy.readerCount,
          'BLOCK',
          this.#policy.readerBlockMs,
          'STREAMS',
          ...readable.map(([, state]) => state.stream),
          ...readable.map(([, state]) => state.lastId as string),
        )
      } catch (error) {
        if (this.#stopped) break
        this.#failed('read', error)
        this.#checkAllSoon()
        await this.#sleep(this.#policy.readerRetryMs)
        continue
      }
      this.#streak = 0
      this.#lastGoodAt = this.#now()
      if (this.#stopped) break
      const byStream = new Map(readable.map(([orgId, state]) => [state.stream, { orgId, state }]))
      for (const [stream, entries] of reply ?? []) {
        const read = byStream.get(stream)
        if (read === undefined || this.#orgs.get(read.orgId) !== read.state) continue
        for (const [id, fields] of entries) this.#take(read.orgId, read.state, id, fields)
      }
    }
  }

  // An entry a read returned, checked against the number of the entry before it. Valkey trims only
  // from a stream's head and numbers every entry one more than the one before it, so this finds a
  // trim past the reader whenever it landed: before the read, or while the read was in flight (when
  // XREAD answers from the trimmed head, past the position it was asked for). Numbered more than one
  // past the last, entries after the reader's position were trimmed before it read them; at or below
  // it, the stream lost entries the reader had read and was written again, by a new primary after a
  // failover or as a new key, which every other reader must hear of too (the epoch, replaced at the
  // next check). Either way the org's sockets are reset before the entry is dispatched, and the
  // reader goes on from it: what follows the reset is sent as usual. An entry with no number isn't
  // the producer's and isn't dispatched, and since the reader can't tell what it hid, the next
  // numbered entry resets the org.
  #take(orgId: string, state: OrgState, id: string, fields: readonly string[]): void {
    const last = state.lastN
    const n = numberOf(fields)
    state.lastId = id
    state.lastN = n
    if (n === undefined) {
      this.#skip()
      return
    }
    if (last === undefined) this.#reset(orgId, 'unnumbered')
    else if (n > last + 1) this.#reset(orgId, 'trimmed')
    else if (n <= last) {
      state.epochLost = true
      state.checkAt = 0
      this.#reset(orgId, 'tail_lost')
    }
    this.#dispatch(orgId, fields)
  }

  // Each entry goes to the sockets holding its topic live, as one ev frame.
  #dispatch(orgId: string, fields: readonly string[]): void {
    const parsed = StreamEntry.safeParse(jsonOf(fieldOf(fields, 'f')))
    if (!parsed.success) {
      this.#skip()
      return
    }
    const { topic, type, ids } = parsed.data
    let frame: string | undefined
    for (const socket of this.#target.byTopic(orgId, topic)) {
      frame ??= evFrame(topic, type, ids)
      this.#target.send(socket, frame)
    }
  }

  #skip(): void {
    this.#skipped++
    const now = this.#now()
    if (now - this.#skippedLoggedAt < SKIPPED_LOG_MS) return
    this.#logger.debug({ event: 'stream_entry_skipped', skipped: this.#skipped - this.#skippedLogged })
    this.#skippedLogged = this.#skipped
    this.#skippedLoggedAt = now
  }

  // The org's state, made if it has none; and whether its tail has been read, reading it if not.
  // One read at a time per org; a failure leaves it unread, to try again.
  async #initialised(orgId: string): Promise<boolean> {
    let state = this.#orgs.get(orgId)
    if (state === undefined) {
      if (this.#stopped) return false
      state = {
        stream: this.#keys.stream(orgId),
        epochKey: this.#keys.epoch(orgId),
        epoch: undefined,
        lastId: undefined,
        lastN: undefined,
        epochLost: false,
        owesReset: false,
        initialising: undefined,
        checkAt: 0,
        refreshAt: 0,
      }
      this.#orgs.set(orgId, state)
    }
    if (state.lastId === undefined) {
      const current = state
      current.initialising ??= this.#init(orgId, current).finally(() => {
        current.initialising = undefined
      })
      try {
        await current.initialising
      } catch {
        return false
      }
    }
    return this.#orgs.get(orgId) === state && state.lastId !== undefined
  }

  // The epoch (made if missing), then the stream's last entry, whose entries after it are this
  // process's to dispatch (0-0 and number 0 for an absent stream, read from its start, so its first
  // entry must be numbered 1). Keys are refreshed at the first maintenance. A read that succeeds
  // after one failed resets the org's sockets.
  async #init(orgId: string, state: OrgState): Promise<void> {
    try {
      const epoch = await this.#epoch(state, true)
      const tail = await this.#tail(state)
      state.epoch = epoch
      this.#follow(state, tail)
      state.checkAt = this.#now() + this.#policy.readerEpochCheckMs
      state.refreshAt = 0
    } catch (error) {
      state.owesReset = true
      this.#failed('init', error)
      throw error
    }
    if (state.owesReset && this.#orgs.get(orgId) === state) {
      state.owesReset = false
      this.#reset(orgId, 'late_start')
    }
  }

  // The stream's last entry, its id and number (undefined if it has none), or undefined for an
  // absent or empty stream.
  async #tail(state: OrgState): Promise<{ id: string; n: number | undefined } | undefined> {
    const [last] = await this.#valkey.xrevrange(state.stream, '+', '-', 'COUNT', 1)
    if (last === undefined) return undefined
    if (!STREAM_ID.test(last[0])) throw new Error('XREVRANGE answered unexpectedly')
    return { id: last[0], n: numberOf(last[1]) }
  }

  // The reader goes on from the stream's last entry, as read by #tail.
  #follow(state: OrgState, tail: { id: string; n: number | undefined } | undefined): void {
    state.lastId = tail?.id ?? '0-0'
    state.lastN = tail === undefined ? 0 : tail.n
  }

  // The org's epoch. At init: SET NX, then GET the value that won. At a check: GET, and only if it's
  // missing SET NX and GET. A value that isn't a lower-case uuid (written by something else) is
  // replaced, which moves every reader to a new epoch, as a lost key would.
  async #epoch(state: OrgState, init: boolean): Promise<string> {
    let value = init ? null : await this.#valkey.get(state.epochKey)
    if (value === null) {
      await this.#valkey.set(state.epochKey, randomUUID(), 'PX', this.#policy.streamTtlMs, 'NX')
      value = await this.#valkey.get(state.epochKey)
    }
    if (value === null || !UUID_PATTERN.test(value)) {
      await this.#valkey.set(state.epochKey, randomUUID(), 'PX', this.#policy.streamTtlMs)
      value = await this.#valkey.get(state.epochKey)
    }
    if (value === null || !UUID_PATTERN.test(value)) throw new Error('the stream’s epoch could not be read')
    return value
  }

  // Before a read: the epoch and tail checks and expiry refreshes that are due, one org at a time.
  // Answers the orgs the read may include: those whose check wasn't due, or passed. One whose due
  // check failed is left out until a check passes, so the read can't move its position past a lost
  // tail unseen, and a lost tail a read found is told to every reader before this one reads on.
  async #maintain(ready: readonly [string, OrgState][]): Promise<[string, OrgState][]> {
    const readable: [string, OrgState][] = []
    for (const [orgId, state] of ready) {
      if (this.#stopped || this.#orgs.get(orgId) !== state) continue
      const now = this.#now()
      let checked = true
      if (now >= state.checkAt) {
        try {
          await this.#check(orgId, state)
          state.checkAt = this.#now() + this.#policy.readerEpochCheckMs
        } catch (error) {
          // Still due: tried again before the org is next read.
          checked = false
          this.#failed('check', error)
        }
      }
      if (now >= state.refreshAt) {
        try {
          await Promise.all([
            this.#valkey.pexpire(state.epochKey, this.#policy.streamTtlMs),
            this.#valkey.pexpire(state.stream, this.#policy.streamTtlMs),
          ])
          state.refreshAt = this.#now() + this.#policy.epochRefreshMs
        } catch (error) {
          this.#failed('refresh', error)
        }
      }
      if (checked && this.#orgs.get(orgId) === state) readable.push([orgId, state])
    }
    return readable
  }

  // The check (§5.5). First, a lost tail a read found (#take) is told to every other reader of the
  // org by replacing the epoch, which this reader then holds. Then: the epoch changed (the key was
  // lost: a restart, a failover; or another reader replaced it), or the tail this reader read is
  // gone: the stream's last entry is below the reader's position, or the entry at its position is
  // missing while the head is at or below it (a failover that lost the tail, after which the new
  // primary may already have appended, at or above the position; a read finds the case where its
  // entries come above it and are numbered at or below the last read, but not one where nothing
  // follows the position or the new primary's ids fall at or below it). Either resets the org's
  // sockets, and the reader continues from the stream's last entry in the epoch it found. Entries
  // appended between the check's reads and that tail aren't sent: the reset, which goes after,
  // covers them. A lost tail is lost for every reader, so the reader replaces the epoch too: every
  // other reader of the org then finds the change and resets its own sockets. Trims aren't looked
  // for here: a read finds every one past the reader by its entries' numbers, and the reader's own
  // last entry trimmed by age is no gap. The head, the last entry and the entry at the position are
  // read in one MULTI (#around), so an append that trims meanwhile can't pass for a lost tail.
  async #check(orgId: string, state: OrgState): Promise<void> {
    if (state.epochLost) {
      const replaced = await this.#replaceEpoch(state)
      if (this.#orgs.get(orgId) !== state) return
      state.epoch = replaced
      state.epochLost = false
    }
    const lastId = state.lastId
    if (lastId === undefined) return
    const epoch = await this.#epoch(state, false)
    const { first, last, held } = await this.#around(state, lastId)
    if (this.#orgs.get(orgId) !== state || state.lastId !== lastId) return
    const shouldHold = lastId !== '0-0' && first !== undefined && compareIds(first, lastId) <= 0
    let reason: ResetReason | undefined
    if (epoch !== state.epoch) reason = 'epoch'
    else if ((last !== undefined && compareIds(last, lastId) < 0) || (shouldHold && !held)) reason = 'tail_lost'
    if (reason === undefined) return
    const continued = reason === 'tail_lost' ? await this.#replaceEpoch(state) : epoch
    const tail = await this.#tail(state)
    if (this.#orgs.get(orgId) !== state || state.lastId !== lastId) return
    state.epoch = continued
    this.#follow(state, tail)
    this.#reset(orgId, reason)
  }

  // The ids of the stream's first and last entries (undefined for an absent or empty stream), and
  // whether it holds the entry at the reader's position, read in one MULTI so they describe one
  // moment's stream. Read one after another, a producer's append between them could trim by age
  // past the reader's own last entry (the first append after a minute of quiet does) once the head
  // was read at or below it: the entry would then seem lost from the middle of a stream whose head
  // is at or below it, and the org would be reset on an event on any topic, at a time that event
  // set. In one moment's stream, trims take only a prefix, so a head at or below the position means
  // the entry there is still in it unless the tail was lost.
  async #around(
    state: OrgState,
    lastId: string,
  ): Promise<{ first: string | undefined; last: string | undefined; held: boolean }> {
    const replies = await this.#valkey
      .multi()
      .xrange(state.stream, '-', '+', 'COUNT', 1)
      .xrevrange(state.stream, '+', '-', 'COUNT', 1)
      .xrange(state.stream, lastId, lastId, 'COUNT', 1)
      .exec()
    if (replies === null || replies.length !== 3) throw new Error('the check’s MULTI answered unexpectedly')
    const [first, last, held] = replies.map(([error, entries]) => {
      if (error !== null) throw error
      if (!Array.isArray(entries)) throw new Error('the check’s MULTI answered unexpectedly')
      const [entry] = entries as unknown[]
      if (entry === undefined) return undefined
      const id = Array.isArray(entry) ? entry[0] : undefined
      if (typeof id !== 'string' || !STREAM_ID.test(id)) throw new Error('the check’s MULTI answered unexpectedly')
      return id
    })
    return { first, last, held: held !== undefined }
  }

  #reset(orgId: string, reason: ResetReason): void {
    this.#resets++
    this.#logger.info({ event: 'stream_reset', org: orgId, reason }, 'the org’s event stream lost continuity')
    this.#target.resetOrg(orgId)
  }

  // A new epoch for the org's stream, written over the old one, and the value that won (another
  // reader that found the same loss may have written its own meanwhile; a reader still holding the
  // other finds the change at its next check).
  async #replaceEpoch(state: OrgState): Promise<string> {
    await this.#valkey.set(state.epochKey, randomUUID(), 'PX', this.#policy.streamTtlMs)
    const value = await this.#valkey.get(state.epochKey)
    if (value === null || !UUID_PATTERN.test(value)) throw new Error('the stream’s epoch could not be read')
    return value
  }

  #checkAllSoon(): void {
    for (const state of this.#orgs.values()) state.checkAt = 0
  }

  #failed(step: Step, error: unknown): void {
    this.#streak++
    const fields = { event: 'stream_reader_failed', step, failures: this.#streak, failure: failureFields(error) }
    if (this.#streak >= 3) this.#logger.error(fields, 'the stream reader keeps failing')
    else this.#logger.warn(fields, 'the stream reader failed')
  }

  // Waits ms, or until watch() or stop() wakes it.
  #sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => this.#wake?.(), Math.max(1, ms))
      timer.unref()
      this.#wake = () => {
        clearTimeout(timer)
        this.#wake = undefined
        resolve()
      }
    })
  }
}

// A field of a stream entry's flat [name, value, ...] list.
function fieldOf(fields: readonly unknown[], name: string): unknown {
  for (let i = 0; i + 1 < fields.length; i += 2) if (fields[i] === name) return fields[i + 1]
  return undefined
}

// An entry's number (its n field, which the producer's script writes), or undefined if it has none.
function numberOf(fields: readonly unknown[]): number | undefined {
  const text = fieldOf(fields, 'n')
  return typeof text === 'string' && ENTRY_NUMBER.test(text) ? Number(text) : undefined
}

function jsonOf(text: unknown): unknown {
  if (typeof text !== 'string') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
