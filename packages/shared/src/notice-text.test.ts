// The privacy notice's words (PDPA-02; C0.9 PD-33, PD-35 to PD-38, PD-53, PD-58, PD-60, PD-62, and
// from PR 3a PD-65 to PD-68, PD-73, PD-74 and PD-86; TECH-SPEC T22 items 22 to 25): what
// generateNotice() writes from the registers and the DPO's contact, and what noticeProblems() and
// noticeWarnings() say of a draft. publish_notice() (migration 0011) refuses the same problems in
// the database (db/tests/160_notice.sql, NTD-05), but for the two only its route checks
// (purpose_conduct_unstoppable and free_text_ai_copy); the screens that show the words hold them
// to AI_COPY again (apps/web, NTW-10).
import { describe, expect, it, vi } from 'vitest'
import { aiCopyIn } from './ai-copy.ts'
import type { DpoContact } from './dpo-contact.ts'
import { PINNED_PURPOSES } from './flags.ts'
import {
  NOTICE_BODY_MAX,
  NOTICE_GENERATOR_PATTERN,
  NOTICE_LINE,
  NOTICE_PROBLEMS,
  type NoticeFacts,
  type NoticeSources,
  noticeChanges,
} from './notice.ts'
import {
  conductUnstoppable,
  DOES_NOT,
  DOES_NOT_EXEMPT,
  generateNotice,
  NOTICE_COUNTRY_NAMES,
  NOTICE_GENERATOR,
  NOTICE_PROVIDER_NAMES,
  NOTICE_SECTIONS,
  type NoticeClearance,
  type NoticeInput,
  type NoticePurpose,
  noticeDigestText,
  noticeDraftSources,
  noticeProblems,
  noticeSaysTheSame,
  noticeWarnings,
} from './notice-text.ts'
import { type ProviderKey, PURPOSE_KEYS, PURPOSES, type PurposeKey } from './purposes.ts'
import { CONDUCT_WITHDRAWABLE, NON_AI_PROVIDERS, NON_AI_PURPOSE_KEYS } from './registers.ts'

const ORG = 'Tembusu Logistics'
const TODAY = '2026-10-23'

// The DPO's business contact, fictional, on a reserved domain (C0.9 OD-10): a role title and an
// email address, at the org's first settings version.
const CONTACT: NonNullable<NoticeInput['contact']> = {
  version: 1,
  title: 'Data Protection Officer',
  email: 'dpo@notice.example',
  phone: null,
  postal: null,
}
// A phone number in the seed's made-up range that no persona uses, and a postal address, fictional.
const PHONE = '+65 8000 0198'
const POSTAL = '1 Example Road\nSingapore 000000'

// The warning every draft carries until C0.19 (C0.9 PD-57). The DPO's contact, which PR 2 warned
// of too, is a problem from PR 3a (dpo_contact_pending, PD-68).
const STANDING = ['production_access_pending']
const NOTHING = { added: [], changed: [], removed: [] }

// Twilio Verify's and AWS's stated facts, fictional.
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
  services: 'Hosting, storage and monitoring',
  dataTypes: 'Everything Hearth stores',
  processingCountries: ['SG'],
  storageCountries: ['SG', 'JP'],
  training: 'off',
  providerRetention: 'As long as Hearth keeps it',
  onwardRecipients: 'None',
}

const purpose = (key: PurposeKey, change: Partial<NoticePurpose> = {}): NoticePurpose => ({
  key,
  version: 2,
  status: 'active',
  basis: 'employment',
  basisReference: null,
  retention: 'Until the person leaves, then 30 days',
  providers: [],
  ...change,
})
const clearance = (
  provider: ProviderKey,
  facts: NoticeFacts,
  change: Partial<NoticeClearance> = {},
): NoticeClearance => ({
  id: `c0000000-0000-4000-8000-${String(NON_AI_PROVIDERS.indexOf(provider) + 1).padStart(12, '0')}`,
  provider,
  facts,
  reviewOn: '2027-10-01',
  ...change,
})

// What a new org's register and the bootstrap make, once the DPO has recorded the bases and their
// contact: the pinned purposes, security_audit and backups active, Twilio and AWS cleared, the rest
// planned.
const input = (change: Partial<NoticeInput> = {}): NoticeInput => ({
  org: ORG,
  purposes: [
    purpose('accounts', { providers: ['twilio', 'aws'] }),
    purpose('service_operation', {
      basis: 'legitimate_interests',
      basisReference: 'Assessment LIA-01 in the DPO’s file',
      retention: '14 days',
      providers: ['aws'],
    }),
    purpose('security_audit', {
      basis: 'other_exception',
      basisReference: 'PDPA First Schedule, Part 3, paragraph 2',
      retention: 'Seven years.',
    }),
    purpose('backups', { basis: 'business_improvement', retention: '35 days', providers: ['aws'] }),
    purpose('presence_receipts', { version: 1, status: 'planned', basis: null, retention: null }),
  ],
  clearances: [clearance('twilio', TWILIO), clearance('aws', AWS)],
  contact: CONTACT,
  ...change,
})
const withPurpose = (key: PurposeKey, change: Partial<NoticePurpose> = {}) => {
  const base = input()
  return { ...base, purposes: [...base.purposes.filter(p => p.key !== key), purpose(key, change)] }
}

// The body's blocks, each read as the screens read it (C0.9 PD-33).
type Line = { kind: 'section' | 'entry' | 'item' | 'paragraph'; text: string }
function lines(body: string): Line[] {
  return body.split('\n').flatMap((text): Line[] => {
    if (text === '') return []
    if (text.startsWith(NOTICE_LINE.entry)) return [{ kind: 'entry', text: text.slice(NOTICE_LINE.entry.length) }]
    if (text.startsWith(NOTICE_LINE.section)) return [{ kind: 'section', text: text.slice(NOTICE_LINE.section.length) }]
    if (text.startsWith(NOTICE_LINE.item)) return [{ kind: 'item', text: text.slice(NOTICE_LINE.item.length) }]
    return [{ kind: 'paragraph', text }]
  })
}
const of = (body: string, kind: Line['kind']) =>
  lines(body)
    .filter(line => line.kind === kind)
    .map(line => line.text)

// The lines of one section, up to the next.
function sectionOf(body: string, title: string): Line[] {
  const all = lines(body)
  const start = all.findIndex(line => line.kind === 'section' && line.text === title)
  if (start === -1) return []
  const end = all.findIndex((line, index) => index > start && line.kind === 'section')
  return all.slice(start + 1, end === -1 ? undefined : end)
}
const textOf = (section: readonly Line[]) => section.map(line => line.text).join('\n')

// The items under one entry of a section.
function itemsOf(body: string, title: string, name: string): string[] {
  const section = sectionOf(body, title)
  const start = section.findIndex(line => line.kind === 'entry' && line.text === name)
  if (start === -1) return []
  const end = section.findIndex((line, index) => index > start && line.kind === 'entry')
  return section
    .slice(start + 1, end === -1 ? undefined : end)
    .filter(line => line.kind === 'item')
    .map(line => line.text)
}

// A short, stable digest of a text (FNV-1a over its UTF-16 units, 64 bits), so NTG-09 can pin the
// output without node:crypto, which this package's types leave out.
function fnv1a(text: string): string {
  let hash = 0xcbf29ce484222325n
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i))
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

