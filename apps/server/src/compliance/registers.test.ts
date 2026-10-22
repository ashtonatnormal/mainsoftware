import { isAiPurpose, PINNED_PURPOSES, PROVIDERS, PURPOSE_KEYS, PURPOSES } from '@hearth/shared'
import { describe, expect, it } from 'vitest'
import {
  isProcessingAllowed,
  providerCleared,
  purposeAllowed,
  readRegisterState,
  registerDigest,
} from '#src/compliance/registers.ts'
import { withOrg } from '#src/db/database.ts'
import { type RegisterStateSpec, registerStateOf } from '#src/testing/gates.ts'
import { type Statement, scriptedPool, systemPrincipal } from '#src/testing/pool.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const SYSTEM = 'c0000000-0000-4000-8000-000000000001'
const PERSON = 'b0000000-0000-4000-8000-000000000001'
const OTHER = 'b0000000-0000-4000-8000-000000000002'

// A register as the DPO might keep it: security_audit active on legitimate interests and listing
// aws, presence_receipts on deemed consent, recording_meetings planned.
const kept = (change: RegisterStateSpec = {}) =>
  registerStateOf({
    purposes: {
      accounts: { status: 'active', version: 1 },
      service_operation: { status: 'active', version: 1 },
      security_audit: { status: 'active', basis: 'legitimate_interests', providers: ['aws'] },
      presence_receipts: { status: 'active', basis: 'deemed_consent_conduct' },
      recording_meetings: { status: 'planned' },
    },
    cleared: ['aws'],
    ...change,
  })

describe('PGT-03 C0.9 PD-07 PD-09 T22 item 6 purposeAllowed', () => {
  it('allows the pinned purposes in every state of the register: never read, stale (undefined) or read', () => {
    expect(PINNED_PURPOSES).toEqual(['accounts', 'service_operation'])
    for (const state of [undefined, registerStateOf(), kept()]) {
      for (const purpose of PINNED_PURPOSES) expect(purposeAllowed(state, purpose), purpose).toBe(true)
    }
    // Even an entry the database would refuse (a pinned purpose retired) changes nothing.
    const retired = registerStateOf({ purposes: { accounts: { status: 'retired' } } })
    expect(purposeAllowed(retired, 'accounts')).toBe(true)
  })

  it('never allows an AI purpose (D41), nor a key that isn’t a purpose, whatever the register says', () => {
    const everything = registerStateOf({
      purposes: Object.fromEntries(PURPOSE_KEYS.map(key => [key, { status: 'active', basis: 'employment' }])),
      notified: [...PURPOSE_KEYS, 'made_up'],
      cleared: [...PROVIDERS],
    })
    for (const purpose of PURPOSE_KEYS.filter(key => PURPOSES[key].ai)) {
      expect(purposeAllowed(everything, purpose), purpose).toBe(false)
    }
    expect(purposeAllowed(everything, 'made_up')).toBe(false)
    expect(isAiPurpose('made_up')).toBe(true)
  })

  it('allows any other purpose only while it is active, notified, and every provider it lists is cleared', () => {
    const notified = ['security_audit', 'presence_receipts', 'recording_meetings']
    expect(purposeAllowed(kept({ notified }), 'security_audit')).toBe(true)
    expect(purposeAllowed(kept({ notified }), 'presence_receipts')).toBe(true)
    // Not active.
    expect(purposeAllowed(kept({ notified }), 'recording_meetings')).toBe(false)
    // A provider it lists isn't cleared.
    expect(purposeAllowed(kept({ notified, cleared: [] }), 'security_audit')).toBe(false)
    // No row: refused (PD-03).
    expect(purposeAllowed(kept({ notified: ['backups'] }), 'backups')).toBe(false)
    // Retired.
    const retired = kept({ notified, purposes: { security_audit: { status: 'retired', basis: 'employment' } } })
    expect(purposeAllowed(retired, 'security_audit')).toBe(false)
    // Never read, or stale.
    expect(purposeAllowed(undefined, 'security_audit')).toBe(false)
  })
})

