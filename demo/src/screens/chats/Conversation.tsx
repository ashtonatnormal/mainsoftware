// An open conversation: header, messages on the chat wall, typing indicator
// and composer. On phones it is immersive (its own header with a back button).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Headphones, Info, Lock, MessageCircleOff } from 'lucide-react'
import type { Conversation as Conv, Message, SourceRef } from '../../types'
import { useStore } from '../../store'
import { ME, personById } from '../../data/people'
import { AgentBadge, AIMarker, Avatar, AvatarStack, Button, cx, EmptyState, IconButton, personName, personShort, ScreenHeader } from '../../ui'
import { dayLabel, sameDay } from '../../time'
import { Composer } from './Composer'
import { MessageRow } from './MessageItem'
import { ActionsSheet, InfoSheet, ThreadSheet } from './Sheets'
import { seedSources, threadReplies, type ThreadReply } from './content'
import { ConvAvatar, ConvTitle, convLabel, counterpart, isAI, isMulti, liveRoom, statusLabel } from './parts'

const GROUP_GAP_MS = 10 * 60_000
/** Replies you add in a thread during the demo (kept while the page is open). */
const addedReplies: Record<string, ThreadReply[]> = {}

export function Conversation({ id }: { id: string }) {
  const { state, back } = useStore()
  const c = state.conversations.find(x => x.id === id)
  if (!c)
    return (
      <div className="flex h-full flex-col">
        <ScreenHeader title="Chat not found" back={back} className="md:hidden" />
        <div className="flex flex-1 items-center justify-center bg-wall">
          <EmptyState icon={<MessageCircleOff size={28} />} title="This chat isn’t available" body="It may have been removed, or you’re not a member." />
        </div>
      </div>
    )
  return <ConversationView c={c} />
}

type Item = { type: 'unread'; key: string; count: number } | { type: 'msg'; key: string; m: Message; first: boolean }
interface Day {
  key: string
  ts: number
  items: Item[]
}

