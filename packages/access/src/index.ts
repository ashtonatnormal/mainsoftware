// The permission model (PRD §7.2, B.4). Every access check in Hearth goes through this package
// (Principle 1): can() for anything a subject asks to do, the read rule behind it (readersOf and
// keysOf), the audience functions for Rule 2 and Rule 3, the index class for search and the
// Org Brain, and the row shape the SQL filter (@hearth/access/sql) reads. No role reads content
// here: privileged access (Rule 9) lives only in the server's Rule 9 module. From C0.7 it also
// decides the realtime gateway's live topics (topic.subscribe; canTopics for the re-checks). From
// C0.8 it decides who signs in with the PIN and how a session re-authenticates (reauth.ts, D46).
export { isAdmin, isOwner } from './admin.ts'
export {
  type Audience,
  type AudienceGap,
  audienceGap,
  audienceOf,
  audienceOfPeople,
  audiencePeople,
  covers,
  holdersOf,
  isOpenToken,
  sameAudience,
  stampFor,
} from './audience.ts'
export { can, canRead, containersOf, inScope, isLive } from './can.ts'
export { atLeast, isItemOwner, maySetSharing, roleOn, trashState } from './drive.ts'
export { type IndexClass, indexClassOf, SEARCHABLE_CLASSES, strictest } from './index-class.ts'
export { eraToken, keysOf, membersToken, orgToken, personToken, teamAdminsToken, teamToken } from './keys.ts'
export { type AclRow, aclOf, filterReadable, listAccessible, type SourceRun, sourceAllowed } from './lists.ts'
export * from './model.ts'
export { type Acl, allows, attendeesOf, NOBODY, readersOf } from './readers.ts'
export { holdsPinRole, type ReauthFacts, reauthenticated, reauthMethodOf } from './reauth.ts'
export type {
  AdminRequest,
  ContentAction,
  ContentRequest,
  CreatableKind,
  CreateRequest,
  Request,
  RequestContext,
  SelfRequest,
  Topic,
  TopicKind,
  TopicRequest,
} from './requests.ts'
export { canTopics, TOPIC_KINDS, topicToken } from './topics.ts'
export { World } from './world.ts'
