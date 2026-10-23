// The privacy notice's words (PDPA-02; C0.9 PD-33, PD-35, PD-36, PD-53, PD-58, PD-60, PD-62;
// TECH-SPEC T22 items 22 to 25): generateNotice() writes a version's body from the registers, and
// noticeProblems() and noticeWarnings() say what holds publishing back and what it warns of. It is
// pure and deterministic, so the same registers always give the same words and the DPO's preview is
// what gets published: the publish route regenerates the draft and compares digests. Only the
// server runs it; the web imports it in tests. NOTICE_GENERATOR names this code's output: any change
// to the words, however small, takes a new id, which notice-text.test.ts pins (NTG-09), so each
// version records which words wrote it, and the DPO's tab shows the notice out of date.
//
// The copy is British, short and active (CLAUDE.md, Conventions), never "ask", "I agree" or an AI
// word (decision 8, AI_COPY), and its verb is "acknowledge": acknowledging records that people
// were told, and it isn't consent (D28, PRD §8.18). The DPO confirms OD-04's paragraph, the
// production-access paragraph, the "doesn't do" clauses and every basis's wording (C0.9 PD-53).
//
// The server loads this file on Node (T2), and the package compiles with lib ES2024 and no DOM or
// Node types.
import { aiCopyIn } from './ai-copy.ts'
import {
  NOTICE_FREE_TEXT_FIELDS,
  NOTICE_LINE,
  NOTICE_PROBLEMS,
  NOTICE_WARNINGS,
  type NoticeFacts,
  type NoticeFreeTextField,
  type NoticeProblem,
  type NoticeSources,
  type NoticeWarning,
  sameNoticeFacts,
} from './notice.ts'
import {
  type AI_PROVIDERS,
  isAiProvider,
  isAiPurpose,
  PROVIDERS,
  type ProviderKey,
  PURPOSE_KEYS,
  PURPOSES,
  type PurposeKey,
} from './purposes.ts'
import { BASIS_NEEDS, type Basis, isConsentBasis, type PurposeStatus } from './registers.ts'

// The id of the words below. A new id with any change to the output (NTG-09).
export const NOTICE_GENERATOR = 'c09.1'

// --- What the generator reads (TECH-SPEC T22 item 23) ------------------------------------------

// A purpose's current register entry (its highest version).
export interface NoticePurpose {
  key: PurposeKey
  version: number
  status: PurposeStatus
  basis: Basis | null
  basisReference: string | null
  retention: string | null
  providers: readonly ProviderKey[]
}

// A provider's open clearance: its id, and the facts snapshot it rests on. The review date is
// read for the review-due warning; the notice doesn't print it.
export interface NoticeClearance {
  id: string
  provider: ProviderKey
  facts: NoticeFacts
  reviewOn: string | null
}

// Everything a draft is written from, read in one transaction: the org's name, the current entry
// of every purpose outside the AI layer (planned ones are left out of the notice), and every open
// clearance of a provider outside it.
export interface NoticeInput {
  org: string
  purposes: readonly NoticePurpose[]
  clearances: readonly NoticeClearance[]
}

// --- Fixed words ------------------------------------------------------------------------------

export const NOTICE_SECTIONS = {
  about: 'About this notice',
  purposes: 'Why your data is processed',
  retired: 'No longer in use',
  withdraw: 'If you withdraw consent',
  doesNot: "What Hearth doesn't do",
  providers: 'Who else receives your data',
  firstCode: 'Your first sign-in code',
  production: 'Access to production systems',
  rights: 'Your rights',
} as const

// How the notice names each provider outside the AI layer (PDPA-10's entries).
type NonAiProviderKey = Exclude<ProviderKey, (typeof AI_PROVIDERS)[number]>
export const NOTICE_PROVIDER_NAMES = {
  aws: 'Amazon Web Services',
  aws_sms: 'Amazon Web Services End User Messaging',
  twilio: 'Twilio Verify',
  livekit: 'LiveKit Cloud',
  apple_push: 'Apple Push Notification service',
  google_fcm: 'Firebase Cloud Messaging (Google)',
  mozilla_push: 'Mozilla Push Service',
  microsoft_wns: 'Windows Push Notification Services (Microsoft)',
} as const satisfies Record<NonAiProviderKey, string>

