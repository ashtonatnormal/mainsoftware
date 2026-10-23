// The privacy notice's vocabulary, what changed between two versions, and the bodies and answers of
// /api/notice and /api/admin/notice (C0.9 PR 2, TECH-SPEC T22 items 21 to 37), and from C0.9 PR 3a
// the DPO's contact each version printed and the acknowledgements the DPO records (OD-11, OD-19).
// That the stated facts equal notice_facts()'s keys is checked against the database by check 6
// (apps/server/scripts/check-catalogues.ts); the words are notice-text.test.ts's.
import { describe, expect, it } from 'vitest'
import type { DpoContact } from './dpo-contact.ts'
import {
  AcknowledgeBody,
  AcknowledgeResponse,
  AcknowledgeResponseForClient,
  NOTICE_ACK_METHODS,
  NOTICE_BODY_MAX,
  NOTICE_CONTACT_CHANGES,
  NOTICE_FACT_FIELDS,
  NOTICE_FREE_TEXT_FIELDS,
  NOTICE_GENERATOR_PATTERN,
  NOTICE_HISTORY_MAX,
  NOTICE_LINE,
  NOTICE_MINE_MAX,
  NOTICE_NOTE_MAX,
  NOTICE_PEOPLE_MAX,
  NOTICE_PROBLEMS,
  NOTICE_TRANSFER_FACTS,
  NOTICE_WARNINGS,
  NoticeAdminResponse,
  NoticeAdminResponseForClient,
  type NoticeFacts,
  NoticePeopleResponse,
  NoticePeopleResponseForClient,
  NoticeResponse,
  NoticeResponseForClient,
  type NoticeSources,
  noticeChanges,
  noticeFactsOf,
  PublishBody,
  PublishResponse,
  PublishResponseForClient,
  RECORD_PROBLEMS,
  RecordAcknowledgementBody,
  recordProblems,
  sameNoticeFacts,
} from './notice.ts'
import type { TransferFacts } from './registers.ts'

const person = 'b0000000-0000-4000-8000-000000000012'
const notice = 'e0000000-0000-4000-8000-000000000002'
const digest = 'a'.repeat(64)
const at = '2026-10-23T01:00:00.000Z'
const SMILE = String.fromCodePoint(0x1f642)

// The DPO's business contact, fictional, on a reserved domain (C0.9 OD-10).
const CONTACT: DpoContact = { title: 'Data Protection Officer', email: 'dpo@notice.example', phone: null, postal: null }

// Twilio Verify's stated facts, fictional.
const TWILIO: NoticeFacts = {
  services: 'Verify: sign-in and re-authentication codes by SMS',
  dataTypes: 'Mobile number, channel, Service SID',
  processingCountries: ['US'],
  storageCountries: ['US'],
  training: 'not_applicable',
  providerRetention: 'Verification records for 90 days',
  onwardRecipients: 'Mobile carriers',
}
const AWS: NoticeFacts = {
  ...TWILIO,
  services: 'Hosting and storage',
  dataTypes: 'Everything Hearth stores',
  processingCountries: ['SG'],
  storageCountries: ['SG'],
  training: 'off',
}

