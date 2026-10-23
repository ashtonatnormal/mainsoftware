// Every word /notice and Settings can show, held to AI_COPY (decision 8, D41; C0.9 PD-53, PD-62):
// every branch of the generator whose body they render (packages/shared notice-text.ts, whose
// generator the web runs only here and in its own tests; notice/notice-model.ts and
// dpo/notice-model.ts read only its provider names), every label the changes callout can name, and
// every line of their own copy. The DPO's free text is the server's to refuse at publish
// (free_text_ai_copy); here it is plain wording, so only the generator's own words are tested. From
// C0.9 PR 3a (c09.2) that includes "Your rights" with every channel of the DPO's contact and the
// withdraw section's branches, deemed consent by conduct among the bases stated (OD-18, PD-73,
// PD-74).
import {
  BASES,
  type DpoContact,
  generateNotice,
  isNoticeHeldBasis,
  NON_AI_PROVIDERS,
  NON_AI_PURPOSE_KEYS,
  NOTICE_PROVIDER_NAMES,
  type NoticeClearance,
  type NoticeInput,
  type NoticePurpose,
  PURPOSES,
  type PurposeKey,
  TRAINING,
} from '@hearth/shared'
import { describe, expect, it } from 'vitest'
import { aiCopyIn } from '@/strings/ai-copy.ts'
import { ACK_METHODS, NOTICE, SETTINGS } from '@/strings/notice.ts'
import { parseNotice } from './NoticeBody.tsx'
import { changeLines } from './notice-model.ts'

const ORG = 'Tembusu Logistics'
// Every basis a version can state: deemed consent by conduct from c09.2 (C0.9 OD-18).
const STATED = BASES.filter(basis => !isNoticeHeldBasis(basis))

// The DPO's contact, made up, on a reserved domain: every channel, then each one alone.
const FULL: DpoContact = {
  title: 'Data Protection Officer',
  email: 'dpo@notice.example',
  phone: '+65 8000 0198',
  postal: '1 Example Road\nSingapore 000000',
}
const CONTACTS: readonly (DpoContact & { version: number })[] = [
  { ...FULL, version: 1 },
  { ...FULL, phone: null, postal: null, version: 2 },
  { ...FULL, email: null, postal: null, version: 3 },
  { ...FULL, email: null, phone: null, version: 4 },
]
const contactAt = (index: number) => CONTACTS[index % CONTACTS.length] ?? null

function purpose(
  key: PurposeKey,
  basis: (typeof STATED)[number],
  status: 'active' | 'retired' = 'active',
): NoticePurpose {
  return {
    key,
    version: 2,
    status,
    basis,
    basisReference: basis === 'legitimate_interests' || basis === 'other_exception' ? 'the 2026 assessment' : null,
    retention: '90 days after you leave',
    providers: NON_AI_PROVIDERS,
  }
}

