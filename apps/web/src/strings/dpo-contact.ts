// What the DPO's contact page (/dpo/contact) says (PDPA-13, PDPA-02; C0.9 OD-10, OD-11, PD-64,
// PD-70). strings/dpo.ts's header gives the rules for every DPO page's copy: British English, short
// and active, never "ask" and never an AI word (decision 8, ST-02, DPP-06). Only the contact page's
// lazy chunk loads this file. What holds a contact back is packages/shared's codes
// (CONTACT_PROBLEMS, which set_dpo_contact() in 0011 refuses in the same order), worded here once
// each, naming the field and never the words matched (C-05). The DPO and the owner may reword any
// of it in the PR.
import type { ContactProblemCode } from '@hearth/shared'

export const CONTACT = {
  loading: 'Loading your contact details…',
  intro:
    'How people reach you as the Data Protection Officer about their personal data, including people who have left and people without a Hearth account. The notice gives these details once you publish it, and Settings shows them to everyone.',
  // A role, never the DPO's own name or number (OD-10): the details outlive whoever holds the role.
  advice:
    'Use a role title and a shared mailbox or business line, not your own name or mobile number, so the details still work if someone else takes on the role.',
  none: {
    title: 'No contact details yet',
    body: 'The notice can’t be published until you record them.',
    record: 'Record contact details',
  },
  card: {
    email: 'Email address',
    phone: 'Phone',
    postal: 'Postal address',
    recorded: 'Recorded',
    notRecorded: 'Not recorded',
  },
  recorded: (day: string, name: string | null) => (name === null ? day : `${day} by ${name}`),
  // Whether the published notice gives these details (ContactAdminResponse's stated).
  stated: {
    yes: 'In the published notice',
    no: 'Not in the published notice yet',
    none: 'Not published yet',
    noLine: 'The published notice still gives your earlier details. Publish a new version so it gives these.',
    notPrintedLine: 'The published notice doesn’t give your contact details yet. Publish a new version so it does.',
  },
  toNotice: 'Open the Notice tab',
  edit: 'Edit contact details',
  dialog: {
    recordTitle: 'Record your contact details',
    editTitle: 'Edit your contact details',
    title: 'Role title',
    titleHint: 'The role people write to, such as Data Protection Officer.',
    channels: 'Give at least one of these, so people can reach you without Hearth.',
    email: 'Email address',
    emailHint: 'A shared mailbox works best.',
    phone: 'Phone',
    phoneHint: 'Start with + and the country code, such as +65.',
    postal: 'Postal address',
    postalHint: 'One line of the address on each line.',
    // Once a version is published (OD-11): a contact change makes it out of date.
    staleWarning:
      'Once you save, the published notice is out of date. Everyone acknowledges the next version you publish.',
  },
  saved: 'Contact details saved.',
  nothingChanged: 'Nothing changed.',
  // 409 register_changed and 400 register_invalid, in this page's words.
  changedSince: 'Your contact details changed since this page read them. Reload, then try again.',
  invalid: 'Your contact details can’t be saved as they are. Check each field.',
} as const

// What holds a contact back (contactProblems), in CONTACT_PROBLEMS' order. ai_copy names the field
// (CONTACT_FIELD_NAMES), never the words matched.
export const CONTACT_PROBLEM_COPY = {
  title_missing: () => 'Give a role title.',
  title_long: () => 'Keep the role title to one line of at most 120 characters.',
  channel_missing: () => 'Give an email address, a phone number or a postal address.',
  email_shape: () => 'Enter an email address such as name@example.org.',
  phone_shape: () => 'Enter the phone number starting with + and the country code.',
  postal_long: () => 'Keep the postal address to 500 characters.',
  ai_copy: (field: string) => `The ${field} uses wording Hearth keeps off its screens. Reword it.`,
} as const satisfies Record<ContactProblemCode, (field: string) => string>

// Each field, as a problem's line names it.
export const CONTACT_FIELD_NAMES = {
  title: 'role title',
  email: 'email address',
  phone: 'phone number',
  postal: 'postal address',
} as const
