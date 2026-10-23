// The privacy notice (PDPA-02, PDPA-03, ACC-12; C0.9 PR 2, TECH-SPEC T22 items 21 to 37), as the
// api, the DPO's Notice tab and /notice share it: the body's line format and limit, the facts a
// version states about each provider, the codes of what holds publishing back and what it warns of,
// what changed between two versions, and the bodies and answers of /api/notice and
// /api/admin/notice. The words are notice-text.ts's, which only the server runs (the web imports
// it in tests); the database decides what is published (migration 0010's publish_notice()). The
// problems and warnings are codes; the pages word each (apps/web's strings), never this file.
//
// The server loads this file on Node (T2), and the package compiles with lib ES2024 and no DOM or
// Node types.
import { z } from 'zod'
import { LowerUuid } from './ids.ts'
import { PROVIDERS, type ProviderKey, PURPOSE_KEYS, type PurposeKey } from './purposes.ts'
import { NON_AI_PROVIDERS, NON_AI_PURPOSE_KEYS, type TransferFacts } from './registers.ts'
import { NOTICE_STANDINGS, PersonName } from './web.ts'

// --- The body (C0.9 PD-33) ---------------------------------------------------------------------

// A version's body is the exact words people acknowledge, as plain text in a fixed line format,
// which /notice and Settings render as text, never as HTML (WS-07):
//   '## '   a section heading
//   '### '  an entry inside a section: a purpose or a provider
//   '- '    an item; consecutive items are one list
//   any other line is a paragraph
// with one blank line between blocks (a heading, a paragraph or a list). The generator flattens the
// DPO's free text and the org's name to one line and never lets either start a line, so nothing
// stored can pass for a heading or an item. The body holds no version number and no date: the
// screens show both from the version's row.
export const NOTICE_LINE = { section: '## ', entry: '### ', item: '- ' } as const

// The longest body publish_notice() takes, in characters as Postgres counts them (code points).
export const NOTICE_BODY_MAX = 100_000

// The generator ids notice_versions.generator admits (0010's check); null marks a stand-in.
export const NOTICE_GENERATOR_PATTERN = /^[a-z0-9][a-z0-9.-]{0,31}$/

// --- What a version states about each provider (C0.9 PD-41) ------------------------------------

// The facts the notice tells people about a provider, which also decide whether its sends wait for
// a new version: a change to any of them stops sends to it until the DPO publishes a version that
// states it, and a change to its review date, its safeguard or a written confirmation doesn't. The
// keys are a clearance's facts snapshot's (transfer_register_facts(), migration 0009), in the order
// notice_facts() (0010) builds them; apps/server/scripts/check-catalogues.ts (check 6) holds the two
// equal.
export const NOTICE_TRANSFER_FACTS = [
  'services',
  'data_types',
  'processing_countries',
  'storage_countries',
  'training',
  'provider_retention',
  'onward_recipients',
] as const
export type NoticeTransferFact = (typeof NOTICE_TRANSFER_FACTS)[number]

// Each stated fact's field in the registers' TransferFacts (registers.ts), so a page can tell which
// fields of a provider's entry the notice states.
export const NOTICE_FACT_FIELDS = {
  services: 'services',
  data_types: 'dataTypes',
  processing_countries: 'processingCountries',
  storage_countries: 'storageCountries',
  training: 'training',
  provider_retention: 'providerRetention',
  onward_recipients: 'onwardRecipients',
} as const satisfies Record<NoticeTransferFact, keyof TransferFacts>

export type NoticeFacts = Pick<TransferFacts, (typeof NOTICE_FACT_FIELDS)[NoticeTransferFact]>

// The stated facts alone, from a provider's whole entry or a clearance's.
export function noticeFactsOf(facts: NoticeFacts): NoticeFacts {
  return {
    services: facts.services,
    dataTypes: facts.dataTypes,
    processingCountries: [...facts.processingCountries],
    storageCountries: [...facts.storageCountries],
    training: facts.training,
    providerRetention: facts.providerRetention,
    onwardRecipients: facts.onwardRecipients,
  }
}

