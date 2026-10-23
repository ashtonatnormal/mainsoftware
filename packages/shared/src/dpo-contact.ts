// The DPO's business contact (PDPA-13, PDPA-02; C0.9 OD-10, PD-63, PD-64, PD-65), as the api, the
// DPO's contact page, the notice's generator and Settings share it: its fields and limits; the rules
// migration 0011 enforces on every write (set_dpo_contact() and dpo_settings' checks), mirrored here
// so the page can say what an entry still needs and the route can answer 400 before the database
// refuses; the links Settings makes from it; and the bodies and answers of
// /api/admin/notice/contact and of the contact GET /api/notice carries. It is a role title, never a
// person's name, and at least one way to reach the DPO outside Hearth, so leavers and people with no
// account can write (OD-10, OD-13). The database stays the one that decides: a rule here that
// drifts from 0011's lets a refusal through as HF006 (400 register_invalid), never a write. The
// problems are codes; the page words each (apps/web's strings), never this file.
//
// The server loads this file on Node (T2), and the package compiles with lib ES2024 and no DOM or
// Node types. It imports neither notice.ts nor notice-text.ts, which import it.
import { z } from 'zod'
import { aiCopyIn } from './ai-copy.ts'
import { NOTICE_STATUSES } from './registers.ts'
import { PersonName } from './web.ts'

// --- The contact (C0.9 PD-64) ------------------------------------------------------------------

export const CONTACT_FIELDS = ['title', 'email', 'phone', 'postal'] as const
export type ContactField = (typeof CONTACT_FIELDS)[number]

// Each field's limit, in characters as Postgres counts them (code points): 0011's dpo_settings
// checks. A role title is one line; a postal address keeps its lines.
export const CONTACT_TITLE_MAX = 120
export const CONTACT_EMAIL_MAX = 254
export const CONTACT_PHONE_MAX = 30 // +, 15 digits and 14 separators
export const CONTACT_POSTAL_MAX = 500

// 0011's dpo_settings_email and dpo_settings_phone, which set_dpo_contact() checks first. NTI-12
// holds both refusing the same samples. An email address in a shape the notice prints exactly and
// Settings links as mailto: with nothing a URL reads specially (no space, quote, ?, &, % or #); a
// phone number in international format, so people abroad can dial it: + and 7 to 15 digits, with
// single spaces or hyphens between them. Both are ASCII, so JavaScript and Postgres read them alike.
export const CONTACT_EMAIL_PATTERN =
  /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}$/
export const CONTACT_PHONE_PATTERN = /^\+[1-9](?:[ -]?[0-9]){6,14}$/

// One version of the contact, as dpo_settings stores it: trimmed, and null where not recorded.
export interface DpoContact {
  title: string
  email: string | null
  phone: string | null
  postal: string | null
}

// --- Text ----------------------------------------------------------------------------------------

// Postgres bounds text in code points, where a JavaScript string's length counts UTF-16 units.
const codePoints = (text: string) => [...text].length

// Free text (the DPO's, the org's name) as one line: every run of whitespace or control characters,
// line breaks of every kind included, becomes one space, and the ends are trimmed. The notice's
// generator writes free text this way, and the problems and the routes check it as it would print.
export const flatText = (text: string): string => text.replace(/[\s\p{Cc}]+/gu, ' ').trim()

// How the body reads a postal address (SetContactBody): line endings become \n, each line's runs of
// whitespace or control characters become one space and the line is trimmed, and empty lines go.
export function normalisePostal(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map(flatText)
    .filter(line => line !== '')
    .join('\n')
}

// A postal address's lines, as Settings shows them, and as one line, as the notice prints it.
export function postalLines(postal: string): string[] {
  return postal
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
}
export const postalOneLine = (postal: string): string => postalLines(postal).join(', ')

// Whether two contacts are the same: every field null in both or exactly equal.
export function sameContact(a: DpoContact, b: DpoContact): boolean {
  return CONTACT_FIELDS.every(field => a[field] === b[field])
}

// The links Settings makes (C0.9 PD-69). The email pattern admits nothing a mailto: URL reads
// specially, so the address needs no encoding; a tel: URL takes the digits and the + alone.
export const mailtoHref = (email: string): string => `mailto:${email}`
export const telHref = (phone: string): string => `tel:${phone.replace(/[ -]/g, '')}`

// --- What holds a contact back (C0.9 PD-64, PD-65) -----------------------------------------------

