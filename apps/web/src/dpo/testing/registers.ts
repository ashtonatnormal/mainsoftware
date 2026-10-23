// The registers' answer for the DPO pages' tests (Vitest only; nothing in the app imports this
// folder): GET /api/admin/registers as the server would send it for an org on its first day, before
// any notice is published, a purpose or provider changed where a case needs it, read with the web
// app's lenient schema; GET /api/admin/notice's for the Notice tab (C0.9 PD-48); and from C0.9 PR 3a
// GET /api/admin/notice/contact's for the contact page (PD-70) and GET /api/admin/notice/people's
// for the record dialog (PD-76). Every fact is made up, and every address is on a reserved domain.
import {
  type ContactAdminForClient,
  type ContactAdminJSON,
  ContactAdminResponse,
  ContactAdminResponseForClient,
  type ContactRowJSON,
  NON_AI_PROVIDERS,
  type NoticeAdminForClient,
  type NoticeAdminJSON,
  NoticeAdminResponse,
  NoticeAdminResponseForClient,
  type NoticePeopleForClient,
  type NoticePeopleJSON,
  NoticePeopleResponse,
  NoticePeopleResponseForClient,
  type NoticeStatus,
  type ProviderKey,
  PURPOSES,
  type PurposeKey,
  type PurposeRowJSON,
  type RegistersForClient,
  type RegistersJSON,
  RegistersResponse,
  RegistersResponseForClient,
  type TransferRowJSON,
} from '@hearth/shared'

export const TODAY = '2026-10-22'

// Hearth's version 1 of a purpose, as a new org starts (C0.9 PD-06): the pinned two and
// security_audit and backups active, every other planned, nothing recorded.
export function purposeRow(purpose: PurposeKey, change: Partial<PurposeRowJSON> = {}): PurposeRowJSON {
  const pinned = purpose === 'accounts' || purpose === 'service_operation'
  const active = pinned || purpose === 'security_audit' || purpose === 'backups'
  return {
    purpose,
    version: 1,
    status: active ? 'active' : 'planned',
    basis: null,
    basisReference: null,
    optOutDays: null,
    retention: null,
    providers: [],
    pinned,
    needsSwitch: PURPOSES[purpose].needsSwitch,
    recordedOn: '2026-10-01',
    recordedBy: null,
    // No notice lists anything yet (C0.9 PD-40, PD-61).
    notified: false,
    stale: false,
    ...change,
  }
}

// A provider's starting row: no facts, never cleared.
export function transferRow(provider: ProviderKey, change: Partial<TransferRowJSON> = {}): TransferRowJSON {
  return {
    provider,
    revision: 1,
    services: null,
    dataTypes: null,
    processingCountries: [],
    storageCountries: [],
    countriesConfirmed: null,
    safeguard: null,
    safeguardReference: null,
    certificateVerifiedOn: null,
    dpaTermsConfirmed: false,
    training: null,
    zeroRetention: null,
    providerRetention: null,
    retentionConfirmed: null,
    onwardRecipients: null,
    reviewOn: null,
    updatedOn: '2026-10-01',
    updatedBy: null,
    sendsWait: false,
    clearance: null,
    ...change,
  }
}

// Every fact PDPA-10 needs before clearing, made up.
export const COMPLETE_FACTS = {
  services: 'Texting sign-in codes',
  dataTypes: 'Mobile number, channel, service identifier',
  processingCountries: ['US'],
  storageCountries: ['IE', 'US'],
  countriesConfirmed: 'Data processing agreement, 1 Oct 2026',
  safeguard: 'dpa',
  safeguardReference: 'Data processing agreement v5',
  certificateVerifiedOn: null,
  dpaTermsConfirmed: true,
  training: 'not_applicable',
  zeroRetention: 'not_offered',
  providerRetention: '90 days',
  retentionConfirmed: 'Support reply, 2 Oct 2026',
  onwardRecipients: 'Mobile carriers',
  reviewOn: '2027-10-01',
} as const satisfies Partial<TransferRowJSON>

// The whole answer: every purpose and provider outside the AI layer, in the registries' order, and
// whether the published notice says what they say (none published, unless a case says otherwise).
export function registersAnswer(
  purposes: Partial<Record<PurposeKey, Partial<PurposeRowJSON>>> = {},
  transfers: Partial<Record<ProviderKey, Partial<TransferRowJSON>>> = {},
  notice: NoticeStatus = 'none',
): RegistersJSON {
  const keys = (Object.keys(PURPOSES) as PurposeKey[]).filter(key => !PURPOSES[key].ai)
  return RegistersResponse.parse({
    today: TODAY,
    purposes: keys.map(key => purposeRow(key, purposes[key])),
    transfers: NON_AI_PROVIDERS.map(provider => transferRow(provider, transfers[provider])),
    notice,
  })
}

// The same, as the page reads it.
export const registersForClient = (...args: Parameters<typeof registersAnswer>): RegistersForClient =>
  RegistersResponseForClient.parse(registersAnswer(...args))

// --- The Notice tab (GET /api/admin/notice, C0.9 PD-48) ------------------------------------------

export const NOTICE_ID = 'e0000000-0000-4000-8000-000000000001'
export const NEXT_ID = 'e0000000-0000-4000-8000-000000000002'
export const DIGEST = 'ab'.repeat(32)

