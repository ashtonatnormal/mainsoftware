// The fixture org for the access-rule suite, the role matrix and the leak suite (C0.4; STU-02,
// STU-03 and A2.4 use it later). It is Tembusu Logistics from db/seed/tembusu.sql (the same org,
// people, teams and roles, by id) with the demo's content ported onto it (BUILD-PLAN 1E.5), plus
// fixture-only additions the cases need:
// - a CFO and a public org-wide #general, and a Finance agent whose scope holds the Q3 numbers
//   (§7.2's CFO case);
// - a restricted "People 1:1s" room with sessions (RMS-55), and spaces, sessions and items no
//   role holder is in, so a role that widened reads would be caught;
// - a group DM with join and leave eras, a person who has left with a role never revoked, a
//   revoked Admin, an archived team with a Team Admin, a pending DPO grant, and a second org.
// Everything here is made up; nothing is anyone's data. Test-only: the server image leaves out
// testing/ folders.
import type {
  ChannelFact,
  ConversationFact,
  Facts,
  FileFact,
  FolderFact,
  Grant,
  Id,
  MembershipFact,
  MessageFact,
  Ref,
  RoomFact,
  SessionFact,
  Subject,
} from '../model.ts'
import { World } from '../world.ts'

const seedPerson = (n: string) => `b0000000-0000-4000-8000-0000000000${n}`
const seedTeam = (n: string) => `d0000000-0000-4000-8000-0000000000${n}`

export const ORG = 'a0000000-0000-4000-8000-000000000001'
export const ORG_2 = 'a0000000-0000-4000-8000-000000000002'
export const HEARTH = seedPerson('00')

// People: the seed's twelve (01-12), then fixture-only ones.
export const P = {
  ashton: seedPerson('01'), // Owner, DPO
  priya: seedPerson('02'), // Leadership
  marcus: seedPerson('03'), // Team Admin of Operations
  farah: seedPerson('04'),
  weiling: seedPerson('05'), // Leadership, Compliance Officer
  ahmad: seedPerson('06'), // Leadership
  rachel: seedPerson('07'),
  daniel: seedPerson('08'),
  huimin: seedPerson('09'), // Team Admin of People
  arjun: seedPerson('10'), // Admin, AI Admin
  kelvin: seedPerson('11'),
  nadia: seedPerson('12'),
  cfo: seedPerson('13'), // fixture: Lim Siew Hoon, CFO
  formerDpo: seedPerson('14'), // fixture: has left; the DPO role was never revoked
  formerAdmin: seedPerson('15'), // fixture: the Admin role was revoked
} as const
export const SEED_PEOPLE = [
  P.ashton,
  P.priya,
  P.marcus,
  P.farah,
  P.weiling,
  P.ahmad,
  P.rachel,
  P.daniel,
  P.huimin,
  P.arjun,
  P.kelvin,
  P.nadia,
]

export const T = {
  leadership: seedTeam('01'),
  operations: seedTeam('02'),
  finance: seedTeam('03'),
  sales: seedTeam('04'),
  design: seedTeam('05'),
  people: seedTeam('06'),
  it: seedTeam('07'),
  fleet: seedTeam('08'),
  customerSuccess: seedTeam('09'),
  nightShift: seedTeam('10'), // fixture: archived
  q4: seedTeam('11'), // fixture: Q4 launch (the demo's "Q4 launch crew", as a directory team, DRV-55)
} as const

export const AG = { digest: 'ag-weekly-digest', it: 'ag-it-helpdesk', finance: 'ag-finance', hr: 'ag-hr-policy' }
export const AS = { ashton: 'as-ashton', daniel: 'as-daniel' }

