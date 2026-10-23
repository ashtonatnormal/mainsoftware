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

// A register as readRegisterState reads it: every purpose's current entry (version 2, active on
// employment, listing nothing, unless given), the providers' rows, and the notice statement's row
// (no version unless given).
interface NoticeRead {
  id: string | null
  generated: boolean | null
  purposes: { purpose: string; version: number }[] | null
  providers: { provider: string; clearance: string; stated: boolean }[] | null
}
function registerPool(
  options: {
    purposes?: Record<string, Partial<{ version: number; status: string; providers: string[] }>>
    providers?: { provider: string; revision: string; review_on: string | null; clearance: string | null }[]
    notice?: Partial<NoticeRead>
  } = {},
) {
  return scriptedPool((statement: Statement) => {
    const { text } = statement
    if (text.startsWith('select distinct on (purpose)')) {
      return PURPOSE_KEYS.map(purpose => ({
        purpose,
        version: 2,
        status: 'active',
        basis: 'employment',
        providers: [],
        ...options.purposes?.[purpose],
      }))
    }
    if (text.startsWith('select r.provider')) return options.providers ?? []
    if (text.startsWith('select v.id, v.generator is not null as generated')) {
      return [{ id: null, generated: null, purposes: null, providers: null, ...options.notice }]
    }
    return systemPrincipal(SYSTEM)(statement)
  })
}

const read = async (pool: ReturnType<typeof scriptedPool>) =>
  withOrg(pool.db, { orgId: ORG, system: true }, trx => readRegisterState(trx, ORG, { restrictions: false }))

const VERSION = 'd1000000-0000-4000-8000-000000000001'
const AWS_CLEARANCE = 'c1000000-0000-4000-8000-000000000001'
const TWILIO_CLEARANCE = 'c1000000-0000-4000-8000-000000000002'

describe('PGT-04 C0.9 PD-08 PD-40 T22 item 6: nothing but the pinned purposes passes before a notice lists it', () => {
  it('PGT-04 C0.9 PD-40: with no version, or one that lists nothing (the seed’s stand-in), only the pinned purposes are allowed, however the register reads', async () => {
    for (const notice of [{}, { id: VERSION, generated: false, purposes: null }, { id: VERSION, generated: true }]) {
      const state = await read(registerPool({ notice }))
      expect(state.notified, JSON.stringify(notice)).toEqual(new Set())
      expect(PURPOSE_KEYS.filter(purpose => purposeAllowed(state, purpose))).toEqual(PINNED_PURPOSES)
    }
  })
})