describe('NTG-01 C0.9 PD-36: the generator is pure and deterministic', () => {
  it('NTG-01: the same registers give the same words, whatever order they are read in', () => {
    const body = generateNotice(input())
    expect(generateNotice(input())).toBe(body)
    const shuffled = input()
    const reversed = {
      ...shuffled,
      purposes: [...shuffled.purposes].reverse(),
      clearances: [...shuffled.clearances].reverse(),
    }
    expect(generateNotice(reversed)).toBe(body)
    expect(noticeDigestText(noticeDraftSources(reversed, body))).toBe(
      noticeDigestText(noticeDraftSources(input(), body)),
    )
  })

  it('NTG-01 PD-34 PD-60: the draft’s sources are every active or retired purpose by key and every open clearance by id, the generator this one', () => {
    const retired = withPurpose('recording_meetings', { status: 'retired', version: 4 })
    const sources = noticeDraftSources(retired, 'The words')
    expect(sources.generator).toBe(NOTICE_GENERATOR)
    expect(sources.body).toBe('The words')
    expect(sources.purposes).toEqual([
      { key: 'accounts', version: 2 },
      { key: 'backups', version: 2 },
      { key: 'recording_meetings', version: 4 },
      { key: 'security_audit', version: 2 },
      { key: 'service_operation', version: 2 },
    ])
    expect(sources.clearances.map(c => c.provider)).toEqual(['aws', 'twilio'])
    expect(sources.clearances.map(c => c.id)).toEqual([...sources.clearances.map(c => c.id)].sort())
    expect(sources.contact).toEqual({
      version: 1,
      facts: { title: 'Data Protection Officer', email: 'dpo@notice.example', phone: null, postal: null },
    })
  })

  it('NTG-01 PD-36 PD-66: the digest’s text is sorted-key JSON of the words, the clearance ids, the contact’s settings version, the generator and each purpose’s version', () => {
    const text = noticeDigestText(noticeDraftSources(input(), 'The words'))
    expect(Object.keys(JSON.parse(text))).toEqual(['body', 'clearances', 'contact', 'generator', 'purposes'])
    expect(JSON.parse(text).purposes).toEqual({ accounts: 2, backups: 2, security_audit: 2, service_operation: 2 })
    expect(JSON.parse(text).contact).toBe(1)
    const base = noticeDraftSources(input(), 'The words')
    for (const change of [
      { body: 'Other words' },
      { generator: 'c09.3' },
      { purposes: [...base.purposes.slice(1), { key: 'accounts' as const, version: 3 }] },
      { clearances: base.clearances.slice(1) },
      { contact: null },
      { contact: { version: 2, facts: base.contact?.facts ?? CONTACT } },
    ]) {
      expect(noticeDigestText({ ...base, ...change }), JSON.stringify(change).slice(0, 60)).not.toBe(text)
    }
  })
})

