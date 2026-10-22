// The processing register (PDPA-01) and the transfer register (PDPA-10), as the api and the DPO
// pages share them (C0.9, TECH-SPEC T22): their vocabulary; the rules migration 0009 enforces on
// every write, mirrored here so the page can say what an entry still needs and the route can answer
// 400 before the database refuses, as cohortProblem mirrors the flags' check (flags.ts); and the
// bodies and answers of /api/admin/registers. The database stays the one that decides: a rule here
// that drifts from 0009's lets a refusal through as HF006 (400 register_invalid), never a write.
// The problems and warnings are codes; the page words each (apps/web's strings), never this file.
//
// The server loads this file on Node (T2), and the package compiles with lib ES2024 and no DOM or
// Node types.
import { z } from 'zod'
import { isPinnedPurpose } from './flags.ts'
import { LowerUuid } from './ids.ts'
import {
  isAiProvider,
  isPurposeKey,
  PROVIDERS,
  type ProviderKey,
  PURPOSE_KEYS,
  PURPOSES,
  type PurposeKey,
} from './purposes.ts'
import { PersonName } from './web.ts'

// --- The processing register (PDPA-01) ---------------------------------------------------------

// A purpose's status: planned (recorded, not started), active (it runs) or retired (it no longer
// runs). Every version of an entry is kept, whatever its status (C0.9 PD-04).
export const PURPOSE_STATUSES = ['planned', 'active', 'retired'] as const
export type PurposeStatus = (typeof PURPOSE_STATUSES)[number]

// PDPA-01's seven legal bases, as 0009's processing_register allows them:
//   employment                   the exception for managing the employment relationship
//   legitimate_interests         legitimate interests, with where its assessment is kept
//   business_improvement         business improvement: using data only, never collecting or
//                                disclosing it
//   consent                      consent, which a person may withdraw at any time (PDPA-04)
//   deemed_consent_conduct       deemed consent by conduct or contractual necessity
//   deemed_consent_notification  deemed consent by notification (s15A), with where its assessment
//                                is kept and an opt-out window of 1 to 365 days
//   other_exception              another exception or legal requirement, with the provision cited
export const BASES = [
  'employment',
  'legitimate_interests',
  'business_improvement',
  'consent',
  'deemed_consent_conduct',
  'deemed_consent_notification',
  'other_exception',
] as const
export type Basis = (typeof BASES)[number]

// The consent-type bases, each of which a person may withdraw: a pinned purpose never rests on one,
// and a processing restriction (PDPA-04a) is recorded only against a purpose resting on one.
export const CONSENT_BASES = [
  'consent',
  'deemed_consent_conduct',
  'deemed_consent_notification',
] as const satisfies readonly Basis[]

export function isConsentBasis(basis: string): boolean {
  return (CONSENT_BASES as readonly string[]).includes(basis)
}

// The bases a purpose that needs a per-person switch (PurposeSpec.needsSwitch) can't rest on until
// the switches exist (PDPA-04, C0.9 PD-11): every consent-type basis, deemed consent by conduct
// included, since withdrawing that too would need the switch. 0009's processing_register_switch
// refuses the same three, and C2.11's migration lifts all three together.
export const SWITCH_BASES: readonly Basis[] = CONSENT_BASES

// What each basis takes beside it (0009's processing_register_attachment): a reference (where the
// assessment is kept, or the provision relied on) and, for s15A, an opt-out window. A basis that
// doesn't take one must have none, and so must an entry with no basis.
export const BASIS_NEEDS = {
  employment: { reference: false, optOutDays: false },
  legitimate_interests: { reference: true, optOutDays: false },
  business_improvement: { reference: false, optOutDays: false },
  consent: { reference: false, optOutDays: false },
  deemed_consent_conduct: { reference: false, optOutDays: false },
  deemed_consent_notification: { reference: true, optOutDays: true },
  other_exception: { reference: true, optOutDays: false },
} as const satisfies Record<Basis, { reference: boolean; optOutDays: boolean }>

