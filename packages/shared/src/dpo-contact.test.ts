// The DPO's business contact (PDPA-13, PDPA-02; C0.9 OD-10, PD-63 to PD-65, PD-69, PD-70): its
// shapes and limits, contactProblems(), the body and answers of /api/admin/notice/contact, and the
// links Settings makes. That contactProblems() and set_dpo_contact() (migration 0011) refuse the
// same samples is the notice integration suite's (NTI-12); the database's own checks are
// db/tests/165_dpo_settings.sql's. Every contact here is fictional, on a reserved domain.
import { describe, expect, it } from 'vitest'
import {
  CONTACT_EMAIL_MAX,
  CONTACT_EMAIL_PATTERN,
  CONTACT_FIELDS,
  CONTACT_PHONE_MAX,
  CONTACT_PHONE_PATTERN,
  CONTACT_POSTAL_MAX,
  CONTACT_PROBLEMS,
  CONTACT_STATED,
  CONTACT_TITLE_MAX,
  ContactAdminResponse,
  ContactAdminResponseForClient,
  type ContactField,
  ContactWriteResponse,
  ContactWriteResponseForClient,
  contactProblems,
  type DpoContact,
  flatText,
  mailtoHref,
  NoticeContact,
  NoticeContactForClient,
  normalisePostal,
  postalLines,
  postalOneLine,
  SetContactBody,
  sameContact,
  telHref,
} from './dpo-contact.ts'
import { NOTICE_STATUSES } from './registers.ts'

const char = (code: number) => String.fromCodePoint(code)
const NBSP = char(0xa0)
const LINE_SEPARATOR = char(0x2028)
const IDEOGRAPHIC_SPACE = char(0x3000)
const BELL = char(0x07)
const NEXT_LINE = char(0x85)
const SMILE = char(0x1f642)

// A whole contact, fictional: the role, a shared mailbox, a phone number in the seed's made-up range
// that no persona uses, and a postal address.
const CONTACT: DpoContact = {
  title: 'Data Protection Officer',
  email: 'dpo@contact.example',
  phone: '+65 8000 0197',
  postal: '1 Example Road\nSingapore 000000',
}
const only = (change: Partial<DpoContact>): DpoContact => ({
  ...CONTACT,
  email: null,
  phone: null,
  postal: null,
  ...change,
})

