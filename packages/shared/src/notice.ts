// The privacy notice (PDPA-02, PDPA-03, ACC-12; C0.9 PR 2, TECH-SPEC T22 items 21 to 37), as the
// api, the DPO's Notice tab and /notice share it: the body's line format and limit, the facts a
// version states about each provider, the codes of what holds publishing back and what it warns of,
// what changed between two versions, and the bodies and answers of /api/notice and
// /api/admin/notice. From C0.9 PR 3a (OD-11, OD-19): the DPO's contact each version printed, and the
// acknowledgements the DPO records for someone who acknowledged outside Hearth, with the people
// they pick from. The words are notice-text.ts's, which only the server runs (the web imports it in
// tests); the database decides what is published (migration 0011's publish_notice()). The problems
// and warnings are codes; the pages word each (apps/web's strings), never this file.
//
// The server loads this file on Node (T2), and the package compiles with lib ES2024 and no DOM or
// Node types.
import { z } from 'zod'
import { aiCopyIn } from './ai-copy.ts'
import { type DpoContact, flatText, NoticeContact, NoticeContactForClient, sameContact } from './dpo-contact.ts'
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
// notice_invalid). purpose_conduct_unstoppable and free_text_ai_copy are the exceptions: only the
// publish route checks them, before it calls the function, its one caller, since each rests on a
// list that is code (CONDUCT_WITHDRAWABLE, AI_COPY).
//   purpose_basis_missing        an active purpose with no legal basis
//   purpose_retention_missing    an active purpose with no retention
//   purpose_consent_basis        an active purpose on a basis no version can state yet: consent
//                                until C1.3's consent items, and deemed consent by notification
//                                (s15A) until C2.11's opt-out windows; deemed consent by conduct is
//                                stated from C0.9 PR 3a (OD-18)
//   purpose_conduct_unstoppable  an active purpose on deemed consent by conduct whose withdrawal
//                                procedure doesn't yet say how one person's withdrawal is carried
//                                out (CONDUCT_WITHDRAWABLE; C0.9 OD-18, PD-86): the notice would
//                                promise a stop Hearth can't make. The route's, as
//                                free_text_ai_copy is
//   provider_not_cleared         an active purpose lists a provider with no open clearance
//   dpo_contact_pending          no business contact for the DPO is recorded (C0.9 OD-10): the
//                                notice can't say how to reach them, and no draft is written. The
//                                code keeps its inherited name (T22 item 37)
//   free_text_ai_copy            free text the DPO recorded, which the notice prints, uses words the
//                                app keeps off its screens before its AI stages (AI_COPY): a
//                                purpose's basis reference or retention, a provider's stated facts,
//                                or the DPO's contact
//   unchanged                    the draft is the latest version again: the same words, generator
//                                and sources
// Each names the purpose, the provider and the field it is about, where it has them, so the page
// links to where it is fixed and words it without quoting the text (C0.9 PD-62).
export const NOTICE_PROBLEMS = [
  'purpose_basis_missing',
  'purpose_retention_missing',
  'purpose_consent_basis',
  'purpose_conduct_unstoppable',
  'provider_not_cleared',
  'dpo_contact_pending',
  'free_text_ai_copy',
  'unchanged',
] as const
export type NoticeProblemCode = (typeof NOTICE_PROBLEMS)[number]