export const OPT_OUT_DAYS_MIN = 1
export const OPT_OUT_DAYS_MAX = 365

// What a new org's register starts with active (C0.9 PD-06, TECH-SPEC T22 item 4), with no basis
// recorded, since version 1 is Hearth's and never the DPO's. First the pinned purposes, which
// Hearth runs on. Then security_audit and backups, because Hearth already processes for both (the
// audit log from C0.3, and the backups every database has), so the register must not call either
// planned. Those two aren't pinned: the purpose gate passes them only once a published notice lists
// them (PR 2), and publishing refuses while an active purpose lacks a basis or retention. Every
// other purpose starts planned. processing_register_defaults() starts exactly these active
// (apps/server/scripts/check-catalogues.ts, check 6). In PURPOSES order.
export const ACTIVE_FROM_START: readonly PurposeKey[] = PURPOSE_KEYS.filter(
  key => isPinnedPurpose(key) || key === 'security_audit' || key === 'backups',
)

// What the DPO pages show and the registers' answer holds until A0 (C0.9 PD-27): the purposes and
// providers outside the AI layer, in their registries' order. The AI rows stay in the database,
// planned and not cleared.
export const NON_AI_PURPOSE_KEYS: readonly PurposeKey[] = PURPOSE_KEYS.filter(key => !PURPOSES[key].ai)
export const NON_AI_PROVIDERS: readonly ProviderKey[] = PROVIDERS.filter(key => !isAiProvider(key))

// What the recording policy keeps of every session, with no participant opt-out (REC-02, REC-04,
// D11). PDPA-01 warns when one of these rests on a consent-type basis: one withdrawal would stop it
// for that person.
export const NO_OPT_OUT_PURPOSES = [
  'recording_meetings',
  'recording_drop_in',
  'session_slides',
  'transcription',
  'meeting_notes',
] as const satisfies readonly PurposeKey[]

// A purpose's entry as the DPO records it: one version of processing_register.
export interface PurposeEntry {
  status: PurposeStatus
  basis: Basis | null
  basisReference: string | null
  optOutDays: number | null
  retention: string | null
  providers: readonly string[]
}

// Why an entry can't be saved, in this order. set_register_purpose() in 0009 refuses each: an
// unknown key as 22023 (404 not_found), the rest as HF006 (400 register_invalid).
//   unknown_purpose    the key isn't a PURPOSES key
//   ai_purpose         an AI purpose, which stays planned with nothing recorded until A0 (D41)
//   pinned_inactive    a pinned purpose that isn't active (C0.9 PD-07)
//   pinned_consent     a pinned purpose on a consent-type basis
//   needs_switch       a purpose that needs a per-person switch, on a consent-type basis (PD-11)
//   basis_missing      active or retired, with no basis
//   retention_missing  active or retired, with no retention
//   reference_missing  the basis takes a reference, and there is none
//   reference_extra    a reference the basis doesn't take
//   opt_out_missing    s15A with no opt-out window
//   opt_out_extra      an opt-out window for another basis
//   opt_out_range      a window outside 1 to 365 days
//   provider_unknown   a provider that isn't a PROVIDERS key
//   provider_ai        an AI provider, which receives nothing until A0
// A basis can't leave the consent types while restrictions are recorded against the purpose
// either; no restriction has a writer until C2.11, so only the database checks that.
export const PURPOSE_PROBLEMS = [
  'unknown_purpose',
  'ai_purpose',
  'pinned_inactive',
  'pinned_consent',
  'needs_switch',
  'basis_missing',
  'retention_missing',
  'reference_missing',
  'reference_extra',
  'opt_out_missing',
  'opt_out_extra',
  'opt_out_range',
  'provider_unknown',
  'provider_ai',
] as const
export type PurposeProblem = (typeof PURPOSE_PROBLEMS)[number]

// Text counts as recorded once it holds more than spaces, as the table stores it trimmed.
const recorded = (text: string | null): text is string => text !== null && text.trim() !== ''

