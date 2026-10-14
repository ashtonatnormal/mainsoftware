import { describe, expect, it } from 'vitest'
import { BACKOFF_JITTER, backoffMs, JOB_POLICY, jittered, SCHEDULER_POLICY, WORKER_POLICY } from '#src/jobs/policy.ts'

describe('C0.6 T15 the queue’s numbers', () => {
  it('holds TECH-SPEC’s defaults (T15 items 2, 6, 12 and 19; T16 item 19)', () => {
    expect(JOB_POLICY).toEqual({
      leaseMs: 30_000,
      heartbeatMs: 10_000,
      pollMs: 500,
      watchdogMs: 1000,
      drainMs: 3000,
      giveBackMs: 1000,
      giveBackLimit: 20,
      overCapDelayMs: 300_000,
    })
    expect(SCHEDULER_POLICY).toEqual({
      tickMs: 5000,
      fireBatch: 20,
      sweepBatch: 100,
      unknownKindMs: 7 * 24 * 3600 * 1000,
      reconcileMs: 600_000,
    })
    expect(WORKER_POLICY).toMatchObject({ consumerPollMs: 500, metricsMs: 30_000, orgsMs: 60_000, stopMs: 5000 })
    // Two heartbeats can fail and the lease still holds; the drain and give-back fit the 5 s stop.
    expect(JOB_POLICY.leaseMs).toBeGreaterThan(2 * JOB_POLICY.heartbeatMs)
    // The watchdog's margin (half a heartbeat) spans several of its ticks, and a heartbeat begun on
    // time, bounded by its statement timeout, ends before the watchdog would stop the job.
    const margin = JOB_POLICY.heartbeatMs / 2
    expect(margin).toBeGreaterThanOrEqual(2 * JOB_POLICY.watchdogMs)
    const bound = Math.min(JOB_POLICY.heartbeatMs, JOB_POLICY.leaseMs / 3)
    expect(JOB_POLICY.heartbeatMs + bound).toBeLessThan(JOB_POLICY.leaseMs - margin)
    expect(JOB_POLICY.drainMs + JOB_POLICY.giveBackMs).toBeLessThan(WORKER_POLICY.stopMs)
  })

  it('backs off from the base, doubling with each attempt to the cap, ±20% (T15 item 4)', () => {
    const backoff = { baseMs: 5000, capMs: 600_000 }
    const middle = () => 0.5
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(attempt => backoffMs(attempt, backoff, middle))).toEqual([
      5000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 600_000, 600_000,
    ])
    expect(backoffMs(1, backoff, () => 0)).toBe(5000 * (1 - BACKOFF_JITTER))
    expect(backoffMs(1, backoff, () => 1)).toBe(5000 * (1 + BACKOFF_JITTER))
    expect(backoffMs(30, backoff, () => 1)).toBe(600_000 * (1 + BACKOFF_JITTER))
    // An absurd attempt number can't overflow past the cap.
    expect(backoffMs(10_000, backoff, middle)).toBe(600_000)
  })

  it('jitters the scheduler’s tick by ±10%', () => {
    expect(jittered(5000, () => 0)).toBe(4500)
    expect(jittered(5000, () => 0.5)).toBe(5000)
    expect(jittered(5000, () => 1)).toBe(5500)
  })
})
