// The live connection's own frame budget (T19 item 10, item 2 of packages/shared/src/gateway.ts's
// client side; T21 item 4). The server gives each socket a token bucket, full when it opens
// (GATEWAY_LIMITS.frameBurst, 20) and refilled at framesPerSecond (5) a second, and every frame the
// client sends takes a token; an empty bucket closes the socket with 1008 too_many_frames. The
// client keeps a smaller bucket of its own (CLIENT_POLICY: 18 and 4 a second), one per socket and
// full when it opens, so whatever it sends stays inside the server's with a margin.
export class TokenBucket {
  readonly burst: number
  readonly perSecond: number
  #tokens: number
  #at: number

  constructor(burst: number, perSecond: number, now: number) {
    this.burst = burst
    this.perSecond = perSecond
    this.#tokens = burst
    this.#at = now
  }

  #refill(now: number): void {
    if (now <= this.#at) return
    this.#tokens = Math.min(this.burst, this.#tokens + ((now - this.#at) * this.perSecond) / 1000)
    this.#at = now
  }

  // Takes a token if there is one, and says whether it did.
  take(now: number): boolean {
    this.#refill(now)
    if (this.#tokens < 1) return false
    this.#tokens -= 1
    return true
  }

  // How long until take() can succeed: 0 when a token is there now, else at least 1 ms.
  waitMs(now: number): number {
    this.#refill(now)
    if (this.#tokens >= 1) return 0
    return Math.max(1, Math.ceil(((1 - this.#tokens) * 1000) / this.perSecond))
  }
}
