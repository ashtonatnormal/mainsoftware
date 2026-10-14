import { PROVIDERS, PURPOSE_KEYS, PURPOSES } from '@hearth/shared'
import { describe, expect, it } from 'vitest'
import { C06_GATE } from '#src/jobs/gate.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const PERSON = 'b0000000-0000-4000-8000-000000000001'

describe('C0.6 T15 item 10 the gate’s stand-ins fail closed until C0.9 and A0', () => {
  it('refuses every AI purpose and allows every other (D41)', () => {
    for (const purpose of PURPOSE_KEYS) {
      expect(C06_GATE.purposeAllowed(ORG, purpose), purpose).toBe(!PURPOSES[purpose].ai)
    }
    expect(C06_GATE.purposeAllowed(ORG, 'org_brain')).toBe(false)
    expect(C06_GATE.purposeAllowed(ORG, 'accounts')).toBe(true)
  })

  it('clears no provider (PDPA-10) until C0.9’s transfer register', () => {
    for (const provider of PROVIDERS) expect(C06_GATE.providerCleared(ORG, provider), provider).toBe(false)
  })

  it('allows processing only for purposes that rest on no consent (PDPA-04)', () => {
    for (const purpose of PURPOSE_KEYS) {
      expect(C06_GATE.processingAllowed(ORG, PERSON, purpose), purpose).toBe(!PURPOSES[purpose].consent)
    }
    expect(C06_GATE.processingAllowed(ORG, PERSON, 'accounts')).toBe(true)
    expect(C06_GATE.processingAllowed(ORG, PERSON, 'presence_receipts')).toBe(false)
  })

  it('puts nothing over a spend cap until A0', () => {
    expect(C06_GATE.overCap(ORG, 'ai.ask')).toBe(false)
  })
})
