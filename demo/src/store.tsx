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
      return { ...s, memories: s.memories.filter(m => m.id !== a.id) }
    case 'editMemory':
      return { ...s, memories: s.memories.map(m => (m.id === a.id ? { ...m, text: a.text } : m)) }
    case 'memoryOn':
      return { ...s, memoryOn: a.on }
    case 'addMemory':
      return { ...s, memories: [...s.memories, a.memory] }
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
  dm_priya: { from: 'u_priya', text: 'Great, thanks! I’ll confirm the insurance cover on tomorrow’s call and send them the notice letter after. 👍' },
  dm_marcus: { from: 'u_marcus', text: 'Thanks boss, telling the crew now 👍' },
  g_q4: { from: 'u_daniel', text: 'Thanks! I’ll walk everyone through v3 at the 3 pm review.' },
  ag_it: { from: 'a_it', text: 'I’ve noted that. For anything urgent, Arjun is on #it-help until 6 pm.' },
}

// ── Personal memory (PA-10) ───────────────────────────────────────────────────
// The assistant saves something only when you tell it to and memory is on, and it
// only uses what it remembered while memory is on. Turning memory off keeps the
// list (you can still see, edit and delete it in Settings) but stops both.
// "Remember that…" / "Can you remember: …" save a fact; "remember to…" (a reminder) and
// "remember what/when…" (a question) don't.
const REMEMBER = /^\s*(?:(?:please|can you|could you|would you)\s+)*remember[\s,:]+(?:that\s+)?(?!(?:to|what|when|where|who|why|how|if|whether)\b)(.+)$/i
const RECALL = /\bwhat (?:do|did) you (?:remember|know) about me\b|\bwhat have you (?:remembered|learn(?:ed|t))\b|\b(?:your|my|assistant) memor(?:y|ies)\b/i
const MEMORY_SOURCE: SourceRef = { label: 'Your assistant memory', kind: 'person', route: { name: 'settings', section: 'memory' } }
const MEMORY_OFF = 'Memory is off, so I’m not using anything I remembered about you and I’m not saving anything new. You can turn it back on in Settings › Assistant memory.'

/** "I'm off on Fridays" → "You’re off on Fridays." so new memories read like the others. */
function aboutYou(text: string) {
  const t = text.trim().replace(/[.!?\s]+$/, '')
    .replace(/\bI am\b/gi, 'you are')
    .replace(/\bI['’]m\b/gi, 'you’re')
    .replace(/\bI['’]ve\b/gi, 'you’ve')
    .replace(/\bI['’]ll\b/gi, 'you’ll')
    .replace(/\bI['’]d\b/gi, 'you’d')
    .replace(/\bmyself\b/gi, 'yourself')
    .replace(/\bmine\b/gi, 'yours')
    .replace(/\bmy\b/gi, 'your')
    .replace(/\bme\b/gi, 'you')
    .replace(/\bi\b(?!\.\w)/gi, 'you') // a lone I or i, but not the i in "i.e."
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}.`
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
      return { ...init, route, onboarded: !!saved.onboarded || tabs.includes(tab), theme: saved.theme ?? 'system' }
    } catch {
      return init
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

  // Apply theme choice to the document root.
  useEffect(() => {
    const root = document.documentElement
    if (state.theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', state.theme)
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
    const lower = q.toLowerCase()
    if (RECALL.test(q)) {
      const { memoryOn, memories } = stateRef.current
      if (!memoryOn) return { answer: MEMORY_OFF, sources: [], matched: true }
      if (!memories.length) return { answer: 'I don’t remember anything about you yet. Say “Remember that…” and I’ll save it where you can see it, in Settings › Assistant memory.', sources: [], matched: true }
      return { answer: `Here’s what I remember about you: ${memories.map(m => m.text).join(' ')} You can edit or delete any of it in Settings › Assistant memory.`, sources: [MEMORY_SOURCE], matched: true }
    }
    const hit = askAnswers.find(a => a.keywords.some(k => lower.includes(k)))
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
        const learn = REMEMBER.exec(text)
        let answer: string
        if (!learn) answer = ask(text).answer
        else {
          const fact = aboutYou(learn[1])
          if (!now.memoryOn) answer = 'Memory is off, so I won’t remember that. Turn it on in Settings › Assistant memory if you’d like me to.'
          else if (now.memories.some(m => m.text.toLowerCase() === fact.toLowerCase())) answer = `I already remember that: “${fact}”`
          else {
            dispatch({ type: 'addMemory', memory: { id: newId('mem'), text: fact, learnedFrom: `You told me on ${shortDay(now.clock).split(' ').slice(1).join(' ')}` } })
            answer = `Got it. I’ll remember: “${fact}” You can edit or delete it in Settings › Assistant memory.`
          }
        }
        dispatch({ type: 'addMessage', message: { id: newId('m'), conversationId, authorId: ASSISTANT, kind: 'text', text: answer, ts: now.clock } })
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
    const session: Session = {
      id: sessionId,
      title: 'Ops standup',
      roomId: 'r_ops',
      conversationId: 'c_ops',
      meetingId: 'e_standup',
      startedAt: start,
      durationSec: Math.max(16 * 60, Math.round((s.clock - start) / 1000)),
      participants: ['u_priya', 'u_marcus', 'u_farah', ME],
      viewedBy: [],
      transcript: [
        { speakerId: 'u_priya', startSec: 5, endSec: 24, text: 'Morning. Inbound first: the container is now Tuesday 6 am, crew moved.' },
        { speakerId: 'u_marcus', startSec: 26, endSec: 48, text: 'Roster for Saturday is with Ashton. Eleven people.' },
        ...lines.map((l, i) => ({ speakerId: l.speakerId, startSec: 610 + i * 34, endSec: 610 + i * 34 + 28, text: l.text })),
      ],
      notes: opsStandupScript.notes,
    }
    toast('Recording saved. Notes in under 5 minutes.')
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
