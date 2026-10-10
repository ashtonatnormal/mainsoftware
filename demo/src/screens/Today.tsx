// Today (PA-04, PA-05, PA-06, J1): the assistant's morning view. Everything the
// assistant shows here is a suggestion: drafts go into the composer, suggested
// tasks need a tap to accept, and nothing is sent on the user's behalf.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AtSign, CalendarClock, Check, ChevronDown, ChevronRight, CircleCheckBig, FileSearch, Hash, ListChecks, MessageSquareReply, Mic, MonitorUp, PenLine, Plus, Search, Sparkles, Users, X } from 'lucide-react'
import { useStore } from '../store'
import type { Actionable, CalendarEvent, Conversation, Room, SourceRef, SuggestedTask, Task, TaskSource } from '../types'
import { ASSISTANT, ME } from '../data/people'
import { digest } from '../data/work'
import { AIMarker, Avatar, AvatarStack, Button, cx, IconButton, personShort, RecordingIndicator, SectionTitle, SourceChips } from '../ui'
import { clock, longDay, sameDay } from '../time'
import { conversationLabel } from './ask/search'

const hourFmt = new Intl.DateTimeFormat('en-SG', { timeZone: 'Asia/Singapore', hour: 'numeric', hourCycle: 'h23' })
function greeting(ms: number) {
  const h = Number(hourFmt.format(ms))
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

const kindMeta: Record<Actionable['kind'], { icon: typeof ListChecks; label: string }> = {
  reply: { icon: MessageSquareReply, label: 'Reply owed' },
  'action-item': { icon: ListChecks, label: 'Action item' },
  prep: { icon: CalendarClock, label: 'Meeting prep' },
  review: { icon: FileSearch, label: 'Review requested' },
  mention: { icon: AtSign, label: 'Mentioned you' },
}

const listBox = 'overflow-hidden rounded-2xl border border-line bg-surface'
const rowDivider = (i: number) => cx(i > 0 && 'border-t border-line')

function inLabel(ms: number) {
  const m = Math.max(1, Math.round(ms / 60_000))
  if (m < 60) return `in ${m} min`
  const h = Math.floor(m / 60)
  const r = m % 60
  return r ? `in ${h} h ${r} min` : `in ${h} h`
}

/** "Today 12:00 pm" → "Due by 12:00 pm"; "Today" → "Due today". */
function dueLabel(due: string) {
  const time = due.replace(/^Today\s*/, '')
  return time ? `Due by ${time}` : 'Due today'
}

function taskSourceRef(s: TaskSource, conversations: Conversation[]): SourceRef[] {
  const route = s.route
  if (!route) return []
  const kind: SourceRef['kind'] = route.name === 'session' ? 'session' : route.name === 'docs' ? 'doc' : route.name === 'calendar' ? 'event' : route.name === 'tasks' ? 'task' : 'message'
  // The section is already marked as the assistant's suggestion, so a chat
  // source only needs to say which chat ("DM with Priya"), not the long label.
  let label = s.label
  if (route.name === 'chats' && s.kind === 'assistant') {
    const conv = conversations.find(c => c.id === route.conversationId)
    if (conv) label = conv.kind === 'dm' ? `DM with ${personShort(conv.members.find(m => m !== ME) ?? '')}` : conversationLabel(conv)
  }
  return [{ label, kind, route }]
}

export default function TodayScreen() {
  const { state, navigate } = useStore()
  const now = state.clock
  const n = state.actionables.length

  return (
    <div className="h-full overflow-y-auto">
      {/* Phone: one column, ordered by urgency. Desktop: main column + side column. */}
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-7 px-4 pt-5 pb-28 sm:px-6 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)] lg:items-start lg:gap-x-10 lg:px-8 lg:pt-8">
        <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-8">
          <section className="order-1" aria-labelledby="today-hello">
            <h1 id="today-hello" className="font-display text-[30px] leading-tight font-semibold tracking-tight sm:text-4xl">
              {greeting(now)}, {personShort(ME)}
            </h1>
            <p className="mt-1 text-sm text-muted">{longDay(now)}</p>
            <div className="mt-4 flex items-center gap-2.5">
              <Avatar id={ASSISTANT} size="sm" />
              <p className="min-w-0 text-[15px]">
                <span className="font-semibold">{n === 0 ? 'Nothing needs you right now' : `${n} ${n === 1 ? 'thing needs' : 'things need'} you`}</span>
                {n > 0 && <span className="text-muted"> today</span>}
              </p>
              <AIMarker />
            </div>
            <button
              onClick={() => navigate({ name: 'ask' })}
              className="mt-4 flex h-11 w-full items-center gap-2.5 rounded-full border border-line bg-surface px-4 text-left text-sm text-muted transition hover:border-muted md:hidden"
            >
              <Search size={16} aria-hidden />
              <span className="min-w-0 flex-1 truncate">Ask or search anything at Tembusu…</span>
              <Sparkles size={14} className="text-agent" aria-hidden />
            </button>
          </section>

          <NeedsYou />
          <Digest />
        </div>

        <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-8">
          <UpNext />
          <LiveNow />
          <DueToday />
          <Suggested />
        </div>
      </div>
    </div>
  )
}

