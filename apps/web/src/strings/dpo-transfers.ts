// What the transfer register's page says (C0.9 PD-05, PD-12, PD-13, PD-14, PD-26; PDPA-10, D46;
// TECH-SPEC T22 item 3). What both DPO pages say is in strings/dpo.ts, whose header gives the rules
// for all three files.
import type { Safeguard, Training, TransferProblem, ZeroRetention } from '@hearth/shared'
import type { NonAiProviderKey } from './dpo.ts'

export const TRANSFERS_COPY = {
  intro:
    'Each provider outside Singapore that receives personal data, what it receives and where, and whether you’ve cleared it for use.',
  cleared: 'Cleared',
  notCleared: 'Not cleared',
  // Twilio Verify, never cleared in the org: what that stops (T22 item 3).
  twilioNotCleared: 'No sign-in code is sent until it’s cleared.',
  clearedOn: (day: string, name: string) => `Cleared on ${day} by ${name}`,
  clearedAtSetUp: (day: string) => `Cleared at set-up on ${day}`,
  withdrawnOn: (day: string) => `Clearance withdrawn on ${day}`,
  endedOn: (day: string) => `Clearance ended on ${day}, when new facts were saved`,
  reviewBy: (day: string) => `Review by ${day}`,
  reviewToday: 'Review due today',
  reviewOverdue: (day: string) => `Review overdue since ${day}`,
  updated: 'Facts recorded',
  // Which outbound clients check each provider's clearance today (TECH-SPEC T22 item 3).
  checkedBy: 'What checks this',
  clearForUse: 'Clear for use',
  clearedToast: (provider: string) => `${provider} is cleared for use.`,
  withdrawnToast: (provider: string) => `${provider}’s clearance is withdrawn.`,
  back: 'Back',
  clearHeld: 'Record what’s still needed first.',
  withdraw: 'Withdraw clearance',
  saveKeepCleared: 'Save and keep cleared',
  saveKeepClearedHeld: 'Record what’s still needed first, or save without keeping it cleared.',
  stillNeeded: 'Still needed before clearing',
  nothingNeeded: 'Nothing more is needed to clear it.',
  countriesHint: 'Two-letter codes, separated by commas, such as SG, US.',
  countriesInvalid: 'Enter two-letter country codes, such as SG or US.',
  // The confirmations (PD-05; the plain Save on a cleared entry asks as Withdraw does).
  confirmClear: {
    title: (provider: string) => `Clear ${provider} for use?`,
    body: 'Clearing records that you, as the Data Protection Officer, have checked these facts.',
  },
  confirmWithdraw: {
    title: (provider: string) => `Withdraw ${provider}’s clearance?`,
  },
  confirmSaveEnds: {
    title: 'Save and end the clearance?',
    body: (provider: string) => `Saving these facts without keeping them cleared ends ${provider}’s clearance.`,
    confirm: 'Save and end clearance',
  },
  fields: {
    services: 'What it’s used for',
    dataTypes: 'The personal data it receives',
    processingCountries: 'Countries it processes the data in',
    storageCountries: 'Countries it stores the data in',
    countriesConfirmed: 'Where and when it confirmed the countries in writing',
    safeguard: 'Transfer safeguard',
    safeguardReference: 'The safeguard’s reference',
    safeguardReferenceHint: 'The agreement’s name and date, or the certificate’s number.',
    certificateVerifiedOn: 'Date you verified the certificate',
    dpaTerms:
      'The agreement binds protection comparable to the PDPA, names the countries and requires prompt notice of incidents',
    training: 'Training on the data',
    zeroRetention: 'Zero-retention result',
    providerRetention: 'How long it keeps the data',
    retentionConfirmed: 'Where and when it confirmed its retention in writing',
    onwardRecipients: 'Who it passes the data on to',
    onwardRecipientsHint: 'Name each, such as the mobile carriers, or write None.',
    reviewOn: 'Review by',
  },
  summary: {
    processes: 'Processes in',
    stores: 'Stores in',
    safeguard: 'Safeguard',
    kept: 'Keeps it for',
    onward: 'Passes it on to',
  },
} as const