// The DPO's free text the notice prints, by the field it comes from: a purpose's basis reference
// and retention, a provider's stated facts that are text, and the DPO's contact (C0.9 PD-65): its
// role title, email address and postal address (a phone number holds no letter). The org's name is
// printed too, but the DPO doesn't set it: the bootstrap and C0.16's org settings refuse a name
// that matches AI_COPY, and until they do the generator prints "your organisation" for such a name.
export const NOTICE_FREE_TEXT_FIELDS = [
  'basis_reference',
  'retention',
  'services',
  'data_types',
  'provider_retention',
  'onward_recipients',
  'contact_title',
  'contact_email',
  'contact_postal',
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
//                        register version, a provider cleared again on the same facts, or a new
//                        version of the DPO's contact with the same details), so everyone would
//                        acknowledge the same words again
//   production_access_pending
//                        the notice states the emergency production role, its log and the quarterly
//                        review by a second person, which C0.11 and C0.19 put in place: the DPO
//                        publishes once they are (C0.9 PD-57; C0.19 drops the warning)
export const NOTICE_WARNINGS = [
  'provider_unlisted',
  'provider_review_due',
  'sends_waiting',
  'same_text',
  'production_access_pending',
] as const
export type NoticeWarningCode = (typeof NOTICE_WARNINGS)[number]

export interface NoticeWarning {
  code: NoticeWarningCode
  provider?: ProviderKey
}

// --- What a version was built from, and what changed (C0.9 PD-34, PD-46, PD-48) ----------------

// A version's sources (store the context): the generator that wrote it (null on a stand-in), its
// words (null for a draft that can't be written yet), the register version of each purpose it lists
// (active or retired, C0.9 PD-60), each provider's clearance with the facts that clearance rests
// on, and the DPO's settings version it printed, with its contact (C0.9 PD-66; null on a stand-in
// and on a version that printed none, such as a c09.1 one). A stand-in lists nothing.
export interface NoticeSources {
  generator: string | null
  body: string | null
  purposes: readonly { key: PurposeKey; version: number }[]
  clearances: readonly { id: string; provider: ProviderKey; facts: NoticeFacts }[]
  contact: { version: number; facts: DpoContact } | null
}

// How the DPO's contact changed from one version to the next (C0.9 PD-67), comparing what the two
// printed:
//   same     neither prints one, or both print the same details (a new settings version with the
//            same details included)
//   added    the earlier version printed none and this one prints one: the first c09.2 version
//            after a c09.1 one or a stand-in, which gives the contact for the first time
//   changed  both print one, with other details
export const NOTICE_CONTACT_CHANGES = ['same', 'added', 'changed'] as const
export type NoticeContactChange = (typeof NOTICE_CONTACT_CHANGES)[number]

// What changed from one version to the next, in the registries' order: the purposes and providers
// added, changed (a purpose at a new register version; a provider stating other facts, so one
// cleared again on the same facts hasn't changed) or removed, the DPO's contact, and whether the
// notice's own words changed (a new generator, or new words from the same sources, such as a new
// org name).
export interface NoticeChanges {
  purposes: { added: PurposeKey[]; changed: PurposeKey[]; removed: PurposeKey[] }
  providers: { added: ProviderKey[]; changed: ProviderKey[]; removed: ProviderKey[] }
  contact: NoticeContactChange
  wording: boolean
}

function contactChange(before: NoticeSources['contact'], after: NoticeSources['contact']): NoticeContactChange {
  if (after === null) return 'same'
  if (before === null) return 'added'
  return sameContact(before.facts, after.facts) ? 'same' : 'changed'
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
  const contact = contactChange(before.contact, after.contact)
  // New words that come with a listed change, or a new contact, are that change, not new wording.
  const listed = [purposes, providers].some(lists => Object.values(lists).some(list => list.length > 0))
  const reworded =
    before.body !== null && after.body !== null && before.body !== after.body && !listed && contact === 'same'
  return { purposes, providers, contact, wording: before.generator !== after.generator || reworded }
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
// by the DPO for someone who acknowledged another way. recorded_by_dpo is written by
// record_notice_acknowledgement() from C0.9 PR 3a (OD-19).
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
  contact: z.enum(NOTICE_CONTACT_CHANGES),
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

// The longest note of how someone acknowledged outside Hearth (0011's
// notice_acknowledgments_recorded_note), in characters as Postgres counts them.
export const NOTICE_NOTE_MAX = 500
const Note = z
  .string()
  .min(1)
  .refine(text => codePoints(text) <= NOTICE_NOTE_MAX, { message: `at most ${NOTICE_NOTE_MAX} characters` })

const CurrentVersion = z.strictObject({ id: LowerUuid, version: Version, publishedAt: Instant, body: Body })
// One of your acknowledgements. One the DPO recorded from C0.9 PR 3a also has the day you
// acknowledged outside Hearth, in the org's zone, and a note of how (PD-75); acknowledgedAt stays
// the moment it was recorded. Neither is set on any other row (0011's
// notice_acknowledgments_recorded_details).
const MyAcknowledgement = z
  .strictObject({
    version: Version,
    acknowledgedAt: Instant,
    method: z.enum(NOTICE_ACK_METHODS),
    acknowledgedOn: Day.nullable(),
    note: Note.nullable(),
  })
  .refine(
    row =>
      (row.acknowledgedOn === null) === (row.note === null) && (row.note === null || row.method === 'recorded_by_dpo'),
    { message: 'a day and a note together, and only on an acknowledgement the DPO recorded' },
  )

// GET /api/notice (C0.9 PD-46, B-11): whose answer it is (so a tab whose cookie now holds someone
// else's session ends its document), their standing, the latest version (null while none is
// published) with the DPO's contact it printed (null when it printed none: C0.9 PD-69), what
// changed since the last generated version they acknowledged (null when there is none, or the
// latest is a stand-in), and their own acknowledgements, newest first.
export const NoticeResponse = z
  .strictObject({
    person: LowerUuid,
    standing: z.enum(NOTICE_STANDINGS),
    current: CurrentVersion.nullable(),
    contact: NoticeContact.nullable(),
    changes: Changes.nullable(),
    mine: z.array(MyAcknowledgement).max(NOTICE_MINE_MAX),
  })
  .refine(answer => (answer.standing === 'unpublished') === (answer.current === null), {
    message: 'unpublished exactly when no version is published',
  })
  .refine(answer => answer.current !== null || answer.contact === null, {
    message: 'a contact only from a published version',
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
  contact: z.enum(NOTICE_CONTACT_CHANGES).catch('same'),
  wording: z.boolean().catch(false),
})
export type NoticeChangesForClient = z.infer<typeof ChangesForClient>

// The web app's reading of GET /api/notice (P6): fields added later are dropped, a standing it can't
// read reads as required, so the screen still offers the notice to acknowledge, and an unreadable
// change list or acknowledgement is left out rather than breaking the screen. A contact it can't
// read is undefined, never null, so Settings says it couldn't be read rather than that the notice
// gives none; a recorded day or note it can't read is left out. An answer with no readable person
// or version fails.
export const NoticeResponseForClient = z.object({
  person: z.string().min(1),
  standing: z.enum(NOTICE_STANDINGS).catch('required'),
  current: z
    .object({ id: z.string().min(1), version: z.int().min(0), publishedAt: Instant, body: z.string().min(1) })
    .nullable(),
  contact: NoticeContactForClient.nullable().optional().catch(undefined),
  changes: ChangesForClient.nullable().catch(null),
  mine: readableRows(
    z.object({
      version: z.int().min(0),
      acknowledgedAt: Instant,
      method: z.enum(NOTICE_ACK_METHODS),
      acknowledgedOn: Day.nullable().catch(null),
      note: Note.nullable().catch(null),
    }),
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

// --- Acknowledgements the DPO records (C0.9 OD-19, PD-75, PD-76) --------------------------------

// The most people GET /api/admin/notice/people lists, in name order; `more` says when there were
// others, so a cut list is never silent.
export const NOTICE_PEOPLE_MAX = 2000

// departments.name holds 1 to 100 characters (0002's check), which Postgres counts in code points,
// as PersonName counts a name's 200.
const DepartmentName = z
  .string()
  .min(1)
  .refine(name => codePoints(name) <= 100, { message: 'at most 100 characters' })

// GET /api/admin/notice/people (C0.9 OD-19, PD-76), under notice.people.read: today in the org's
// zone, the latest version a record would be for, and every person still at the organisation but
// you, by name, department, manager and the day they were added (in the org's zone), at most
// NOTICE_PEOPLE_MAX in name order, with more when there were others. Never a number or who has
// acknowledged (C0.16 decides whether to name those outstanding). The action isn't a setup use,
// so a version always exists when this answers.
export const NoticePeopleResponse = z.strictObject({
  today: Day,
  latest: z.strictObject({ notice: LowerUuid, version: Version, publishedOn: Day }),
  people: z
    .array(
      z.strictObject({
        id: LowerUuid,
        name: PersonName,
        department: DepartmentName.nullable(),
        manager: PersonName.nullable(),
        addedOn: Day,
      }),
    )
    .max(NOTICE_PEOPLE_MAX),
  more: z.boolean(),
})
export type NoticePeopleJSON = z.infer<typeof NoticePeopleResponse>

// The web app's reading of the same answer (P6): fields added later are dropped, a person it can't
// read is left out (one it couldn't name or post back), a department or manager it can't read
// shows as none, and an unreadable more reads as false. An answer with no readable day, version or
// list fails, so the dialog never claims there is nobody to record.
export const NoticePeopleResponseForClient = z.object({
  today: Day,
  latest: z.object({ notice: LowerUuid, version: z.int().min(0), publishedOn: Day }),
  people: readableRows(
    z.object({
      id: LowerUuid,
      name: PersonName,
      department: DepartmentName.nullable().catch(null),
      manager: PersonName.nullable().catch(null),
      addedOn: Day,
    }),
  ),
  more: z.boolean().catch(false),
})
export type NoticePeopleForClient = z.infer<typeof NoticePeopleResponseForClient>
export type NoticePersonForClient = NoticePeopleForClient['people'][number]

// POST /api/admin/notice/acknowledgements/record: whose, the version the dialog was read for, the
// day they acknowledged it outside Hearth, and how. The DPO and their device come from the session,
// never the body. The note's bound is generous (UTF-16 units), so a long note is a problem the
// dialog words, and record_notice_acknowledgement() trims it and checks it again (HF008).
export const RecordAcknowledgementBody = z.strictObject({
  person: LowerUuid,
  notice: LowerUuid,
  acknowledgedOn: Day,
  note: z.string().max(2000),
})
export type RecordAcknowledgementJSON = z.input<typeof RecordAcknowledgementBody>

// What the dialog holds a record back for, in this order (record_notice_acknowledgement() checks the
// day and the note too, HF008, 400 notice_invalid):
//   person_missing     nobody chosen
//   day_missing        no day, or one that isn't a date
//   day_out_of_range   before the version was published, or after today, in the org's zone
//   note_missing       no note of how they acknowledged it
//   note_long          a note over 500 characters
//   note_not_one_line  a note with a line break or another control character
//   ai_copy            a note with wording Hearth keeps off its screens (AI_COPY, decision 8): the
//                      person sees it in Settings (PD-75), and only the route checks it
export const RECORD_PROBLEMS = [
  'person_missing',
  'day_missing',
  'day_out_of_range',
  'note_missing',
  'note_long',
  'note_not_one_line',
  'ai_copy',
] as const
export type RecordProblemCode = (typeof RECORD_PROBLEMS)[number]

// What holds the dialog's record back, in RECORD_PROBLEMS order, for the days the answer gives
// (from the version's publication day to today, both YYYY-MM-DD). The note is read as the function
// reads it: trimmed (String.prototype.trim()'s set), counted in code points, with no control
// character (Postgres's [[:cntrl:]] is \p{Cc}).
export function recordProblems(
  form: { person: string | null; acknowledgedOn: string | null; note: string },
  range: { from: string; to: string },
): RecordProblemCode[] {
  const found = new Set<RecordProblemCode>()
  if (form.person === null || form.person === '') found.add('person_missing')
  const day = form.acknowledgedOn
  if (day === null || !Day.safeParse(day).success) found.add('day_missing')
  else if (day < range.from || day > range.to) found.add('day_out_of_range')
  const note = form.note.trim()
  if (note === '') found.add('note_missing')
  else {
    if (codePoints(note) > NOTICE_NOTE_MAX) found.add('note_long')
    if (/\p{Cc}/u.test(note)) found.add('note_not_one_line')
    if (aiCopyIn(flatText(note)) !== undefined) found.add('ai_copy')
  }
  return RECORD_PROBLEMS.filter(problem => found.has(problem))
}
