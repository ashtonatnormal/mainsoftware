// The live connection's waits (T19 item 10, items 2 and 7 of packages/shared/src/gateway.ts's
// client side; R-46, R-49, K-41). Each is a whole number of milliseconds drawn with the random
// source the caller passes, so a test seeds it and the browser passes Math.random. Every wait is
// random over its range, so the tabs a server restart cut off don't come back together.
//
// - withinSpread: a random time up to the spread welcome and pong name (a reconnect after an open
//   socket closes, a reset's refetch, a nudge's).
// - fullJitter: a random time up to 1 s, 2 s, 4 s… capped at 30 s, for each reconnect that failed
//   in a row.
// - abuseDelay: 30 s to 60 s, after a 1008 that names abuse (bad_frame, too_many_frames,
//   too_many_topics): a client that tripped the server's limits shouldn't come straight back.
// - retryAckDelay: a topic in ack.retry is sent again after 1 to 5 s, doubling with each retry in a
//   row, capped at 30 s.

export const BACKOFF = {
  baseMs: 1_000,
  capMs: 30_000,
  abuseMinMs: 30_000,
  retryAckMinMs: 1_000,
  retryAckMaxMs: 5_000,
  retryAckCapMs: 30_000,
} as const

// Past this many doublings every range is at its cap; it also keeps 2 ** n finite.
const MAX_DOUBLINGS = 16

const doublings = (n: number) => Math.min(MAX_DOUBLINGS, Math.max(0, Math.floor(n)))

// A random time in [0, spreadMs).
export function withinSpread(spreadMs: number, random: () => number): number {
  return Math.floor(random() * Math.max(0, spreadMs))
}

// A random time in [0, min(30 s, 1 s × 2^failures)), failures being how many tries in a row have
// failed before this wait.
export function fullJitter(failures: number, random: () => number): number {
  return Math.floor(random() * Math.min(BACKOFF.capMs, BACKOFF.baseMs * 2 ** doublings(failures)))
}

// A random time in [30 s, 60 s).
export function abuseDelay(random: () => number): number {
  return BACKOFF.abuseMinMs + Math.floor(random() * BACKOFF.abuseMinMs)
}

// A random time in [1 s, 5 s) × 2^retries, capped at 30 s, retries being how many times in a row
// the topic has come back in ack.retry before this one.
export function retryAckDelay(retries: number, random: () => number): number {
  const base = BACKOFF.retryAckMinMs + random() * (BACKOFF.retryAckMaxMs - BACKOFF.retryAckMinMs)
  return Math.min(BACKOFF.retryAckCapMs, Math.floor(base * 2 ** doublings(retries)))
}
