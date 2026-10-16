// Fan-out and resume for the realtime gateway (BUILD-PLAN C0.7, TECH-SPEC T19 item 9). Topic events
// go into one capped Valkey Stream per org, h:<env>:rt:{<org>}, which is also the resume buffer:
//   - The producer, publishTopicEvent(), runs one script that appends an entry (MAXLEN ~ 10000, at
//     most 2 KiB, ids only), creates the org's epoch key if it's missing, and refreshes both keys'
//     24 h expiry. Callers publish after their commit (api) or from a job (worker). C0.7 has no
//     production caller: C0.14's inbox, C0.16's team events, C0.18's banner and C1.1's chat are the
//     first.
//   - Every realtime process reads the streams of the orgs it has sockets in (StreamReader), with
//     XREAD BLOCK on a connection of its own (valkey.ts createBlockingReader), and sends each entry
//     as an ev frame to the sockets holding its topic live; a socket whose topic is still replaying
//     holds it until the replay is done. Entries are read and sent in stream order, and a socket's
//     frames go out in order, so a frame carrying a position at or below the reader's follows every
//     entry at or below it: ack, ev, pong and reset each tell the client every topic acked on the
//     socket is caught up to there (§6.9 item 3).
//   - The reported position (T19 item 9). Only an ev carries an exact id, for a topic the socket
//     holds. ack, pong and reset carry the org's reported position, which the reader sets on a timer
//     at the start of each 25 s grain (and at its first read of the org, and at a reset), never when
//     an entry arrives. At each grain's start every reader with sockets in the org also appends the
//     grain's tick, an entry {v:1,k:'tick'} with the id <start>-0 (TICK, if nothing at or after it
//     is there yet), which no socket is sent. So while ticks are written, the reader has always
//     dispatched an entry at or after the previous grain's start, and the reported position is that
//     start (reportedAt): a function of the clock alone, the same for every org and every member,
//     and at or below the reader's position, so the claim above holds. Only when the reader has
//     dispatched nothing since the previous grain's start (no tick written for a whole grain, as
//     while Valkey refuses writes, or the reader unable to read) does it fall back to the reader's
//     position rounded down to its grain, still set only at a grain's start: then it says at most
//     whether the org had an entry in a grain, once a grain, on that fixed schedule.
//   - The epoch, a random uuid beside the stream, names its continuity. A Valkey restart or failover
//     that loses the key gives a new one, and a reader that finds its epoch changed, its position
//     trimmed or the tail it read gone sends reset to every socket of the org. The tail is gone when
//     the stream's last entry is below the reader's position, or the entry at its position is
//     missing although the head is at or below it, which finds a failover's lost tail even when a
//     producer appended on the new primary first. Lost entries are lost for every reader and every
//     resume, so that reader also replaces the epoch: a since from before the loss then resets. The
//     reader reads an org only once its due gap check has passed, so no read moves its position past
//     a gap unseen. An absent stream under the same epoch is no gap: nothing was written after the
//     reader's position (S6). Entries lost before any reader read them can't be found. While
//     realtime has sockets in an org it refreshes both keys every 60 s, so a quiet org's stream
//     doesn't expire under its readers.
//   - A client resubscribes with since { epoch, pos }. planResume() decides whether the entries it
//     missed can be replayed: the same epoch, since at most 205 s old by its own time (so a client
//     can't probe the stream with an older one), nothing after since trimmed, the oldest missed
//     entry of its own topics at most 2 minutes old and at most 500 of them, and for a team topic a
//     membership that began before since (so a team left and rejoined while away replays nothing
//     from the gap; GW-09). It reads every entry after since, up to twice the stream's cap, but only
//     the resumed topics' own entries decide it: how many entries other topics have, and when, never
//     changes its answer. What still can is the trim test: a since within those 205 s resets once
//     the org's stream has overflowed its cap after it (T19 item 9's residual). Otherwise those
//     topics answer reset and the client refetches them over REST. ReplayQueue bounds how many
//     replays run at once (S5).
// Every entry and frame holds ids, codes and whole numbers only (T19 item 9): clients read content
// over REST, which checks access. A topic is decided by can() before anything of it is replayed or
// sent. Stream ids compare as (ms, seq) pairs of 64-bit numbers, never as strings (compareIds).
import { randomUUID } from 'node:crypto'
import { Code, IdsValues, LowerUuid, type Position, parseTopic, Topic, UUID_PATTERN } from '@hearth/shared'
import type { Redis } from 'ioredis'
import type { Logger } from 'pino'
import { z } from 'zod'
import { runScript, script } from '#src/auth/limiter.ts'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'
import { failureFields } from '#src/db/sqlstate.ts'
import { GATEWAY_POLICY, type GatewayPolicy, sinceMaxAgeMs } from '#src/realtime/policy.ts'

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

