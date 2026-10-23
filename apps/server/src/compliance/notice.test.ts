import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  AcknowledgeBody,
  AcknowledgeResponse,
  aiCopyIn,
  generateNotice,
  NOTICE_GENERATOR,
  NoticeAdminResponse,
  NoticeResponse,
  noticeDigestText,
  noticeDraftSources,
  PublishBody,
  PublishResponse,
} from '@hearth/shared'
import type { Redis } from 'ioredis'
import { describe, expect, it, vi } from 'vitest'
import type { Api } from '#src/api.ts'
import { Breaker } from '#src/auth/breaker.ts'
import { deriveKeys } from '#src/auth/crypto.ts'
import { ApiError } from '#src/auth/errors.ts'
import { relyingParty } from '#src/auth/passkeys.ts'
import { OTP } from '#src/auth/policy.ts'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'
import {
  acknowledgeNotice,
  NOTICE_ERRORS,
  noticeDraft,
  noticeFactsFrom,
  noticeStatusOf,
  publishNotice,
  readNotice,
  readNoticeAdmin,
} from '#src/compliance/notice.ts'
import { AfterResponse, parse, type ReqInfo } from '#src/http.ts'
import { staticFlags } from '#src/testing/flags.ts'
import { appended, pgError, type Statement, scriptedPool, standingsOf } from '#src/testing/pool.ts'
import { NOTHING_CLEARED } from '#src/testing/transfers.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const DPO = 'b0000000-0000-4000-8000-000000000005'
const OWNER = 'b0000000-0000-4000-8000-000000000001'
const LEFT = 'b0000000-0000-4000-8000-000000000009'
const DEVICE = 'd0000000-0000-4000-8000-000000000001'
const V0 = 'c0000000-0000-4000-8000-0000000000a0'
const V1 = 'c0000000-0000-4000-8000-0000000000a1'
const NEW = 'c0000000-0000-4000-8000-0000000000a2'
const TWILIO = 'c0000000-0000-4000-8000-0000000000c1'
const OLD_TWILIO = 'c0000000-0000-4000-8000-0000000000c0'
const session = (userId = DPO) => ({
  sessionId: 'e0000000-0000-4000-8000-000000000001',
  orgId: ORG,
  userId,
  deviceId: DEVICE,
})

// A clearance's facts snapshot as 0009 stores it (transfer_register_facts()), fictional.
const snapshot = (change: Record<string, unknown> = {}) => ({
  services: 'Sends sign-in codes',
  data_types: 'Your mobile number',
  processing_countries: ['US'],
  storage_countries: ['US'],
  countries_confirmed: 'Test agreement, annex 1',
  safeguard: 'dpa',
  safeguard_reference: 'Test agreement',
  certificate_verified_on: null,
  dpa_terms_confirmed: true,
  training: 'not_applicable',
  zero_retention: 'not_applicable',
  provider_retention: '30 days',
  retention_confirmed: 'Test agreement, annex 2',
  onward_recipients: 'Mobile carriers',
  review_on: '2027-10-01',
  ...change,
})

// The register as the draft reads it: accounts active and listing Twilio, security_audit planned,
// recording_meetings retired, and an AI row the read leaves out (as though SQL's filter had let it
// through).
const purposeRows = (change: Record<string, unknown> = {}) => [
  {
    purpose: 'accounts',
    version: 2,
    status: 'active',
    basis: 'employment',
    basis_reference: null,
    retention: 'Until you leave, then 90 days',
    providers: ['twilio', 'openai'],
    ...change,
  },
  {
    purpose: 'security_audit',
    version: 1,
    status: 'planned',
    basis: null,
    basis_reference: null,
    retention: null,
    providers: [],
  },
  {
    purpose: 'recording_meetings',
    version: 3,
    status: 'retired',
    basis: 'legitimate_interests',
    basis_reference: 'LIA register, row 2',
    retention: 'None kept: deleted on 1 October 2026',
    providers: [],
  },
  {
    purpose: 'org_brain',
    version: 1,
    status: 'planned',
    basis: null,
    basis_reference: null,
    retention: null,
    providers: [],
  },
]