export const C = {
  general: 'ch-general',
  announcements: 'ch-announcements',
  ops: 'ch-ops-north-site',
  askHr: 'ch-ask-hr',
  sales: 'ch-sales',
  design: 'ch-design',
  leadership: 'ch-leadership', // private
  welcome: 'ch-welcome',
  it: 'ch-it-help',
  studio: 'ch-design-crit', // fixture: private, Daniel and Rachel only
} as const
export const CV = {
  ashtonPriya: 'dm-ashton-priya',
  ashtonMarcus: 'dm-ashton-marcus',
  cfoWeiling: 'dm-cfo-weiling',
  farahKelvin: 'dm-farah-kelvin',
  q4: 'gdm-q4-launch-crew',
  floor: 'gdm-floor',
  itHelpdesk: 'adm-ashton-it',
  cfoFinance: 'adm-cfo-finance',
  ashtonAssistant: 'ac-ashton',
  danielAssistant: 'ac-daniel',
} as const
export const R = {
  ops: 'rm-ops-standup', // the room of #ops-north-site
  design: 'rm-design',
  sales: 'rm-sales-floor', // the Sales team's room; the Q3 pricing review was held here
  lounge: 'rm-lounge', // standalone, public
  people: 'rm-people-1on1s', // standalone, private, restricted (RMS-55)
  q4: 'rm-q4-launch-review', // the Q4 launch review's own meeting room
  board: 'rm-board', // standalone, private
  townhall: 'rm-townhall', // standalone, public, restricted (RMS-58)
  leadershipOneOnOnes: 'rm-leadership-1on1s', // the room of private #leadership, restricted
} as const
export const TH = { q4Event: 'th-q4-review', q4Call: 'th-q4-call' } as const
export const E = {
  pricing: 'ev-q3-pricing-review',
  standup: 'ev-ops-standup',
  q4: 'ev-q4-launch-review',
  priyaOneOnOne: 'ev-1on1-priya',
  allHands: 'ev-all-hands',
} as const
export const S = {
  pricing: 'ss-q3-pricing-review', // a meeting in a team room: invitees + participants (RMS-44)
  standupFri: 'ss-ops-standup-fri', // a room session in a public channel's room
  designShort: 'ss-design-short',
  peopleAshton: 'ss-people-ashton', // restricted: Hui Min and Ashton
  peopleFloor: 'ss-people-floor', // restricted: Farah and Kelvin, no role holder
  peopleBefore: 'ss-people-before-restricted', // stamped before the room was restricted
  opsRestricted: 'ss-ops-restricted', // stamped restricted in a room that isn't any more
  q4Call: 'ss-q4-call', // a group-DM call Ahmad missed
  dmCall: 'ss-dm-call', // a DM call both took part in
  q4Review: 'ss-q4-launch-review',
} as const
export const SC = { pricing: 'sc-pricing-1', people: 'sc-people-1', standupPlayback: 'sc-standup-1' } as const
export const F = {
  q4: 'f-q4-launch',
  q4Contract: 'f-q4-contract',
  ops: 'f-ops-wiki', // owned by the Operations team
  hr: 'f-hr-wiki',
  people: 'f-people', // owned by the People team
  it: 'f-it-wiki',
  board: 'f-board-pack',
  vendor: 'f-vendor-quotes',
} as const
export const FI = {
  q4Proposal: 'd-q4-proposal',
  leavePolicy: 'd-leave-policy',
  runbook: 'd-safety-runbook',
  checklist: 'd-day-one-checklist',
  boardUpdate: 'd-board-update',
  otRoster: 'sh-ot-roster',
  forecast: 'sh-q4-forecast',
  movers: 'sh-movers-quotes',
  q3Numbers: 'sh-q3-numbers', // the CFO's
  q4Deck: 'dk-q4-review',
  allHandsDeck: 'dk-all-hands',
  otPdf: 'up-ot-roster', // a chat attachment in #ops-north-site
  kranji: 'up-kranji-quote',
  swift: 'up-swiftmove-quote',
  msa: 'up-meridian-msa',
  q3Pdf: 'up-q3-results',
  rachelNotes: 'd-rachel-notes', // fixture: Rachel's, shared with nobody
  opsPolicy: 'd-ops-policy', // fixture: owned by Operations, editing limited to Marcus
  nightRota: 'd-night-rota', // fixture: shared with the archived Night shift team
  q4Attachment: 'up-q4-sketch', // fixture: an attachment in the group DM, before Daniel joined
} as const
export const CM = { q4Daniel: 'cm-q4-daniel', q4Ahmad: 'cm-q4-ahmad', q4Deleted: 'cm-q4-deleted' } as const
export const TK = {
  ot: 'tk-approve-ot',
  board: 'tk-board-pack',
  sheet: 'tk-price-sheet',
  private: 'tk-people-private', // from a restricted session, private to Hui Min
  checklist: 'tk-day-one-checklist',
  fromDm: 'tk-movers-vendor', // made from a DM message
} as const
export const ST = { board: 'st-board-pack', people: 'st-people' } as const
export const DV = {
  digest: 'dv-weekly-digest', // from the Q3 pricing review (CHT-50)
  opsSummary: 'dv-ops-summary',
  mixed: 'dv-ops-and-forecast',
  restrictedNote: 'dv-people-notes',
  empty: 'dv-no-sources',
} as const
export const PROPOSAL = { priyaDpo: 'pr-priya-dpo' } as const