// The producer's one script: create the epoch if it's missing, append, cap, and refresh both keys'
// expiry. KEYS[1] the stream, KEYS[2] its epoch (one hash slot, {<org>}); ARGV[1] the cap, ARGV[2]
// the expiry in ms, ARGV[3] a new epoch, ARGV[4] the entry. Answers the new entry's id.
export const PUBLISH_TOPIC_EVENT = script(`
redis.call('SET', KEYS[2], ARGV[3], 'NX', 'PX', ARGV[2])
local id = redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[1], '*', 'f', ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
redis.call('PEXPIRE', KEYS[2], ARGV[2])
return id`)

const STREAM_ID = /^(\d{1,20})-(\d{1,20})$/

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

// The time an id was made (epoch ms, by Valkey's clock).
export function idTime(id: string): number {
  return Number(idParts(id)[0])
}

// The start of the grain of grainMs that the time `at` (epoch ms) is in.
export function grainStart(at: number, grainMs: number): number {
  return Math.floor(at / grainMs) * grainMs
}

// The position an org's sockets are told in ack, pong and reset (T19 item 9), as the reader sets it
// at the start of a grain, boundary, from the id it has dispatched up to, lastId: the start of the
// grain before, once lastId is at or after it, which the tick there makes so whatever other topics
// do; otherwise lastId rounded down to its grain. Either is at or below lastId, so every entry at or
// below it has been dispatched. The exact id would tell every member when the org's latest event
// happened, on any topic, theirs or not.
export function reportedAt(lastId: string, boundary: number, grainMs: number): string {
  const previous = `${Math.max(0, boundary - grainMs)}-0`
  if (compareIds(lastId, previous) >= 0) return previous
  return `${grainStart(idTime(lastId), grainMs)}-0`
}

// A grain's tick (T19 item 9): the entry each reader with sockets in the org appends at the start of
// each grain, with that start as its id, which no socket is sent. v1 like an event, but its own k.
export const TICK_ENTRY = JSON.stringify({ v: 1, k: 'tick' })

// The tick and the tail, in one script: create the epoch if it's missing (as the producer does),
// append the tick at <boundary>-0 unless the stream's last entry is already at or after it, refresh
// both keys' expiry, and answer the stream's last id (nil for an absent stream). An append Valkey
// refuses (its last generated id is past the boundary, though the entries there are gone) is left
// out: the reader's gap check finds such a loss. KEYS[1] the stream, KEYS[2] its epoch; ARGV[1] the
// boundary (ms), ARGV[2] the cap, ARGV[3] the expiry in ms, ARGV[4] a new epoch, ARGV[5] the tick.
export const TICK = script(`
redis.call('SET', KEYS[2], ARGV[4], 'NX', 'PX', ARGV[3])
local last = redis.call('XREVRANGE', KEYS[1], '+', '-', 'COUNT', 1)[1]
if last == nil or tonumber(string.match(last[1], '^(%d+)-')) < tonumber(ARGV[1]) then
  redis.pcall('XADD', KEYS[1], 'MAXLEN', '~', ARGV[2], ARGV[1] .. '-0', 'f', ARGV[5])
end
redis.call('PEXPIRE', KEYS[1], ARGV[3])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
local tail = redis.call('XREVRANGE', KEYS[1], '+', '-', 'COUNT', 1)[1]
if tail == nil then return false end
return tail[1]`)