interface World {
  fresh?: boolean
  // The draft's purposes and clearances.
  purposes?: readonly unknown[]
  clearances?: readonly unknown[]
  // The latest version and its links, and the person's acknowledgements.
  latest?: { id: string; version: number; generator: string | null; body: string } | undefined
  links?: { purposes: readonly unknown[]; clearances: readonly unknown[] }
  // Whether the acting person acknowledged the latest version, and their earlier generated one.
  acknowledged?: boolean
  since?: { id: string; version: number; generator: string; body: string } | undefined
  // The function's row, or an error to raise.
  call?: unknown[] | Error
  standing?: 'acknowledged' | 'required' | 'unpublished'
}

const PUBLISHED = new Date('2026-10-21T02:00:00Z')

function org(w: World = {}) {
  return scriptedPool((statement: Statement) => {
    const { text } = statement
    if (text.includes('from people p join devices d')) {
      return [{ fresh: w.fresh ?? true, pin_set: true, issued_under_pin_rule: true }]
    }
    if (text.startsWith('select "id", "deactivated_at" from "people"')) {
      return [
        { id: OWNER, deactivated_at: null },
        { id: DPO, deactivated_at: null },
        { id: LEFT, deactivated_at: new Date('2026-10-01T00:00:00Z') },
      ]
    }
    if (text.startsWith('select "person_id", "role"')) {
      return [
        { person_id: OWNER, role: 'owner', team_id: null, revoked_at: null },
        { person_id: DPO, role: 'dpo', team_id: null, revoked_at: null },
      ]
    }
    if (text.startsWith('select x.person, case when v.id is null') && w.standing !== undefined) {
      return standingsOf([DPO, OWNER], w.standing)
    }
    if (text.startsWith('select name, ((now() at time zone time_zone)::date)::text as today')) {
      return [{ name: 'Integration test', today: '2026-10-22' }]
    }
    if (text.startsWith('select distinct on (purpose) purpose, version, status, basis, basis_reference')) {
      return [...(w.purposes ?? purposeRows())]
    }
    if (text.startsWith('select c.id, c.provider, c.facts, t.review_on')) {
      return [...(w.clearances ?? [{ id: TWILIO, provider: 'twilio', facts: snapshot(), review_on: '2027-10-01' }])]
    }
    if (text.startsWith('select v.id, v.version, v.published_at, p.full_name as published_by, v.generator, v.body')) {
      return w.latest === undefined ? [] : [{ ...w.latest, published_at: PUBLISHED, published_by: 'Ashton Tan' }]
    }
    if (
      text.startsWith('select v.id, v.version, v.published_at, null::text as published_by, v.generator, v.body, exists')
    ) {
      return w.latest === undefined
        ? []
        : [{ ...w.latest, published_at: PUBLISHED, published_by: null, acknowledged: w.acknowledged ?? false }]
    }
    if (text.includes('where v.org_id = $1 and v.generator is not null and v.version < $2')) {
      return w.since === undefined ? [] : [{ ...w.since, published_at: PUBLISHED, published_by: null }]
    }
    if (text.startsWith('select notice_version_id, purpose, register_version')) return [...(w.links?.purposes ?? [])]
    if (text.startsWith('select l.notice_version_id, c.id, c.provider, c.facts'))
      return [...(w.links?.clearances ?? [])]
    if (text.startsWith('select v.version, a.acknowledged_at, a.method')) {
      return w.acknowledged && w.latest !== undefined
        ? [{ version: w.latest.version, acknowledged_at: new Date('2026-10-21T03:00:00Z'), method: 'in_app' }]
        : []
    }
    if (text.startsWith('select count(*)::int as people')) return [{ people: 2, acknowledged: 1 }]
    if (
      text.startsWith('select v.id, v.version, v.published_at, p.full_name as published_by, v.generator is not null')
    ) {
      return w.latest === undefined
        ? []
        : [
            {
              id: w.latest.id,
              version: w.latest.version,
              published_at: PUBLISHED,
              published_by: 'Ashton Tan',
              generated: w.latest.generator !== null,
            },
          ]
    }
    if (/^select (notice, version|version, changed) from public\./.test(text)) return w.call ?? []
    return []
  })
}