describe('PGT-04 C0.9 PD-08 T22 item 6: PR 2’s tripwire', () => {
  it('C0.9 PR 1: until a notice is published from the register (PR 2), no purpose but the pinned ones is allowed', async () => {
    // What readRegisterState gives in PR 1, from a register where every purpose is active, on a
    // basis, with nothing listed: nothing is notified, so only the pinned purposes pass. PR 2 fills
    // notified from the highest published notice version and rewrites this test.
    const p = scriptedPool((statement: Statement) => {
      if (statement.text.startsWith('select distinct on (purpose)')) {
        return PURPOSE_KEYS.map(purpose => ({
          purpose,
          version: 2,
          status: 'active',
          basis: 'employment',
          providers: [],
        }))
      }
      return systemPrincipal(SYSTEM)(statement)
    })
    const state = await withOrg(p.db, { orgId: ORG, system: true }, trx =>
      readRegisterState(trx, ORG, { restrictions: false }),
    )
    expect(state.notified).toEqual(new Set())
    expect(PURPOSE_KEYS.filter(purpose => purposeAllowed(state, purpose))).toEqual(PINNED_PURPOSES)
  })
})

describe('PGT-05 C0.9 PD-10 T22 item 7 isProcessingAllowed (PDPA-04, PDPA-04a)', () => {
  // Restrictions read (the worker's cache reads them), none unless given.
  const on = (spec: RegisterStateSpec = {}) => registerStateOf({ restrictions: [], ...spec })

  it('allows the pinned purposes for everyone, whatever the register says or whether it was read', () => {
    for (const state of [undefined, registerStateOf(), on()]) {
      for (const purpose of PINNED_PURPOSES) expect(isProcessingAllowed(state, PERSON, purpose), purpose).toBe(true)
    }
  })

  it('refuses consent until consent records exist (C0.9 PR 2 or C1.3), and no basis recorded', () => {
    const state = on({
      purposes: {
        presence_receipts: { status: 'active', basis: 'consent' },
        session_sharing: { status: 'planned' },
      },
    })
    expect(isProcessingAllowed(state, PERSON, 'presence_receipts')).toBe(false)
    expect(isProcessingAllowed(state, PERSON, 'session_sharing')).toBe(false)
    expect(isProcessingAllowed(state, PERSON, 'backups')).toBe(false)
  })

  it('allows deemed consent (by conduct or by notification) unless the person has a restriction in effect', () => {
    for (const deemed of ['deemed_consent_conduct', 'deemed_consent_notification'] as const) {
      const state = on({
        purposes: { presence_receipts: { status: 'active', basis: deemed } },
        restrictions: [
          { person: OTHER, purpose: 'presence_receipts', effectiveAt: 1000 },
          { person: PERSON, purpose: 'presence_receipts', effectiveAt: 5000 },
        ],
      })
      expect(isProcessingAllowed(state, OTHER, 'presence_receipts', 2000), deemed).toBe(false)
      // A restriction takes effect from its time, not before.
      expect(isProcessingAllowed(state, PERSON, 'presence_receipts', 2000), deemed).toBe(true)
      expect(isProcessingAllowed(state, PERSON, 'presence_receipts', 5000), deemed).toBe(false)
      // Restrictions not read (a reader that may not): refused rather than guessed.
      const unread = registerStateOf({ purposes: { presence_receipts: { status: 'active', basis: deemed } } })
      expect(isProcessingAllowed(unread, PERSON, 'presence_receipts'), deemed).toBe(false)
    }
  })

  it('allows any other recorded basis, and refuses an AI purpose and a register never read', () => {
    for (const other of ['employment', 'legitimate_interests', 'business_improvement', 'other_exception'] as const) {
      const state = on({ purposes: { presence_receipts: { status: 'active', basis: other } } })
      expect(isProcessingAllowed(state, PERSON, 'presence_receipts'), other).toBe(true)
    }
    const ai = on({ purposes: { org_brain: { status: 'active', basis: 'employment' } } })
    expect(isProcessingAllowed(ai, PERSON, 'org_brain')).toBe(false)
    expect(isProcessingAllowed(undefined, PERSON, 'presence_receipts')).toBe(false)
  })
})

