// The revocation latency metric (TECH-SPEC T19 item 13; REG-04, REG-05): how long after access was
// lost each revocation took effect. Whoever applies one records it: realtime's gateway when it
// closes sockets or drops topics, and from C2.2 the worker-side handlers (LiveKit, AI caches) for
// their own effects. Each record logs one revocation_applied line; every 30 s one
// revocation_latency line per (handler, path) summarises the window, from a node:perf_hooks
// histogram, and the window starts again.
//
// Start times come from the change's own clock: the api's Date.now() just after its commit on the
// push path (startSource 'publisher'), Postgres's base rows (revoked_at, deactivated_at, a removal's
// time, an expiry) on the durable path and the re-check ('database'). A record with no known start
// logs latencyMs null and counts as unknownStart. Every value is clamped to 1 ms-1 h, since a host
// clock may be off: the histogram refuses a value below its lowest and silently drops one above its
// highest. A latency below -1 s is counted as skewed, with its skewMs on the line.
//
// Levels: info up to 30 s, warn above 30 s, error above 60 s (a breach of Rule 6's bound). No line
// carries a person's or session's id, a topic, a token, a phone number or content: an org id and
// counts only (C0.13's log canary; T19 item 14). C0.13 turns the lines into the revocation-latency
// dashboard and its alarms.
import { createHistogram, performance, type RecordableHistogram } from 'node:perf_hooks'
import type { Logger } from 'pino'

// How the revocation reached whoever applied it: the api's push after its commit, the worker's
// durable revocation jobs, or a re-check against Postgres.
export type RevocationPath = 'push' | 'durable' | 'recheck'
export type StartSource = 'database' | 'publisher' | 'unknown'

export interface Applied {
  // The handler that applied it: 'sockets' or 'topics' in the gateway (registry.ts names them), a
  // later handler's own name in the worker.
  handler: string
  path: RevocationPath
  // A code: 'sessions_ended', 'keys_changed', or 'ended' (an expiry, the idle limit or a sign-out a
  // check found).
  cause: string
  orgId: string
  // Sockets closed, or (socket, topic) pairs dropped.
  count: number
  // When access was lost (epoch ms), if known.
  startedAt: number | undefined
  startSource: StartSource
  // When the close or the dropped frame was sent (epoch ms).
  appliedAt: number
}

export const LATENCY_SUMMARY_MS = 30_000
export const LATENCY_WARN_MS = 30_000
// Rule 6's bound (ACC-05: within 60 seconds), a hard bound, not a percentile.
export const LATENCY_ERROR_MS = 60_000
// The histogram's range: every value is clamped into it.
export const LATENCY_LOWEST_MS = 1
export const LATENCY_HIGHEST_MS = 3_600_000
// A latency below this is a clock out of step, not a fast revocation.
export const SKEW_MS = -1000

// A latency as the histogram takes it: whole milliseconds, 1 ms to 1 h.
export function clampLatency(latencyMs: number): number {
  return Math.min(LATENCY_HIGHEST_MS, Math.max(LATENCY_LOWEST_MS, Math.round(latencyMs)))
}

interface Window {
  handler: string
  path: RevocationPath
  histogram: RecordableHistogram
  // The exact longest latency: the histogram's max is the top of its bucket (3 significant figures),
  // which could put 60,000 ms over Rule 6's bound.
  max: number
  unknownStart: number
  skewed: number
}

type LogTo = Pick<Logger, 'info' | 'warn' | 'error'>

const levelOf = (ms: number): 'info' | 'warn' | 'error' =>
  ms > LATENCY_ERROR_MS ? 'error' : ms > LATENCY_WARN_MS ? 'warn' : 'info'

export class RevocationLatency {
  readonly #logger: LogTo
  readonly #now: () => number
  readonly #windows = new Map<string, Window>()
  readonly #timer: NodeJS.Timeout | undefined
  #windowStart: number

