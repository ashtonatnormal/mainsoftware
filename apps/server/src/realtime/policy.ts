// Every number of the realtime gateway (TECH-SPEC T19), in one place, so a change is a reviewed
// commit with its tests, as T14's are in auth/policy.ts and T15's in jobs/policy.ts. T14's own
// three stay in auth/policy.ts: SOCKET_REVOKE_MS (a session's sockets close within 60 s),
// SOCKET_RECHECK_MS (every socket is re-checked each 15 s) and SOCKETS_PER_SESSION (8). The limits
// a client must keep are also in packages/shared (GATEWAY_LIMITS), which policy.test.ts pins equal
// to these. None of them is configuration: realtime reads no new variable (T19 item 16).

export interface GatewayPolicy {
  // The heartbeat (T19 item 12). The server pings a socket heartbeatMs after its last ping, looking
  // every heartbeatSweepMs, and terminates one it has heard nothing from for deadAfterMs (two
  // missed pings and 5 s). heartbeatMs stays under the ALB's default 60 s idle timeout.
  heartbeatMs: number
  heartbeatSweepMs: number
  deadAfterMs: number
  // A client gives up on a socket silent this long after its own ping (GATEWAY_LIMITS).
  pongTimeoutMs: number
  // A socket that hasn't said hello by then closes with 1008 hello_timeout.
  helloTimeoutMs: number

  // What a client may send (T19 item 10): a frame of at most maxFrameBytes (ws closes a larger one
  // with 1009), at most maxTopicsPerFrame topics a sub and maxTopicsPerSocket held, deciding and
  // replaying ones included, and an inbound token bucket of frameBurst, full when a socket opens,
  // refilled at framesPerSecond.
  maxFrameBytes: number
  maxTopicsPerFrame: number
  maxTopicsPerSocket: number
  frameBurst: number
  framesPerSecond: number

  // Backpressure (T19 item 10). Above softBufferBytes buffered, droppable frames are shed, and a
  // socket that stays there for softBufferMs closes with 4408, as one above hardBufferBytes does.
  softBufferBytes: number
  hardBufferBytes: number
  softBufferMs: number
  // How long a closing socket gets to finish the closing handshake before it is cut.
  closeGraceMs: number

  // The connection budget (the owner's, 16 Oct 2026; T19 item 11): sockets per process and per
  // person (SOCKETS_PER_SESSION is T14's); session lookups running and waiting per process, each
  // slot held until its lookup settles; how long a lookup may take, from the upgrade's arrival.
  maxSocketsPerProcess: number
  maxSocketsPerPerson: number
  lookupsRunning: number
  lookupsWaiting: number
  lookupTimeoutMs: number
  // The realtime pool: lookupsRunning, 1 decision lane, 1 periodic check, FLAG_READS_IN_FLIGHT flag
  // reads, 1 for /ready's role check and 1 spare (T19 item 11).
  poolSize: number

  // Decisions and re-checks (T19 item 8). The lane batches subscribes, accept-time and targeted
  // checks every decisionBatchMs, or at once at decisionBatchMax subscribers; targeted re-checks
  // coalesce for targetedDelayMs. A periodic check (or a lane's transaction) that hasn't answered
  // within recheckTimeoutMs has failed: recheckTransactionTimeout is the same bound as Postgres's
  // transaction_timeout. With SOCKET_RECHECK_MS, 2 × (15 + 10) s < 60 s.
  decisionBatchMs: number
  decisionBatchMax: number
  targetedDelayMs: number
  recheckTimeoutMs: number
  recheckTransactionTimeout: string

  // The races (T19 item 6): a revoked session is refused at upgrade for recentlyRevokedMs (longer
  // than a lookup's limit plus its queue), keeping at most recentlyRevokedMax ids; a person whose
  // keys changed is re-checked at accept and after a subscribe for keysChangedMs.
  recentlyRevokedMs: number
  recentlyRevokedMax: number
  keysChangedMs: number

  // Resume (T19 item 9). A replay is valid while its oldest missed entry is at most resumeWindowMs
  // old, it scans at most replayScanMax entries and sends at most replayFramesMax frames (the same
  // cap holds a replaying topic's live entries). A team topic whose current membership began after
  // since's time less eraMarginMs resets (Valkey's and Postgres's clocks may differ by that much).
  resumeWindowMs: number
  replayScanMax: number
  replayFramesMax: number
  eraMarginMs: number
  // Replay caps (S5): replaysRunning at once per process and replaysWaiting queued; one at a time
  // per socket, with replaysWaitingPerSocket queued; one that can't start within replayStartMs
  // answers reset.
  replaysRunning: number
  replaysWaiting: number
  replaysWaitingPerSocket: number
  replayStartMs: number