// Why a contact can't be saved, in the order set_dpo_contact() in 0011 refuses them (HF006, 400
// register_invalid), naming the field where there is one:
//   title_missing    no role title
//   title_long       over 120 characters, or not on one line
//   channel_missing  no email, phone or postal address (OD-10)
//   email_shape      an email address the notice can't print exactly or Settings link
//   phone_shape      a number not in international format
//   postal_long      a postal address over 500 characters, or not plain text
//   ai_copy          a field uses wording Hearth keeps off its screens (AI_COPY, decision 8): only
//                    the route checks it, before it calls the function, its one caller (PD-65)
export const CONTACT_PROBLEMS = [
  'title_missing',
  'title_long',
  'channel_missing',
  'email_shape',
  'phone_shape',
  'postal_long',
  'ai_copy',
] as const
export type ContactProblemCode = (typeof CONTACT_PROBLEMS)[number]

export interface ContactProblem {
  code: ContactProblemCode
  field?: ContactField
}

// Postgres's [[:cntrl:]] and [[:space:]] in the database's ctype (en_US.UTF-8): the first is \p{Cc}
// exactly, and the second JavaScript's \s without the no-break spaces (U+00A0, U+2007, U+202F) and
// U+FEFF, so a postal address is refused here exactly when 0011's check refuses it.
const CONTROL = /\p{Cc}/u
const EMPTY_LINE = /\n[\t\n\v\f\r \u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]*\n/u

// What holds the contact back, in CONTACT_PROBLEMS order, then CONTACT_FIELDS'. It reads the fields
// as set_dpo_contact() does: trimmed (String.prototype.trim()'s set, which the function's own trim
// matches), empty as not recorded, and counted in code points. It checks a postal address as given,
// so the page checks what the body will send (normalisePostal()). AI_COPY is checked on the title,
// the email address and the postal address, each as the notice prints it (a phone number holds no
// letter), and the problem names the field, never the word.
export function contactProblems(contact: Record<ContactField, string | null>): ContactProblem[] {
  const read = (field: ContactField) => {
    const text = contact[field]?.trim() ?? ''
    return text === '' ? null : text
  }
  const title = read('title')
  const email = read('email')
  const phone = read('phone')
  const postal = read('postal')
  const found: ContactProblem[] = []
  if (title === null) found.push({ code: 'title_missing', field: 'title' })
  else if (codePoints(title) > CONTACT_TITLE_MAX || CONTROL.test(title))
    found.push({ code: 'title_long', field: 'title' })
  if (email === null && phone === null && postal === null) found.push({ code: 'channel_missing' })
  if (email !== null && (codePoints(email) > CONTACT_EMAIL_MAX || !CONTACT_EMAIL_PATTERN.test(email))) {
    found.push({ code: 'email_shape', field: 'email' })
  }
  if (phone !== null && !CONTACT_PHONE_PATTERN.test(phone)) found.push({ code: 'phone_shape', field: 'phone' })
  if (
    postal !== null &&
    (codePoints(postal) > CONTACT_POSTAL_MAX || CONTROL.test(postal.replaceAll('\n', '')) || EMPTY_LINE.test(postal))
  ) {
    found.push({ code: 'postal_long', field: 'postal' })
  }
  const printed: [ContactField, string | null][] = [
    ['title', title],
    ['email', email],
    ['postal', postal === null ? null : postalOneLine(postal)],
  ]
  for (const [field, text] of printed) {
    if (text !== null && aiCopyIn(flatText(text)) !== undefined) found.push({ code: 'ai_copy', field })
  }
  return found
}

// --- The api: bodies and answers (C0.9 PD-70; apps/server/src/compliance/routes.ts and notice.ts) -

// A settings version (dpo_settings.version, an integer column, from 1).
const SettingsVersion = z.int().min(1).max(2_147_483_647)
// A day, YYYY-MM-DD, in the org's zone.
const Day = z.iso.date()

// Text the DPO types: trimmed, and null when blank, as the table stores it. The bounds are generous
// (UTF-16 units, several times the column's), so a long value is a problem the page words
// (contactProblems()), never a malformed body.
function typed(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform(text => (text === '' ? null : text))
}

// POST /api/admin/notice/contact/set: the settings version the page showed (null while none is
// recorded) and the contact, trimmed, with a blank field read as not recorded and the postal
// address's lines normalised (normalisePostal()). A wrong email or phone shape still parses, so it
// is a problem the page explains (400 register_invalid), not a bad request. The DPO comes from the
// session, never the body.
export const SetContactBody = z.strictObject({
  seen: SettingsVersion.nullable(),
  title: z
    .string()
    .trim()
    .max(480)
    .transform(text => (text === '' ? null : text)),
  email: typed(1000),
  phone: typed(1000),
  postal: z
    .string()
    .max(2000)
    .nullable()
    .transform(text => {
      const lines = text === null ? '' : normalisePostal(text)
      return lines === '' ? null : lines
    }),
})
export type SetContactJSON = z.input<typeof SetContactBody>

