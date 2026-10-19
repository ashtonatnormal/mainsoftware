// The facts every access decision is made from (PRD §7.2, B.4). They mirror the database rows
// (C0.3 for people, roles and teams; C0.5 for devices and passkeys; the later stages for channels,
// rooms, sessions and the Drive), with every fact that ends or narrows access a required field, so
// a loader that leaves one out fails typecheck instead of widening access (`T | null` mirrors a
// nullable column).

export type Id = string

// An access token: who a reader set names. `o:` everyone active in the org (and anyone who joins
// later), `t:` a team's current members, `ta:` a team's current Team Admins, `m:` a space's current
// members, `e:` one membership era of a group DM, `p:` one person. Ids are prefixed by kind, so a
// team and a person with the same id never match, and the org token carries the org's id (ACC-11).
export type Token = string

// Org roles as role_assignments stores them (ACC-10). Member has no row: every active person on
// the roster is a Member.
export type OrgRole = 'owner' | 'admin' | 'ai_admin' | 'leadership' | 'dpo' | 'compliance_officer' | 'team_admin'
// The roles only an Owner grants or removes (CLAUDE.md, Database).
export const OWNER_ONLY_ROLES: readonly OrgRole[] = [
  'owner',
  'admin',
  'ai_admin',
  'leadership',
  'dpo',
  'compliance_officer',
]
// The privileged roles (D46): they sign in and re-authenticate with the account PIN after the SMS
// code. Named PIN_ROLES, not by the word privileged, which R9-02 keeps for Rule 9 alone. The
// owner's default is the roles only an Owner grants; roles.test.ts pins the two lists equal, so
// splitting them is a reviewed change. A code constant: flags never gate an access or safety
// control (CLAUDE.md, Database).
export const PIN_ROLES: readonly OrgRole[] = OWNER_ONLY_ROLES
// The roles whose grant needs a second approver, because they open Rule 9 access (PRD-85).
export const TWO_PERSON_ROLES: readonly OrgRole[] = ['dpo', 'compliance_officer']
// The roles the audit-log readers setting can name (D45: never Team Admin).
export type AuditReaderRole = Exclude<OrgRole, 'team_admin'>

// Roles on a Drive item (DOC-03, FILE-03). A grant gives at most Editor: the Owner is the item's
// owner field, never a grant, so no share can create or remove one.
export type GrantRole = 'viewer' | 'commenter' | 'editor'
export type ItemRole = GrantRole | 'owner'
export const ITEM_ROLE_RANK: Record<ItemRole, number> = { viewer: 1, commenter: 2, editor: 3, owner: 4 }

export type Grantee = { kind: 'person'; id: Id } | { kind: 'team'; id: Id } | { kind: 'org'; id: Id }
export type Grant = { grantee: Grantee; role: GrantRole }
// A Drive item is owned by one person or one team (ACC-05 moves ownership to a manager or a team).
export type DriveOwner = { kind: 'person'; id: Id } | { kind: 'team'; id: Id }

export type ResourceKind =
  | 'channel'
  | 'dm'
  | 'group_dm'
  | 'agent_dm'
  | 'assistant_chat'
  | 'room'
  | 'thread'
  | 'message'
  | 'session'
  | 'slide_copy'
  | 'event'
  | 'task'
  | 'suggested_task'
  | 'folder'
  | 'file'
  | 'comment'
  | 'derived'
export type Ref = { kind: ResourceKind; id: Id }
export type ConversationKind = 'dm' | 'group_dm' | 'agent_dm' | 'assistant_chat'

