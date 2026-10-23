import type { DriveOwner, Grantee, GrantRole, Id, OrgRole, Ref } from './model.ts'

// What someone asks to do. Content requests name a resource; admin requests name their target.
// Every request is decided by can() (Principle 1; CLAUDE.md: "can() decides every admin action").

// Actions on a resource that need nothing more than the resource.
export type ContentAction =
  | 'read'
  | 'post' // channel, conversation, standalone room, thread
  | 'join' // channel, room
  | 'leave' // channel, standalone room, group DM
  | 'manage' // channel or room settings (not visibility, not the restricted flag)
  | 'edit' // message, event, task, folder, file, comment
  | 'delete' // message, task, comment; never a session or a slide copy (REC-23)
  | 'cancel' // event
  | 'comment' // file: add a comment (DOC-05)
  | 'resolve' // comment
  | 'view_history' // file (SHEET-26, SLIDE-24)
  | 'share' // file or folder: may change its sharing at all; task: make a private task shared
  | 'present' // deck (SLIDE-14)
  | 'present_anyway' // deck, to an audience some of whom can't open it (SLIDE-18)
  | 'trash'
  | 'restore'
  | 'purge'
  | 'set_editors_can_share'
  | 'limit_editing'
  | 'correct' // session notes and transcript (REC-15)
  | 'view_viewed_by' // session access log (REC-21)
  | 'accept' // suggested task
  | 'dismiss' // suggested task

export type ContentRequest =
  | { action: ContentAction; resource: Ref }
  | { action: 'member.add' | 'member.remove'; resource: Ref; principal: { kind: 'human' | 'agent'; id: Id } }
  | { action: 'set_visibility'; resource: Ref; to: 'public' | 'private' }
  // Add, change (role) or remove (null) one grant on the item itself (FILE-03).
  | { action: 'share.set'; resource: Ref; grantee: Grantee; role: GrantRole | null }
  | { action: 'transfer_ownership'; resource: Ref; to: DriveOwner }

export type CreatableKind = 'channel' | 'room' | 'dm' | 'group_dm' | 'folder' | 'file' | 'event' | 'task'
export type CreateRequest = {
  action: 'create'
  kind: CreatableKind
  // For a channel or standalone room.
  visibility?: 'public' | 'private'
  // For a folder or file: the folder it goes in; none means My Drive.
  in?: Ref
}

export type AdminRequest =
  | { action: 'role.grant'; person: Id; role: OrgRole; teamId: Id | null }
  | { action: 'role.approve'; proposalId: Id }
  | { action: 'role.revoke'; person: Id; role: OrgRole; teamId: Id | null }
  // A roster add or one CSV row (ACC-03): the roles in it are decided as role grants, and its
  // manager as a manager change.
  | { action: 'person.add'; roles: readonly { role: OrgRole; teamId: Id | null }[]; manager: Id | null }
  // A console edit or CSV re-import of an existing person's manager (ACC-03).
  | { action: 'person.set_manager'; person: Id; manager: Id | null }
  | {
      action:
        | 'person.deactivate'
        | 'person.reset_pin'
        | 'person.change_phone'
        | 'person.sign_out_devices'
        | 'person.list_devices'
      person: Id
    }
  | { action: 'team.create' }
  | { action: 'team.archive'; team: Id }
  | { action: 'team.members.change'; team: Id; person: Id; op: 'add' | 'remove' }
  | { action: 'team.defaults.set'; team: Id; spaces: readonly Ref[] }
  | { action: 'org.defaults.set'; spaces: readonly Ref[] }
  | { action: 'audit_readers.change'; role: OrgRole; op: 'add' | 'remove' }
  | { action: 'audit_log.read' }
  | { action: 'room.restrict' | 'room.unrestrict'; room: Id }
  | { action: 'session.reclassify'; session: Id }
  | { action: 'recording_policy.set' | 'public_creation.set' }
  | { action: 'channel.transfer_ownership'; channel: Id; to: Id }
  | { action: 'privileged_console.open'; console: 'compliance' | 'dpo' }
  // Turn a feature flag on or off, or change its cohort (T17 item 9). The key is the registry's
  // (packages/shared FLAGS); whether the flag is locked is the database's to say.
  | { action: 'flag.set'; key: string }
  // The processing and transfer registers (PDPA-01, PDPA-10, PDPA-13; C0.9 PD-20): reading both,
  // recording a new version of a purpose's entry, and recording a provider's facts, clearing them
  // or withdrawing the clearance. The keys are the registries' (packages/shared PURPOSES and
  // PROVIDERS); whether an entry may be saved as it is is the database's to say.
  | { action: 'register.read' }
  | { action: 'register.purpose.set'; purpose: string }
  | { action: 'register.transfer.set'; provider: string; op: 'record' | 'clear' | 'withdraw' }
  // The privacy notice (PDPA-02, PDPA-03; C0.9 PD-49): reading the draft the registers make, with
  // its problems, the counts of who has acknowledged and the history, and publishing a version.
  | { action: 'notice.read' }
  | { action: 'notice.publish' }