// Messages, by space, in sequence order. A null author means the space's first human member.
export const M = {
  general: 'm-general-1',
  announcement: 'm-announcement-1',
  ops1: 'm-ops-1',
  ops2: 'm-ops-2',
  ops3: 'm-ops-3',
  ops4: 'm-ops-4',
  opsFile: 'm-ops-5', // carries the OT roster PDF
  opsDeleted: 'm-ops-6',
  askHr: 'm-ask-hr-1',
  sales: 'm-sales-1',
  design: 'm-design-1',
  digest: 'm-leadership-1', // the Weekly Digest's post
  leadership: 'm-leadership-2',
  welcome: 'm-welcome-1',
  it: 'm-it-1',
  itDeleted: 'm-it-2',
  studio: 'm-studio-1',
  priya1: 'm-dm-priya-1',
  priya2: 'm-dm-priya-2',
  marcus: 'm-dm-marcus-1',
  cfoQ3: 'm-dm-cfo-1', // "Q3 numbers" in the CFO's DM with Wei Ling
  farahKelvin: 'm-dm-farah-kelvin-1',
  q4First: 'm-q4-1', // seq 1, with the sketch attached
  q4Second: 'm-q4-2', // seq 2; Daniel joins after it
  q4Third: 'm-q4-3', // seq 3; Ahmad leaves after it
  q4Fourth: 'm-q4-4', // seq 4, while Ahmad was out; he rejoins after it
  q4Fifth: 'm-q4-5', // seq 5
  q4Deleted: 'm-q4-6', // seq 6, deleted
  floor: 'm-floor-1',
  itHelp1: 'm-adm-it-1',
  itHelp2: 'm-adm-it-2',
  finance: 'm-adm-finance-1',
  assistant: 'm-ac-ashton-1',
  danielAssistant: 'm-ac-daniel-1',
  q4EventThread: 'm-th-q4-review-1',
  q4CallThread: 'm-th-q4-call-1',
  lounge: 'm-lounge-1',
  peopleRoom: 'm-people-room-1',
} as const

// Every resource in the fixture, by kind, for loops over "everything".
export const ALL_REFS = (): Ref[] => {
  const world = fixtureWorld()
  const kinds = [
    'channel',
    'dm',
    'group_dm',
    'agent_dm',
    'assistant_chat',
    'room',
    'thread',
    'message',
    'session',
    'slide_copy',
    'event',
    'task',
    'suggested_task',
    'folder',
    'file',
    'comment',
    'derived',
  ] as const
  return kinds.flatMap(kind => world.all(kind).map(fact => ({ kind, id: (fact as { id: Id }).id })))
}

export const human = (id: Id): Subject => ({ kind: 'human', id })
export const assistant = (id: Id): Subject => ({ kind: 'assistant', id })
export const agent = (id: Id): Subject => ({ kind: 'agent', id })
export const system: Subject = { kind: 'system', id: HEARTH }

export const ref = {
  channel: (id: Id): Ref => ({ kind: 'channel', id }),
  dm: (id: Id): Ref => ({ kind: 'dm', id }),
  groupDm: (id: Id): Ref => ({ kind: 'group_dm', id }),
  agentDm: (id: Id): Ref => ({ kind: 'agent_dm', id }),
  assistantChat: (id: Id): Ref => ({ kind: 'assistant_chat', id }),
  room: (id: Id): Ref => ({ kind: 'room', id }),
  thread: (id: Id): Ref => ({ kind: 'thread', id }),
  message: (id: Id): Ref => ({ kind: 'message', id }),
  session: (id: Id): Ref => ({ kind: 'session', id }),
  slideCopy: (id: Id): Ref => ({ kind: 'slide_copy', id }),
  event: (id: Id): Ref => ({ kind: 'event', id }),
  task: (id: Id): Ref => ({ kind: 'task', id }),
  suggestedTask: (id: Id): Ref => ({ kind: 'suggested_task', id }),
  folder: (id: Id): Ref => ({ kind: 'folder', id }),
  file: (id: Id): Ref => ({ kind: 'file', id }),
  comment: (id: Id): Ref => ({ kind: 'comment', id }),
  derived: (id: Id): Ref => ({ kind: 'derived', id }),
}

const ALL_STAFF = [...SEED_PEOPLE, P.cfo]

function channel(id: Id, visibility: 'public' | 'private', owners: Id[], ownerTeamId: Id | null = null): ChannelFact {
  return { id, visibility, ownerTeamId, owners, archivedAt: null }
}
function conversation(id: Id, kind: ConversationFact['kind'], ownerId: Id | null = null): ConversationFact {
  return { id, kind, ownerId }
}
// Current members of a space, joined before its first message.
function members(spaceId: Id, principals: readonly Id[]): MembershipFact[] {
  return principals.map(principalId => ({
    id: `mb:${spaceId}:${principalId}`,
    spaceId,
    principalId,
    afterSeq: 0,
    throughSeq: null,
  }))
}
function messages(spaceId: Id, rows: readonly [Id, Id][]): MessageFact[] {
  return rows.map(([id, authorId], i) => ({ id, spaceId, seq: i + 1, authorId, deletedAt: null }))
}
function folder(id: Id, owner: FolderFact['owner'], grants: Grant[], parentId: Id | null = null): FolderFact {
  return { id, parentId, owner, grants, trashedAt: null, trashedById: null }
}
function file(
  id: Id,
  subtype: FileFact['subtype'],
  parent: FileFact['parent'],
  owner: FileFact['owner'],
  grants: Grant[] = [],
  editingLimitedTo: Id[] | null = null,
): FileFact {
  return {
    id,
    subtype,
    parent,
    owner,
    grants,
    editingLimitedTo,
    editorsCanShare: true,
    trashedAt: null,
    trashedById: null,
  }
}
const person = (id: Id) => ({ kind: 'person' as const, id })
const team = (id: Id) => ({ kind: 'team' as const, id })
const orgGrantee = { kind: 'org' as const, id: ORG }
const inFolder = (id: Id) => ({ kind: 'folder' as const, id })
const atRoot = { kind: 'root' as const }
const attachedTo = (id: Id) => ({ kind: 'message' as const, id })
type RoomShape = RoomFact extends infer R
  ? R extends unknown
    ? Omit<R, 'id' | 'ownerTeamId' | 'archivedAt'>
    : never
  : never