export interface PersonFact {
  id: Id
  deactivatedAt: number | null
}
export interface RoleFact {
  personId: Id
  role: OrgRole
  teamId: Id | null
  revokedAt: number | null
}
// A DPO or Compliance Officer grant waiting for its second approver (C0.16 keeps these apart from
// role_assignments until approved).
export interface RoleProposalFact {
  id: Id
  personId: Id
  role: 'dpo' | 'compliance_officer'
  proposedBy: Id
  approvedAt: number | null
  withdrawnAt: number | null
}
export interface TeamFact {
  id: Id
  archivedAt: number | null
}
export interface TeamMemberFact {
  teamId: Id
  personId: Id
  removedAt: number | null
}
// An agent's scope is part of the agent version being run (the published one, or the draft under
// test in STU-02), so it comes from the facts, never from the caller (AGT-04).
export interface AgentFact {
  id: Id
  scope: readonly Ref[]
  archivedAt: number | null
}
export interface AssistantFact {
  id: Id
  ownerId: Id
  archivedAt: number | null
}
export interface ChannelFact {
  id: Id
  visibility: 'public' | 'private'
  ownerTeamId: Id | null
  owners: readonly Id[]
  archivedAt: number | null
}
export interface ConversationFact {
  id: Id
  kind: ConversationKind
  // The person whose assistant conversation this is (PA-01); null for every other kind.
  ownerId: Id | null
}
// Membership of a channel, standalone room or conversation, as one span. Messages carry a
// per-space sequence number (C1.1), and a group-DM member reads only the messages sequenced in
// one of their spans: afterSeq < seq ≤ throughSeq (decision 10, PRD-79). throughSeq null = current.
export interface MembershipFact {
  id: Id
  spaceId: Id
  principalId: Id
  afterSeq: number
  throughSeq: number | null
}
export interface MessageFact {
  id: Id
  spaceId: Id
  seq: number
  authorId: Id
  deletedAt: number | null
}
// A room belongs to a channel, stands alone (public = whole org, or private), or is a meeting's
// own room (CAL-03, private to its invitees). Any of them may be restricted (REC-07).
export type RoomFact = {
  id: Id
  restricted: boolean
  ownerTeamId: Id | null
  owners: readonly Id[]
  archivedAt: number | null
} & (
  | { kind: 'channel_room'; channelId: Id }
  | { kind: 'standalone'; visibility: 'public' | 'private' }
  | { kind: 'meeting'; eventId: Id }
)
// A thread with its own audience (REC-13): a meeting's event thread, or a participants-only
// thread for a group-DM call not everyone joined. Ordinary threads are messages of their space.
export type ThreadFact = { id: Id; audience: { kind: 'event'; eventId: Id } | { kind: 'call'; sessionId: Id } }
// What C2.4 stamps when a session starts (REC-20): who its recording, transcript and notes go to.
// A space stamp is evaluated live, so future members of the channel or room are included and
// people who leave drop out (SLIDE-18, Rule 6). A meeting stamps its invitees at the start, so
// someone invited later doesn't gain an earlier occurrence. restricted is on every variant: a
// restricted session is participants-only whatever its base audience (Rule 5).
export type SessionStamp = { restricted: boolean } & (
  | { audience: 'space'; spaceId: Id }
  | { audience: 'invitees_and_participants'; eventId: Id; invitees: readonly Id[] }
  | { audience: 'participants' }
)
export interface SessionFact {
  id: Id
  place: { kind: 'room'; roomId: Id } | { kind: 'conversation'; conversationId: Id }
  // The humans who took part (REC-01: agents don't count).
  participants: readonly Id[]
  stamp: SessionStamp
}
export interface SlideCopyFact {
  id: Id
  sessionId: Id
  // Some of the session's audience couldn't open the deck when it was shown (SLIDE-34).
  playbackOnly: boolean
}
export interface EventFact {
  id: Id
  organiserId: Id
  invitees: readonly Id[]
}
export interface TaskFact {
  id: Id
  creatorId: Id
  assignees: readonly Id[]
  teamId: Id | null
  // A private task is its owner's only, until they share it (Rule 5).
  privateToId: Id | null
  sourceRef: Ref | null
}
export interface SuggestedTaskFact {
  id: Id
  ownerId: Id
  sourceRef: Ref | null
}
export interface FolderFact {
  id: Id
  parentId: Id | null
  owner: DriveOwner
  grants: readonly Grant[]
  // Editors may share unless the Owner turns it off (FILE-03, decision 17).
  editorsCanShare: boolean
  trashedAt: number | null
  trashedById: Id | null
}
export type FileSubtype = 'doc' | 'sheet' | 'deck' | 'upload'
export interface FileFact {
  id: Id
  subtype: FileSubtype
  // A chat attachment's parent is its message, whose readers it takes (CHAT-06).
  parent: { kind: 'folder'; id: Id } | { kind: 'message'; id: Id } | { kind: 'root' }
  owner: DriveOwner
  grants: readonly Grant[]
  // Restricted editing: only these people may edit; other Editors comment (DOC-03, D19).
  editingLimitedTo: readonly Id[] | null
  // Editors may share unless the Owner turns it off (FILE-03, decision 17).
  editorsCanShare: boolean
  trashedAt: number | null
  trashedById: Id | null
}
export interface CommentFact {
  id: Id
  fileId: Id
  authorId: Id
  deletedAt: number | null
}
// Anything made from other items (summaries, notes, digests): readable only by people who can
// read every source (Rule 3).
export interface DerivedFact {
  id: Id
  sources: readonly Ref[]
}
// A device someone signed in on (ACC-04) and a passkey on their account (ACC-02). Only requests
// about your own devices and passkeys read them, so a loader holds the requester's alone (T14).
export interface DeviceFact {
  id: Id
  userId: Id
  signedOutAt: number | null
}
export interface PasskeyFact {
  id: Id
  userId: Id
  removedAt: number | null
}
export interface OrgSettings {
  // Who may create public channels and standalone rooms (ADM-03, ROOM-01).
  publicCreation: 'everyone' | 'admins'
}

export interface Facts {
  org: { id: Id }
  settings: OrgSettings
  people: readonly PersonFact[]
  roles: readonly RoleFact[]
  roleProposals: readonly RoleProposalFact[]
  teams: readonly TeamFact[]
  teamMembers: readonly TeamMemberFact[]
  // The roles the org lets read the audit log (D45), current entries only.
  auditLogReaders: readonly AuditReaderRole[]
  agents: readonly AgentFact[]
  assistants: readonly AssistantFact[]
  channels: readonly ChannelFact[]
  conversations: readonly ConversationFact[]
  memberships: readonly MembershipFact[]
  messages: readonly MessageFact[]
  rooms: readonly RoomFact[]
  threads: readonly ThreadFact[]
  sessions: readonly SessionFact[]
  slideCopies: readonly SlideCopyFact[]
  events: readonly EventFact[]
  tasks: readonly TaskFact[]
  suggestedTasks: readonly SuggestedTaskFact[]
  folders: readonly FolderFact[]
  files: readonly FileFact[]
  comments: readonly CommentFact[]
  derived: readonly DerivedFact[]
  devices: readonly DeviceFact[]
  passkeys: readonly PasskeyFact[]
}

// Who acts: one case per principal kind (principals.kind, C0.3), the "union subject" of
// BUILD-PLAN C0.4. An assistant's owner and an agent's scope come from the facts, not from here.
export type Subject =
  | { kind: 'human'; id: Id }
  | { kind: 'assistant'; id: Id }
  | { kind: 'agent'; id: Id }
  | { kind: 'system'; id: Id }
