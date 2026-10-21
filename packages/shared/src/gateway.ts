// The realtime gateway's protocol (BUILD-PLAN C0.7, TECH-SPEC T19 item 10): the frames a client and
// the realtime role's /ws exchange, as zod schemas the server and C0.8's web app both import. Frames
// are JSON text and each carries v, the protocol version. They hold ids, codes and whole numbers
// only: an ev is a nudge to refetch over REST, which checks access, never content (T19 item 9). No
// frame carries a stream position, an epoch or anything else read from the org's event stream as a
// whole. A reset comes to every socket of the org at the same moment and names only the socket's
// own topics, so it never says which topic had events. The org's volume can cause one only by a
// burst of more than about 100,000 events that outruns a server's reader (the stream is trimmed by
// age, and its count cap is a memory backstop), and the server coalesces an org's resets to one at
// once and at most one each 5 s after: an overload that lasts gives one reset for each 5 s it goes
// on, which says roughly when and for how long the org was that busy, never how many events or on
// which topic (T19 item 9). The server reads client frames strictly; clients read server frames
// leniently, so the server may add to a version without a stale client missing a drop or a reset
// (P5, P6).
//
// The client's side (T19 item 10), for C0.8:
// 1. Open wss://<app host>/ws (same origin, so the cookie goes with it), send hello at once naming
//    every version it speaks, and wait for welcome. Use welcome's v in every later frame, and keep
//    its reconnectSpreadMs ("the spread"), which every pong updates.
// 2. Subscribe, then fetch. sub at most 50 topics a frame and 100 a socket. Fetch a topic's state
//    over REST only after an ack lists it ok, and fetch every topic each such ack lists ok, a
//    repeated sub's included. An ev that arrives during the fetch means fetch again; an ev for a
//    topic whose sub hasn't been acked yet changes nothing, since the fetch after its ack covers it.
//    Send ack.retry's topics again after a random 1-5 s, backing off to 30 s. A topic in
//    ack.refused is missing or not allowed, alike: forget it and wipe its cached server data, as
//    for dropped. A repeated sub, of a topic the socket already holds, decides nothing: its ack
//    lists the topic ok if it is live in the generation the sub found (the same hold, not ended and
//    made again since), and otherwise in retry (an earlier sub is still deciding it, or answered it
//    refused or retry meanwhile). So a repeat sent before the first sub's ack may be answered ok or
//    retry: don't count on a repeat's ack, wait for the first's. A topic ended meanwhile is in no
//    list: one asked for but in none of the ack's lists was dropped (its dropped frame came before
//    the ack) or unsubscribed after the sub was sent.
//    Every frame the client sends takes a token from the socket's bucket, protocol pings and pongs
//    included (only the pong answering the server's own ping is free): GATEWAY_LIMITS.frameBurst
//    (20), full when the socket opens, refilled at framesPerSecond (5) a second. An empty bucket
//    closes the socket with 1008 too_many_frames, treated as abuse (item 7). So put a navigation's
//    topic changes into one unsub and one sub, debounce them (keep a topic a moment after its view
//    closes, so quick back-and-forth sends nothing), and send at most one visibility or online ping
//    every few seconds. A reconnect (hello and ⌈topics/50⌉ subs) fits the burst.
// 3. Reconnect: re-authorise and refetch (the owner's decision, TECH-SPEC T19 item 9). A new socket
//    holds nothing, and the server replays nothing and keeps no position for a client. After any
//    (re)connect, sub every topic the view needs, in ⌈topics/50⌉ sub frames, and refetch each topic
//    acked ok over REST, as in item 2: that fetch is how the client learns what changed while it
//    was away. Each topic is decided again, so one lost while away is refused (item 2), and its
//    cached server data goes. C1.1's per-conversation sequences make that catch-up cheap over REST.
// 4. ev: something changed on its topic: refetch what its ids name (an unknown key is ignored). It
//    carries the event's own ids for that topic and nothing about the org's other events.
// 5. dropped: forget the topic and wipe its cached server data; an unknown reason reads as 'access'.
//    reset: events on the topics it names may not have reached this socket (the server lost track
//    of the org's event stream for a moment): refetch each of them that the client holds over REST
//    at a random time within the spread; an unknown reason reads as 'gap'. A reset that comes while
//    the refetch an earlier one asked for still waits to start asks for nothing more; one that
//    comes after it started means refetch again. nudge 'flags': GET
//    /api/flags at a random time within the spread. Neither a drop nor a sign-out discards unsynced
//    local edits: they are shown and offered as a copy (NFR-04).
// 6. Heartbeat. ping every 25 s, and whenever the page becomes visible or comes online (at most one
//    every few seconds: item 2's bucket). No frame within 10 s of a ping means the socket is dead:
//    close it and reconnect (item 3).
// 7. Closes. 4401: go to sign-in, and never reconnect. 4403: show the notice (C0.9), and reconnect
//    once it is acknowledged. 4426: reload. 1008 with an abuse reason: back off from 30 s. Any other
//    close of an open socket, 1006 and 1001 included: wait a random time within the spread, then
//    retry with full-jitter back-off from 1 s to 30 s, and resubscribe and refetch as item 3 says.
//    Never rely on seeing a particular code: 1006 is the fallback for all of them. After 30 s of
//    failed reconnects, at a random point in the next 5 s, GET /api/flags: a 401 means go to sign-in.
//    While 4403 or 4426 has the client paused, no socket can hear a 4401, so it asks GET /api/flags
//    at a random point in the first 30 s and every 30 s after until it resumes: a 401 means go to
//    sign-in. So every tab one 4403 paused polls /api/flags until the notice is acknowledged.
import { z } from 'zod'
import { CODE, CODE_MAX, IDS_KEY, IDS_LIST_MAX, IDS_NUMBER_MAX, LowerUuid, UUID_SOURCE } from './ids.ts'

