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

// Your own devices and passkeys (ACC-02, ACC-04), for any active person. Listing and signing out
// devices need no re-authentication and are never refused, though a device you name must be yours
// and still signed in. Adding or removing a passkey changes how the account is signed in to, so it
// needs a fresh re-authentication (T14), and a passkey you name must be yours and not removed.
export type SelfRequest =
  // No device: this one, or all your others (the server says which).
  | { action: 'devices.sign_out_own'; device?: Id }
  | { action: 'devices.list_own' }
  | { action: 'passkeys.add_own' }
  | { action: 'passkeys.remove_own'; passkey: Id }

export type Request = ContentRequest | CreateRequest | AdminRequest | SelfRequest

// What the server knows about the session making the request. Every admin request, and adding or
// removing your own passkey, needs a recent re-authentication (§9.4, T14); the server decides how
// recent and passes the result.
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
])

export function isAdminRequest(request: Request): request is AdminRequest {
  return ADMIN_ACTIONS.has(request.action)
}

export const SELF_ACTIONS = new Set<string>([
  'devices.sign_out_own',
  'devices.list_own',
  'passkeys.add_own',
  'passkeys.remove_own',
])

export function isSelfRequest(request: Request): request is SelfRequest {
  return SELF_ACTIONS.has(request.action)
}
