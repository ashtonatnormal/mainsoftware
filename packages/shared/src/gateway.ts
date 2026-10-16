// The realtime gateway's protocol (BUILD-PLAN C0.7, TECH-SPEC T19 item 10): the frames a client and
// the realtime role's /ws exchange, as zod schemas the server and C0.8's web app both import. Frames
// are JSON text and each carries v, the protocol version. They hold ids, codes and whole numbers
// only: an ev is a nudge to refetch over REST, which checks access, never content (T19 item 9). The
// server reads client frames strictly; clients read server frames leniently, so the server may add
// to a version without a stale client missing a drop (P5, P6).
//
// The client's side (T19 item 10), for C0.8:
// 1. Open wss://<app host>/ws (same origin, so the cookie goes with it), send hello at once naming
//    every version it speaks, and wait for welcome. Use welcome's v in every later frame, and keep
//    its reconnectSpreadMs ("the spread"), which every pong updates.
// 2. Subscribe, then fetch. sub at most 50 topics a frame and 100 a socket. Fetch over REST only
//    after the ack, and only topics with no valid since: new ones, or those in ack.reset. An ev that
//    arrives during the fetch means fetch again. Send ack.retry's topics again after a random 1-5 s,
//    backing off to 30 s. A topic asked for but in none of the ack's lists was dropped first: its
//    dropped frame came before the ack.
// 3. Positions. Keep one { epoch, pos } per topic. A topic acked ok takes the ack's pos, and every
//    later ack, ev, pong and reset advances every topic acked ok on the socket to its pos: the higher
//    of the two, compared as (ms, seq), and a new epoch replaces the old. That holds because a
//    socket's frames go out in stream order. Drop an ev whose pos is at or below its topic's.
// 4. Reconnect and resume. Resubscribe every topic with since set to the lowest position among them
//    (topics in another epoch go without since), in ⌈topics/50⌉ sub frames.
// 5. dropped: forget the topic and wipe its cached server data; an unknown reason reads as 'access'.
//    reset: set every topic's position to its pos, and refetch every topic at a random time within
//    the spread. nudge 'flags': GET /api/flags at a random time within the spread. Neither a drop nor
//    a sign-out discards unsynced local edits: they are shown and offered as a copy (NFR-04).
// 6. Heartbeat. ping every 25 s, and whenever the page becomes visible or comes online. No frame
//    within 10 s of a ping means the socket is dead: close it and reconnect.
// 7. Closes. 4401: go to sign-in, and never reconnect. 4403: show the notice (C0.9), and reconnect
//    once it is acknowledged. 4426: reload. 1008 with an abuse reason: back off from 30 s. Any other
//    close of an open socket, 1006 and 1001 included: wait a random time within the spread, then
//    retry with full-jitter back-off from 1 s to 30 s. Never rely on seeing a particular code: 1006
//    is the fallback for all of them. After 30 s of failed reconnects, at a random point in the next
//    5 s, GET /api/flags: a 401 means go to sign-in.
import { z } from 'zod'
import { CODE, CODE_MAX, IDS_KEY, IDS_LIST_MAX, IDS_NUMBER_MAX, LowerUuid, UUID_SOURCE } from './ids.ts'