export const GATEWAY_PATH = '/ws'
// The protocol versions this build speaks, oldest first. hello names the client's, welcome the one
// chosen.
export const GATEWAY_VERSIONS = [1] as const
export const GATEWAY_LIMITS = {
  maxFrameBytes: 4096, // a client frame over this closes the socket (1009)
  maxTopicsPerFrame: 50,
  maxTopicsPerSocket: 100, // counting topics still being decided
  heartbeatMs: 25_000, // the client pings this often (and the server)
  pongTimeoutMs: 10_000, // a client gives up on a socket silent this long after its ping
  helloTimeoutMs: 10_000, // the server closes a socket that hasn't said hello by then
  frameBurst: 20, // the inbound token bucket, full when a socket opens; every frame takes a token
  framesPerSecond: 5, // the bucket's refill, a second; past it the socket closes (1008 too_many_frames)
} as const

// A topic is <kind>:<uuid> (T19 item 7): a person's own, their org's, or a team's. C1.1 adds spaces.
// packages/access decides each one (topic.subscribe), and its TOPIC_KINDS must equal these.
export const GATEWAY_TOPIC_KINDS = ['person', 'org', 'team'] as const
export type GatewayTopicKind = (typeof GATEWAY_TOPIC_KINDS)[number]
// UUID_SOURCE is ids.ts's lower-case form, the one the database's is_ids_only() accepts.
export const TOPIC_PATTERN = new RegExp(`^(${GATEWAY_TOPIC_KINDS.join('|')}):(${UUID_SOURCE})$`)
export const Topic = z.string().max(64).regex(TOPIC_PATTERN)

export function parseTopic(topic: string): { kind: GatewayTopicKind; id: string } | undefined {
  const [, kind, id] = TOPIC_PATTERN.exec(topic) ?? []
  if (kind === undefined || id === undefined) return undefined
  return { kind: kind as GatewayTopicKind, id }
}

export const Code = z.string().max(CODE_MAX).regex(CODE)
// An ev's ids, ids only (ids.ts's rule, by value): uuids, codes, booleans, whole numbers from 0 to
// 1,000,000, and lists of at most 100 uuids.
export const IdsValues = z.record(
  z.string().regex(IDS_KEY),
  z.union([LowerUuid, Code, z.boolean(), z.int().min(0).max(IDS_NUMBER_MAX), z.array(LowerUuid).max(IDS_LIST_MAX)]),
)
export type IdsValues = z.infer<typeof IdsValues>

// Why a topic was dropped: 'access', it was lost (Rule 6). C1.1 may add 'gone' (deletions).
export const GATEWAY_DROP_REASONS = ['access'] as const
// Why the server asks for a refetch (reset): 'gap', events on those topics may not have reached the
// socket, because the server lost track of the org's event stream. The causes (T19 item 9, Gaps)
// are: Valkey restarted or failed over, losing the stream's epoch or entries a reader had read
// (epoch, tail_lost); entries were trimmed before a reader read them, because it stalled for longer
// than the stream keeps entries or a burst of more than about 100,000 events outran it (trimmed);
// the stream held an entry the producer's script didn't write (unnumbered); or a reader's read of
// the stream's tail failed before one succeeded, so a sub may have been acked while it followed
// nothing (late_start). The client sees only 'gap'.
export const GATEWAY_RESET_REASONS = ['gap'] as const
// What a nudge asks the client to re-read: 'flags', GET /api/flags (T17 item 11).
export const GATEWAY_NUDGES = ['flags'] as const
export type GatewayNudge = (typeof GATEWAY_NUDGES)[number]