describe('NTG-02 C0.9 PD-33 PD-35 PD-53: every section and every basis', () => {
  const body = generateNotice(input())

  it('NTG-02 PD-35: the sections, in order; no version number and no date', () => {
    expect(of(body, 'section')).toEqual([
      NOTICE_SECTIONS.about,
      NOTICE_SECTIONS.purposes,
      NOTICE_SECTIONS.withdraw,
      NOTICE_SECTIONS.doesNot,
      NOTICE_SECTIONS.providers,
      NOTICE_SECTIONS.firstCode,
      NOTICE_SECTIONS.production,
      NOTICE_SECTIONS.rights,
    ])
    expect(body).not.toMatch(/\bversion \d|\b20\d\d-\d\d-\d\d\b/i)
  })

  it('NTG-02 PD-33: blocks are one heading, paragraph or list, with one blank line between them, and no line has spaces at its ends', () => {
    expect(body).not.toMatch(/\n{3}|^\n|\n$/)
    for (const block of body.split('\n\n')) {
      const kinds = new Set(lines(block).map(line => line.kind))
      expect(block.split('\n').length === 1 || (kinds.size === 1 && kinds.has('item')), block).toBe(true)
    }
    for (const text of body.split('\n')) expect(text, text).toBe(text.trim())
  })

  it('NTG-02 D28 PRD §8.18: acknowledging records that you were told and isn’t consent', () => {
    const about = textOf(sectionOf(body, NOTICE_SECTIONS.about))
    expect(about).toContain(`what personal data Hearth processes for ${ORG}`)
    expect(about).toContain('Acknowledging it records that you were told. It is not consent to any purpose')
  })

  it('NTG-02 PDPA-02: each active purpose, in the registry’s order, with its basis, retention and providers', () => {
    const why = sectionOf(body, NOTICE_SECTIONS.purposes)
    expect(why.filter(line => line.kind === 'entry').map(line => line.text)).toEqual([
      PURPOSES.accounts.register,
      PURPOSES.service_operation.register,
      PURPOSES.security_audit.register,
      PURPOSES.backups.register,
    ])
    expect(itemsOf(body, NOTICE_SECTIONS.purposes, PURPOSES.accounts.register)).toEqual([
      "Legal basis: the PDPA's exception for managing the employment relationship, which needs no consent.",
      'Kept for: Until the person leaves, then 30 days.',
      'Shared with: Amazon Web Services and Twilio Verify.',
    ])
    // A retention that closes itself gets no second full stop; a purpose with no provider says so.
    expect(itemsOf(body, NOTICE_SECTIONS.purposes, PURPOSES.security_audit.register).slice(1)).toEqual([
      'Kept for: Seven years.',
      'No provider receives it.',
    ])
  })

  it('NTG-02 PDPA-02 PD-38: each basis the notice may state has its own words; legitimate interests says so and how to learn more', () => {
    const basis = (body: string, key: PurposeKey) => itemsOf(body, NOTICE_SECTIONS.purposes, PURPOSES[key].register)[0]
    expect(basis(body, 'service_operation')).toBe(
      `Legal basis: the legitimate interests of ${ORG}, weighed against yours in a documented assessment (Assessment LIA-01 in the DPO’s file). Contact the Data Protection Officer to learn more.`,
    )
    expect(basis(body, 'security_audit')).toBe(
      'Legal basis: an exception or requirement in law (PDPA First Schedule, Part 3, paragraph 2).',
    )
    expect(basis(body, 'backups')).toBe(
      `Legal basis: business improvement, so ${ORG} uses only data it already holds and collects or discloses none for it.`,
    )
  })

  it('NTG-02 PDPA-02 PDPA-13 OD-10 PD-74: whether consent can be withdrawn, production access (PRD-101), and your rights with the DPO’s contact', () => {
    expect(textOf(sectionOf(body, NOTICE_SECTIONS.withdraw))).toBe(
      'None of the purposes under “Why your data is processed” rests on your consent, so they all continue if you withdraw it.',
    )
    expect(textOf(sectionOf(body, NOTICE_SECTIONS.production))).toContain('only through a separate emergency role')
    expect(sectionOf(body, NOTICE_SECTIONS.rights)).toEqual([
      {
        kind: 'paragraph',
        text: `You can request a copy of the personal data ${ORG} holds about you, have it corrected, or withdraw consent where a purpose rests on it.`,
      },
      {
        kind: 'paragraph',
        text: `To do any of these, or to raise a question or a complaint about how your personal data is handled, contact the Data Protection Officer of ${ORG}. You don't need a Hearth account for this, so it still works after you leave.`,
      },
      { kind: 'item', text: 'Role: Data Protection Officer' },
      { kind: 'item', text: 'Email: dpo@notice.example' },
      {
        kind: 'paragraph',
        text: "If you're not satisfied with the answer, you can complain to the Personal Data Protection Commission (PDPC).",
      },
    ])
    // The contact is printed, so the pointer to the employee data protection policy goes; the first
    // code's mention of that policy stays (OD-04).
    expect(textOf(sectionOf(body, NOTICE_SECTIONS.rights))).not.toContain('employee data protection policy')
    expect(textOf(sectionOf(body, NOTICE_SECTIONS.firstCode))).toContain('employee data protection policy')
  })

  it('NTG-02 PDPA-10 PDPA-02: each cleared provider, in the registry’s order, with what it does and receives, where, for how long, who else, and that it trains no models', () => {
    const providers = sectionOf(body, NOTICE_SECTIONS.providers)
    expect(providers.filter(line => line.kind === 'entry').map(line => line.text)).toEqual([
      NOTICE_PROVIDER_NAMES.aws,
      NOTICE_PROVIDER_NAMES.twilio,
    ])
    expect(itemsOf(body, NOTICE_SECTIONS.providers, NOTICE_PROVIDER_NAMES.twilio)).toEqual([
      'What it does: Verify: sign-in and re-authentication codes by SMS.',
      'What it receives: Mobile number, channel, Service SID.',
      'Where it processes and stores the data: United States.',
      'How long it keeps the data: Verification records for 90 days.',
      'Who it passes the data to: Mobile carriers.',
      'Model training: it trains no models on the data it receives.',
    ])
    expect(itemsOf(body, NOTICE_SECTIONS.providers, NOTICE_PROVIDER_NAMES.aws)).toEqual([
      'What it does: Hosting, storage and monitoring.',
      'What it receives: Everything Hearth stores.',
      'Where it processes the data: Singapore.',
      'Where it stores the data: Singapore and Japan.',
      'How long it keeps the data: As long as Hearth keeps it.',
      'Who it passes the data to: None.',
      `Model training: turned off for ${ORG}, so it trains no models on this data.`,
    ])
  })

  it('NTG-02 PD-53 decision 8: no branch of the generator holds wording AI_COPY refuses', () => {
    const branches: NoticeInput[] = [
      input(),
      input({ clearances: [] }),
      input({ purposes: [] }),
      withPurpose('service_operation', { basis: 'legitimate_interests', basisReference: null }),
      withPurpose('security_audit', { basis: 'other_exception', basisReference: null }),
      withPurpose('recording_meetings', { status: 'retired' }),
      withPurpose('recording_drop_in', { providers: ['livekit'] }),
      input({ clearances: [clearance('twilio', { ...TWILIO, processingCountries: [], training: null })] }),
      input({ clearances: NON_AI_PROVIDERS.map(provider => clearance(provider, AWS)) }),
      withPurpose('presence_receipts', { basis: 'deemed_consent_conduct' }),
      input({ contact: { ...CONTACT, phone: PHONE, postal: POSTAL } }),
      input({ contact: { ...CONTACT, email: null, postal: POSTAL } }),
    ]
    for (const branch of branches) {
      const body = generateNotice(branch)
      expect(aiCopyIn(body), body.slice(0, 80)).toBeUndefined()
      expect(body).not.toMatch(/\bI agree\b/i)
    }
    for (const title of Object.values(NOTICE_SECTIONS)) expect(aiCopyIn(title), title).toBeUndefined()
    for (const name of Object.values(NOTICE_PROVIDER_NAMES)) expect(aiCopyIn(name), name).toBeUndefined()
  })

  it('NTG-02 PD-33: an org with no active purpose still gets a whole notice, and the largest registers fit under NOTICE_BODY_MAX', () => {
    expect(of(generateNotice(input({ purposes: [] })), 'paragraph')).toContain(
      `Hearth processes no personal data for ${ORG} yet.`,
    )
    // Every non-AI purpose active and every provider cleared, each field at the most its column
    // holds (0009), 60 of the longest-named countries where it processes and 60 more where it
    // stores, a 200-character org name, and every channel of the DPO's contact at its longest
    // (0011).
    const long = (n: number) => 'é'.repeat(n)
    const longest = Object.entries(NOTICE_COUNTRY_NAMES)
      .sort(([, a], [, b]) => b.length - a.length)
      .map(([code]) => code)
    const largest: NoticeInput = {
      org: long(200),
      purposes: NON_AI_PURPOSE_KEYS.map(key =>
        purpose(key, {
          basis: 'legitimate_interests',
          basisReference: long(1000),
          retention: long(1000),
          providers: NON_AI_PROVIDERS,
        }),
      ),
      clearances: NON_AI_PROVIDERS.map(provider =>
        clearance(provider, {
          services: long(500),
          dataTypes: long(1000),
          processingCountries: longest.slice(0, 60).sort(),
          storageCountries: longest.slice(60, 120).sort(),
          training: 'off',
          providerRetention: long(1000),
          onwardRecipients: long(1000),
        }),
      ),
      contact: {
        version: 1,
        title: long(120),
        email: `${'a'.repeat(64)}@${'b'.repeat(185)}.org`,
        phone: `+1${' 2'.repeat(14)}`,
        postal: long(500),
      },
    }
    expect(largest.contact?.email).toHaveLength(254)
    expect(largest.contact?.phone).toHaveLength(30)
    expect([...generateNotice(largest)].length).toBeLessThan(NOTICE_BODY_MAX)
  })
})

describe('NTG-03 C0.9 OD-04: the first sign-in code, only when Twilio is cleared', () => {
  it('NTG-03 OD-04: with Twilio cleared, the notice says the first code went to Twilio Verify before it could be read, and where', () => {
    const first = textOf(sectionOf(generateNotice(input()), NOTICE_SECTIONS.firstCode))
    expect(first).toBe(
      `To send your first sign-in code, your mobile number went to Twilio Verify before you could read this notice. Your invitation and the employee data protection policy of ${ORG} told you it would.\nWhere Twilio Verify processes it: United States.`,
    )
    const twoCountries = input({ clearances: [clearance('twilio', { ...TWILIO, processingCountries: ['IE', 'US'] })] })
    expect(textOf(sectionOf(generateNotice(twoCountries), NOTICE_SECTIONS.firstCode))).toContain(
      'Where Twilio Verify processes it: Ireland and United States.',
    )
  })

  it('NTG-03 OD-04: without Twilio cleared there is no such section, even where a purpose lists Twilio', () => {
    const body = generateNotice(input({ clearances: [clearance('aws', AWS)] }))
    expect(of(body, 'section')).not.toContain(NOTICE_SECTIONS.firstCode)
    expect(body).not.toMatch(/first sign-in code/)
  })
})

