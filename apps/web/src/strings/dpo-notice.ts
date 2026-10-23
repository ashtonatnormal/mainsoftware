// What the DPO's Notice tab (/dpo/notice) and the register pages' notice markers say (C0.9 PD-39,
// PD-48, PD-53, PD-59, PD-61; B-04, B-12, C-09; PDPA-02, PDPA-03). strings/dpo.ts's header gives
// the rules for every DPO page's copy: British English, short and active, never "ask" and never an
// AI word (decision 8, ST-02, DPP-06). Only the Notice tab, the two register screens and the
// contact page load this file, never RegisterPage.tsx (B-12); the record dialog's copy is
// strings/dpo-record.ts, which only the Notice tab loads. The notice's own words are the draft's body, which the
// server generates (packages/shared notice-text.ts); none of them is here. The problems and
// warnings are packages/shared's codes (NOTICE_PROBLEMS, NOTICE_WARNINGS), worded here once each,
// and never quote the DPO's own text (C-05). The DPO and the owner may reword any of it in the PR.
import type { NoticeFreeTextField, NoticeProblemCode, NoticeStatus, NoticeWarningCode } from '@hearth/shared'

// Whether the published notice says what the registers say (RegistersResponse's notice, and the
// Notice tab's own reading of its answer).
export const NOTICE_STATUS_LABELS: Readonly<Record<NoticeStatus, string>> = {
  up_to_date: 'Up to date',
  out_of_date: 'Out of date',
  none: 'Not published',
}

export const NOTICE_TAB = {
  loading: 'Loading the notice…',
  published: {
    title: 'The published notice',
    // Before any version (OD-01): nobody uses Hearth; the DPO reaches only the registers and this
    // tab (strings/notice.ts unpublished.dpoBody says the same).
    none: 'No notice is published yet, so nobody can use Hearth until you publish one.',
    version: (version: string, date: string) => `Version ${version}, published ${date}.`,
    versionBy: (version: string, date: string, name: string) => `Version ${version}, published ${date} by ${name}.`,
    // A stand-in (no generator): the seed's, before the first generated version (C0.9 PD-33).
    standIn: 'It’s a placeholder, not written from the registers. Publish a version that is.',
    upToDate: 'It says what the registers say.',
    outOfDate: 'It no longer says what the registers say. Publish a new version.',
    // A count, never names (data minimisation, PD-48).
    acknowledged: (count: string, people: string, version: string) =>
      `${count} of the ${people} people at the organisation have acknowledged version ${version}.`,
    acknowledgedOfOne: (count: string, version: string) =>
      `${count} of the 1 person at the organisation has acknowledged version ${version}.`,
  },
  draft: {
    title: (version: string) => `Publishing version ${version}`,
    first: 'The first version lists every active purpose, and every provider you’ve cleared for use.',
    changes: 'What it changes',
    added: 'Now listed',
    changed: 'Changed',
    removed: 'No longer listed',
    wording: 'The notice’s own wording changes too.',
    problems: 'Before you can publish',
    warnings: 'Check before you publish',
    toPurposes: 'Open the processing register',
    toTransfers: 'Open the transfer register',
    // The DPO's contact (C0.9 OD-10, OD-11, PD-67): where it is fixed, the problems' group, and what
    // the next version changes.
    toContact: 'Open your contact details',
    contactSubject: 'Your contact details',
    contact: 'Your contact details change.',
    contactAdded: 'The notice gives your contact details for the first time.',
    publish: (version: string) => `Publish version ${version}`,
    publishing: 'Publishing…',
    // Publish held for this reason when the draft is the published notice again.
    alreadySays: 'The published notice already says this.',
  },
  preview: {
    title: (version: string) => `Preview of version ${version}`,
    label: (version: string) => `Preview of version ${version}, as people will read it`,
    // The draft's words are held back while an entry they'd state is missing or uses words the
    // screens keep off (the server's answer has no body then).
    hidden: 'The preview shows once what’s listed above is fixed.',
  },
  history: {
    title: 'Published versions',
    standIn: 'A placeholder, not written from the registers.',
  },
  // Publish, behind a confirmation and then the PIN when the server asks for it (PD-30, PD-48).
  confirm: {
    title: (version: string) => `Publish version ${version}?`,
    body: (version: string) =>
      `Everyone, you included, acknowledges version ${version} before using Hearth again. People using Hearth now are taken to it within half a minute.`,
  },
  // 409 notice_changed and 400 notice_invalid, in this page's words: the server's are for /notice.
  changedSince:
    'The registers or the published notice changed since this page read them. Reload to check the draft again.',
  invalid: 'The draft can’t be published as it is. Reload to see what it needs.',
} as const

