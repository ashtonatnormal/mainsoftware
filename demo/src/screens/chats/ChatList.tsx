// CHAT-04: one WhatsApp-style list of every conversation — channels, DMs,
// groups, agents — with the assistant pinned first, then most recent activity.
import { useMemo, useState } from 'react'
import { BellOff, Bot, Check, CheckCheck, Mic, NotebookText, Paperclip, Pin, Search, SquarePen, X } from 'lucide-react'
import type { Conversation, ConversationKind, Message } from '../../types'
import { useStore } from '../../store'
import { ME, personById } from '../../data/people'
import { AgentBadge, Button, cx, EmptyState, IconButton, Pill, personShort, UnreadBadge } from '../../ui'
import { duration, listStamp } from '../../time'
import { ConvAvatar, ConvTitle, liveRoom } from './parts'

type Filter = 'all' | 'unread' | 'channels' | 'people' | 'agents'
const filters: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'channels', label: 'Channels' },
  { value: 'people', label: 'People' },
  { value: 'agents', label: 'Agents' },
]
const kindsFor: Record<Exclude<Filter, 'all' | 'unread'>, ConversationKind[]> = {
  channels: ['channel'],
  people: ['dm', 'group'],
  agents: ['agent', 'assistant'],
}

export function ChatList({ activeId }: { activeId?: string }) {
  const { state, navigate, toast } = useStore()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  const lastById = useMemo(() => {
    const map: Record<string, Message> = {}
    for (const m of state.messages) {
      const prev = map[m.conversationId]
      if (!prev || m.ts >= prev.ts) map[m.conversationId] = m
    }
    return map
  }, [state.messages])

  const query = q.trim().toLowerCase().replace(/^#/, '')
  const list = state.conversations
    .filter(c => (filter === 'all' ? true : filter === 'unread' ? c.unread > 0 || (c.mentions ?? 0) > 0 : kindsFor[filter].includes(c.kind)))
    .filter(c => !query || c.name.toLowerCase().includes(query))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.lastActivity - a.lastActivity)

  const open = (c: Conversation) => navigate({ name: 'chats', conversationId: c.id }, { replace: !!activeId })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-3 px-4 pt-3 pb-2 md:pt-4">
        <div className="hidden items-center justify-between gap-2 md:flex">
          <h1 className="font-display text-2xl font-semibold">Chats</h1>
          <IconButton label="New chat" onClick={() => toast('Starting new chats and channels comes later in the demo.')}>
            <SquarePen size={19} />
          </IconButton>
        </div>
        <div>
          <label htmlFor="chat-search" className="sr-only">Search chats by name</label>
          <div className="flex h-10 items-center gap-2 rounded-full bg-surface-2 px-3.5 text-muted focus-within:ring-2 focus-within:ring-accent">
            <Search size={16} className="shrink-0" aria-hidden />
            <input
              id="chat-search"
              type="text"
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search chats"
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-[15px] text-fg placeholder:text-muted"
              style={{ outline: 'none' }}
            />
            {q && (
              <button onClick={() => setQ('')} aria-label="Clear search" className="grid size-6 place-items-center rounded-full hover:bg-line">
                <X size={14} />
              </button>
            )}
          </div>
        </div>
        <div className="-mx-4 flex gap-1 overflow-x-auto px-4 [scrollbar-width:none]" role="group" aria-label="Filter chats">
          {filters.map(f => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              aria-pressed={filter === f.value}
              className={cx(
                'h-8 shrink-0 rounded-full px-2.5 text-[13px] font-medium transition md:px-2 lg:px-2.5',
                filter === f.value ? 'bg-accent-soft text-accent-ink' : 'bg-surface-2 text-muted hover:text-fg',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Extra room at the end on phones so the shell's "in a room" pill never hides the last chat. */}
      <div className={cx('min-h-0 flex-1 overflow-y-auto', state.myRoomId ? 'pb-20' : 'pb-4')}>
        {list.length === 0 ? (
          query ? (
            <EmptyState
              icon={<Search size={28} />}
              title={`No chats called “${q.trim()}”`}
              body="This box only matches chat names. Search & Ask can look inside messages, meetings and docs."
              action={<Button size="sm" onClick={() => navigate({ name: 'ask', q: q.trim() })}>Search everything</Button>}
            />
          ) : filter === 'unread' ? (
            <EmptyState icon={<CheckCheck size={28} />} title="You’re all caught up" body="Nothing unread. New messages will show up here." />
          ) : (
            <EmptyState title="Nothing here yet" body="Chats of this kind will show up here." />
          )
        ) : (
          <>
            <ul>
              {list.map(c => (
                <li key={c.id}>
                  <ChatRow c={c} last={lastById[c.id]} active={c.id === activeId} onOpen={() => open(c)} />
                </li>
              ))}
            </ul>
            {filter === 'agents' && !query && (
              <p className="flex gap-2.5 px-4 pt-4 text-[13px] text-muted">
                <Bot size={16} className="mt-0.5 shrink-0 text-agent" aria-hidden />
                <span>
                  HR Policy, Onboarding Buddy and Weekly Digest work inside channels such as #ask-hr and #leadership. Type @ and their name to ask one.
                </span>
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function ChatRow({ c, last, active, onOpen }: { c: Conversation; last?: Message; active: boolean; onOpen: () => void }) {
  const { state } = useStore()
  const room = liveRoom(c, state.rooms)
  const unread = c.unread > 0 && !c.muted
  const mentions = c.mentions ?? 0
  return (
    <button
      onClick={onOpen}
      aria-current={active ? 'true' : undefined}
      className={cx('flex w-full items-center gap-3 pl-4 text-left transition', active ? 'bg-accent-soft/60' : 'hover:bg-surface-2')}
    >
      <ConvAvatar c={c} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 border-b border-line py-3 pr-4">
        <span className="flex items-center gap-2">
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <ConvTitle c={c} className="min-w-0 truncate font-semibold" />
            {c.kind === 'agent' && <AgentBadge />}
            {room && (
              <Pill tone="rec" className="shrink-0" icon={<span className="size-1.5 rounded-full bg-rec anim-pulse" aria-hidden />}>
                Live · {room.participants.length}
              </Pill>
            )}
          </span>
          <span className={cx('shrink-0 text-xs tabular', unread ? 'font-semibold text-accent-ink' : 'text-muted')}>{listStamp(c.lastActivity)}</span>
        </span>
        <span className="flex items-center gap-2">
          <span className={cx('flex min-w-0 flex-1 items-center gap-1 text-sm', unread ? 'text-fg' : 'text-muted')}>
            <Preview c={c} last={last} />
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {c.muted && <BellOff size={14} className="text-muted" aria-label="Muted" />}
            {c.pinned && <Pin size={14} className="rotate-45 text-muted" aria-label="Pinned" />}
            {mentions > 0 && (
              <span className="grid size-5 place-items-center rounded-full bg-accent text-[11px] font-bold text-accent-fg" aria-label={`${mentions} mention${mentions > 1 ? 's' : ''} of you`}>
                @
              </span>
            )}
            <UnreadBadge count={c.unread} muted={c.muted} />
          </span>
        </span>
      </span>
    </button>
  )
}

function Preview({ c, last }: { c: Conversation; last?: Message }) {
  const { state } = useStore()
  const typingId = state.typing[c.id]
  const draft = state.drafts[c.id]?.trim()
  const isOpen = state.route.name === 'chats' && state.route.conversationId === c.id

  if (typingId) return <span className="truncate font-medium text-accent-ink">{personShort(typingId)} is typing…</span>
  if (draft && !isOpen)
    return (
      <span className="truncate">
        <span className="font-semibold text-accent-ink">Draft: </span>
        {draft}
      </span>
    )
  if (!last) return <span className="truncate">No messages yet</span>

  const mine = last.authorId === ME
  const author = personById[last.authorId]
  const firstLine = (last.text ?? '').split('\n')[0]
  // "Weekly Digest: Weekly digest · 5–9 Oct" reads badly; skip the name when the text already starts with it.
  const repeatsName = !!author && last.kind === 'text' && firstLine.toLowerCase().startsWith(author.name.toLowerCase())
  const showPrefix = ['text', 'voice', 'file'].includes(last.kind) && (mine || c.kind === 'channel' || c.kind === 'group') && !repeatsName
  const prefix = showPrefix ? (mine ? 'You: ' : `${author?.short ?? 'Someone'}: `) : ''
  const read = (last.readBy?.length ?? 0) > 0
  const ticks = mine && (c.kind === 'dm' || c.kind === 'group') && ['text', 'voice', 'file'].includes(last.kind)
    ? read ? <CheckCheck size={15} className="shrink-0 text-accent-ink" aria-label="Read" /> : <Check size={15} className="shrink-0 text-muted" aria-label="Sent" />
    : null

  let body
  if (last.deleted) body = <span className="truncate italic">Message deleted</span>
  else if (last.kind === 'voice')
    body = (
      <>
        <Mic size={14} className="shrink-0 text-accent-ink" aria-hidden />
        <span className="truncate">Voice message {duration(last.voice?.durationSec ?? 0)}</span>
      </>
    )
  else if (last.kind === 'file')
    body = (
      <>
        <Paperclip size={14} className="shrink-0" aria-hidden />
        <span className="truncate">{last.file?.name ?? 'File'}</span>
      </>
    )
  else if (last.kind === 'notes') {
    const s = state.sessions.find(x => x.id === last.sessionId)
    body = (
      <>
        <NotebookText size={14} className="shrink-0 text-agent" aria-hidden />
        <span className="truncate">Meeting notes · {s?.title ?? 'Session'}</span>
      </>
    )
  } else if (last.kind === 'suggest') {
    const agent = personById[last.suggestion?.agentId ?? '']
    body = (
      <>
        <Bot size={14} className="shrink-0 text-agent" aria-hidden />
        <span className="truncate">{agent?.short ?? 'An agent'} has an answer</span>
      </>
    )
  } else if (last.kind === 'system') body = <span className="truncate">{last.text}</span>
  else body = <span className="truncate">{firstLine}</span>

  return (
    <>
      {ticks}
      {prefix && <span className="shrink-0">{prefix}</span>}
      {body}
    </>
  )
}
