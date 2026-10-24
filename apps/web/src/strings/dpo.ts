// What the DPO's pages say (C0.9 PD-26, PD-27, PD-31; OD-03): British English, short and active
// (CLAUDE.md, Conventions), never "ask" and never an AI word (decision 8, strings/ai-copy.ts). Only
// the pages' lazy chunks load these files, so the boot's bundle carries none of it; their titles
// and the avatar menu's entry are in strings/shell.ts. In several files, so each page's chunk
// carries only its own copy: this one, what both pages say; strings/dpo-purposes.ts, the processing
// register's; strings/dpo-transfers.ts, the transfer register's; strings/dpo-contact.ts, the
// contact page's (C0.9 PD-70); strings/dpo-notice.ts, the Notice tab's and the notice markers';
// strings/dpo-record.ts, the Notice tab's record dialog's (PD-76). The registers' rules are
// codes in packages/shared (registers.ts) and are worded in these files, once each; a code with no
// line fails typecheck. The purposes' own wording is the register's (PURPOSES[key].register), and
// dpo/copy.test.ts holds every label the pages can render to AI_COPY (DPP-06). The DPO and the
// owner may reword any of it in the PR.
import type { AI_PROVIDERS, ProviderKey } from '@hearth/shared'

// The providers the pages show until A0 (C0.9 PD-27): every PROVIDERS key but the AI layer's.
export type NonAiProviderKey = Exclude<ProviderKey, (typeof AI_PROVIDERS)[number]>

export const DPO = {
  // The links between the two registers, the contact details (C0.9 PD-70) and the notice (PD-48),
  // at the top of each page.
  tabs: {
    label: 'Registers',
    purposes: 'Purposes',
    transfers: 'Transfers',
    contact: 'Contact',
    notice: 'Notice',
  },
  loading: 'Loading the register…',
  // GET /api/admin/registers refused with forbidden: anyone but the DPO (PD-20).
  forbidden: 'This page is for the Data Protection Officer.',
  retry: 'Try again',
  reload: 'Reload',
  editButton: 'Edit',
  // The Edit button's name and the dialog's title.
  edit: (what: string) => `Edit ${what}`,
  cancel: 'Cancel',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved.',
  // A write that landed and changed nothing (PD-21): the entry was already as sent.
  nothingChanged: 'Nothing changed.',
  // Shown on a held Save, and above the list of what blocks it.
  fixFirst: 'Fix what’s listed first.',
  beforeSaving: 'Before you can save',
  notRecorded: 'Not recorded',
  // A version or a revision Hearth made, which names nobody (version 1, the starting facts).
  byHearth: 'Set by Hearth',
  recordedOn: (day: string, name: string) => `${day} by ${name}`,

  // The re-authentication step, inline until C0.16's sheet (PD-26, PD-30).
  reauth: {
    pinLabel: 'Your PIN',
    confirm: 'Confirm',
    confirming: 'Checking…',
    signOut: 'Sign out',
    // pin_reset_needed, and pin_locked once only an Owner can unlock it (pin.state admin_locked),
    // in these pages' own words: the server's copy says "Ask", which no text these pages show may
    // (decision 8).
    pinResetNeeded: 'Your PIN needs resetting. An Owner resets it, after checking it’s you.',
    pinAdminLocked: 'Your PIN is locked. An Owner resets it, after checking it’s you.',
  },
} as const

export const PROVIDER_NAMES: Readonly<Record<NonAiProviderKey, string>> = {
  aws: 'Amazon Web Services',
  aws_sms: 'AWS text messages',
  twilio: 'Twilio Verify',
  livekit: 'LiveKit Cloud',
  apple_push: 'Apple Push Notification service',
  google_fcm: 'Firebase Cloud Messaging',
  mozilla_push: 'Mozilla Push Service',
  microsoft_wns: 'Windows Push Notification Services',
}
