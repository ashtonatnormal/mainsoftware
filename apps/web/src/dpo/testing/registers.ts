// The registers' answer for the DPO pages' tests (Vitest only; nothing in the app imports this
// folder): GET /api/admin/registers as the server would send it for an org on its first day, a
// purpose or provider changed where a case needs it, read with the web app's lenient schema. Every
// fact is made up.
import {
  NON_AI_PROVIDERS,
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

// The whole answer: every purpose and provider outside the AI layer, in the registries' order.
export function registersAnswer(
  purposes: Partial<Record<PurposeKey, Partial<PurposeRowJSON>>> = {},
  transfers: Partial<Record<ProviderKey, Partial<TransferRowJSON>>> = {},
): RegistersJSON {
  const keys = (Object.keys(PURPOSES) as PurposeKey[]).filter(key => !PURPOSES[key].ai)
  return RegistersResponse.parse({
    today: TODAY,
    purposes: keys.map(key => purposeRow(key, purposes[key])),
    transfers: NON_AI_PROVIDERS.map(provider => transferRow(provider, transfers[provider])),
  })
}

// The same, as the page reads it.
export const registersForClient = (...args: Parameters<typeof registersAnswer>): RegistersForClient =>
  RegistersResponseForClient.parse(registersAnswer(...args))