describe('DCS-01 C0.9 PD-64: the shapes and limits, at their edges', () => {
  it('DCS-01 PD-64: the limits are 0011’s, and the longest phone the pattern takes fits its limit', () => {
    expect([CONTACT_TITLE_MAX, CONTACT_EMAIL_MAX, CONTACT_PHONE_MAX, CONTACT_POSTAL_MAX]).toEqual([120, 254, 30, 500])
    expect([...CONTACT_FIELDS]).toEqual(['title', 'email', 'phone', 'postal'])
    const longest = `+1${' 2'.repeat(14)}`
    expect(longest).toHaveLength(CONTACT_PHONE_MAX)
    expect(CONTACT_PHONE_PATTERN.test(longest)).toBe(true)
    expect(CONTACT_PHONE_PATTERN.test(`${longest}3`)).toBe(false)
  })

  it('DCS-01 PD-64: an email address the notice prints exactly and Settings can link', () => {
    const label = (n: number) => `a${'b'.repeat(n - 2)}c`
    for (const email of [
      'dpo@contact.example',
      'a@b.co',
      'first.last+dpo@sub.contact.example',
      'o-k_1@x-1.example',
      `${'a'.repeat(64)}@contact.example`,
      `dpo@${label(63)}.example`,
      `dpo@contact.${'a'.repeat(63)}`,
    ]) {
      expect(CONTACT_EMAIL_PATTERN.test(email), email).toBe(true)
    }
    for (const email of [
      `${'a'.repeat(65)}@contact.example`,
      `dpo@${label(64)}.example`,
      `dpo@contact.${'a'.repeat(64)}`,
      'dpo@-contact.example',
      'dpo@contact-.example',
      'dpo@contact..example',
      'dpo@.example',
      'dpo@contact',
      'dpo@contact.c',
      'dpo@contact.c0',
      'dpo@contact.example.',
      '@contact.example',
      'dpo@@contact.example',
      'd po@contact.example',
      'dpo@contact.example?subject=x',
      'dpo%40@contact.example',
      'dpo#1@contact.example',
      '"dpo"@contact.example',
      "d'po@contact.example",
      'a&b@contact.example',
      `d${char(0xe9)}po@contact.example`,
      'dpo@contact.example\n',
    ]) {
      expect(CONTACT_EMAIL_PATTERN.test(email), JSON.stringify(email)).toBe(false)
    }
  })

  it('DCS-01 PD-64: a phone number in international format, 7 to 15 digits with single spaces or hyphens between', () => {
    for (const phone of [
      '+6580000197',
      '+65 8000 0197',
      '+65-8000-0197',
      '+1234567',
      '+123456789012345',
      '+1 2-3 4-5 6-7',
    ]) {
      expect(CONTACT_PHONE_PATTERN.test(phone), phone).toBe(true)
    }
    for (const phone of [
      '+123456',
      '+1234567890123456',
      '+0123456789',
      '6580000197',
      '+65  8000 0197',
      '+65 -8000 0197',
      '+65 8000 0197 ',
      '(+65) 8000 0197',
      '+65.8000.0197',
      '+65 8000 0197 ext 2',
      '+65 8000 0197-',
    ]) {
      expect(CONTACT_PHONE_PATTERN.test(phone), JSON.stringify(phone)).toBe(false)
    }
  })

  it('DCS-01 PD-64: limits count characters as Postgres does, in code points', () => {
    expect(contactProblems(only({ title: SMILE.repeat(CONTACT_TITLE_MAX), email: CONTACT.email }))).toEqual([])
    expect(contactProblems(only({ title: SMILE.repeat(CONTACT_TITLE_MAX + 1), email: CONTACT.email }))).toEqual([
      { code: 'title_long', field: 'title' },
    ])
    expect(contactProblems(only({ postal: SMILE.repeat(CONTACT_POSTAL_MAX) }))).toEqual([])
    expect(contactProblems(only({ postal: SMILE.repeat(CONTACT_POSTAL_MAX + 1) }))).toEqual([
      { code: 'postal_long', field: 'postal' },
    ])
    // An address the pattern takes but longer than 254 characters.
    const long = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.org`
    expect(long.length).toBeGreaterThan(CONTACT_EMAIL_MAX)
    expect(CONTACT_EMAIL_PATTERN.test(long)).toBe(true)
    expect(contactProblems(only({ email: long }))).toEqual([{ code: 'email_shape', field: 'email' }])
    expect(contactProblems(only({ email: long.slice(long.length - CONTACT_EMAIL_MAX).replace(/^\./, 'x') }))).toEqual(
      [],
    )
  })

  it('DCS-01 PD-64: a role title is one line, and a postal address plain text with no empty line, as Postgres reads [[:cntrl:]] and [[:space:]]', () => {
    for (const title of ['Data\nProtection', `Data${BELL}Protection`, `Data${NEXT_LINE}Protection`, 'Data\tOfficer']) {
      expect(contactProblems(only({ title, email: CONTACT.email })), JSON.stringify(title)).toEqual([
        { code: 'title_long', field: 'title' },
      ])
    }
    for (const postal of [
      '1 Example Road\n\nSingapore',
      '1 Example Road\n  \nSingapore',
      `1 Example Road\n${IDEOGRAPHIC_SPACE}\nSingapore`,
      `1 Example Road\n${LINE_SEPARATOR}\nSingapore`,
      `1 Example Road\tSingapore`,
      `1 Example Road\r\nSingapore`,
      `1 Example Road${BELL}`,
    ]) {
      expect(contactProblems(only({ postal })), JSON.stringify(postal)).toEqual([
        { code: 'postal_long', field: 'postal' },
      ])
    }
    // The database's [[:space:]] has no no-break space, so a line of one isn't empty there either.
    expect(contactProblems(only({ postal: `1 Example Road\n${NBSP}\nSingapore` }))).toEqual([])
    expect(contactProblems(only({ postal: '1 Example Road\nSingapore 000000' }))).toEqual([])
  })
})

describe('DCS-02 C0.9 PD-64 PD-65: contactProblems() mirrors set_dpo_contact()', () => {
  it('DCS-02: a contact the rules allow has no problem, with any one channel or all three', () => {
    expect(contactProblems(CONTACT)).toEqual([])
    for (const field of ['email', 'phone', 'postal'] as const) {
      expect(contactProblems(only({ [field]: CONTACT[field] })), field).toEqual([])
    }
  })

  it('DCS-02: each problem on its own, naming its field', () => {
    const cases: [Partial<DpoContact>, object][] = [
      [{ title: '' }, { code: 'title_missing', field: 'title' }],
      [{ title: 'x'.repeat(CONTACT_TITLE_MAX + 1) }, { code: 'title_long', field: 'title' }],
      [{ email: 'dpo at contact.example' }, { code: 'email_shape', field: 'email' }],
      [{ phone: '8000 0197' }, { code: 'phone_shape', field: 'phone' }],
      [{ postal: 'x'.repeat(CONTACT_POSTAL_MAX + 1) }, { code: 'postal_long', field: 'postal' }],
      [{ title: 'Ask the Data Protection Officer' }, { code: 'ai_copy', field: 'title' }],
    ]
    for (const [change, problem] of cases) {
      expect(contactProblems({ ...CONTACT, ...change }), JSON.stringify(change)).toEqual([problem])
    }
    expect(contactProblems(only({}))).toEqual([{ code: 'channel_missing' }])
  })

  it('DCS-02 OD-10: blank is not recorded, after trimming as String.prototype.trim() does', () => {
    expect(contactProblems({ title: '  ', email: ' ', phone: '', postal: '\n\t' })).toEqual([
      { code: 'title_missing', field: 'title' },
      { code: 'channel_missing' },
    ])
    expect(contactProblems({ title: null, email: null, phone: null, postal: null })).toEqual([
      { code: 'title_missing', field: 'title' },
      { code: 'channel_missing' },
    ])
    // Whitespace at the ends goes, a no-break space included, as the function's trim removes it.
    expect(contactProblems({ ...CONTACT, email: `${NBSP} dpo@contact.example\n`, phone: ' +65 8000 0197 ' })).toEqual(
      [],
    )
  })

  it('DCS-02: every problem at once comes in set_dpo_contact()’s order, with the route’s AI_COPY check last', () => {
    expect(
      contactProblems({ title: 'Ask me', email: 'not an address', phone: '123', postal: 'Agent House\n\nSingapore' }),
    ).toEqual([
      { code: 'email_shape', field: 'email' },
      { code: 'phone_shape', field: 'phone' },
      { code: 'postal_long', field: 'postal' },
      { code: 'ai_copy', field: 'title' },
      { code: 'ai_copy', field: 'postal' },
    ])
    expect(contactProblems(only({ title: `${'x'.repeat(CONTACT_TITLE_MAX)}\ny` }))).toEqual([
      { code: 'title_long', field: 'title' },
      { code: 'channel_missing' },
    ])
    expect([...CONTACT_PROBLEMS]).toEqual([
      'title_missing',
      'title_long',
      'channel_missing',
      'email_shape',
      'phone_shape',
      'postal_long',
      'ai_copy',
    ])
  })

  it('DCS-02 PD-65 decision 8: AI_COPY is checked on the title, email and postal address as the notice prints them, naming the field and never the word', () => {
    const problems = contactProblems({
      title: 'Assistant to the DPO',
      email: 'agent@contact.example',
      phone: CONTACT.phone,
      postal: 'Copilot House\nSingapore 000000',
    })
    expect(problems).toEqual([
      { code: 'ai_copy', field: 'title' },
      { code: 'ai_copy', field: 'email' },
      { code: 'ai_copy', field: 'postal' },
    ])
    expect(JSON.stringify(problems)).not.toMatch(/assistant|agent|copilot/i)
    // Words on their own lines are checked as the notice joins them; nothing else is checked.
    expect(contactProblems({ ...CONTACT, postal: '1 Example Road\nAsk at reception' })).toEqual([
      { code: 'ai_copy', field: 'postal' },
    ])
    // A word that only holds one of them, as tasks holds ask, isn't one.
    expect(contactProblems({ ...CONTACT, title: 'Data Protection Officer, tasks and baskets' })).toEqual([])
  })
})

describe('DCS-03 C0.9 PD-64 PD-70: SetContactBody', () => {
  const body = {
    seen: null,
    title: '  Data Protection Officer ',
    email: ' dpo@contact.example ',
    phone: '',
    postal: `  1 Example Road \r\n\r\n  Singapore ${BELL}  000000\t\n${LINE_SEPARATOR}`,
  }

  it('DCS-03: it trims, reads blank as not recorded, and normalises the postal address’s lines', () => {
    expect(SetContactBody.parse(body)).toEqual({
      seen: null,
      title: 'Data Protection Officer',
      email: 'dpo@contact.example',
      phone: null,
      postal: '1 Example Road\nSingapore 000000',
    })
    expect(SetContactBody.parse({ ...body, seen: 3, title: '   ', email: null, postal: ' \n ' })).toMatchObject({
      seen: 3,
      title: null,
      email: null,
      postal: null,
    })
    // The role title is one line: a pasted tab or another control character, or a run of spaces,
    // is one space (flatText()), so contactProblems() never reads a title that looks like one line
    // as not one.
    const flat = SetContactBody.parse({ ...body, title: ` Data\tProtection${BELL}  Officer ` })
    expect(flat.title).toBe('Data Protection Officer')
    expect(contactProblems(flat)).toEqual([])
    expect(normalisePostal('a\rb\r\nc\nd')).toBe('a\nb\nc\nd')
    expect(normalisePostal(`  a ${NEXT_LINE} b  \n\n  `)).toBe('a b')
  })

  it('DCS-03: a wrong shape still parses, so the page explains it; a malformed body doesn’t', () => {
    const parsed = SetContactBody.parse({ ...body, email: 'not an address', phone: '8000 0197' })
    expect(parsed).toMatchObject({ email: 'not an address', phone: '8000 0197' })
    expect(contactProblems(parsed)).toEqual([
      { code: 'email_shape', field: 'email' },
      { code: 'phone_shape', field: 'phone' },
    ])
    // A long value is a problem the page words, not a bad request, up to bounds no field reaches.
    expect(SetContactBody.safeParse({ ...body, title: 'x'.repeat(480) }).success).toBe(true)
    for (const bad of [
      { ...body, extra: 1 },
      { ...body, seen: undefined },
      { ...body, seen: 0 },
      { ...body, seen: 1.5 },
      { ...body, title: null },
      { ...body, title: 'x'.repeat(481) },
      { ...body, email: 'x'.repeat(1001) },
      { ...body, phone: 7 },
      { ...body, postal: 'x'.repeat(2001) },
      { ...body, person: 'b0000000-0000-4000-8000-000000000001' },
    ]) {
      expect(SetContactBody.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false)
    }
  })

  it('DCS-03: its answer is the version and whether anything changed', () => {
    expect(ContactWriteResponse.parse({ version: 2, changed: true })).toEqual({ version: 2, changed: true })
    for (const bad of [
      { version: 0, changed: true },
      { version: 2 },
      { version: 2, changed: false, contact: CONTACT },
    ]) {
      expect(ContactWriteResponse.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
    expect(ContactWriteResponseForClient.parse({ version: 2, changed: false, later: 1 })).toEqual({
      version: 2,
      changed: false,
    })
  })
})

describe('DCS-04 C0.9 PD-69: the links Settings makes', () => {
  it('DCS-04: mailto: takes the address as it is, and tel: the + and the digits', () => {
    expect(mailtoHref('dpo@contact.example')).toBe('mailto:dpo@contact.example')
    expect(telHref('+65 8000-0197')).toBe('tel:+6580000197')
    expect(telHref('+6580000197')).toBe('tel:+6580000197')
  })

  it('DCS-04 PD-64: no address the pattern takes holds anything a mailto: URL reads specially', () => {
    for (let code = 0x20; code < 0x7f; code++) {
      const c = char(code)
      const allowed = /[A-Za-z0-9._+-]/.test(c)
      expect(CONTACT_EMAIL_PATTERN.test(`d${c}po@contact.example`), JSON.stringify(c)).toBe(allowed)
      expect(CONTACT_EMAIL_PATTERN.test(`dpo@con${c}tact.example`), JSON.stringify(c)).toBe(/[A-Za-z0-9.-]/.test(c))
    }
    for (const special of ['?', '&', '%', '#', '"', "'", ' ', '<', '>', ':', '/', '\\']) {
      expect(CONTACT_EMAIL_PATTERN.test(`d${special}po@contact.example`), special).toBe(false)
    }
  })
})

describe('DCS-05 C0.9 PD-67 PD-74: comparing contacts and printing a postal address', () => {
  it('DCS-05 PD-67: two contacts are the same only when every field is', () => {
    expect(sameContact(CONTACT, { ...CONTACT })).toBe(true)
    expect(sameContact(only({ email: 'dpo@contact.example' }), only({ email: 'dpo@contact.example' }))).toBe(true)
    const changes: Partial<DpoContact>[] = [
      { title: 'Data protection officer' },
      { email: null },
      { email: 'DPO@contact.example' },
      { phone: '+6580000197' },
      { postal: '1 Example Road\nSingapore  000000' },
      { postal: '' },
    ]
    for (const change of changes)
      expect(sameContact(CONTACT, { ...CONTACT, ...change }), JSON.stringify(change)).toBe(false)
  })

  it('DCS-05 PD-74: Settings shows a postal address’s lines, and the notice prints them on one line joined with commas', () => {
    expect(postalLines(CONTACT.postal ?? '')).toEqual(['1 Example Road', 'Singapore 000000'])
    expect(postalOneLine(CONTACT.postal ?? '')).toBe('1 Example Road, Singapore 000000')
    // Stored as a direct writer might store it (the route normalises first): lines trimmed, empty ones left out.
    expect(postalLines(' 1 Example Road \n\n Singapore ')).toEqual(['1 Example Road', 'Singapore'])
    expect(postalOneLine('One line')).toBe('One line')
  })

  it('DCS-05 PD-33: flatText() puts free text on one line, as the notice prints it', () => {
    expect(flatText(`  a \n\t b\r\nc${LINE_SEPARATOR}d${BELL}e  `)).toBe('a b c d e')
    expect(flatText('')).toBe('')
  })
})

describe('DCS-06 C0.9 PD-70 P6: GET /api/admin/notice/contact and the contact GET /api/notice carries', () => {
  const row = { version: 2, ...CONTACT, recordedOn: '2026-10-23', recordedBy: 'Ashton Tan' }
  const answer = { notice: 'out_of_date', contact: row, stated: 'not_stated' }

  it('DCS-06 PD-70: the answer is the notice’s status, the current contact and whether the latest version prints it, and nothing more', () => {
    expect(ContactAdminResponse.parse(answer)).toEqual(answer)
    const states: [string, string, boolean][] = [
      ['none', 'unpublished', true],
      ['up_to_date', 'stated', false],
      ['out_of_date', 'not_printed', true],
      ['out_of_date', 'not_stated', false],
    ]
    expect(states.map(([, stated]) => stated)).toEqual([...CONTACT_STATED])
    for (const [notice, stated, none] of states) {
      expect(ContactAdminResponse.parse({ notice, contact: row, stated }).stated, stated).toBe(stated)
      // No contact recorded yet: nothing published, or a latest version that prints none.
      expect(ContactAdminResponse.safeParse({ notice, contact: null, stated }).success, stated).toBe(none)
    }
    for (const notice of NOTICE_STATUSES) {
      expect(ContactAdminResponse.safeParse({ notice, contact: row, stated: 'unpublished' }).success, notice).toBe(
        notice === 'none',
      )
    }
    for (const bad of [
      { ...answer, extra: 1 },
      { ...answer, stated: 'printed' },
      { ...answer, contact: { ...row, version: 0 } },
      { ...answer, contact: { ...row, email: 'dpo at contact.example' } },
      { ...answer, contact: { ...row, phone: '8000 0197' } },
      { ...answer, contact: { ...row, title: '' } },
      { ...answer, contact: { ...row, title: SMILE.repeat(CONTACT_TITLE_MAX + 1) } },
      { ...answer, contact: { ...row, postal: 'x'.repeat(CONTACT_POSTAL_MAX + 1) } },
      { ...answer, contact: { ...row, email: null, phone: null, postal: null } },
      { ...answer, contact: { ...row, recordedOn: '23 Oct 2026' } },
      { ...answer, contact: { ...row, recordedBy: '' } },
      { ...answer, contact: { ...row, mobile: '+6580000101' } },
    ]) {
      expect(ContactAdminResponse.safeParse(bad).success, JSON.stringify(bad).slice(0, 140)).toBe(false)
    }
    expect(ContactAdminResponse.parse({ ...answer, contact: { ...row, recordedBy: null } }).contact?.recordedBy).toBe(
      null,
    )
  })

  it('DCS-06 P6: the web app reads each stated marker, shows none it can’t read, and fails on a contact it can’t read', () => {
    for (const stated of CONTACT_STATED) {
      expect(ContactAdminResponseForClient.parse({ ...answer, stated }).stated, stated).toBe(stated)
    }
    const read = ContactAdminResponseForClient.parse({
      ...answer,
      later: true,
      notice: 'stale',
      stated: 'printed',
      contact: { ...row, recordedBy: 7, later: 1 },
    })
    expect(read).toEqual({ notice: 'up_to_date', contact: { ...row, recordedBy: null }, stated: null })
    expect(ContactAdminResponseForClient.parse({ notice: 'none', contact: null }).stated).toBeNull()
    for (const contact of [{ ...row, email: 'dpo at contact.example' }, { ...row, title: 7 }, 'none', undefined]) {
      expect(ContactAdminResponseForClient.safeParse({ ...answer, contact }).success, JSON.stringify(contact)).toBe(
        false,
      )
    }
  })

  it('DCS-06 PD-69: the contact a version printed is the four fields, in the shapes Settings links', () => {
    expect(NoticeContact.parse(CONTACT)).toEqual(CONTACT)
    expect(NoticeContact.parse(only({ postal: CONTACT.postal }))).toEqual(only({ postal: CONTACT.postal }))
    for (const bad of [
      { ...CONTACT, version: 1 },
      { ...CONTACT, email: 'dpo@contact.example?cc=x' },
      only({}),
      { ...CONTACT, title: undefined },
    ]) {
      expect(NoticeContact.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
    expect(NoticeContactForClient.parse({ ...CONTACT, later: 1 })).toEqual(CONTACT)
    expect(NoticeContactForClient.safeParse({ ...CONTACT, phone: 'tel:+65' }).success).toBe(false)
    const fields: ContactField[] = ['title', 'email', 'phone', 'postal']
    expect(Object.keys(NoticeContactForClient.parse(CONTACT))).toEqual(fields)
  })
})
