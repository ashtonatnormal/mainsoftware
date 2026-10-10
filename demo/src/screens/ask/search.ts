// Plain keyword search for Search & Ask (SRCH-02, SRCH-04, FILE-06). It only
// looks at what the demo user can open: their conversations, Drive files (docs,
// sheets, slides, uploads and folders, never anything in the trash), tasks,
// events, non-restricted sessions and the people directory. Restricted-room
// sessions are never searched (Rule 5).
import type { CalendarEvent, Conversation, Deck, Doc, DriveUpload, Folder, Message, PersonId, Route, Session, Sheet, Task } from '../../types'
import { ASSISTANT, ME, people, personById } from '../../data/people'
import { clock, listStamp, shortDay } from '../../time'
import { driveEntries, folderPath, isTrashed, kindLabel, routeFor, type DriveEntry } from '../../drive'
import { canOpen } from '../drive/model'

/** 'docs' holds every Drive result; the screen labels it "Files". */
export type ResultGroup = 'messages' | 'docs' | 'meetings' | 'tasks' | 'people'
export type ResultIcon = 'message' | 'voice' | 'file' | 'doc' | 'session' | 'event' | 'task' | 'person' | 'folder' | 'sheet' | 'slides' | 'pdf' | 'image' | 'video' | 'audio' | 'upload'

export interface SearchResult {
  id: string
  group: ResultGroup
  icon: ResultIcon
  title: string
  context?: string
  snippet: string
  meta?: string
  route?: Route
  personId?: PersonId
  agent?: boolean
  driveId?: string // a Drive item: opening it marks it recently opened
  score: number
  ts: number
}

export interface SearchSource {
  conversations: Conversation[]
  messages: Message[]
  sessions: Session[]
  events: CalendarEvent[]
  docs: Doc[]
  tasks: Task[]
  folders: Folder[]
  sheets: Sheet[]
  decks: Deck[]
  uploads: DriveUpload[]
}

const STOP = new Set(
  ('a an the and or but if of in on at to for from by with into over up out about as is are was were be been being am ' +
    'it its this that these those there here what whats which who whom whose how why when where can could should would will shall may might must ' +
    'do does did done doing have has had get got i me my mine we us our you your yours he him his she her they them their ' +
    'any some all many much more most not no yes so than then just also said say says tell told know latest happening happen ' +
    'owns own please show find give let lets thing things anything something')
    .split(/\s+/),
)

/** Lower-cased search terms with stopwords removed and light stemming. */
export function termsOf(q: string): string[] {
  const words = q.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 2 && !STOP.has(w))
  const stems = words.map(w => (w.length > 4 ? w.replace(/(ing|ed|es|s|e)$/, '') : w))
  return [...new Set(stems)].filter(Boolean)
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Regex that matches whole words starting with any of the terms. */
export function termRegex(terms: string[], flags = 'gi') {
  if (!terms.length) return null
  return new RegExp(`\\b(?:${terms.map(escape).join('|')})[a-z0-9]*`, flags)
}

function hits(text: string, terms: string[]) {
  const lower = text.toLowerCase()
  return terms.filter(t => new RegExp(`\\b${escape(t)}`).test(lower))
}

/** Cuts long text to a window around the first match. */
export function snippetAround(text: string, terms: string[], max = 170) {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const re = termRegex(terms, 'i')
  const idx = re ? clean.search(re) : -1
  if (idx < 60) return clean.slice(0, max).replace(/\s\S*$/, '') + '…'
  let start = clean.lastIndexOf(' ', idx - 40)
  if (start < 0) start = 0
  const more = start + max < clean.length
  const body = clean.slice(start, start + max)
  return `…${(more ? body.replace(/\s\S*$/, '') : body).trim()}${more ? '…' : ''}`
}

export function conversationLabel(c?: Conversation) {
  if (!c) return 'a conversation'
  if (c.kind === 'channel') return `#${c.name}`
  if (c.kind === 'dm') {
    const other = c.members.find(m => m !== ME)
    return other ? personById[other]?.name ?? c.name : c.name
  }
  return c.name
}

/** The DM (or agent conversation) the demo user has with someone, if any. */
export function directConversation(conversations: Conversation[], personId: PersonId) {
  if (personId === ASSISTANT) return conversations.find(c => c.kind === 'assistant')
  return conversations.find(c => (c.kind === 'dm' || c.kind === 'agent') && c.members.includes(personId) && c.members.includes(ME))
}

const short = (id: PersonId) => (id === ME ? 'You' : personById[id]?.short ?? 'Someone')

