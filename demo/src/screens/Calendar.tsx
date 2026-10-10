// Calendar (CAL-01..10): an agenda for the demo week, a 5-day grid on desktop,
// event details with the assistant's prep brief (PA-06), join rules for the
// meeting room, and a static "Find a time" helper (CAL-04).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { CalendarClock, CalendarSearch, Check, Clock, DoorOpen, HelpCircle, ListChecks, MapPin, Mic, Palmtree, PlayCircle, Plus, Users, X } from 'lucide-react'
import type { CalendarEvent, Session } from '../types'
import { useStore } from '../store'
import { ME } from '../data/people'
import { AIMarker, Avatar, AvatarStack, Button, cx, personName, Pill, ScreenHeader, SectionTitle, Sheet, SourceChips } from '../ui'
import { at, clock, longDay, sameDay, shortDay } from '../time'

const DAYS = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'].map(d => at(`${d}T00:00`))
const GRID_START = 8
const GRID_END = 18
const HOUR_PX = 56

const range = (e: CalendarEvent) => `${clock(e.start)} – ${clock(e.end)}`
/** The meeting's recording, once it has one. The Ops standup gets one when it wraps up, before its end time. */
const sessionOf = (e: CalendarEvent, sessions: Session[]) => sessions.find(s => s.id === e.sessionId || s.meetingId === e.id)
const isOver = (e: CalendarEvent, now: number, sessions: Session[]) => e.end <= now || !!sessionOf(e, sessions)
const isLive = (e: CalendarEvent, now: number, sessions: Session[]) => e.kind !== 'leave' && e.start <= now && !isOver(e, now, sessions)
const canJoin = (e: CalendarEvent, now: number, sessions: Session[]) => !!e.roomId && !isOver(e, now, sessions) && e.start - now <= 5 * 60_000
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const isLeave = (e: CalendarEvent) => e.kind === 'leave'