function ConversationView({ c }: { c: Conv }) {
  const { state, markRead, back, ask, send } = useStore()
  // Where the "N unread messages" divider goes, fixed when the chat opens.
  const [unreadAtOpen] = useState(() => {
    const list = state.messages.filter(m => m.conversationId === c.id).sort((a, b) => a.ts - b.ts)
    return c.unread > 0 && c.unread < list.length ? { id: list[list.length - c.unread].id, count: c.unread } : undefined
  })
  const [infoOpen, setInfoOpen] = useState(false)
  const [threadOf, setThreadOf] = useState<Message | null>(null)
  const [actionsFor, setActionsFor] = useState<Message | null>(null)
  const [, bump] = useState(0)

  useEffect(() => {
    markRead(c.id)
  }, [c.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const msgs = useMemo(() => state.messages.filter(m => m.conversationId === c.id).sort((a, b) => a.ts - b.ts), [state.messages, c.id])

  const days = useMemo(() => {
    const out: Day[] = []
    let unreadFrom = unreadAtOpen ? msgs.findIndex(m => m.id === unreadAtOpen.id) : -1
    // Once you've replied, you've caught up: drop the divider (as WhatsApp does).
    if (unreadFrom >= 0 && msgs.slice(unreadFrom).some(m => m.authorId === ME)) unreadFrom = -1
    const groupable = (x: Message) => x.kind !== 'system' && x.kind !== 'notes' && x.kind !== 'suggest'
    msgs.forEach((m, i) => {
      const prev = msgs[i - 1]
      const newDay = !prev || !sameDay(prev.ts, m.ts)
      if (newDay) out.push({ key: `d_${m.id}`, ts: m.ts, items: [] })
      const day = out[out.length - 1]
      if (i === unreadFrom && unreadAtOpen) day.items.push({ type: 'unread', key: 'unread', count: unreadAtOpen.count })
      const first = newDay || i === unreadFrom ||!prev || prev.authorId !== m.authorId || !groupable(prev) || !groupable(m) || m.ts - prev.ts > GROUP_GAP_MS
      day.items.push({ type: 'msg', key: m.id, m, first })
    })
    return out
  }, [msgs, unreadAtOpen])

  // Read ticks (CHAT-09): read when the other side has read it or replied since.
  const others = c.members.filter(x => x !== ME)
  const isRead = (m: Message, idx: number) =>
    (m.readBy?.length ?? 0) >= Math.max(1, others.length) || msgs.slice(idx + 1).some(x => x.authorId !== ME && others.includes(x.authorId))

  // Sources behind AI messages: seeded ones, or what the assistant cited for your question.
  const sourcesFor = (m: Message, idx: number): SourceRef[] | undefined => {
    if (!isAI(m.authorId) || m.kind !== 'text') return undefined
    if (m.sources) return m.sources
    if (seedSources[m.id]) return seedSources[m.id]
    if (c.kind === 'assistant') {
      const q = [...msgs.slice(0, idx)].reverse().find(x => x.authorId === ME && x.kind === 'text')
      if (q?.text) {
        const res = ask(q.text)
        if (res.answer === m.text) return res.sources
      }
    }
    return []
  }

  const repliesFor = (mid: string): ThreadReply[] => [...(threadReplies[mid] ?? []), ...(addedReplies[mid] ?? [])]

  // ── Scrolling: newest message on open, and stay pinned to the bottom ────────
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const toBottom = useCallback((smooth: boolean) => {
    const el = scroller.current
    if (!el) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduce ? 'smooth' : 'auto' })
  }, [])
  useLayoutEffect(() => {
    toBottom(false)
  }, [toBottom])
  const typingId = state.typing[c.id]
  const lastId = msgs[msgs.length - 1]?.id
  useEffect(() => {
    toBottom(true)
    atBottom.current = true
  }, [lastId, typingId, toBottom])
  useEffect(() => {
    const el = content.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (atBottom.current) toBottom(false)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [toBottom])

  const multi = isMulti(c)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header c={c} onInfo={() => setInfoOpen(true)} onBack={back} />

      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto bg-wall"
        onScroll={e => {
          const el = e.currentTarget
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <div ref={content} className={'mx-auto flex min-h-full w-full max-w-3xl flex-col justify-end px-3 pt-2 pb-4 sm:px-6'}>
          <Intro c={c} />
          {days.map(day => (
            <section key={day.key} aria-label={dayLabel(day.ts)}>
              <div className="sticky top-2 z-[5] my-3 flex justify-center">
                <span className="rounded-full bg-surface px-3 py-1 text-xs font-medium text-muted shadow-card">{dayLabel(day.ts)}</span>
              </div>
              {day.items.map(it =>
                it.type === 'unread' ? (
                  <div key={it.key} className="my-3 flex items-center gap-3" role="separator">
                    <span className="h-px flex-1 bg-accent/40" />
                    <span className="rounded-full bg-accent-soft px-3 py-1 text-xs font-semibold text-accent-ink">
                      {it.count} unread {it.count === 1 ? 'message' : 'messages'}
                    </span>
                    <span className="h-px flex-1 bg-accent/40" />
                  </div>
                ) : (
                  <MessageRowFor
                    key={it.key}
                    m={it.m}
                    c={c}
                    first={it.first}
                    idx={msgs.indexOf(it.m)}
                    isRead={isRead}
                    sourcesFor={sourcesFor}
                    replies={repliesFor(it.m.id)}
                    onThread={setThreadOf}
                    onActions={setActionsFor}
                  />
                ),
              )}
            </section>
          ))}
          {typingId && <Typing personId={typingId} showAvatar={multi} />}
        </div>
      </div>

      <Composer key={c.id} c={c} />

      <InfoSheet c={c} open={infoOpen} onClose={() => setInfoOpen(false)} />
      <ThreadSheet
        c={c}
        parent={threadOf}
        replies={threadOf ? repliesFor(threadOf.id) : []}
        onClose={() => setThreadOf(null)}
        onReply={(text, alsoSend) => {
          if (!threadOf) return
          const list = (addedReplies[threadOf.id] ??= [])
          list.push({ id: `tr_${Date.now()}`, authorId: ME, text, ts: state.clock })
          if (alsoSend) send(c.id, text)
          bump(n => n + 1)
        }}
      />
      <ActionsSheet m={actionsFor} onClose={() => setActionsFor(null)} onThread={m => setThreadOf(m)} />
    </div>
  )
}

function MessageRowFor({
  m,
  c,
  first,
  idx,
  isRead,
  sourcesFor,
  replies,
  onThread,
  onActions,
}: {
  m: Message
  c: Conv
  first: boolean
  idx: number
  isRead: (m: Message, idx: number) => boolean
  sourcesFor: (m: Message, idx: number) => SourceRef[] | undefined
  replies: ThreadReply[]
  onThread: (m: Message) => void
  onActions: (m: Message) => void
}) {
  const scripted = m.threadCount ?? 0
  const extra = Math.max(0, replies.length - (threadReplies[m.id]?.length ?? 0))
  const count = scripted + extra
  const ids = [...new Set([...(m.threadPreview ?? []), ...replies.map(r => r.authorId)])]
  return (
    <MessageRow
      m={m}
      c={c}
      first={first}
      read={m.authorId === ME && isRead(m, idx)}
      threadCount={count}
      threadIds={ids}
      lastReplyTs={replies[replies.length - 1]?.ts}
      sources={sourcesFor(m, idx)}
      onThread={onThread}
      onActions={onActions}
    />
  )
}

// ── Header ────────────────────────────────────────────────────────────────────
function Header({ c, onInfo, onBack }: { c: Conv; onInfo: () => void; onBack: () => void }) {
  const { state, joinRoom, navigate } = useStore()
  const room = c.roomId ? state.rooms.find(r => r.id === c.roomId) : undefined
  const live = liveRoom(c, state.rooms)
  const inRoom = !!room && state.myRoomId === room.id
  const pid = counterpart(c)
  const p = pid ? personById[pid] : undefined

  let subtitle: ReactNode
  if (c.kind === 'channel') subtitle = c.topic ?? `${c.members.length} members`
  else if (c.kind === 'group') subtitle = `${c.members.length} members`
  else if (c.kind === 'assistant')
    subtitle = (
      <span className="inline-flex items-center gap-1">
        <Lock size={11} aria-hidden /> Private to you
      </span>
    )
  else if (c.kind === 'agent' && p)
    subtitle = (
      <span className="inline-flex items-center gap-1.5">
        <AgentBadge /> owned by {personName(p.agentOwner ?? '')}
      </span>
    )
  else if (p) {
    const inSomeRoom = state.rooms.find(r => r.participants.includes(p.id))
    subtitle = `${p.title} · ${inSomeRoom ? `In ${inSomeRoom.name}` : p.customStatus ?? statusLabel[p.status]}`
  }

  const enterRoom = () => {
    if (!room) return
    if (!inRoom) joinRoom(room.id)
    navigate({ name: 'rooms', roomId: room.id })
  }

  return (
    <ScreenHeader
      className="pl-1 sm:pl-2 md:pl-4"
      leading={
        <>
          <IconButton label="Back" onClick={onBack} className="md:hidden">
            <ArrowLeft size={20} />
          </IconButton>
          {/* Same action as the title button, so keep it out of the tab order. */}
          <button onClick={onInfo} className="shrink-0 rounded-full" tabIndex={-1} aria-hidden>
            <ConvAvatar c={c} size="md" />
          </button>
        </>
      }
      title={
        <button onClick={onInfo} className="block max-w-full truncate text-left" aria-label={`${convLabel(c)}: conversation info`}>
          <ConvTitle c={c} className="truncate" />
        </button>
      }
      subtitle={subtitle}
      actions={
        <>
          {room &&
            (live ? (
              <button
                onClick={enterRoom}
                aria-label={`${inRoom ? 'Open' : 'Join'} ${room.name}: ${live.participants.length} people inside, recording`}
                title={`${room.name} · recording`}
                className="inline-flex h-9 items-center gap-2 rounded-full bg-rec-soft pr-3 pl-1.5 text-[13px] font-semibold text-rec transition hover:brightness-95"
              >
                <span className="hidden sm:inline-flex">
                  <AvatarStack ids={live.participants} max={3} size="xs" />
                </span>
                <span className="inline-flex sm:hidden">
                  <AvatarStack ids={live.participants.slice(0, 2)} max={2} size="xs" />
                </span>
                <span className="size-1.5 rounded-full bg-rec anim-pulse" aria-hidden />
                {inRoom ? 'Open' : 'Join'}
                <span className="hidden lg:inline">room</span>
              </button>
            ) : (
              <Button size="sm" variant="secondary" icon={<Headphones size={15} />} onClick={enterRoom} aria-label={`${inRoom ? 'Open' : 'Join'} ${room.name}`}>
                <span className="hidden sm:inline">{inRoom ? 'Open room' : 'Join room'}</span>
              </Button>
            ))}
          {/* On phones a room button leaves no space; tapping the name opens info there too. */}
          <span className={room ? 'hidden sm:block' : 'block'}>
            <IconButton label="Conversation info" onClick={onInfo}>
              <Info size={20} />
            </IconButton>
          </span>
        </>
      }
    />
  )
}

// ── Intro cards at the top of 1:1 AI conversations ────────────────────────────
function Intro({ c }: { c: Conv }) {
  const { navigate } = useStore()
  if (c.kind === 'assistant')
    return (
      <div className="mx-auto my-3 flex max-w-md flex-col items-center gap-2 rounded-2xl bg-surface px-4 py-4 text-center">
        <Avatar id="as_me" size="lg" />
        <p className="font-display text-lg font-semibold">Your private assistant</p>
        <p className="text-sm text-muted">
          It reads what you can see and answers with sources. It only suggests and drafts: it never sends anything for you.
        </p>
        <button className="text-sm font-semibold text-accent-ink hover:underline" onClick={() => navigate({ name: 'settings', section: 'memory' })}>
          See what it remembers
        </button>
      </div>
    )
  if (c.kind === 'agent') {
    const pid = counterpart(c)
    const p = pid ? personById[pid] : undefined
    if (!p) return null
    return (
      <div className="mx-auto my-3 flex max-w-md flex-col items-center gap-2 rounded-2xl bg-surface px-4 py-4 text-center">
        <Avatar id={p.id} size="lg" />
        <p className="flex items-center gap-2 font-display text-lg font-semibold">
          {p.name} <AgentBadge />
        </p>
        <p className="text-sm text-muted">{p.title}. Built by the central AI team and owned by {personName(p.agentOwner ?? '')}.</p>
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <AIMarker /> Answers are AI-generated and cite their sources.
        </p>
      </div>
    )
  }
  return null
}

function Typing({ personId, showAvatar }: { personId: string; showAvatar: boolean }) {
  const p = personById[personId]
  const label = p?.kind === 'assistant' ? 'Your assistant is checking your sources…' : `${personShort(personId)} is typing…`
  return (
    <div className="anim-in mt-3 flex items-end gap-2" role="status" aria-live="polite">
      {showAvatar && <Avatar id={personId} size="sm" />}
      <div className={cx('flex items-center gap-2.5 rounded-2xl rounded-tl-md bg-surface px-3.5 py-2.5')}>
        <span className="flex items-center gap-1" aria-hidden>
          {[0, 1, 2].map(i => (
            <span key={i} className="size-1.5 rounded-full bg-muted anim-pulse" style={{ animationDelay: `${i * 0.25}s` }} />
          ))}
        </span>
        <span className="text-xs text-muted">{label}</span>
      </div>
    </div>
  )
}