describe('C0.9 PD-33 PD-41: the body and the stated facts', () => {
  it('PD-33: the line format’s prefixes, the body limit and the generator ids 0010 admits', () => {
    expect(NOTICE_LINE).toEqual({ section: '## ', entry: '### ', item: '- ' })
    expect(NOTICE_BODY_MAX).toBe(100_000)
    for (const id of ['c09.1', 'c09.12', 'pr3-1', '0']) expect(NOTICE_GENERATOR_PATTERN.test(id), id).toBe(true)
    for (const id of ['', 'C09.1', '.c09', 'c09 1', 'c'.repeat(33), 'c09_1']) {
      expect(NOTICE_GENERATOR_PATTERN.test(id), id).toBe(false)
    }
  })

  it('PD-41 A-01: a version states seven facts of each provider, named as the clearance snapshot names them, each mapped to its register field', () => {
    expect([...NOTICE_TRANSFER_FACTS]).toEqual([
      'services',
      'data_types',
      'processing_countries',
      'storage_countries',
      'training',
      'provider_retention',
      'onward_recipients',
    ])
    expect(Object.keys(NOTICE_FACT_FIELDS)).toEqual([...NOTICE_TRANSFER_FACTS])
    // Not the review date, the safeguard, the zero-retention result or a written confirmation:
    // changing those keeps sends going.
    const unstated: (keyof TransferFacts)[] = [
      'countriesConfirmed',
      'safeguard',
      'safeguardReference',
      'certificateVerifiedOn',
      'dpaTermsConfirmed',
      'zeroRetention',
      'retentionConfirmed',
      'reviewOn',
    ]
    for (const field of unstated) expect(Object.values(NOTICE_FACT_FIELDS), field).not.toContain(field)
  })

  it('PD-41: noticeFactsOf keeps only the stated facts, and sameNoticeFacts compares each of them exactly', () => {
    const whole: TransferFacts = {
      ...TWILIO,
      countriesConfirmed: 'Addendum, section 4',
      safeguard: 'dpa',
      safeguardReference: 'Addendum, 1 Oct 2026',
      certificateVerifiedOn: null,
      dpaTermsConfirmed: true,
      zeroRetention: 'not_offered',
      retentionConfirmed: 'Support case',
      reviewOn: '2027-10-01',
    }
    expect(noticeFactsOf(whole)).toEqual(TWILIO)
    expect(Object.keys(noticeFactsOf(whole)).sort()).toEqual(Object.values(NOTICE_FACT_FIELDS).sort())
    // A new review date or safeguard states nothing new.
    const reviewed: TransferFacts = { ...whole, reviewOn: '2028-01-01', safeguard: 'dpa_addendum' }
    expect(sameNoticeFacts(noticeFactsOf(reviewed), TWILIO)).toBe(true)
    expect(sameNoticeFacts(TWILIO, { ...TWILIO })).toBe(true)
    const changed: Partial<NoticeFacts>[] = [
      { services: `${TWILIO.services} and WhatsApp` },
      { dataTypes: 'Mobile number' },
      { processingCountries: ['US', 'IE'] },
      { storageCountries: [] },
      { training: 'off' },
      { providerRetention: null },
      { onwardRecipients: 'Mobile carriers ' },
    ]
    for (const change of changed)
      expect(sameNoticeFacts(TWILIO, { ...TWILIO, ...change }), JSON.stringify(change)).toBe(false)
  })
})

describe('C0.9 PD-37 PD-38 PD-62 PD-68 PD-86: what holds publishing back and what it warns of', () => {
  it('PD-37 PD-68 PD-86: the problems, in publish_notice()’s order with the route’s own two where it checks them; the DPO’s contact is a problem, never a warning', () => {
    expect([...NOTICE_PROBLEMS]).toEqual([
      'purpose_basis_missing',
      'purpose_retention_missing',
      'purpose_consent_basis',
      'purpose_conduct_unstoppable',
      'provider_not_cleared',
      'dpo_contact_pending',
      'free_text_ai_copy',
      'unchanged',
    ])
    expect([...NOTICE_WARNINGS]).toEqual([
      'provider_unlisted',
      'provider_review_due',
      'sends_waiting',
      'same_text',
      'production_access_pending',
    ])
  })

  it('PD-62 PD-65: the free text checked is the DPO’s that the notice prints: a purpose’s reference and retention, a provider’s stated facts that are text, and the contact but its phone number', () => {
    expect([...NOTICE_FREE_TEXT_FIELDS]).toEqual([
      'basis_reference',
      'retention',
      'services',
      'data_types',
      'provider_retention',
      'onward_recipients',
      'contact_title',
      'contact_email',
      'contact_postal',
    ])
  })
})

// A version's sources, from the parts a test changes.
const sources = (change: Partial<NoticeSources> = {}): NoticeSources => ({
  generator: 'c09.1',
  body: 'The words',
  purposes: [
    { key: 'accounts', version: 2 },
    { key: 'backups', version: 2 },
  ],
  clearances: [
    { id: 'c0000000-0000-4000-8000-000000000001', provider: 'aws', facts: AWS },
    { id: 'c0000000-0000-4000-8000-000000000002', provider: 'twilio', facts: TWILIO },
  ],
  contact: { version: 1, facts: CONTACT },
  ...change,
})
const NOTHING = { added: [], changed: [], removed: [] }