const NEEDS_NOTHING = { reference: false, optOutDays: false } as const

export function purposeProblems(key: string, entry: PurposeEntry): PurposeProblem[] {
  if (!isPurposeKey(key)) return ['unknown_purpose']
  if (PURPOSES[key].ai) return ['ai_purpose']
  const found = new Set<PurposeProblem>()
  const consentType = entry.basis !== null && isConsentBasis(entry.basis)
  if (isPinnedPurpose(key)) {
    if (entry.status !== 'active') found.add('pinned_inactive')
    if (consentType) found.add('pinned_consent')
  }
  if (PURPOSES[key].needsSwitch && entry.basis !== null && SWITCH_BASES.includes(entry.basis)) found.add('needs_switch')
  if (entry.status !== 'planned') {
    if (entry.basis === null) found.add('basis_missing')
    if (!recorded(entry.retention)) found.add('retention_missing')
  }
  const needs = entry.basis === null ? NEEDS_NOTHING : BASIS_NEEDS[entry.basis]
  const reference = recorded(entry.basisReference)
  if (needs.reference && !reference) found.add('reference_missing')
  if (!needs.reference && reference) found.add('reference_extra')
  if (needs.optOutDays && entry.optOutDays === null) found.add('opt_out_missing')
  if (!needs.optOutDays && entry.optOutDays !== null) found.add('opt_out_extra')
  const days = entry.optOutDays
  if (days !== null && !(Number.isInteger(days) && days >= OPT_OUT_DAYS_MIN && days <= OPT_OUT_DAYS_MAX)) {
    found.add('opt_out_range')
  }
  for (const provider of entry.providers) {
    if (!(PROVIDERS as readonly string[]).includes(provider)) found.add('provider_unknown')
    else if (isAiProvider(provider)) found.add('provider_ai')
  }
  return PURPOSE_PROBLEMS.filter(problem => found.has(problem))
}

// PDPA-01's warnings, which show and never block (C0.9 PD-11, TECH-SPEC T22 item 2), in this order:
//   business_improvement  business improvement covers using data only, so the DPO checks the
//                         purpose collects and discloses nothing on it
//   no_opt_out_consent    a consent-type basis for what the recording policy keeps with no opt-out
//   withdrawal_by_hand    a consent-type basis: until per-person switches exist (PDPA-04a), a
//                         withdrawal is carried out by hand, under the DPO's written procedure
export const PURPOSE_WARNINGS = ['business_improvement', 'no_opt_out_consent', 'withdrawal_by_hand'] as const
export type PurposeWarning = (typeof PURPOSE_WARNINGS)[number]

export function purposeWarnings(key: string, entry: Pick<PurposeEntry, 'basis'>): PurposeWarning[] {
  if (!isPurposeKey(key) || PURPOSES[key].ai || entry.basis === null) return []
  const found = new Set<PurposeWarning>()
  if (entry.basis === 'business_improvement') found.add('business_improvement')
  if (isConsentBasis(entry.basis)) {
    if ((NO_OPT_OUT_PURPOSES as readonly string[]).includes(key)) found.add('no_opt_out_consent')
    found.add('withdrawal_by_hand')
  }
  return PURPOSE_WARNINGS.filter(warning => found.has(warning))
}

// The statuses and bases the page offers for a purpose: only what purposeProblems lets save. A
// pinned purpose stays active on a basis that isn't consent-type; one that needs a switch rests on
// no consent-type basis until C2.11; an AI purpose, or a key that isn't one, is offered nothing
// (it stays planned until A0).
export function statusesFor(key: string): readonly PurposeStatus[] {
  if (!isPurposeKey(key) || PURPOSES[key].ai) return []
  return isPinnedPurpose(key) ? ['active'] : PURPOSE_STATUSES
}

