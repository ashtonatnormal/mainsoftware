// The outbox catalogue (INF-OUTBOX, TECH-SPEC T16). Every type an outbox event may have is named
// here, and the list of names equals the outbox_events_type check (migration 0007's, widened by
// each step that emits a type: 0009's for C0.9; apps/server/scripts/check-catalogues.ts). Emitted
// types have an ids schema, name the step that emits them, and are the only ones the server's
// appendOutbox() accepts; reserved types are named for the step after each, which gives them their
// ids, purposes and snapshot rule and makes them emitted.
//
// Names are <noun>.<past-tense verb> (person.deactivated), apart from audit codes' imperative
// person.deactivate. Sign-in sessions are signin.*, never session.*, which C2.4 keeps for recorded
// room sessions (T14 item 17). A later stage's namespace (RESERVED_NAMESPACES) holds only names of
// that stage, so nobody takes one early (catalogues.test.ts).
//
//   entity    the entity_type of what the event is about.
//   acl       content events carry aclOf's row and the container's acl_epoch ('snapshot'); every
//             other event carries none (T16 item 12).
//   ordering  how a consumer orders what it reads: it re-reads the entity's current state
//             ('reread'), or keeps the highest acl_epoch per holder ('epoch').
//   tombstone the entity is gone for every reader, so everything made from it goes too.
//   purposes  the purposes an event of the type may carry (PURPOSES).
//   ids       the other ids consumers need: a z.strictObject of ids only (ids.ts), whose lists hold
//             at most 100 ids, so a longer one is split into several events of the same type.
import { z } from 'zod'
import { PROVIDERS, PURPOSE_KEYS, type PurposeKey } from './purposes.ts'
import { PURPOSE_STATUSES } from './registers.ts'

export type EventStatus = 'emitted' | 'reserved'

export interface EventSpec {
  status: EventStatus
  stage: string
  entity: string
  acl: 'snapshot' | 'none'
  ordering: 'reread' | 'epoch'
  tombstone: boolean
  purposes: readonly PurposeKey[]
  ids?: z.ZodObject
  description: string
}

const ids = z.array(z.uuid()).max(100)

// An emitted type, from the BUILD-PLAN step that first emits it.
function emitted<const Ids extends z.ZodObject, const P extends readonly PurposeKey[]>(
  stage: string,
  spec: {
    entity: string
    purposes: P
    ids: Ids
    description: string
  },
) {
  return {
    status: 'emitted',
    stage,
    acl: 'none',
    ordering: 'reread',
    tombstone: false,
    ...spec,
  } as const
}

// A reserved type: its step fills in the rest. Until then it carries no ids schema, so nothing
// can append it.
function reserved(stage: string, entity: string, description: string, tombstone = false) {
  return {
    status: 'reserved',
    stage,
    entity,
    acl: 'none',
    ordering: 'reread',
    tombstone,
    purposes: [],
    description,
  } as const
}