  // Summarises every summaryMs (30 s) until stop(), on an unref'd timer; summaryMs 0 summarises only
  // when asked (summarise()), for tests. now is a monotonic clock (performance.now), for windowMs.
  constructor(options: { logger: LogTo; summaryMs?: number; now?: () => number }) {
    this.#logger = options.logger
    this.#now = options.now ?? (() => performance.now())
    this.#windowStart = this.#now()
    const summaryMs = options.summaryMs ?? LATENCY_SUMMARY_MS
    if (summaryMs > 0) {
      this.#timer = setInterval(() => this.summarise(), summaryMs)
      this.#timer.unref()
    }
  }

  // Logs one revocation_applied line and counts the latency into its (handler, path)'s window.
  record(applied: Applied): void {
    const window = this.#window(applied.handler, applied.path)
    const line = {
      event: 'revocation_applied',
      handler: applied.handler,
      path: applied.path,
      cause: applied.cause,
      org: applied.orgId,
      count: applied.count,
    }
    if (applied.startedAt === undefined || applied.startSource === 'unknown') {
      window.unknownStart++
      this.#logger.info({ ...line, latencyMs: null, startSource: 'unknown' }, 'a revocation was applied')
      return
    }
    const raw = applied.appliedAt - applied.startedAt
    const latencyMs = clampLatency(raw)
    const skewed = raw < SKEW_MS
    if (skewed) window.skewed++
    window.histogram.record(latencyMs)
    window.max = Math.max(window.max, latencyMs)
    this.#logger[levelOf(latencyMs)](
      { ...line, latencyMs, startSource: applied.startSource, ...(skewed ? { skewMs: Math.round(raw) } : {}) },
      'a revocation was applied',
    )
  }

  // One revocation_latency line per (handler, path) with records since the last summary, then a new
  // window. Percentiles (to 3 significant figures, never above the exact max) and max are null when
  // every record had an unknown start.
  summarise(): void {
    const now = this.#now()
    const windowMs = Math.max(0, Math.round(now - this.#windowStart))
    this.#windowStart = now
    for (const [key, window] of this.#windows) {
      const { histogram } = window
      const count = histogram.count
      if (count === 0 && window.unknownStart === 0) {
        this.#windows.delete(key)
        continue
      }
      const max = count === 0 ? null : window.max
      const at = (percentile: number) => (count === 0 ? null : Math.min(window.max, histogram.percentile(percentile)))
      this.#logger[max === null ? 'info' : levelOf(max)](
        {
          event: 'revocation_latency',
          handler: window.handler,
          path: window.path,
          count,
          p50: at(50),
          p95: at(95),
          p99: at(99),
          max,
          unknownStart: window.unknownStart,
          skewed: window.skewed,
          windowMs,
        },
        'revocation latency',
      )
      // A window with nothing recorded next time is dropped then, so a handler and path seen once
      // logs no empty lines after.
      histogram.reset()
      window.max = 0
      window.unknownStart = 0
      window.skewed = 0
    }
  }

  // The longest latency recorded in the current window (ms), or undefined when none has a known
  // start: what the gateway's gauges line can carry beside its oldest unconfirmed age.
  oldest(): number | undefined {
    let longest: number | undefined
    for (const window of this.#windows.values()) {
      if (window.histogram.count === 0) continue
      longest = Math.max(longest ?? 0, window.max)
    }
    return longest
  }

  stop(): void {
    clearInterval(this.#timer)
  }

  #window(handler: string, path: RevocationPath): Window {
    const key = `${handler}:${path}`
    let window = this.#windows.get(key)
    if (window === undefined) {
      window = {
        handler,
        path,
        histogram: createHistogram({ lowest: LATENCY_LOWEST_MS, highest: LATENCY_HIGHEST_MS, figures: 3 }),
        max: 0,
        unknownStart: 0,
        skewed: 0,
      }
      this.#windows.set(key, window)
    }
    return window
  }
}