// Why publishing is held back (noticeProblems): under the purpose or provider each names, which the
// page shows above them, so no line repeats the long register wording of a purpose.
export const NOTICE_PROBLEM_COPY = {
  purpose_basis_missing: () => 'Record its legal basis.',
  purpose_retention_missing: () => 'Say how long its data is kept.',
  // Consent until C1.3, deemed consent by notification until C2.11 (C0.9 OD-18).
  purpose_consent_basis: () =>
    'It rests on consent or deemed consent by notification, which the notice can’t state yet. Choose another basis.',
  // Deemed consent by conduct with no way yet to stop it for one person (C0.9 OD-18, PD-86).
  purpose_conduct_unstoppable: () =>
    'It rests on deemed consent by conduct, but Hearth can’t yet stop it for one person who withdraws, so the notice can’t promise that. Choose another basis.',
  provider_not_cleared: (provider: string) => `It lists ${provider}, which isn’t cleared for use.`,
  // No contact recorded (C0.9 OD-10, PD-68): the notice can't be written.
  dpo_contact_pending: () => 'Record your contact details, so the notice can say how to reach you.',
  // The field, never the words matched (C-05).
  free_text_ai_copy: (field: string) => `“${field}” uses wording Hearth keeps off its screens. Reword it.`,
  unchanged: () => 'The published notice already says this.',
} as const satisfies Record<NoticeProblemCode, (...args: string[]) => string>

// The DPO's free text the notice prints, by field, as the register pages label it.
export const NOTICE_FIELD_LABELS: Readonly<Record<NoticeFreeTextField, string>> = {
  basis_reference: 'The reference for its legal basis',
  retention: 'How long it’s kept',
  services: 'What it’s used for',
  data_types: 'The personal data it receives',
  provider_retention: 'How long it keeps the data',
  onward_recipients: 'Who it passes the data on to',
  // The DPO's contact (C0.9 PD-65), as its page labels it.
  contact_title: 'Role title',
  contact_email: 'Email address',
  contact_postal: 'Postal address',
}

// What publishing warns of (noticeWarnings), which never holds it back.
export const NOTICE_WARNING_COPY = {
  provider_unlisted: (provider: string) =>
    `${provider} is cleared, but no active purpose lists it. The notice names it anyway.`,
  provider_review_due: (provider: string) =>
    `The review of ${provider} is due. Check its facts on the transfer register.`,
  sends_waiting: (provider: string) =>
    `Nothing is sent to ${provider} until you publish: the published notice doesn’t state its facts.`,
  // Twilio Verify's: until then only the DPO gets a sign-in code (C0.9 PD-59).
  sends_waiting_twilio: () =>
    'Until you publish, only you get sign-in codes: the published notice doesn’t state Twilio Verify’s facts.',
  same_text: () =>
    'The words are the published version’s, but what they rest on has changed, so everyone acknowledges the same words again.',
  // C0.9 PD-57: the production-access paragraph describes what C0.11 and C0.19 put in place.
  production_access_pending: () =>
    'The notice says each use of the emergency production role is logged and reviewed by a second person each quarter. Publish it only once both are in place.',
} as const satisfies Record<NoticeWarningCode | 'sends_waiting_twilio', (...args: string[]) => string>

// The register pages' markers (PD-48, B-04, C-09): the Notice link's badge, the banner over the
// list, and the lines on the cards and in the edit dialogs.
export const NOTICE_MARKERS = {
  banner: {
    none: 'No notice is published yet, so nobody can use Hearth. Record your contact details and each active purpose’s legal basis and how long its data is kept, then publish it.',
    outOfDate: 'The published notice no longer says what the registers say. Publish a new version.',
    // A pinned purpose changed since the latest generated version: it runs for everyone anyway
    // (PD-07), so the notice is out of date until the next publish (PD-61, B-04).
    stale:
      'The published notice no longer matches how these are handled, and everyone is affected now. Publish a new notice.',
    toNotice: 'Open the notice',
  },
  // An active purpose that isn't pinned, which the latest version doesn't list at this version
  // (PD-40): the purpose gate refuses it, so nothing gated on it runs.
  waitingForNotice: 'Features that serve it stay off until a published notice lists this version.',
  // A pinned purpose the latest generated version lists at an older version (PD-61).
  pinnedStale: 'The published notice states an older version of this, which applies to everyone already.',
  // A cleared provider the latest generated version doesn't state (PD-41, PD-59).
  sendsWait:
    'Cleared, but the published notice doesn’t state these facts, so nothing is sent to it until you publish a new notice.',
  sendsWaitTwilio:
    'Cleared, but the published notice doesn’t state these facts. Until you publish a new notice, only you get sign-in codes.',
  // The edit dialogs, once a generated version is published.
  purposeStops: 'Saving this change turns off the features that serve it until you publish a new notice that lists it.',
  pinnedConfirm: {
    title: 'Save a change that applies to everyone?',
    body: 'This applies to everyone at once. Publish a new notice afterwards so it says so.',
    confirm: 'Save',
    back: 'Back',
  },
  factsStop: (provider: string) =>
    `The published notice states ${provider}’s facts. Once you save a change to them, nothing is sent to ${provider} until you publish a new notice.`,
  factsStopTwilio:
    'The published notice states Twilio Verify’s facts. Once you save a change to them, sign-in codes stop for everyone but you until you publish a new notice.',
} as const