describe('XFR-02 C0.9 PD-05 PDPA-10 providerCleared', () => {
  it('is true only for a provider with an open clearance, never an AI one (D41), and never for a register not read', () => {
    const state = registerStateOf({ cleared: ['aws', 'openai', 'bedrock'] })
    expect(providerCleared(state, 'aws')).toBe(true)
    expect(providerCleared(state, 'twilio')).toBe(false)
    expect(providerCleared(state, 'openai')).toBe(false)
    expect(providerCleared(state, 'bedrock')).toBe(false)
    expect(providerCleared(state, 'carrier_pigeon')).toBe(false)
    expect(providerCleared(undefined, 'aws')).toBe(false)
    // An entry with no open clearance.
    const ended = registerStateOf()
    expect(
      providerCleared(
        { ...ended, providers: new Map([['aws', { revision: 3, reviewOn: null, clearance: null }]]) },
        'aws',
      ),
    ).toBe(false)
  })
})

describe('C0.9 T22 item 9 readRegisterState and registerDigest', () => {
  it('reads each purpose’s highest version, each provider with its open clearance, and live restrictions when asked, for the org set, with no lock', async () => {
    const p = scriptedPool((statement: Statement) => {
      const { text } = statement
      if (text.startsWith('select distinct on (purpose)')) {
        return [{ purpose: 'accounts', version: 3, status: 'active', basis: 'employment', providers: ['aws'] }]
      }
      if (text.startsWith('select r.provider')) {
        return [
          {
            provider: 'aws',
            revision: '4',
            review_on: '2027-01-31',
            clearance: 'c1000000-0000-4000-8000-000000000001',
          },
          { provider: 'twilio', revision: '1', review_on: null, clearance: null },
        ]
      }
      if (text.startsWith('select id, person_id, purpose')) {
        return [
          {
            id: 'e1000000-0000-4000-8000-000000000001',
            person_id: PERSON,
            purpose: 'presence_receipts',
            effective_at: new Date('2026-10-01T00:00:00Z'),
          },
        ]
      }
      return systemPrincipal(SYSTEM)(statement)
    })
    const state = await withOrg(p.db, { orgId: ORG, system: true }, trx =>
      readRegisterState(trx, ORG, { restrictions: true }),
    )
    expect([...state.purposes]).toEqual([
      ['accounts', { version: 3, status: 'active', basis: 'employment', providers: ['aws'] }],
    ])
    expect([...state.providers]).toEqual([
      ['aws', { revision: 4, reviewOn: '2027-01-31', clearance: 'c1000000-0000-4000-8000-000000000001' }],
      ['twilio', { revision: 1, reviewOn: null, clearance: null }],
    ])
    expect([...(state.restrictions ?? [])]).toEqual([
      [
        `${PERSON}:presence_receipts`,
        { id: 'e1000000-0000-4000-8000-000000000001', effectiveAt: Date.parse('2026-10-01T00:00:00Z') },
      ],
    ])
    const reads = p.statements.filter(s =>
      / from (processing_register|transfer_register|processing_restrictions)\b/.test(s.text),
    )
    expect(reads).toHaveLength(3)
    for (const read of reads) {
      expect(read.values).toEqual([ORG])
      expect(read.text).not.toMatch(/\bfor (share|update|no key update|key share)\b/)
    }
  })

  it('moves the digest on a new version, new facts (the revision), a clearance or a restriction, and only then', () => {
    const base = registerStateOf({
      purposes: { accounts: { status: 'active', version: 1 } },
      cleared: ['aws'],
      restrictions: [{ person: PERSON, purpose: 'presence_receipts' }],
    })
    const same = registerStateOf({
      purposes: { accounts: { status: 'active', version: 1 } },
      cleared: ['aws'],
      restrictions: [{ person: PERSON, purpose: 'presence_receipts' }],
    })
    expect(registerDigest(same)).toBe(registerDigest(base))
    const moved = [
      registerStateOf({
        purposes: { accounts: { status: 'active', version: 2 } },
        cleared: ['aws'],
        restrictions: [{ person: PERSON, purpose: 'presence_receipts' }],
      }),
      {
        ...base,
        providers: new Map([
          ['aws', { revision: 3, reviewOn: null, clearance: 'c0000000-0000-4000-8000-000000000001' }],
        ]),
      },
      { ...base, providers: new Map([['aws', { revision: 2, reviewOn: null, clearance: null }]]) },
      { ...base, restrictions: new Map() },
    ]
    for (const state of moved) expect(registerDigest(state)).not.toBe(registerDigest(base))
  })
})