// What Hearth doesn't do (decision 5; C0.9 PD-35, PD-58): each clause with the purposes that would
// make it false. A clause is left out once any of its purposes is active, and the section once no
// clause is left, so no clause ever contradicts a purpose the same notice lists. Until A0 every
// purpose of the last two is AI, never active, so both always print (decision 5). The clauses avoid
// the word "AI" (decision 8): the last says what those features would do without naming them.
// Every purpose is in exactly one clause or in DOES_NOT_EXEMPT, with its reason (NTG-10), so a new
// purpose forces a decision.
export const DOES_NOT = [
  { clause: 'record calls, meetings or drop-in rooms', purposes: ['recording_meetings', 'recording_drop_in'] },
  {
    clause: 'transcribe anything',
    purposes: ['transcription', 'voice_message_transcription', 'transcription_test_set'],
  },
  {
    clause: 'summarise what you write or draft text from it',
    purposes: ['meeting_notes', 'org_brain', 'ai_writing', 'people_inference', 'assistant', 'agents'],
  },
] as const satisfies readonly { clause: string; purposes: readonly PurposeKey[] }[]

const LISTED_WHEN_ACTIVE = 'listed as a purpose when active; the notice makes no claim that Hearth doesn’t do it'
export const DOES_NOT_EXEMPT = {
  accounts: LISTED_WHEN_ACTIVE,
  content_delivery: LISTED_WHEN_ACTIVE,
  service_operation: LISTED_WHEN_ACTIVE,
  security_audit: LISTED_WHEN_ACTIVE,
  access_logs: LISTED_WHEN_ACTIVE,
  backups: LISTED_WHEN_ACTIVE,
  presence_receipts: LISTED_WHEN_ACTIVE,
  session_slides: LISTED_WHEN_ACTIVE,
  session_sharing: LISTED_WHEN_ACTIVE,
  people_insights: LISTED_WHEN_ACTIVE,
  sensitive_data_detection: 'listed as a purpose once active (PDPA-17)',
  ai_cost_figures: 'cost control: it reads no content',
} as const satisfies Partial<Record<PurposeKey, string>>

// --- Lines --------------------------------------------------------------------------------------

// Free text (the DPO's, the org's name) as one line: every run of whitespace or control characters,
// line breaks of every kind included, becomes one space, and the ends are trimmed.
const flat = (text: string) => text.replace(/[\s\p{Cc}]+/gu, ' ').trim()

// One line of the body, written as a template whose values are free text. It always starts with the
// generator's own words, never with a value, so nothing the DPO types can begin a line and pass for
// a heading or an item (C0.9 PD-33).
function line(fixed: TemplateStringsArray, ...free: readonly string[]): string {
  const start = fixed[0] ?? ''
  if (!/^\S/u.test(start)) throw new Error('A notice line starts with the generator’s own words')
  return free.reduce((text, value, index) => `${text}${flat(value)}${fixed[index + 1] ?? ''}`, start)
}