export function basesFor(key: string): readonly Basis[] {
  if (!isPurposeKey(key) || PURPOSES[key].ai) return []
  if (isPinnedPurpose(key)) return BASES.filter(basis => !isConsentBasis(basis))
  if (PURPOSES[key].needsSwitch) return BASES.filter(basis => !SWITCH_BASES.includes(basis))
  return BASES
}

// --- The transfer register (PDPA-10, D46) ------------------------------------------------------

// The transfer safeguard: the provider's data processing agreement, an addendum to it (the ASEAN
// Model Contractual Clauses, say), or a certification, which counts only once its certificate is
// verified (certificateVerifiedOn).
export const SAFEGUARDS = ['dpa', 'dpa_addendum', 'certification'] as const
export type Safeguard = (typeof SAFEGUARDS)[number]

// Training on the org's data: turned off, or not applicable (the provider trains no models on it).
export const TRAINING = ['off', 'not_applicable'] as const
export type Training = (typeof TRAINING)[number]

// The zero-retention application's result. pending is recorded but is no result, so an entry can't
// be cleared on it.
export const ZERO_RETENTION = ['granted', 'refused', 'not_offered', 'not_applicable', 'pending'] as const
export type ZeroRetention = (typeof ZERO_RETENTION)[number]

// How a clearance was made: by the DPO in the app, or by the first-Owner bootstrap, which clears
// Twilio Verify and AWS once, from facts given at run time (C0.9 OD-01, PD-23).
export const CLEARED_VIA = ['app', 'bootstrap'] as const
export type ClearedVia = (typeof CLEARED_VIA)[number]

// Why a clearance ended: the DPO withdrew it, or new facts were recorded (C0.9 PD-05).
export const WITHDRAW_REASONS = ['dpo_decision', 'facts_changed'] as const
export type WithdrawReason = (typeof WITHDRAW_REASONS)[number]

// What a provider's entry records (PDPA-10, D46; C0.9 PD-12). Countries are ISO 3166-1 alpha-2
// codes, and dates are YYYY-MM-DD.
export interface TransferFacts {
  services: string | null
  dataTypes: string | null
  processingCountries: readonly string[]
  storageCountries: readonly string[]
  // Where and when the provider confirmed the countries in writing.
  countriesConfirmed: string | null
  safeguard: Safeguard | null
  safeguardReference: string | null
  certificateVerifiedOn: string | null
  // The agreement binds PDPA-comparable protection, names the countries and requires prompt
  // incident notice.
  dpaTermsConfirmed: boolean
  training: Training | null
  zeroRetention: ZeroRetention | null
  providerRetention: string | null
  // Where and when the provider confirmed its retention in writing.
  retentionConfirmed: string | null
  // Who carries the data on (carriers, Google's RCS), or "None".
  onwardRecipients: string | null
  reviewOn: string | null
}

// What a provider's entry still needs before it can be cleared, in this order. From ai_provider
// on, it is the order transfer_clearances_check() in 0009 checks them in (HF006, naming the first);
// an unknown key has no entry to clear (22023, 404 not_found).
//   unknown_provider        the key isn't a PROVIDERS key
//   ai_provider             an AI provider, never cleared before A0 (D41)
//   services                ... and each fact below, not recorded
//   data_types
//   processing_countries
//   storage_countries
//   countries_confirmed
//   safeguard
//   safeguard_reference
//   certificate_unverified  a certification with no verification date (a table check too)
//   certificate_future      a verification date after today
//   dpa_terms               the agreement's terms not confirmed
//   training
//   zero_retention          no result recorded, or only pending
//   provider_retention
//   retention_confirmed
//   onward_recipients
//   review_on               no review date
//   review_due              a review date today or earlier
// "Today" is the org's, in its time zone, as the registers' answer gives it.
export const TRANSFER_PROBLEMS = [
  'unknown_provider',
  'ai_provider',
  'services',
  'data_types',
  'processing_countries',
  'storage_countries',
  'countries_confirmed',
  'safeguard',
  'safeguard_reference',
  'certificate_unverified',
  'certificate_future',
  'dpa_terms',
  'training',
  'zero_retention',
  'provider_retention',
  'retention_confirmed',
  'onward_recipients',
  'review_on',
  'review_due',
] as const
export type TransferProblem = (typeof TRANSFER_PROBLEMS)[number]

