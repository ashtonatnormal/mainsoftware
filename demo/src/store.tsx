import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import type { Actionable, CalendarEvent, Conversation, ConversationId, Doc, Memory, Message, Room, RoomId, Route, Session, SourceRef, SuggestedTask, Task, TaskStatus } from './types'
import { conversations as seedConversations, messages as seedMessages } from './data/chat'
import { events as seedEvents, opsStandupScript, rooms as seedRooms, sessions as seedSessions } from './data/meetings'
import { actionables as seedActionables, askAnswers, askFallback, docs as seedDocs, memories as seedMemories, suggestedTasks as seedSuggested, tasks as seedTasks } from './data/work'
import { ASSISTANT, ME } from './data/people'
import { NOW, shortDay } from './time'

export type ThemeChoice = 'system' | 'light' | 'dark'

export interface Toast {
  id: number
  text: string
  action?: { label: string; route: Route }
}

export interface State {
  onboarded: boolean
  route: Route
  history: Route[]
  conversations: Conversation[]
  messages: Message[]
  drafts: Record<ConversationId, string>
  typing: Record<ConversationId, string | undefined> // conversationId -> personId typing
  rooms: Room[]
  myRoomId?: RoomId
  sessions: Session[]
  tasks: Task[]
  suggested: SuggestedTask[]
  actionables: Actionable[]
  events: CalendarEvent[]
  docs: Doc[]
  memories: Memory[]
  memoryOn: boolean
  toasts: Toast[]
  theme: ThemeChoice
  clock: number // demo time; advances slowly so live things feel live
}

type Action =
  | { type: 'navigate'; route: Route; replace?: boolean }
  | { type: 'back' }
  | { type: 'onboarded' }
  | { type: 'addMessage'; message: Message }
  | { type: 'markRead'; conversationId: ConversationId }
  | { type: 'setDraft'; conversationId: ConversationId; text: string }
  | { type: 'typing'; conversationId: ConversationId; personId?: string }
  | { type: 'react'; messageId: string; emoji: string }
  | { type: 'joinRoom'; roomId: RoomId }
  | { type: 'leaveRoom' }
  | { type: 'endRoom'; roomId: RoomId }
  | { type: 'setSpeaking'; roomId: RoomId; personId?: string }
  | { type: 'addSession'; session: Session }
  | { type: 'addSuggested'; items: SuggestedTask[] }
  | { type: 'acceptSuggested'; id: string; title?: string; due?: string }
  | { type: 'dismissSuggested'; id: string }
  | { type: 'addTask'; task: Task }
  | { type: 'setTaskStatus'; id: string; status: TaskStatus }
  | { type: 'dismissActionable'; id: string }
  | { type: 'addActionable'; item: Actionable }
  | { type: 'rsvp'; eventId: string; rsvp: CalendarEvent['rsvp'] }
  | { type: 'updateDoc'; doc: Doc }
  | { type: 'deleteMemory'; id: string }
  | { type: 'editMemory'; id: string; text: string }
  | { type: 'memoryOn'; on: boolean }
  | { type: 'addMemory'; memory: Memory }
  | { type: 'toast'; toast: Toast }
  | { type: 'dismissToast'; id: number }
  | { type: 'theme'; theme: ThemeChoice }
  | { type: 'tick' }