// Whether two clearances state the same facts, as notice_facts() compares them: text exactly and
// countries in their stored order (upper case, sorted, each once).
export function sameNoticeFacts(a: NoticeFacts, b: NoticeFacts): boolean {
  const sameList = (x: readonly string[], y: readonly string[]) =>
    x.length === y.length && x.every((code, index) => code === y[index])
  return (
    a.services === b.services &&
    a.dataTypes === b.dataTypes &&
    sameList(a.processingCountries, b.processingCountries) &&
    sameList(a.storageCountries, b.storageCountries) &&
    a.training === b.training &&
    a.providerRetention === b.providerRetention &&
    a.onwardRecipients === b.onwardRecipients
  )
}

// --- Publishing: what holds it back and what it warns of (C0.9 PD-37, PD-38, PD-62) -------------

// What holds publishing back, in the order publish_notice() refuses them (HF008, 400
// notice_invalid). free_text_ai_copy is the exception: only the publish route checks it, before it
// calls the function, its one caller.
//   purpose_basis_missing      an active purpose with no legal basis
//   purpose_retention_missing  an active purpose with no retention
//   purpose_consent_basis      an active purpose on a consent-type basis, which no version can state
//                              yet: consent until C1.3's consent items, deemed consent by conduct
//                              until PR 3 publishes how to withdraw, and s15A until per-person
//                              opt-out windows are tracked
//   provider_not_cleared       an active purpose lists a provider with no open clearance
//   free_text_ai_copy          free text the DPO recorded, which the notice prints, uses words the
//                              app keeps off its screens before its AI stages (AI_COPY): a
//                              purpose's basis reference or retention, or a provider's stated facts
//   unchanged                  the draft is the latest version again: the same words, generator and
//                              sources
// Each names the purpose, the provider and the field it is about, where it has them, so the page
// links to where it is fixed and words it without quoting the text (C0.9 PD-62).
export const NOTICE_PROBLEMS = [
  'purpose_basis_missing',
  'purpose_retention_missing',
  'purpose_consent_basis',
  'provider_not_cleared',
  'free_text_ai_copy',
  'unchanged',
] as const
export type NoticeProblemCode = (typeof NOTICE_PROBLEMS)[number]

// The DPO's free text the notice prints, by the register field it comes from: a purpose's basis
// reference and retention, and a provider's stated facts that are text. The org's name is printed
// too, but the DPO doesn't set it: the bootstrap and C0.16's org settings refuse a name that
// matches AI_COPY instead.
export const NOTICE_FREE_TEXT_FIELDS = [
  'basis_reference',
  'retention',
  'services',
  'data_types',
  'provider_retention',
  'onward_recipients',
] as const
export type NoticeFreeTextField = (typeof NOTICE_FREE_TEXT_FIELDS)[number]

export interface NoticeProblem {
  code: NoticeProblemCode
  purpose?: PurposeKey
  provider?: ProviderKey
  field?: NoticeFreeTextField
}

// What publishing warns of, which never holds it back, in this order:
//   provider_unlisted    a cleared provider no active purpose lists: the notice still names it, so
//                        a cleared provider is never left out
//   provider_review_due  a cleared provider's review date is today or earlier, in the org's zone
//   sends_waiting        a cleared provider whose stated facts the latest generated version doesn't
//                        state: nothing is sent to it until a version that does is published
//   same_text            the words are the latest version's but the sources moved (a purpose's new
//                        register version, or a provider cleared again on the same facts), so
//                        everyone would acknowledge the same words again
//   dpo_contact_pending  the notice can't give the DPO's contact yet (C0.9 PR 3 adds it)
export const NOTICE_WARNINGS = [
  'provider_unlisted',
  'provider_review_due',
  'sends_waiting',
  'same_text',
  'dpo_contact_pending',
] as const
export type NoticeWarningCode = (typeof NOTICE_WARNINGS)[number]

export interface NoticeWarning {
  code: NoticeWarningCode
  provider?: ProviderKey
}

// --- What a version was built from, and what changed (C0.9 PD-34, PD-46, PD-48) ----------------

// A version's sources (store the context): the generator that wrote it (null on a stand-in), its
// words (null for a draft that can't be written yet), the register version of each purpose it lists
// (active or retired, C0.9 PD-60), and each provider's clearance with the facts that clearance
// rests on. A stand-in lists nothing.
export interface NoticeSources {
  generator: string | null
  body: string | null
  purposes: readonly { key: PurposeKey; version: number }[]
  clearances: readonly { id: string; provider: ProviderKey; facts: NoticeFacts }[]
}