// A sentence that ends with free text, closed with a full stop unless the text closes itself.
const sentence = (text: string) => (/[.!?…]["'”’)\]]*$/u.test(text) ? text : `${text}.`)

// "a", "a and b", "a, b and c" (British: no comma before "and").
function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

// Country names in British English (Intl.DisplayNames, from Node's ICU), falling back to the code
// for one it doesn't know. Made on first use, so loading this file has no effect of its own.
let regions: Intl.DisplayNames | undefined
function countryName(code: string): string {
  regions ??= new Intl.DisplayNames('en-GB', { type: 'region', fallback: 'none' })
  try {
    return regions.of(code) ?? code
  } catch {
    return code
  }
}
const countries = (codes: readonly string[]) => joinList(codes.map(code => countryName(flat(code))))

// Text counts as recorded once it holds more than whitespace, as the registers count it.
const recorded = (text: string | null): text is string => text !== null && text.trim() !== ''

type Block = readonly string[]
const section = (title: string): Block => [`${NOTICE_LINE.section}${title}`]
const entry = (title: string): Block => [`${NOTICE_LINE.entry}${title}`]
const paragraph = (text: string): Block => [text]
const list = (items: readonly string[]): Block => items.map(item => `${NOTICE_LINE.item}${item}`)

// --- The input, checked -------------------------------------------------------------------------

interface Read {
  org: string
  active: readonly NoticePurpose[]
  retired: readonly NoticePurpose[]
  clearances: readonly NoticeClearance[]
}

const byPurpose = (a: NoticePurpose, b: NoticePurpose) => PURPOSE_KEYS.indexOf(a.key) - PURPOSE_KEYS.indexOf(b.key)
const byProvider = (a: ProviderKey, b: ProviderKey) => PROVIDERS.indexOf(a) - PROVIDERS.indexOf(b)

// What generateNotice() can't write is a bug in its caller, never something to publish: an AI
// purpose or provider (D41; the server reads neither), the same purpose or provider twice, or an
// entry that noticeProblems() holds back (no basis or no retention, or a consent-type basis), so
// the server asks for problems first.
function read(input: NoticeInput): Read {
  const org = flat(input.org)
  if (org === '') throw new Error('A notice names its organisation')
  const purposes = new Set<PurposeKey>()
  for (const purpose of input.purposes) {
    if (isAiPurpose(purpose.key)) throw new Error(`${purpose.key} is an AI purpose, never in the notice before A0`)
    if (purposes.has(purpose.key)) throw new Error(`${purpose.key} is in the input twice`)
    purposes.add(purpose.key)
    for (const provider of purpose.providers) {
      if (isAiProvider(provider)) throw new Error(`${purpose.key} lists ${provider}, an AI provider`)
    }
    if (purpose.status === 'planned') continue
    if (purpose.status === 'active' && (purpose.basis === null || isConsentBasis(purpose.basis))) {
      throw new Error(`${purpose.key} has no basis the notice can state`)
    }
    if (!recorded(purpose.retention)) throw new Error(`${purpose.key} has no retention`)
  }
  const providers = new Set<ProviderKey>()
  for (const clearance of input.clearances) {
    if (isAiProvider(clearance.provider)) throw new Error(`${clearance.provider} is an AI provider, never cleared`)
    if (providers.has(clearance.provider)) throw new Error(`${clearance.provider} is cleared twice in the input`)
    providers.add(clearance.provider)
  }
  const current = (status: PurposeStatus) => input.purposes.filter(p => p.status === status).sort(byPurpose)
  const clearances = [...input.clearances].sort((a, b) => byProvider(a.provider, b.provider))
  return { org, active: current('active'), retired: current('retired'), clearances }
}

// --- The body (TECH-SPEC T22 items 22 and 23) ---------------------------------------------------

// How the notice states each basis it may (C0.9 PD-38: no consent-type basis is stated yet).
// Legitimate interests says so and how to learn more (PDPA-02). No line puts the org's name in the
// possessive, which reads badly for a name ending in s.
function basisItem(purpose: NoticePurpose, org: string): string {
  const reference = recorded(purpose.basisReference) ? purpose.basisReference : null
  switch (purpose.basis) {
    case 'employment':
      return "Legal basis: the PDPA's exception for managing the employment relationship, which needs no consent."
    case 'legitimate_interests':
      return reference === null
        ? line`Legal basis: the legitimate interests of ${org}, weighed against yours in a documented assessment. Contact the Data Protection Officer to learn more.`
        : line`Legal basis: the legitimate interests of ${org}, weighed against yours in a documented assessment (${reference}). Contact the Data Protection Officer to learn more.`
    case 'business_improvement':
      return line`Legal basis: business improvement, so ${org} uses only data it already holds and collects or discloses none for it.`
    case 'other_exception':
      return reference === null
        ? 'Legal basis: an exception or requirement in law.'
        : line`Legal basis: an exception or requirement in law (${reference}).`
    default:
      // read() refuses the rest first.
      throw new Error(`${purpose.key}: no basis the notice can state`)
  }
}

function sharedItem(purpose: NoticePurpose): string {
  const names = [...purpose.providers]
    .sort(byProvider)
    .filter((provider, index, sorted) => sorted.indexOf(provider) === index)
    .map(provider => NOTICE_PROVIDER_NAMES[provider as NonAiProviderKey])
  return names.length === 0 ? 'No provider receives it.' : `Shared with: ${joinList(names)}.`
}

function trainingItem(facts: NoticeFacts, org: string): string[] {
  switch (facts.training) {
    case 'off':
      return [line`Model training: turned off for ${org}, so it trains no models on this data.`]
    case 'not_applicable':
      return ['Model training: it trains no models on the data it receives.']
    default:
      // A clearance always records it (transferProblems()); nothing is claimed without it.
      return []
  }
}

function providerItems(clearance: NoticeClearance, org: string): string[] {
  const facts = clearance.facts
  const items: string[] = []
  if (recorded(facts.services)) items.push(sentence(line`What it does: ${facts.services}`))
  if (recorded(facts.dataTypes)) items.push(sentence(line`What it receives: ${facts.dataTypes}`))
  const processing = countries(facts.processingCountries)
  const storage = countries(facts.storageCountries)
  if (processing === storage) {
    if (processing !== '') items.push(line`Where it processes and stores the data: ${processing}.`)
  } else {
    if (processing !== '') items.push(line`Where it processes the data: ${processing}.`)
    if (storage !== '') items.push(line`Where it stores the data: ${storage}.`)
  }
  if (recorded(facts.providerRetention)) {
    items.push(sentence(line`How long it keeps the data: ${facts.providerRetention}`))
  }
  if (recorded(facts.onwardRecipients)) {
    items.push(sentence(line`Who it passes the data to: ${facts.onwardRecipients}`))
  }
  return [...items, ...trainingItem(facts, org)]
}

// The body of a new version, from the registers as they are (C0.9 PD-35): every active purpose,
// with its basis, retention and providers; every retired one, with how long what it collected is
// kept (PD-60); whether consent can be withdrawn; what Hearth doesn't do (PD-58); every cleared
// provider with the facts it states, and OD-04's paragraph when Twilio is one; production access
// (PRD-101); and your rights. Throws on what noticeProblems() holds back (read() above).
export function generateNotice(input: NoticeInput): string {
  const { org, active, retired, clearances } = read(input)
  const blocks: Block[] = []

  blocks.push(
    section(NOTICE_SECTIONS.about),
    paragraph(
      line`This notice tells you what personal data Hearth processes for ${org}, why, how long it is kept and who else receives it.`,
    ),
    paragraph(
      'Acknowledging it records that you were told. It is not consent to any purpose: each one rests on the legal basis given for it below.',
    ),
    paragraph('You acknowledge each new version of this notice before you carry on using Hearth.'),
  )

  blocks.push(section(NOTICE_SECTIONS.purposes))
  if (active.length === 0) blocks.push(paragraph(line`Hearth processes no personal data for ${org} yet.`))
  for (const purpose of active) {
    blocks.push(
      entry(PURPOSES[purpose.key].register),
      list([basisItem(purpose, org), sentence(line`Kept for: ${purpose.retention ?? ''}`), sharedItem(purpose)]),
    )
  }

  if (retired.length > 0) {
    blocks.push(
      section(NOTICE_SECTIONS.retired),
      paragraph(
        'Hearth no longer processes personal data for these purposes. What was already collected is kept only as long as each one says.',
      ),
    )
    for (const purpose of retired) {
      blocks.push(
        entry(PURPOSES[purpose.key].register),
        list([sentence(line`Data already collected is kept for: ${purpose.retention ?? ''}`)]),
      )
    }
  }

  blocks.push(
    section(NOTICE_SECTIONS.withdraw),
    paragraph('None of these purposes rests on your consent, so all of them continue if you withdraw it.'),
  )

  const running = new Set<PurposeKey>(active.map(purpose => purpose.key))
  const clauses = DOES_NOT.filter(row => !row.purposes.some(key => running.has(key)))
  if (clauses.length > 0) {
    blocks.push(
      section(NOTICE_SECTIONS.doesNot),
      list(clauses.map(row => `Hearth doesn't ${row.clause}.`)),
      paragraph('None of these happens unless a new version of this notice says so and you have acknowledged it.'),
    )
  }

  if (clearances.length > 0) {
    blocks.push(
      section(NOTICE_SECTIONS.providers),
      paragraph(line`Each provider below receives personal data from Hearth for ${org}, as its entry says.`),
    )
    for (const clearance of clearances) {
      blocks.push(
        entry(NOTICE_PROVIDER_NAMES[clearance.provider as NonAiProviderKey]),
        list(providerItems(clearance, org)),
      )
    }
  }

  // OD-04: the first code went to Twilio before anyone could read this, so the notice says so, and
  // where Twilio processes it. A country list stands after a colon, as in the providers' entries, so
  // no name needs an article ("the United States").
  const twilio = clearances.find(clearance => clearance.provider === 'twilio')
  if (twilio !== undefined) {
    const where = countries(twilio.facts.processingCountries)
    blocks.push(
      section(NOTICE_SECTIONS.firstCode),
      paragraph(
        line`To send your first sign-in code, your mobile number went to Twilio Verify before you could read this notice. Your invitation and the employee data protection policy of ${org} told you it would.`,
      ),
    )
    if (where !== '') blocks.push(paragraph(line`Where Twilio Verify processes it: ${where}.`))
  }

  blocks.push(
    section(NOTICE_SECTIONS.production),
    paragraph(
      line`The person who runs Hearth's servers for ${org} can reach its production systems only through a separate emergency role. Each use is logged, and a second person reviews every use each quarter.`,
    ),
    section(NOTICE_SECTIONS.rights),
    paragraph(
      line`You can request a copy of the personal data ${org} holds about you, have it corrected, or withdraw consent where a purpose rests on it.`,
    ),
    paragraph(
      line`To do any of these, contact the Data Protection Officer through the contact given in the employee data protection policy of ${org}.`,
    ),
  )

  return blocks.map(block => block.join('\n')).join('\n\n')
}

// --- Sources and the digest (C0.9 PD-34, PD-36) -------------------------------------------------

// Code-unit order, as collate "C" sorts the keys and ids publish_notice() compares.
const codeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// The draft's sources, as publish_notice() takes them and the version links them: every active or
// retired purpose at its current version, sorted by key (PD-60), and every open clearance, sorted
// by id.
export function noticeDraftSources(input: NoticeInput, body: string | null): NoticeSources {
  return {
    generator: NOTICE_GENERATOR,
    body,
    purposes: input.purposes
      .filter(purpose => purpose.status !== 'planned')
      .map(purpose => ({ key: purpose.key, version: purpose.version }))
      .sort((a, b) => codeUnits(a.key, b.key)),
    clearances: input.clearances
      .map(clearance => ({ id: clearance.id, provider: clearance.provider, facts: clearance.facts }))
      .sort((a, b) => codeUnits(a.id, b.id)),
  }
}

// What the draft's digest hashes (sha-256, on the server): JSON with sorted keys of its words, its
// generator and its sources, so a preview and a publish agree only when every one of them does.
export function noticeDigestText(sources: NoticeSources): string {
  const purposes: Record<string, number> = {}
  for (const purpose of [...sources.purposes].sort((a, b) => codeUnits(a.key, b.key))) {
    purposes[purpose.key] = purpose.version
  }
  return JSON.stringify({
    body: sources.body,
    clearances: sources.clearances.map(clearance => clearance.id).sort(codeUnits),
    generator: sources.generator,
    purposes,
  })
}

// The same words from the same generator, listing the same purposes at the same versions.
function sameWords(draft: NoticeSources, latest: NoticeSources): boolean {
  const pairs = (sources: NoticeSources) =>
    sources.purposes
      .map(purpose => `${purpose.key}:${purpose.version}`)
      .sort(codeUnits)
      .join(',')
  return (
    draft.body !== null &&
    draft.body === latest.body &&
    draft.generator === latest.generator &&
    pairs(draft) === pairs(latest)
  )
}

// Whether a draft is the latest version again: the same words and purposes, and the same clearances.
function sameVersion(draft: NoticeSources, latest: NoticeSources): boolean {
  const ids = (sources: NoticeSources) =>
    sources.clearances
      .map(clearance => clearance.id)
      .sort(codeUnits)
      .join(',')
  return sameWords(draft, latest) && ids(draft) === ids(latest)
}

// Whether the latest version still says what the draft would (C0.9 PD-48): the same words and
// purposes, and each provider stating the same facts, whichever clearance they rest on. A provider
// cleared again on the same facts (a new review date alone) leaves the notice up to date: its sends
// go on (PD-59), and publishing would only have everyone acknowledge the same words again
// (same_text). A stand-in never says what a draft would.
export function noticeSaysTheSame(draft: NoticeSources, latest: NoticeSources): boolean {
  if (!sameWords(draft, latest)) return false
  const stated = new Map(latest.clearances.map(clearance => [clearance.provider, clearance.facts]))
  return (
    draft.clearances.length === stated.size &&
    draft.clearances.every(clearance => {
      const was = stated.get(clearance.provider)
      return was !== undefined && sameNoticeFacts(was, clearance.facts)
    })
  )
}

// --- Problems and warnings (C0.9 PD-37, PD-38, PD-62) ------------------------------------------

// The problems that stop the draft being written at all.
const UNWRITABLE: readonly NoticeProblem['code'][] = [
  'purpose_basis_missing',
  'purpose_retention_missing',
  'purpose_consent_basis',
]

function sortedBy<T extends { code: string; purpose?: PurposeKey; provider?: ProviderKey; field?: string }>(
  codes: readonly string[],
  found: readonly T[],
): T[] {
  const rank = (item: T) => [
    codes.indexOf(item.code),
    item.purpose === undefined ? -1 : PURPOSE_KEYS.indexOf(item.purpose),
    item.provider === undefined ? -1 : PROVIDERS.indexOf(item.provider),
    item.field === undefined ? -1 : (NOTICE_FREE_TEXT_FIELDS as readonly string[]).indexOf(item.field),
  ]
  return [...found].sort((a, b) => {
    const x = rank(a)
    const y = rank(b)
    for (let i = 0; i < x.length; i++) {
      const d = (x[i] ?? 0) - (y[i] ?? 0)
      if (d !== 0) return d
    }
    return 0
  })
}

// What holds a draft back, in NOTICE_PROBLEMS order, then the registries' (notice.ts says what
// each means). The rules hold for active purposes; a retired one's retention is checked too, which
// 0009 already requires, so the generator never meets one without it. Free text is checked as the
// notice prints it, and only where it prints it. Whether the draft is the latest version again is
// known only once it can be written.
export function noticeProblems(input: NoticeInput, latest: NoticeSources | null): NoticeProblem[] {
  const found: NoticeProblem[] = []
  const cleared = new Set(input.clearances.map(clearance => clearance.provider))
  const freeText = (
    field: NoticeFreeTextField,
    text: string | null,
    about: Pick<NoticeProblem, 'purpose' | 'provider'>,
  ) => {
    if (text !== null && aiCopyIn(flat(text)) !== undefined) found.push({ code: 'free_text_ai_copy', ...about, field })
  }
  for (const purpose of input.purposes) {
    if (purpose.status === 'planned') continue
    const about = { purpose: purpose.key }
    if (!recorded(purpose.retention)) found.push({ code: 'purpose_retention_missing', ...about })
    freeText('retention', purpose.retention, about)
    if (purpose.status !== 'active') continue
    if (purpose.basis === null) found.push({ code: 'purpose_basis_missing', ...about })
    else if (isConsentBasis(purpose.basis)) found.push({ code: 'purpose_consent_basis', ...about })
    else if (BASIS_NEEDS[purpose.basis].reference) freeText('basis_reference', purpose.basisReference, about)
    for (const provider of new Set(purpose.providers)) {
      if (!cleared.has(provider)) found.push({ code: 'provider_not_cleared', ...about, provider })
    }
  }
  for (const clearance of input.clearances) {
    const about = { provider: clearance.provider }
    freeText('services', clearance.facts.services, about)
    freeText('data_types', clearance.facts.dataTypes, about)
    freeText('provider_retention', clearance.facts.providerRetention, about)
    freeText('onward_recipients', clearance.facts.onwardRecipients, about)
  }
  if (latest !== null && !found.some(problem => UNWRITABLE.includes(problem.code))) {
    const draft = noticeDraftSources(input, generateNotice(input))
    if (sameVersion(draft, latest)) found.push({ code: 'unchanged' })
  }
  return sortedBy(NOTICE_PROBLEMS, found)
}

// What publishing the draft warns of, in NOTICE_WARNINGS order, then the providers' (notice.ts says
// what each means). today is the org's, in its time zone, YYYY-MM-DD.
export function noticeWarnings(input: NoticeInput, latest: NoticeSources | null, today: string): NoticeWarning[] {
  const found: NoticeWarning[] = []
  const listed = new Set(
    input.purposes.filter(purpose => purpose.status === 'active').flatMap(purpose => purpose.providers),
  )
  for (const clearance of input.clearances) {
    const about = { provider: clearance.provider }
    if (!listed.has(clearance.provider)) found.push({ code: 'provider_unlisted', ...about })
    if (clearance.reviewOn !== null && clearance.reviewOn <= today)
      found.push({ code: 'provider_review_due', ...about })
    const stated = latest?.clearances.some(
      was => was.provider === clearance.provider && sameNoticeFacts(was.facts, clearance.facts),
    )
    if (latest !== null && latest.generator !== null && !stated) found.push({ code: 'sends_waiting', ...about })
  }
  const writable = noticeProblems(input, null).every(problem => !UNWRITABLE.includes(problem.code))
  if (latest !== null && writable) {
    const draft = noticeDraftSources(input, generateNotice(input))
    if (draft.body === latest.body && !sameVersion(draft, latest)) found.push({ code: 'same_text' })
  }
  // Standing warnings: what the notice says of the DPO's contact and of production access isn't in
  // place yet (C0.9 PD-57), so the DPO is told each time.
  found.push({ code: 'dpo_contact_pending' }, { code: 'production_access_pending' })
  return sortedBy(NOTICE_WARNINGS, found)
}