export function transferProblems(entry: { provider: string } & TransferFacts, today: string): TransferProblem[] {
  if (!(PROVIDERS as readonly string[]).includes(entry.provider)) return ['unknown_provider']
  if (isAiProvider(entry.provider)) return ['ai_provider']
  const found = new Set<TransferProblem>()
  if (!recorded(entry.services)) found.add('services')
  if (!recorded(entry.dataTypes)) found.add('data_types')
  if (entry.processingCountries.length === 0) found.add('processing_countries')
  if (entry.storageCountries.length === 0) found.add('storage_countries')
  if (!recorded(entry.countriesConfirmed)) found.add('countries_confirmed')
  if (entry.safeguard === null) found.add('safeguard')
  if (!recorded(entry.safeguardReference)) found.add('safeguard_reference')
  if (entry.safeguard === 'certification' && entry.certificateVerifiedOn === null) found.add('certificate_unverified')
  if (entry.certificateVerifiedOn !== null && entry.certificateVerifiedOn > today) found.add('certificate_future')
  if (!entry.dpaTermsConfirmed) found.add('dpa_terms')
  if (entry.training === null) found.add('training')
  if (entry.zeroRetention === null || entry.zeroRetention === 'pending') found.add('zero_retention')
  if (!recorded(entry.providerRetention)) found.add('provider_retention')
  if (!recorded(entry.retentionConfirmed)) found.add('retention_confirmed')
  if (!recorded(entry.onwardRecipients)) found.add('onward_recipients')
  if (entry.reviewOn === null) found.add('review_on')
  else if (entry.reviewOn <= today) found.add('review_due')
  return TRANSFER_PROBLEMS.filter(problem => found.has(problem))
}

// --- The api: bodies and answers (C0.9 PD-20, PD-21; apps/server/src/compliance/routes.ts) -------

// A day, YYYY-MM-DD. The answer gives days in the org's time zone, never times: when someone
// recorded or cleared something is shown as a day, as the devices list shows its dates
// (apps/server/src/admin/people.ts).
const Day = z.iso.date()

// Postgres bounds text in code points, where a JavaScript string's length counts UTF-16 units.
const codePoints = (text: string) => [...text].length

// Text the DPO types: trimmed, at most max UTF-16 units, so never longer than the table allows, and
// null when blank, as the table stores it.
function typed(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform(text => (text === '' ? null : text))
}

// The same text as the answer carries it: stored, so never blank, and bounded as Postgres bounds
// it.
function stored(max: number) {
  return z
    .string()
    .min(1)
    .refine(text => codePoints(text) <= max, { message: `at most ${max} characters` })
    .nullable()
}

// At most 60 codes each (0009's transfer_register_countries). The body takes either case and gives
// them upper case, once each and sorted, as record_transfer_entry() stores them.
const COUNTRIES_MAX = 60
const CountriesBody = z
  .array(z.string().regex(/^[A-Za-z]{2}$/))
  .max(COUNTRIES_MAX)
  .transform(codes => [...new Set(codes.map(code => code.toUpperCase()))].sort())
const Countries = z.array(z.string().regex(/^[A-Z]{2}$/)).max(COUNTRIES_MAX)

// The version an edit was made from (processing_register.version, an integer column).
const Version = z.int().min(1).max(2_147_483_647)
// The revision an edit was made from (transfer_register.revision); a safe integer.
const Revision = z.int().min(1)

// The providers an entry lists: at most 20 before the function sorts and dedupes them (0009).
const PROVIDERS_MAX = 20