describe('PGT-12 C0.9 PD-40 T22 item 27 “notified” goes strictly by version', () => {
  it('PGT-12: a purpose is notified only while the latest version lists it at its current register version, and only while active', async () => {
    const state = await read(
      registerPool({
        purposes: {
          security_audit: { version: 3 },
          backups: { version: 4 },
          presence_receipts: { version: 2, status: 'retired' },
          access_logs: { version: 2 },
        },
        notice: {
          id: VERSION,
          generated: true,
          purposes: [
            // Listed at its current version: notified.
            { purpose: 'security_audit', version: 3 },
            // Changed since publishing (now version 4): not notified until the next publish.
            { purpose: 'backups', version: 3 },
            // Retired, and listed as such (B-05): never notified.
            { purpose: 'presence_receipts', version: 2 },
            { purpose: 'accounts', version: 2 },
          ],
        },
      }),
    )
    expect([...state.notified].sort()).toEqual(['accounts', 'security_audit'])
    expect(purposeAllowed(state, 'security_audit')).toBe(true)
    expect(purposeAllowed(state, 'backups')).toBe(false)
    expect(purposeAllowed(state, 'presence_receipts')).toBe(false)
    // Not listed at all.
    expect(purposeAllowed(state, 'access_logs')).toBe(false)
    expect(state.notice).toEqual({ id: VERSION, generated: true })
  })

  it('PGT-12: a stand-in’s links count too, as the fixtures’ do; there are none in production (PD-33)', async () => {
    const state = await read(
      registerPool({
        notice: { id: VERSION, generated: false, purposes: [{ purpose: 'security_audit', version: 2 }] },
      }),
    )
    expect(state.notified).toEqual(new Set(['security_audit']))
    expect(state.notice).toEqual({ id: VERSION, generated: false })
  })

  it('reads the notice in one statement, for the org set, with no lock, through notice_provider_states() and the granted columns only', async () => {
    const pool = registerPool()
    await read(pool)
    const statement = pool.statements.find(s => s.text.startsWith('select v.id, v.generator is not null as generated'))
    expect(statement?.text).toBe(
      "select v.id, v.generator is not null as generated, (select json_agg(json_build_object('purpose', l.purpose, 'version', l.register_version)) from notice_version_purposes l where l.org_id = $1 and l.notice_version_id = v.id) as purposes, (select json_agg(json_build_object('provider', s.provider, 'clearance', s.clearance, 'stated', s.stated)) from public.notice_provider_states() s) as providers from (values (1)) as one (n) left join lateral ( select id, generator from notice_versions where org_id = $2 order by version desc limit 1) v on true",
    )
    expect(statement?.values).toEqual([ORG, ORG])
    expect(statement?.text).not.toMatch(/\bfor (share|update|no key update|key share)\b/)
    // Never a version's text, who published it, a clearance's facts or a version's providers (B-06).
    expect(statement?.text).not.toMatch(/\bbody\b|published_by|facts|notice_version_providers/)
  })
})

describe('PGT-13 C0.9 PD-41 B-03 T22 item 27 the provider-notice rule in the worker’s view', () => {
  const providers = [
    { provider: 'aws', revision: '3', review_on: null, clearance: AWS_CLEARANCE },
    { provider: 'twilio', revision: '2', review_on: null, clearance: TWILIO_CLEARANCE },
    { provider: 'livekit', revision: '1', review_on: null, clearance: null },
  ]
  const states = [
    { provider: 'aws', clearance: AWS_CLEARANCE, stated: true },
    { provider: 'twilio', clearance: TWILIO_CLEARANCE, stated: false },
  ]

  it('PGT-13: before the first generated version (none, or a stand-in) an open clearance alone clears, as PR 1 did', async () => {
    for (const notice of [{}, { id: VERSION, generated: false, providers: states }]) {
      const state = await read(registerPool({ providers, notice }))
      expect(providerCleared(state, 'aws')).toBe(true)
      expect(providerCleared(state, 'twilio')).toBe(true)
      expect(providerCleared(state, 'livekit')).toBe(false)
    }
  })

  it('PGT-13: once a generated version is the latest, a provider is cleared only while it states the open clearance', async () => {
    const state = await read(registerPool({ providers, notice: { id: VERSION, generated: true, providers: states } }))
    expect(state.providers.get('aws')?.stated).toBe(true)
    expect(state.providers.get('twilio')?.stated).toBe(false)
    expect(state.providers.get('livekit')?.stated).toBe(false)
    expect(providerCleared(state, 'aws')).toBe(true)
    expect(providerCleared(state, 'twilio')).toBe(false)
    expect(providerCleared(state, 'livekit')).toBe(false)
    // A purpose listing an unstated provider is refused, though notified.
    const listing = await read(
      registerPool({
        providers,
        purposes: { security_audit: { providers: ['twilio'] }, backups: { providers: ['aws'] } },
        notice: {
          id: VERSION,
          generated: true,
          providers: states,
          purposes: [
            { purpose: 'security_audit', version: 2 },
            { purpose: 'backups', version: 2 },
          ],
        },
      }),
    )
    expect(purposeAllowed(listing, 'security_audit')).toBe(false)
    expect(purposeAllowed(listing, 'backups')).toBe(true)
  })

  it('PGT-13: a stated row for another clearance than the one open now states nothing', async () => {
    const state = await read(
      registerPool({
        providers,
        notice: {
          id: VERSION,
          generated: true,
          providers: [{ provider: 'aws', clearance: 'c1000000-0000-4000-8000-0000000000ff', stated: true }],
        },
      }),
    )
    expect(state.providers.get('aws')?.stated).toBe(false)
    expect(providerCleared(state, 'aws')).toBe(false)
  })
})