const initial: State = {
  onboarded: false,
  route: { name: 'today' },
  history: [],
  conversations: seedConversations,
  messages: seedMessages,
  drafts: {},
  typing: {},
  rooms: seedRooms,
  sessions: seedSessions,
  tasks: seedTasks,
  suggested: seedSuggested,
  actionables: seedActionables,
  events: seedEvents,
  docs: seedDocs,
  memories: seedMemories,
  memoryOn: true,
  toasts: [],
  theme: 'system',
  clock: NOW,
}

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'navigate':
      if (JSON.stringify(a.route) === JSON.stringify(s.route)) return s
      return { ...s, route: a.route, history: a.replace ? s.history : [...s.history.slice(-30), s.route] }
    case 'back': {
      const prev = s.history[s.history.length - 1]
      return prev ? { ...s, route: prev, history: s.history.slice(0, -1) } : { ...s, route: { name: 'today' } }
    }
    case 'onboarded':
      return { ...s, onboarded: true }
    case 'addMessage':
      return {
        ...s,
        messages: [...s.messages, a.message],
        conversations: s.conversations.map(c =>
          c.id === a.message.conversationId
            ? { ...c, lastActivity: a.message.ts, unread: a.message.authorId === ME || isOpen(s, c.id) ? c.unread : c.unread + 1 }
            : c,
        ),
        typing: { ...s.typing, [a.message.conversationId]: undefined },
      }
    case 'markRead':
      return { ...s, conversations: s.conversations.map(c => (c.id === a.conversationId ? { ...c, unread: 0, mentions: 0 } : c)) }
    case 'setDraft':
      return { ...s, drafts: { ...s.drafts, [a.conversationId]: a.text } }
    case 'typing':
      return { ...s, typing: { ...s.typing, [a.conversationId]: a.personId } }
    case 'react':
      return {
        ...s,
        messages: s.messages.map(m => {
          if (m.id !== a.messageId) return m
          const reactions = [...(m.reactions ?? [])]
          const i = reactions.findIndex(r => r.emoji === a.emoji)
          if (i === -1) reactions.push({ emoji: a.emoji, by: [ME] })
          else {
            const by = reactions[i].by.includes(ME) ? reactions[i].by.filter(p => p !== ME) : [...reactions[i].by, ME]
            if (by.length) reactions[i] = { ...reactions[i], by }
            else reactions.splice(i, 1)
          }
          return { ...m, reactions }
        }),
      }
    case 'joinRoom':
      return {
        ...s,
        myRoomId: a.roomId,
        rooms: s.rooms.map(r => {
          if (r.id === s.myRoomId && r.id !== a.roomId) return withoutMe(r, s.clock)
          if (r.id !== a.roomId) return r
          const participants = r.participants.includes(ME) ? r.participants : [...r.participants, ME]
          return { ...r, participants, sessionStartedAt: r.sessionStartedAt ?? (participants.length >= 2 ? s.clock : undefined) }
        }),
      }
    case 'leaveRoom':
      return { ...s, myRoomId: undefined, rooms: s.rooms.map(r => (r.id === s.myRoomId ? withoutMe(r, s.clock) : r)) }
    case 'endRoom': // everyone has left: the session ends and recording stops
      return { ...s, rooms: s.rooms.map(r => (r.id === a.roomId ? { ...r, participants: [], sessionStartedAt: undefined, speakingId: undefined, screenShareBy: undefined } : r)) }
    case 'setSpeaking':
      return { ...s, rooms: s.rooms.map(r => (r.id === a.roomId ? { ...r, speakingId: a.personId } : r)) }
    case 'addSession':
      return { ...s, sessions: [a.session, ...s.sessions.filter(x => x.id !== a.session.id)] }
    case 'addSuggested':
      return { ...s, suggested: [...a.items, ...s.suggested.filter(x => !a.items.some(i => i.id === x.id))] }
    case 'acceptSuggested': {
      const sg = s.suggested.find(x => x.id === a.id)
      if (!sg) return s
      const task: Task = { id: `t_${sg.id}`, title: a.title ?? sg.title, assigneeIds: [sg.ownerId], due: a.due ?? sg.due, status: 'todo', source: sg.source }
      return { ...s, suggested: s.suggested.filter(x => x.id !== a.id), tasks: [task, ...s.tasks] }
    }
    case 'dismissSuggested':
      return { ...s, suggested: s.suggested.filter(x => x.id !== a.id) }
    case 'addTask':
      return { ...s, tasks: [a.task, ...s.tasks] }
    case 'setTaskStatus':
      return { ...s, tasks: s.tasks.map(t => (t.id === a.id ? { ...t, status: a.status } : t)) }
    case 'dismissActionable':
      return { ...s, actionables: s.actionables.filter(x => x.id !== a.id) }
    case 'addActionable':
      return { ...s, actionables: [a.item, ...s.actionables.filter(x => x.id !== a.item.id)] }
    case 'rsvp':
      return { ...s, events: s.events.map(e => (e.id === a.eventId ? { ...e, rsvp: a.rsvp } : e)) }
    case 'updateDoc':
      return { ...s, docs: s.docs.map(d => (d.id === a.doc.id ? a.doc : d)) }
    case 'deleteMemory':
      return withMemoryDrafts({ ...s, memories: s.memories.filter(m => m.id !== a.id) })
    case 'editMemory':
      return withMemoryDrafts({ ...s, memories: s.memories.map(m => (m.id === a.id ? { ...m, text: a.text } : m)) })
    case 'memoryOn':
      return withMemoryDrafts({ ...s, memoryOn: a.on })
    case 'addMemory':
      return withMemoryDrafts({ ...s, memories: [...s.memories, a.memory] })
    case 'toast':
      return { ...s, toasts: [...s.toasts.slice(-2), a.toast] }
    case 'dismissToast':
      return { ...s, toasts: s.toasts.filter(t => t.id !== a.id) }
    case 'theme':
      return { ...s, theme: a.theme }
    case 'tick':
      return { ...s, clock: s.clock + 15_000 }
  }
}

function isOpen(s: State, id: ConversationId) {
  return s.route.name === 'chats' && s.route.conversationId === id
}