  // Each org's stream (T19 item 9): capped at about streamMaxLen entries (MAXLEN ~ trims whole
  // nodes), each at most entryMaxBytes, with the stream and its epoch expiring streamTtlMs after
  // their last write or refresh.
  streamMaxLen: number
  streamTtlMs: number
  entryMaxBytes: number
  // The reader (realtime/stream.ts): XREAD BLOCK readerBlockMs COUNT readerCount on its own
  // connection; with no orgs it looks again after readerIdleMs, and after a failure after
  // readerRetryMs. It checks each org's epoch and gaps every readerEpochCheckMs, and refreshes both
  // keys every epochRefreshMs while the org has sockets here. A reader with orgs that hasn't read
  // for readerStuckMs (3 blocks and a second) fails the full readiness.
  readerBlockMs: number
  readerCount: number
  readerIdleMs: number
  readerRetryMs: number
  readerEpochCheckMs: number
  epochRefreshMs: number
  readerStuckMs: number

  // The flags nudge goes out at most once per org each nudgeCoalesceMs, on the trailing edge (P4).
  nudgeCoalesceMs: number
  // How often the revocation_latency summary and the gateway_gauges line are written (T19 item 13).
  metricsMs: number
  // The reconnect spread welcome and pong carry (P3): spreadMsPerSocket for each socket on the
  // process, at least spreadMinMs and at most spreadMaxMs (the client's back-off cap).
  spreadMsPerSocket: number
  spreadMinMs: number
  spreadMaxMs: number
  // Log levels (T19 item 13): a revocation applied later than latencyWarnMs warns and later than
  // latencyErrorMs is an error (revocation/latency.ts keeps the same numbers); the oldest
  // unconfirmed session or topic warns above unconfirmedWarnMs.
  latencyWarnMs: number
  latencyErrorMs: number
  unconfirmedWarnMs: number
}

export const GATEWAY_POLICY: GatewayPolicy = {
  heartbeatMs: 25_000,
  heartbeatSweepMs: 5000,
  deadAfterMs: 55_000,
  pongTimeoutMs: 10_000,
  helloTimeoutMs: 10_000,

  maxFrameBytes: 4096,
  maxTopicsPerFrame: 50,
  maxTopicsPerSocket: 100,
  frameBurst: 20,
  framesPerSecond: 5,

  softBufferBytes: 256 * 1024,
  hardBufferBytes: 1024 * 1024,
  softBufferMs: 10_000,
  closeGraceMs: 1000,

  maxSocketsPerProcess: 25_000,
  maxSocketsPerPerson: 40,
  lookupsRunning: 5,
  lookupsWaiting: 1000,
  lookupTimeoutMs: 5000,
  poolSize: 12,

  decisionBatchMs: 20,
  decisionBatchMax: 500,
  targetedDelayMs: 100,
  recheckTimeoutMs: 10_000,
  recheckTransactionTimeout: '10s',

  recentlyRevokedMs: 60_000,
  recentlyRevokedMax: 100_000,
  keysChangedMs: 60_000,

  resumeWindowMs: 120_000,
  replayScanMax: 1000,
  replayFramesMax: 500,
  eraMarginMs: 5000,
  replaysRunning: 8,
  replaysWaiting: 1000,
  replaysWaitingPerSocket: 2,
  replayStartMs: 2000,

  streamMaxLen: 10_000,
  streamTtlMs: 86_400_000,
  entryMaxBytes: 2048,
  readerBlockMs: 2000,
  readerCount: 500,
  readerIdleMs: 1000,
  readerRetryMs: 1000,
  readerEpochCheckMs: 2000,
  epochRefreshMs: 60_000,
  readerStuckMs: 7000,

  nudgeCoalesceMs: 1000,
  metricsMs: 30_000,
  spreadMsPerSocket: 1,
  spreadMinMs: 5000,
  spreadMaxMs: 30_000,
  latencyWarnMs: 30_000,
  latencyErrorMs: 60_000,
  unconfirmedWarnMs: 40_000,
}

// The policy with a test's overrides, refused at start if its numbers can't keep the heartbeat's
// rules (T19 item 12): a socket is declared dead only after two missed pings, and the ping comes
// before an ALB's default 60 s idle timeout cuts the connection. A test that shortens the heartbeat
// (200/550 ms) passes both.
export function gatewayPolicy(overrides: Partial<GatewayPolicy> = {}): GatewayPolicy {
  const policy = { ...GATEWAY_POLICY, ...overrides }
  if (policy.deadAfterMs <= 2 * policy.heartbeatMs) {
    throw new Error('the gateway’s dead limit must be longer than two heartbeats')
  }
  if (policy.heartbeatMs >= 60_000) throw new Error('the gateway’s heartbeat must be shorter than 60 s')
  if (policy.spreadMinMs > policy.spreadMaxMs) throw new Error('the reconnect spread’s minimum is above its maximum')
  return policy
}

// How widely a client spreads its reconnect (P3; T19 item 11): 1 ms for each socket on this
// process, at least 5 s and at most 30 s. A lost task's sockets then come back to each task they
// move to at about 1,000 a second.
export function reconnectSpreadMs(sockets: number, policy: GatewayPolicy = GATEWAY_POLICY): number {
  return Math.min(policy.spreadMaxMs, Math.max(policy.spreadMinMs, Math.round(sockets * policy.spreadMsPerSocket)))
}
