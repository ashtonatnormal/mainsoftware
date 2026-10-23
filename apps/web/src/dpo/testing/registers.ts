// The registers' answer for the DPO pages' tests (Vitest only; nothing in the app imports this
// folder): GET /api/admin/registers as the server would send it for an org on its first day, before
// any notice is published, a purpose or provider changed where a case needs it, read with the web
// app's lenient schema; and GET /api/admin/notice's for the Notice tab (C0.9 PD-48). Every fact is
// made up.
import {
  NON_AI_PROVIDERS,
  type NoticeAdminForClient,
  type NoticeAdminJSON,
  NoticeAdminResponse,
  NoticeAdminResponseForClient,
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
// generator's.
export const DRAFT_BODY = [
  '## About this notice',
  'This notice says how Tembusu Logistics uses your personal data in Hearth.',
  '## Why your data is processed',
  '### Accounts and sign-in',
  '- Legal basis: the employment exception.',
  '- Kept for: while you work here, then 30 days.',
].join('\n\n')

// The answer as the server would send it: version 0 published by Ashton and acknowledged by 9 of
// 12, a draft of version 1 that is ready to publish, and the history of one version.
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
      warnings: [{ code: 'dpo_contact_pending' }],
      changes: {
        since: 0,
        purposes: { added: ['backups'], changed: ['accounts'], removed: [] },
        providers: { added: [], changed: [], removed: ['aws'] },
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