function withoutMe(r: Room, clock: number): Room {
  const participants = r.participants.filter(p => p !== ME)
  return { ...r, participants, sessionStartedAt: participants.length >= 2 ? r.sessionStartedAt ?? clock : undefined, speakingId: participants.includes(r.speakingId ?? '') ? r.speakingId : participants[0] }
}

// ── Scripted replies so conversations feel alive ──────────────────────────────
const scriptedReplies: Record<string, { from: string; text: string }> = {
  // Fits either Today draft to Priya (with or without memory, PA-10).
  dm_priya: { from: 'u_priya', text: 'Thanks! I’ll check the insurance cover with Kranji on tomorrow’s call and let you know before Tuesday. 👍' },
  dm_marcus: { from: 'u_marcus', text: 'Thanks boss, telling the crew now 👍' },
  g_q4: { from: 'u_daniel', text: 'Thanks! I’ll walk everyone through v3 at the 3 pm review.' },
  ag_it: { from: 'a_it', text: 'I’ve noted that. For anything urgent, Arjun is on #it-help until 6 pm.' },
}

// ── Personal memory (PA-10) ───────────────────────────────────────────────────
// The assistant saves something only when you ask it to in the Assistant chat and
// memory is on, and it only uses what it remembered while memory is on. Turning
// memory off keeps the list (you can still see, edit and delete it in Settings)
// but stops both. It never changes the setting or deletes memories itself (PA-03).
// Memory phrasing never hides the answer to a work question: anything that isn't
// clearly about memory falls through to the normal answers.
// Every memory reply links to where you see and control memory.
const MEMORY_SOURCE: SourceRef = { label: 'Settings › Assistant memory', kind: 'person', route: { name: 'settings', section: 'memory' } }
const MEMORY_OFF = 'Memory is off, so I’m not using anything I remembered about you and I’m not saving anything new. You can turn it back on in Settings › Assistant memory.'
const MEMORY_OFF_SAVE = 'Memory is off, so I won’t remember that. Turn it on in Settings › Assistant memory if you’d like me to.'
const MEMORY_ASK_WHAT = 'What would you like me to remember? Start with “Remember that…”, for example “Remember that I’m off on Fridays.”'
const MEMORY_REMINDER = 'That sounds like a reminder. I can’t set those, but you can add it as a task in Tasks and it’ll show on Today.'
const MEMORY_SETTINGS = 'I can’t change memory settings or delete what I remember myself. You can turn memory off, or edit and delete anything I remember, in Settings › Assistant memory.'

/** The scripted answer a work question matches, if any. A leading "never mind" clause
 *  ("Forget about the movers, what's the forklift status?") isn't part of the question. */
const workAnswer = (q: string) => {
  const lower = q.replace(/^\s*(?:(?:ok|okay|please|pls|plz)\s+)?(?:forget (?:it|that|about [^,.;:?]+)|never ?mind|nvm)\s*[,.;:–—-]+\s*(?=\S)/i, '').toLowerCase()
  return askAnswers.find(a => a.keywords.some(k => lower.includes(k)))
}

