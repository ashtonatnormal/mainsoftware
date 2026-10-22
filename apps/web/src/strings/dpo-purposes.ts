// What the processing register's page says (C0.9 PD-07, PD-08, PD-11, PD-26, PD-27; PDPA-01). What
// both DPO pages say is in strings/dpo.ts, whose header gives the rules for all three files.
import type { Basis, PurposeProblem, PurposeStatus, PurposeWarning } from '@hearth/shared'

export const PURPOSES_COPY = {
  intro: 'Why Hearth processes personal data, on what basis, for how long, and who receives it.',
  status: 'Status',
  basis: 'Legal basis',
  retention: 'How long it’s kept',
  providers: 'Who receives it',
  noProviders: 'Nobody outside Hearth',
  optOutDays: 'Opt-out window (days)',
  optOutValue: (days: string) => `${days} days`,
  // The entry's version: 1 is Hearth's, each save by the DPO adds one (PD-04).
  version: 'Version',
  recorded: 'Recorded',
  // A pinned purpose (PD-07).
  pinned: 'Kept active by Hearth: it runs sign-in and Hearth’s own upkeep, so it can’t be retired or rest on consent.',
  // Nothing is notified until the notice is published (PD-08), and AI rows are hidden (PD-27).
  startsWhenNotified: 'A purpose starts only once the published notice lists it.',
  laterStages: 'Purposes for later stages are recorded, and listed here when their stage starts.',
  warnings: 'Check before you save',
} as const

export const STATUS_LABELS: Readonly<Record<PurposeStatus, string>> = {
  planned: 'Planned',
  active: 'Active',
  retired: 'Retired',
}

export const BASIS_LABELS: Readonly<Record<Basis, string>> = {
  employment: 'Employment: managing the working relationship',
  legitimate_interests: 'Legitimate interests',
  business_improvement: 'Business improvement',
  consent: 'Consent',
  deemed_consent_conduct: 'Deemed consent by conduct or contract',
  deemed_consent_notification: 'Deemed consent by notification',
  other_exception: 'Another exception or legal requirement',
}

// The label of the reference a basis takes (BASIS_NEEDS): where its assessment is kept, or the
// provision relied on.
export const REFERENCE_LABELS: Readonly<Partial<Record<Basis, string>>> = {
  legitimate_interests: 'Where the legitimate interests assessment is kept',
  deemed_consent_notification: 'Where the assessment is kept',
  other_exception: 'The provision relied on',
}

// Why a purpose can't be saved (purposeProblems). An unknown or later-stage purpose, or provider,
// can't come from these pages; their lines are here so every code has one.
export const PURPOSE_PROBLEM_COPY: Readonly<Record<PurposeProblem, string>> = {
  unknown_purpose: 'Hearth doesn’t know this purpose.',
  ai_purpose: 'Purposes for later stages stay planned until their stage begins.',
  pinned_inactive: 'Hearth needs this purpose for sign-in and its own upkeep, so it stays active.',
  pinned_consent: 'Hearth needs this purpose for sign-in and its own upkeep, so it can’t rest on consent.',
  needs_switch: 'Until people can each switch this off, it can’t rest on consent of any kind.',
  basis_missing: 'Choose a legal basis.',
  retention_missing: 'Say how long it’s kept.',
  reference_missing: 'Say where the assessment is kept, or name the provision relied on.',
  reference_extra: 'This basis takes no reference.',
  opt_out_missing: 'Give the opt-out window in days.',
  opt_out_extra: 'Only deemed consent by notification takes an opt-out window.',
  opt_out_range: 'The opt-out window is 1 to 365 days.',
  provider_unknown: 'Hearth doesn’t know one of the providers.',
  provider_ai: 'Providers for later stages can’t be listed yet.',
}

// PDPA-01's warnings (purposeWarnings), which never block.
export const PURPOSE_WARNING_COPY: Readonly<Record<PurposeWarning, string>> = {
  business_improvement:
    'Business improvement covers using data only. Check this purpose collects and discloses nothing on this basis.',
  no_opt_out_consent:
    'The recording policy keeps this for everyone, with no opt-out, so one withdrawal would stop it for that person.',
  withdrawal_by_hand:
    'Until people can each switch this off, a withdrawal is carried out by hand, under your written procedure.',
}