// The ev frame for an entry, serialised once for every socket it goes to (§6.3).
export function evFrame(topic: string, pos: string, type: string, ids: IdsValues): string {
  return JSON.stringify({ v: 1, t: 'ev', topic, pos, type, ids })
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
// that misses one refetches at its next reset or resume. With rethrow (a job), a failure is thrown
// after it is logged, so the job is tried again. An entry that isn't ids only, names another org's
// org topic, or is over 2 KiB is a bug in the caller: it is logged at error level and not appended
// (thrown with rethrow).
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
      [policy.streamMaxLen, policy.streamTtlMs, randomUUID(), checked.text],
    )
    if (typeof id !== 'string' || !STREAM_ID.test(id)) throw new Error('the topic event script answered unexpectedly')
    return id
  } catch (error) {
    logger.warn({ err: error, event: 'topic_event_publish_failed', org: orgId })
    if (options.rethrow === true) throw error
    return undefined
  }
}

// An entry a replaying topic holds until its replay is done: its id and its ev frame.
export interface HeldEntry {
  id: string
  text: string
}

// A socket's hold on a topic, as far as the reader needs it (the gateway's own per-socket state,
// realtime/frames.ts, keeps more). A live topic gets each entry at once; a replaying one collects
// them in held, at most replayFramesMax, past which it is marked overflowed, its held entries are
// dropped, and its replay answers reset instead (§7.6 step 4).
export interface TopicHold {
  state: 'deciding' | 'replaying' | 'live'
  held?: HeldEntry[]
  overflowed?: boolean
}

// Adds an entry to a replaying topic's held list, or marks the topic overflowed once it is full.
export function holdEntry(hold: TopicHold, entry: HeldEntry, max: number): void {
  if (hold.overflowed === true) return
  if (hold.held === undefined) hold.held = []
  if (hold.held.length >= max) {
    hold.overflowed = true
    hold.held = []
    return
  }
  hold.held.push(entry)
}

// What the reader needs of the gateway (realtime/socket.ts): S is its socket type.
export interface StreamTarget<S> {
  // The orgs with at least one socket on this process: only their streams are read.
  orgsWithSockets(): Iterable<string>
  // The sockets holding the topic, replaying or live (its byTopic index).
  byTopic(orgId: string, topic: string): Iterable<S>
  holdOf(socket: S, topic: string): TopicHold | undefined
  // Sends an ev frame (never shed: it isn't droppable).
  send(socket: S, text: string): void
  // The org's stream lost continuity: tell every socket of the org at once (§5.5), with the reported
  // position in the epoch the reader continues in.
  resetOrg(orgId: string, position: Position): void
}

export interface StreamReaderOptions<S> {
  // The command client, for what never blocks (GET, SET, PEXPIRE, XRANGE, XREVRANGE and the tick's
  // script): 1 s is enough.
  valkey: Pick<Redis, 'get' | 'set' | 'pexpire' | 'xrange' | 'xrevrange' | 'evalsha' | 'eval'>
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
interface OrgState {
  stream: string
  epochKey: string
  epoch: string | undefined
  // The id of the last entry dispatched: the org's position. Undefined until the first read of the
  // stream's tail.
  lastId: string | undefined
  // The position its sockets are told (reportedAt), set with lastId at the first read and at a
  // reset, and at each grain's start; never when an entry arrives.
  reported: string | undefined
  initialising: Promise<void> | undefined
  // When the epoch and gaps are next checked, and both keys' expiry next refreshed.
  checkAt: number
  refreshAt: number
}

type Step = 'init' | 'read' | 'check' | 'refresh' | 'tick'

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
  // The timer for the next grain's start (wall clock).
  #grainTimer: NodeJS.Timeout | undefined
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