const YOU = '(?:you|u)'
const YOUR = '(?:your|ur)'
const EMOJI = '[\\s\\p{Extended_Pictographic}\\u200d\\ufe0f]*'
// "Turn off your memory", "Delete my memories", "Don’t remember that": the assistant can't do these itself.
const MEMORY_COMMAND = /\b(?:turn|switch)\b[^?]*\bmemor(?:y|ies)\b|\b(?:disable|enable|pause|stop|delete|remove|clear|erase|wipe|reset|forget)\b[^?]*\bmemor(?:y|ies)\b|^\s*(?:(?:please|pls|plz)\s+)?(?:don['’]?t|do not|stop)\s+remember(?:ing)?\b/i
// "Forget that I prefer…" is a command too, but "Forget it, what about pricing?" means "never mind".
const FORGET = /^\s*(?:(?:please|pls|plz|can you|can u|could you|could u)\s+)?forget\b/i
// Figures of speech about the user's own memory are ordinary questions.
const MEMORY_IDIOM = /\b(?:refresh|jog)\s+(?:my|your)\s+memory\b|\bif (?:my|your) memory serves\b|\b(?:from|to) (?:my )?memory\b/i
// "What do you remember about me?", "What's in your memory?", a bare "What do you remember?"
const RECALL = new RegExp([
  '\\b(?:remember(?:ed)?|know|learn(?:ed|t)?)\\b[^.!?]*\\b(?:about|abt) me\\b',
  `\\bwhat(?:['’]?s| is) in ${YOUR} memory\\b`,
  `\\b(?:show|list|see|read)\\b[^.!?]*\\b(?:${YOUR}|my) memor(?:y|ies)\\b`,
  `\\bwhat are ${YOUR} memories\\b`,
  `\\bwhat did i (?:ask|tell) ${YOU} to remember\\b`,
  `\\bwhat ${YOU} remember(?:ed)?\\s*[?.!]*\\s*$`,
  `^\\s*what (?:do|did|have) ${YOU} (?:remember(?:ed)?|know|saved?)\\s*[?.!]*\\s*$`,
  `^\\s*do ${YOU} remember anything\\s*[?.!]*\\s*$`,
].join('|'), 'i')
// Anything else about the memory itself: "How does your memory work?", "Is my memory on?"
const MEMORY_TOPIC = /\b(?:your|ur|my|assistant(?:['’]s)?) memor(?:y|ies)\b/i

type RememberRequest =
  | { kind: 'fact'; fact: string; then?: string } // then: a question asked after the fact, answered too
  | { kind: 'empty' } // "Remember that" with nothing to save
  | { kind: 'reminder' } // "remember to call Priya"

const OPENER = '(?:hey|hi|hello|hearth|ok|okay|also|and|oh|so|btw|assistant|please|pls|plz|can you|can u|could you|could u|would you|would u|will you|will u)'
const REMEMBER_RE = new RegExp(`^\\s*(?:${OPENER}\\b[\\s,!.]*)*remember\\b(\\s*[:;–—-])?[\\s,]*(.*)$`, 'is')
const PERSONAL_START = /^(?:i|i['’]m|im|i['’]ve|i['’]ll|i['’]d|my|we|our|you|your)\b/i
const ABOUT_ME = /\b(?:i|i['’]m|im|i['’]ve|i['’]ll|i['’]d|my|me|mine|myself)\b/i
const NOT_A_FACT = /^(?:what|when|where|who|whom|whose|which|why|how|if|whether|anything|everything|something)\b/i
const REMINDER = /^(?:to|2)\b|^(?:call|email|e-mail|send|book|check|ask|tell|buy|pay|submit|reply|ring|text|message|follow up|pick up|bring|meet|update|review|approve|sign|file|chase|confirm|remind)\b/i
const QUESTION = new RegExp(`\\?${EMOJI}$`, 'u')

/** Trailing punctuation, emoji and pleasantries ("…, thanks 🙏") are not part of the fact. */
function cleanFact(t: string) {
  let prev: string
  do {
    prev = t
    t = t.replace(new RegExp(`[\\s.!?,;:\\p{Extended_Pictographic}\\u200d\\ufe0f]+$`, 'u'), '').replace(/[\s,]+(?:thanks|thank you|thank u|thx|ty|tq|cheers|please|pls|plz)$/i, '')
  } while (t !== prev)
  return t.trim()
}

/**
 * Reads a "remember" message. Saves need a clear signal: "Remember that…" or
 * "Remember: …", or a fact about you ("remember my manager is Wei Ling").
 * "Remember the Kranji quote" and "remember what we decided" are questions about
 * work, so they return null and get the normal answer.
 */
function parseRemember(text: string): RememberRequest | null {
  const m = REMEMBER_RE.exec(text)
  if (!m) return null
  let rest = m[2].trim()
  let marker: 'that' | 'colon' | null = m[1] ? 'colon' : null
  const lead = /^(that|this)\b\s*([:;–—-])?\s*/i.exec(rest)
  // "that" marks a fact ("Remember that I…"); "this" only with a colon ("remember this: …").
  if (lead && (lead[1].toLowerCase() === 'that' || lead[2])) {
    marker = lead[1].toLowerCase() === 'that' ? 'that' : 'colon'
    rest = rest.slice(lead[0].length)
  }
  const parts = rest.split(/(?<=[.!?])\s+|\s*\n+\s*/).filter(Boolean)
  let factParts: string[]
  let then: string[] = []
  if (parts.length && QUESTION.test(parts[0])) {
    // The request itself is a question. "Remember that Kranji quote?" asks about work;
    // only a marked fact about you, "Could you remember that I like agendas early?", saves.
    if (!(marker && ABOUT_ME.test(parts[0]))) return null
    factParts = [parts[0]]
    then = parts.slice(1)
  } else {
    const q = parts.findIndex(p => QUESTION.test(p))
    factParts = q === -1 ? parts : parts.slice(0, q)
    then = q === -1 ? [] : parts.slice(q)
  }
  const body = cleanFact(factParts.map(p => (/[.!?]$/.test(p) ? p : `${p}.`)).join(' '))
  if (!body || /^(?:that|this|it|so|them|me|everything|please|pls|plz)$/i.test(body)) return { kind: 'empty' }
  if (REMINDER.test(body)) return { kind: 'reminder' }
  if (!marker && !PERSONAL_START.test(body)) return null
  if (marker !== 'that' && NOT_A_FACT.test(body)) return null
  return { kind: 'fact', fact: aboutYou(body), then: then.join(' ') || undefined }
}

// The assistant writes memories to you, so swap the speaker: your "I/my" become "you/your",
// and "you/your" (meaning the assistant) become "I/my".
const SWAP: Record<string, string> = {
  'i am': 'you are', 'i’m': 'you’re', im: 'you’re', 'i was': 'you were', 'i wasn’t': 'you weren’t', 'i’ve': 'you’ve', 'i’ll': 'you’ll', 'i’d': 'you’d',
  i: 'you', me: 'you', my: 'your', mine: 'yours', myself: 'yourself',
  'you are': 'I am', 'you’re': 'I’m', 'you aren’t': 'I’m not', 'you were': 'I was', 'you weren’t': 'I wasn’t', 'you’ve': 'I’ve', 'you’ll': 'I’ll', 'you’d': 'I’d',
  your: 'my', yours: 'mine', yourself: 'myself',
}
const PRONOUN = /\b(?:i am|i['’]m|im|i was|i wasn['’]t|i['’]ve|i['’]ll|i['’]d|you are|you['’]re|you aren['’]t|you were|you weren['’]t|you['’]ve|you['’]ll|you['’]d|myself|yourself|mine|yours|my|your|me|i(?!\.\w)|you)\b/gi
// A bare "you" is the subject ("I") before a verb or at the start of a clause, otherwise the object ("me").
const SUBJECT_NEXT = /^\s+(?:can|could|should|shall|will|would|must|may|might|need|needs|have|had|do|did|don['’]t|didn['’]t|always|never|only|just|also|usually|often|write|draft|send|make|prepare|book|reply|use|keep|remind|get|give|take|tell|call|ask|check|summarise|summarize|schedule|start|stop|help|find|flag|post|share|add|put|cc|copy|read|answer)\b/i
const CLAUSE_START = /(?:^|[,;:]\s*|\b(?:and|but|or|that|when|whenever|if|so|because|then|while|unless|before|after|once|until)\s+)$/i
const ABBREVIATION = /(?:\b[a-z]\.[a-z]\.|\b(?:e\.g|i\.e|etc|vs|approx|incl|no|dr|mr|mrs|ms|st)\.)$/i

/** "I was promoted in March" → "You were promoted in March."; "the summaries you write for me" → "the summaries I write for you". */
function aboutYou(text: string) {
  const swapped = text.replace(PRONOUN, (w: string, at: number, all: string) => {
    const key = w.toLowerCase().replace(/'/g, '’')
    if (key !== 'you') return SWAP[key]
    return SUBJECT_NEXT.test(all.slice(at + w.length)) || CLAUSE_START.test(all.slice(0, at)) ? 'I' : 'me'
  })
  // Capitalise each sentence, but not the word after "a.m." or "e.g.".
  const capped = swapped.replace(/(^|[.!?]\s+)([a-z])/g, (m: string, p: string, c: string, at: number, all: string) =>
    p && ABBREVIATION.test(all.slice(0, at + 1)) ? m : p + c.toUpperCase())
  return `${capped}.`
}

const sameFact = (a: string, b: string) => {
  // Compare ignoring case, punctuation, spacing and contractions ("you’re" = "you are").
  const norm = (t: string) => t.toLowerCase().replace(/'/g, '’')
    .replace(/n’t\b/g, ' not').replace(/’re\b/g, ' are').replace(/’m\b/g, ' am').replace(/’ve\b/g, ' have').replace(/’ll\b/g, ' will').replace(/’d\b/g, ' would')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  return norm(a) === norm(b)
}
const sentence = (t: string) => (/[.!?]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`)

// Today's drafts (PA-04/PA-08) use a memory only while memory is on and that memory is
// still there as it was: deleting or rewording "You prefer short replies…" means the demo
// can't honestly claim the short draft follows it, so the draft without it is used. A draft
// that uses a memory cites it, so you can see why it reads the way it does.
const seedActionableById = Object.fromEntries(seedActionables.map(a => [a.id, a]))
const seedMemoryById = Object.fromEntries(seedMemories.map(m => [m.id, m]))

function withMemoryDrafts(s: State): State {
  return {
    ...s,
    actionables: s.actionables.map(a => {
      const seed = seedActionableById[a.id]
      const d = seed?.draft
      if (!a.draft || !d?.memoryId || d.withoutMemory === undefined) return a
      // The memory as written, under its own id or taught again in the Assistant chat.
      const fact = seedMemoryById[d.memoryId]?.text ?? ''
      const used = s.memoryOn ? s.memories.find(m => m.id === d.memoryId && sameFact(m.text, fact)) ?? s.memories.find(m => sameFact(m.text, fact)) : undefined
      const text = used ? d.text : d.withoutMemory
      const sources = used ? [...(seed.sources ?? []), memoryUsed(used)] : seed.sources
      return a.draft.text === text && a.sources === sources ? a : { ...a, draft: { ...a.draft, text }, sources }
    }),
  }
}

const memoryUsed = (m: Memory): SourceRef => ({ label: `Your memory: ${m.text.charAt(0).toLowerCase()}${m.text.slice(1)}`, kind: 'person', route: { name: 'settings', section: 'memory' } })

/** ask()'s answer when the question is about the assistant's memory, or null. */
function memoryAnswer(q: string, s: Pick<State, 'memoryOn' | 'memories'>): { answer: string; sources: SourceRef[] } | null {
  const work = workAnswer(q)
  if (MEMORY_COMMAND.test(q) || (FORGET.test(q) && !work && !q.includes('?'))) return { answer: MEMORY_SETTINGS, sources: [MEMORY_SOURCE] }
  if (MEMORY_IDIOM.test(q)) return null
  const req = parseRemember(q)
  if (req?.kind === 'reminder') return { answer: MEMORY_REMINDER, sources: [] }
  if (req) return s.memoryOn ? { answer: 'To have me remember something, tell me in your Assistant chat, starting with “Remember that…”.', sources: [MEMORY_SOURCE] } : { answer: MEMORY_OFF_SAVE, sources: [MEMORY_SOURCE] }
  if (RECALL.test(q)) {
    if (!s.memoryOn) return { answer: MEMORY_OFF, sources: [MEMORY_SOURCE] }
    if (!s.memories.length) return { answer: 'I don’t remember anything about you yet. Tell me “Remember that…” in your Assistant chat and I’ll save it where you can see it, in Settings › Assistant memory.', sources: [MEMORY_SOURCE] }
    return { answer: `Here’s what I remember about you: ${s.memories.map(m => sentence(m.text)).join(' ')} You can edit or delete any of it in Settings › Assistant memory.`, sources: [MEMORY_SOURCE] }
  }
  if (MEMORY_TOPIC.test(q) && !work) {
    return s.memoryOn
      ? { answer: 'Memory is on. When you tell me “Remember that…” in your Assistant chat, I save it, and you can ask me what I remember. You can see, edit or delete it all, or turn memory off, in Settings › Assistant memory.', sources: [MEMORY_SOURCE] }
      : { answer: MEMORY_OFF, sources: [MEMORY_SOURCE] }
  }
  return null
}

let idSeq = 1000
export const newId = (prefix: string) => `${prefix}_${++idSeq}`

interface Api {
  state: State
  navigate: (route: Route, opts?: { replace?: boolean }) => void
  back: () => void
  completeOnboarding: () => void
  send: (conversationId: ConversationId, text: string) => void
  sendVoice: (conversationId: ConversationId, durationSec: number, transcript: string) => void
  markRead: (conversationId: ConversationId) => void
  setDraft: (conversationId: ConversationId, text: string) => void
  react: (messageId: string, emoji: string) => void
  joinRoom: (roomId: RoomId) => void
  leaveRoom: () => void
  setSpeaking: (roomId: RoomId, personId?: string) => void
  acceptSuggested: (id: string, edits?: { title?: string; due?: string }) => void
  dismissSuggested: (id: string) => void
  addTask: (title: string, due?: string) => void
  setTaskStatus: (id: string, status: TaskStatus) => void
  dismissActionable: (id: string) => void
  useDraft: (actionableId: string) => void
  rsvp: (eventId: string, rsvp: CalendarEvent['rsvp']) => void
  updateDoc: (doc: Doc) => void
  deleteMemory: (id: string) => void
  editMemory: (id: string, text: string) => void
  setMemoryOn: (on: boolean) => void
  toast: (text: string, action?: Toast['action']) => void
  dismissToast: (id: number) => void
  setTheme: (theme: ThemeChoice) => void
  ask: (q: string) => { answer: string; sources: import('./types').SourceRef[]; matched: boolean }
}

const Ctx = createContext<Api | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial, init => {
    try {
      const saved = JSON.parse(localStorage.getItem('hearth-demo') ?? '{}')
      const tab = window.location.hash.slice(1)
      const tabs = ['today', 'chats', 'rooms', 'tasks', 'calendar', 'docs', 'insights', 'ask', 'settings']
      const route = tabs.includes(tab) ? ({ name: tab } as Route) : init.route
      return withMemoryDrafts({ ...init, route, onboarded: !!saved.onboarded || tabs.includes(tab), theme: saved.theme ?? 'system' })
    } catch {
      return withMemoryDrafts(init)
    }
  })
  const stateRef = useRef(state)
  stateRef.current = state
  const timers = useRef<number[]>([])
  const later = useCallback((ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms))
  }, [])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  // Persist the two per-viewer conveniences only.
  useEffect(() => {
    try {
      localStorage.setItem('hearth-demo', JSON.stringify({ onboarded: state.onboarded, theme: state.theme }))
    } catch {
      /* storage unavailable: fine */
    }
  }, [state.onboarded, state.theme])

  // Apply the theme choice to the document root. "System" leaves the root alone,
  // so a theme the host page set (or the OS setting) still applies; switching back
  // to it restores whatever was there before the demo changed it.
  const hostTheme = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    const root = document.documentElement
    if (state.theme === 'system') {
      if (hostTheme.current === undefined) return
      if (hostTheme.current === null) root.removeAttribute('data-theme')
      else root.setAttribute('data-theme', hostTheme.current)
      hostTheme.current = undefined
      return
    }
    if (hostTheme.current === undefined) hostTheme.current = root.getAttribute('data-theme')
    root.setAttribute('data-theme', state.theme)
  }, [state.theme])

  // Demo clock ticks so "live" durations move.
  useEffect(() => {
    const t = window.setInterval(() => dispatch({ type: 'tick' }), 15_000)
    return () => clearInterval(t)
  }, [])

  const toast = useCallback((text: string, action?: Toast['action']) => {
    const id = Date.now() + Math.random()
    dispatch({ type: 'toast', toast: { id, text, action } })
    later(4500, () => dispatch({ type: 'dismissToast', id }))
  }, [later])

  const ask = useCallback((q: string) => {
    const mem = memoryAnswer(q, stateRef.current)
    if (mem) return { ...mem, matched: true }
    const hit = workAnswer(q)
    return hit ? { answer: hit.answer, sources: hit.sources, matched: true } : { answer: askFallback, sources: [], matched: false }
  }, [])

  const send = useCallback((conversationId: ConversationId, text: string) => {
    const s = stateRef.current
    dispatch({ type: 'addMessage', message: { id: newId('m'), conversationId, authorId: ME, kind: 'text', text, ts: s.clock, readBy: [] } })
    dispatch({ type: 'setDraft', conversationId, text: '' })
    const conv = s.conversations.find(c => c.id === conversationId)
    if (conv?.kind === 'assistant') {
      dispatch({ type: 'typing', conversationId, personId: ASSISTANT })
      // Decide at reply time, so flipping the memory switch mid-reply is respected.
      later(1400, () => {
        const now = stateRef.current
        const req = parseRemember(text)
        let answer: string
        let sources: SourceRef[] = []
        if (!req) ({ answer, sources } = ask(text))
        else if (req.kind === 'reminder') answer = MEMORY_REMINDER
        else {
          sources = [MEMORY_SOURCE]
          if (!now.memoryOn) answer = MEMORY_OFF_SAVE
          else if (req.kind === 'empty') answer = MEMORY_ASK_WHAT
          else if (now.memories.some(m => sameFact(m.text, req.fact))) answer = `I already remember that: “${req.fact}”`
          else {
            dispatch({ type: 'addMemory', memory: { id: newId('mem'), text: req.fact, learnedFrom: `You told me on ${shortDay(now.clock).split(' ').slice(1).join(' ')}` } })
            answer = `Got it. I’ll remember: “${req.fact}” You can edit or delete it in Settings › Assistant memory.`
          }
        }
        // "Remember that I prefer email. What did we decide on pricing?" answers the question too.
        if (req?.kind === 'fact' && req.then) {
          const more = ask(req.then)
          answer = `${answer}\n\n${more.answer}`
          sources = more.sources
        }
        dispatch({ type: 'addMessage', message: { id: newId('m'), conversationId, authorId: ASSISTANT, kind: 'text', text: answer, sources, ts: now.clock } })
      })
      return
    }
    const reply = scriptedReplies[conversationId]
    if (reply && !s.messages.some(m => m.conversationId === conversationId && m.authorId === reply.from && m.text === reply.text)) {
      later(1200, () => dispatch({ type: 'typing', conversationId, personId: reply.from }))
      later(3600, () => dispatch({ type: 'addMessage', message: { id: newId('m'), conversationId, authorId: reply.from, kind: 'text', text: reply.text, ts: stateRef.current.clock } }))
    }
  }, [ask, later])

  const sendVoice = useCallback((conversationId: ConversationId, durationSec: number, transcript: string) => {
    const waveform = Array.from({ length: 30 }, (_, i) => 0.25 + 0.6 * Math.abs(Math.sin(i * 1.7 + durationSec)))
    dispatch({ type: 'addMessage', message: { id: newId('m'), conversationId, authorId: ME, kind: 'voice', voice: { durationSec, waveform, transcript }, ts: stateRef.current.clock, readBy: [] } })
  }, [])

  const leaveRoom = useCallback(() => {
    const s = stateRef.current
    const roomId = s.myRoomId
    dispatch({ type: 'leaveRoom' })
    if (roomId !== 'r_ops') {
      toast('You left the room. The session is still recorded while 2 or more people remain.')
      return
    }
    // J3: leaving the Ops standup produces a transcript, notes and suggested tasks.
    const sessionId = 's_standup_mon'
    const start = Date.parse('2026-10-12T08:30:00+08:00')
    const lines = opsStandupScript.lines
    const transcriptEnd = 610 + lines.length * 34
    const session: Session = {
      id: sessionId,
      title: 'Ops standup',
      roomId: 'r_ops',
      conversationId: 'c_ops',
      meetingId: 'e_standup',
      startedAt: start,
      durationSec: Math.max(transcriptEnd, Math.round((s.clock - start) / 1000)),
      participants: ['u_priya', 'u_marcus', 'u_farah', ME],
      viewedBy: [],
      transcript: [
        { speakerId: 'u_priya', startSec: 5, endSec: 24, text: 'Morning. Inbound first: the container is now Tuesday 6 am, crew moved.' },
        { speakerId: 'u_marcus', startSec: 26, endSec: 48, text: 'Roster for Saturday is with Ashton. Eleven people.' },
        ...lines.map((l, i) => ({ speakerId: l.speakerId, startSec: 610 + i * 34, endSec: 610 + i * 34 + 28, text: l.text })),
      ],
      notes: opsStandupScript.notes,
    }
    // The standup wraps up as you leave, so the room empties and recording stops.
    dispatch({ type: 'endRoom', roomId })
    toast('Standup wrapped up. Recording saved, notes in under 5 minutes.')
    dispatch({ type: 'addSession', session })
    later(3500, () => {
      dispatch({ type: 'addMessage', message: { id: newId('m'), conversationId: 'c_ops', authorId: ME, kind: 'notes', sessionId, ts: stateRef.current.clock } })
      const mine = opsStandupScript.notes.actionItems.filter(a => a.ownerId === ME)
      dispatch({
        type: 'addSuggested',
        items: mine.map(a => ({ id: `st_${a.id}`, title: a.text, ownerId: ME, due: a.due, source: { kind: 'meeting' as const, label: 'Action item · Ops standup · today', route: { name: 'session' as const, sessionId } } })),
      })
      toast('Ops standup notes are ready · 1 action item for you', { label: 'View notes', route: { name: 'session', sessionId } })
    })
  }, [later, toast])

  const api = useMemo<Api>(() => ({
    state,
    navigate: (route, opts) => dispatch({ type: 'navigate', route, replace: opts?.replace }),
    back: () => dispatch({ type: 'back' }),
    completeOnboarding: () => dispatch({ type: 'onboarded' }),
    send,
    sendVoice,
    markRead: id => dispatch({ type: 'markRead', conversationId: id }),
    setDraft: (id, text) => dispatch({ type: 'setDraft', conversationId: id, text }),
    react: (messageId, emoji) => dispatch({ type: 'react', messageId, emoji }),
    joinRoom: roomId => dispatch({ type: 'joinRoom', roomId }),
    leaveRoom,
    setSpeaking: (roomId, personId) => dispatch({ type: 'setSpeaking', roomId, personId }),
    acceptSuggested: (id, edits) => {
      dispatch({ type: 'acceptSuggested', id, title: edits?.title, due: edits?.due })
      toast('Added to My tasks')
    },
    dismissSuggested: id => dispatch({ type: 'dismissSuggested', id }),
    addTask: (title, due) => dispatch({ type: 'addTask', task: { id: newId('t'), title, due, assigneeIds: [ME], status: 'todo', source: { kind: 'manual', label: 'Added by you' } } }),
    setTaskStatus: (id, status) => dispatch({ type: 'setTaskStatus', id, status }),
    dismissActionable: id => dispatch({ type: 'dismissActionable', id }),
    useDraft: actionableId => {
      const a = stateRef.current.actionables.find(x => x.id === actionableId)
      if (!a?.draft) return
      dispatch({ type: 'setDraft', conversationId: a.draft.conversationId, text: a.draft.text })
      dispatch({ type: 'navigate', route: { name: 'chats', conversationId: a.draft.conversationId } })
    },
    rsvp: (eventId, rsvp) => dispatch({ type: 'rsvp', eventId, rsvp }),
    updateDoc: doc => dispatch({ type: 'updateDoc', doc }),
    deleteMemory: id => dispatch({ type: 'deleteMemory', id }),
    editMemory: (id, text) => dispatch({ type: 'editMemory', id, text }),
    setMemoryOn: on => dispatch({ type: 'memoryOn', on }),
    toast,
    dismissToast: id => dispatch({ type: 'dismissToast', id }),
    setTheme: theme => dispatch({ type: 'theme', theme }),
    ask,
  }), [state, send, sendVoice, leaveRoom, toast, ask])

  // Test hook used by scripts/screenshots.mjs (and handy in the console).
  useEffect(() => {
    ;(window as unknown as { __hearth?: Api }).__hearth = api
  }, [api])

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}

export function useStore() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useStore outside StoreProvider')
  return v
}