// What changed from one version to the next, in the registries' order: the purposes and providers
// added, changed (a purpose at a new register version; a provider stating other facts, so one
// cleared again on the same facts hasn't changed) or removed, and whether the notice's own words
// changed (a new generator, or new words from the same sources, such as a new org name).
export interface NoticeChanges {
  purposes: { added: PurposeKey[]; changed: PurposeKey[]; removed: PurposeKey[] }
  providers: { added: ProviderKey[]; changed: ProviderKey[]; removed: ProviderKey[] }
  wording: boolean
}

export function noticeChanges(before: NoticeSources, after: NoticeSources): NoticeChanges {
  const purposesBefore = new Map(before.purposes.map(p => [p.key, p.version]))
  const purposesAfter = new Map(after.purposes.map(p => [p.key, p.version]))
  const providersBefore = new Map(before.clearances.map(c => [c.provider, c.facts]))
  const providersAfter = new Map(after.clearances.map(c => [c.provider, c.facts]))
  const purposes = {
    added: PURPOSE_KEYS.filter(key => purposesAfter.has(key) && !purposesBefore.has(key)),
    changed: PURPOSE_KEYS.filter(
      key => purposesAfter.has(key) && purposesBefore.has(key) && purposesAfter.get(key) !== purposesBefore.get(key),
    ),
    removed: PURPOSE_KEYS.filter(key => purposesBefore.has(key) && !purposesAfter.has(key)),
  }
  const providers = {
    added: PROVIDERS.filter(key => providersAfter.has(key) && !providersBefore.has(key)),
    changed: PROVIDERS.filter(key => {
      const was = providersBefore.get(key)
      const now = providersAfter.get(key)
      return was !== undefined && now !== undefined && !sameNoticeFacts(was, now)
    }),
    removed: PROVIDERS.filter(key => providersBefore.has(key) && !providersAfter.has(key)),
  }
  const listed = [purposes, providers].some(lists => Object.values(lists).some(list => list.length > 0))
  const reworded = before.body !== null && after.body !== null && before.body !== after.body && !listed
  return { purposes, providers, wording: before.generator !== after.generator || reworded }
}

// --- The api: bodies and answers (TECH-SPEC T22 items 25 and 26) --------------------------------

// A version number (notice_versions.version, an integer column, from 0).
const Version = z.int().min(0).max(2_147_483_647)
// When something happened, as an ISO instant: the screens show it in the viewer's own zone.
const Instant = z.iso.datetime({ offset: true })
// A day, YYYY-MM-DD, in the org's zone.
const Day = z.iso.date()
// sha-256, in hex: what ties the DPO's preview to what is published (C0.9 PD-36).
const Digest = z.string().regex(/^[0-9a-f]{64}$/)

// Postgres bounds text in code points, where a JavaScript string's length counts UTF-16 units.
const codePoints = (text: string) => [...text].length
const Body = z
  .string()
  .min(1)
  .refine(text => codePoints(text) <= NOTICE_BODY_MAX, { message: `at most ${NOTICE_BODY_MAX} characters` })

// How an acknowledgement was made (0003's notice_acknowledgments.method): in the app, or recorded
// by the DPO for someone who acknowledged another way (no writer until C0.9 PR 3).
export const NOTICE_ACK_METHODS = ['in_app', 'recorded_by_dpo'] as const
export type NoticeAckMethod = (typeof NOTICE_ACK_METHODS)[number]

// How many of your own acknowledgements GET /api/notice answers, newest first, and how many versions
// the DPO's history lists.
export const NOTICE_MINE_MAX = 50
export const NOTICE_HISTORY_MAX = 100

const NonAiPurpose = z.enum(PURPOSE_KEYS).refine(key => NON_AI_PURPOSE_KEYS.includes(key), {
  message: 'an AI purpose (C0.9 PD-35)',
})
const NonAiProvider = z.enum(PROVIDERS).refine(key => NON_AI_PROVIDERS.includes(key), {
  message: 'an AI provider (C0.9 PD-35)',
})