describe('NTG-04 C0.9 PD-35 D41: what the notice never lists', () => {
  it('NTG-04 PD-35: planned purposes are left out, and retired ones only in their own section', () => {
    const body = generateNotice(withPurpose('recording_meetings', { status: 'retired' }))
    const why = sectionOf(body, NOTICE_SECTIONS.purposes).map(line => line.text)
    expect(why).not.toContain(PURPOSES.presence_receipts.register)
    expect(why).not.toContain(PURPOSES.recording_meetings.register)
    expect(body).not.toContain(PURPOSES.presence_receipts.register)
    expect(noticeDraftSources(input(), null).purposes.map(p => p.key)).not.toContain('presence_receipts')
  })

  it('NTG-04 D41 PD-38: the generator refuses what can’t be in a notice, which noticeProblems() or the server holds back first', () => {
    const refused: [string, NoticeInput][] = [
      ['an AI purpose', withPurpose('org_brain', { status: 'planned' })],
      ['an AI provider listed', withPurpose('backups', { providers: ['bedrock'] })],
      ['an AI provider cleared', input({ clearances: [clearance('openai' as ProviderKey, AWS)] })],
      ['a purpose twice', input({ purposes: [purpose('accounts'), purpose('accounts')] })],
      ['a provider cleared twice', input({ clearances: [clearance('aws', AWS), clearance('aws', AWS)] })],
      ['no basis', withPurpose('backups', { basis: null })],
      ['consent', withPurpose('backups', { basis: 'consent' })],
      ['s15A', withPurpose('backups', { basis: 'deemed_consent_notification', basisReference: 'x' })],
      ['no retention', withPurpose('backups', { retention: '  ' })],
      [
        'a retired purpose with no retention',
        withPurpose('recording_meetings', { status: 'retired', retention: null }),
      ],
      ['no org name', input({ org: ' \n ' })],
      ['no contact for the DPO (C0.9 PD-68)', input({ contact: null })],
      ['a contact with no channel', input({ contact: { ...CONTACT, email: '  ' } })],
      ['a contact with no role title', input({ contact: { ...CONTACT, title: '' } })],
    ]
    for (const [label, refusedInput] of refused) expect(() => generateNotice(refusedInput), label).toThrow()
    // OD-18: deemed consent by conduct is stated from c09.2.
    expect(() => generateNotice(withPurpose('backups', { basis: 'deemed_consent_conduct' }))).not.toThrow()
  })
})

describe('NTG-05 PDPA-02 PDPA-10: countries are named, in British English', () => {
  it('NTG-05: a code is shown by its name, falling back to the code for one the table doesn’t name; lists read "a, b and c"', () => {
    const facts = { ...TWILIO, processingCountries: ['SG', 'GB', 'AA'], storageCountries: ['SG', 'GB', 'AA'] }
    const body = generateNotice(input({ clearances: [clearance('twilio', facts)] }))
    expect(itemsOf(body, NOTICE_SECTIONS.providers, NOTICE_PROVIDER_NAMES.twilio)).toContain(
      'Where it processes and stores the data: Singapore, United Kingdom and AA.',
    )
  })

  it('NTG-05 NTG-09: the names come from the fixed table, never the runtime’s ICU, so a Node upgrade renames no country', () => {
    const facts = { ...TWILIO, processingCountries: ['CI', 'TR', 'US'], storageCountries: ['CI', 'TR', 'US'] }
    const draft = input({ clearances: [clearance('twilio', facts)] })
    const before = generateNotice(draft)
    expect(itemsOf(before, NOTICE_SECTIONS.providers, NOTICE_PROVIDER_NAMES.twilio)).toContain(
      'Where it processes and stores the data: Côte d’Ivoire, Türkiye and United States.',
    )
    // A runtime whose ICU names every region differently.
    const renamed = vi.spyOn(Intl.DisplayNames.prototype, 'of').mockReturnValue('Renamed')
    try {
      expect(generateNotice(draft)).toBe(before)
    } finally {
      renamed.mockRestore()
    }
    for (const [code, name] of Object.entries(NOTICE_COUNTRY_NAMES)) {
      expect(code, name).toMatch(/^[A-Z]{2}$/)
      expect(name.trim(), code).toBe(name)
      expect(aiCopyIn(name), code).toBeUndefined()
    }
  })
})