// Its answer: the current settings version, and whether this request recorded it (the same contact
// again records nothing).
export const ContactWriteResponse = z.strictObject({ version: SettingsVersion, changed: z.boolean() })
export type ContactWriteJSON = z.infer<typeof ContactWriteResponse>
export const ContactWriteResponseForClient = z.object({ version: z.int().min(1), changed: z.boolean() })

// Whether the published notice gives the current contact (C0.9 PD-70), which the contact page shows
// as a pill:
//   unpublished  no version is published yet
//   stated       the latest version prints this contact
//   not_printed  the latest version prints none: a stand-in, a c09.1 version, or no contact was
//                recorded when it was published
//   not_stated   the latest version prints an earlier contact
export const CONTACT_STATED = ['unpublished', 'stated', 'not_printed', 'not_stated'] as const
export type ContactStated = (typeof CONTACT_STATED)[number]

// A contact as stored: never blank, bounded as Postgres bounds it, and in the shapes 0011 admits,
// so a link Settings makes from it is always one the pattern allows.
const stored = (max: number) =>
  z
    .string()
    .min(1)
    .refine(text => codePoints(text) <= max, { message: `at most ${max} characters` })
const contactFacts = {
  title: stored(CONTACT_TITLE_MAX),
  email: z.string().max(CONTACT_EMAIL_MAX).regex(CONTACT_EMAIL_PATTERN).nullable(),
  phone: z.string().regex(CONTACT_PHONE_PATTERN).nullable(),
  postal: stored(CONTACT_POSTAL_MAX).nullable(),
}
const someChannel = (contact: Pick<DpoContact, 'email' | 'phone' | 'postal'>) =>
  contact.email !== null || contact.phone !== null || contact.postal !== null
const SOME_CHANNEL = { message: 'at least one channel outside Hearth (C0.9 OD-10)' }

// The current contact, for its page: its settings version, the contact, the day it was recorded in
// the org's zone, and who recorded it.
const contactRow = {
  version: SettingsVersion,
  ...contactFacts,
  recordedOn: Day,
  recordedBy: PersonName.nullable(),
}
const ContactRow = z.strictObject(contactRow).refine(someChannel, SOME_CHANNEL)

// GET /api/admin/notice/contact (C0.9 PD-70), under notice.read: whether the published notice is up
// to date with the registers (the Notice link's badge), the current contact (null until the DPO
// records one), and whether the latest version prints it. The server types its answer with this.
export const ContactAdminResponse = z
  .strictObject({
    notice: z.enum(NOTICE_STATUSES),
    contact: ContactRow.nullable(),
    stated: z.enum(CONTACT_STATED),
  })
  .refine(answer => (answer.notice === 'none') === (answer.stated === 'unpublished'), {
    message: 'unpublished exactly when no version is published',
  })
  .refine(answer => answer.contact !== null || answer.stated === 'unpublished' || answer.stated === 'not_printed', {
    message: 'a contact stated, or an earlier one, only once one is recorded',
  })
export type ContactAdminJSON = z.infer<typeof ContactAdminResponse>
export type ContactRowJSON = NonNullable<ContactAdminJSON['contact']>

// The web app's reading of the same answer (P6): fields added later are dropped, a notice marker it
// can't read claims nothing (no out-of-date badge), a name it can't read shows as nobody's, and a
// stated marker it can't read shows no pill. A contact it can't read fails the read, so the page
// shows the server's words with Try again, never a false "No contact details yet".
export const ContactAdminResponseForClient = z.object({
  notice: z.enum(NOTICE_STATUSES).catch('up_to_date'),
  contact: z
    .object({ ...contactRow, version: z.int().min(1), recordedBy: PersonName.nullable().catch(null) })
    .nullable(),
  stated: z.enum(CONTACT_STATED).nullable().catch(null),
})
export type ContactAdminForClient = z.infer<typeof ContactAdminResponseForClient>
export type ContactRowForClient = NonNullable<ContactAdminForClient['contact']>

// The contact a published version printed (GET /api/notice, C0.9 PD-69): Settings shows it to
// everyone, with mailto: and tel: links.
export const NoticeContact = z.strictObject(contactFacts).refine(someChannel, SOME_CHANNEL)
export type NoticeContactJSON = z.infer<typeof NoticeContact>
// The web app's reading of it: fields added later are dropped; every field is read as the strict
// schema reads it, so a link is only ever made from an address or number the pattern allows.
export const NoticeContactForClient = z.object(contactFacts)
export type NoticeContactForClientJSON = z.infer<typeof NoticeContactForClient>