export function search(q: string, src: SearchSource): SearchResult[] {
  const terms = termsOf(q)
  if (!terms.length) return []
  const out: SearchResult[] = []
  const add = (r: Omit<SearchResult, 'score'>, titleText: string, bodyText: string) => {
    const inTitle = hits(titleText, terms)
    const all = new Set([...inTitle, ...hits(bodyText, terms)])
    if (!all.size) return
    out.push({ ...r, score: all.size + inTitle.length * 0.5 })
  }

  // Messages (text, files, agent answers and voice-note transcripts).
  const mine = new Set(src.conversations.filter(c => c.members.includes(ME)).map(c => c.id))
  const convById = Object.fromEntries(src.conversations.map(c => [c.id, c]))
  for (const m of src.messages) {
    if (!mine.has(m.conversationId) || m.deleted) continue
    if (m.kind === 'system' || m.kind === 'notes') continue
    const text = m.kind === 'voice' ? m.voice?.transcript ?? '' : m.kind === 'suggest' ? m.suggestion?.answer ?? '' : [m.text, m.file?.name].filter(Boolean).join(' · ')
    if (!text) continue
    const author = m.kind === 'suggest' ? m.suggestion?.agentId ?? m.authorId : m.authorId
    add(
      {
        id: m.id,
        group: 'messages',
        icon: m.kind === 'voice' ? 'voice' : m.kind === 'file' ? 'file' : 'message',
        title: short(author),
        context: convById[m.conversationId]?.kind === 'dm' ? 'Direct message' : conversationLabel(convById[m.conversationId]),
        snippet: snippetAround(text.replace(/\[\d+\]/g, ''), terms),
        meta: `${m.kind === 'voice' ? 'Voice note · ' : ''}${listStamp(m.ts)}`,
        route: { name: 'chats', conversationId: m.conversationId },
        ts: m.ts,
      },
      // A name finds that person's messages too ("Priya" → what Priya wrote).
      author === ME ? '' : personById[author]?.name ?? '',
      text,
    )
  }

  // Meetings: session transcripts and notes (never restricted ones), then events.
  for (const s of src.sessions) {
    if (s.restricted || !s.participants.includes(ME)) continue
    const notesText = s.notes ? [s.notes.summary, ...s.notes.decisions, ...s.notes.actionItems.map(a => a.text)].join(' ') : ''
    const passages = s.transcript.map(p => ({ p, n: hits(p.text, terms).length })).filter(x => x.n > 0).sort((a, b) => b.n - a.n)
    const decision = s.notes?.decisions.find(d => hits(d, terms).length)
    const best = passages[0]
    const useNotes = !!decision && (!best || hits(decision, terms).length >= best.n)
    const snippet = useNotes
      ? `Decision: ${decision}`
      : best
        ? `${short(best.p.speakerId)}: ${snippetAround(best.p.text, terms, 150)}`
        : s.notes?.summary ?? s.transcript[0]?.text ?? ''
    add(
      {
        id: s.id,
        group: 'meetings',
        icon: 'session',
        title: s.title,
        context: `${shortDay(s.startedAt)} · ${clock(s.startedAt)}`,
        snippet,
        meta: useNotes || !best ? 'Notes' : 'Transcript',
        route: { name: 'session', sessionId: s.id, t: !useNotes && best ? best.p.startSec : undefined },
        ts: s.startedAt,
      },
      s.title,
      `${notesText} ${s.transcript.map(p => p.text).join(' ')}`,
    )
  }
  for (const e of src.events) {
    if (!e.attendees.includes(ME) || e.kind === 'leave') continue
    const agendaHit = e.agenda.find(a => hits(a, terms).length)
    add(
      {
        id: e.id,
        group: 'meetings',
        icon: 'event',
        title: e.title,
        context: `${shortDay(e.start)} · ${clock(e.start)}`,
        snippet: agendaHit ? `Agenda: ${agendaHit}` : e.agenda.length ? `Agenda: ${e.agenda.join(' · ')}` : `${e.attendees.length} people`,
        meta: 'Calendar',
        route: { name: 'calendar', eventId: e.id },
        ts: e.start,
      },
      e.title,
      e.agenda.join(' '),
    )
  }

  // Drive (FILE-06): names and the text inside every file you can open.
  for (const e of driveEntries(src)) {
    if (isTrashed(src.folders, e.item) || !canOpen({ ...src, clock: 0 }, e)) continue
    const hit = driveHit(e, terms)
    const path = folderPath(src.folders, e.item.folderId).map(f => f.title)
    add(
      {
        id: e.item.id,
        group: 'docs',
        icon: driveIcon(e),
        title: e.item.title,
        context: e.kind === 'doc' ? (e.item as Doc).space : path.length ? path.join(' › ') : e.item.ownerId === ME ? 'My Drive' : 'Shared with me',
        snippet: hit.snippet,
        meta: hit.meta,
        route: routeFor(e),
        driveId: e.item.id,
        ts: e.item.updatedAt,
      },
      e.item.title,
      hit.text,
    )
  }

  // Tasks.
  for (const t of src.tasks) {
    const who = t.assigneeIds.map(short).join(', ')
    add(
      {
        id: t.id,
        group: 'tasks',
        icon: 'task',
        title: t.title,
        context: t.team,
        snippet: `${who}${t.due ? ` · due ${t.due}` : ''}${t.source ? ` · from ${t.source.label}` : ''}`,
        meta: t.status === 'done' ? 'Done' : t.status === 'doing' ? 'In progress' : 'To do',
        route: { name: 'tasks' },
        ts: 0,
      },
      t.title,
      t.source?.label ?? '',
    )
  }

  // People and agents (the directory). The private assistant isn't a person.
  for (const p of people) {
    if (p.id === ME || p.kind === 'assistant') continue
    const conv = directConversation(src.conversations, p.id)
    add(
      {
        id: p.id,
        group: 'people',
        icon: 'person',
        title: p.name,
        context: p.team,
        snippet: p.customStatus ? `${p.title} · ${p.customStatus}` : p.title,
        meta: conv ? (p.kind === 'agent' ? 'Agent chat' : 'Direct message') : undefined,
        route: conv ? { name: 'chats', conversationId: conv.id } : undefined,
        personId: p.id,
        agent: p.kind === 'agent',
        ts: 0,
      },
      p.name,
      `${p.title} ${p.team}`,
    )
  }

  return out.sort((a, b) => b.score - a.score || b.ts - a.ts)
}