function changeLists<T extends z.ZodType>(key: T, max: number) {
  return z.strictObject({
    added: z.array(key).max(max),
    changed: z.array(key).max(max),
    removed: z.array(key).max(max),
  })
}

// What changed since version `since`: since the person's last acknowledged generated version
// (GET /api/notice), or since the latest version (the DPO's draft).
const Changes = z.strictObject({
  since: Version,
  purposes: changeLists(NonAiPurpose, NON_AI_PURPOSE_KEYS.length),
  providers: changeLists(NonAiProvider, NON_AI_PROVIDERS.length),
  wording: z.boolean(),
})
export type NoticeChangesJSON = z.infer<typeof Changes>

// POST /api/notice/acknowledge: the version the person read, as the screen showed it. The server
// takes the person and their device from the session, never from the body.
export const AcknowledgeBody = z.strictObject({ notice: LowerUuid })
export type AcknowledgeJSON = z.input<typeof AcknowledgeBody>

// Its answer: the version acknowledged, and whether this request recorded it (a second one records
// nothing).
export const AcknowledgeResponse = z.strictObject({ version: Version, changed: z.boolean() })
export type AcknowledgeResponseJSON = z.infer<typeof AcknowledgeResponse>
export const AcknowledgeResponseForClient = z.object({ version: z.int().min(0), changed: z.boolean() })

const CurrentVersion = z.strictObject({ id: LowerUuid, version: Version, publishedAt: Instant, body: Body })
const MyAcknowledgement = z.strictObject({
  version: Version,
  acknowledgedAt: Instant,
  method: z.enum(NOTICE_ACK_METHODS),
})

// GET /api/notice (C0.9 PD-46, B-11): whose answer it is (so a tab whose cookie now holds someone
// else's session ends its document), their standing, the latest version (null while none is
// published), what changed since the last generated version they acknowledged (null when there is
// none, or the latest is a stand-in), and their own acknowledgements, newest first.
export const NoticeResponse = z
  .strictObject({
    person: LowerUuid,
    standing: z.enum(NOTICE_STANDINGS),
    current: CurrentVersion.nullable(),
    changes: Changes.nullable(),
    mine: z.array(MyAcknowledgement).max(NOTICE_MINE_MAX),
  })
  .refine(answer => (answer.standing === 'unpublished') === (answer.current === null), {
    message: 'unpublished exactly when no version is published',
  })
export type NoticeJSON = z.infer<typeof NoticeResponse>

// Each row of a list that reads, leaving out those that don't, so the rest still shows.
function readableRows<T extends z.ZodType>(row: T) {
  return z.array(z.unknown()).transform(rows =>
    rows.flatMap((value): z.output<T>[] => {
      const read = row.safeParse(value)
      return read.success ? [read.data] : []
    }),
  )
}

// A purpose or provider key the web app can label; one it can't is left out of a change list.
const knownKeys = <T extends z.ZodType>(key: T) => readableRows(key).catch([])
const changeListsForClient = <T extends z.ZodType>(key: T) =>
  z.object({ added: knownKeys(key), changed: knownKeys(key), removed: knownKeys(key) })
const ChangesForClient = z.object({
  since: z.int().min(0),
  purposes: changeListsForClient(NonAiPurpose),
  providers: changeListsForClient(NonAiProvider),
  wording: z.boolean().catch(false),
})
export type NoticeChangesForClient = z.infer<typeof ChangesForClient>

// The web app's reading of GET /api/notice (P6): fields added later are dropped, a standing it can't
// read reads as required, so the screen still offers the notice to acknowledge, and an unreadable
// change list or acknowledgement is left out rather than breaking the screen. An answer with no
// readable person or version fails.
export const NoticeResponseForClient = z.object({
  person: z.string().min(1),
  standing: z.enum(NOTICE_STANDINGS).catch('required'),
  current: z
    .object({ id: z.string().min(1), version: z.int().min(0), publishedAt: Instant, body: z.string().min(1) })
    .nullable(),
  changes: ChangesForClient.nullable().catch(null),
  mine: readableRows(
    z.object({ version: z.int().min(0), acknowledgedAt: Instant, method: z.enum(NOTICE_ACK_METHODS) }),
  ).catch([]),
})
export type NoticeForClient = z.infer<typeof NoticeResponseForClient>