// POST /api/admin/registers/purposes/set. AI keys and AI providers parse, so can() refuses the
// first (403) and the shared problems the second (400 register_invalid). An opt-out window of any
// whole number parses, so a window out of range is a problem the page explains, not a bad request.
export const SetPurposeBody = z.strictObject({
  purpose: z.enum(PURPOSE_KEYS),
  seen: Version,
  status: z.enum(PURPOSE_STATUSES),
  basis: z.enum(BASES).nullable(),
  basisReference: typed(1000),
  optOutDays: z.int().nullable(),
  retention: typed(1000),
  providers: z.array(z.enum(PROVIDERS)).max(PROVIDERS_MAX),
})
export type SetPurposeJSON = z.input<typeof SetPurposeBody>

const transferFactsBody = {
  services: typed(500),
  dataTypes: typed(1000),
  processingCountries: CountriesBody,
  storageCountries: CountriesBody,
  countriesConfirmed: typed(500),
  safeguard: z.enum(SAFEGUARDS).nullable(),
  safeguardReference: typed(500),
  certificateVerifiedOn: Day.nullable(),
  dpaTermsConfirmed: z.boolean(),
  training: z.enum(TRAINING).nullable(),
  zeroRetention: z.enum(ZERO_RETENTION).nullable(),
  providerRetention: typed(1000),
  retentionConfirmed: typed(500),
  onwardRecipients: typed(1000),
  reviewOn: Day.nullable(),
}

// POST /api/admin/registers/transfers/record: the entry's facts, from the revision the page showed.
// keepCleared ("Save and keep cleared") clears the new facts in the same transaction, if the entry
// was cleared, and refuses the whole save if they are incomplete (C0.9 PD-05).
export const RecordTransferBody = z.strictObject({
  provider: z.enum(PROVIDERS),
  seen: Revision,
  ...transferFactsBody,
  keepCleared: z.boolean(),
})
export type RecordTransferJSON = z.input<typeof RecordTransferBody>

// POST /api/admin/registers/transfers/clear: clears the facts of the revision the page showed.
export const ClearTransferBody = z.strictObject({ provider: z.enum(PROVIDERS), seen: Revision })
export type ClearTransferJSON = z.input<typeof ClearTransferBody>

// POST /api/admin/registers/transfers/withdraw. It names no revision: a withdrawal is never refused
// for being made from an older page.
export const WithdrawTransferBody = z.strictObject({ provider: z.enum(PROVIDERS) })
export type WithdrawTransferJSON = z.input<typeof WithdrawTransferBody>

// What each write answers: the entry's row (the new version's, or the transfer entry's), its
// version or revision, whether the provider is cleared now, and whether anything changed (a save
// that changes nothing writes nothing).
export const PurposeWriteResponse = z.strictObject({ entry: LowerUuid, version: Version, changed: z.boolean() })
export type PurposeWriteJSON = z.infer<typeof PurposeWriteResponse>
export const TransferWriteResponse = z.strictObject({
  entry: LowerUuid,
  revision: Revision,
  cleared: z.boolean(),
  changed: z.boolean(),
})
export type TransferWriteJSON = z.infer<typeof TransferWriteResponse>
// The web app's reading of either: the page reloads the registers after a write, so it reads only
// whether anything changed.
export const RegisterWriteResponseForClient = z.object({ changed: z.boolean() })

const NonAiPurpose = z.enum(PURPOSE_KEYS).refine(key => !PURPOSES[key].ai, { message: 'an AI purpose (C0.9 PD-27)' })
const NonAiProvider = z.enum(PROVIDERS).refine(key => !isAiProvider(key), { message: 'an AI provider (C0.9 PD-27)' })

// One purpose's current entry: its highest version.
const purposeRow = {
  purpose: NonAiPurpose,
  version: Version,
  status: z.enum(PURPOSE_STATUSES),
  basis: z.enum(BASES).nullable(),
  basisReference: stored(1000),
  optOutDays: z.int().min(OPT_OUT_DAYS_MIN).max(OPT_OUT_DAYS_MAX).nullable(),
  retention: stored(1000),
  providers: z.array(NonAiProvider).max(PROVIDERS_MAX),
  // Fixed per key (processing_register_defaults()): the page offers what purposeProblems allows.
  pinned: z.boolean(),
  needsSwitch: z.boolean(),
  recordedOn: Day,
  // Who recorded this version; null for version 1, which is Hearth's.
  recordedBy: PersonName.nullable(),
}