export const EVENTS = {
  // Emitted from C0.6.
  'signin.started': emitted('C0.6', {
    entity: 'person',
    purposes: ['accounts'],
    ids: z.strictObject({
      device: z.uuid(),
      session: z.uuid(),
      // sms: the code alone (no PIN role). sms_new_pin / sms_pin: a PIN-role holder's code, then
      // their new or existing PIN. sms_passkey: dormant (D46).
      method: z.enum(['sms', 'sms_new_pin', 'sms_pin', 'sms_passkey']),
      // Issued under the PIN rule: the person held a PIN role at issue (D46). C0.14's DPO alert
      // reads this, never the roles at alert time.
      pin_rule: z.boolean(),
    }),
    description: 'A person signed in on a device (issueSession)',
  }),
  'signin.ended': emitted('C0.6', {
    entity: 'person',
    purposes: ['accounts'],
    // The sessions' own revoke_reason, so signing out your own device is device_sign_out, as the
    // database records it; the actor says who.
    ids: z.strictObject({
      sessions: ids,
      devices: ids,
      reason: z.enum(['device_sign_out', 'deactivated', 'pin_reset']),
    }),
    description: 'Sign-in sessions ended: a device signed out, a deactivation or a PIN reset',
  }),
  'account.pin_set': emitted('C0.6', {
    entity: 'person',
    purposes: ['accounts'],
    ids: z.strictObject({}),
    description: 'A person set their PIN',
  }),
  'account.pin_reset': emitted('C0.6', {
    entity: 'person',
    purposes: ['accounts'],
    ids: z.strictObject({}),
    description: 'An admin reset a person’s PIN',
  }),
  'account.passkey_added': emitted('C0.6', {
    entity: 'person',
    purposes: ['accounts'],
    ids: z.strictObject({ passkey: z.uuid() }),
    description: 'A person added a passkey',
  }),
  'account.passkey_removed': emitted('C0.6', {
    entity: 'person',
    purposes: ['accounts'],
    ids: z.strictObject({ passkey: z.uuid() }),
    description: 'A person removed a passkey',
  }),
  'person.deactivated': emitted('C0.6', {
    entity: 'person',
    purposes: ['accounts'],
    ids: z.strictObject({}),
    description: 'An admin deactivated a person (offboarding consumes it)',
  }),
  'acl.changed': emitted('C0.6', {
    entity: 'person',
    purposes: ['accounts', 'content_delivery'],
    // keys: people's keys changed (subject_ids names them) and nothing stored was rewritten, so
    // consumers drop live state; rows: an item's stored ACL was rewritten (from C1.1, with the
    // snapshot and its new epoch). C0.16 adds its reasons for team and role changes.
    ids: z.strictObject({ change: z.enum(['keys', 'rows']), reason: z.enum(['deactivated']) }),
    description: 'Who can read something changed (BUILD-PLAN 1D, open items: the C0.6 outbox-envelope row)',
  }),
  'flag.changed': emitted('C0.6', {
    entity: 'feature_flag',
    purposes: ['service_operation'],
    // The entity is the flag's row, which consumers re-read for its key, cohort and revision (A9).
    ids: z.strictObject({ enabled: z.boolean() }),
    description: 'An Owner or Admin changed a feature flag',
  }),

  // Emitted from C0.9 (TECH-SPEC T22 item 13, C0.9 PD-22): a register entry changed, through the
  // DPO's routes or the first-Owner bootstrap. Ids only: the key and what it is now; a consumer
  // re-reads the row. They carry service_operation and name nobody as a subject.
  'register.purpose_changed': emitted('C0.9', {
    // The new version's row (processing_register): each change is a new version (C0.9 PD-04).
    entity: 'processing_purpose',
    purposes: ['service_operation'],
    ids: z.strictObject({ purpose: z.enum(PURPOSE_KEYS), status: z.enum(PURPOSE_STATUSES) }),
    description: 'The DPO recorded a new version of a purpose’s entry in the processing register',
  }),
  'register.transfer_changed': emitted('C0.9', {
    // The provider's row (transfer_register); cleared says whether it is cleared now.
    entity: 'transfer_entry',
    purposes: ['service_operation'],
    ids: z.strictObject({ provider: z.enum(PROVIDERS), cleared: z.boolean() }),
    description: 'A transfer-register entry’s facts or clearance changed',
  }),

  // Reserved: named in 0007's type list; the step after each gives it the rest.
  'person.added': reserved('C0.16', 'person', 'A person was added to the roster'),
  'person.updated': reserved('C0.16', 'person', 'A person’s roster entry changed'),
  'person.phone_changed': reserved('C0.16', 'person', 'A person’s phone number changed'),
  'department.changed': reserved('C0.16', 'department', 'A department was added or changed'),
  'team.changed': reserved('C0.16', 'team', 'A team was added, changed or archived'),
  'team.membership_changed': reserved(
    'C0.16',
    'person',
    'Someone joined or left a team (BUILD-PLAN 1D, open items: the C2.3 row)',
  ),
  'role.changed': reserved('C0.16', 'person', 'A role was granted or revoked'),
  'profile.updated': reserved('C0.15', 'person', 'A profile or working hours changed'),
  'notice.published': reserved('C0.9', 'notice', 'A privacy notice version was published'),
  'notice.acknowledged': reserved('C0.9', 'person', 'A person acknowledged a notice'),
  'message.created': reserved('C1.1', 'message', 'A message was posted'),
  'message.updated': reserved('C1.1', 'message', 'A message was edited (BUILD-PLAN 1D, open items: the C1.1 row)'),
  'message.deleted': reserved('C1.1', 'message', 'A message was deleted', true),
  'voice_message.created': reserved('C1.6', 'voice_message', 'A voice message was posted'),
  'task.created': reserved('C2.1', 'task', 'A task was created'),
  'task.updated': reserved('C2.1', 'task', 'A task changed'),
  'task.deleted': reserved('C2.1', 'task', 'A task was deleted', true),
  'task.overdue': reserved('C2.1', 'task', 'A task passed its due time (a delayed job appends it)'),
  'session.started': reserved('C2.4', 'session', 'A recorded room session started'),
  'session.ended': reserved('C2.4', 'session', 'A recorded room session ended'),
  'track_segment.written': reserved('C2.6', 'track_segment', 'A recording segment was written'),
  'redaction.applied': reserved('C2.11', 'redaction', 'A redaction was applied, so derived content regenerates'),
  'suggested_task.created': reserved('C3.5', 'suggested_task', 'A task was suggested'),
} as const satisfies Record<string, EventSpec>

export type EventType = keyof typeof EVENTS

// The tables that hold content: every write to one appends its event with an ACL snapshot, and none
// may be exempt (CLAUDE.md, Build order; apps/server/scripts/check-catalogues.ts refuses an
// exemption, by grant or through a function's writes, that touches one). Named here, apart from the
// coverage entries, so a content table whose every entry is exempt is still caught. Each content
// step adds its tables (C1.1's messages first).
export const CONTENT_TABLES: readonly string[] = []

export const EVENT_TYPES = Object.keys(EVENTS) as [EventType, ...EventType[]]

export type EmittedEventType = {
  [K in EventType]: (typeof EVENTS)[K]['status'] extends 'emitted' ? K : never
}[EventType]

export type IdsOf<T extends EmittedEventType> = z.infer<(typeof EVENTS)[T]['ids']>

export function isEventType(type: string): type is EventType {
  return Object.hasOwn(EVENTS, type)
}

export function isEmitted(type: string): type is EmittedEventType {
  return isEventType(type) && EVENTS[type].status === 'emitted'
}

// A later stage's names. A catalogue name in one of these namespaces must carry that stage, so no
// step takes another's names early.
export const RESERVED_NAMESPACES = {
  'session.': 'C2.4', // recorded room sessions; never sign-in sessions (T14 item 17)
  'message.': 'C1.1',
  'voice_message.': 'C1.6',
  'task.': 'C2.1',
  'room.': 'C2.2',
  'track_segment.': 'C2.6',
  'redaction.': 'C2.11',
  'event.': 'C3.1',
  'suggested_task.': 'C3.5',
  'file.': 'C4.1',
  'folder.': 'C4.1',
  'doc.': 'C4.2',
  'comment.': 'C4.5',
  'sheet.': 'C5.1',
  'slide.': 'C5.8',
  'correction.': 'C6.1',
  'transcript.': 'A1',
  'brain.': 'A2',
  'notes.': 'A3',
  'assistant.': 'A4',
  'agent.': 'A5',
} as const satisfies Record<string, string>
