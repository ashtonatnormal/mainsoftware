import { TOPIC_KINDS } from '@hearth/access'
import { GATEWAY_LIMITS, GATEWAY_TOPIC_KINDS } from '@hearth/shared'
import { describe, expect, it } from 'vitest'
import { SOCKET_RECHECK_MS, SOCKET_REVOKE_MS } from '#src/auth/policy.ts'
import { FLAG_READS_IN_FLIGHT } from '#src/flags/cache.ts'
import { GATEWAY_POLICY, gatewayPolicy, reconnectSpreadMs } from '#src/realtime/policy.ts'
import { CLOSE_GRACE_MS, LOOKUP_TIMEOUT_MS, MAX_FRAME_BYTES, RECHECK_TIMEOUT_MS } from '#src/realtime/socket.ts'
import { TOPIC_KIND_SPECS } from '#src/realtime/topics.ts'
import { LATENCY_ERROR_MS, LATENCY_SUMMARY_MS, LATENCY_WARN_MS } from '#src/revocation/latency.ts'

const P = GATEWAY_POLICY

describe('C0.7 T19 the gateway’s numbers', () => {
  it('GW-03 GW-07 T19 item 8: one failed re-check closes nothing and a lost session or topic still goes within 60 s', () => {
    expect(2 * (SOCKET_RECHECK_MS + RECHECK_TIMEOUT_MS)).toBeLessThan(SOCKET_REVOKE_MS)
    expect(2 * (SOCKET_RECHECK_MS + P.recheckTimeoutMs)).toBeLessThan(SOCKET_REVOKE_MS)
    // Postgres's transaction_timeout for a check is the same bound as the gateway's own deadline.
    expect(P.recheckTransactionTimeout).toBe(`${P.recheckTimeoutMs / 1000}s`)
    // A deadline never longer than the interval it guards.
    expect(P.recheckTimeoutMs).toBeLessThanOrEqual(SOCKET_RECHECK_MS)
  })

  it('GW-08 T19 item 12: the dead limit is past two heartbeats, and the heartbeat beats the ALB’s 60 s idle timeout', () => {
    expect(P.deadAfterMs).toBeGreaterThan(2 * P.heartbeatMs)
    expect(P.heartbeatMs).toBeLessThan(60_000)
    // Two missed pings and one sweep: a healthy socket's pong always lands well inside the limit.
    expect(P.heartbeatSweepMs).toBeLessThanOrEqual(P.deadAfterMs - 2 * P.heartbeatMs)
    expect(P.heartbeatMs + P.heartbeatSweepMs).toBeLessThan(P.deadAfterMs)
    // The test policy of the integration suite (200/550 ms) passes; a bad override is refused at start.
    expect(gatewayPolicy({ heartbeatMs: 200, deadAfterMs: 550 })).toMatchObject({ heartbeatMs: 200, deadAfterMs: 550 })
    expect(() => gatewayPolicy({ heartbeatMs: 200, deadAfterMs: 400 })).toThrow(/two heartbeats/)
    expect(() => gatewayPolicy({ heartbeatMs: 60_000, deadAfterMs: 130_000 })).toThrow(/60 s/)
    expect(() => gatewayPolicy({ spreadMinMs: 31_000 })).toThrow(/spread/)
    expect(gatewayPolicy()).toEqual(GATEWAY_POLICY)
  })

  it('M1 T19 item 11: an upgrade stops waiting for a lookup slot a second before its limit, and a reserve that leaves no wait is refused at start', () => {
    expect(P.lookupReserveMs).toBe(1000)
    expect(P.lookupReserveMs).toBeLessThan(P.lookupTimeoutMs)
    expect(() => gatewayPolicy({ lookupReserveMs: 5000 })).toThrow(/reserve/)
    expect(() => gatewayPolicy({ lookupReserveMs: 0 })).toThrow(/reserve/)
    expect(gatewayPolicy({ lookupTimeoutMs: 50, lookupReserveMs: 10 })).toMatchObject({ lookupReserveMs: 10 })
  })

  it('T19 item 9 GW-09: no number of a replay, a resume window or a reported position is left: a client resubscribes and refetches', () => {
    // The owner's decision: re-authorise and refetch. The policy keeps the stream's own numbers for
    // fan-out and none of the numbers that only served resume.
    const names = Object.keys(P)
    for (const gone of ['resume', 'replay', 'grain', 'since', 'era', 'position']) {
      expect(
        names.filter(name => name.toLowerCase().includes(gone)),
        gone,
      ).toEqual([])
    }
  })

  it('M1 T19 item 11: the realtime pool keeps a connection for the lane, the check, the flag reads and /ready besides the lookups', () => {
    expect(P.poolSize).toBeGreaterThanOrEqual(P.lookupsRunning + 1 + 1 + FLAG_READS_IN_FLIGHT + 2)
    // The api's pool stays at 10 (db/pool.ts); realtime's is its own number.
    expect(P.poolSize).toBe(12)
  })

  it('P3 T19 item 11: the reconnect spread is 1 ms a socket, from 5 s to 30 s, never past the client’s back-off cap', () => {
    expect(P.spreadMaxMs).toBeLessThanOrEqual(30_000)
    expect(reconnectSpreadMs(0)).toBe(P.spreadMinMs)
    expect(reconnectSpreadMs(1)).toBe(5000)
    expect(reconnectSpreadMs(5000)).toBe(5000)
    expect(reconnectSpreadMs(12_500)).toBe(12_500)
    expect(reconnectSpreadMs(25_000)).toBe(25_000)
    expect(reconnectSpreadMs(30_000)).toBe(P.spreadMaxMs)
    expect(reconnectSpreadMs(1_000_000)).toBe(30_000)
    // A full task's sockets come back to the tasks they move to at no more than about 1,000 a
    // second (a socket per ms).
    expect(P.maxSocketsPerProcess / reconnectSpreadMs(P.maxSocketsPerProcess)).toBeLessThanOrEqual(1)
  })

  it('T19 item 10: the limits a client keeps (packages/shared GATEWAY_LIMITS) are the policy’s, and so are socket.ts’s', () => {
    for (const [name, value] of Object.entries(GATEWAY_LIMITS)) {
      expect({ name, value: P[name as keyof typeof GATEWAY_LIMITS] }).toEqual({ name, value })
    }
    expect([MAX_FRAME_BYTES, LOOKUP_TIMEOUT_MS, RECHECK_TIMEOUT_MS, CLOSE_GRACE_MS]).toEqual([
      P.maxFrameBytes,
      P.lookupTimeoutMs,
      P.recheckTimeoutMs,
      P.closeGraceMs,
    ])
    // A 100-topic reconnect is two subs of 50, well inside the bucket with hello and a ping (S7).
    expect(Math.ceil(P.maxTopicsPerSocket / P.maxTopicsPerFrame) + 2).toBeLessThanOrEqual(P.frameBurst)
  })

  it('T19 item 7: the topic kinds the protocol names are the ones packages/access decides, and the gateway’s registry', () => {
    expect([...GATEWAY_TOPIC_KINDS]).toEqual([...TOPIC_KINDS])
    expect(Object.keys(TOPIC_KIND_SPECS)).toEqual([...GATEWAY_TOPIC_KINDS])
    // No kind needs a per-item check yet: the gateway runs none, so C1.1 adds it with its first.
    expect(Object.values(TOPIC_KIND_SPECS).map(spec => spec.perItem)).toEqual([false, false, false])
  })

  it('T19 items 9 and 13: the stream and latency numbers agree with each other and with revocation/latency.ts', () => {
    expect([P.latencyWarnMs, P.latencyErrorMs, P.metricsMs]).toEqual([
      LATENCY_WARN_MS,
      LATENCY_ERROR_MS,
      LATENCY_SUMMARY_MS,
    ])
    expect(P.latencyErrorMs).toBe(SOCKET_REVOKE_MS)
    expect(P.unconfirmedWarnMs).toBeLessThan(SOCKET_REVOKE_MS)
    // The reader's connection drops a silent peer, but never cuts a healthy block (valkey.ts), and a
    // stuck reader is three blocks and a second.
    expect(P.readerStuckMs).toBe(3 * P.readerBlockMs + 1000)
    expect(P.readerEpochCheckMs).toBeGreaterThanOrEqual(P.readerBlockMs)
    expect(P.epochRefreshMs).toBeLessThan(P.streamTtlMs)
    // A full page of the reader's (readerCount entries of at most entryMaxBytes) stays a few MB.
    expect(P.readerCount * P.entryMaxBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
    // A revoked session is remembered for longer than a lookup may take.
    expect(P.recentlyRevokedMs).toBeGreaterThan(P.lookupTimeoutMs)
  })

  it('T19 item 9: the stream is trimmed by age, well past the reader’s stuck limit, so a trim past a reader means it was stuck, not that the org was busy; the count cap is a backstop far above the old 10,000, and a policy that breaks either is refused at start', () => {
    expect(P.streamMaxAgeMs).toBe(60_000)
    expect(P.streamMaxAgeMs).toBeGreaterThanOrEqual(8 * P.readerStuckMs)
    // The backstop: 200 pages of the reader's, and at most about 200 MB at 2 KiB an entry.
    expect(P.streamMaxLen).toBe(100_000)
    expect(P.streamMaxLen).toBeGreaterThanOrEqual(200 * P.readerCount)
    expect(P.streamMaxLen * P.entryMaxBytes).toBeLessThanOrEqual(200 * 1024 * 1024)
    expect(() => gatewayPolicy({ streamMaxAgeMs: P.readerStuckMs })).toThrow(/age limit/)
    expect(() => gatewayPolicy({ streamMaxLen: 0 })).toThrow(/cap/)
    expect(gatewayPolicy({ streamMaxAgeMs: 300, readerStuckMs: 200, streamMaxLen: 20 })).toMatchObject({
      streamMaxAgeMs: 300,
      streamMaxLen: 20,
    })
  })

  it('T19 item 9 P4: an org’s resets are coalesced on the trailing edge to one each spread’s minimum, no more often than the flags nudge, so an overload of other topics’ events shows only how long it lasted, to within 5 s', () => {
    expect(P.resetCoalesceMs).toBe(5000)
    expect(P.resetCoalesceMs).toBe(P.spreadMinMs)
    expect(P.resetCoalesceMs).toBeGreaterThanOrEqual(P.nudgeCoalesceMs)
  })
})
