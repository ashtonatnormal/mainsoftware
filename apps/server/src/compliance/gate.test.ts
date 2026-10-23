import { FLAGS, PINNED_PURPOSES, PROVIDERS, PURPOSE_KEYS } from '@hearth/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerGate } from '#src/compliance/gate.ts'
import { FLAG_STALE_MS, FlagCache } from '#src/flags/cache.ts'
import type { Gate } from '#src/jobs/gate.ts'
import { registerStateOf } from '#src/testing/gates.ts'
import { captureLogger } from '#src/testing/logs.ts'
import { type Statement, scriptedPool } from '#src/testing/pool.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const SYSTEM = 'c0000000-0000-4000-8000-000000000001'
const PERSON = 'b0000000-0000-4000-8000-000000000001'

// Whatever a gate answers for every purpose and provider, for comparing two gates.
const answers = (gate: Gate) => ({
  purposes: PURPOSE_KEYS.filter(purpose => gate.purposeAllowed(ORG, purpose)),
  providers: PROVIDERS.filter(provider => gate.providerCleared(ORG, provider)),
  processing: PURPOSE_KEYS.filter(purpose => gate.processingAllowed(ORG, PERSON, purpose)),
  overCap: gate.overCap(ORG, 'ai.ask'),
})

const UNREAD = { purposes: [...PINNED_PURPOSES], providers: [], processing: [...PINNED_PURPOSES], overCap: false }

describe('PGT-06 C0.9 PD-07 PD-16 T22 items 6 and 9 registerGate', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('over registers never read: the pinned purposes only, no provider, and nothing over a cap until A0', () => {
    expect(answers(registerGate({ register: () => undefined }))).toEqual(UNREAD)
  })

  it('over registers read: as they say, for the org asked about', () => {
    const state = registerStateOf({
      purposes: {
        accounts: { status: 'active', version: 1 },
        security_audit: { status: 'active', basis: 'legitimate_interests', providers: ['aws'] },
        presence_receipts: { status: 'active', basis: 'employment' },
      },
      cleared: ['aws', 'openai'],
      notified: ['security_audit'],
      restrictions: [],
    })
    const source = { register: vi.fn((orgId: string) => (orgId === ORG ? state : undefined)) }
    const gate = registerGate(source)
    expect(answers(gate)).toEqual({
      purposes: ['accounts', 'service_operation', 'security_audit'],
      // An AI provider never counts as cleared (D41).
      providers: ['aws'],
      processing: ['accounts', 'service_operation', 'security_audit', 'presence_receipts'],
      overCap: false,
    })
    expect(source.register).toHaveBeenCalledWith(ORG)
    // Another org's registers aren't these.
    expect(gate.purposeAllowed('a0000000-0000-4000-8000-000000000002', 'security_audit')).toBe(false)
    // Asked again each time, so a change shows at the next check (PD-17).
    source.register.mockReturnValue(undefined)
    expect(answers(gate)).toEqual(UNREAD)
  })

  it('over the worker’s cache: undefined until the first read and again once the read is 8 s old, and the pinned purposes pass throughout', async () => {
    let failing = false
    const p = scriptedPool((statement: Statement) => {
      const { text } = statement
      if (text.includes("from principals where org_id = $1 and kind = 'system'")) return [{ id: SYSTEM }]
      if (failing) return new Error('Connection terminated unexpectedly')
      if (text.startsWith('select r.provider')) {
        return [{ provider: 'aws', revision: '2', review_on: null, clearance: 'c1000000-0000-4000-8000-000000000001' }]
      }
      return []
    })
    const flags = new FlagCache({
      db: p.db,
      as: 'hearth_queue',
      registry: FLAGS,
      registers: { restrictions: true },
      logger: captureLogger('worker').logger,
      now: () => Date.now(),
      random: () => 0.5,
    })
    const gate = registerGate(flags)
    expect(answers(gate)).toEqual(UNREAD)
    await flags.track(ORG)
    expect(gate.providerCleared(ORG, 'aws')).toBe(true)
    expect(gate.purposeAllowed(ORG, 'accounts')).toBe(true)
    // Stale: every read fails for 8 s.
    failing = true
    await vi.advanceTimersByTimeAsync(FLAG_STALE_MS + 2500)
    expect(flags.confirmed(ORG)).toBe(false)
    expect(answers(gate)).toEqual(UNREAD)
    flags.stop()
  })

  it('is a plain object of closures, so a spread copy that replaces one check keeps the others, as every Gate is (T15 item 10)', () => {
    const state = registerStateOf({ cleared: ['aws'] })
    const gate = registerGate({ register: () => state })
    const copy: Gate = { ...gate, processingAllowed: () => false }
    expect(copy.purposeAllowed(ORG, 'accounts')).toBe(true)
    expect(copy.purposeAllowed(ORG, 'org_brain')).toBe(false)
    expect(copy.providerCleared(ORG, 'aws')).toBe(true)
    expect(copy.processingAllowed(ORG, PERSON, 'accounts')).toBe(false)
    expect(copy.overCap(ORG, 'ai.ask')).toBe(false)
    expect(Object.keys(gate).sort()).toEqual(['overCap', 'processingAllowed', 'providerCleared', 'purposeAllowed'])
  })
})