function useWide() {
  const q = '(min-width: 768px)'
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches)
  useEffect(() => {
    const mq = window.matchMedia(q)
    const on = () => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return wide
}

export default function CalendarScreen() {
  const { state } = useStore()
  const wide = useWide()
  const [findOpen, setFindOpen] = useState(false)
  // Stable, so the Sheet's focus effect doesn't rerun on every clock tick.
  const closeFind = useCallback(() => setFindOpen(false), [])
  const eventId = state.route.name === 'calendar' ? state.route.eventId : undefined
  const event = state.events.find(e => e.id === eventId)

  if (!wide) {
    return (
      <>
        {event ? <EventDetail event={event} onFindTime={() => setFindOpen(true)} /> : <Agenda onFindTime={() => setFindOpen(true)} />}
        <FindTimeSheet open={findOpen} onClose={closeFind} attendees={event?.attendees} />
      </>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <WeekHeader onFindTime={() => setFindOpen(true)} />
        <WeekGrid selectedId={event?.id} />
      </div>
      <aside className="flex w-[380px] shrink-0 flex-col border-l border-line bg-surface lg:w-[420px]">
        {event ? <EventDetail event={event} onFindTime={() => setFindOpen(true)} /> : <Agenda compact onFindTime={() => setFindOpen(true)} />}
      </aside>
      <FindTimeSheet open={findOpen} onClose={closeFind} attendees={event?.attendees} />
    </div>
  )
}

function useNewEvent() {
  const { toast } = useStore()
  return () => toast('Event creation comes later in the demo')
}

// ── Desktop week grid ─────────────────────────────────────────────────────────
function WeekHeader({ onFindTime }: { onFindTime: () => void }) {
  const newEvent = useNewEvent()
  return (
    <div className="flex items-center gap-3 border-b border-line px-6 py-4">
      <div className="min-w-0 flex-1">
        <h1 className="font-display text-2xl font-semibold">Calendar</h1>
        <p className="text-sm text-muted">This week · 12 – 16 October</p>
      </div>
      <Button size="sm" variant="secondary" icon={<CalendarSearch size={15} />} onClick={onFindTime}>Find a time</Button>
      <Button size="sm" variant="primary" icon={<Plus size={15} />} onClick={newEvent}>New event</Button>
    </div>
  )
}

function WeekGrid({ selectedId }: { selectedId?: string }) {
  const { state, navigate } = useStore()
  const now = state.clock
  const hours = Array.from({ length: GRID_END - GRID_START }, (_, i) => GRID_START + i)
  const leaves = state.events.filter(isLeave)

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="min-w-[640px] px-4 pb-6">
        {/* day headers + all-day row */}
        <div className="sticky top-0 z-10 grid grid-cols-[52px_repeat(5,minmax(0,1fr))] bg-bg pt-3">
          <div />
          {DAYS.map(d => {
            const today = sameDay(d, now)
            return (
              <div key={d} className="px-1 pb-2 text-center">
                <p className={cx('text-[11px] font-bold uppercase tracking-[0.08em]', today ? 'text-accent-ink' : 'text-muted')}>{shortDay(d).replace(',', '').split(' ')[0]}</p>
                <p className={cx('mx-auto mt-0.5 grid size-8 place-items-center rounded-full font-display text-lg font-semibold tabular', today && 'bg-accent text-accent-fg')}>{shortDay(d).replace(',', '').split(' ')[1]}</p>
              </div>
            )
          })}
          <div className="py-1 pr-2 text-right text-[10px] text-muted">all day</div>
          {DAYS.map(d => (
            <div key={d} className="min-h-7 border-b border-line px-0.5 pb-1">
              {leaves.filter(e => sameDay(e.start, d)).map(e => (
                <button key={e.id} onClick={() => navigate({ name: 'calendar', eventId: e.id })} className={cx('flex w-full min-w-0 items-center gap-1 rounded-md bg-surface-2 px-2 py-0.5 text-left text-xs text-muted hover:text-fg', selectedId === e.id && 'ring-2 ring-accent')}>
                  <Palmtree size={12} className="shrink-0" aria-hidden /><span className="truncate">{e.title}</span>
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="relative grid grid-cols-[52px_repeat(5,minmax(0,1fr))]" style={{ height: hours.length * HOUR_PX }}>
          <div className="relative">
            {hours.map((h, i) => (
              <span key={h} className="absolute right-2 -translate-y-1/2 text-[10px] text-muted tabular" style={{ top: i * HOUR_PX }}>
                {i === 0 ? '' : `${h > 12 ? h - 12 : h} ${h >= 12 ? 'pm' : 'am'}`}
              </span>
            ))}
          </div>
          {DAYS.map(d => {
            const today = sameDay(d, now)
            const nowTop = ((now - d) / 3_600_000 - GRID_START) * HOUR_PX
            const dayEvents = state.events.filter(e => !isLeave(e) && sameDay(e.start, d))
            return (
              <div key={d} className={cx('relative border-l border-line', today && 'bg-accent-soft/30')}>
                {hours.map((h, i) => <div key={h} className="absolute inset-x-0 border-t border-line" style={{ top: i * HOUR_PX }} />)}
                {dayEvents.map(e => {
                  const startH = (e.start - d) / 3_600_000
                  const top = (startH - GRID_START) * HOUR_PX
                  const height = Math.max(24, ((e.end - e.start) / 3_600_000) * HOUR_PX - 3)
                  const live = isLive(e, now, state.sessions)
                  const pending = e.rsvp === 'pending'
                  const short = height < 40
                  return (
                    <button
                      key={e.id}
                      onClick={() => navigate({ name: 'calendar', eventId: e.id })}
                      className={cx(
                        'absolute inset-x-1 z-[2] flex min-w-0 overflow-hidden rounded-lg border-l-[3px] px-2 text-left text-xs transition hover:brightness-95',
                        short ? 'items-center gap-1.5' : 'flex-col py-1',
                        live ? 'border-rec bg-rec-soft text-fg' : pending ? 'border-dashed border-accent bg-surface text-fg outline outline-1 -outline-offset-1 outline-line' : 'border-accent bg-accent-soft text-fg',
                        selectedId === e.id && 'ring-2 ring-accent',
                      )}
                      style={{ top: top + 1, height }}
                    >
                      <span className={cx('flex min-w-0 items-center gap-1.5 font-semibold', short && 'max-w-full shrink-0')}>
                        {live && <span className="size-1.5 shrink-0 rounded-full bg-rec anim-pulse" aria-hidden />}
                        <span className="truncate">{e.title}</span>
                      </span>
                      <span className="min-w-0 truncate text-[11px] text-muted">{live ? 'Now' : clock(e.start)}{pending && ' · reply needed'}</span>
                    </button>
                  )
                })}
                {today && nowTop > 0 && nowTop < hours.length * HOUR_PX && (
                   <div className="pointer-events-none absolute inset-x-0 flex items-center" style={{ top: nowTop }} aria-hidden>
                    <span className="-ml-1 size-2 rounded-full bg-rec" />
                    <span className="h-px flex-1 bg-rec" />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Agenda ────────────────────────────────────────────────────────────────────
function Agenda({ compact, onFindTime }: { compact?: boolean; onFindTime: () => void }) {
  const { state } = useStore()
  const newEvent = useNewEvent()
  const now = state.clock
  const todayRef = useRef<HTMLElement>(null)

  return (
    <div className="h-full overflow-y-auto">
      <div className={cx('mx-auto w-full', compact ? 'px-4 py-4' : 'max-w-3xl px-4 py-4 sm:px-6')}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          {compact ? <h2 className="font-display text-lg font-semibold">Agenda</h2> : <p className="text-sm text-muted">This week · 12 – 16 October</p>}
          {!compact && (
            <div className="flex gap-1.5">
              <Button size="sm" variant="secondary" icon={<CalendarSearch size={15} />} onClick={onFindTime}>Find a time</Button>
              <Button size="sm" variant="primary" icon={<Plus size={15} />} onClick={newEvent}>New event</Button>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-5">
          {DAYS.map(d => {
            const today = sameDay(d, now)
            const dayEvents = state.events.filter(e => sameDay(e.start, d)).sort((a, b) => Number(isLeave(b)) - Number(isLeave(a)) || a.start - b.start)
            return (
              <section key={d} ref={today ? todayRef : undefined} aria-label={longDay(d)}>
                <h3 className={cx('mb-1 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.08em]', today ? 'text-accent-ink' : 'text-muted')}>
                  {today && <span className="rounded-full bg-accent px-1.5 py-px text-[10px] text-accent-fg">Today</span>}
                  {shortDay(d)}
                </h3>
                {dayEvents.length === 0 ? (
                  <p className="border-y border-line py-3 text-sm text-muted">No meetings</p>
                ) : (
                  <ul className="divide-y divide-line border-y border-line">
                    {dayEvents.map(e => <AgendaRow key={e.id} event={e} />)}
                  </ul>
                )}
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function AgendaRow({ event: e }: { event: CalendarEvent }) {
  const { state, navigate, joinRoom, rsvp, toast } = useStore()
  const now = state.clock
  const live = isLive(e, now, state.sessions)
  const past = isOver(e, now, state.sessions)
  const ended = e.end > now && past // wrapped up early, recording saved
  const session = ended ? sessionOf(e, state.sessions) : undefined
  const open = () => navigate({ name: 'calendar', eventId: e.id })

  if (isLeave(e)) {
    return (
      <li>
        <button onClick={open} className="my-2 flex w-full items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-left text-sm text-muted hover:text-fg">
          <Palmtree size={15} className="shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{e.title}</span>
          <span className="shrink-0 text-xs">All day</span>
        </button>
      </li>
    )
  }

  return (
    <li className={cx('flex items-start gap-3 py-3', past && 'opacity-60')}>
      <div className="w-[68px] shrink-0 pt-0.5 text-xs tabular">
        {live ? <span className="inline-flex items-center gap-1 font-bold text-rec"><span className="size-1.5 rounded-full bg-rec anim-pulse" aria-hidden />Now</span> : <span className="font-semibold">{clock(e.start)}</span>}
        <p className="text-muted">{clock(e.end)}</p>
      </div>
      <div className="min-w-0 flex-1">
        <button onClick={open} className="block max-w-full truncate rounded text-left font-medium hover:underline">{e.title}</button>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
          <AvatarStack ids={e.attendees} max={4} size="xs" />
          {e.prep && <Pill tone="agent">Prep brief ready</Pill>}
          {e.rsvp === 'pending' && <Pill tone="warn">Reply needed</Pill>}
        </div>
        {e.rsvp === 'pending' && (
          <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={`Reply to ${e.title}`}>
            {(['yes', 'maybe', 'no'] as const).map(r => (
              <Button key={r} size="sm" variant={r === 'yes' ? 'primary' : 'secondary'} onClick={() => { rsvp(e.id, r); toast(`Replied “${rsvpWord[r]}”`) }}>{rsvpWord[r]}</Button>
            ))}
          </div>
        )}
      </div>
      {canJoin(e, now, state.sessions) && (
        <Button size="sm" variant="danger" icon={<Mic size={14} />} onClick={() => { joinRoom(e.roomId!); navigate({ name: 'rooms', roomId: e.roomId }) }}>Join</Button>
      )}
      {session && (
        <Button size="sm" variant="secondary" icon={<PlayCircle size={14} />} onClick={() => navigate({ name: 'session', sessionId: session.id })}>View notes</Button>
      )}
    </li>
  )
}

// Example replies from other attendees (everyone else defaults to "Going").
const otherReplies: Record<string, Record<string, CalendarEvent['rsvp']>> = {
  e_q4: { u_weiling: 'maybe' },
  e_allhands: { u_kelvin: 'maybe', u_arjun: 'pending', u_nadia: 'pending' },
}

const rsvpWord = { yes: 'Going', maybe: 'Maybe', no: 'Not going', pending: 'No reply yet' } as const

// ── Event detail ──────────────────────────────────────────────────────────────
function EventDetail({ event: e, onFindTime }: { event: CalendarEvent; onFindTime: () => void }) {
  const { state, navigate, joinRoom, rsvp, toast } = useStore()
  const now = state.clock
  const live = isLive(e, now, state.sessions)
  const past = isOver(e, now, state.sessions)
  const joinable = canJoin(e, now, state.sessions)
  const room = state.rooms.find(r => r.id === e.roomId)
  const session = sessionOf(e, state.sessions)
  // Other attendees' replies are example data; mine comes from the store.
  const replyOf = (id: string): CalendarEvent['rsvp'] => (id === ME ? e.rsvp : otherReplies[e.id]?.[id] ?? 'yes')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScreenHeader
        back={() => navigate({ name: 'calendar' })}
        title={e.title}
        subtitle={isLeave(e) ? `${shortDay(e.start)} · All day` : `${shortDay(e.start)} · ${range(e)}`}
        className="md:min-h-16"
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-5 sm:px-5">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {live && <Pill tone="rec" icon={<span className="size-1.5 rounded-full bg-rec anim-pulse" />}>Happening now</Pill>}
              {past && <Pill>Finished</Pill>}
              {isLeave(e) && <Pill icon={<Palmtree size={11} />}>Leave</Pill>}
            </div>
            <p className="flex items-center gap-2 text-sm"><Clock size={15} className="shrink-0 text-muted" aria-hidden />{longDay(e.start)}{!isLeave(e) && `, ${range(e)}`}</p>
            {room && <p className="flex items-center gap-2 text-sm"><MapPin size={15} className="shrink-0 text-muted" aria-hidden />Voice room · {room.name}</p>}
          </div>

          {/* Join */}
          {room && !past && (
            <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-3">
              <span className={cx('grid size-10 shrink-0 place-items-center rounded-xl', joinable ? 'bg-rec-soft text-rec' : 'bg-surface-2 text-muted')}><DoorOpen size={20} /></span>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{room.name}</p>
                <p className="text-xs text-muted">
                  {room.participants.length >= 2 ? `${room.participants.length} people inside · recorded and transcribed` : joinable ? 'Recorded and transcribed once 2 people are in' : 'Join opens 5 minutes before'}
                </p>
              </div>
              <Button variant={joinable ? 'danger' : 'secondary'} disabled={!joinable} icon={<Mic size={16} />} onClick={() => { joinRoom(room.id); navigate({ name: 'rooms', roomId: room.id }) }}>
                Join
              </Button>
            </div>
          )}

          {/* My reply */}
          {!past && !isLeave(e) && (
            <div>
              <SectionTitle>Your reply</SectionTitle>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Your reply">
                {(['yes', 'maybe', 'no'] as const).map(r => (
                  <Button key={r} size="sm" variant={e.rsvp === r ? 'primary' : 'secondary'} aria-pressed={e.rsvp === r} icon={e.rsvp === r ? <Check size={14} /> : undefined} onClick={() => { rsvp(e.id, r); toast(`Replied “${rsvpWord[r]}”`) }}>{rsvpWord[r]}</Button>
                ))}
              </div>
            </div>
          )}

          {/* Session from a past meeting */}
          {session && (
            <button onClick={() => navigate({ name: 'session', sessionId: session.id })} className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3 text-left transition hover:border-muted">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-ink"><PlayCircle size={20} /></span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">Recording, transcript and notes</span>
                <span className="block text-xs text-muted">{session.title} · {Math.round(session.durationSec / 60)} min{session.notes ? ' · notes ready' : ''}</span>
              </span>
            </button>
          )}

          {/* Prep brief (PA-06) */}
          {e.prep && !past && (
            <section className="rounded-2xl border border-agent/30 bg-agent-soft/40 p-4" aria-labelledby="prep-title">
              <div className="mb-2 flex items-center gap-2">
                <h2 id="prep-title" className="font-display text-base font-semibold">Prep brief</h2>
                <AIMarker label="Assistant" />
              </div>
              <p className="mb-3 text-sm text-muted">From what you can open: the documents, messages and meetings these attendees share.</p>
              <div className="flex flex-col gap-4 text-sm">
                <div>
                  <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-muted">Read before</p>
                  <SourceChips sources={e.prep.related} />
                </div>
                {e.prep.openItems.length > 0 && (
                  <div>
                    <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-muted">Open items between attendees</p>
                    <ul className="flex flex-col gap-1.5">
                      {e.prep.openItems.map((o, i) => (
                        <li key={i} className="flex gap-2"><ListChecks size={15} className="mt-0.5 shrink-0 text-agent" aria-hidden />{o}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {e.prep.lastNotes && (
                  <div>
                    <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-muted">Last time</p>
                    <p>{cap(e.prep.lastNotes.replace(/^Last time \([^)]*\):\s*/, ''))}</p>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Agenda */}
          {e.agenda.length > 0 && (
            <section>
              <SectionTitle>Agenda</SectionTitle>
              <ol className="flex flex-col divide-y divide-line border-y border-line">
                {e.agenda.map((a, i) => (
                  <li key={i} className="flex gap-3 py-2 text-sm"><span className="w-4 shrink-0 text-right text-muted tabular">{i + 1}</span>{a}</li>
                ))}
              </ol>
            </section>
          )}

          {/* Attendees */}
          <section>
            <SectionTitle count={e.attendees.length} action={!past && !isLeave(e) ? <Button size="sm" variant="ghost" icon={<CalendarSearch size={14} />} onClick={onFindTime}>Find a time</Button> : undefined}>
              {isLeave(e) ? 'Who' : 'Attendees'}
            </SectionTitle>
            <ul className="flex flex-col divide-y divide-line border-y border-line">
              {e.attendees.map(id => {
                const r = replyOf(id)
                return (
                  <li key={id} className="flex items-center gap-3 py-2">
                    <Avatar id={id} size="sm" status />
                    <span className="min-w-0 flex-1 truncate text-sm">{id === ME ? 'You' : personName(id)}</span>
                    {!isLeave(e) && <RsvpTag r={r} />}
                  </li>
                )
              })}
            </ul>
          </section>
        </div>
      </div>
    </div>
  )
}

function RsvpTag({ r }: { r: CalendarEvent['rsvp'] }) {
  const map: Record<CalendarEvent['rsvp'], { icon: ReactNode; cls: string }> = {
    yes: { icon: <Check size={12} />, cls: 'text-ok' },
    maybe: { icon: <HelpCircle size={12} />, cls: 'text-warn' },
    no: { icon: <X size={12} />, cls: 'text-rec' },
    pending: { icon: <CalendarClock size={12} />, cls: 'text-muted' },
  }
  return <span className={cx('inline-flex shrink-0 items-center gap-1 text-xs font-medium', map[r].cls)}>{map[r].icon}{rsvpWord[r]}</span>
}

// ── Find a time (CAL-04) ──────────────────────────────────────────────────────
const SLOTS = [
  { start: at('2026-10-13T14:00'), end: at('2026-10-13T14:30'), note: 'Everyone free' },
  { start: at('2026-10-14T09:30'), end: at('2026-10-14T10:00'), note: 'Everyone free · before Wei Ling’s month-end close' },
  { start: at('2026-10-15T16:00'), end: at('2026-10-15T16:30'), note: 'Everyone free · Daniel is on leave the day after' },
]

function FindTimeSheet({ open, onClose, attendees }: { open: boolean; onClose: () => void; attendees?: string[] }) {
  const { toast } = useStore()
  const ids = attendees?.length ? attendees : [ME, 'u_priya', 'u_daniel', 'u_ahmad']
  return (
    <Sheet open={open} onClose={onClose} title="Find a time">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2 text-sm text-muted">
          <Users size={15} className="shrink-0" aria-hidden />
          <AvatarStack ids={ids} max={6} size="xs" />
          <span className="min-w-0 truncate">{ids.length} people · 30 minutes · working hours</span>
        </div>
        {ids.length > 5 && <p className="text-xs text-muted">Large group: showing the closest times when most people are free.</p>}
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {SLOTS.map(s => (
            <li key={s.start} className="flex items-center gap-3 py-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-ok-soft text-ok"><CalendarClock size={18} /></span>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{shortDay(s.start)}, {clock(s.start)} – {clock(s.end)}</p>
                <p className="text-xs text-muted">{s.note}</p>
              </div>
              <Button size="sm" variant="secondary" onClick={() => { onClose(); toast('Event creation comes later in the demo') }}>Pick</Button>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted">Based on everyone’s calendar free and busy times only. Event titles stay private.</p>
      </div>
    </Sheet>
  )
}

