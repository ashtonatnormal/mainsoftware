// Shared data model for the Hearth demo. Everything is scripted example data;
// nothing talks to a server. Requirement IDs refer to docs/PRD.md.

export type PersonId = string
export type ConversationId = string
export type RoomId = string
export type SessionId = string

export type PersonKind = 'human' | 'agent' | 'assistant'

export interface Person {
  id: PersonId
  name: string
  short: string // first name or short label used in compact UI
  kind: PersonKind
  title: string // job title, or the agent's role description
  team: string
  hue: number // avatar colour, 0-360
  status: 'online' | 'away' | 'dnd' | 'offline'
  customStatus?: string
  mobile?: boolean // usually on a phone (frontline / field)
  agentOwner?: PersonId // AGT-02 named owner
}

export type ConversationKind = 'channel' | 'dm' | 'group' | 'agent' | 'assistant'
export type ParticipationLevel = 'off' | 'mention' | 'suggest' | 'active'

export interface Conversation {
  id: ConversationId
  kind: ConversationKind
  name: string // for DMs: the other person's name
  topic?: string
  private?: boolean
  members: PersonId[]
  roomId?: RoomId // CHAT-16 attached voice room
  pinned?: boolean
  muted?: boolean
  unread: number
  mentions?: number
  participation?: ParticipationLevel // AGT-08
  lastActivity: number // epoch ms
}

export interface Reaction {
  emoji: string
  by: PersonId[]
}

export interface VoiceNote {
  durationSec: number
  waveform: number[] // 0..1 bar heights
  transcript: string
  nonEnglish?: boolean
}

export interface SourceRef {
  label: string // e.g. "Leave Policy (HR wiki)"
  kind: 'doc' | 'message' | 'session' | 'task' | 'event' | 'person' | 'sheet' | 'slides' | 'file'
  route: Route
}

export interface AgentSuggestion {
  agentId: PersonId
  teaser: string // "HR Policy has an answer from the Leave Policy page"
  answer: string
  sources: SourceRef[]
}

export type MessageKind = 'text' | 'voice' | 'notes' | 'suggest' | 'system' | 'file'

export interface Message {
  id: string
  conversationId: ConversationId
  authorId: PersonId
  ts: number
  kind: MessageKind
  text?: string
  voice?: VoiceNote
  sessionId?: SessionId // kind 'notes'
  suggestion?: AgentSuggestion // kind 'suggest'
  file?: { name: string; size: string; type: 'pdf' | 'image' | 'doc' | 'sheet' }
  sources?: SourceRef[] // assistant answers keep the sources they cite
  reactions?: Reaction[]
  threadCount?: number
  threadPreview?: PersonId[]
  edited?: boolean
  deleted?: boolean
  readBy?: PersonId[] // CHAT-09 ticks in DMs
}

export interface Room {
  id: RoomId
  name: string
  conversationId?: ConversationId // channel the room belongs to (ROOM-01)
  restricted?: boolean // REC-07
  isPublic: boolean
  participants: PersonId[] // humans currently inside (agents never count, REC-01)
  sessionStartedAt?: number // set while 2+ humans are present
  speakingId?: PersonId
  screenShareBy?: PersonId
}

export interface Passage {
  speakerId: PersonId
  startSec: number
  endSec: number
  text: string
  nonEnglish?: boolean
}

export interface ActionItem {
  id: string
  text: string
  ownerId: PersonId
  due?: string // display label, e.g. "Today" / "Fri 16 Oct"
  passageIndex?: number // link to the transcript timestamp
}

export interface Notes {
  summary: string
  decisions: string[]
  actionItems: ActionItem[]
  openQuestions: string[]
  incomplete?: boolean
}

export interface Session {
  id: SessionId
  title: string
  roomId?: RoomId
  conversationId?: ConversationId
  meetingId?: string
  startedAt: number
  durationSec: number
  participants: PersonId[]
  transcript: Passage[]
  notes?: Notes // only substantive sessions get notes (REC-11, D27)
  viewedBy: { personId: PersonId; at: number }[]
  restricted?: boolean
  hasVideo?: boolean
}