// ── Drive helpers ────────────────────────────────────────────────────────────
function driveIcon(e: DriveEntry): ResultIcon {
  if (e.kind === 'file') return 'upload'
  return e.kind
}

/** The searchable text of a Drive item, the snippet to show for these terms, and a meta line. */
function driveHit(e: DriveEntry, terms: string[]): { text: string; snippet: string; meta: string } {
  const edited = `Edited ${listStamp(e.item.updatedAt)}`
  switch (e.kind) {
    case 'folder': {
      const f = e.item as Folder
      return { text: f.description ?? '', snippet: f.description ?? (f.team ? `Team folder · ${f.team}` : 'Folder'), meta: f.team ? 'Team folder' : 'Folder' }
    }
    case 'doc': {
      const d = e.item as Doc
      const block = d.blocks.find(b => b.type !== 'h1' && hits(b.text, terms).length) ?? d.blocks.find(b => b.type === 'p')
      return { text: d.blocks.map(b => b.text).join(' '), snippet: block ? snippetAround(block.text, terms) : '', meta: edited }
    }
    case 'sheet': {
      const sh = e.item as Sheet
      // Typed values only: formulas aren't text anyone wrote.
      const cells = sh.tabs.flatMap(t => Object.entries(t.cells).filter(([, c]) => c.v && !c.v.startsWith('=')).map(([addr, c]) => ({ tab: t, addr, v: c.v })))
      const cell = cells.find(c => hits(c.v, terms).length)
      let snippet = ''
      if (cell) {
        const row = cell.addr.replace(/^[A-Z]+/, '')
        const rowVals = cells.filter(c => c.tab === cell.tab && c.addr.replace(/^[A-Z]+/, '') === row).sort((a, b) => a.addr.localeCompare(b.addr)).map(c => c.v)
        snippet = `${sh.tabs.length > 1 ? `${cell.tab.name} · ` : ''}Row ${row}: ${rowVals.join(' · ')}`
      }
      return { text: cells.map(c => c.v).join(' '), snippet, meta: `Sheet · ${edited.toLowerCase()}` }
    }
    case 'slides': {
      const dk = e.item as Deck
      const lines = dk.slides.map((sl, i) => ({ n: i + 1, text: [sl.title, sl.subtitle, ...(sl.bullets ?? []), sl.left?.heading, ...(sl.left?.bullets ?? []), sl.right?.heading, ...(sl.right?.bullets ?? []), sl.stat && `${sl.stat} ${sl.statLabel ?? ''}`].filter(Boolean) as string[] }))
      let snippet = `${dk.slides.length} slides`
      for (const l of lines) {
        const line = l.text.find(t => hits(t, terms).length)
        if (line) { snippet = `Slide ${l.n}: ${snippetAround(line, terms, 140)}`; break }
      }
      return { text: lines.flatMap(l => l.text).join(' '), snippet, meta: `Slides · ${edited.toLowerCase()}` }
    }
    default: {
      const u = e.item as DriveUpload
      const text = u.previewText ?? ''
      return { text, snippet: text ? snippetAround(text, terms) : `${kindLabel[u.kind]} · ${u.size}`, meta: `${kindLabel[u.kind]} · ${u.size}` }
    }
  }
}