function room(id: Id, rest: RoomShape & { ownerTeamId?: Id }): RoomFact {
  return { ownerTeamId: null, archivedAt: null, ...rest, id } as RoomFact
}
function session(id: Id, place: SessionFact['place'], participants: Id[], stamp: SessionFact['stamp']): SessionFact {
  return { id, place, participants, stamp }
}

// A fresh copy of the fixture's facts each call, so a case can change them freely.
export function fixtureFacts(): Facts {
  const teamMembers: [Id, Id[]][] = [
    [T.leadership, [P.ashton, P.priya, P.weiling, P.ahmad]],
    [T.operations, [P.priya, P.marcus, P.farah, P.kelvin]],
    [T.finance, [P.weiling, P.cfo]],
    [T.sales, [P.ahmad, P.rachel]],
    [T.design, [P.daniel]],
    [T.people, [P.huimin]],
    [T.it, [P.arjun]],
    [T.fleet, [P.kelvin]],
    [T.customerSuccess, [P.nadia]],
    [T.nightShift, [P.kelvin, P.farah]],
    [T.q4, [P.ashton, P.priya, P.daniel, P.ahmad, P.weiling]],
  ]
  const q4Eras: MembershipFact[] = [
    ...members(CV.q4, [P.ashton, P.priya]),
    { id: `mb:${CV.q4}:${P.daniel}`, spaceId: CV.q4, principalId: P.daniel, afterSeq: 2, throughSeq: null },
    { id: `mb:${CV.q4}:${P.ahmad}:1`, spaceId: CV.q4, principalId: P.ahmad, afterSeq: 0, throughSeq: 3 },
    { id: `mb:${CV.q4}:${P.ahmad}:2`, spaceId: CV.q4, principalId: P.ahmad, afterSeq: 4, throughSeq: null },
  ]
  const q4Messages = messages(CV.q4, [
    [M.q4First, P.ashton],
    [M.q4Second, P.priya],
    [M.q4Third, P.daniel],
    [M.q4Fourth, P.priya],
    [M.q4Fifth, P.ahmad],
    [M.q4Deleted, P.priya],
  ]).map(m => (m.id === M.q4Deleted ? { ...m, deletedAt: 1 } : m))

  return {
    org: { id: ORG },
    settings: { publicCreation: 'admins' },
    people: [
      ...[...ALL_STAFF, P.formerAdmin].map(id => ({ id, deactivatedAt: null })),
      { id: P.formerDpo, deactivatedAt: 1 },
    ],
    roles: [
      { personId: P.ashton, role: 'owner', teamId: null, revokedAt: null },
      { personId: P.ashton, role: 'dpo', teamId: null, revokedAt: null },
      { personId: P.arjun, role: 'admin', teamId: null, revokedAt: null },
      { personId: P.arjun, role: 'ai_admin', teamId: null, revokedAt: null },
      { personId: P.priya, role: 'leadership', teamId: null, revokedAt: null },
      { personId: P.weiling, role: 'leadership', teamId: null, revokedAt: null },
      { personId: P.ahmad, role: 'leadership', teamId: null, revokedAt: null },
      { personId: P.weiling, role: 'compliance_officer', teamId: null, revokedAt: null },
      { personId: P.huimin, role: 'team_admin', teamId: T.people, revokedAt: null },
      { personId: P.marcus, role: 'team_admin', teamId: T.operations, revokedAt: null },
      // Fixture-only.
      { personId: P.formerDpo, role: 'dpo', teamId: null, revokedAt: null },
      { personId: P.formerAdmin, role: 'admin', teamId: null, revokedAt: 1 },
      { personId: P.farah, role: 'team_admin', teamId: T.nightShift, revokedAt: null },
    ],
    roleProposals: [
      {
        id: PROPOSAL.priyaDpo,
        personId: P.priya,
        role: 'dpo',
        proposedBy: P.ashton,
        approvedAt: null,
        withdrawnAt: null,
      },
    ],
    teams: Object.values(T).map(id => ({ id, archivedAt: id === T.nightShift ? 1 : null })),
    teamMembers: teamMembers.flatMap(([teamId, people]) =>
      people.map(personId => ({ teamId, personId, removedAt: null })),
    ),
    auditLogReaders: [],
    agents: [
      { id: AG.digest, scope: [ref.channel(C.leadership), ref.channel(C.sales), ref.room(R.sales)], archivedAt: null },
      { id: AG.it, scope: [ref.channel(C.it), ref.folder(F.it)], archivedAt: null },
      { id: AG.finance, scope: [ref.file(FI.q3Numbers), ref.channel(C.general)], archivedAt: null },
      { id: AG.hr, scope: [ref.folder(F.hr)], archivedAt: null },
    ],
    assistants: [
      { id: AS.ashton, ownerId: P.ashton, archivedAt: null },
      { id: AS.daniel, ownerId: P.daniel, archivedAt: null },
    ],
    channels: [
      channel(C.general, 'public', [P.ashton]),
      channel(C.announcements, 'public', [P.huimin]),
      channel(C.ops, 'public', [P.priya], T.operations),
      channel(C.askHr, 'public', [P.huimin], T.people),
      channel(C.sales, 'public', [P.ahmad], T.sales),
      channel(C.design, 'public', [P.daniel], T.design),
      channel(C.leadership, 'private', [P.ashton], T.leadership),
      channel(C.welcome, 'public', [P.huimin]),
      channel(C.it, 'public', [P.arjun], T.it),
      channel(C.studio, 'private', [P.daniel], T.design),
    ],
    conversations: [
      conversation(CV.ashtonPriya, 'dm'),
      conversation(CV.ashtonMarcus, 'dm'),
      conversation(CV.cfoWeiling, 'dm'),
      conversation(CV.farahKelvin, 'dm'),
      conversation(CV.q4, 'group_dm'),
      conversation(CV.floor, 'group_dm'),
      conversation(CV.itHelpdesk, 'agent_dm'),
      conversation(CV.cfoFinance, 'agent_dm'),
      conversation(CV.ashtonAssistant, 'assistant_chat', P.ashton),
      conversation(CV.danielAssistant, 'assistant_chat', P.daniel),
    ],
    memberships: [
      ...members(C.general, [...ALL_STAFF, P.formerDpo]),
      ...members(C.announcements, ALL_STAFF),
      ...members(C.ops, [P.ashton, P.priya, P.marcus, P.farah, P.arjun, P.kelvin]),
      ...members(C.askHr, [P.ashton, P.huimin, P.farah, P.marcus, P.nadia, P.priya]),
      ...members(C.sales, [P.ashton, P.ahmad, P.rachel, P.weiling]),
      ...members(C.design, [P.ashton, P.daniel, P.rachel, P.priya]),
      ...members(C.leadership, [P.ashton, P.priya, P.weiling, P.ahmad, P.huimin, P.formerDpo, AG.digest]),
      ...members(C.welcome, [P.ashton, P.huimin, P.nadia, P.priya, P.daniel]),
      ...members(C.it, [P.ashton, P.arjun, P.marcus, P.farah, AG.it]),
      ...members(C.studio, [P.daniel, P.rachel]),
      ...members(R.lounge, [P.kelvin]),
      ...members(R.people, [P.huimin, P.ashton, P.marcus, P.farah, P.kelvin]),
      ...members(R.board, [P.ashton, P.cfo, P.weiling]),
      ...members(R.townhall, [P.huimin]),
      ...members(CV.ashtonPriya, [P.ashton, P.priya]),
      ...members(CV.ashtonMarcus, [P.ashton, P.marcus]),
      ...members(CV.cfoWeiling, [P.cfo, P.weiling]),
      ...members(CV.farahKelvin, [P.farah, P.kelvin]),
      ...q4Eras,
      ...members(CV.floor, [P.daniel, P.rachel, P.farah]),
      ...members(CV.itHelpdesk, [P.ashton, AG.it]),
      ...members(CV.cfoFinance, [P.cfo, AG.finance]),
    ],
    messages: [
      ...messages(C.general, [[M.general, P.huimin]]),
      ...messages(C.announcements, [[M.announcement, P.huimin]]),
      ...messages(C.ops, [
        [M.ops1, P.ashton],
        [M.ops2, P.marcus],
        [M.ops3, P.farah],
        [M.ops4, P.priya],
        [M.opsFile, P.marcus],
        [M.opsDeleted, P.marcus],
      ]).map(m => (m.id === M.opsDeleted ? { ...m, deletedAt: 1 } : m)),
      ...messages(C.askHr, [[M.askHr, P.farah]]),
      ...messages(C.sales, [[M.sales, P.ashton]]),
      ...messages(C.design, [[M.design, P.daniel]]),
      ...messages(C.leadership, [
        [M.digest, AG.digest],
        [M.leadership, P.priya],
      ]),
      ...messages(C.welcome, [[M.welcome, P.huimin]]),
      ...messages(C.it, [
        [M.it, P.arjun],
        [M.itDeleted, P.arjun],
      ]).map(m => (m.id === M.itDeleted ? { ...m, deletedAt: 1 } : m)),
      ...messages(C.studio, [[M.studio, P.daniel]]),
      ...messages(CV.ashtonPriya, [
        [M.priya1, P.ashton],
        [M.priya2, P.priya],
      ]),
      ...messages(CV.ashtonMarcus, [[M.marcus, P.ashton]]),
      ...messages(CV.cfoWeiling, [[M.cfoQ3, P.cfo]]),
      ...messages(CV.farahKelvin, [[M.farahKelvin, P.farah]]),
      ...q4Messages,
      ...messages(CV.floor, [[M.floor, P.rachel]]),
      ...messages(CV.itHelpdesk, [
        [M.itHelp1, P.ashton],
        [M.itHelp2, AG.it],
      ]),
      ...messages(CV.cfoFinance, [[M.finance, P.cfo]]),
      ...messages(CV.ashtonAssistant, [[M.assistant, P.ashton]]),
      ...messages(CV.danielAssistant, [[M.danielAssistant, P.daniel]]),
      ...messages(TH.q4Event, [[M.q4EventThread, P.priya]]),
      ...messages(TH.q4Call, [[M.q4CallThread, P.ashton]]),
      ...messages(R.lounge, [[M.lounge, P.kelvin]]),
      ...messages(R.people, [[M.peopleRoom, P.huimin]]),
    ],
    rooms: [
      room(R.ops, { kind: 'channel_room', channelId: C.ops, restricted: false, owners: [] }),
      room(R.design, { kind: 'channel_room', channelId: C.design, restricted: false, owners: [] }),
      room(R.sales, { kind: 'channel_room', channelId: C.sales, restricted: false, owners: [] }),
      room(R.lounge, { kind: 'standalone', visibility: 'public', restricted: false, owners: [P.kelvin] }),
      room(R.people, {
        kind: 'standalone',
        visibility: 'private',
        restricted: true,
        owners: [P.huimin],
        ownerTeamId: T.people,
      }),
      room(R.q4, { kind: 'meeting', eventId: E.q4, restricted: false, owners: [] }),
      room(R.board, { kind: 'standalone', visibility: 'private', restricted: false, owners: [P.ashton] }),
      room(R.townhall, { kind: 'standalone', visibility: 'public', restricted: true, owners: [P.huimin] }),
      room(R.leadershipOneOnOnes, { kind: 'channel_room', channelId: C.leadership, restricted: true, owners: [] }),
    ],
    threads: [
      { id: TH.q4Event, audience: { kind: 'event', eventId: E.q4 } },
      { id: TH.q4Call, audience: { kind: 'call', sessionId: S.q4Call } },
    ],
    sessions: [
      session(S.pricing, { kind: 'room', roomId: R.sales }, [P.ashton, P.weiling, P.ahmad, P.rachel], {
        restricted: false,
        audience: 'invitees_and_participants',
        eventId: E.pricing,
        invitees: [P.ashton, P.weiling, P.ahmad, P.rachel],
      }),
      session(S.standupFri, { kind: 'room', roomId: R.ops }, [P.priya, P.marcus, P.farah, P.ashton], {
        restricted: false,
        audience: 'space',
        spaceId: C.ops,
      }),
      session(S.designShort, { kind: 'room', roomId: R.design }, [P.daniel, P.rachel], {
        restricted: false,
        audience: 'space',
        spaceId: C.design,
      }),
      session(S.peopleAshton, { kind: 'room', roomId: R.people }, [P.huimin, P.ashton], {
        restricted: true,
        audience: 'space',
        spaceId: R.people,
      }),
      session(S.peopleFloor, { kind: 'room', roomId: R.people }, [P.farah, P.kelvin], {
        restricted: true,
        audience: 'space',
        spaceId: R.people,
      }),
      session(S.peopleBefore, { kind: 'room', roomId: R.people }, [P.huimin, P.marcus], {
        restricted: false,
        audience: 'space',
        spaceId: R.people,
      }),
      session(S.opsRestricted, { kind: 'room', roomId: R.ops }, [P.marcus, P.farah], {
        restricted: true,
        audience: 'space',
        spaceId: C.ops,
      }),
      session(S.q4Call, { kind: 'conversation', conversationId: CV.q4 }, [P.ashton, P.priya, P.daniel], {
        restricted: false,
        audience: 'participants',
      }),
      session(S.dmCall, { kind: 'conversation', conversationId: CV.ashtonPriya }, [P.ashton, P.priya], {
        restricted: false,
        audience: 'participants',
      }),
      session(S.q4Review, { kind: 'room', roomId: R.q4 }, [P.ashton, P.priya, P.daniel], {
        restricted: false,
        audience: 'invitees_and_participants',
        eventId: E.q4,
        invitees: [P.priya, P.ashton, P.daniel, P.ahmad, P.weiling],
      }),
    ],
    slideCopies: [
      { id: SC.pricing, sessionId: S.pricing, playbackOnly: false },
      { id: SC.people, sessionId: S.peopleAshton, playbackOnly: false },
      { id: SC.standupPlayback, sessionId: S.standupFri, playbackOnly: true },
    ],
    events: [
      { id: E.pricing, organiserId: P.ashton, invitees: [P.weiling, P.ahmad, P.rachel] },
      { id: E.standup, organiserId: P.priya, invitees: [P.ashton, P.marcus, P.farah] },
      { id: E.q4, organiserId: P.priya, invitees: [P.ashton, P.daniel, P.ahmad, P.weiling] },
      { id: E.priyaOneOnOne, organiserId: P.ashton, invitees: [P.priya] },
      { id: E.allHands, organiserId: P.huimin, invitees: SEED_PEOPLE.filter(p => p !== P.huimin) },
    ],
    tasks: [
      {
        id: TK.ot,
        creatorId: P.ashton,
        assignees: [P.ashton],
        teamId: T.operations,
        privateToId: null,
        sourceRef: ref.session(S.standupFri),
      },
      {
        id: TK.board,
        creatorId: P.ashton,
        assignees: [P.ashton, P.weiling],
        teamId: T.leadership,
        privateToId: null,
        sourceRef: null,
      },
      {
        id: TK.sheet,
        creatorId: P.weiling,
        assignees: [P.weiling],
        teamId: null,
        privateToId: null,
        sourceRef: ref.session(S.pricing),
      },
      {
        id: TK.private,
        creatorId: P.huimin,
        assignees: [P.huimin, P.marcus],
        teamId: null,
        privateToId: P.huimin,
        sourceRef: ref.session(S.peopleAshton),
      },
      {
        id: TK.checklist,
        creatorId: P.huimin,
        assignees: [P.huimin],
        teamId: T.people,
        privateToId: null,
        sourceRef: null,
      },
      {
        id: TK.fromDm,
        creatorId: P.ashton,
        assignees: [P.ashton],
        teamId: null,
        privateToId: null,
        sourceRef: ref.message(M.priya2),
      },
    ],
    suggestedTasks: [
      { id: ST.board, ownerId: P.ashton, sourceRef: ref.session(S.pricing) },
      { id: ST.people, ownerId: P.huimin, sourceRef: ref.session(S.peopleAshton) },
    ],
    folders: [
      folder(F.q4, person(P.priya), [{ grantee: team(T.q4), role: 'commenter' }]),
      folder(F.q4Contract, person(P.ahmad), [], F.q4),
      folder(F.ops, team(T.operations), [
        { grantee: orgGrantee, role: 'viewer' },
        { grantee: team(T.operations), role: 'editor' },
      ]),
      folder(F.hr, person(P.huimin), [{ grantee: orgGrantee, role: 'viewer' }]),
      folder(F.people, team(T.people), [{ grantee: team(T.people), role: 'editor' }]),
      folder(F.it, person(P.arjun), [{ grantee: orgGrantee, role: 'viewer' }]),
      folder(F.board, person(P.ashton), [{ grantee: person(P.cfo), role: 'editor' }]),
      folder(F.vendor, person(P.ashton), [{ grantee: person(P.priya), role: 'editor' }]),
    ],
    files: [
      file(FI.q4Proposal, 'doc', inFolder(F.q4), person(P.priya), [
        { grantee: person(P.daniel), role: 'editor' },
        { grantee: person(P.ashton), role: 'editor' },
      ]),
      file(FI.leavePolicy, 'doc', inFolder(F.hr), person(P.huimin)),
      file(FI.runbook, 'doc', inFolder(F.ops), person(P.marcus), [
        { grantee: person(P.farah), role: 'editor' },
        { grantee: person(P.priya), role: 'editor' },
      ]),
      file(FI.checklist, 'doc', inFolder(F.people), person(P.huimin)),
      file(FI.boardUpdate, 'doc', inFolder(F.board), person(P.ashton)),
      file(FI.otRoster, 'sheet', inFolder(F.ops), person(P.marcus), [
        { grantee: person(P.priya), role: 'editor' },
        { grantee: person(P.ashton), role: 'editor' },
      ]),
      file(FI.forecast, 'sheet', inFolder(F.q4), person(P.weiling), [
        { grantee: person(P.priya), role: 'editor' },
        { grantee: person(P.ashton), role: 'editor' },
      ]),
      file(FI.movers, 'sheet', inFolder(F.vendor), person(P.ashton), [{ grantee: person(P.priya), role: 'editor' }]),
      file(FI.q3Numbers, 'sheet', atRoot, person(P.cfo), [
        { grantee: person(P.weiling), role: 'editor' },
        { grantee: person(P.ashton), role: 'viewer' },
      ]),
      file(FI.q4Deck, 'deck', inFolder(F.q4), person(P.priya), [
        { grantee: person(P.daniel), role: 'editor' },
        { grantee: person(P.ashton), role: 'editor' },
      ]),
      file(FI.allHandsDeck, 'deck', inFolder(F.people), person(P.huimin), [
        { grantee: orgGrantee, role: 'viewer' },
        { grantee: person(P.ashton), role: 'editor' },
      ]),
      file(FI.otPdf, 'upload', attachedTo(M.opsFile), person(P.marcus)),
      file(FI.kranji, 'upload', inFolder(F.vendor), person(P.priya)),
      file(FI.swift, 'upload', inFolder(F.vendor), person(P.priya)),
      file(FI.msa, 'upload', inFolder(F.q4Contract), person(P.ahmad)),
      file(FI.q3Pdf, 'upload', inFolder(F.board), person(P.ashton)),
      file(FI.rachelNotes, 'doc', atRoot, person(P.rachel)),
      file(FI.opsPolicy, 'doc', inFolder(F.ops), team(T.operations), [], [P.marcus]),
      file(FI.nightRota, 'doc', atRoot, person(P.rachel), [{ grantee: team(T.nightShift), role: 'viewer' }]),
      file(FI.q4Attachment, 'upload', attachedTo(M.q4First), person(P.ashton)),
    ],
    comments: [
      { id: CM.q4Daniel, fileId: FI.q4Proposal, authorId: P.daniel, deletedAt: null },
      { id: CM.q4Ahmad, fileId: FI.q4Proposal, authorId: P.ahmad, deletedAt: null },
      { id: CM.q4Deleted, fileId: FI.q4Proposal, authorId: P.priya, deletedAt: 1 },
    ],
    derived: [
      { id: DV.digest, sources: [ref.session(S.pricing)] },
      { id: DV.opsSummary, sources: [ref.message(M.ops1), ref.message(M.ops2)] },
      { id: DV.mixed, sources: [ref.message(M.ops2), ref.file(FI.forecast)] },
      { id: DV.restrictedNote, sources: [ref.session(S.peopleAshton)] },
      { id: DV.empty, sources: [] },
    ],
  }
}

