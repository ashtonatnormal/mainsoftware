// The DPO's contact page, pure (PDPA-13, PDPA-02; C0.9 OD-10, OD-11, PD-64, PD-70): GET
// /api/admin/notice/contact's answer as the page shows it, the contact as its form holds it and as
// the body the api takes, what still holds a save back, and what a refused save says, so every
// state is tested in Node with no DOM (dpo/contact-model.test.ts, CTW-01 to CTW-05). The rules are
// packages/shared's (contactProblems, which the route runs before set_dpo_contact() in 0011 and the
// function enforces again); this module only feeds them the body the save would send and words
// their codes (strings/dpo-contact.ts). The page never decides whether the published notice gives
// the details: the answer's stated does (CONTACT_STATED).
import {
  type ContactAdminForClient,
  type ContactField,
  type ContactRowForClient,
  type ContactStated,
  contactProblems,
  normalisePostal,
  postalLines,
  type SetContactJSON,
} from '@hearth/shared'
import { dayText } from '@/lib/time.ts'
import { CONTACT, CONTACT_FIELD_NAMES, CONTACT_PROBLEM_COPY } from '@/strings/dpo-contact.ts'
import { type Fact, failureOf, type Refusal, refusalOf, textOrNull } from './model.ts'
import type { PillTone } from './parts.tsx'

// The title a first record starts from: the role, never a person's name (OD-10).
export const DEFAULT_TITLE = 'Data Protection Officer'

// --- The card --------------------------------------------------------------------------------------

export interface ContactPill {
  readonly tone: PillTone
  readonly text: string
}

export type ContactView =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'contact'
      readonly title: string
      // Whether the published notice gives these details, or none when the answer couldn't say.
      readonly pill: ContactPill | undefined
      // Under the pill when it doesn't: why, with a link to the Notice tab.
      readonly line: string | undefined
      readonly facts: readonly Fact[]
    }

const PILLS: Readonly<Record<ContactStated, ContactPill>> = {
  stated: { tone: 'ok', text: CONTACT.stated.yes },
  not_printed: { tone: 'warn', text: CONTACT.stated.no },
  not_stated: { tone: 'warn', text: CONTACT.stated.no },
  unpublished: { tone: 'muted', text: CONTACT.stated.none },
}

const LINES: Readonly<Partial<Record<ContactStated, string>>> = {
  not_printed: CONTACT.stated.notPrintedLine,
  not_stated: CONTACT.stated.noLine,
}

export function contactView(answer: Pick<ContactAdminForClient, 'contact' | 'stated'>): ContactView {
  const row = answer.contact
  if (row === null) return { kind: 'none' }
  const stated = answer.stated
  return {
    kind: 'contact',
    title: row.title,
    pill: stated === null ? undefined : PILLS[stated],
    line: stated === null ? undefined : LINES[stated],
    facts: [
      { term: CONTACT.card.email, value: row.email ?? CONTACT.card.notRecorded },
      { term: CONTACT.card.phone, value: row.phone ?? CONTACT.card.notRecorded },
      row.postal === null
        ? { term: CONTACT.card.postal, value: CONTACT.card.notRecorded }
        : { term: CONTACT.card.postal, value: postalLines(row.postal).join('\n'), lines: true },
      { term: CONTACT.card.recorded, value: CONTACT.recorded(dayText(row.recordedOn), row.recordedBy) },
    ],
  }
}

// --- The form --------------------------------------------------------------------------------------

export interface ContactForm {
  readonly title: string
  readonly email: string
  readonly phone: string
  readonly postal: string
}

// The current contact as the form starts from it, or, with none, the role's title alone.
export function contactFormOf(row: ContactRowForClient | null): ContactForm {
  if (row === null) return { title: DEFAULT_TITLE, email: '', phone: '', postal: '' }
  return { title: row.title, email: row.email ?? '', phone: row.phone ?? '', postal: row.postal ?? '' }
}

// POST /api/admin/notice/contact/set's body: the settings version the page read (null while none is
// recorded), and each field as the api reads it (SetContactBody): trimmed, a blank one not
// recorded, and the postal address's lines normalised (normalisePostal()).
export function contactBodyOf(row: ContactRowForClient | null, form: ContactForm): SetContactJSON {
  const postal = normalisePostal(form.postal)
  return {
    seen: row?.version ?? null,
    title: form.title.trim(),
    email: textOrNull(form.email),
    phone: textOrNull(form.phone),
    postal: postal === '' ? null : postal,
  }
}

// One line of what holds the save back, with the field it is about (none for a missing channel).
export interface ContactProblemLine {
  readonly field: ContactField | undefined
  readonly text: string
}

export interface ContactEditor {
  readonly problems: readonly ContactProblemLine[]
  // Saving makes the published notice out of date (OD-11): once a version is published.
  readonly stale: boolean
}

// What holds the save back, checked on the body the save would send (so stray spaces and blank
// lines the api drops are never held against the form), in contactProblems()' order; and whether a
// save makes the published notice out of date.
export function contactEditor(
  form: ContactForm,
  answer: Pick<ContactAdminForClient, 'contact' | 'notice'>,
): ContactEditor {
  const body = contactBodyOf(answer.contact, form)
  const problems = contactProblems({
    title: body.title,
    email: body.email,
    phone: body.phone,
    postal: body.postal,
  }).map(problem => ({
    field: problem.field,
    text: CONTACT_PROBLEM_COPY[problem.code](problem.field === undefined ? '' : CONTACT_FIELD_NAMES[problem.field]),
  }))
  return { problems, stale: answer.notice !== 'none' }
}

// --- Saving ----------------------------------------------------------------------------------------

// The toast once a save lands: the same contact again records nothing (PD-21's pattern).
export const contactSavedText = (result: { readonly changed: boolean }): string =>
  result.changed ? CONTACT.saved : CONTACT.nothingChanged

// A refused save, in the dialog: 409 register_changed (the contact moved since the page read it)
// offers Reload, and 400 register_invalid (a rule the page didn't catch) asks to check each field,
// in this page's words, since the server's are the registers'; the rest as the register pages read
// them (the PIN step, a new sign-in, forbidden, or the server's words).
export function contactRefusalOf(error: unknown): Refusal {
  const failure = failureOf(error)
  if (failure.code === 'register_changed') return { kind: 'changed', text: CONTACT.changedSince }
  if (failure.code === 'register_invalid') return { kind: 'message', text: CONTACT.invalid }
  return refusalOf(failure)
}