// A draft's words, in the body's line format (packages/shared NOTICE_LINE); made up, not the
// generator's, but giving the DPO's contact under "Your rights" as c09.2 does (C0.9 PD-74).
export const DRAFT_BODY = [
  '## About this notice',
  'This notice says how Tembusu Logistics uses your personal data in Hearth.',
  '## Why your data is processed',
  '### Accounts and sign-in',
  '- Legal basis: the employment exception.',
  '- Kept for: while you work here, then 30 days.',
  '## Your rights',
  'To do any of these, contact the Data Protection Officer of Tembusu Logistics.',
  '- Role: Data Protection Officer\n- Email: dpo@tembusu.example',
].join('\n\n')

// The answer as the server would send it: version 0 published by Ashton and acknowledged by 9 of
// 12, a draft of version 1 that is ready to publish (the DPO's contact recorded, so the only
// standing warning is the production-access paragraph's, C0.9 PD-68), and the history of one
// version.
export function noticeAdminAnswer(change: Partial<NoticeAdminJSON> = {}): NoticeAdminJSON {
  const latest = {
    id: NOTICE_ID,
    version: 0,
    publishedAt: '2026-10-21T02:00:00.000Z',
    publishedBy: 'Ashton Teo',
    generated: true,
  }
  return NoticeAdminResponse.parse({
    today: TODAY,
    latest: { ...latest, acknowledged: 9, people: 12 },
    draft: {
      version: 1,
      body: DRAFT_BODY,
      digest: DIGEST,
      problems: [],
      warnings: [{ code: 'production_access_pending' }],
      changes: {
        since: 0,
        purposes: { added: ['backups'], changed: ['accounts'], removed: [] },
        providers: { added: [], changed: [], removed: ['aws'] },
        contact: 'same',
        wording: false,
      },
      upToDate: false,
    },
    history: [latest],
    ...change,
  })
}

// The same, as the page reads it.
export const noticeAdminForClient = (...args: Parameters<typeof noticeAdminAnswer>): NoticeAdminForClient =>
  NoticeAdminResponseForClient.parse(noticeAdminAnswer(...args))

// A draft with no contact recorded (C0.9 OD-10, PD-68): unwritable, so no words and no digest.
export const NO_CONTACT_DRAFT = {
  version: 1,
  body: null,
  digest: null,
  problems: [{ code: 'dpo_contact_pending' }],
  warnings: [{ code: 'production_access_pending' }],
  changes: null,
  upToDate: false,
} as const satisfies NoticeAdminJSON['draft']

// --- The contact page (GET /api/admin/notice/contact, C0.9 PD-70) --------------------------------

// The DPO's contact as Ashton recorded it, version 1.
export function contactRow(change: Partial<ContactRowJSON> = {}): ContactRowJSON {
  return {
    version: 1,
    title: 'Data Protection Officer',
    email: 'dpo@tembusu.example',
    phone: null,
    postal: '1 Example Road\nSingapore 000000',
    recordedOn: '2026-10-20',
    recordedBy: 'Ashton Teo',
    ...change,
  }
}

// The answer: none published and no contact, unless a case says otherwise.
export function contactAdminAnswer(change: Partial<ContactAdminJSON> = {}): ContactAdminJSON {
  return ContactAdminResponse.parse({ notice: 'none', contact: null, stated: 'unpublished', ...change })
}

// The same, as the page reads it.
export const contactAdminForClient = (...args: Parameters<typeof contactAdminAnswer>): ContactAdminForClient =>
  ContactAdminResponseForClient.parse(contactAdminAnswer(...args))

// --- The record dialog (GET /api/admin/notice/people, C0.9 OD-19, PD-76) -------------------------

// The seed's people as the DPO's list names them (db/seed/tembusu.sql's roster, made up), Ashton
// left out, in name order.
export const PEOPLE = [
  { id: 'b0000000-0000-4000-8000-000000000006', name: 'Ahmad Rahman', department: 'Commercial', manager: 'Ashton Teo' },
  { id: 'b0000000-0000-4000-8000-000000000011', name: 'Kelvin Tan', department: null, manager: null },
  { id: 'b0000000-0000-4000-8000-000000000003', name: 'Marcus Ong', department: 'Operations', manager: 'Priya Nair' },
  { id: 'b0000000-0000-4000-8000-000000000002', name: 'Priya Nair', department: 'Operations', manager: 'Ashton Teo' },
  { id: 'b0000000-0000-4000-8000-000000000007', name: 'Rachel Goh', department: 'Commercial', manager: 'Ahmad Rahman' },
].map(person => ({ ...person, addedOn: '2026-10-01' }))

// The answer: version 0, published on 21 Oct, read on TODAY.
export function noticePeopleAnswer(change: Partial<NoticePeopleJSON> = {}): NoticePeopleJSON {
  return NoticePeopleResponse.parse({
    today: TODAY,
    latest: { notice: NOTICE_ID, version: 0, publishedOn: '2026-10-21' },
    people: PEOPLE,
    more: false,
    ...change,
  })
}

// The same, as the dialog reads it.
export const noticePeopleForClient = (...args: Parameters<typeof noticePeopleAnswer>): NoticePeopleForClient =>
  NoticePeopleResponseForClient.parse(noticePeopleAnswer(...args))