export function fixtureWorld(change?: (facts: Facts) => Facts): World {
  const facts = fixtureFacts()
  return new World(change ? change(facts) : facts)
}

// A second org, to show nothing crosses orgs (ACC-11): its own Owner, a public channel and an
// item shared with its whole org.
export const ORG_2_PEOPLE = { owner: 'b2000000-0000-4000-8000-000000000001' } as const
export const ORG_2_IDS = { general: 'ch-org2-general', message: 'm-org2-general-1', doc: 'd-org2-handbook' } as const
export function otherOrgFacts(): Facts {
  return {
    org: { id: ORG_2 },
    settings: { publicCreation: 'everyone' },
    people: [{ id: ORG_2_PEOPLE.owner, deactivatedAt: null }],
    roles: [{ personId: ORG_2_PEOPLE.owner, role: 'owner', teamId: null, revokedAt: null }],
    roleProposals: [],
    teams: [],
    teamMembers: [],
    auditLogReaders: ['owner'],
    agents: [],
    assistants: [],
    channels: [channel(ORG_2_IDS.general, 'public', [ORG_2_PEOPLE.owner])],
    conversations: [],
    memberships: members(ORG_2_IDS.general, [ORG_2_PEOPLE.owner]),
    messages: messages(ORG_2_IDS.general, [[ORG_2_IDS.message, ORG_2_PEOPLE.owner]]),
    rooms: [],
    threads: [],
    sessions: [],
    slideCopies: [],
    events: [],
    tasks: [],
    suggestedTasks: [],
    folders: [],
    files: [
      file(ORG_2_IDS.doc, 'doc', atRoot, person(ORG_2_PEOPLE.owner), [
        { grantee: { kind: 'org', id: ORG_2 }, role: 'viewer' },
      ]),
    ],
    comments: [],
    derived: [],
  }
}

// Every person in the fixture org who holds an org role now, and one who holds none.
export const ROLE_HOLDERS = [P.ashton, P.arjun, P.priya, P.weiling, P.ahmad, P.marcus, P.huimin] as const