export type TaskStatus = 'todo' | 'doing' | 'done'

export interface TaskSource {
  kind: 'meeting' | 'message' | 'assistant' | 'manual'
  label: string // "Ops standup · Mon 12 Oct"
  route?: Route
}

export interface Task {
  id: string
  title: string
  assigneeIds: PersonId[]
  due?: string
  dueSoon?: boolean
  overdue?: boolean
  status: TaskStatus
  priority?: 'high' | 'normal'
  team?: string
  source?: TaskSource
  comments?: number
}

export interface SuggestedTask {
  id: string
  title: string
  ownerId: PersonId
  due?: string
  source: TaskSource
}

export interface CalendarEvent {
  id: string
  title: string
  start: number
  end: number
  attendees: PersonId[]
  roomId?: RoomId
  agenda: string[]
  rsvp: 'yes' | 'no' | 'maybe' | 'pending'
  sessionId?: SessionId // set after it happened
  prep?: {
    related: SourceRef[]
    openItems: string[]
    lastNotes?: string
  }
  kind?: 'meeting' | 'leave' | 'launch'
}

export interface DocVersion {
  id: string
  authorId: PersonId
  ts: number
  summary: string
  added?: string[]
  removed?: string[]
}

export interface DocComment {
  id: string
  authorId: PersonId
  ts: number
  anchor: string // quoted text
  text: string
  replies?: { authorId: PersonId; text: string; ts: number }[]
  resolved?: boolean
}

export interface DocBlock {
  type: 'h1' | 'h2' | 'p' | 'li' | 'todo' | 'quote'
  text: string
  done?: boolean
}

// ── Drive (FILE-01..08) ───────────────────────────────────────────────────────
// Docs, sheets, slide decks, uploaded files and folders all live in one Drive.
// Each kind keeps its own content type; DriveMeta is what they share.

export type DriveKind = 'folder' | 'doc' | 'sheet' | 'slides' | 'pdf' | 'image' | 'video' | 'audio' | 'file'
export type UploadKind = 'pdf' | 'image' | 'video' | 'audio' | 'file'
export type AccessRole = 'viewer' | 'commenter' | 'editor'
/** Who else can open an item, beyond the people named on it (FILE-03, DOC-03). */
export type GeneralAccess = 'restricted' | 'team' | 'org'
export type DriveView = 'home' | 'my' | 'shared' | 'recent' | 'starred' | 'trash'

export interface DriveMeta {
  id: string
  title: string
  ownerId: PersonId
  updatedAt: number
  updatedBy?: PersonId
  folderId: string | null // null = the owner's My Drive root
  starred?: boolean // starred by you
  trashed?: boolean
  trashedAt?: number
  lastOpenedAt?: number // by you, for Recent
  access?: GeneralAccess // default: 'team' inside a team folder, else 'restricted'
  sharedWith?: { personId: PersonId; role: AccessRole }[] // named people besides the owner and editors
}

/** Content kinds that people edit (docs, sheets, slides) share these. */
export interface Editable extends DriveMeta {
  editors: PersonId[] // restricted editing (DOC-03): only these people (and the owner) can edit
  commenters: 'team' | 'org' | 'none'
  presence: PersonId[] // currently viewing/editing
}

export interface Doc extends Editable {
  space: string // folder name shown as context, e.g. "HR wiki" or "My Drive"
  blocks: DocBlock[]
  versions: DocVersion[]
  comments: DocComment[]
  emoji?: string
}

export interface Folder extends DriveMeta {
  team?: string // a team folder (FILE-01): everyone in this team can open it
  color?: 'ember' | 'teal' | 'green' | 'amber' | 'slate' | 'rose'
  description?: string
}