// What checks each provider's clearance today, and what withdrawing it stops (TECH-SPEC T22 item 3).
// Only Twilio Verify's is checked, before each sign-in or re-authentication code.
export const PROVIDER_CHECKS: Readonly<Record<NonAiProviderKey, { checkedBy: string; withdrawing: string }>> = {
  twilio: {
    checkedBy: 'Hearth checks this before it sends each sign-in or re-authentication code.',
    withdrawing:
      'Withdrawing stops Hearth sending Twilio Verify anyone’s number. Nobody can get a sign-in code, and people who confirm it’s them with a texted code can’t, until Twilio is cleared again. Your PIN still confirms it’s you, and open sessions keep working. Clear it again here before your own session ends.',
  },
  aws: {
    checkedBy: 'Hearth’s hosting and logs run on it whatever this says. Nothing else in Hearth sends to it yet.',
    withdrawing:
      'Withdrawing records your decision. Hearth’s hosting and logs keep running on Amazon Web Services, so it stops nothing yet.',
  },
  aws_sms: {
    checkedBy: 'Nothing in Hearth sends to it yet.',
    withdrawing: 'Withdrawing records your decision. Nothing in Hearth sends to it yet, so it stops nothing today.',
  },
  livekit: {
    checkedBy: 'Nothing in Hearth sends to it yet.',
    withdrawing: 'Withdrawing records your decision. Nothing in Hearth sends to it yet, so it stops nothing today.',
  },
  apple_push: {
    checkedBy: 'Nothing in Hearth sends to it yet.',
    withdrawing: 'Withdrawing records your decision. Nothing in Hearth sends to it yet, so it stops nothing today.',
  },
  google_fcm: {
    checkedBy: 'Nothing in Hearth sends to it yet.',
    withdrawing: 'Withdrawing records your decision. Nothing in Hearth sends to it yet, so it stops nothing today.',
  },
  mozilla_push: {
    checkedBy: 'Nothing in Hearth sends to it yet.',
    withdrawing: 'Withdrawing records your decision. Nothing in Hearth sends to it yet, so it stops nothing today.',
  },
  microsoft_wns: {
    checkedBy: 'Nothing in Hearth sends to it yet.',
    withdrawing: 'Withdrawing records your decision. Nothing in Hearth sends to it yet, so it stops nothing today.',
  },
}

export const SAFEGUARD_LABELS: Readonly<Record<Safeguard, string>> = {
  dpa: 'Data processing agreement',
  dpa_addendum: 'An addendum to the agreement, such as the ASEAN Model Contractual Clauses',
  certification: 'Certification',
}

export const TRAINING_LABELS: Readonly<Record<Training, string>> = {
  off: 'Turned off',
  not_applicable: 'Not applicable: it trains on nothing',
}

export const ZERO_RETENTION_LABELS: Readonly<Record<ZeroRetention, string>> = {
  granted: 'Granted',
  refused: 'Refused',
  not_offered: 'Not offered',
  not_applicable: 'Not applicable',
  pending: 'Applied for, no answer yet',
}

// What a provider's entry still needs before it can be cleared (transferProblems), as a list.
export const TRANSFER_PROBLEM_COPY: Readonly<Record<TransferProblem, string>> = {
  unknown_provider: 'Hearth doesn’t know this provider.',
  ai_provider: 'Providers for later stages can’t be cleared yet.',
  services: 'What it’s used for',
  data_types: 'The personal data it receives',
  processing_countries: 'The countries it processes the data in',
  storage_countries: 'The countries it stores the data in',
  countries_confirmed: 'Where and when it confirmed the countries in writing',
  safeguard: 'The transfer safeguard',
  safeguard_reference: 'The safeguard’s reference',
  certificate_unverified: 'The date you verified the certificate',
  certificate_future: 'A verification date that isn’t in the future',
  dpa_terms: 'Confirmation of the agreement’s terms',
  training: 'Whether it trains on the data',
  zero_retention: 'The zero-retention result: an application with no answer yet doesn’t count',
  provider_retention: 'How long it keeps the data',
  retention_confirmed: 'Where and when it confirmed its retention in writing',
  onward_recipients: 'Who it passes the data on to, or None',
  review_on: 'A review date',
  review_due: 'A review date after today',
}