// Every close the server sends (T19 item 10), and what the client does on it (the header's item 7).
// A reason is at most 123 bytes, and every code is one ws sends and accepts. 1009 (a frame over
// 4 KiB) and 1002 or 1007 (a protocol error) are ws's own, and 1006 is what a client sees for any
// close it got no frame for, so a client never relies on seeing a particular code.
export const GATEWAY_CLOSE = {
  // The session ended, for any reason: go to sign-in, and never reconnect.
  signedOut: { code: 4401, reason: 'signed_out' },
  // The admission hook (C0.9) no longer admits the person: show the notice, and reconnect once it
  // is acknowledged. Not a sign-out: nothing is wiped.
  noticeRequired: { code: 4403, reason: 'notice_required' },
  // The client's newest version is older than the server's: reload.
  clientOutdated: { code: 4426, reason: 'client_outdated' },
  // The session or a topic couldn't be confirmed in time, the org has no system principal, or the
  // client is newer than this server (a deploy in progress): reconnect within the spread.
  tryAgain: { code: 1013, reason: 'try again later' },
  // The server is stopping (drain at SIGTERM): reconnect within the spread.
  stopping: { code: 1001, reason: 'server stopping' },
  // The send buffer stayed too full: reconnect within the spread, then resubscribe and refetch.
  tooSlow: { code: 4408, reason: 'too_slow' },
  // No hello in time: reconnect within the spread, then back off as usual.
  helloTimeout: { code: 1008, reason: 'hello_timeout' },
  // Abuse or a bug in the client: back off from 30 s, and report.
  badFrame: { code: 1008, reason: 'bad_frame' },
  tooManyFrames: { code: 1008, reason: 'too_many_frames' },
  tooManyTopics: { code: 1008, reason: 'too_many_topics' },
  // A frame handler threw: reconnect within the spread, then back off.
  internalError: { code: 1011, reason: 'internal_error' },
} as const
export type GatewayClose = keyof typeof GATEWAY_CLOSE

// Client to server.

const id = z.int().min(1).max(1_000_000)
const topics = z.array(Topic).min(1).max(GATEWAY_LIMITS.maxTopicsPerFrame)
const version = z.int().min(1).max(1000)

// hello has the same shape in every version, so any server can read any client's: v is the
// client's newest version, versions every one it speaks. Read with z.object, so a later version
// may add fields.
export const Hello = z.object({ v: version, t: z.literal('hello'), versions: z.array(version).min(1).max(8) })
export type Hello = z.infer<typeof Hello>

// Every later frame, strictly, in the version welcome chose (1 here).
export const ClientFrame = z.discriminatedUnion('t', [
  // Topics only: nothing about where the client was, so the server decides each one again and the
  // client refetches it over REST (header item 3).
  z.strictObject({ v: z.literal(1), t: z.literal('sub'), id, topics }),
  z.strictObject({ v: z.literal(1), t: z.literal('unsub'), id, topics }),
  z.strictObject({ v: z.literal(1), t: z.literal('ping') }),
])
export type ClientFrame = z.infer<typeof ClientFrame>

// The highest version both speak; or why there's none. client_outdated: the client's newest version
// is older than the server's newest, so a reload brings a bundle that speaks it (with contiguous
// versions, the client is older than every version the server speaks). server_outdated: the client
// is newer than every version the server speaks, so it reconnects, and reaches a newer task once the
// deploy moves on.
export function chooseVersion(
  versions: readonly number[],
  speaks: readonly number[] = GATEWAY_VERSIONS,
): { v: number } | 'client_outdated' | 'server_outdated' {
  const common = versions.filter(v => speaks.includes(v))
  if (common.length > 0) return { v: Math.max(...common) }
  return Math.max(...versions) < Math.max(...speaks) ? 'client_outdated' : 'server_outdated'
}

// Server to client: what the server sends, strictly.

const count = z.int().min(0).max(IDS_NUMBER_MAX)