function clearance(
  provider: (typeof NON_AI_PROVIDERS)[number],
  index: number,
  training: (typeof TRAINING)[number] | null,
): NoticeClearance {
  return {
    id: `f0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    provider,
    facts: {
      services: 'Sends one-time codes by text message',
      dataTypes: 'Mobile numbers',
      processingCountries: ['US'],
      storageCountries: index % 2 === 0 ? ['US'] : ['SG', 'US'],
      training,
      providerRetention: '90 days',
      onwardRecipients: 'Mobile carriers',
    },
    reviewOn: null,
  }
}

// Inputs that between them take every branch: each basis the notice states, with and without a
// reference; active and retired purposes; none; every provider, with each training answer and
// none, and stored where it processes or elsewhere; Twilio, whose entry brings OD-04's paragraph,
// and none; the contact with every channel and with each alone; and a purpose on deemed consent by
// conduct among others, so the withdraw section names it.
function inputs(): NoticeInput[] {
  const all: NoticeInput[] = [{ org: ORG, purposes: [], clearances: [], contact: contactAt(0) }]
  STATED.forEach((basis, at) => {
    all.push({
      org: ORG,
      purposes: NON_AI_PURPOSE_KEYS.map(key => purpose(key, basis)),
      clearances: NON_AI_PROVIDERS.map((provider, index) => clearance(provider, index, TRAINING[index % 2] ?? null)),
      contact: contactAt(at),
    })
    all.push({
      org: ORG,
      purposes: NON_AI_PURPOSE_KEYS.map(key => ({ ...purpose(key, basis), basisReference: null })),
      clearances: [],
      contact: contactAt(at + 1),
    })
    all.push({
      org: ORG,
      purposes: NON_AI_PURPOSE_KEYS.map(key => ({ ...purpose(key, basis, 'retired'), basisReference: null })),
      clearances: NON_AI_PROVIDERS.map((provider, index) => clearance(provider, index, null)),
      contact: contactAt(at + 2),
    })
  })
  all.push({
    org: ORG,
    purposes: NON_AI_PURPOSE_KEYS.map((key, at) =>
      purpose(key, at % 2 === 0 ? 'deemed_consent_conduct' : 'legitimate_interests'),
    ),
    clearances: [],
    contact: contactAt(3),
  })
  return all
}

describe('C0.9 PD-53: the notice holds no AI copy', () => {
  it('NTW-10 decision 8 PD-62 PD-73 PD-74: no line of any body the generator can write matches AI_COPY (each channel of the contact and both branches of the withdraw section included), and each one parses into blocks /notice renders', () => {
    const bodies = inputs().map(generateNotice)
    expect(bodies.length).toBeGreaterThan(STATED.length * 2)
    for (const body of bodies) {
      const found = body.split('\n').filter(text => aiCopyIn(text) !== undefined)
      expect(found).toEqual([])
      expect(parseNotice(body).length).toBeGreaterThan(5)
    }
    // The branches were taken: the first code's paragraph and the retired section each show.
    expect(bodies.some(body => body.includes('Your first sign-in code'))).toBe(true)
    expect(bodies.some(body => body.includes('No longer in use'))).toBe(true)
    expect(bodies.some(body => body.includes('Model training'))).toBe(true)
    // c09.2's branches (C0.9 PD-73, PD-74): every channel of the contact, and both withdraw branches.
    for (const item of ['- Role: ', '- Email: ', '- Phone: ', '- Post: 1 Example Road, Singapore 000000']) {
      expect(
        bodies.some(body => body.includes(item)),
        item,
      ).toBe(true)
    }
    expect(bodies.some(body => body.includes('so they all continue if you withdraw it.'))).toBe(true)
    expect(bodies.some(body => body.includes('These purposes rest on your deemed consent'))).toBe(true)
  })

  it('NTW-10 decision 8: every label the changes callout can name, and every line of /notice’s and Settings’ copy, holds none', () => {
    const lines = changeLines({
      since: 0,
      purposes: { added: [...NON_AI_PURPOSE_KEYS], changed: [], removed: [] },
      providers: { added: [], changed: [...NON_AI_PROVIDERS], removed: [] },
      contact: 'changed',
      wording: true,
    })
    const labels = [...(lines?.added ?? []), ...(lines?.changed ?? [])]
    expect(labels).toHaveLength(NON_AI_PURPOSE_KEYS.length + NON_AI_PROVIDERS.length)
    for (const key of NON_AI_PURPOSE_KEYS) expect(labels).toContain(PURPOSES[key].register)
    for (const name of Object.values(NOTICE_PROVIDER_NAMES)) expect(labels).toContain(name)
    const copy = JSON.stringify([NOTICE, SETTINGS, ACK_METHODS, labels], (_key, value: unknown) =>
      typeof value === 'function' ? (value as (...args: string[]) => string)('X', 'X', 'X') : value,
    )
    expect(aiCopyIn(copy)).toBeUndefined()
  })
})
