// Why personal data is processed (PDPA-01). The keys mirror PDPA-01's pre-filled purposes, plus
// service_operation for Hearth's own maintenance (for the DPO to confirm or fold into hosting);
// C0.9's processing register uses the same keys, and a CI check then requires every key to have an
// entry (TECH-SPEC T16 item 16).
//   ai       only the AI layer serves it. Until A0 nothing may run for it: the purpose gate refuses
//            it (T15 item 10), and every flag that names one sits under ai.* (catalogues.test.ts).
//   consent  whether it may rest on consent, which a person's processing switch can then withdraw
//            (PDPA-04, PDPA-04a). Until C0.9 the gate allows processing only for purposes marked
//            false. A purpose not yet known to rest on something else is marked true, so it stays
//            refused until C0.9's register says otherwise: C0.6's conservative reading, for the DPO.
//   register the purpose as the processing register words it.
export interface PurposeSpec {
  ai: boolean
  consent: boolean
  register: string
}

export const PURPOSES = {
  accounts: {
    ai: false,
    consent: false,
    register: 'Accounts and sign-in: the roster, phone numbers and one-time codes, devices, profiles',
  },
  content_delivery: {
    ai: false,
    consent: false,
    register: 'Hosting and delivering messages, voice messages, docs, sheets, slide decks, files, tasks and calendar',
  },
  service_operation: {
    ai: false,
    consent: false,
    register: 'Running the service: queues, scheduled maintenance and clean-up',
  },
  security_audit: { ai: false, consent: false, register: 'Security audit and monitoring' },
  access_logs: { ai: false, consent: false, register: 'Access logs and “viewed by” lists' },
  backups: { ai: false, consent: false, register: 'Backups' },
  presence_receipts: { ai: false, consent: true, register: 'Presence and read receipts' },
  recording_meetings: { ai: false, consent: true, register: 'Recording scheduled meetings and calls' },
  recording_drop_in: { ai: false, consent: true, register: 'Recording drop-in room sessions' },
  session_slides: {
    ai: false,
    consent: true,
    register: 'Keeping the slides presented in a session with its record',
  },
  session_sharing: { ai: false, consent: true, register: 'Showing session records to people who weren’t there' },
  people_insights: { ai: false, consent: true, register: 'People insights (counts and durations)' },
  sensitive_data_detection: { ai: false, consent: true, register: 'Sensitive-data detection' },
  transcription: { ai: true, consent: true, register: 'Transcribing sessions' },
  voice_message_transcription: { ai: true, consent: true, register: 'Voice-message transcription' },
  meeting_notes: { ai: true, consent: true, register: 'AI meeting notes' },
  org_brain: { ai: true, consent: true, register: 'Org Brain indexing' },
  ai_writing: { ai: true, consent: true, register: 'Built-in AI summaries and writing help' },
  people_inference: { ai: true, consent: true, register: 'People and expertise inference' },
  assistant: { ai: true, consent: true, register: 'The personal assistant' },
  agents: { ai: true, consent: true, register: 'Specialist agents and their digests' },
  ai_cost_figures: { ai: true, consent: true, register: 'Per-person AI cost figures' },
  transcription_test_set: { ai: true, consent: true, register: 'The transcription test set' },
} as const satisfies Record<string, PurposeSpec>

export type PurposeKey = keyof typeof PURPOSES

export const PURPOSE_KEYS = Object.keys(PURPOSES) as PurposeKey[]

export function isPurposeKey(key: string): key is PurposeKey {
  return Object.hasOwn(PURPOSES, key)
}

// Whether only the AI layer serves the purpose (A0 onwards). An unknown key counts as AI, so a
// mistyped purpose is refused rather than let through.
export function isAiPurpose(key: string): boolean {
  return !isPurposeKey(key) || PURPOSES[key].ai
}

// The providers PDPA-10's transfer register lists. A job or consumer names those it sends personal
// data to, and runs only once each is cleared (C0.9; until then none is, T15 item 10).
export const PROVIDERS = [
  'aws',
  'aws_sms',
  'livekit',
  'openai',
  'bedrock',
  'apple_push',
  'google_fcm',
  'mozilla_push',
  'microsoft_wns',
] as const
export type ProviderKey = (typeof PROVIDERS)[number]