describe('PGT-16 C0.9 B-04 C-09 PD-61 pinned purposes the published notice no longer describes', () => {
  it('PGT-16: a pinned purpose is stale only while the latest version is generated and doesn’t list it at its current version; it stays allowed', async () => {
    const purposes = { accounts: { version: 3 }, service_operation: { version: 2 } }
    const generated = await read(
      registerPool({
        purposes,
        notice: {
          id: VERSION,
          generated: true,
          purposes: [
            { purpose: 'accounts', version: 2 },
            { purpose: 'service_operation', version: 2 },
          ],
        },
      }),
    )
    expect(generated.stale).toEqual(new Set(['accounts']))
    expect(purposeAllowed(generated, 'accounts')).toBe(true)
    // Not listed at all is stale too.
    const unlisted = await read(registerPool({ purposes, notice: { id: VERSION, generated: true, purposes: [] } }))
    expect(unlisted.stale).toEqual(new Set(['accounts', 'service_operation']))
    // C-09: no version, or a stand-in as the latest: nothing is stale.
    for (const notice of [{}, { id: VERSION, generated: false, purposes: [] }]) {
      expect((await read(registerPool({ purposes, notice }))).stale, JSON.stringify(notice)).toEqual(new Set())
    }
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
        { ...ended, providers: new Map([['aws', { revision: 3, reviewOn: null, clearance: null, stated: false }]]) },
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
      [
        'aws',
        { revision: 4, reviewOn: '2027-01-31', clearance: 'c1000000-0000-4000-8000-000000000001', stated: false },
      ],
      ['twilio', { revision: 1, reviewOn: null, clearance: null, stated: false }],
    ])
    expect(state.notice).toBeNull()
    expect([...(state.restrictions ?? [])]).toEqual([
      [
        `${PERSON}:presence_receipts`,
        { id: 'e1000000-0000-4000-8000-000000000001', effectiveAt: Date.parse('2026-10-01T00:00:00Z') },
      ],
    ])
    const reads = p.statements.filter(s =>
      / from (processing_register|transfer_register|processing_restrictions|notice_versions)\b/.test(s.text),
    )
    expect(reads).toHaveLength(4)
    for (const read of reads) {
      expect(new Set(read.values)).toEqual(new Set([ORG]))
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
          ['aws', { revision: 3, reviewOn: null, clearance: 'c0000000-0000-4000-8000-000000000001', stated: false }],
        ]),
      },
      { ...base, providers: new Map([['aws', { revision: 2, reviewOn: null, clearance: null, stated: false }]]) },
      { ...base, restrictions: new Map() },
    ]
    for (const state of moved) expect(registerDigest(state)).not.toBe(registerDigest(base))
  })

  it('PGT-14 C0.9 T22 item 9: moves the digest on a publish (a new latest version) and when the notice comes to state a clearance, or stops', () => {
    const spec: RegisterStateSpec = { purposes: { accounts: { status: 'active', version: 1 } }, cleared: ['aws'] }
    const base = registerStateOf(spec)
    const published = registerStateOf({
      ...spec,
      notice: { id: 'd0000000-0000-4000-8000-000000000001', generated: true },
    })
    const again = registerStateOf({ ...spec, notice: { id: 'd0000000-0000-4000-8000-000000000002', generated: true } })
    const stated = registerStateOf({
      ...spec,
      notice: { id: 'd0000000-0000-4000-8000-000000000002', generated: true },
      stated: ['aws'],
    })
    const digests = [base, published, again, stated].map(registerDigest)
    expect(new Set(digests).size).toBe(4)
    expect(
      registerDigest(
        registerStateOf({ ...spec, notice: { id: 'd0000000-0000-4000-8000-000000000001', generated: true } }),
      ),
    ).toBe(digests[1])
  })
})