const Problem = z.strictObject({
  code: z.enum(NOTICE_PROBLEMS),
  purpose: NonAiPurpose.optional(),
  provider: NonAiProvider.optional(),
  field: z.enum(NOTICE_FREE_TEXT_FIELDS).optional(),
})
const Warning = z.strictObject({ code: z.enum(NOTICE_WARNINGS), provider: NonAiProvider.optional() })
// More than any draft can hold: each purpose and provider at most a few times over.
const LIST_MAX = 200

// A version in the DPO's history: who published it, and whether Hearth generated it (false for a
// stand-in, which only ever comes before the first generated version).
const historyRow = {
  id: LowerUuid,
  version: Version,
  publishedAt: Instant,
  publishedBy: PersonName.nullable(),
  generated: z.boolean(),
}

// GET /api/admin/notice (C0.9 PD-48): today in the org's zone; the latest version with how many of
// the people still at the organisation have acknowledged it (a count, never names); the draft the
// registers make now, with the number it would get, its words and digest (null while it can't be
// written, or shown: a problem the DPO must fix first, such as free text the screens keep off),
// what holds it back, what it warns of, what it changes since the latest version, and whether the
// published notice already says it; and up to 100 versions, newest first.
export const NoticeAdminResponse = z.strictObject({
  today: Day,
  latest: z
    .strictObject({ ...historyRow, acknowledged: z.int().min(0), people: z.int().min(0) })
    .refine(latest => latest.acknowledged <= latest.people, { message: 'more acknowledged than people' })
    .nullable(),
  draft: z
    .strictObject({
      version: Version,
      body: Body.nullable(),
      digest: Digest.nullable(),
      problems: z.array(Problem).max(LIST_MAX),
      warnings: z.array(Warning).max(LIST_MAX),
      changes: Changes.nullable(),
      upToDate: z.boolean(),
    })
    .refine(draft => (draft.body === null) === (draft.digest === null), {
      message: 'a digest exactly when there are words',
    }),
  history: z.array(z.strictObject(historyRow)).max(NOTICE_HISTORY_MAX),
})
export type NoticeAdminJSON = z.infer<typeof NoticeAdminResponse>
export type NoticeHistoryRowJSON = NoticeAdminJSON['history'][number]

// A name the web app can't read shows as nobody's, never as a failed page.
const nameForClient = PersonName.nullable().catch(null)
const historyRowForClient = {
  id: z.string().min(1),
  version: z.int().min(0),
  publishedAt: Instant,
  publishedBy: nameForClient,
  generated: z.boolean(),
}

// The web app's reading of the same answer (P6): fields added later are dropped, a name it can't
// read shows as nobody's, and a problem, warning or history row it can't read is left out. The page
// offers Publish only with a digest and no problem, and the server checks again, so a problem left
// out here never lets a draft through.
export const NoticeAdminResponseForClient = z.object({
  today: Day,
  latest: z.object({ ...historyRowForClient, acknowledged: z.int().min(0), people: z.int().min(0) }).nullable(),
  draft: z.object({
    version: z.int().min(0),
    body: z.string().min(1).nullable().catch(null),
    digest: Digest.nullable().catch(null),
    problems: readableRows(z.object(Problem.shape)),
    warnings: readableRows(z.object(Warning.shape)),
    changes: ChangesForClient.nullable().catch(null),
    upToDate: z.boolean().catch(false),
  }),
  history: readableRows(z.object(historyRowForClient)).catch([]),
})
export type NoticeAdminForClient = z.infer<typeof NoticeAdminResponseForClient>

// POST /api/admin/notice/publish: the latest version the page showed (null when none), and the
// digest of the draft it previewed. The server regenerates the draft and refuses one whose digest
// differs (409 notice_changed), so what is published is what the DPO read.
export const PublishBody = z.strictObject({ seen: Version.nullable(), digest: Digest })
export type PublishJSON = z.input<typeof PublishBody>

// Its answer: the new version's row and number.
export const PublishResponse = z.strictObject({ notice: LowerUuid, version: Version })
export type PublishResponseJSON = z.infer<typeof PublishResponse>
export const PublishResponseForClient = z.object({ version: z.int().min(0) })