describe('NTG-08 C0.9 PD-46 PD-48 PD-67: what changed between two versions', () => {
  it('NTG-08: the same sources change nothing', () => {
    expect(noticeChanges(sources(), sources())).toEqual({
      purposes: NOTHING,
      providers: NOTHING,
      contact: 'same',
      wording: false,
    })
  })

  it('NTG-08 PD-67: the contact was added after a version that printed none, changed when its details differ, and is the same when they match, whichever settings version', () => {
    expect([...NOTICE_CONTACT_CHANGES]).toEqual(['same', 'added', 'changed'])
    const printedNone = sources({ generator: 'c09.0', contact: null })
    const standIn = sources({ generator: null, purposes: [], clearances: [], contact: null })
    for (const before of [printedNone, standIn]) expect(noticeChanges(before, sources()).contact).toBe('added')
    const changes: Partial<DpoContact>[] = [
      { title: 'Data Protection Office' },
      { email: 'privacy@notice.example' },
      { phone: '+65 8000 0196' },
      { postal: '1 Example Road' },
    ]
    for (const change of changes) {
      const after = sources({ body: 'Other words', contact: { version: 2, facts: { ...CONTACT, ...change } } })
      expect(noticeChanges(sources(), after), JSON.stringify(change)).toMatchObject({
        contact: 'changed',
        wording: false,
      })
    }
    // A new settings version with the same details, or none printed on either side, is the same.
    expect(noticeChanges(sources(), sources({ contact: { version: 3, facts: { ...CONTACT } } })).contact).toBe('same')
    expect(noticeChanges(printedNone, sources({ contact: null })).contact).toBe('same')
    // A version that prints none after one that did can't be published (dpo_contact_pending), and
    // claims nothing.
    expect(noticeChanges(sources(), sources({ contact: null })).contact).toBe('same')
  })

  it('NTG-08 PD-40: a purpose added, at a new register version or no longer listed, in the registry’s order', () => {
    const after = sources({
      purposes: [
        { key: 'security_audit', version: 3 },
        { key: 'backups', version: 3 },
        { key: 'access_logs', version: 2 },
      ],
    })
    expect(noticeChanges(sources(), after).purposes).toEqual({
      added: ['security_audit', 'access_logs'],
      changed: ['backups'],
      removed: ['accounts'],
    })
  })

  it('NTG-08 PD-41: a provider added or removed, or stating other facts; one cleared again on the same facts hasn’t changed', () => {
    const recleared = sources({
      clearances: [
        { id: 'c0000000-0000-4000-8000-0000000000a1', provider: 'aws', facts: { ...AWS } },
        { id: 'c0000000-0000-4000-8000-000000000002', provider: 'twilio', facts: TWILIO },
      ],
    })
    expect(noticeChanges(sources(), recleared).providers).toEqual(NOTHING)
    const after = sources({
      clearances: [
        {
          id: 'c0000000-0000-4000-8000-0000000000a2',
          provider: 'twilio',
          facts: { ...TWILIO, storageCountries: ['IE'] },
        },
        { id: 'c0000000-0000-4000-8000-0000000000a3', provider: 'apple_push', facts: AWS },
      ],
    })
    expect(noticeChanges(sources(), after).providers).toEqual({
      added: ['apple_push'],
      changed: ['twilio'],
      removed: ['aws'],
    })
  })

  it('NTG-08 PD-36: the words changed with a new generator, or with new words from the same sources (a new org name)', () => {
    expect(noticeChanges(sources(), sources({ generator: 'c09.2' })).wording).toBe(true)
    expect(
      noticeChanges(sources({ generator: null, purposes: [], clearances: [], contact: null }), sources()).wording,
    ).toBe(true)
    expect(noticeChanges(sources(), sources({ body: 'Other words' })).wording).toBe(true)
    // New words that come with a listed change, or with a new contact, are that change, not new
    // wording (PD-67).
    const moved = sources({ body: 'Other words', purposes: [{ key: 'accounts', version: 3 }] })
    expect(noticeChanges(sources(), moved).wording).toBe(false)
    const contacted = sources({
      body: 'Other words',
      contact: { version: 2, facts: { ...CONTACT, email: null, phone: '+65 8000 0196' } },
    })
    expect(noticeChanges(sources(), contacted).wording).toBe(false)
    // A draft that can't be written yet compares by its sources and generator alone.
    expect(noticeChanges(sources(), sources({ body: null })).wording).toBe(false)
  })
})