function context(pool: ReturnType<typeof scriptedPool>) {
  const after = vi.fn()
  const api: Api = {
    db: pool.db,
    valkey: { publish: vi.fn() } as unknown as Redis,
    keys: deriveKeys('unit-test-unit-test-unit-test-unit-test'),
    sms: undefined,
    keyPrefix: 'it:unit:',
    flags: staticFlags(),
    afterResponse: new AfterResponse(),
    appOrigin: 'https://hearth.example.com',
    names: valkeyKeys('it:unit:'),
    rp: relyingParty('https://hearth.example.com'),
    otp: { verifyFloorMs: 0, breaker: new Breaker(OTP.breaker) },
    passkeys: false,
    transfers: NOTHING_CLEARED,
  }
  const info: ReqInfo = {
    ip: '198.51.100.7',
    requestId: 'f0000000-0000-4000-8000-000000000001',
    userAgent: undefined,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ReqInfo['log'],
    after,
  }
  return { api, info, after }
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!(error instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(error)}`)
  return error
}

const callOf = (pool: ReturnType<typeof scriptedPool>, name: string) =>
  pool.statements.find(statement => statement.text.includes(`from public.${name}(`))

// The draft the fixture's registers make, as the generator writes it, and its digest.
const input = () => ({
  org: 'Integration test',
  purposes: [
    {
      key: 'accounts' as const,
      version: 2,
      status: 'active' as const,
      basis: 'employment' as const,
      basisReference: null,
      retention: 'Until you leave, then 90 days',
      providers: ['twilio' as const],
    },
    {
      key: 'security_audit' as const,
      version: 1,
      status: 'planned' as const,
      basis: null,
      basisReference: null,
      retention: null,
      providers: [],
    },
    {
      key: 'recording_meetings' as const,
      version: 3,
      status: 'retired' as const,
      basis: 'legitimate_interests' as const,
      basisReference: 'LIA register, row 2',
      retention: 'None kept: deleted on 1 October 2026',
      providers: [],
    },
  ],
  clearances: [{ id: TWILIO, provider: 'twilio' as const, facts: noticeFactsFrom(snapshot()), reviewOn: '2027-10-01' }],
})
const BODY = generateNotice(input())
const DIGEST = createHash('sha256')
  .update(noticeDigestText(noticeDraftSources(input(), BODY)))
  .digest('hex')

describe('NTS-02 C0.9 PD-36 PD-37 the draft: what the registers make, and its digest', () => {
  it('reads a clearance snapshot as its stated facts, and a fact of the wrong shape as not recorded', () => {
    expect(noticeFactsFrom(snapshot())).toEqual({
      services: 'Sends sign-in codes',
      dataTypes: 'Your mobile number',
      processingCountries: ['US'],
      storageCountries: ['US'],
      training: 'not_applicable',
      providerRetention: '30 days',
      onwardRecipients: 'Mobile carriers',
    })
    expect(noticeFactsFrom(snapshot({ services: 3, training: 'on', storage_countries: 'US' }))).toMatchObject({
      services: null,
      training: null,
      storageCountries: [],
    })
    expect(noticeFactsFrom(null)).toMatchObject({ services: null, processingCountries: [] })
  })

  it('generates the first version from the registers, leaving AI rows out, with the sha-256 of its sources as its digest', async () => {
    const pool = org()
    const draft = await pool.db.transaction().execute(trx => noticeDraft(trx as never, ORG))
    expect(draft.version).toBe(0)
    expect(draft.latest).toBeNull()
    expect(draft.body).toBe(BODY)
    expect(draft.digest).toBe(DIGEST)
    expect(draft.digest).toMatch(/^[0-9a-f]{64}$/)
    // Active and retired purposes, by key; the open clearance; the AI purpose and provider left out.
    expect(draft.sources.purposes).toEqual([
      { key: 'accounts', version: 2 },
      { key: 'recording_meetings', version: 3 },
    ])
    expect(draft.sources.clearances.map(clearance => clearance.id)).toEqual([TWILIO])
    expect(draft.sources.generator).toBe(NOTICE_GENERATOR)
    expect(draft.problems).toEqual([])
    expect(draft.warnings.map(warning => warning.code)).toEqual(['dpo_contact_pending', 'production_access_pending'])
    expect(draft.changes).toBeNull()
    expect(draft.upToDate).toBe(false)
    expect(noticeStatusOf(draft)).toBe('none')
    // Every read is plain: publish_notice() does the locking.
    expect(pool.texts().join(' ')).not.toMatch(/\bfor (share|update|no key update)\b/)
  })

  it('PD-62 B-14 C-05: free text the screens keep off holds the draft back with neither words nor digest, naming the field, never the word', async () => {
    const pool = org({
      clearances: [
        { id: TWILIO, provider: 'twilio', facts: snapshot({ onward_recipients: 'Our agents' }), review_on: null },
      ],
    })
    const draft = await pool.db.transaction().execute(trx => noticeDraft(trx as never, ORG))
    expect(draft.problems).toEqual([{ code: 'free_text_ai_copy', provider: 'twilio', field: 'onward_recipients' }])
    expect(draft.body).toBeNull()
    expect(draft.digest).toBeNull()
    expect(JSON.stringify(draft.problems)).not.toMatch(/agents/i)
  })

  it('PD-62 C-05: the Tembusu seed’s org name, which every notice prints and publishing doesn’t check, matches no AI_COPY pattern', () => {
    // The DPO can't change the org's name, so publishing doesn't hold it to AI_COPY; the bootstrap
    // and C0.16's org settings refuse a matching one, and this holds the seed's (T22 item 24).
    const seed = readFileSync(new URL('../../../../db/seed/tembusu.sql', import.meta.url), 'utf8')
    const names = [...seed.matchAll(/insert into public\.orgs \(id, name\) values \('[0-9a-f-]+', '([^']+)'\)/g)].map(
      match => match[1] ?? '',
    )
    expect(names).toEqual(['Tembusu Logistics'])
    for (const name of names) expect(aiCopyIn(name), name).toBeUndefined()
  })

  it('PD-48: a draft the latest version already says is up to date, a provider cleared again on the same facts included; one from a stand-in is out of date, with what it changes', async () => {
    const links = {
      purposes: [
        { notice_version_id: V0, purpose: 'accounts', register_version: 2 },
        { notice_version_id: V0, purpose: 'recording_meetings', register_version: 3 },
      ],
      clearances: [{ notice_version_id: V0, id: TWILIO, provider: 'twilio', facts: snapshot() }],
    }
    const same = org({ latest: { id: V0, version: 0, generator: NOTICE_GENERATOR, body: BODY }, links })
    const draft = await same.db.transaction().execute(trx => noticeDraft(trx as never, ORG))
    expect(draft.version).toBe(1)
    expect(draft.problems).toEqual([{ code: 'unchanged' }])
    expect(draft.upToDate).toBe(true)
    expect(noticeStatusOf(draft)).toBe('up_to_date')
    expect(draft.changes).toEqual({
      since: 0,
      purposes: { added: [], changed: [], removed: [] },
      providers: { added: [], changed: [], removed: [] },
      wording: false,
    })
    // A provider cleared again on the same facts (a new review date alone) is still up to date: its
    // sends go on, and publishing only warns that everyone would acknowledge the same words again.
    const recleared = org({
      latest: { id: V0, version: 0, generator: NOTICE_GENERATOR, body: BODY },
      links: {
        ...links,
        clearances: [{ notice_version_id: V0, id: OLD_TWILIO, provider: 'twilio', facts: snapshot() }],
      },
    })
    const sameFacts = await recleared.db.transaction().execute(trx => noticeDraft(trx as never, ORG))
    expect(sameFacts.problems).toEqual([])
    expect(sameFacts.warnings.map(warning => warning.code)).toContain('same_text')
    expect(sameFacts.upToDate).toBe(true)
    expect(noticeStatusOf(sameFacts)).toBe('up_to_date')
    // Other stated facts aren't: the notice no longer says them, and Twilio's sends wait for it.
    const moved = org({
      latest: { id: V0, version: 0, generator: NOTICE_GENERATOR, body: BODY },
      links: {
        ...links,
        clearances: [
          {
            notice_version_id: V0,
            id: OLD_TWILIO,
            provider: 'twilio',
            facts: snapshot({ provider_retention: '7 days' }),
          },
        ],
      },
    })
    const otherFacts = await moved.db.transaction().execute(trx => noticeDraft(trx as never, ORG))
    expect(otherFacts.upToDate).toBe(false)
    expect(noticeStatusOf(otherFacts)).toBe('out_of_date')
    const standIn = org({ latest: { id: V0, version: 0, generator: null, body: 'A stand-in' } })
    const fromStandIn = await standIn.db.transaction().execute(trx => noticeDraft(trx as never, ORG))
    expect(fromStandIn.upToDate).toBe(false)
    expect(noticeStatusOf(fromStandIn)).toBe('out_of_date')
    expect(fromStandIn.changes).toMatchObject({
      since: 0,
      purposes: { added: ['accounts', 'recording_meetings'] },
      providers: { added: ['twilio'] },
      wording: true,
    })
  })
})

describe('NTS-02 C0.9 PD-46 B-11 GET /api/notice', () => {
  it('answers your standing, the current version, what changed since the generated version you last acknowledged, and your acknowledgements, in a read-only transaction that leaves the session alone', async () => {
    const pool = org({
      latest: { id: V1, version: 1, generator: NOTICE_GENERATOR, body: BODY },
      since: { id: V0, version: 0, generator: NOTICE_GENERATOR, body: 'Older words' },
      links: {
        purposes: [
          { notice_version_id: V0, purpose: 'accounts', register_version: 1 },
          { notice_version_id: V1, purpose: 'accounts', register_version: 2 },
        ],
        clearances: [
          {
            notice_version_id: V0,
            id: OLD_TWILIO,
            provider: 'twilio',
            facts: snapshot({ provider_retention: '7 days' }),
          },
          { notice_version_id: V1, id: TWILIO, provider: 'twilio', facts: snapshot() },
        ],
      },
    })
    const c = context(pool)
    const answer = NoticeResponse.parse((await readNotice(c.api, session(OWNER), c.info)).body)
    expect(answer).toEqual({
      person: OWNER,
      standing: 'required',
      current: { id: V1, version: 1, publishedAt: '2026-10-21T02:00:00.000Z', body: BODY },
      changes: {
        since: 0,
        purposes: { added: [], changed: ['accounts'], removed: [] },
        providers: { added: [], changed: ['twilio'], removed: [] },
        wording: false,
      },
      mine: [],
    })
    expect(pool.texts()[0]).toBe('start transaction isolation level read committed read only')
    // /notice polls it: not use of the session (PD-46).
    expect(c.after).not.toHaveBeenCalled()
    expect(pool.texts().join(' ')).not.toMatch(/\bfor (share|update|no key update)\b/)
  })

  it('reads acknowledged once you have, unpublished before any version, and a stand-in as the latest with no changes', async () => {
    const acknowledged = org({
      latest: { id: V1, version: 1, generator: null, body: 'A stand-in' },
      acknowledged: true,
    })
    const c = context(acknowledged)
    expect(NoticeResponse.parse((await readNotice(c.api, session(OWNER), c.info)).body)).toMatchObject({
      standing: 'acknowledged',
      changes: null,
      mine: [{ version: 1, acknowledgedAt: '2026-10-21T03:00:00.000Z', method: 'in_app' }],
    })
    const none = context(org())
    expect(NoticeResponse.parse((await readNotice(none.api, session(OWNER), none.info)).body)).toEqual({
      person: OWNER,
      standing: 'unpublished',
      current: null,
      changes: null,
      mine: [],
    })
  })

  it('answers an ended session as signed out, never 404, and passes whatever the person’s standing (NOTICE_FREE)', async () => {
    const pool = org({ standing: 'required' })
    const c = context(pool)
    expect(await refusal(readNotice(c.api, session(LEFT), c.info))).toMatchObject({ status: 401, code: 'signed_out' })
    // The gate isn't asked: notice.read_own is free in every standing.
    expect(pool.texts().some(text => text.startsWith('select x.person'))).toBe(false)
  })
})

describe('NTS-02 C0.9 PD-42 POST /api/notice/acknowledge', () => {
  const body = parse(AcknowledgeBody, { notice: V1 })

  it('acknowledges the version read on the session’s own device through acknowledge_notice(), appending notice.acknowledged only when something was recorded', async () => {
    for (const changed of [true, false]) {
      const pool = org({ standing: 'required', call: [{ version: 1, changed }] })
      const c = context(pool)
      const answer = await acknowledgeNotice(c.api, body, session(OWNER), c.info)
      expect(AcknowledgeResponse.parse(answer.body)).toEqual({ version: 1, changed })
      const call = callOf(pool, 'acknowledge_notice')
      expect(call?.text).toBe(
        'select version, changed from public.acknowledge_notice($1::uuid, $2, $3::uuid, $4::inet)',
      )
      expect(call?.values).toEqual([V1, c.info.requestId, DEVICE, c.info.ip])
      expect(appended(pool.statements)).toEqual(
        changed
          ? [
              {
                type: 'notice.acknowledged',
                entity: OWNER,
                subjects: [OWNER],
                ids: { notice: V1, version: 1 },
                actor: undefined,
              },
            ]
          : [],
      )
      // A state-changing request re-reads the acting session FOR SHARE.
      expect(
        pool.texts().some(text => text.includes('from people p join devices d') && text.includes('for share')),
      ).toBe(true)
      expect(pool.texts().at(-1)).toBe('commit')
    }
  })

  it('PD-52: answers HF007 409 notice_changed, 22023 404, and a person or device gone 401 signed_out, clearing the cookie', async () => {
    for (const [sqlstate, status, code, clears] of [
      ['HF007', 409, 'notice_changed', false],
      ['22023', 404, 'not_found', false],
      ['42501', 401, 'signed_out', true],
    ] as const) {
      const pool = org({ call: pgError(sqlstate) })
      const c = context(pool)
      const error = await refusal(acknowledgeNotice(c.api, body, session(OWNER), c.info))
      expect(error, sqlstate).toMatchObject({ status, code })
      expect(error.clear.length > 0).toBe(clears)
      expect(appended(pool.statements)).toEqual([])
      expect(pool.texts().at(-1)).toBe('rollback')
    }
  })
})

describe('NTS-02 C0.9 PD-48 PD-49 GET /api/admin/notice', () => {
  it('lets the DPO read the draft, the latest version’s count acknowledged (never names) and the history', async () => {
    const pool = org({ latest: { id: V0, version: 0, generator: null, body: 'A stand-in' } })
    const c = context(pool)
    const answer = NoticeAdminResponse.parse((await readNoticeAdmin(c.api, session(), c.info)).body)
    expect(answer.today).toBe('2026-10-22')
    expect(answer.latest).toEqual({
      id: V0,
      version: 0,
      publishedAt: '2026-10-21T02:00:00.000Z',
      publishedBy: 'Ashton Tan',
      generated: false,
      acknowledged: 1,
      people: 2,
    })
    expect(answer.draft).toMatchObject({ version: 1, body: BODY, digest: DIGEST, problems: [], upToDate: false })
    expect(answer.history).toEqual([
      { id: V0, version: 0, publishedAt: '2026-10-21T02:00:00.000Z', publishedBy: 'Ashton Tan', generated: false },
    ])
    expect(pool.texts()[0]).toBe('start transaction isolation level read committed read only')
    // Only active people are counted, in one statement with their acknowledgements.
    expect(pool.texts().find(text => text.startsWith('select count(*)::int as people'))).toMatch(
      /p\.deactivated_at is null/,
    )
  })

  it('refuses everyone but the DPO, and a DPO whose PIN is more than 5 minutes old, before reading the notice or the registers', async () => {
    for (const [who, fresh, code] of [
      [OWNER, true, 'forbidden'],
      [DPO, false, 'reauth_required'],
    ] as const) {
      const pool = org({ fresh })
      const c = context(pool)
      expect(await refusal(readNoticeAdmin(c.api, session(who), c.info)), who).toMatchObject({ status: 403, code })
      // The gate's standing read aside (compliance/notice-standing.ts).
      const read = pool.texts().filter(text => !text.startsWith('select x.person'))
      expect(read.some(text => /notice_versions|processing_register|transfer_clearances/.test(text))).toBe(false)
    }
  })

  it('PD-43 PD-44: a DPO who hasn’t acknowledged the latest version is sent to it (403 notice_required); before any version, the DPO passes', async () => {
    const required = context(org({ standing: 'required' }))
    expect(await refusal(readNoticeAdmin(required.api, session(), required.info))).toMatchObject({
      status: 403,
      code: 'notice_required',
    })
    const before = context(org({ standing: 'unpublished' }))
    expect(
      NoticeAdminResponse.parse((await readNoticeAdmin(before.api, session(), before.info)).body).latest,
    ).toBeNull()
    // An Owner before v0 is refused by the gate, before can().
    const owner = context(org({ standing: 'unpublished' }))
    expect(await refusal(readNoticeAdmin(owner.api, session(OWNER), owner.info))).toMatchObject({
      code: 'notice_required',
    })
  })
})

describe('NTS-02 C0.9 PD-36 PD-37 PD-52 POST /api/admin/notice/publish', () => {
  const publish = (input: Record<string, unknown> = {}) => parse(PublishBody, { seen: null, digest: DIGEST, ...input })

  it('publishes the previewed draft through publish_notice() with its sources, and appends notice.published naming the new version', async () => {
    const pool = org({ call: [{ notice: NEW, version: 0 }] })
    const c = context(pool)
    const answer = await publishNotice(c.api, publish(), session(), c.info)
    expect(PublishResponse.parse(answer.body)).toEqual({ notice: NEW, version: 0 })
    const call = callOf(pool, 'publish_notice')
    expect(call?.text).toBe(
      'select notice, version from public.publish_notice($1::integer, $2, $3, $4::text[], $5::integer[], $6::uuid[], $7, $8::uuid, $9::inet)',
    )
    expect(call?.values).toEqual([
      null,
      BODY,
      NOTICE_GENERATOR,
      ['accounts', 'recording_meetings'],
      [2, 3],
      [TWILIO],
      c.info.requestId,
      DEVICE,
      c.info.ip,
    ])
    expect(appended(pool.statements)).toEqual([
      { type: 'notice.published', entity: NEW, subjects: [], ids: { version: 0 }, actor: undefined },
    ])
    // can() first (the acting session FOR SHARE), then the draft's plain reads, then the function.
    const texts = pool.texts()
    const acting = texts.findIndex(text => text.includes('from people p join devices d'))
    expect(texts[acting]).toMatch(/for share of p, d, s/)
    expect(acting).toBeLessThan(texts.findIndex(text => text.startsWith('select c.id, c.provider')))
    expect(texts.at(-1)).toBe('commit')
  })

  it('answers a stale seen or digest 409 notice_changed and a draft with a problem 400 notice_invalid, before the database is asked', async () => {
    for (const [world, body, status, code] of [
      [{}, publish({ seen: 0 }), 409, 'notice_changed'],
      [{}, publish({ digest: 'f'.repeat(64) }), 409, 'notice_changed'],
      [{ latest: { id: V0, version: 0, generator: null, body: 'A stand-in' } }, publish(), 409, 'notice_changed'],
      [{ purposes: purposeRows({ basis: null }) }, publish(), 400, 'notice_invalid'],
      [{ purposes: purposeRows({ retention: 'Kept by our agents' }) }, publish(), 400, 'notice_invalid'],
      [{ clearances: [] }, publish(), 400, 'notice_invalid'],
    ] as const) {
      const pool = org({ ...world, call: [{ notice: NEW, version: 0 }] })
      const c = context(pool)
      expect(await refusal(publishNotice(c.api, body, session(), c.info)), JSON.stringify(world)).toMatchObject({
        status,
        code,
      })
      expect(callOf(pool, 'publish_notice')).toBeUndefined()
      expect(appended(pool.statements)).toEqual([])
    }
  })

  it('refuses everyone but a freshly re-authenticated DPO through can(), before reading the draft', async () => {
    for (const [who, fresh, code] of [
      [OWNER, true, 'forbidden'],
      [DPO, false, 'reauth_required'],
    ] as const) {
      const pool = org({ fresh, call: [{ notice: NEW, version: 0 }] })
      const c = context(pool)
      expect(await refusal(publishNotice(c.api, publish(), session(who), c.info))).toMatchObject({ status: 403, code })
      const read = pool.texts().filter(text => !text.startsWith('select x.person'))
      expect(read.some(text => /notice_versions|processing_register|publish_notice/.test(text))).toBe(false)
    }
  })

  it('answers the function’s refusals: HF007 409 notice_changed, HF008 400 notice_invalid, 42501 403, 22023 404, and a conflict as the api’s try_again', async () => {
    for (const [sqlstate, status, code] of [
      ['HF007', 409, 'notice_changed'],
      ['HF008', 400, 'notice_invalid'],
      ['42501', 403, 'forbidden'],
      ['22023', 404, 'not_found'],
    ] as const) {
      const pool = org({ call: pgError(sqlstate) })
      const c = context(pool)
      expect(await refusal(publishNotice(c.api, publish(), session(), c.info)), sqlstate).toMatchObject({
        status,
        code,
      })
      expect(appended(pool.statements)).toEqual([])
      expect(pool.texts().at(-1)).toBe('rollback')
    }
    const conflict = context(org({ call: pgError('40P01') }))
    const error = await publishNotice(conflict.api, publish(), session(), conflict.info).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).not.toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ code: '40P01' })
    // Every code only the notice answers is one of these.
    expect([...NOTICE_ERRORS]).toEqual(['notice_required', 'notice_changed', 'notice_invalid'])
  })
})
