// Why personal data is processed (PDPA-01). The keys mirror PDPA-01's pre-filled purposes, plus
// service_operation for Hearth's own maintenance (for the DPO to confirm or fold into hosting).
// The keys and their fixed facts live here, in code; each org's entry for each key (its status,
// legal basis, retention and providers) lives in Postgres, in the processing register the DPO
// maintains (migration 0009, TECH-SPEC T22 item 2). processing_register_defaults() there lists
// exactly these keys with the same ai and needsSwitch (apps/server/scripts/check-catalogues.ts,
// check 6). Whether a purpose rests on consent is the register's basis, never this file
// (C0.9 PD-28).
//   ai          only the AI layer serves it. Until A0 nothing may run for it: the purpose gate
//               refuses it, the register keeps it planned with nothing recorded (D41's second
//               lock), and every flag that names one sits under ai.* (catalogues.test.ts).
//   needsSwitch withdrawing it for one person would need a per-person processing switch (PDPA-04:
//               recording, transcription, notes, voice-message transcription, Org Brain or AI use).
//               Until those switches exist (PDPA-04a, C2.11), the register refuses every
//               consent-type basis for it (C0.9 PD-11). The transcription test set is exempt: a
//               withdrawal there is carried out by deleting the person's clips (§9.5).
//   register    the purpose as the processing register words it.
export interface PurposeSpec {
  ai: boolean
  needsSwitch: boolean
  register: string
}

export const PURPOSES = {
  accounts: {
    ai: false,
    needsSwitch: false,
    register: 'Accounts and sign-in: the roster, phone numbers and one-time codes, devices, profiles',
  },
  content_delivery: {
    ai: false,
    needsSwitch: false,
    register: 'Hosting and delivering messages, voice messages, docs, sheets, slide decks, files, tasks and calendar',
  },
  service_operation: {
    ai: false,
    needsSwitch: false,
    register: 'Running the service: queues, scheduled maintenance and clean-up',
  },
  security_audit: { ai: false, needsSwitch: false, register: 'Security audit and monitoring' },
  access_logs: { ai: false, needsSwitch: false, register: 'Access logs and “viewed by” lists' },
  backups: { ai: false, needsSwitch: false, register: 'Backups' },
  presence_receipts: { ai: false, needsSwitch: false, register: 'Presence and read receipts' },
  recording_meetings: { ai: false, needsSwitch: true, register: 'Recording scheduled meetings and calls' },
  recording_drop_in: { ai: false, needsSwitch: true, register: 'Recording drop-in room sessions' },
  session_slides: {
    ai: false,
    needsSwitch: false,
    register: 'Keeping the slides presented in a session with its record',
  },
  session_sharing: {
    ai: false,
    needsSwitch: false,
    register: 'Showing session records to people who weren’t there',
  },
  people_insights: { ai: false, needsSwitch: false, register: 'People insights (counts and durations)' },
  sensitive_data_detection: { ai: false, needsSwitch: false, register: 'Sensitive-data detection' },
  transcription: { ai: true, needsSwitch: true, register: 'Transcribing sessions' },
  voice_message_transcription: { ai: true, needsSwitch: true, register: 'Voice-message transcription' },
  meeting_notes: { ai: true, needsSwitch: true, register: 'AI meeting notes' },
  org_brain: { ai: true, needsSwitch: true, register: 'Org Brain indexing' },
  ai_writing: { ai: true, needsSwitch: true, register: 'Built-in AI summaries and writing help' },
  people_inference: { ai: true, needsSwitch: true, register: 'People and expertise inference' },
  assistant: { ai: true, needsSwitch: true, register: 'The personal assistant' },
  agents: { ai: true, needsSwitch: true, register: 'Specialist agents and their digests' },
  ai_cost_figures: { ai: true, needsSwitch: true, register: 'Per-person AI cost figures' },
  transcription_test_set: { ai: true, needsSwitch: false, register: 'The transcription test set' },
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

// The providers PDPA-10's transfer register lists, one entry each per org (C0.9 PD-14): aws covers
// hosting and CloudWatch (with RUM from C0.13); aws_sms is recorded and stays not cleared, since
// that SMS fallback isn't used; the four push services are cleared by the DPO before C0.15. An
// outbound client sends a provider personal data only while the org's entry for it is cleared, and
// checks that at each send (TECH-SPEC T22 items 3 and 8); a job or consumer names the providers it
// sends to.
export const PROVIDERS = [
  'aws',
  'aws_sms',
  'twilio',
  'livekit',
  'openai',
  'bedrock',
  'apple_push',
  'google_fcm',
  'mozilla_push',
  'microsoft_wns',
] as const
export type ProviderKey = (typeof PROVIDERS)[number]

export function isProviderKey(key: string): key is ProviderKey {
  return (PROVIDERS as readonly string[]).includes(key)
}

// The providers only the AI layer sends to: OpenAI for transcription and Bedrock for the Claude
// models (B.5, B.6). Neither can be cleared before A0, by trigger and by can() (D41).
export const AI_PROVIDERS = ['openai', 'bedrock'] as const satisfies readonly ProviderKey[]

// Whether only the AI layer sends to the provider. An unknown key counts as AI, as for purposes,
// so a mistyped provider is refused rather than cleared.
export function isAiProvider(key: string): boolean {
  return !isProviderKey(key) || (AI_PROVIDERS as readonly string[]).includes(key)
}