export const GATEWAY_PATH = '/ws'
// The protocol versions this build speaks, oldest first. hello names the client's, welcome the one
// chosen.
export const GATEWAY_VERSIONS = [1] as const
export const GATEWAY_LIMITS = {
  maxFrameBytes: 4096, // a client frame over this closes the socket (1009)
  maxTopicsPerFrame: 50,
  maxTopicsPerSocket: 100, // counting topics still being decided or replayed
  heartbeatMs: 25_000, // the client pings this often (and the server)
  pongTimeoutMs: 10_000, // a client gives up on a socket silent this long after its ping
  helloTimeoutMs: 10_000, // the server closes a socket that hasn't said hello by then
  frameBurst: 20, // the inbound token bucket, full when a socket opens
  framesPerSecond: 5,
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

// A position in an org's event stream: a Valkey stream id, <ms>-<seq>, each part a 64-bit number.
// epoch names the stream's continuity; a position from another epoch says nothing about this one.
export const StreamPosition = z
  .string()
  .max(41)
  .regex(/^\d{1,20}-\d{1,20}$/)
export const Position = z.strictObject({ epoch: LowerUuid, pos: StreamPosition })
export type Position = z.infer<typeof Position>
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
// What a nudge asks the client to re-read: 'flags', GET /api/flags (T17 item 11).
export const GATEWAY_NUDGES = ['flags'] as const
export type GatewayNudge = (typeof GATEWAY_NUDGES)[number]

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
  // since: a position from an earlier ack, ev, pong or reset; replay those topics from there if it can.
  z.strictObject({ v: z.literal(1), t: z.literal('sub'), id, topics, since: Position.optional() }),
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
  // The answer to sub or unsub. ok: held now (sub) or no longer held (unsub). refused: missing or
  // not allowed, alike (PRD-108). reset: held, but since couldn't be honoured: refetch them over
  // REST. retry: not decided (the database couldn't be reached in time): send them again after a
  // back-off. A topic dropped before the ack is in none of these: its dropped frame came first.
  // pos: every topic acked ok on this socket is caught up to here, or null while the stream can't
  // be reached.
  z.strictObject({
    v: z.literal(1),
    t: z.literal('ack'),
    id,
    ok: z.array(Topic),
    refused: z.array(Topic),
    reset: z.array(Topic),
    retry: z.array(Topic),
    pos: Position.nullable(),
  }),
  // Something changed on a topic: refetch what these ids name. pos is in the epoch of the socket's
  // last ack, pong or reset; every topic acked ok on this socket is caught up to it.
  z.strictObject({
    v: z.literal(1),
    t: z.literal('ev'),
    topic: Topic,
    pos: StreamPosition,
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
  // The stream lost continuity (Valkey restarted or failed over, or the reader fell behind):
  // refetch every topic over REST, within the spread, and continue from pos.
  z.strictObject({ v: z.literal(1), t: z.literal('reset'), pos: Position }),
  // Re-read something about the org: 'flags' → GET /api/flags (T17 item 11), within the spread.
  z.strictObject({ v: z.literal(1), t: z.literal('nudge'), what: z.enum(GATEWAY_NUDGES) }),
  // The answer to ping: the org's position (every topic acked ok on this socket is caught up to
  // it), and the current spread.
  z.strictObject({ v: z.literal(1), t: z.literal('pong'), pos: Position.nullable(), reconnectSpreadMs: count }),
])
export type ServerFrame = z.infer<typeof ServerFrame>

// What a client reads with (C0.8): the same frames, leniently, so a client older than the server
// still acts on them (P6). Unknown fields are ignored. A dropped frame's topics are any strings and
// its reason anything, read as 'access' unless known, so a stale client still forgets what it held.
// A nudge's what is any code: the client acts on the ones it knows. An ev's ids are any record: the
// client looks up only the keys it knows. A frame with an unknown t doesn't parse, and
// readServerFrame() skips it.
const PositionForClient = z.object({ epoch: LowerUuid, pos: StreamPosition })
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
    reset: z.array(Topic),
    retry: z.array(Topic),
    pos: PositionForClient.nullable(),
  }),
  z.object({
    v: z.literal(1),
    t: z.literal('ev'),
    topic: Topic,
    pos: StreamPosition,
    type: Code,
    ids: z.record(z.string(), z.unknown()),
  }),
  z.object({
    v: z.literal(1),
    t: z.literal('dropped'),
    topics: z.array(z.string()).min(1),
    reason: z.enum(GATEWAY_DROP_REASONS).catch('access'),
  }),
  z.object({ v: z.literal(1), t: z.literal('reset'), pos: PositionForClient }),
  z.object({ v: z.literal(1), t: z.literal('nudge'), what: Code }),
  z.object({ v: z.literal(1), t: z.literal('pong'), pos: PositionForClient.nullable(), reconnectSpreadMs: z.int() }),
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