  // Starts the loop and the grain timer (once).
  start(): void {
    if (this.#running === undefined && !this.#stopped) this.#scheduleGrain()
    this.#running ??= this.#run().catch(error => {
      // Nothing in the loop should throw; if something does, readiness reports the reader stuck.
      this.#logger.error({ err: error, event: 'stream_reader_stopped' }, 'the stream reader stopped')
    })
  }

  // Stops the loop, which ends after its current XREAD (at most a block, or at once once the
  // reader's connection is closed), and the grain timer. Resolves when the loop has ended.
  async stop(): Promise<void> {
    this.#stopped = true
    clearTimeout(this.#grainTimer)
    this.#grainTimer = undefined
    this.#wake?.()
    await this.#running
  }

  // An org now has a socket here (the gateway's accept): read its stream's tail now, so its first
  // ack can carry a position, and read its stream from the next loop.
  watch(orgId: string): void {
    if (this.#stopped) return
    void this.#initialised(orgId)
    this.#wake?.()
  }

  // The org's position, once the reader has read the stream's tail; null if Valkey can't be reached,
  // so a subscribe never waits on Valkey for longer than the command client's timeouts.
  async position(orgId: string): Promise<Position | null> {
    return (await this.#initialised(orgId)) ? this.current(orgId) : null
  }

  // The same, read at once: the last position dispatched, or null before the tail has been read.
  current(orgId: string): Position | null {
    const state = this.#orgs.get(orgId)
    if (state?.epoch === undefined || state.lastId === undefined) return null
    return { epoch: state.epoch, pos: state.lastId }
  }

  // The position the org's sockets are told in ack, pong and reset (T19 item 9), read at once: at
  // or below current() whenever both are read in the same turn, and null before the tail has been
  // read.
  reported(orgId: string): Position | null {
    const state = this.#orgs.get(orgId)
    if (state?.epoch === undefined || state.lastId === undefined || state.reported === undefined) return null
    return { epoch: state.epoch, pos: state.reported }
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
      // The gap checks and refreshes that are due, before the read: an XREAD from a trimmed
      // position returns what is left after it, and one after a failover that lost the tail
      // returns what the new primary appended, so a gap is found only by comparing the stream with
      // the position the read would start from. An org whose due check failed waits for one that
      // passes.
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
        for (const [id, fields] of entries) {
          read.state.lastId = id
          this.#dispatch(read.orgId, id, fields)
        }
        // A full page: the reader is behind, so it checks for a trim past it before the next read.
        if (entries.length >= this.#policy.readerCount) read.state.checkAt = 0
      }
    }
  }

  // At the start of each grain (wall clock, as stream ids are): set every org's reported position
  // from what has been dispatched, then append the grain's tick for each, so the next grain's
  // reported position is this grain's start whatever other topics do (T19 item 9). A tick is best
  // effort: one that fails is logged, and the reported position falls back to the reader's own,
  // still set only here.
  #scheduleGrain(): void {
    const grain = this.#policy.positionGrainMs
    this.#grainTimer = setTimeout(() => this.#atGrain(), Math.max(1, grain - (Date.now() % grain)))
    this.#grainTimer.unref()
  }

  #atGrain(): void {
    this.#grainTimer = undefined
    if (this.#stopped) return
    // A timer that fires a moment early finds the grain before; the next one, 1 ms later, this one.
    const boundary = grainStart(Date.now(), this.#policy.positionGrainMs)
    const due: [string, OrgState][] = []
    for (const [orgId, state] of this.#orgs) {
      if (state.epoch === undefined || state.lastId === undefined) continue
      const next = reportedAt(state.lastId, boundary, this.#policy.positionGrainMs)
      if (state.reported === undefined || compareIds(next, state.reported) > 0) state.reported = next
      due.push([orgId, state])
    }
    for (const [, state] of due) {
      this.#tick(state, boundary).catch(error => {
        if (!this.#stopped) this.#failed('tick', error)
      })
    }
    this.#scheduleGrain()
  }

  // Runs the tick's script for the grain starting at boundary, and answers the stream's last id
  // (0-0 for an absent stream).
  async #tick(state: OrgState, boundary: number): Promise<string> {
    const tail = await runScript(
      this.#valkey,
      TICK,
      [state.stream, state.epochKey],
      [boundary, this.#policy.streamMaxLen, this.#policy.streamTtlMs, randomUUID(), TICK_ENTRY],
    )
    if (tail === null) return '0-0'
    if (typeof tail !== 'string' || !STREAM_ID.test(tail)) throw new Error('the tick script answered unexpectedly')
    return tail
  }

  // Each entry goes to the sockets holding its topic: at once if live, into the held list if the
  // topic is replaying. A tick goes to nobody.
  #dispatch(orgId: string, id: string, fields: readonly string[]): void {
    const text = fieldOf(fields, 'f')
    if (text === TICK_ENTRY) return
    const parsed = StreamEntry.safeParse(jsonOf(text))
    if (!parsed.success) {
      this.#skip()
      return
    }
    const { topic, type, ids } = parsed.data
    let frame: string | undefined
    for (const socket of this.#target.byTopic(orgId, topic)) {
      const hold = this.#target.holdOf(socket, topic)
      if (hold === undefined || hold.state === 'deciding') continue
      frame ??= evFrame(topic, id, type, ids)
      if (hold.state === 'live') this.#target.send(socket, frame)
      else holdEntry(hold, { id, text: frame }, this.#policy.replayFramesMax)
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
        reported: undefined,
        initialising: undefined,
        checkAt: 0,
        refreshAt: 0,
      }
      this.#orgs.set(orgId, state)
    }
    if (state.lastId === undefined) {
      const current = state
      current.initialising ??= this.#init(current).finally(() => {
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

  // The epoch (made if missing), then the tick for the current grain and the stream's last id after
  // it (TICK), whose entries after it are this process's to dispatch. The tick puts an entry at or
  // after the current grain's start in the stream before its tail is read, so the reported position
  // is the previous grain's start from the first, whenever the org's first socket arrives (T19 item
  // 9). Keys are refreshed at the first maintenance.
  async #init(state: OrgState): Promise<void> {
    try {
      const epoch = await this.#epoch(state, true)
      const boundary = grainStart(Date.now(), this.#policy.positionGrainMs)
      const last = await this.#tick(state, boundary)
      state.epoch = epoch
      state.lastId = last
      state.reported = reportedAt(last, boundary, this.#policy.positionGrainMs)
      state.checkAt = this.#now() + this.#policy.readerEpochCheckMs
      state.refreshAt = 0
    } catch (error) {
      this.#failed('init', error)
      throw error
    }
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

  // Before a read: the gap checks and expiry refreshes that are due, one org at a time. Answers the
  // orgs the read may include: those whose check wasn't due, or passed. One whose due check failed
  // is left out until a check passes, so the read can't move its position past a gap unseen.
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

  // The gap check (§5.5): the epoch changed (the key was lost: a restart, a failover), the stream
  // was trimmed past this reader, or the tail it read is gone: the stream's last entry is below the
  // reader's position, or the entry at its position is missing while the head is at or below it
  // (a failover that lost the tail, after which the new primary may already have appended above
  // it). Any of these resets the org's sockets, and the reader continues from the stream's last
  // entry in the epoch it found, read after the current grain's tick as at the first read, so the
  // reset's position is the reported one, the previous grain's start (T19 item 9). Entries appended
  // between the check's reads and that tail aren't sent: the reset, which goes after, covers them.
  // A lost tail is lost for every reader and every resume, so the reader replaces the epoch too: a
  // since from before the loss then answers reset_epoch, rather than resuming past entries that are
  // gone.
  async #check(orgId: string, state: OrgState): Promise<void> {
    const lastId = state.lastId
    const epoch = await this.#epoch(state, false)
    const [first] = await this.#valkey.xrange(state.stream, '-', '+', 'COUNT', 1)
    const [last] = await this.#valkey.xrevrange(state.stream, '+', '-', 'COUNT', 1)
    const shouldHold =
      lastId !== undefined && lastId !== '0-0' && first !== undefined && compareIds(first[0], lastId) <= 0
    const [held] = shouldHold ? await this.#valkey.xrange(state.stream, lastId, lastId, 'COUNT', 1) : []
    if (this.#orgs.get(orgId) !== state || lastId === undefined || state.lastId !== lastId) return
    let reason: 'epoch' | 'trimmed' | 'tail_lost' | undefined
    if (epoch !== state.epoch) reason = 'epoch'
    else if (first !== undefined && lastId !== '0-0' && compareIds(first[0], lastId) > 0) reason = 'trimmed'
    else if ((last !== undefined && compareIds(last[0], lastId) < 0) || (shouldHold && held === undefined)) {
      reason = 'tail_lost'
    }
    if (reason === undefined) return
    const continued = reason === 'tail_lost' ? await this.#replaceEpoch(state) : epoch
    const boundary = grainStart(Date.now(), this.#policy.positionGrainMs)
    const tail = await this.#tick(state, boundary)
    if (this.#orgs.get(orgId) !== state || state.lastId !== lastId) return
    state.epoch = continued
    state.lastId = tail
    state.reported = reportedAt(tail, boundary, this.#policy.positionGrainMs)
    this.#resets++
    this.#logger.info({ event: 'stream_reset', org: orgId, reason }, 'the org’s event stream lost continuity')
    this.#target.resetOrg(orgId, { epoch: continued, pos: state.reported })
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

// A field of a stream entry's flat [name, value, ...] list, or of a reply that is a list, a Map or
// a record (XINFO STREAM's, by the client's reply mapping).
function fieldOf(reply: unknown, name: string): unknown {
  if (Array.isArray(reply)) {
    for (let i = 0; i + 1 < reply.length; i += 2) if (reply[i] === name) return reply[i + 1]
    return undefined
  }
  if (reply instanceof Map) return reply.get(name)
  if (typeof reply === 'object' && reply !== null) return (reply as Record<string, unknown>)[name]
  return undefined
}

function jsonOf(text: unknown): unknown {
  if (typeof text !== 'string') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// How a resubscribed topic resumes (§7.6), as the gauges count them: resumed, its missed entries
// replayed; or reset, the client refetches it, because the membership began after since
// (reset_era), the stream's continuity can't be confirmed (reset_epoch: another epoch, or the stream
// couldn't be reached), since itself or the oldest missed entry of the resumed topics is too old
// (reset_window), entries after since were trimmed (reset_trimmed), the replay would be too long
// (reset_long), or it couldn't start in time (reset_busy). fresh is a subscribe with no since.
export const RESUME_OUTCOMES = [
  'resumed',
  'reset_era',
  'reset_epoch',
  'reset_window',
  'reset_trimmed',
  'reset_long',
  'reset_busy',
  'fresh',
] as const
export type ResumeOutcome = (typeof RESUME_OUTCOMES)[number]

export interface ResumeRequest {
  since: Position
  // The topics the decision allowed, now replaying.
  topics: readonly string[]
  // When the subscriber's current membership of each allowed team topic began (epoch ms, from
  // team_memberships.created_at in the lane's read). A team topic missing here resets (reset_era).
  eras: ReadonlyMap<string, number>
}

export interface ResumePlan {
  outcomes: Map<string, ResumeOutcome>
  // The missed entries of the resumed topics, oldest first, each as its ev frame.
  frames: (HeldEntry & { topic: string })[]
}

// Whether every entry after since is still in the stream: its first entry is at or below since,
// since trimming removes only from the head; or, for a since below it (a reported position, the
// start of a grain, can fall before a new stream's first entry), the stream was never trimmed
// (XINFO STREAM's entries-added equals its length; MAXLEN trimming doesn't move
// max-deleted-entry-id, so that can't be used). An absent or empty stream answers no: a since
// young enough to get here was told while the stream held at least its grain's tick, so it went.
async function untrimmed(valkey: Pick<Redis, 'xrange' | 'xinfo'>, stream: string, since: string): Promise<boolean> {
  const [first] = await valkey.xrange(stream, '-', '+', 'COUNT', 1)
  if (first === undefined) return false
  if (compareIds(first[0], since) <= 0) return true
  let info: unknown
  try {
    info = await valkey.xinfo('STREAM', stream)
  } catch (error) {
    // Absent: the stream went since its head was read.
    if (error instanceof Error && /no such key/i.test(error.message)) return false
    throw error
  }
  const added = Number(fieldOf(info, 'entries-added'))
  const length = Number(fieldOf(info, 'length'))
  if (!Number.isFinite(added) || !Number.isFinite(length)) throw new Error('XINFO STREAM answered unexpectedly')
  return added === length
}

// Decides how each topic of a resubscribe resumes from since, given the org's position now (the
// reader's, or null if Valkey can't be reached), in §7.6's order: the era of each team topic, then
// for the rest the epoch, since's own age, trimming, a since at or past the position (nothing to
// replay: the client saw it on another task), and the resumed topics' own missed entries: the
// window, from the oldest of them, and the frames' cap. A gap with none of their entries resumes.
// It reads every entry in (since, position], replayScanPage at a time, and counts only the resumed
// topics' own, so how many entries other topics have after since, and when, never changes its
// answer (T19 item 9); only a stream far past its cap, with more than replayScanMax entries after
// since, resets (reset_long). The trim test is the one step other topics' entries can still decide, and
// only for a since within sinceMaxAgeMs() (205 s): it resets once the stream has overflowed its cap
// after since. Reads on the command client; throws if Valkey can't answer, and the caller resets every
// topic (reset_epoch).
export async function planResume(
  valkey: Pick<Redis, 'xrange' | 'xinfo'>,
  stream: string,
  request: ResumeRequest,
  current: Position | null,
  options: { policy?: GatewayPolicy; now?: number } = {},
): Promise<ResumePlan> {
  const policy = options.policy ?? GATEWAY_POLICY
  const now = options.now ?? Date.now()
  const outcomes = new Map<string, ResumeOutcome>()
  const sinceMs = idTime(request.since.pos)
  const rest: string[] = []
  for (const topic of request.topics) {
    // Only a team topic: a person or org topic is held from the account's start, and a deactivation
    // is final (keep_history).
    if (parseTopic(topic)?.kind === 'team') {
      const began = request.eras.get(topic)
      if (began === undefined || began > sinceMs - policy.eraMarginMs) {
        outcomes.set(topic, 'reset_era')
        continue
      }
    }
    rest.push(topic)
  }
  const all = (outcome: ResumeOutcome, frames: ResumePlan['frames'] = []): ResumePlan => {
    for (const topic of rest) outcomes.set(topic, outcome)
    return { outcomes, frames }
  }
  if (rest.length === 0) return all('resumed')
  if (current === null || current.epoch !== request.since.epoch) return all('reset_epoch')
  // Older than any position a client keeps through a window away (a reported position is at most
  // two grains old when told): decided by since and the clock alone, before the stream is read, so
  // an older since learns nothing of it.
  if (sinceMs < now - sinceMaxAgeMs(policy)) return all('reset_window')
  if (!(await untrimmed(valkey, stream, request.since.pos))) return all('reset_trimmed')
  if (compareIds(request.since.pos, current.pos) >= 0) return all('resumed')
  const wanted = new Set(rest)
  const frames: ResumePlan['frames'] = []
  let after = request.since.pos
  let scanned = 0
  for (;;) {
    // Past replayScanMax, one more entry is enough to know there are more.
    const count = Math.min(policy.replayScanPage, policy.replayScanMax - scanned + 1)
    const page = await valkey.xrange(stream, `(${after}`, current.pos, 'COUNT', count)
    if (scanned + page.length > policy.replayScanMax) return all('reset_long')
    for (const [id, fields] of page) {
      const parsed = StreamEntry.safeParse(jsonOf(fieldOf(fields, 'f')))
      if (!parsed.success || !wanted.has(parsed.data.topic)) continue
      // The first is the oldest missed entry of the resumed topics, which decides the window.
      if (frames.length === 0 && idTime(id) < now - policy.resumeWindowMs) return all('reset_window')
      if (frames.length >= policy.replayFramesMax) return all('reset_long')
      const { topic, type, ids } = parsed.data
      frames.push({ id, topic, text: evFrame(topic, id, type, ids) })
    }
    scanned += page.length
    const last = page.at(-1)
    if (last === undefined || page.length < count) break
    after = last[0]
  }
  return all('resumed', frames)
}

type ReplayPolicy = Pick<
  GatewayPolicy,
  'replaysRunning' | 'replaysWaiting' | 'replaysWaitingPerSocket' | 'replayStartMs'
>

// The replay caps (S5; T19 item 9): at most replaysRunning replays at once in the process and
// replaysWaiting queued; one at a time per socket, with at most replaysWaitingPerSocket queued
// behind it. A replay that finds its queue full, or can't start within replayStartMs, is answered
// 'busy' (the caller resets its topics: reset_busy). Replays start in the order they were asked
// for, skipping one whose socket is still running another.
export class ReplayQueue {
  readonly #policy: ReplayPolicy
  readonly #runningFor = new Set<object>()
  readonly #waitingFor = new Map<object, number>()
  readonly #waiting: { socket: object; start: () => void }[] = []
  #running = 0

  constructor(policy: ReplayPolicy = GATEWAY_POLICY) {
    this.#policy = policy
  }

  run<T>(socket: object, replay: () => Promise<T>): Promise<T | 'busy'> {
    const waiting = this.#waitingFor.get(socket) ?? 0
    if (waiting === 0 && !this.#runningFor.has(socket) && this.#running < this.#policy.replaysRunning) {
      return this.#start(socket, replay)
    }
    if (waiting >= this.#policy.replaysWaitingPerSocket || this.#waiting.length >= this.#policy.replaysWaiting) {
      return Promise.resolve('busy')
    }
    return new Promise<T | 'busy'>((resolve, reject) => {
      const waiter = {
        socket,
        start: () => {
          clearTimeout(timer)
          this.#start(socket, replay).then(resolve, reject)
        },
      }
      const timer = setTimeout(
        () => {
          this.#unqueue(waiter)
          resolve('busy')
        },
        Math.max(1, this.#policy.replayStartMs),
      )
      timer.unref()
      this.#waiting.push(waiter)
      this.#waitingFor.set(socket, waiting + 1)
    })
  }

  counts(): { running: number; waiting: number } {
    return { running: this.#running, waiting: this.#waiting.length }
  }

  #start<T>(socket: object, replay: () => Promise<T>): Promise<T> {
    this.#running++
    this.#runningFor.add(socket)
    return Promise.resolve()
      .then(replay)
      .finally(() => {
        this.#running--
        this.#runningFor.delete(socket)
        this.#pump()
      })
  }

  #unqueue(waiter: { socket: object; start: () => void }): void {
    const at = this.#waiting.indexOf(waiter)
    if (at < 0) return
    this.#waiting.splice(at, 1)
    const left = (this.#waitingFor.get(waiter.socket) ?? 1) - 1
    if (left > 0) this.#waitingFor.set(waiter.socket, left)
    else this.#waitingFor.delete(waiter.socket)
  }

  // Starts the oldest waiting replays whose sockets are free, while there's room.
  #pump(): void {
    for (let at = 0; at < this.#waiting.length && this.#running < this.#policy.replaysRunning; ) {
      const waiter = this.#waiting[at] as { socket: object; start: () => void }
      if (this.#runningFor.has(waiter.socket)) {
        at++
        continue
      }
      this.#unqueue(waiter)
      waiter.start()
    }
  }
}