export const ServerFrame = z.discriminatedUnion('t', [
  // The answer to hello: the version chosen, limits the client must keep, this socket's id for
  // support logs, and how widely to spread a reconnect.
  z.strictObject({
    v: z.literal(1),
    t: z.literal('welcome'),
    socket: z.uuid(),
    heartbeatMs: count,
    maxTopics: count,
    maxTopicsPerFrame: count,
    maxFrameBytes: count,
    reconnectSpreadMs: count,
  }),
  // The answer to sub or unsub. ok: held now (sub: fetch each over REST, header item 2) or no longer
  // held (unsub). refused: missing or not allowed, alike (PRD-108). retry: not decided (the
  // database couldn't be reached in time), or still being decided for an earlier sub on this
  // socket: send them again after a back-off. A topic dropped before the ack is in none of these
  // (its dropped frame came first), nor is one unsubscribed after the sub.
  z.strictObject({
    v: z.literal(1),
    t: z.literal('ack'),
    id,
    ok: z.array(Topic),
    refused: z.array(Topic),
    retry: z.array(Topic),
  }),
  // Something changed on a topic: refetch what these ids name. It carries the event's own ids for
  // its topic and nothing org-wide: no stream id, no position.
  z.strictObject({
    v: z.literal(1),
    t: z.literal('ev'),
    topic: Topic,
    type: Code,
    ids: IdsValues,
  }),
  // These topics are no longer held. 'access': lost access (Rule 6).
  z.strictObject({
    v: z.literal(1),
    t: z.literal('dropped'),
    topics: z.array(Topic).min(1),
    reason: z.enum(GATEWAY_DROP_REASONS),
  }),
  // Events on these topics, the ones the socket holds live, may not have reached it ('gap'): refetch
  // them over REST, within the spread. Sent to every socket of the org that holds a topic, so it says
  // nothing about any one topic's events.
  z.strictObject({
    v: z.literal(1),
    t: z.literal('reset'),
    topics: z.array(Topic).min(1),
    reason: z.enum(GATEWAY_RESET_REASONS),
  }),
  // Re-read something about the org: 'flags' → GET /api/flags (T17 item 11), within the spread.
  z.strictObject({ v: z.literal(1), t: z.literal('nudge'), what: z.enum(GATEWAY_NUDGES) }),
  // The answer to ping: the current spread, and nothing else.
  z.strictObject({ v: z.literal(1), t: z.literal('pong'), reconnectSpreadMs: count }),
])
export type ServerFrame = z.infer<typeof ServerFrame>

// What a client reads with (C0.8): the same frames, leniently, so a client older than the server
// still acts on them (P6). Unknown fields are ignored. A dropped frame's topics are any strings and
// its reason anything, read as 'access' unless known, so a stale client still forgets what it held;
// a reset's the same, its reason read as 'gap' unless known, so a stale client still refetches. A
// nudge's what is any code: the client acts on the ones it knows. An ev's ids are any record: the
// client looks up only the keys it knows. A frame with an unknown t doesn't parse, and
// readServerFrame() skips it.
export const ServerFrameForClient = z.discriminatedUnion('t', [
  z.object({
    v: z.literal(1),
    t: z.literal('welcome'),
    socket: z.uuid(),
    heartbeatMs: z.int(),
    maxTopics: z.int(),
    maxTopicsPerFrame: z.int(),
    maxFrameBytes: z.int(),
    reconnectSpreadMs: z.int(),
  }),
  z.object({
    v: z.literal(1),
    t: z.literal('ack'),
    id,
    ok: z.array(Topic),
    refused: z.array(Topic),
    retry: z.array(Topic),
  }),
  z.object({
    v: z.literal(1),
    t: z.literal('ev'),
    topic: Topic,
    type: Code,
    ids: z.record(z.string(), z.unknown()),
  }),
  z.object({
    v: z.literal(1),
    t: z.literal('dropped'),
    topics: z.array(z.string()).min(1),
    reason: z.enum(GATEWAY_DROP_REASONS).catch('access'),
  }),
  z.object({
    v: z.literal(1),
    t: z.literal('reset'),
    topics: z.array(z.string()).min(1),
    reason: z.enum(GATEWAY_RESET_REASONS).catch('gap'),
  }),
  z.object({ v: z.literal(1), t: z.literal('nudge'), what: Code }),
  z.object({ v: z.literal(1), t: z.literal('pong'), reconnectSpreadMs: z.int() }),
])
export type ServerFrameForClient = z.infer<typeof ServerFrameForClient>

// Parses a text frame, or undefined: not JSON, a t this client doesn't know, or a known frame that
// doesn't parse. The client skips it.
export function readServerFrame(text: string): ServerFrameForClient | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  const parsed = ServerFrameForClient.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