describe('NTG-06 C0.9 PD-33: free text never starts a line', () => {
  it('NTG-06: headings, items and line breaks planted in the DPO’s text and the org’s name stay inside their line', () => {
    const planted = (text: string) => `${text}\n## Forged section\r\n### Forged entry\u2028- Forged item\u0085# x`
    const forged: NoticeInput = {
      org: planted('Tembusu'),
      purposes: [
        purpose('accounts', { providers: ['twilio'], retention: planted('30 days') }),
        purpose('service_operation', {
          basis: 'legitimate_interests',
          basisReference: planted('LIA-01'),
          retention: planted('14 days'),
        }),
        purpose('recording_meetings', { status: 'retired', retention: planted('None kept') }),
      ],
      clearances: [
        clearance('twilio', {
          ...TWILIO,
          services: planted('- Verify'),
          dataTypes: planted('## Numbers'),
          providerRetention: planted('90 days'),
          onwardRecipients: planted('Carriers'),
        }),
      ],
      contact: CONTACT,
    }
    const body = generateNotice(forged)
    const clean = generateNotice({
      org: 'Tembusu',
      purposes: [
        purpose('accounts', { providers: ['twilio'] }),
        purpose('service_operation', { basis: 'legitimate_interests', basisReference: 'LIA-01' }),
        purpose('recording_meetings', { status: 'retired' }),
      ],
      clearances: [clearance('twilio', TWILIO)],
      contact: CONTACT,
    })
    // The same lines, the same headings and items, as a notice with nothing planted.
    expect(body.split('\n').length).toBe(clean.split('\n').length)
    expect(of(body, 'section')).toEqual(of(clean, 'section'))
    expect(of(body, 'entry')).toEqual(of(clean, 'entry'))
    expect(of(body, 'item').length).toBe(of(clean, 'item').length)
    for (const text of body.split('\n')) {
      const rest = text.replace(/^(?:### |## |- )/, '')
      expect(rest, text).not.toMatch(/^(?:Forged|#|- |Tembusu|LIA|Carriers|None kept|Numbers|30 days|14 days|90 days)/)
      expect(text, text).not.toMatch(/[\r\u2028\u0085]/)
    }
    expect(body).toContain('Forged section')
  })
})

describe('NTG-07 C0.9 PD-37 PD-38: what holds a draft back, and what it warns of', () => {
  it('NTG-07 PD-57 PD-68: a draft the registers allow has no problem, and warns that production access isn’t in place yet', () => {
    expect(noticeProblems(input(), null)).toEqual([])
    expect(noticeWarnings(input(), null, TODAY)).toEqual([{ code: 'production_access_pending' }])
  })

  it('NTG-07 PD-37: every problem at once comes in publish_notice()’s order, then the registry’s', () => {
    const base = input()
    const all: NoticeInput = {
      ...base,
      purposes: [
        ...base.purposes.filter(p => !['backups', 'security_audit', 'presence_receipts'].includes(p.key)),
        purpose('security_audit', { basis: null }),
        purpose('backups', { retention: null }),
        purpose('presence_receipts', { basis: 'deemed_consent_notification', basisReference: 'x' }),
        purpose('session_slides', { basis: 'deemed_consent_conduct' }),
        purpose('content_delivery', { providers: ['livekit', 'aws', 'livekit'] }),
      ],
      clearances: [
        clearance('twilio', { ...TWILIO, onwardRecipients: 'Carriers and their agents' }),
        clearance('aws', AWS),
      ],
      contact: null,
    }
    expect(noticeProblems(all, null)).toEqual([
      { code: 'purpose_basis_missing', purpose: 'security_audit' },
      { code: 'purpose_retention_missing', purpose: 'backups' },
      { code: 'purpose_consent_basis', purpose: 'presence_receipts' },
      { code: 'purpose_conduct_unstoppable', purpose: 'session_slides' },
      { code: 'provider_not_cleared', purpose: 'content_delivery', provider: 'livekit' },
      { code: 'dpo_contact_pending' },
      { code: 'free_text_ai_copy', provider: 'twilio', field: 'onward_recipients' },
    ])
  })

  it('NTG-07 PD-38 OD-18: consent and deemed consent by notification can’t be published yet; deemed consent by conduct can be written, and is held back only until its withdrawal is written down (PD-86)', () => {
    for (const basis of ['consent', 'deemed_consent_notification'] as const) {
      expect(noticeProblems(withPurpose('presence_receipts', { basis }), null), basis).toEqual([
        { code: 'purpose_consent_basis', purpose: 'presence_receipts' },
      ])
    }
    const conduct = withPurpose('presence_receipts', { basis: 'deemed_consent_conduct' })
    expect(noticeProblems(conduct, null)).toEqual([
      { code: 'purpose_conduct_unstoppable', purpose: 'presence_receipts' },
    ])
    expect(() => generateNotice(conduct)).not.toThrow()
    // A planned purpose holds nothing back, whatever it records.
    expect(noticeProblems(withPurpose('presence_receipts', { status: 'planned', basis: 'consent' }), null)).toEqual([])
  })

  it('NTG-07 PD-37: the latest version again is unchanged; the same words from moved sources only warn', () => {
    const body = generateNotice(input())
    const latest = noticeDraftSources(input(), body)
    expect(noticeProblems(input(), latest)).toEqual([{ code: 'unchanged' }])
    expect(noticeWarnings(input(), latest, TODAY).map(w => w.code)).toEqual(STANDING)
    // A new register version with the same entry, or a provider cleared again on the same facts.
    const bumped = withPurpose('backups', {
      basis: 'business_improvement',
      retention: '35 days',
      providers: ['aws'],
      version: 3,
    })
    const recleared = input({
      clearances: [clearance('twilio', TWILIO), clearance('aws', AWS, { id: 'c0000000-0000-4000-8000-0000000000ff' })],
    })
    for (const moved of [bumped, recleared]) {
      expect(generateNotice(moved)).toBe(body)
      expect(noticeProblems(moved, latest)).toEqual([])
      expect(noticeWarnings(moved, latest, TODAY).map(w => w.code)).toEqual(['same_text', ...STANDING])
    }
    // PD-48: the notice still says what the re-cleared draft would, since the provider states the
    // same facts; a purpose at a new register version it doesn't list yet (PD-40).
    expect(noticeSaysTheSame(noticeDraftSources(input(), body), latest)).toBe(true)
    expect(noticeSaysTheSame(noticeDraftSources(recleared, body), latest)).toBe(true)
    expect(noticeSaysTheSame(noticeDraftSources(bumped, body), latest)).toBe(false)
    // Other words are neither: an edit that changes what the notice says.
    const edited = withPurpose('backups', { basis: 'business_improvement', retention: '30 days', providers: ['aws'] })
    expect(noticeProblems(edited, latest)).toEqual([])
    expect(noticeWarnings(edited, latest, TODAY).map(w => w.code)).toEqual(STANDING)
    // Against a stand-in, nothing is ever unchanged.
    const standIn: NoticeSources = { generator: null, body, purposes: [], clearances: [], contact: null }
    expect(noticeProblems(input(), standIn)).toEqual([])
    expect(noticeSaysTheSame(noticeDraftSources(input(), body), { ...standIn, ...latest, generator: null })).toBe(false)
  })

  it('NTG-07 PD-37 PD-41: a provider no purpose lists, a review date due, and sends waiting for a version that states the facts', () => {
    const body = generateNotice(input())
    const latest = noticeDraftSources(input(), body)
    const changed = input({
      clearances: [
        clearance('twilio', { ...TWILIO, storageCountries: ['US', 'IE'] }),
        clearance('aws', AWS, { reviewOn: TODAY }),
        clearance('livekit', AWS, { reviewOn: '2026-10-01' }),
        clearance('apple_push', AWS, { reviewOn: '2026-10-24' }),
      ],
    })
    expect(noticeWarnings(changed, latest, TODAY)).toEqual([
      { code: 'provider_unlisted', provider: 'livekit' },
      { code: 'provider_unlisted', provider: 'apple_push' },
      { code: 'provider_review_due', provider: 'aws' },
      { code: 'provider_review_due', provider: 'livekit' },
      { code: 'sends_waiting', provider: 'twilio' },
      { code: 'sends_waiting', provider: 'livekit' },
      { code: 'sends_waiting', provider: 'apple_push' },
      { code: 'production_access_pending' },
    ])
    // Before any generated version, a clearance alone lets sends go (C0.9 PD-41): nothing waits.
    for (const before of [
      null,
      { generator: null, body: 'Local stand-in', purposes: [], clearances: [], contact: null },
    ]) {
      expect(noticeWarnings(changed, before, TODAY).map(w => w.code)).not.toContain('sends_waiting')
    }
  })
})

describe('NTG-09 C0.9 PD-36: NOTICE_GENERATOR names these exact words', () => {
  // One digest per generator id. A change to the words fails this: give the generator a new id and
  // pin its digest here, so every version records which words wrote it, and the DPO's tab shows the
  // notice out of date. Country names come from the generator's own table (NTG-05), so a Node
  // upgrade doesn't move it. c09.1's digest is of its draft before the contact was an input; c09.2
  // (C0.9 PR 3a) prints the fixture's contact too.
  const PINNED: Readonly<Record<string, string>> = { 'c09.1': '4c47a8c307f25504', 'c09.2': 'd5da6ef62a264896' }

  it('NTG-09: the output of a fixed draft has the digest pinned for this generator id, which 0010 admits', () => {
    expect(NOTICE_GENERATOR_PATTERN.test(NOTICE_GENERATOR)).toBe(true)
    const fixture = withPurpose('recording_drop_in', { status: 'retired', retention: 'None kept' })
    expect(fnv1a(generateNotice(fixture)), NOTICE_GENERATOR).toBe(PINNED[NOTICE_GENERATOR])
  })
})

describe('NTG-10 NTG-11 decision 5 C0.9 PD-58: what Hearth doesn’t do', () => {
  const clauses = (body: string) => of(body, 'item').filter(text => text.startsWith("Hearth doesn't "))

  it('NTG-10 PD-58: every purpose is in exactly one clause or exempt, with its reason, so a new purpose forces a decision', () => {
    const inClauses = DOES_NOT.flatMap(row => [...row.purposes])
    expect(new Set(inClauses).size).toBe(inClauses.length)
    const exempt = Object.keys(DOES_NOT_EXEMPT)
    for (const key of exempt) expect(inClauses, key).not.toContain(key)
    expect([...inClauses, ...exempt].sort()).toEqual([...PURPOSE_KEYS].sort())
    for (const reason of Object.values(DOES_NOT_EXEMPT)) expect(reason.length).toBeGreaterThan(10)
    // C-06's three clauses, none of them AI copy.
    expect(DOES_NOT.map(row => row.clause)).toEqual([
      'record calls, meetings or drop-in rooms',
      'transcribe anything',
      'summarise what you write or draft text from it',
    ])
    for (const row of DOES_NOT) expect(aiCopyIn(row.clause), row.clause).toBeUndefined()
  })

  it('NTG-11 decision 5: with nothing recorded or transcribed, all three print, and say nothing starts without a new version', () => {
    const body = generateNotice(input())
    expect(clauses(body)).toEqual([
      "Hearth doesn't record calls, meetings or drop-in rooms.",
      "Hearth doesn't transcribe anything.",
      "Hearth doesn't summarise what you write or draft text from it.",
    ])
    expect(textOf(sectionOf(body, NOTICE_SECTIONS.doesNot))).toContain(
      'None of these happens unless a new version of this notice says so and you have acknowledged it.',
    )
  })

  it('NTG-11 PD-58: recording either kind of session takes the recording clause out, and leaves the other two', () => {
    for (const key of ['recording_meetings', 'recording_drop_in'] as const) {
      expect(clauses(generateNotice(withPurpose(key))), key).toEqual([
        "Hearth doesn't transcribe anything.",
        "Hearth doesn't summarise what you write or draft text from it.",
      ])
    }
    // Sensitive-data detection is listed as a purpose, and the last clause still prints (C1.13).
    expect(clauses(generateNotice(withPurpose('sensitive_data_detection')))).toHaveLength(3)
  })

  it('NTG-11 decision 5 PD-58: whatever non-AI purposes are active, the transcription and AI clauses stay, and no clause contradicts a listed purpose', () => {
    const optional = NON_AI_PURPOSE_KEYS.filter(key => !PINNED_PURPOSES.includes(key))
    const recording = new Set<PurposeKey>(['recording_meetings', 'recording_drop_in'])
    for (let mask = 0; mask < 1 << optional.length; mask++) {
      const active = optional.filter((_, bit) => (mask & (1 << bit)) !== 0)
      const body = generateNotice({
        org: ORG,
        purposes: [...PINNED_PURPOSES, ...active].map(key => purpose(key)),
        clearances: [],
        contact: CONTACT,
      })
      const printed = clauses(body)
      expect(printed, active.join()).toContain("Hearth doesn't transcribe anything.")
      expect(printed, active.join()).toContain("Hearth doesn't summarise what you write or draft text from it.")
      expect(printed.includes("Hearth doesn't record calls, meetings or drop-in rooms."), active.join()).toBe(
        !active.some(key => recording.has(key)),
      )
    }
  })
})

describe('NTG-12 C0.9 PD-60: retired purposes are listed for good, with how long their data is kept', () => {
  it('NTG-12 PD-60: each retired purpose has an entry saying how long what it collected is kept, and no basis', () => {
    const body = generateNotice(
      withPurpose('recording_meetings', { status: 'retired', retention: 'None kept: deleted on 1 Oct 2026' }),
    )
    expect(itemsOf(body, NOTICE_SECTIONS.retired, PURPOSES.recording_meetings.register)).toEqual([
      'Data already collected is kept for: None kept: deleted on 1 Oct 2026.',
    ])
    expect(textOf(sectionOf(body, NOTICE_SECTIONS.retired))).not.toMatch(/Legal basis/)
    // C-04: the recording clause still prints beside it: nothing is recorded now.
    expect(of(body, 'item')).toContain("Hearth doesn't record calls, meetings or drop-in rooms.")
    expect(of(body, 'section').indexOf(NOTICE_SECTIONS.retired)).toBe(
      of(body, 'section').indexOf(NOTICE_SECTIONS.purposes) + 1,
    )
  })

  it('NTG-12 PD-60: with no retired purpose the section is left out', () => {
    expect(of(generateNotice(input()), 'section')).not.toContain(NOTICE_SECTIONS.retired)
  })
})

describe('NTG-13 C0.9 PD-62 decision 8: the DPO’s free text is held to AI_COPY at publish', () => {
  it('NTG-13 PD-62: a stated fact, a retention or a basis reference the notice would print, with wording AI_COPY refuses, holds publishing back, naming where and never quoting it', () => {
    const cases: [NoticeInput, object][] = [
      [
        input({
          clearances: [
            clearance('twilio', { ...TWILIO, onwardRecipients: 'Mobile carriers and their agents' }),
            clearance('aws', AWS),
          ],
        }),
        { code: 'free_text_ai_copy', provider: 'twilio', field: 'onward_recipients' },
      ],
      [
        input({
          clearances: [clearance('twilio', TWILIO), clearance('aws', { ...AWS, services: 'Hosting and Bedrock AI' })],
        }),
        { code: 'free_text_ai_copy', provider: 'aws', field: 'services' },
      ],
      [
        withPurpose('backups', { basis: 'business_improvement', retention: 'Ask the DPO' }),
        { code: 'free_text_ai_copy', purpose: 'backups', field: 'retention' },
      ],
      [
        withPurpose('service_operation', {
          basis: 'legitimate_interests',
          basisReference: 'Assessment of the assistant',
        }),
        { code: 'free_text_ai_copy', purpose: 'service_operation', field: 'basis_reference' },
      ],
      [
        withPurpose('recording_meetings', { status: 'retired', retention: 'Until the copilot is gone' }),
        { code: 'free_text_ai_copy', purpose: 'recording_meetings', field: 'retention' },
      ],
    ]
    for (const [planted, problem] of cases) {
      expect(noticeProblems(planted, null), JSON.stringify(problem)).toEqual([problem])
    }
    // Text the notice doesn't print, and the org's name, which the DPO doesn't set (C-05), aren't checked.
    expect(noticeProblems(input({ org: 'Agents of Change Pte Ltd' }), null)).toEqual([])
    expect(noticeProblems(withPurpose('presence_receipts', { status: 'planned', retention: 'Ask me' }), null)).toEqual(
      [],
    )
  })

  it('NTG-13 PD-62 decision 8: an org name AI_COPY refuses is never printed; the notice says "your organisation" instead', () => {
    const body = generateNotice(input({ org: 'Agents of Change Pte Ltd' }))
    expect(body).not.toContain('Agents of Change')
    expect(body).toContain('your organisation')
    expect(aiCopyIn(body)).toBeUndefined()
    // Any other name is printed as it is.
    expect(generateNotice(input({ org: 'Tembusu Logistics' }))).toContain('Tembusu Logistics')
  })
})

describe('NTG-14 PDPA-02 PDPA-13 C0.9 OD-10 OD-13 PD-74: “Your rights” gives the DPO’s contact', () => {
  const rights = (contact: NoticeInput['contact'], org = ORG) =>
    sectionOf(generateNotice(input({ org, contact })), NOTICE_SECTIONS.rights)
  const items = (contact: NoticeInput['contact']) =>
    rights(contact)
      .filter(line => line.kind === 'item')
      .map(line => line.text)

  it('NTG-14 PD-74: the role, then each channel recorded, in this order, as items with no full stop', () => {
    const lines = {
      email: 'Email: dpo@notice.example',
      phone: `Phone: ${PHONE}`,
      postal: 'Post: 1 Example Road, Singapore 000000',
    }
    for (let mask = 1; mask < 8; mask++) {
      const has = (bit: number) => (mask & bit) !== 0
      const contact = {
        ...CONTACT,
        email: has(1) ? CONTACT.email : null,
        phone: has(2) ? PHONE : null,
        postal: has(4) ? POSTAL : null,
      }
      expect(items(contact), String(mask)).toEqual([
        'Role: Data Protection Officer',
        ...(has(1) ? [lines.email] : []),
        ...(has(2) ? [lines.phone] : []),
        ...(has(4) ? [lines.postal] : []),
      ])
    }
    // An address that ends in a full stop of its own keeps it; none is added.
    expect(items({ ...CONTACT, title: 'Data Protection Officer, Tembusu Pte. Ltd.' })[0]).toBe(
      'Role: Data Protection Officer, Tembusu Pte. Ltd.',
    )
  })

  it('NTG-14 OD-13: you need no account to use it, so it works after you leave', () => {
    expect(textOf(rights(CONTACT))).toContain(
      "You don't need a Hearth account for this, so it still works after you leave.",
    )
  })

  it('NTG-14 PD-74: a postal address prints on one line, its lines joined with commas', () => {
    const postal = '1 Example Road\n#02-01 Example House\nSingapore 000000'
    expect(items({ ...CONTACT, email: null, postal })).toEqual([
      'Role: Data Protection Officer',
      'Post: 1 Example Road, #02-01 Example House, Singapore 000000',
    ])
    // Commas or semicolons typed at a line's end aren't doubled; a full stop (an abbreviation's) stays.
    for (const [typed, printed] of [
      ['1 Example Road,\nUnit #01-02,\nSingapore 000000', 'Post: 1 Example Road, Unit #01-02, Singapore 000000'],
      ['1 Example Road ;\n,\nSingapore 000000', 'Post: 1 Example Road, Singapore 000000'],
      ['1 Example St.\nSingapore 000000', 'Post: 1 Example St., Singapore 000000'],
    ] as const) {
      expect(items({ ...CONTACT, email: null, postal: typed })[1], typed).toBe(printed)
    }
  })

  it('NTG-14 PD-33: headings, items and line breaks planted in the contact stay inside their line', () => {
    const separator = String.fromCodePoint(0x2028)
    const planted = {
      ...CONTACT,
      title: 'Data Protection Officer\n## Forged section',
      postal: `1 Example Road\n- Forged item\r\n### Forged entry${separator}# x`,
    }
    const body = generateNotice(input({ contact: planted }))
    const clean = generateNotice(input({ contact: { ...CONTACT, postal: '1 Example Road' } }))
    expect(body.split('\n').length).toBe(clean.split('\n').length)
    expect(of(body, 'section')).toEqual(of(clean, 'section'))
    expect(of(body, 'entry')).toEqual(of(clean, 'entry'))
    expect(items(planted)).toEqual([
      'Role: Data Protection Officer ## Forged section',
      'Email: dpo@notice.example',
      'Post: 1 Example Road, - Forged item, ### Forged entry # x',
    ])
    expect(body).not.toMatch(/\r/)
    expect(body.includes(separator)).toBe(false)
  })

  it('NTG-14 PD-62: an org name AI_COPY refuses reads “your organisation” here too', () => {
    const text = textOf(rights(CONTACT, 'Agents of Change Pte Ltd'))
    expect(text).toContain('the personal data your organisation holds about you')
    expect(text).toContain('contact the Data Protection Officer of your organisation.')
    expect(text).not.toContain('Agents')
  })
})

describe('NTG-15 PDPA-04 C0.9 OD-18 PD-73 PD-86: deemed consent by conduct, and withdrawing it', () => {
  const conduct = (key: PurposeKey, change: Partial<NoticePurpose> = {}) =>
    purpose(key, { basis: 'deemed_consent_conduct', ...change })
  // The usual registers with these purposes in place of any of the same key.
  const withPurposes = (...purposes: NoticePurpose[]): NoticeInput => {
    const base = input()
    const keys = new Set(purposes.map(p => p.key))
    return { ...base, purposes: [...base.purposes.filter(p => !keys.has(p.key)), ...purposes] }
  }
  const withdraw = (draft: NoticeInput) => sectionOf(generateNotice(draft), NOTICE_SECTIONS.withdraw)

  it('NTG-15 PD-73: the basis item says it is your deemed consent, and points to how to withdraw it', () => {
    const body = generateNotice(withPurposes(conduct('presence_receipts')))
    expect(itemsOf(body, NOTICE_SECTIONS.purposes, PURPOSES.presence_receipts.register)[0]).toBe(
      'Legal basis: your deemed consent. You give this data yourself, for this purpose, and it is reasonable that you would. You can withdraw it, as “If you withdraw consent” below says.',
    )
  })

  it('NTG-15 PD-73: with no purpose on it, the section says the purposes listed all continue', () => {
    expect(withdraw(input())).toEqual([
      {
        kind: 'paragraph',
        text: 'None of the purposes under “Why your data is processed” rests on your consent, so they all continue if you withdraw it.',
      },
    ])
  })

  it('NTG-15 PD-73: with some, it lists only the active ones in the registry’s order, says the others listed continue, and how to withdraw', () => {
    const draft = withPurposes(
      conduct('session_slides'),
      conduct('presence_receipts'),
      conduct('people_insights', { status: 'retired' }),
    )
    expect(withdraw(draft)).toEqual([
      {
        kind: 'paragraph',
        text: 'These purposes rest on your deemed consent, so they stop for you if you withdraw it:',
      },
      { kind: 'item', text: PURPOSES.presence_receipts.register },
      { kind: 'item', text: PURPOSES.session_slides.register },
      {
        kind: 'paragraph',
        text: "The other purposes under “Why your data is processed” don't rest on consent, so they continue if you withdraw it.",
      },
      {
        kind: 'paragraph',
        text: "To withdraw, contact the Data Protection Officer, as “Your rights” below says. Hearth can't take a withdrawal in the app yet, so they carry it out by hand: they tell you first what withdrawing changes for you, and confirm once it has taken effect.",
      },
    ])
  })

  it('NTG-15 PD-60 PD-73: a retired purpose, even on a consent-type basis, is neither listed nor said to continue', () => {
    for (const basis of ['consent', 'deemed_consent_conduct', 'deemed_consent_notification'] as const) {
      const draft = withPurposes(purpose('people_insights', { status: 'retired', basis }))
      expect(noticeProblems(draft, null), basis).toEqual([])
      const body = generateNotice(draft)
      expect(textOf(withdraw(draft)), basis).toBe(
        'None of the purposes under “Why your data is processed” rests on your consent, so they all continue if you withdraw it.',
      )
      expect(textOf(withdraw(draft))).not.toContain(PURPOSES.people_insights.register)
      expect(textOf(sectionOf(body, NOTICE_SECTIONS.retired))).toContain(PURPOSES.people_insights.register)
    }
  })

  it('NTG-15 PD-38: consent and deemed consent by notification still can’t be written; deemed consent by conduct can', () => {
    for (const basis of ['consent', 'deemed_consent_notification'] as const) {
      const draft = withPurposes(purpose('presence_receipts', { basis, basisReference: 'x' }))
      expect(
        noticeProblems(draft, null).map(p => p.code),
        basis,
      ).toEqual(['purpose_consent_basis'])
      expect(() => generateNotice(draft), basis).toThrow()
    }
    expect(() => generateNotice(withPurposes(conduct('presence_receipts')))).not.toThrow()
  })

  it('NTG-15 PD-86: conductUnstoppable() with the real list, empty in C0, finds every active purpose on the basis; with a planted list, only the rest', () => {
    expect(CONDUCT_WITHDRAWABLE).toEqual([])
    const { purposes } = withPurposes(
      conduct('session_slides'),
      conduct('presence_receipts'),
      conduct('people_insights', { status: 'retired' }),
      conduct('access_logs', { status: 'planned' }),
    )
    expect(conductUnstoppable(purposes)).toEqual(['presence_receipts', 'session_slides'])
    expect(conductUnstoppable(purposes, ['session_slides'])).toEqual(['presence_receipts'])
    expect(conductUnstoppable(purposes, ['presence_receipts', 'session_slides'])).toEqual([])
    expect(conductUnstoppable(input().purposes)).toEqual([])
  })

  it('NTG-15 PD-86: purpose_conduct_unstoppable names its purpose, comes after purpose_consent_basis, and leaves the preview written', () => {
    const both = withPurposes(conduct('session_slides'), purpose('presence_receipts', { basis: 'consent' }))
    expect(noticeProblems(both, null)).toEqual([
      { code: 'purpose_consent_basis', purpose: 'presence_receipts' },
      { code: 'purpose_conduct_unstoppable', purpose: 'session_slides' },
    ])
    expect(NOTICE_PROBLEMS.indexOf('purpose_conduct_unstoppable')).toBe(
      NOTICE_PROBLEMS.indexOf('purpose_consent_basis') + 1,
    )
    // It holds back only publishing: the words are written, so the DPO can read them, and a latest
    // version with the same words is compared as usual.
    const alone = withPurposes(conduct('session_slides'))
    const body = generateNotice(alone)
    const latest = noticeDraftSources(alone, body)
    expect(noticeProblems(alone, latest)).toEqual([
      { code: 'purpose_conduct_unstoppable', purpose: 'session_slides' },
      { code: 'unchanged' },
    ])
  })
})

describe('NTG-16 PDPA-02 C0.9 OD-10 PD-65 PD-68: the DPO’s contact holds publishing back until it is recorded', () => {
  it('NTG-16 PD-68: no contact is a problem, and no draft can be written; with one there is none, and it is never a warning', () => {
    expect(noticeProblems(input({ contact: null }), null)).toEqual([{ code: 'dpo_contact_pending' }])
    expect(() => generateNotice(input({ contact: null }))).toThrow(
      'A notice gives the Data Protection Officer’s contact',
    )
    expect(noticeProblems(input(), null)).toEqual([])
    const latest = noticeDraftSources(input(), generateNotice(input()))
    for (const contact of [null, CONTACT]) {
      for (const before of [null, latest]) {
        const codes = noticeWarnings(input({ contact }), before, TODAY).map(warning => warning.code)
        expect(codes as string[]).not.toContain('dpo_contact_pending')
      }
    }
    // Unwritable: against the latest version it is never unchanged, and same_text isn't judged.
    expect(noticeProblems(input({ contact: null }), latest)).toEqual([{ code: 'dpo_contact_pending' }])
    expect(noticeWarnings(input({ contact: null }), latest, TODAY).map(w => w.code)).toEqual(STANDING)
  })

  it('NTG-16 PD-37: it sits in NOTICE_PROBLEMS order, after the purposes and providers and before the free text', () => {
    expect(NOTICE_PROBLEMS.indexOf('dpo_contact_pending')).toBe(NOTICE_PROBLEMS.indexOf('provider_not_cleared') + 1)
    expect(NOTICE_PROBLEMS.indexOf('free_text_ai_copy')).toBe(NOTICE_PROBLEMS.indexOf('dpo_contact_pending') + 1)
    const draft = input({
      contact: null,
      purposes: [...input().purposes, purpose('content_delivery', { providers: ['livekit'] })],
    })
    expect(noticeProblems(draft, null).map(p => p.code)).toEqual(['provider_not_cleared', 'dpo_contact_pending'])
  })

  it('NTG-16 PD-65: the contact’s free text with an AI_COPY word holds publishing back, naming its field and never the word', () => {
    const cases: [Partial<DpoContact>, string][] = [
      [{ title: 'Ask the Data Protection Officer' }, 'contact_title'],
      [{ email: 'agents@notice.example' }, 'contact_email'],
      [{ postal: 'Co-pilot House\nSingapore 000000' }, 'contact_postal'],
    ]
    for (const [change, field] of cases) {
      expect(noticeProblems(input({ contact: { ...CONTACT, ...change } }), null), field).toEqual([
        { code: 'free_text_ai_copy', field },
      ])
    }
    // A phone number holds no letter, so nothing of it is checked; and clean text holds nothing back.
    expect(noticeProblems(input({ contact: { ...CONTACT, phone: PHONE, postal: POSTAL } }), null)).toEqual([])
  })
})

describe('NTG-17 C0.9 PD-66 PD-67: the contact’s settings version is one of a version’s sources', () => {
  it('NTG-17 PD-66: the sources and the digest carry the settings version, and none while no contact is recorded', () => {
    const sources = noticeDraftSources(input(), 'The words')
    expect(sources.contact).toEqual({
      version: 1,
      facts: { title: CONTACT.title, email: CONTACT.email, phone: null, postal: null },
    })
    expect(JSON.parse(noticeDigestText(sources)).contact).toBe(1)
    const none = noticeDraftSources(input({ contact: null }), null)
    expect(none.contact).toBeNull()
    expect(JSON.parse(noticeDigestText(none)).contact).toBeNull()
    expect(noticeDigestText(noticeDraftSources(input({ contact: { ...CONTACT, version: 2 } }), 'The words'))).not.toBe(
      noticeDigestText(sources),
    )
  })

  it('NTG-17 PD-67: a new settings version with the same words is out of date and warns same_text; the same version says the same', () => {
    const body = generateNotice(input())
    const latest = noticeDraftSources(input(), body)
    expect(noticeProblems(input(), latest)).toEqual([{ code: 'unchanged' }])
    expect(noticeSaysTheSame(noticeDraftSources(input(), body), latest)).toBe(true)
    // The same details recorded again, as version 3 after a change and a change back.
    const again = input({ contact: { ...CONTACT, version: 3 } })
    expect(generateNotice(again)).toBe(body)
    expect(noticeProblems(again, latest)).toEqual([])
    expect(noticeWarnings(again, latest, TODAY).map(w => w.code)).toEqual(['same_text', ...STANDING])
    expect(noticeSaysTheSame(noticeDraftSources(again, body), latest)).toBe(false)
    // Other details are other words.
    const moved = input({ contact: { ...CONTACT, version: 2, email: 'privacy@notice.example' } })
    expect(generateNotice(moved)).not.toBe(body)
    expect(noticeWarnings(moved, latest, TODAY).map(w => w.code)).toEqual(STANDING)
  })

  it('NTG-17 PD-67: what changed says the contact was added after a version that printed none, changed when its details differ, and the same when they match; a contact-only change isn’t new wording', () => {
    const body = generateNotice(input())
    const now = noticeDraftSources(input(), body)
    const before = { ...now, generator: 'c09.1', body: 'Older words', contact: null }
    const standIn: NoticeSources = { generator: null, body: 'Stand-in', purposes: [], clearances: [], contact: null }
    expect(noticeChanges(before, now).contact).toBe('added')
    expect(noticeChanges(standIn, now).contact).toBe('added')
    const phoned = input({ contact: { ...CONTACT, version: 2, phone: PHONE } })
    const changed = noticeDraftSources(phoned, generateNotice(phoned))
    expect(noticeChanges(now, changed)).toEqual({
      purposes: NOTHING,
      providers: NOTHING,
      contact: 'changed',
      wording: false,
    })
    const again = noticeDraftSources(input({ contact: { ...CONTACT, version: 3 } }), body)
    expect(noticeChanges(now, again)).toEqual({
      purposes: NOTHING,
      providers: NOTHING,
      contact: 'same',
      wording: false,
    })
  })
})
