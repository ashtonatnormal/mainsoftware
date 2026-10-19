import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type Applied,
  clampLatency,
  LATENCY_HIGHEST_MS,
  LATENCY_SUMMARY_MS,
  RevocationLatency,
} from '#src/revocation/latency.ts'
import { captureLogger } from '#src/testing/logs.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const NOW = 1_800_000_000_000

const applied = (latencyMs: number | undefined, change: Partial<Applied> = {}): Applied => ({
  handler: 'sockets',
  path: 'push',
  cause: 'sessions_ended',
  orgId: ORG,
  count: 2,
  startedAt: latencyMs === undefined ? undefined : NOW - latencyMs,
  startSource: latencyMs === undefined ? 'unknown' : 'publisher',
  appliedAt: NOW,
  ...change,
})

function metric() {
  const log = captureLogger('realtime')
  let clock = 0
  const latency = new RevocationLatency({ logger: log.logger, summaryMs: 0, now: () => clock })
  return {
    latency,
    log,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('C0.7 T19 item 13 REG-04 REG-05 CR-05 the revocation latency metric', () => {
  it('clamps every value to whole milliseconds from 1 ms to 1 h', () => {
    expect([0, 1.5, -250, -5000, 3_600_001, 7_200_000, 59_999.4].map(clampLatency)).toEqual([
      1,
      2,
      1,
      1,
      LATENCY_HIGHEST_MS,
      LATENCY_HIGHEST_MS,
      59_999,
    ])
  })

  it('logs each revocation applied with its handler, path, cause, org, count, clamped latency and start source', () => {
    const { latency, log } = metric()
    latency.record(applied(1.5))
    latency.record(applied(0, { handler: 'topics', path: 'durable', cause: 'keys_changed', startSource: 'database' }))
    latency.record(applied(2 * LATENCY_HIGHEST_MS))
    expect(
      log.events('revocation_applied').map(({ time: _t, pid: _p, hostname: _h, msg: _m, ...line }) => line),
    ).toEqual([
      {
        level: 30,
        role: 'realtime',
        event: 'revocation_applied',
        handler: 'sockets',
        path: 'push',
        cause: 'sessions_ended',
        org: ORG,
        count: 2,
        latencyMs: 2,
        startSource: 'publisher',
      },
      expect.objectContaining({ handler: 'topics', path: 'durable', latencyMs: 1, startSource: 'database' }),
      expect.objectContaining({ level: 50, latencyMs: LATENCY_HIGHEST_MS }),
    ])
  })

  it('CR-05: counts a latency below -1 s as skewed, with its skewMs, and a small negative one as 1 ms only', () => {
    const { latency, log } = metric()
    latency.record(applied(-500))
    latency.record(applied(-5000))
    const lines = log.events('revocation_applied')
    expect(lines[0]).toMatchObject({ latencyMs: 1 })
    expect(lines[0]).not.toHaveProperty('skewMs')
    expect(lines[1]).toMatchObject({ latencyMs: 1, skewMs: -5000, level: 30 })
    latency.summarise()
    expect(log.events('revocation_latency')).toEqual([expect.objectContaining({ count: 2, skewed: 1 })])
  })

  it('logs an unknown start as latencyMs null, records nothing into the histogram, and counts it', () => {
    const { latency, log } = metric()
    latency.record(applied(undefined))
    latency.record(applied(2000, { startSource: 'unknown' }))
    expect(log.events('revocation_applied').map(line => [line.latencyMs, line.startSource])).toEqual([
      [null, 'unknown'],
      [null, 'unknown'],
    ])
    expect(latency.oldest()).toBeUndefined()
    latency.summarise()
    expect(log.events('revocation_latency')).toEqual([
      expect.objectContaining({ count: 0, unknownStart: 2, p50: null, p99: null, max: null, level: 30 }),
    ])
  })

  it('logs at info up to 30 s, warn above 30 s and error above 60 s (a breach of Rule 6’s bound)', () => {
    const { latency, log } = metric()
    for (const ms of [30_000, 30_001, 60_000, 60_001]) latency.record(applied(ms))
    expect(log.events('revocation_applied').map(line => line.level)).toEqual([30, 40, 40, 50])
  })

  it('judges a summary by the exact max, not the top of its histogram bucket, and keeps percentiles at or below it', () => {
    const { latency, log } = metric()
    latency.record(applied(60_000))
    expect(latency.oldest()).toBe(60_000)
    latency.summarise()
    expect(log.events('revocation_latency')).toEqual([
      expect.objectContaining({ level: 40, max: 60_000, p50: 60_000, p99: 60_000 }),
    ])
  })

  it('summarises each (handler, path, startSource) with records: count, p50, p95, p99, max, then starts a new window', () => {
    const { latency, log, advance } = metric()
    for (let ms = 1; ms <= 100; ms++) latency.record(applied(ms * 10))
    latency.record(applied(45_000, { handler: 'topics', path: 'recheck', startSource: 'database' }))
    expect(latency.oldest()).toBe(45_000)
    advance(LATENCY_SUMMARY_MS)
    latency.summarise()
    const lines = log.events('revocation_latency')
    expect(lines).toHaveLength(2)
    const sockets = lines.find(line => line.handler === 'sockets')
    expect(sockets).toMatchObject({
      level: 30,
      path: 'push',
      startSource: 'publisher',
      count: 100,
      max: 1000,
      unknownStart: 0,
      skewed: 0,
    })
    expect(sockets?.windowMs).toBe(LATENCY_SUMMARY_MS)
    // HDR histograms keep 3 significant figures.
    expect(Math.abs(Number(sockets?.p50) - 500)).toBeLessThanOrEqual(1)
    expect(Math.abs(Number(sockets?.p95) - 950)).toBeLessThanOrEqual(1)
    expect(Math.abs(Number(sockets?.p99) - 990)).toBeLessThanOrEqual(1)
    expect(lines.find(line => line.handler === 'topics')).toMatchObject({
      level: 40,
      path: 'recheck',
      startSource: 'database',
      count: 1,
    })
    // A new window: nothing recorded since, so nothing is logged.
    latency.summarise()
    expect(log.events('revocation_latency')).toHaveLength(2)
    expect(latency.oldest()).toBeUndefined()
    latency.record(applied(61_000))
    latency.summarise()
    expect(log.events('revocation_latency').at(-1)).toMatchObject({ level: 50, count: 1, max: 61_000 })
  })

  it('T19 item 13: summarises each start source apart, so the outbox’s commit-side starts never mix with the base rows’ transaction starts', () => {
    const { latency, log } = metric()
    latency.record(applied(100, { path: 'durable', startSource: 'outbox' }))
    latency.record(applied(200, { path: 'durable', startSource: 'outbox' }))
    // A re-check that a people signal brought in, under the signal's path, finding the sessions
    // ended by their base rows.
    latency.record(applied(45_000, { path: 'durable', cause: 'ended', startSource: 'database' }))
    latency.record(applied(undefined, { path: 'durable' }))
    expect(log.events('revocation_applied').map(line => line.startSource)).toEqual([
      'outbox',
      'outbox',
      'database',
      'unknown',
    ])
    latency.summarise()
    expect(
      log
        .events('revocation_latency')
        .map(line => [line.handler, line.path, line.startSource, line.count, line.max, line.unknownStart, line.level]),
    ).toEqual([
      ['sockets', 'durable', 'outbox', 2, 200, 0, 30],
      ['sockets', 'durable', 'database', 1, 45_000, 0, 40],
      ['sockets', 'durable', 'unknown', 0, null, 1, 30],
    ])
  })

  it('summarises every 30 s on its own until stopped', () => {
    vi.useFakeTimers()
    const log = captureLogger('realtime')
    const latency = new RevocationLatency({ logger: log.logger })
    latency.record(applied(100))
    vi.advanceTimersByTime(LATENCY_SUMMARY_MS - 1)
    expect(log.events('revocation_latency')).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(log.events('revocation_latency')).toHaveLength(1)
    latency.stop()
    latency.record(applied(100))
    vi.advanceTimersByTime(LATENCY_SUMMARY_MS * 3)
    expect(log.events('revocation_latency')).toHaveLength(1)
  })

  it('REG-05 T19 item 14: logs no id but the org’s, no token, phone number or content', () => {
    const { latency, log } = metric()
    latency.record(applied(10))
    latency.record(applied(undefined))
    latency.record(applied(-5000))
    latency.record(applied(90_000, { handler: 'topics', path: 'durable' }))
    latency.summarise()
    const allowed = new Set([
      'level',
      'time',
      'pid',
      'hostname',
      'role',
      'msg',
      'event',
      'handler',
      'path',
      'cause',
      'org',
      'count',
      'latencyMs',
      'startSource',
      'skewMs',
      'p50',
      'p95',
      'p99',
      'max',
      'unknownStart',
      'skewed',
      'windowMs',
    ])
    expect(log.lines.length).toBeGreaterThan(0)
    for (const line of log.lines) for (const key of Object.keys(line)) expect(allowed, key).toContain(key)
    // The org is the only uuid any line holds.
    const uuids = JSON.stringify(log.lines).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)
    expect(new Set(uuids)).toEqual(new Set([ORG]))
  })
})
