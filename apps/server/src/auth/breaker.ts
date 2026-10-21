// The code checks' circuit breaker (T20): after `failures` provider failures within `windowMs`, it
// stays open for `openMs`, and while it is open every code check answers 503 unavailable without
// asking the provider. One per api process, on the Api object registerApi builds, so one test app's
// tripped breaker can't leak into another's.
export interface BreakerPolicy {
  failures: number
  windowMs: number
  openMs: number
}

export class Breaker {
  readonly policy: BreakerPolicy
  #failedAt: number[] = []
  #openUntil = 0
  readonly #now: () => number

  constructor(policy: BreakerPolicy, now: () => number = Date.now) {
    this.policy = policy
    this.#now = now
  }

  // Whether checks are refused now.
  isOpen(): boolean {
    return this.#now() < this.#openUntil
  }

  // A provider failure (an error or a timeout). The one that fills the window opens the breaker and
  // starts a new count.
  failed(): void {
    const now = this.#now()
    this.#failedAt = this.#failedAt.filter(at => now - at < this.policy.windowMs)
    this.#failedAt.push(now)
    if (this.#failedAt.length >= this.policy.failures) {
      this.#openUntil = now + this.policy.openMs
      this.#failedAt = []
    }
  }
}