// A provider's clearance: the open one, or else the last that ended.
const clearance = {
  clearedOn: Day,
  clearedBy: PersonName.nullable(),
  clearedVia: z.enum(CLEARED_VIA),
  // The entry's revision whose facts it rests on.
  revision: Revision,
  withdrawnOn: Day.nullable(),
  withdrawnBy: PersonName.nullable(),
  withdrawReason: z.enum(WITHDRAW_REASONS).nullable(),
}

// One provider's entry, with its facts as stored.
const transferRow = {
  provider: NonAiProvider,
  revision: Revision,
  services: stored(500),
  dataTypes: stored(1000),
  processingCountries: Countries,
  storageCountries: Countries,
  countriesConfirmed: stored(500),
  safeguard: z.enum(SAFEGUARDS).nullable(),
  safeguardReference: stored(500),
  certificateVerifiedOn: Day.nullable(),
  dpaTermsConfirmed: z.boolean(),
  training: z.enum(TRAINING).nullable(),
  zeroRetention: z.enum(ZERO_RETENTION).nullable(),
  providerRetention: stored(1000),
  retentionConfirmed: stored(500),
  onwardRecipients: stored(1000),
  reviewOn: Day.nullable(),
  updatedOn: Day,
  // Who recorded these facts; null while they are Hearth's (the starting row, or the bootstrap's).
  updatedBy: PersonName.nullable(),
}

const Clearance = z.strictObject(clearance)
// clearance: null if the provider was never cleared in the org.
const TransferRow = z.strictObject({ ...transferRow, clearance: Clearance.nullable() })
const PurposeRow = z.strictObject(purposeRow)

// GET /api/admin/registers (C0.9 PD-20, PD-27): the current entry of every purpose and provider
// outside the AI layer, and today in the org's time zone, against which the page judges review
// dates and the shared rules. The server types its answer with this, so an AI row can't leave it.
export const RegistersResponse = z.strictObject({
  today: Day,
  purposes: z.array(PurposeRow).max(PURPOSE_KEYS.length),
  transfers: z.array(TransferRow).max(PROVIDERS.length),
})
export type RegistersJSON = z.infer<typeof RegistersResponse>
export type PurposeRowJSON = z.infer<typeof PurposeRow>
export type TransferRowJSON = z.infer<typeof TransferRow>
export type ClearanceJSON = z.infer<typeof Clearance>

// Each row of a list that reads, leaving out those that don't, so the rest of the page still shows.
function readableRows<T extends z.ZodType>(row: T) {
  return z.array(z.unknown()).transform(rows =>
    rows.flatMap((value): z.output<T>[] => {
      const read = row.safeParse(value)
      return read.success ? [read.data] : []
    }),
  )
}

// A name the web app can't read shows as nobody's, never as a failed page.
const nameForClient = PersonName.nullable().catch(null)

// The web app's reading of the same answer (P6): fields the server adds later are dropped, a name
// it can't read shows as nobody's, and a row it can't read, or one for an AI purpose or provider
// (C0.9 PD-27), is left out rather than breaking the page. An answer with no readable day fails.
export const RegistersResponseForClient = z.object({
  today: Day,
  purposes: readableRows(z.object({ ...purposeRow, recordedBy: nameForClient })),
  transfers: readableRows(
    z.object({
      ...transferRow,
      updatedBy: nameForClient,
      clearance: z.object({ ...clearance, clearedBy: nameForClient, withdrawnBy: nameForClient }).nullable(),
    }),
  ),
})
export type RegistersForClient = z.infer<typeof RegistersResponseForClient>
export type PurposeRowForClient = RegistersForClient['purposes'][number]
export type TransferRowForClient = RegistersForClient['transfers'][number]