// Your own session, devices and passkeys (ACC-02, ACC-04, T21), for any active person. Reading your
// own session, listing and signing out devices need no re-authentication and are never refused,
// though a device you name must be yours and still signed in. Adding or removing a passkey changes
// how the account is signed in to, so it needs a fresh re-authentication (T14), and a passkey you
// name must be yours and not removed.
export type SelfRequest =
  // No device: this one, or all your others (the server says which).
  | { action: 'devices.sign_out_own'; device?: Id }
  | { action: 'devices.list_own' }
  | { action: 'passkeys.add_own' }
  | { action: 'passkeys.remove_own'; passkey: Id }
  // Who you are and the client flags evaluated for you (the web shell: GET /api/session and
  // GET /api/flags; T17 item 11, T21), for any active person; never an assistant, an agent or the
  // system principal (R9-03), and no re-authentication. It names no one, so it can't reach anyone
  // else's session.
  | { action: 'session.read_own' }
  // The privacy notice (PDPA-02, PDPA-03, ACC-12; C0.9 PD-49): reading the current version with
  // your own acknowledgements, and acknowledging it, on this session's device, for any active
  // person and with no re-authentication, so the notice gate never locks anyone out.
  | { action: 'notice.read_own' }
  | { action: 'notice.acknowledge_own' }

// A live topic on the realtime gateway (BUILD-PLAN C0.7, TECH-SPEC T19 item 7): a person's own,
// their org's, or a team's. C1.1 adds spaces, decided by canRead or by membership (OD-05).
export type TopicKind = 'person' | 'org' | 'team'
export interface Topic {
  kind: TopicKind
  id: Id
}
export type TopicRequest = { action: 'topic.subscribe'; topic: Topic }

export type Request = ContentRequest | CreateRequest | AdminRequest | SelfRequest | TopicRequest

// What the server knows about the session making the request. Every admin request, and adding or
// removing your own passkey, needs a recent re-authentication (§9.4, T14); the server decides how
// recent and passes the result, computed by reauthenticated() (reauth.ts, D46).
export interface RequestContext {
  reauthenticated?: boolean
}

export const ADMIN_ACTIONS = new Set<string>([
  'role.grant',
  'role.approve',
  'role.revoke',
  'person.add',
  'person.set_manager',
  'person.deactivate',
  'person.reset_pin',
  'person.change_phone',
  'person.sign_out_devices',
  'person.list_devices',
  'team.create',
  'team.archive',
  'team.members.change',
  'team.defaults.set',
  'org.defaults.set',
  'audit_readers.change',
  'audit_log.read',
  'room.restrict',
  'room.unrestrict',
  'session.reclassify',
  'recording_policy.set',
  'public_creation.set',
  'channel.transfer_ownership',
  'privileged_console.open',
  'flag.set',
  'register.read',
  'register.purpose.set',
  'register.transfer.set',
  'notice.read',
  'notice.publish',
])

export function isAdminRequest(request: Request): request is AdminRequest {
  return ADMIN_ACTIONS.has(request.action)
}

export const SELF_ACTIONS = new Set<string>([
  'devices.sign_out_own',
  'devices.list_own',
  'passkeys.add_own',
  'passkeys.remove_own',
  'session.read_own',
  'notice.read_own',
  'notice.acknowledge_own',
])

export function isSelfRequest(request: Request): request is SelfRequest {
  return SELF_ACTIONS.has(request.action)
}

export const TOPIC_ACTIONS = new Set<string>(['topic.subscribe'])

export function isTopicRequest(request: Request): request is TopicRequest {
  return TOPIC_ACTIONS.has(request.action)
}