const current = { id: notice, version: 1, publishedAt: at, body: '## About this notice\n\nThe words.' }
const changes = {
  since: 0,
  purposes: { added: ['security_audit'], changed: ['accounts'], removed: [] },
  providers: { added: [], changed: ['twilio'], removed: [] },
  contact: 'added',
  wording: false,
}
const inApp = { version: 0, acknowledgedAt: at, method: 'in_app', acknowledgedOn: null, note: null }
const recorded = {
  version: 1,
  acknowledgedAt: at,
  method: 'recorded_by_dpo',
  acknowledgedOn: '2026-10-21',
  note: 'Signed a printed copy at induction',
}
const answer = {
  person,
  standing: 'required',
  current,
  contact: CONTACT,
  changes,
  mine: [recorded, inApp],
}

describe('C0.9 PD-42 PD-46 B-11: GET /api/notice and POST /api/notice/acknowledge', () => {
  it('PDPA-03 B-11 PD-69: the answer is whose it is, the standing, the latest version with the contact it printed, what changed and your own acknowledgements, and nothing more', () => {
    expect(NoticeResponse.parse(answer)).toEqual(answer)
    expect(NoticeResponse.parse({ ...answer, changes: null, mine: [] }).mine).toEqual([])
    expect(NoticeResponse.parse({ ...answer, contact: null }).contact).toBeNull()
    for (const bad of [
      { ...answer, extra: 1 },
      { ...answer, person: person.toUpperCase() },
      { ...answer, standing: 'exempt' },
      { ...answer, current: { ...current, body: '' } },
      { ...answer, current: { ...current, publishedAt: '23 Oct 2026' } },
      { ...answer, current: { ...current, version: -1 } },
      { ...answer, current: { ...current, generator: 'c09.1' } },
      { ...answer, changes: { ...changes, purposes: { ...changes.purposes, added: ['org_brain'] } } },
      { ...answer, changes: { ...changes, providers: { ...changes.providers, added: ['openai'] } } },
      { ...answer, mine: [{ ...inApp, method: 'email' }] },
      { ...answer, mine: Array.from({ length: NOTICE_MINE_MAX + 1 }, () => inApp) },
      { ...answer, mine: [{ ...inApp, deviceId: person }] },
      { ...answer, contact: { ...CONTACT, email: 'dpo at notice.example' } },
      { ...answer, contact: { ...CONTACT, email: null } },
      { ...answer, contact: { ...CONTACT, version: 1 } },
      { ...answer, changes: { ...changes, contact: 'removed' } },
      // PD-75: a day and a note come together, and only on an acknowledgement the DPO recorded.
      { ...answer, mine: [{ ...inApp, acknowledgedOn: '2026-10-21', note: 'On paper' }] },
      { ...answer, mine: [{ ...recorded, note: null }] },
      { ...answer, mine: [{ ...recorded, acknowledgedOn: null }] },
      { ...answer, mine: [{ ...recorded, acknowledgedOn: '21 Oct 2026' }] },
      { ...answer, mine: [{ ...recorded, note: '' }] },
      { ...answer, mine: [{ ...recorded, note: 'x'.repeat(NOTICE_NOTE_MAX + 1) }] },
      { ...answer, mine: [{ version: 0, acknowledgedAt: at, method: 'in_app' }] },
    ]) {
      expect(NoticeResponse.safeParse(bad).success, JSON.stringify(bad).slice(0, 160)).toBe(false)
    }
    expect([...NOTICE_ACK_METHODS]).toEqual(['in_app', 'recorded_by_dpo'])
    // A note is bounded as Postgres bounds it, in code points.
    const emoji = { ...recorded, note: SMILE.repeat(NOTICE_NOTE_MAX) }
    expect(NoticeResponse.safeParse({ ...answer, mine: [emoji] }).success).toBe(true)
    // A recorded acknowledgement from before 0011 has neither (fixtures and upgrade data only).
    const older = { ...recorded, acknowledgedOn: null, note: null }
    expect(NoticeResponse.safeParse({ ...answer, mine: [older] }).success).toBe(true)
  })

  it('OD-01 PD-44 PD-69: unpublished exactly when no version is published, and then no contact', () => {
    const unpublished = { ...answer, standing: 'unpublished', current: null, contact: null, changes: null }
    expect(NoticeResponse.safeParse(unpublished).success).toBe(true)
    expect(NoticeResponse.safeParse({ ...unpublished, contact: CONTACT }).success).toBe(false)
    expect(NoticeResponse.safeParse({ ...answer, standing: 'unpublished' }).success).toBe(false)
    for (const standing of ['acknowledged', 'required']) {
      expect(NoticeResponse.safeParse({ ...answer, standing, current: null }).success, standing).toBe(false)
    }
  })

  it('PD-33: a body is bounded at 100,000 characters as Postgres counts them', () => {
    const at100k = { ...answer, current: { ...current, body: '🙂'.repeat(NOTICE_BODY_MAX) } }
    expect(NoticeResponse.safeParse(at100k).success).toBe(true)
    const over = { ...answer, current: { ...current, body: 'a'.repeat(NOTICE_BODY_MAX + 1) } }
    expect(NoticeResponse.safeParse(over).success).toBe(false)
  })

  it('P6 PD-46: the web app reads a standing it can’t read as required, and leaves out what it can’t read', () => {
    const read = NoticeResponseForClient.parse({
      ...answer,
      standing: 'Acknowledged',
      later: true,
      changes: {
        ...changes,
        purposes: { added: ['security_audit', 'org_brain', 'acounts', 7], changed: 'accounts', removed: [] },
      },
      mine: [recorded, { version: 'one' }, 'not a row', inApp],
    })
    expect(read.standing).toBe('required')
    expect(read.changes?.purposes).toEqual({ added: ['security_audit'], changed: [], removed: [] })
    expect(read.changes?.contact).toBe('added')
    expect(read.mine).toEqual(answer.mine)
    expect(read.contact).toEqual(CONTACT)
    expect(Object.keys(read)).toEqual(['person', 'standing', 'current', 'contact', 'changes', 'mine'])
    for (const standing of ['acknowledged', 'required', 'unpublished']) {
      expect(NoticeResponseForClient.parse({ ...answer, standing }).standing, standing).toBe(standing)
    }
    // Unreadable changes or acknowledgements show as none; no readable person or version fails.
    expect(NoticeResponseForClient.parse({ ...answer, changes: 'all', mine: null })).toMatchObject({
      changes: null,
      mine: [],
    })
    expect(NoticeResponseForClient.safeParse({ ...answer, person: '' }).success).toBe(false)
    expect(NoticeResponseForClient.safeParse({ ...answer, current: { ...current, body: 7 } }).success).toBe(false)
  })

  it('P6 PD-67 PD-69 PD-75: the web app reads a contact it can’t read as unreadable, never as none, and a change marker, day or note it can’t read as nothing', () => {
    const read = (change: object) => NoticeResponseForClient.parse({ ...answer, ...change })
    expect(read({ contact: null }).contact).toBeNull()
    expect(read({ contact: { ...CONTACT, later: 1 } }).contact).toEqual(CONTACT)
    for (const contact of [{ ...CONTACT, email: 'dpo@notice.example?cc=x' }, { ...CONTACT, title: 7 }, 'none']) {
      expect(read({ contact }).contact, JSON.stringify(contact)).toBeUndefined()
    }
    const { contact: _contact, ...older } = answer
    expect(NoticeResponseForClient.parse(older).contact).toBeUndefined()
    expect(read({ changes: { ...changes, contact: 'removed' } }).changes?.contact).toBe('same')
    const { contact: _marker, ...unmarked } = changes
    expect(read({ changes: unmarked }).changes?.contact).toBe('same')
    expect(read({ mine: [{ ...recorded, acknowledgedOn: 'yesterday', note: 7 }] }).mine).toEqual([
      { ...recorded, acknowledgedOn: null, note: null },
    ])
    expect(read({ mine: [{ version: 0, acknowledgedAt: at, method: 'in_app' }] }).mine).toEqual([inApp])
  })

  it('PD-42: acknowledging names only the version read; the person and device are the session’s, never the body’s', () => {
    expect(AcknowledgeBody.parse({ notice })).toEqual({ notice })
    for (const bad of [
      {},
      { notice: notice.toUpperCase() },
      { notice: 'v1' },
      { notice, person },
      { notice, device: person },
      { notice, version: 1 },
    ]) {
      expect(AcknowledgeBody.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
    expect(AcknowledgeResponse.parse({ version: 1, changed: false })).toEqual({ version: 1, changed: false })
    expect(AcknowledgeResponse.safeParse({ version: 1, changed: true, at }).success).toBe(false)
    expect(AcknowledgeResponseForClient.parse({ version: 1, changed: true, at })).toEqual({ version: 1, changed: true })
  })
})

const latest = {
  id: notice,
  version: 1,
  publishedAt: at,
  publishedBy: 'Ashton Tan',
  generated: true,
  acknowledged: 3,
  people: 12,
}
const draft = {
  version: 2,
  body: '## About this notice\n\nThe words.',
  digest,
  problems: [{ code: 'provider_not_cleared', purpose: 'accounts', provider: 'twilio' }],
  warnings: [{ code: 'sends_waiting', provider: 'twilio' }, { code: 'production_access_pending' }],
  changes,
  upToDate: false,
}
const history = [
  { id: notice, version: 1, publishedAt: at, publishedBy: 'Ashton Tan', generated: true },
  { id: 'e0000000-0000-4000-8000-000000000001', version: 0, publishedAt: at, publishedBy: null, generated: false },
]
const admin = { today: '2026-10-23', latest, draft, history }

describe('C0.9 PD-36 PD-37 PD-48: GET /api/admin/notice and POST /api/admin/notice/publish', () => {
  it('PD-48: the answer is today, the latest version with counts and never names, the draft and the history, and nothing more', () => {
    expect(NoticeAdminResponse.parse(admin)).toEqual(admin)
    expect(NoticeAdminResponse.parse({ ...admin, latest: null, history: [] }).latest).toBeNull()
    const free = { code: 'free_text_ai_copy', provider: 'twilio', field: 'onward_recipients' }
    expect(
      NoticeAdminResponse.safeParse({ ...admin, draft: { ...draft, body: null, digest: null, problems: [free] } })
        .success,
    ).toBe(true)
    // PD-65 PD-68 PD-86: the contact's problems, and a purpose on deemed consent by conduct.
    const contactProblems = [
      { code: 'purpose_conduct_unstoppable', purpose: 'presence_receipts' },
      { code: 'dpo_contact_pending' },
      { code: 'free_text_ai_copy', field: 'contact_title' },
    ]
    expect(
      NoticeAdminResponse.safeParse({
        ...admin,
        draft: { ...draft, body: null, digest: null, problems: contactProblems },
      }).success,
    ).toBe(true)
    for (const bad of [
      { ...admin, extra: 1 },
      { ...admin, today: '23/10/2026' },
      { ...admin, latest: { ...latest, acknowledged: 13 } },
      { ...admin, latest: { ...latest, outstanding: ['Nadia'] } },
      { ...admin, latest: { ...latest, publishedBy: '' } },
      { ...admin, draft: { ...draft, digest: null } },
      { ...admin, draft: { ...draft, body: null } },
      { ...admin, draft: { ...draft, digest: 'A'.repeat(64) } },
      { ...admin, draft: { ...draft, problems: [{ code: 'too_long' }] } },
      { ...admin, draft: { ...draft, problems: [{ code: 'purpose_basis_missing', purpose: 'org_brain' }] } },
      { ...admin, draft: { ...draft, problems: [{ ...free, text: 'agents' }] } },
      { ...admin, draft: { ...draft, warnings: [{ code: 'sends_waiting', provider: 'bedrock' }] } },
      { ...admin, draft: { ...draft, warnings: [{ code: 'dpo_contact_pending' }] } },
      { ...admin, draft: { ...draft, problems: [{ code: 'free_text_ai_copy', field: 'contact_phone' }] } },
      { ...admin, history: Array.from({ length: NOTICE_HISTORY_MAX + 1 }, () => history[0]) },
    ]) {
      expect(NoticeAdminResponse.safeParse(bad).success, JSON.stringify(bad).slice(0, 160)).toBe(false)
    }
  })

  it('P6 PD-48: the web app leaves out a problem, warning or history row it can’t read, and shows a name it can’t read as nobody’s', () => {
    const read = NoticeAdminResponseForClient.parse({
      ...admin,
      later: 1,
      latest: { ...latest, publishedBy: 7 },
      draft: {
        ...draft,
        problems: [...draft.problems, { code: 'too_long' }, 'not a problem'],
        warnings: [...draft.warnings, { code: 'sends_waiting', provider: 'openai' }],
        changes: 'everything',
      },
      history: [...history, { version: 'zero' }],
    })
    expect(read.latest?.publishedBy).toBeNull()
    expect(read.draft.problems).toEqual(draft.problems)
    expect(read.draft.warnings).toEqual(draft.warnings)
    expect(read.draft.changes).toBeNull()
    expect(read.history).toEqual(history)
    expect(Object.keys(read)).toEqual(['today', 'latest', 'draft', 'history'])
    expect(NoticeAdminResponseForClient.safeParse({ ...admin, today: undefined }).success).toBe(false)
  })

  it('PD-36: publishing names the version the page showed (none before the first) and the digest of the draft it previewed', () => {
    for (const seen of [null, 0, 7]) expect(PublishBody.parse({ seen, digest }), String(seen)).toEqual({ seen, digest })
    for (const bad of [
      { digest },
      { seen: null },
      { seen: -1, digest },
      { seen: 1.5, digest },
      { seen: 1, digest: 'a'.repeat(63) },
      { seen: 1, digest: 'g'.repeat(64) },
      { seen: 1, digest, body: 'The words' },
      { seen: 1, digest, purposes: ['accounts'] },
    ]) {
      expect(PublishBody.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
    expect(PublishResponse.parse({ notice, version: 2 })).toEqual({ notice, version: 2 })
    expect(PublishResponse.safeParse({ notice, version: 2, body: 'The words' }).success).toBe(false)
    expect(PublishResponseForClient.parse({ notice, version: 2 })).toEqual({ version: 2 })
  })
})

describe('C0.9 OD-19 PD-75 PD-76: the acknowledgements the DPO records', () => {
  const people = {
    today: '2026-10-23',
    latest: { notice, version: 1, publishedOn: '2026-10-20' },
    people: [
      {
        id: 'b0000000-0000-4000-8000-000000000007',
        name: 'Rachel Goh',
        department: 'Sales',
        manager: 'Ahmad Rahman',
        addedOn: '2026-10-01',
      },
      { id: person, name: 'Nadia Yusof', department: null, manager: null, addedOn: '2026-10-02' },
    ],
    more: false,
  }

  it('PD-76: the people list is today, the latest version and every active person by name, department, manager and the day added, and nothing more', () => {
    expect(NoticePeopleResponse.parse(people)).toEqual(people)
    expect(NOTICE_PEOPLE_MAX).toBe(2000)
    const [row] = people.people
    if (row === undefined) throw new Error('the fixture lists people')
    // departments.name holds 1 to 100 characters, counted in code points (0002).
    const department = (name: string) => ({ ...people, people: [{ ...row, department: name }] })
    expect(NoticePeopleResponse.safeParse(department(SMILE.repeat(100))).success).toBe(true)
    expect(NoticePeopleResponse.safeParse(department(SMILE.repeat(101))).success).toBe(false)
    for (const bad of [
      { ...people, extra: 1 },
      { ...people, latest: null },
      { ...people, latest: { ...people.latest, publishedOn: '20 Oct 2026' } },
      { ...people, more: undefined },
      { ...people, people: [{ ...row, phone: '+6580000107' }] },
      { ...people, people: [{ ...row, acknowledged: true }] },
      { ...people, people: [{ ...row, id: row.id.toUpperCase() }] },
      { ...people, people: [{ ...row, name: '' }] },
      { ...people, people: [{ ...row, department: '' }] },
      { ...people, people: [{ ...row, addedOn: null }] },
      { ...people, people: Array.from({ length: NOTICE_PEOPLE_MAX + 1 }, () => row) },
    ]) {
      expect(NoticePeopleResponse.safeParse(bad).success, JSON.stringify(bad).slice(0, 120)).toBe(false)
    }
  })

  it('P6 PD-76: the web app leaves out a person it can’t read or post back, shows a department or manager it can’t read as none, and reads an unreadable more as false', () => {
    const read = NoticePeopleResponseForClient.parse({
      ...people,
      later: 1,
      people: [
        { ...people.people[0], department: 7, manager: '' },
        { ...people.people[1], id: 'not-an-id' },
        { name: 'Nobody' },
      ],
      more: 'yes',
    })
    expect(read.people).toEqual([{ ...people.people[0], department: null, manager: null }])
    expect(read.more).toBe(false)
    expect(Object.keys(read)).toEqual(['today', 'latest', 'people', 'more'])
    for (const bad of [
      { ...people, people: 'all' },
      { ...people, latest: null },
      { ...people, today: undefined },
    ]) {
      expect(NoticePeopleResponseForClient.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false)
    }
  })

  it('PD-75: recording names whose, which version, the day and how; the DPO and the device are the session’s', () => {
    const body = { person, notice, acknowledgedOn: '2026-10-21', note: 'Signed a printed copy at induction' }
    expect(RecordAcknowledgementBody.parse(body)).toEqual(body)
    // A long note parses, so the dialog words it, up to a bound no note reaches.
    expect(RecordAcknowledgementBody.safeParse({ ...body, note: 'x'.repeat(2000) }).success).toBe(true)
    for (const bad of [
      { ...body, person: person.toUpperCase() },
      { ...body, notice: 'v1' },
      { ...body, acknowledgedOn: '2026-02-30' },
      { ...body, acknowledgedOn: null },
      { ...body, note: 'x'.repeat(2001) },
      { ...body, note: undefined },
      { ...body, device: person },
      { ...body, recordedBy: person },
      { ...body, method: 'in_app' },
    ]) {
      expect(RecordAcknowledgementBody.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false)
    }
  })

  it('PD-75: recordProblems() finds each problem, in RECORD_PROBLEMS order, against the answer’s days', () => {
    const range = { from: '2026-10-20', to: '2026-10-23' }
    const form = { person, acknowledgedOn: '2026-10-21', note: 'Signed a printed copy at induction' }
    expect(recordProblems(form, range)).toEqual([])
    for (const day of [range.from, range.to])
      expect(recordProblems({ ...form, acknowledgedOn: day }, range)).toEqual([])
    const cases: [object, string[]][] = [
      [{ person: null }, ['person_missing']],
      [{ person: '' }, ['person_missing']],
      [{ acknowledgedOn: null }, ['day_missing']],
      [{ acknowledgedOn: '' }, ['day_missing']],
      [{ acknowledgedOn: '2026-02-30' }, ['day_missing']],
      [{ acknowledgedOn: '2026-10-19' }, ['day_out_of_range']],
      [{ acknowledgedOn: '2026-10-24' }, ['day_out_of_range']],
      [{ note: '  ' }, ['note_missing']],
      [{ note: 'x'.repeat(NOTICE_NOTE_MAX + 1) }, ['note_long']],
      [{ note: 'On paper\nat induction' }, ['note_not_one_line']],
      [{ note: `On paper${String.fromCodePoint(0x85)}` }, ['note_not_one_line']],
      [{ note: 'Asked at induction' }, ['ai_copy']],
    ]
    for (const [change, problems] of cases) {
      expect(recordProblems({ ...form, ...change }, range), JSON.stringify(change)).toEqual(problems)
    }
    // Counted in code points, and trimmed first, as record_notice_acknowledgement() reads it.
    expect(recordProblems({ ...form, note: SMILE.repeat(NOTICE_NOTE_MAX) }, range)).toEqual([])
    expect(recordProblems({ ...form, note: `  On paper \n` }, range)).toEqual([])
    expect(recordProblems({ person: null, acknowledgedOn: '2027-01-01', note: 'Ask\nme' }, range)).toEqual([
      'person_missing',
      'day_out_of_range',
      'note_not_one_line',
      'ai_copy',
    ])
    expect([...RECORD_PROBLEMS]).toEqual([
      'person_missing',
      'day_missing',
      'day_out_of_range',
      'note_missing',
      'note_long',
      'note_not_one_line',
      'ai_copy',
    ])
  })
})
