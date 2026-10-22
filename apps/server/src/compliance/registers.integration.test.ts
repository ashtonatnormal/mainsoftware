// The registers through the DPO's routes on the Compose stack (C0.9, TECH-SPEC T22; PDPA-01,
// PDPA-10, PDPA-13): the real api over migration 0009, the DPO on a PIN-rule session, and a worker
// instance whose purpose gate judges work by its flag read's copy of the registers. Each test
// makes its own org, DPO and people, so `-t` on one test works. `npm run test:integration` runs it
// with the stack up (`docker compose up -d --wait`).
//
// afterAll checks every reply was no-store and none a 500, that no Node warning fired, the
// outbox's contract for the run (every committed write covered; this suite owns
// register.purpose_changed and register.transfer_changed), and, when every test passed, that each
// of the registers' own error codes was answered.
import {
  ACTIVE_FROM_START,
  NON_AI_PROVIDERS,
  NON_AI_PURPOSE_KEYS,
  type RegistersJSON,
  RegistersResponse,
  type TransferFacts,
  type TransferProblem,
  transferProblems,
} from '@hearth/shared'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REGISTER_ERRORS } from '#src/compliance/routes.ts'
import { withOrg } from '#src/db/database.ts'
import { CLEARING_FACTS, type Client, type Org, type Person, type Stack, startStack } from '#src/testing/stack.ts'
import { everyTestPassed, expectEveryWriteCovered } from '#src/testing/writes.ts'

let s: Stack

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Polls every 20 ms until check passes on what read gives, for at most `ms`.
async function eventually<T>(read: () => T | Promise<T>, check: (value: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (check(value)) return value
    if (Date.now() > deadline) throw new Error(`still not as expected after ${ms} ms: ${JSON.stringify(value)}`)
    await sleep(20)
  }
}

// An org of the test's own, with its DPO signed in (a PIN role: the code, then a new PIN; the
// sign-in counts as a re-authentication for 5 minutes).
async function dpoOrg(): Promise<{ org: Org; dpo: Person; client: Client }> {
  const org = await s.newOrg()
  const dpo = await s.person({ org, roles: ['dpo'] })
  return { org, dpo, client: await s.signIn(dpo) }
}

// The registers as the DPO reads them, strictly as the server types them.
async function registers(client: Client): Promise<RegistersJSON> {
  const reply = await client.get('/api/admin/registers')
  expect([reply.status, reply.error]).toEqual([200, undefined])
  return RegistersResponse.parse(reply.body)
}

const purposeBody = (seen: number) => ({
  purpose: 'security_audit',
  seen,
  status: 'active',
  basis: 'legitimate_interests',
  basisReference: 'Fictional assessment, row 2',
  optOutDays: null,
  retention: '1 year',
  providers: ['aws'],
})

interface EventRow {
  type: string
  entity_id: string
  actor_id: string
  actor_kind: string
  purpose: string
  ids: Record<string, unknown>
  subject_ids: string[]
  tx_id: string
}
const eventsIn = (org: Org) =>
  s.query<EventRow>(
    `select type, entity_id, actor_id, actor_kind, purpose, ids, subject_ids, tx_id::text from outbox_events
     where org_id = $1 and type like 'register.%' order by id`,
    [org.id],
  )

interface AuditRow {
  action: string
  actor_id: string
  target_type: string
  target_id: string
  device_id: string | null
  request_id: string | null
  details: Record<string, unknown>
}
const auditsIn = (org: Org) =>
  s.query<AuditRow>(
    `select action, actor_id, target_type, target_id, device_id, request_id, details from audit_events
     where org_id = $1 and action like 'register.%' order by id`,
    [org.id],
  )

// How many times a worker logged register_changed for the org.
const changesLogged = (org: Org) =>
  s.logs.filter(line => line.event === 'register_changed' && line.org === org.id).length

