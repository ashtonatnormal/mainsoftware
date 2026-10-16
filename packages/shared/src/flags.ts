// Every feature flag (INF-FLAGS, TECH-SPEC T17). Keys, classes, purposes, client visibility and
// stage live here, in code; each org's state (enabled, cohort, revision) lives in Postgres
// (feature_flags, migration 0007), and feature_flag_defaults() there must list exactly these keys
// with the same default and lock (apps/server/scripts/check-catalogues.ts).
//
// A flag is on when it and every flag above it is enabled (ai above ai.agents above
// ai.agents.<id>) and the person is in each one's cohort. Flags switch features on or off; they
// never gate an access check (can() still decides every one) nor a privacy or safety control (the
// recording indicator, the notice gate, the access filter), and they hold no values: settings do
// (T17 item 10).
//
//   class    essential: no spend cap ever pauses it (D10), and its work waits while it is off.
//            optional: a spend cap may pause it (A0), and its work is dropped when it is off.
//            The class lives in code only (CLAUDE.md, AI: how caps are enforced stays in code).
//   default  its value in a new org; locked: nobody can change it but a migration. Every ai.* flag
//            is off and locked, by a table constraint too, until A0's reviewed migration lifts it.
//   purposes why the feature processes personal data (PURPOSES); a job or consumer of the feature
//            names one of them.
//   client   whether its value, evaluated for the person, may reach their browser (C0.8).
//   stage    the BUILD-PLAN step that builds what it gates.
import type { PurposeKey } from './purposes.ts'

export type FlagClass = 'essential' | 'optional'

export interface FlagSpec {
  description: string
  class: FlagClass
  default: boolean
  locked: boolean
  purposes: readonly PurposeKey[]
  client: boolean
  stage: string
}

// An AI flag as the registry holds it until A0: off, locked and never sent to a browser.
function aiFlag(
  description: string,
  flagClass: FlagClass,
  purposes: readonly PurposeKey[],
  stage: string,
): {
  description: string
  class: FlagClass
  default: false
  locked: true
  purposes: readonly PurposeKey[]
  client: false
  stage: string
} {
  return { description, class: flagClass, default: false, locked: true, purposes, client: false, stage }
}

export const FLAGS = {
  // Hearth's own maintenance: partitions, the outbox and queue clean-up, offboarding. Locked on.
  'core.system': {
    description: 'Hearth’s own maintenance: partitions, clean-up and offboarding',
    class: 'essential',
    default: true,
    locked: true,
    purposes: ['service_operation', 'accounts'],
    client: false,
    stage: 'C0.6',
  },
  // ADM-10's three levels: all AI, all agents, one agent (ai.agents.<id>, rows made by A5).
  // Transcription and meeting notes are essential: caps never stop them (ADM-05, D10).
  ai: aiFlag('Every AI feature (ADM-10)', 'essential', [], 'A0'),
  'ai.transcription': aiFlag(
    'Transcription of sessions and voice messages',
    'essential',
    ['transcription', 'voice_message_transcription'],
    'A1',
  ),
  'ai.transcription.sessions': aiFlag('Session transcription', 'essential', ['transcription'], 'A1'),
  'ai.transcription.voice_messages': aiFlag(
    'Voice-message transcription',
    'essential',
    ['voice_message_transcription'],
    'A1',
  ),
  'ai.notes': aiFlag('Meeting notes', 'essential', ['meeting_notes'], 'A3'),
  'ai.brain': aiFlag('Org Brain indexing', 'optional', ['org_brain'], 'A2'),
  'ai.ask': aiFlag('Asking the Org Brain', 'optional', ['org_brain'], 'A3'),
  'ai.catch_up': aiFlag('Catch-up summaries', 'optional', ['ai_writing'], 'A3'),
  'ai.summaries': aiFlag('Summaries', 'optional', ['ai_writing'], 'A3'),
  'ai.docs': aiFlag('Writing help in docs', 'optional', ['ai_writing'], 'A3'),
  'ai.sheets': aiFlag('AI help in sheets', 'optional', ['ai_writing'], 'A3'),
  'ai.slides': aiFlag('AI help in slides', 'optional', ['ai_writing'], 'A3'),
  'ai.quick_replies': aiFlag('Quick replies', 'optional', ['ai_writing'], 'A3'),
  'ai.people_inference': aiFlag('People and expertise inference', 'optional', ['people_inference'], 'A3'),
  'ai.assistant': aiFlag('The personal assistant', 'optional', ['assistant'], 'A4'),
  'ai.agents': aiFlag('Every specialist agent (ADM-10)', 'optional', ['agents'], 'A5'),
  'ai.onboarding_buddy': aiFlag('The onboarding buddy', 'optional', ['agents'], 'A5'),
} as const satisfies Record<string, FlagSpec>

export type FlagKey = keyof typeof FLAGS

export const FLAG_KEYS = Object.keys(FLAGS) as [FlagKey, ...FlagKey[]]

// A flag key as the database allows it (feature_flags_key in 0007): dotted lower-case codes, at
// most 100 characters.
export const FLAG_KEY = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/
export const FLAG_KEY_MAX = 100

export function isFlagKey(key: string): boolean {
  return FLAG_KEY.test(key) && key.length <= FLAG_KEY_MAX
}

// The key and every key above it, from the top: 'ai.agents.x1' gives ['ai', 'ai.agents',
// 'ai.agents.x1']. The fences read the rows of exactly these keys (feature_fence, job_fence).
export function flagLineage(key: string): string[] {
  const parts = key.split('.')
  return parts.map((_, i) => parts.slice(0, i + 1).join('.'))
}

// Every AI flag: ai itself and everything under it. can() refuses flag.set for each, and the table
// keeps each off and locked until A0.
export function isAiFlag(key: string): boolean {
  return key === 'ai' || key.startsWith('ai.')
}

// Who a flag is on for while it's enabled (T17 item 3): the whole org, or a cohort of people and
// holders of org-wide roles, any of whom matches. Teams and departments come with the first step
// that needs them (C6.8's department waves), and so does Team Admin: its powers end when its team
// is archived (T13), so telling who holds it means reading teams. The database allows exactly these
// roles and at most COHORT_LIMIT entries in all (feature_flags_cohort in 0007), and the flags route
// refuses anything else before it reaches the database.
export const COHORT_ROLES = ['owner', 'admin', 'ai_admin', 'leadership', 'dpo', 'compliance_officer'] as const
export type CohortRole = (typeof COHORT_ROLES)[number]
export const COHORT_LIMIT = 1000

export type FlagAudience = 'org' | 'cohort'

export interface FlagCohort {
  people: readonly string[]
  roles: readonly CohortRole[]
}

// Why a flag's audience and cohort can't be stored together, or undefined if they can: the same
// rule as the table's check, so the route answers 400 rather than the database 500.
export function cohortProblem(audience: FlagAudience, cohort: FlagCohort): string | undefined {
  const size = cohort.people.length + cohort.roles.length
  if (size > COHORT_LIMIT) return `A cohort can name at most ${COHORT_LIMIT} people and roles in all.`
  if (audience === 'cohort' && size === 0) return 'A cohort must name at least one person or role.'
  if (audience === 'org' && size > 0) return 'A flag on for the whole organisation names no cohort.'
  return undefined
}