/** A file someone uploaded (FILE-02/04/06). */
export interface DriveUpload extends DriveMeta {
  kind: UploadKind
  size: string // display label, e.g. "84 KB"
  pages?: number // PDFs
  durationSec?: number // audio/video
  previewText?: string // text extracted for preview and search (FILE-06)
  url?: string // blob: URL for a file added in this browser session (image previews)
  hue?: number // seeded images: colour of the generated preview
  fromConversationId?: ConversationId // FILE-08: shared in this chat
}

// Sheets (DOC-12)
export interface SheetCell {
  v: string // what the person typed; starts with "=" for a formula
  b?: boolean // bold
  i?: boolean // italic
  align?: 'left' | 'center' | 'right'
  fmt?: 'number' | 'currency' | 'percent' | 'integer' | 'text'
  fill?: 'accent' | 'agent' | 'ok' | 'warn' | 'rec' | 'muted'
}

export interface SheetTab {
  id: string
  name: string
  rows: number
  cols: number
  cells: Record<string, SheetCell> // keyed by A1 address, e.g. "B3"
  colWidths?: Record<string, number> // px by column letter
  frozenRows?: number
}

export interface Sheet extends Editable {
  tabs: SheetTab[]
  cursors?: Record<PersonId, string> // where collaborators are, e.g. { u_priya: "C4" }
  versions?: DocVersion[]
}

// Slides (DOC-13)
export type SlideLayout = 'title' | 'section' | 'bullets' | 'two-column' | 'big-number' | 'quote' | 'image'

export interface Slide {
  id: string
  layout: SlideLayout
  title: string
  subtitle?: string // title/section slides, quote attribution, image caption
  bullets?: string[] // bullets layout
  left?: { heading?: string; bullets: string[] } // two-column layout
  right?: { heading?: string; bullets: string[] }
  stat?: string // big-number layout, e.g. "1,200"
  statLabel?: string
  imageHue?: number // image layout: generated placeholder colour
  imageUrl?: string // image layout: a picture added in this browser session (blob: URL)
  notes?: string // speaker notes
}

export interface Deck extends Editable {
  slides: Slide[]
  theme: 'ember' | 'slate' | 'teal'
  versions?: DocVersion[]
}

export type DocTemplateId = 'blank' | 'meeting-notes' | 'project-brief' | 'policy' | 'onboarding'

export interface Actionable {
  id: string
  kind: 'reply' | 'action-item' | 'prep' | 'review' | 'mention'
  title: string
  detail: string
  route: Route
  // PA-08: drafts go into the composer. A draft shaped by a memory (PA-10) names it in
  // memoryId and carries withoutMemory, the draft written without that memory, which is
  // used while memory is off or that memory is deleted or changed.
  draft?: { conversationId: ConversationId; text: string; memoryId?: string; withoutMemory?: string }
  sources?: SourceRef[]
}

export interface DigestItem {
  id: string
  conversationId: ConversationId
  text: string
  count?: number
}

export interface AskAnswer {
  id: string
  keywords: string[]
  question: string
  answer: string // may contain [1], [2] markers matching sources
  sources: SourceRef[]
}

export interface Memory {
  id: string
  text: string
  learnedFrom: string
}

export interface InsightRow {
  personId: PersonId
  messages: number
  reactions: number
  talkMin: number
  roomMin: number
  meetings: number
  tasksDone: number
}

export type Route =
  | { name: 'today' }
  | { name: 'chats'; conversationId?: ConversationId }
  | { name: 'rooms'; roomId?: RoomId }
  | { name: 'session'; sessionId: SessionId; t?: number }
  | { name: 'tasks' }
  | { name: 'calendar'; eventId?: string }
  | { name: 'drive'; view?: DriveView; folderId?: string }
  | { name: 'docs'; docId?: string } // without docId this shows the Drive
  | { name: 'sheets'; sheetId: string }
  | { name: 'slides'; deckId: string }
  | { name: 'file'; fileId: string } // preview of an uploaded file
  | { name: 'insights' }
  | { name: 'ask'; q?: string }
  | { name: 'settings'; section?: 'memory' | 'privacy' | 'notifications' | 'devices' }

export type RouteName = Route['name']