describe('C0.9 T22 the registers through the DPO’s routes (PDPA-01, PDPA-10, PDPA-13)', () => {
  beforeAll(async () => {
    s = await startStack()
  })

  // biome-ignore lint/correctness/noEmptyPattern: the hook takes no fixtures.
  afterAll(async ({}, suite) => {
    if (s === undefined) return
    try {
      for (const reply of s.replies) {
        expect(reply.cacheControl, `${reply.method} ${reply.url}`).toBe('no-store')
        expect(reply.error, `${reply.method} ${reply.url}`).not.toBe('internal')
      }
      expect(s.warnings.map(warning => `${warning.name}: ${warning.message}`)).toEqual([])
      const all = everyTestPassed(suite)
      await expectEveryWriteCovered(s.superuser, 'registers', { allPassed: all })
      if (all) {
        const answered = new Set(s.replies.map(reply => reply.error))
        expect(REGISTER_ERRORS.filter(code => !answered.has(code))).toEqual([])
      }
    } finally {
      await s.stop()
    }
  })

  it('RGS-I1 C0.9 PD-04 PD-05 PD-21 PD-22: the DPO reads, records a purpose and a provider’s facts, clears, keeps cleared and withdraws; each write audits and appends its event, and the worker’s gate sees it within one poll', async () => {
    const { org, dpo, client } = await dpoOrg()
    const worker = await s.startWorker({ productionConsumers: false })
    await worker.ready()
    const gate = worker.worker.gate
    // The worker reads the org's registers in its flag read (T22 item 9).
    const register = () => worker.worker.flags.register(org.id)
    await eventually(register, state => state !== undefined)
    const changed = async (before: number) =>
      eventually(
        () => changesLogged(org),
        count => count > before,
      )

    // A new org's starting state (PD-06): the four purposes Hearth runs on active with no basis,
    // every other non-AI one planned, nothing cleared, and no AI row in the answer (PD-27).
    const start = await registers(client)
    expect(start.purposes.filter(row => row.status === 'active').map(row => row.purpose)).toEqual([
      ...ACTIVE_FROM_START,
    ])
    expect(start.purposes.every(row => row.version === 1 && row.basis === null && row.recordedBy === null)).toBe(true)
    expect(start.purposes.map(row => row.purpose)).toEqual([...NON_AI_PURPOSE_KEYS])
    expect(start.transfers.map(row => row.provider)).toEqual([...NON_AI_PROVIDERS])
    expect(start.transfers.every(row => row.revision === 1 && row.clearance === null)).toBe(true)
    const { deviceId } = await s.sessionOf(client)

    // A purpose's next version (PDPA-01): security_audit on legitimate interests.
    let before = changesLogged(org)
    const recorded = await client.post('/api/admin/registers/purposes/set', purposeBody(1))
    expect([recorded.status, recorded.body]).toMatchObject([200, { version: 2, changed: true }])
    await changed(before)
    expect(register()?.purposes.get('security_audit')).toEqual({
      version: 2,
      status: 'active',
      basis: 'legitimate_interests',
      providers: ['aws'],
    })
    // Still not allowed: no published notice lists it until C0.9 PR 2 (PGT-04, PD-08).
    expect(gate.purposeAllowed(org.id, 'security_audit')).toBe(false)
    expect(gate.purposeAllowed(org.id, 'accounts')).toBe(true)
    const read = await registers(client)
    expect(read.purposes.find(row => row.purpose === 'security_audit')).toMatchObject({
      version: 2,
      basisReference: 'Fictional assessment, row 2',
      recordedOn: read.today,
      recordedBy: `Person ${dpo.id.slice(0, 8)}`,
    })
    // Saving it unchanged changes nothing, and writes no version, event or audit row.
    const again = await client.post('/api/admin/registers/purposes/set', purposeBody(2))
    expect([again.status, again.body]).toMatchObject([200, { version: 2, changed: false }])

    // A provider's facts, then its clearance, then new facts kept cleared, then the withdrawal.
    before = changesLogged(org)
    const facts = await client.post('/api/admin/registers/transfers/record', {
      provider: 'apple_push',
      seen: 1,
      ...CLEARING_FACTS,
      keepCleared: false,
    })
    expect([facts.status, facts.body]).toMatchObject([200, { revision: 2, cleared: false, changed: true }])
    // A change of facts moves the revision, which the worker's digest includes (T22 item 9).
    await changed(before)
    expect(gate.providerCleared(org.id, 'apple_push')).toBe(false)

    before = changesLogged(org)
    const cleared = await client.post('/api/admin/registers/transfers/clear', { provider: 'apple_push', seen: 2 })
    expect([cleared.status, cleared.body]).toMatchObject([200, { revision: 2, cleared: true, changed: true }])
    await changed(before)
    expect(gate.providerCleared(org.id, 'apple_push')).toBe(true)
    // Clearing it again changes nothing.
    const twice = await client.post('/api/admin/registers/transfers/clear', { provider: 'apple_push', seen: 2 })
    expect([twice.status, twice.body]).toMatchObject([200, { cleared: true, changed: false }])

    before = changesLogged(org)
    const kept = await client.post('/api/admin/registers/transfers/record', {
      provider: 'apple_push',
      seen: 2,
      ...CLEARING_FACTS,
      onwardRecipients: 'None, by contract',
      keepCleared: true,
    })
    expect([kept.status, kept.body]).toMatchObject([200, { revision: 3, cleared: true, changed: true }])
    await changed(before)
    expect(gate.providerCleared(org.id, 'apple_push')).toBe(true)

    before = changesLogged(org)
    const withdrawn = await client.post('/api/admin/registers/transfers/withdraw', { provider: 'apple_push' })
    expect([withdrawn.status, withdrawn.body]).toMatchObject([200, { revision: 3, cleared: false, changed: true }])
    await changed(before)
    expect(gate.providerCleared(org.id, 'apple_push')).toBe(false)
    const nothing = await client.post('/api/admin/registers/transfers/withdraw', { provider: 'apple_push' })
    expect([nothing.status, nothing.body]).toMatchObject([200, { cleared: false, changed: false }])

    const entry = (await registers(client)).transfers.find(row => row.provider === 'apple_push')
    expect(entry).toMatchObject({
      revision: 3,
      onwardRecipients: 'None, by contract',
      updatedBy: `Person ${dpo.id.slice(0, 8)}`,
      clearance: { clearedVia: 'app', revision: 3, withdrawReason: 'dpo_decision' },
    })

    // One event per change, each in its own transaction, naming the new version or the entry, the
    // DPO as the actor, service_operation, and nobody as a subject (PD-22).
    const events = await eventsIn(org)
    expect(events.map(event => [event.type, event.ids])).toEqual([
      ['register.purpose_changed', { purpose: 'security_audit', status: 'active' }],
      ['register.transfer_changed', { provider: 'apple_push', cleared: false }],
      ['register.transfer_changed', { provider: 'apple_push', cleared: true }],
      ['register.transfer_changed', { provider: 'apple_push', cleared: true }],
      ['register.transfer_changed', { provider: 'apple_push', cleared: false }],
    ])
    expect(new Set(events.map(event => event.tx_id)).size).toBe(5)
    for (const event of events) {
      expect(event).toMatchObject({
        actor_id: dpo.id,
        actor_kind: 'human',
        purpose: 'service_operation',
        subject_ids: [],
      })
    }
    const [version2] = await s.query<{ id: string }>(
      `select id from processing_register where org_id = $1 and purpose = 'security_audit' and version = 2`,
      [org.id],
    )
    const [apple] = await s.query<{ id: string }>(
      `select id from transfer_register where org_id = $1 and provider = 'apple_push'`,
      [org.id],
    )
    expect(events[0]?.entity_id).toBe(version2?.id)
    expect(events.slice(1).every(event => event.entity_id === apple?.id)).toBe(true)

    // One audit row per change (ADM-06), the DPO acting from this session's device; the facts'
    // history in the record's details (from and to), naming nobody's personal data.
    const audits = await auditsIn(org)
    expect(audits.map(row => [row.action, row.target_type, row.target_id])).toEqual([
      ['register.purpose_set', 'processing_purpose', 'security_audit'],
      ['register.transfer_recorded', 'transfer_entry', 'apple_push'],
      ['register.transfer_cleared', 'transfer_entry', 'apple_push'],
      ['register.transfer_recorded', 'transfer_entry', 'apple_push'],
      ['register.transfer_withdrawn', 'transfer_entry', 'apple_push'],
    ])
    for (const row of audits) expect(row).toMatchObject({ actor_id: dpo.id, device_id: deviceId })
    expect(audits[3]?.details).toMatchObject({
      revision: 3,
      was_revision: 2,
      changed: { onward_recipients: { from: 'None', to: 'None, by contract' } },
      ended_clearance: true,
      kept_cleared: true,
    })
    await worker.stop()
  })

  it('RGS-I2 C0.9 PD-20 PD-30: only the DPO reaches the registers, with a PIN from the last 5 minutes, and never an AI key', async () => {
    const { org, dpo, client } = await dpoOrg()
    const owner = await s.person({ org, roles: ['owner'] })
    const admin = await s.person({ org, roles: ['admin'] })
    const member = await s.person({ org })
    const routes = (seen: number): Array<[string, unknown]> => [
      ['/api/admin/registers/purposes/set', purposeBody(seen)],
      ['/api/admin/registers/transfers/record', { provider: 'aws', seen, ...CLEARING_FACTS, keepCleared: false }],
      ['/api/admin/registers/transfers/clear', { provider: 'aws', seen }],
      ['/api/admin/registers/transfers/withdraw', { provider: 'aws' }],
    ]
    const nothingWritten = async () => {
      expect(await eventsIn(org)).toEqual([])
      expect(await auditsIn(org)).toEqual([])
    }
    for (const person of [owner, admin, member]) {
      const other = await s.signIn(person)
      const read = await other.get('/api/admin/registers')
      expect([read.status, read.error], 'GET').toEqual([403, 'forbidden'])
      for (const [url, body] of routes(1)) {
        const refused = await other.post(url, body)
        expect([refused.status, refused.error], url).toEqual([403, 'forbidden'])
      }
    }
    await nothingWritten()

    // A PIN more than 5 minutes old: the refusal names the PIN, and the PIN lets the DPO on.
    await s.age((await s.sessionOf(client)).id, '6 minutes')
    const stale = await client.get('/api/admin/registers')
    expect([stale.status, stale.body]).toMatchObject([403, { error: 'reauth_required', method: 'pin' }])
    for (const [url, body] of routes(1)) {
      const refused = await client.post(url, body)
      expect([refused.status, refused.body], url).toMatchObject([403, { error: 'reauth_required', method: 'pin' }])
    }
    await nothingWritten()
    await s.reauth(client, dpo)
    expect((await client.get('/api/admin/registers')).status).toBe(200)

    // AI purposes and providers stay off limits until A0 (D41, PD-27), whatever the DPO asks.
    for (const [url, body] of [
      [
        '/api/admin/registers/purposes/set',
        {
          ...purposeBody(1),
          purpose: 'org_brain',
          status: 'planned',
          basis: null,
          basisReference: null,
          retention: null,
          providers: [],
        },
      ],
      ['/api/admin/registers/transfers/record', { provider: 'openai', seen: 1, ...CLEARING_FACTS, keepCleared: false }],
      ['/api/admin/registers/transfers/clear', { provider: 'bedrock', seen: 1 }],
      ['/api/admin/registers/transfers/withdraw', { provider: 'openai' }],
    ] as const) {
      const refused = await client.post(url, body)
      expect([refused.status, refused.error], url).toEqual([403, 'forbidden'])
    }
    await nothingWritten()
  })

  it('RGS-I3 C0.9 PD-25: an edit from an older version or revision answers 409 register_changed, and an entry a rule refuses 400 register_invalid, writing nothing', async () => {
    const { org, client } = await dpoOrg()
    expect((await client.post('/api/admin/registers/purposes/set', purposeBody(1))).status).toBe(200)
    // From version 1 again, after version 2 was recorded.
    const stalePurpose = await client.post('/api/admin/registers/purposes/set', {
      ...purposeBody(1),
      retention: '2 years',
    })
    expect([stalePurpose.status, stalePurpose.error]).toEqual([409, 'register_changed'])
    // A transfer entry from an older revision, to record or to clear.
    expect(
      (
        await client.post('/api/admin/registers/transfers/record', {
          provider: 'livekit',
          seen: 1,
          ...CLEARING_FACTS,
          services: 'Fictional rooms',
          keepCleared: false,
        })
      ).status,
    ).toBe(200)
    const staleFacts = await client.post('/api/admin/registers/transfers/record', {
      provider: 'livekit',
      seen: 1,
      ...CLEARING_FACTS,
      keepCleared: false,
    })
    expect([staleFacts.status, staleFacts.error]).toEqual([409, 'register_changed'])
    const staleClear = await client.post('/api/admin/registers/transfers/clear', { provider: 'livekit', seen: 1 })
    expect([staleClear.status, staleClear.error]).toEqual([409, 'register_changed'])

    // The shared rules, before the database: a pinned purpose retired, a consent-type basis for one
    // that needs a switch (PD-11, deemed consent by conduct included), a certification unverified.
    for (const [url, body] of [
      [
        '/api/admin/registers/purposes/set',
        { ...purposeBody(1), purpose: 'accounts', status: 'retired', basis: 'employment', basisReference: null },
      ],
      [
        '/api/admin/registers/purposes/set',
        {
          ...purposeBody(1),
          purpose: 'recording_meetings',
          status: 'planned',
          basis: 'deemed_consent_conduct',
          basisReference: null,
        },
      ],
      [
        '/api/admin/registers/transfers/record',
        { provider: 'aws', seen: 1, ...CLEARING_FACTS, safeguard: 'certification', keepCleared: false },
      ],
    ] as const) {
      const refused = await client.post(url, body)
      expect([refused.status, refused.error], JSON.stringify(body).slice(0, 80)).toEqual([400, 'register_invalid'])
    }
    // The clearance trigger, on facts not yet complete (HF006): aws has nothing recorded.
    const incomplete = await client.post('/api/admin/registers/transfers/clear', { provider: 'aws', seen: 1 })
    expect([incomplete.status, incomplete.error]).toEqual([400, 'register_invalid'])
    // Only the two successful records wrote anything.
    expect((await eventsIn(org)).map(event => event.type)).toEqual([
      'register.purpose_changed',
      'register.transfer_changed',
    ])
  })

  it('RGS-I4 C0.9 PD-12: the shared transferProblems() and the clearance trigger refuse the same fact first, case by case', async () => {
    const { org, dpo, client } = await dpoOrg()
    const { today } = await registers(client)
    const later = CLEARING_FACTS.reviewOn
    const complete: TransferFacts = { ...CLEARING_FACTS }
    // Each case: the facts recorded, the problem the shared rules list first, and the words of the
    // trigger's (or, for a certification with no date, the table's) refusal.
    const cases: Array<[Partial<TransferFacts>, TransferProblem | undefined, RegExp | undefined]> = [
      [{ services: null }, 'services', /Record the services it provides/],
      [{ dataTypes: null, training: null }, 'data_types', /Record the personal data it receives/],
      [{ processingCountries: [] }, 'processing_countries', /where it processes the data/],
      [{ storageCountries: [] }, 'storage_countries', /where it stores the data/],
      [{ countriesConfirmed: null }, 'countries_confirmed', /confirmed those countries in writing/],
      [{ safeguard: null }, 'safeguard', /Record the safeguard for the transfer/],
      [{ safeguardReference: null }, 'safeguard_reference', /Record where the safeguard is kept/],
      [
        { safeguard: 'certification', certificateVerifiedOn: null },
        'certificate_unverified',
        /transfer_register_certificate/,
      ],
      [
        { safeguard: 'certification', certificateVerifiedOn: later },
        'certificate_future',
        /verified on a date still to come/,
      ],
      [{ dpaTermsConfirmed: false }, 'dpa_terms', /Confirm the agreement binds protection comparable/],
      [{ training: null }, 'training', /Record whether it trains on the data/],
      [{ zeroRetention: null }, 'zero_retention', /Record the zero-retention result/],
      [{ zeroRetention: 'pending' }, 'zero_retention', /Pending isn't a result/],
      [{ providerRetention: null }, 'provider_retention', /Record how long it keeps the data before/],
      [{ retentionConfirmed: null }, 'retention_confirmed', /confirmed how long it keeps the data in writing/],
      [{ onwardRecipients: null }, 'onward_recipients', /Record who it passes the data on to/],
      [{ reviewOn: null }, 'review_on', /Set a review date after today/],
      [{ reviewOn: today }, 'review_due', /Set a review date after today/],
      [{}, undefined, undefined],
    ]
    for (const [change, problem, refusal] of cases) {
      const facts = { ...complete, ...change }
      expect(transferProblems({ provider: 'google_fcm', ...facts }, today)[0], JSON.stringify(change)).toBe(problem)
      // The DPO's own functions, in one transaction that never commits: record, then clear.
      const error = await withOrg(s.db, { orgId: org.id, userId: dpo.id }, async trx => {
        const { rows } = await sql<{ revision: string }>`select revision from public.record_transfer_entry('google_fcm',
            1::bigint, ${facts.services}, ${facts.dataTypes}, ${facts.processingCountries}::text[],
            ${facts.storageCountries}::text[], ${facts.countriesConfirmed}, ${facts.safeguard}, ${facts.safeguardReference},
            ${facts.certificateVerifiedOn}::date, ${facts.dpaTermsConfirmed}, ${facts.training}, ${facts.zeroRetention},
            ${facts.providerRetention}, ${facts.retentionConfirmed}, ${facts.onwardRecipients}, ${facts.reviewOn}::date,
            false, 'it', null, null)`.execute(trx)
        await sql`select * from public.clear_transfer_entry('google_fcm', ${rows[0]?.revision}::bigint, 'it', null, null)`.execute(
          trx,
        )
        throw new Error('cleared')
      }).then(
        () => undefined,
        (e: unknown) => e as { code?: string; message?: string; constraint?: string },
      )
      if (refusal === undefined) expect(error?.message, 'complete facts clear').toBe('cleared')
      else if (problem === 'certificate_unverified') {
        expect([error?.code, error?.constraint]).toEqual(['23514', 'transfer_register_certificate'])
      } else {
        expect(error?.code, JSON.stringify(change)).toBe('HF006')
        expect(error?.message, JSON.stringify(change)).toMatch(refusal)
      }
    }
    // An AI provider: the shared rules and the function refuse it whatever its facts (D41).
    expect(transferProblems({ provider: 'openai', ...complete }, today)).toEqual(['ai_provider'])
    const ai = await withOrg(s.db, { orgId: org.id, userId: dpo.id }, trx =>
      sql`select * from public.clear_transfer_entry('openai', 1::bigint, 'it', null, null)`.execute(trx),
    ).then(
      () => undefined,
      (e: unknown) => e as { code?: string },
    )
    expect(ai?.code).toBe('HF006')
    // Nothing above committed.
    expect(await eventsIn(org)).toEqual([])
  })
})