// ── Needs you (PA-04) ────────────────────────────────────────────────────────
function NeedsYou() {
  const { state } = useStore()
  const items = state.actionables
  return (
    <section className="order-2" aria-labelledby="needs-title">
      <SectionTitle count={items.length || undefined}>
        <span id="needs-title">Needs you</span>
      </SectionTitle>
      {items.length === 0 ? (
        <div className={cx(listBox, 'anim-in')}>
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <span className="mb-1 grid size-12 place-items-center rounded-full bg-ok-soft text-ok"><CircleCheckBig size={24} aria-hidden /></span>
            <p className="font-display text-lg font-semibold">You’re all caught up</p>
            <p className="max-w-sm text-sm text-muted">Your assistant will add replies, action items and reviews here as they come in.</p>
          </div>
        </div>
      ) : (
        <ul className={listBox}>
          {items.map((a, i) => (
            <ActionableRow key={a.id} item={a} className={rowDivider(i)} />
          ))}
        </ul>
      )}
    </section>
  )
}

function ActionableRow({ item, className }: { item: Actionable; className?: string }) {
  const { state, navigate, useDraft: applyDraft, dismissActionable } = useStore()
  const [open, setOpen] = useState(false)
  // Only offer "Show all" when the two-line preview actually cuts the draft off.
  const draftRef = useRef<HTMLParagraphElement>(null)
  const openRef = useRef(open)
  openRef.current = open
  const [clipped, setClipped] = useState(false)
  useLayoutEffect(() => {
    const el = draftRef.current
    if (!el) return
    const check = () => {
      if (!openRef.current) setClipped(el.scrollHeight > el.clientHeight + 1)
    }
    check()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const meta = kindMeta[item.kind]
  const Icon = meta.icon
  const conv = item.draft ? state.conversations.find(c => c.id === item.draft!.conversationId) : undefined
  const to = conv?.kind === 'dm' ? personShort(conv.members.find(m => m !== ME) ?? '') : conversationLabel(conv)

  return (
    <li className={cx('flex gap-3 px-4 py-4', className)}>
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-ink">
        <Icon size={18} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-muted">{meta.label}</p>
            <h3 className="leading-snug font-semibold">{item.title}</h3>
          </div>
          <IconButton label={`Dismiss: ${item.title}`} className="-mt-1.5 -mr-2 size-9 text-muted" onClick={() => dismissActionable(item.id)}>
            <X size={16} />
          </IconButton>
        </div>
        <p className="mt-1 text-sm text-muted">{item.detail}</p>

        {item.draft && (
          <div className="mt-3 rounded-xl border-l-[3px] border-agent bg-surface-2 py-2.5 pr-3 pl-3">
            <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              <AIMarker label="Draft" />
              <span className="min-w-0">Reply to {to} · you edit and send it</span>
            </div>
            <p ref={draftRef} id={`draft-${item.id}`} className={cx('text-sm text-fg', !open && 'line-clamp-2')}>
              {item.draft.text}
            </p>
            {(clipped || open) && (
              <button
                onClick={() => setOpen(o => !o)}
                aria-expanded={open}
                aria-controls={`draft-${item.id}`}
                className="mt-1 inline-flex items-center gap-0.5 rounded-full text-xs font-medium text-agent hover:underline"
              >
                {open ? 'Show less' : 'Show the full draft'}
                <ChevronDown size={14} className={cx('transition', open && 'rotate-180')} aria-hidden />
              </button>
            )}
          </div>
        )}

        {!!item.sources?.length && (
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <span className="text-xs text-muted">Based on</span>
            <SourceChips sources={item.sources} numbered={false} />
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          {item.draft && (
            <Button size="sm" variant="primary" icon={<PenLine size={14} aria-hidden />} onClick={() => applyDraft(item.id)}>
              Reply with draft
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => navigate(item.route)}>
            {item.kind === 'prep' ? 'Open brief' : 'Open'}
          </Button>
        </div>
      </div>
    </li>
  )
}

// ── Since you were last here (PA-05) ─────────────────────────────────────────
function Digest() {
  const { state, navigate } = useStore()
  const rows = digest.map(d => ({ ...d, conv: state.conversations.find(c => c.id === d.conversationId) })).filter(d => d.conv)
  if (!rows.length) return null
  return (
    <section className="order-4" aria-labelledby="digest-title">
      <SectionTitle action={<AIMarker label="Summary" />}>
        <span id="digest-title">Since you were last here</span>
      </SectionTitle>
      <ul className={listBox}>
        {rows.map((d, i) => {
          const unread = d.conv!.unread
          return (
            <li key={d.id} className={rowDivider(i)}>
              <button onClick={() => navigate({ name: 'chats', conversationId: d.conversationId })} className="flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-surface-2">
                <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-muted">
                  <Hash size={16} aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 truncate font-semibold">{conversationLabel(d.conv).replace(/^#/, '')}</span>
                    <span className={cx('shrink-0 text-xs tabular', unread ? 'font-semibold text-accent-ink' : 'text-muted')}>
                      {unread ? `${unread} new` : 'Read'}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-sm text-muted">{d.text}</span>
                </span>
                <ChevronRight size={16} className="mt-2.5 shrink-0 text-muted" aria-hidden />
              </button>
            </li>
          )
        })}
      </ul>
      <p className="mt-2 px-1 text-xs text-muted">Summarised by your assistant from each channel. Open one to read the messages.</p>
    </section>
  )
}

// ── Up next (calendar, PA-06 prep) ───────────────────────────────────────────
function UpNext() {
  const { state, navigate } = useStore()
  const now = state.clock
  const roomLive = (id?: string) => (state.rooms.find(r => r.id === id)?.participants.length ?? 0) >= 2
  const isLive = (e: CalendarEvent) => e.start <= now && (now < e.end || roomLive(e.roomId))
  const upcoming = state.events
    .filter(e => e.kind !== 'leave' && sameDay(e.start, now) && (e.end > now || isLive(e)))
    .sort((a, b) => a.start - b.start)

  return (
    <section className="order-3" aria-labelledby="upnext-title">
      <SectionTitle action={<LinkButton onClick={() => navigate({ name: 'calendar' })}>Calendar</LinkButton>}>
        <span id="upnext-title">Up next</span>
      </SectionTitle>
      {upcoming.length === 0 ? (
        <Quiet>Nothing else on your calendar today.</Quiet>
      ) : (
        <ul className={listBox}>
          {upcoming.map((e, i) => (
            <EventRow key={e.id} ev={e} live={isLive(e)} className={rowDivider(i)} />
          ))}
        </ul>
      )}
    </section>
  )
}

function EventRow({ ev, live, className }: { ev: CalendarEvent; live: boolean; className?: string }) {
  const { state, navigate, joinRoom } = useStore()
  const room = state.rooms.find(r => r.id === ev.roomId)
  const inRoom = !!ev.roomId && state.myRoomId === ev.roomId
  const joinable = !!ev.roomId && (live || ev.start - state.clock <= 5 * 60_000)
  const [time, ampm] = clock(ev.start).split(' ')
  const others = room?.participants.filter(p => p !== ME) ?? []

  return (
    <li className={cx('flex gap-3 px-4 py-3', live && 'bg-rec-soft/40', className)}>
      <div className="w-12 shrink-0 pt-0.5 text-center leading-tight">
        {live ? (
          <>
            <span className="block text-sm font-bold text-rec">Now</span>
            <span className="block text-[11px] text-muted tabular">{time}</span>
          </>
        ) : (
          <>
            <span className="block text-sm font-semibold tabular">{time}</span>
            <span className="block text-[11px] text-muted">{ampm}</span>
          </>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <button onClick={() => navigate({ name: 'calendar', eventId: ev.id })} className="block max-w-full truncate text-left font-semibold hover:underline">
          {ev.title}
        </button>
        <p className="truncate text-xs text-muted">
          {clock(ev.start)} – {clock(ev.end)}
          {!live && ` · ${inLabel(ev.start - state.clock)}`}
        </p>
        {live && room && (
          <p className="mt-1 flex min-w-0 items-center gap-2">
            <RecordingIndicator compact />
            <span className="truncate text-xs text-muted">
              {inRoom ? `You and ${others.length} others` : `${others.length} in the room`}
            </span>
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <AvatarStack ids={ev.attendees} max={4} size="sm" />
          <span className="flex-1" />
          {joinable && (
            <Button
              size="sm"
              variant={inRoom ? 'secondary' : live ? 'primary' : 'secondary'}
              icon={<Mic size={14} aria-hidden />}
              onClick={() => {
                if (!inRoom) joinRoom(ev.roomId!)
                navigate({ name: 'rooms', roomId: ev.roomId })
              }}
            >
              {inRoom ? 'Back to room' : 'Join'}
            </Button>
          )}
          {ev.prep && (
            <Button size="sm" variant="agent" icon={<Sparkles size={14} aria-hidden />} onClick={() => navigate({ name: 'calendar', eventId: ev.id })}>
              Prep brief
            </Button>
          )}
        </div>
      </div>
    </li>
  )
}

// ── Live now (rooms with 2+ people) ──────────────────────────────────────────
function LiveNow() {
  const { state, navigate } = useStore()
  const live = state.rooms.filter(r => r.participants.length >= 2)
  return (
    <section className="order-5" aria-labelledby="live-title">
      <SectionTitle count={live.length || undefined} action={<LinkButton onClick={() => navigate({ name: 'rooms' })}>All rooms</LinkButton>}>
        <span id="live-title">Live now</span>
      </SectionTitle>
      {live.length === 0 ? (
        <Quiet>No rooms are live right now.</Quiet>
      ) : (
        <ul className={listBox}>
          {live.map((r, i) => (
            <RoomRow key={r.id} room={r} className={rowDivider(i)} />
          ))}
        </ul>
      )}
    </section>
  )
}

function RoomRow({ room, className }: { room: Room; className?: string }) {
  const { state, navigate, joinRoom } = useStore()
  const inRoom = state.myRoomId === room.id
  const channel = state.conversations.find(c => c.id === room.conversationId)
  return (
    <li className={cx('flex items-center gap-3 px-4 py-3', className)}>
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-rec-soft text-rec">
        {room.screenShareBy ? <MonitorUp size={17} aria-hidden /> : <Mic size={17} aria-hidden />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-semibold">{room.name}</span>
          {channel && <span className="truncate text-xs text-muted">{conversationLabel(channel)}</span>}
        </p>
        <p className="flex min-w-0 items-center gap-2">
          <RecordingIndicator compact />
          <span className="truncate text-xs text-muted">{room.participants.length} in the room</span>
        </p>
        <div className="mt-1.5 flex min-w-0 items-center gap-2">
          <AvatarStack ids={room.participants} max={5} size="sm" />
          {room.screenShareBy && <span className="min-w-0 truncate text-xs text-muted">{personShort(room.screenShareBy)} is sharing a screen</span>}
        </div>
      </div>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          if (!inRoom) joinRoom(room.id)
          navigate({ name: 'rooms', roomId: room.id })
        }}
        aria-label={inRoom ? `Back to ${room.name}` : `Join ${room.name}`}
      >
        {inRoom ? 'Open' : 'Join'}
      </Button>
    </li>
  )
}

// ── Tasks ────────────────────────────────────────────────────────────────────
function DueToday() {
  const { state, navigate, setTaskStatus } = useStore()
  // Ticked off on this screen: keep them visible (struck through) until you leave.
  const [ticked, setTicked] = useState<string[]>([])
  const due = state.tasks.filter(t => t.assigneeIds.includes(ME) && t.due?.includes('Today') && (t.status !== 'done' || ticked.includes(t.id)))
  const toggle = (t: Task) => {
    const done = t.status !== 'done'
    setTaskStatus(t.id, done ? 'done' : 'todo')
    setTicked(x => (done ? [...x, t.id] : x.filter(id => id !== t.id)))
  }
  return (
    <section className="order-6" aria-labelledby="due-title">
      <SectionTitle count={due.filter(t => t.status !== 'done').length || undefined} action={<LinkButton onClick={() => navigate({ name: 'tasks' })}>All tasks</LinkButton>}>
        <span id="due-title">Due today</span>
      </SectionTitle>
      {due.length === 0 ? (
        <Quiet>Nothing else is due today.</Quiet>
      ) : (
        <ul className={listBox}>
          {due.map((t, i) => {
            const done = t.status === 'done'
            return (
              <li key={t.id} className={cx('flex items-start gap-2 py-2.5 pr-4 pl-2', rowDivider(i))}>
                <button
                  role="checkbox"
                  aria-checked={done}
                  aria-label={`Done: ${t.title}`}
                  onClick={() => toggle(t)}
                  className="grid size-9 shrink-0 place-items-center rounded-full transition hover:bg-surface-2"
                >
                  <span className={cx('grid size-5 place-items-center rounded-full border-2 transition', done ? 'border-ok bg-ok text-surface' : t.dueSoon ? 'border-warn' : 'border-muted')}>
                    {done && <Check size={12} strokeWidth={3} aria-hidden />}
                  </span>
                </button>
                <button onClick={() => navigate({ name: 'tasks' })} className="min-w-0 flex-1 pt-1.5 text-left">
                  <span className={cx('block leading-snug font-medium', done && 'text-muted line-through')}>{t.title}</span>
                  <span className="mt-0.5 block text-xs text-muted">
                    <span className={cx(!done && t.dueSoon && 'font-semibold text-warn')}>{done ? 'Done' : dueLabel(t.due!)}</span>
                    {t.source && !done ? ` · ${t.source.label}` : ''}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function Suggested() {
  const { state, acceptSuggested, dismissSuggested } = useStore()
  const items = state.suggested.filter(s => s.ownerId === ME)
  if (!items.length) return null
  return (
    <section className="order-7" aria-labelledby="sugg-title">
      <SectionTitle count={items.length} action={<AIMarker label="Suggested" />}>
        <span id="sugg-title">Suggested tasks</span>
      </SectionTitle>
      <ul className={listBox}>
        {items.map((s: SuggestedTask, i) => (
          <li key={s.id} className={cx('px-4 py-3', rowDivider(i))}>
            <p className="leading-snug font-medium">{s.title}</p>
            {s.due && <p className="mt-0.5 text-xs text-muted">Due {s.due}</p>}
            {s.source.route ? (
              <div className="mt-2">
                <SourceChips sources={taskSourceRef(s.source, state.conversations)} numbered={false} />
              </div>
            ) : (
              <p className="mt-1 text-xs text-muted">{s.source.label}</p>
            )}
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" icon={<Plus size={14} aria-hidden />} onClick={() => acceptSuggested(s.id)}>
                Accept
              </Button>
              <Button size="sm" variant="ghost" onClick={() => dismissSuggested(s.id)} aria-label={`Dismiss suggestion: ${s.title}`}>
                Dismiss
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2 flex items-center gap-1.5 px-1 text-xs text-muted">
        <Users size={12} aria-hidden /> Only you see these until you accept them.
      </p>
    </section>
  )
}

// ── Small helpers ────────────────────────────────────────────────────────────
function LinkButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded-full px-2 py-0.5 text-xs font-medium text-accent-ink transition hover:bg-accent-soft">
      {children}
    </button>
  )
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="rounded-2xl border border-dashed border-line px-4 py-4 text-sm text-muted">{children}</p>
}
