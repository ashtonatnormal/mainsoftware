// What /notice and Settings say (C0.9 PD-46, PD-47, PD-53; PDPA-02, PDPA-03): British English,
// short and active (CLAUDE.md, Conventions). The verb is "acknowledge": acknowledging records that
// the person was told, and is never consent, so nothing here says "I agree"; and never "ask" or an
// AI word (decision 8, strings/ai-copy.ts, ST-02). Only the screens' lazy chunks load this file;
// their titles are in strings/shell.ts. The notice's own words are the version's body, which the
// server generates (packages/shared notice-text.ts); none of them is here. The DPO and the owner
// may reword any of it in the PR.
import type { NoticeAckMethod } from '@hearth/shared'

export const NOTICE = {
  loading: 'Loading the notice…',
  loadFailed: 'Couldn’t load the notice. Check your connection, then try again.',
  retry: 'Try again',
  // Under the h1: the version and when it was published, in the person's zone.
  version: (version: string, date: string) => `Version ${version} · published ${date}`,
  // The scroll region that holds the body.
  bodyLabel: (version: string) => `Privacy notice, version ${version}`,
  // What changed since the last version the person acknowledged (PD-46).
  changes: {
    title: (since: string) => `What’s changed since version ${since}`,
    added: 'Now listed',
    changed: 'Changed',
    removed: 'No longer listed',
    wording: 'The notice’s wording has changed.',
    // The DPO's contact (C0.9 OD-11, PD-67), on a line of its own.
    contact: 'The Data Protection Officer’s contact details have changed.',
    contactAdded: 'The notice now gives the Data Protection Officer’s contact details.',
  },
  confirm: (version: string) => `I’ve read the privacy notice, version ${version}.`,
  tickFirst: 'Tick the box to say you’ve read it.',
  acknowledge: 'Acknowledge',
  acknowledging: 'Acknowledging…',
  // A 409 notice_changed: the version on screen is no longer the latest.
  newer: 'A newer version was published while you were reading. Read it, then acknowledge it.',
  signOut: 'Sign out',
  // Visiting /notice once the current version is acknowledged.
  acknowledgedOn: (version: string, date: string) => `You acknowledged version ${version} on ${date}.`,
  continue: 'Continue',
  // Before any version is published (OD-01): the DPO publishes it; nobody else can use Hearth yet.
  unpublished: {
    dpoTitle: 'Publish the privacy notice',
    dpoBody:
      'Nobody can use Hearth until the notice is published. Record your contact details and each purpose’s legal basis and how long its data is kept, then publish the notice.',
    // Publishing needs the DPO's contact (C0.9 OD-10, PD-68).
    toContact: 'Record your contact details',
    toPurposes: 'Open the processing register',
    toNotice: 'Publish the notice',
    title: 'Hearth isn’t open yet',
    body: 'Your organisation hasn’t published its privacy notice yet. You can use Hearth once it has, and you’ve read and acknowledged it.',
  },
} as const

// How an acknowledgement was made, as Settings lists it.
export const ACK_METHODS: Readonly<Record<NoticeAckMethod, string>> = {
  in_app: 'in the app',
  recorded_by_dpo: 'recorded by the Data Protection Officer',
}

export const SETTINGS = {
  // The registry's sections (settings/sections.ts): each one's line on /settings.
  sections: {
    label: 'Settings sections',
    privacy: 'How to reach the Data Protection Officer, the privacy notice and your acknowledgements',
  },
  privacy: {
    // The contact the latest version printed (C0.9 OD-12, PD-69), for everyone.
    contact: {
      title: 'Contact the Data Protection Officer',
      body: 'For a copy of your personal data, to have it corrected or to withdraw consent, or with a question or complaint about how it is handled.',
      email: 'Email',
      phone: 'Phone',
      postal: 'Post',
      leaving: 'You don’t need Hearth for this, so it still works after you leave.',
      none: 'The current notice doesn’t give the Data Protection Officer’s contact yet. The employee data protection policy gives it.',
      unreadable: 'The contact details can’t be shown. Reload the page to try again.',
    },
    noticeTitle: 'Privacy notice',
    acknowledged: (version: string, date: string, method: string) =>
      `You acknowledged version ${version} on ${date} (${method}).`,
    notYet: (version: string) => `You haven’t acknowledged version ${version} yet.`,
    none: 'No privacy notice has been published yet.',
    historyTitle: 'Your acknowledgements',
    history: (version: string, date: string, method: string) => `Version ${version}, ${date} (${method})`,
    noHistory: 'You haven’t acknowledged a version yet.',
    // An acknowledgement the DPO recorded: how you acknowledged outside Hearth (C0.9 OD-19, PD-75).
    recordedHow: (note: string) => `How: ${note}`,
  },
} as const
