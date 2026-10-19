import { describe, expect, it } from 'vitest'
import { Breaker } from '#src/auth/breaker.ts'

describe('T20 the code checks circuit breaker', () => {
  it('opens after 3 failures within 60 s, stays open 30 s, then closes', () => {
    let now = 1_000_000
    const breaker = new Breaker({ failures: 3, windowMs: 60_000, openMs: 30_000 }, () => now)
    breaker.failed()
    now += 20_000
    breaker.failed()
    expect(breaker.isOpen()).toBe(false)
    now += 20_000
    breaker.failed()
    expect(breaker.isOpen()).toBe(true)
    now += 29_999
    expect(breaker.isOpen()).toBe(true)
    now += 1
    expect(breaker.isOpen()).toBe(false)
  })

  it('forgets failures older than the window', () => {
    let now = 0
    const breaker = new Breaker({ failures: 3, windowMs: 60_000, openMs: 30_000 }, () => now)
    breaker.failed()
    breaker.failed()
    now += 60_000
    breaker.failed()
    expect(breaker.isOpen()).toBe(false)
    breaker.failed()
    expect(breaker.isOpen()).toBe(false)
    breaker.failed()
    expect(breaker.isOpen()).toBe(true)
  })
})
