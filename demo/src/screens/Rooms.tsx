// Rooms (ROOM-01..09, REC-01/05/06/07): Discord-style drop-in voice rooms.
// Route { name: 'rooms', roomId? }: the list, a pre-join panel with the recording
// notice, or the in-room view with the participant grid and controls.
import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Hand, Lock, MessageSquare, Mic, MicOff, MonitorUp, Pause, PhoneOff, Smile, Users, Video, VideoOff, Volume2, X } from 'lucide-react'
import { useStore } from '../store'
import type { Message, Room, Route } from '../types'
import { ME, ORG_NAME } from '../data/people'
import { Avatar, Button, cx, EmptyState, Page, personName, personShort, Pill, RecordingIndicator, ScreenHeader, SectionTitle } from '../ui'
import { clock, dayLabel, duration, isToday, minutesLabel, shortDay } from '../time'

// People who keep their mic muted in the scripted rooms (Marcus is on the warehouse floor).
const mutedInRoom: Record<string, string[]> = { r_ops: ['u_marcus'], r_design: [] }
const REACTIONS = ['👍', '👏', '😂', '🎉']

// Rooms whose recording notice was shown on the pre-join panel this visit (REC-06).
const noticeSeen = new Set<string>()

function useIsDesktop(query = '(min-width: 768px)') {
  const [desktop, setDesktop] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setDesktop(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return desktop
}

function channelName(room: Room, conversations: { id: string; name: string }[]) {
  const c = room.conversationId ? conversations.find(x => x.id === room.conversationId) : undefined
  return c?.name
}

/** Who can open this room's recordings (REC-20), as one sentence. */
function audienceLine(room: Room, channel?: string) {
  if (room.restricted) return 'Only the people in the session can open them.'
  if (channel) return `Everyone in #${channel} can open them.`
  if (room.isPublic) return `Everyone at ${ORG_NAME} can open them.`
  return 'Only members of this room can open them.'
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function quietLine(room: Room) {
  if (room.id === 'r_q4') return 'Private room for the Q4 launch review at 3 pm.'
  if (room.participants.length === 1) return `${personShort(room.participants[0])} is here. Recording starts when a second person joins.`
  return 'No one here yet. Drop in any time.'
}

export default function RoomsScreen() {
  const { state } = useStore()
  const route = state.route as Extract<Route, { name: 'rooms' }>
  if (!route.roomId) return <RoomsList />
  const room = state.rooms.find(r => r.id === route.roomId)
  if (!room) {
    return (
      <div className="flex h-full flex-col">
        <ScreenHeader title="Room" back />
        <EmptyState title="This room doesn’t exist" body="It may have been removed. Pick another room from the list." />
      </div>
    )
  }
  return state.myRoomId === room.id ? <InRoom room={room} /> : <PreJoin room={room} />
}

// ── List ──────────────────────────────────────────────────────────────────────
function RoomsList() {
  const { state, navigate, joinRoom } = useStore()
  const live = state.rooms.filter(r => r.participants.length >= 2)
  const quiet = state.rooms.filter(r => r.participants.length < 2)
  const recent = [...state.sessions].sort((a, b) => b.startedAt - a.startedAt)
  const join = (id: string) => {
    if (state.myRoomId !== id) joinRoom(id)
    navigate({ name: 'rooms', roomId: id })
  }

  return (
    <Page wide>
      <div className="mb-5 hidden md:block">
        <h1 className="font-display text-2xl font-semibold">Rooms</h1>
        <p className="text-sm text-muted">Drop in any time. Every session with 2 or more people is recorded and transcribed.</p>
      </div>
      <p className="mb-4 text-sm text-muted md:hidden">Drop in any time. Sessions with 2 or more people are recorded.</p>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-8">
          <section>
            <SectionTitle count={live.length}>Live now</SectionTitle>
            {live.length === 0 ? (
              <p className="rounded-2xl border border-line bg-surface px-4 py-6 text-center text-sm text-muted">No one is talking right now.</p>
            ) : (
              <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
                {live.map(r => {
                  const ch = channelName(r, state.conversations)
                  const mine = state.myRoomId === r.id
                  return (
                    <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                      <button onClick={() => navigate({ name: 'rooms', roomId: r.id })} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                        <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-rec-soft text-rec"><Volume2 size={20} /></span>
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate font-semibold">{r.name}</span>
                            {r.screenShareBy && <Pill tone="agent" icon={<MonitorUp size={11} />} className="shrink-0">Screen</Pill>}
                          </span>
                          <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted">
                            {ch && <span className="truncate">#{ch}</span>}
                            {r.sessionStartedAt && <span className="tabular">{minutesLabel((state.clock - r.sessionStartedAt) / 1000)}</span>}
                            <RecordingIndicator compact />
                          </span>
                          <span className="mt-1.5 flex items-center gap-1.5">
                            {r.participants.slice(0, 5).map(p => <Avatar key={p} id={p} size="sm" speaking={r.speakingId === p} />)}
                            {r.participants.length > 5 && <span className="text-xs text-muted">+{r.participants.length - 5}</span>}
                          </span>
                        </span>
                      </button>
                      {mine ? (
                        <Button variant="secondary" onClick={() => navigate({ name: 'rooms', roomId: r.id })}>You’re in</Button>
                      ) : (
                        <Button variant="primary" icon={<Mic size={16} />} onClick={() => join(r.id)}>Join</Button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          <section>
            <SectionTitle>Quiet rooms</SectionTitle>
            <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
              {quiet.map(r => {
                const ch = channelName(r, state.conversations)
                const mine = state.myRoomId === r.id
                return (
                  <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                    <button onClick={() => navigate({ name: 'rooms', roomId: r.id })} className="flex min-w-0 flex-1 items-start gap-3 text-left">
                      <span className={cx('mt-0.5 grid size-11 shrink-0 place-items-center rounded-2xl', r.restricted ? 'bg-warn-soft text-warn' : 'bg-surface-2 text-muted')}>
                        {r.restricted ? <Lock size={18} /> : <Volume2 size={20} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="truncate font-semibold">{r.name}</span>
                          {r.restricted && <Pill tone="warn" icon={<Lock size={10} />}>Restricted</Pill>}
                          {!r.isPublic && !r.restricted && <Pill>Private</Pill>}
                          {ch && <span className="truncate text-xs text-muted">#{ch}</span>}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted">
                          {r.restricted ? 'Sessions are visible only to the people in them and never added to search or AI.' : quietLine(r)}
                        </span>
                        {r.participants.length > 0 && (
                          <span className="mt-1.5 flex items-center gap-1.5">{r.participants.map(p => <Avatar key={p} id={p} size="sm" />)}</span>
                        )}
                      </span>
                    </button>
                    {mine ? (
                      <Button variant="secondary" onClick={() => navigate({ name: 'rooms', roomId: r.id })}>You’re in</Button>
                    ) : (
                      <Button variant="secondary" onClick={() => navigate({ name: 'rooms', roomId: r.id })}>Join</Button>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        </div>

        <section className="min-w-0">
          <SectionTitle>Recent sessions</SectionTitle>
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {recent.map(s => {
              const conv = s.conversationId ? state.conversations.find(c => c.id === s.conversationId) : undefined
              return (
                <li key={s.id}>
                  <button onClick={() => navigate({ name: 'session', sessionId: s.id })} className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-surface-2">
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-ink"><Mic size={18} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium">{s.title}</span>
                        {s.restricted && <Pill tone="warn" icon={<Lock size={10} />}>Restricted</Pill>}
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {shortDay(s.startedAt)}, {clock(s.startedAt)} · {minutesLabel(s.durationSec)}{conv ? ` · #${conv.name}` : ''}
                      </span>
                      <span className={cx('block truncate text-xs', s.notes ? 'text-agent' : 'text-muted')}>
                        {s.notes ? `Notes · ${plural(s.notes.decisions.length, 'decision')} · ${plural(s.notes.actionItems.length, 'action item')}` : 'Short session · no notes'}
                      </span>
                    </span>
                    <ChevronRight size={16} className="shrink-0 text-muted" />
                  </button>
                </li>
              )
            })}
          </ul>
          <p className="mt-2 px-1 text-[11px] text-muted">Recordings are kept for 120 days. Transcripts and notes are kept for 3 years.</p>
        </section>
      </div>
    </Page>
  )
}

function gridCols(n: number) {
  if (n <= 1) return 'mx-auto w-full max-w-md grid-cols-1'
  if (n <= 4) return 'mx-auto w-full max-w-3xl grid-cols-2'
  return 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-4'
}

// ── Pre-join ──────────────────────────────────────────────────────────────────
function PreJoin({ room }: { room: Room }) {
  const { state, joinRoom, back } = useStore()
  const ch = channelName(room, state.conversations)
  const live = room.participants.length >= 2
  useEffect(() => {
    noticeSeen.add(room.id)
  }, [room.id])

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title={room.name} subtitle={ch ? `#${ch}` : room.restricted ? 'Restricted room' : 'Standalone room'} back />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-md flex-col items-center gap-5 px-4 py-8 text-center">
          <span className={cx('grid size-20 place-items-center rounded-3xl', live ? 'bg-rec-soft text-rec' : room.restricted ? 'bg-warn-soft text-warn' : 'bg-surface-2 text-muted')}>
            {room.restricted ? <Lock size={32} /> : <Volume2 size={34} />}
          </span>
          <div className="flex flex-col items-center gap-1.5">
            <h2 className="font-display text-2xl font-semibold">{room.name}</h2>
            <div className="flex flex-wrap items-center justify-center gap-2 text-sm text-muted">
              {live ? <RecordingIndicator /> : <span>No session running</span>}
              {room.sessionStartedAt && <span className="tabular">· live for {minutesLabel((state.clock - room.sessionStartedAt) / 1000)}</span>}
              {room.restricted && <Pill tone="warn" icon={<Lock size={10} />}>Restricted</Pill>}
            </div>
          </div>

          {room.participants.length > 0 ? (
            <div className="flex w-full flex-col items-center gap-2">
              <div className="flex flex-wrap justify-center gap-3">
                {room.participants.map(p => (
                  <span key={p} className="flex w-16 flex-col items-center gap-1">
                    <Avatar id={p} size="lg" speaking={room.speakingId === p && live} />
                    <span className="w-full truncate text-xs">{personShort(p)}</span>
                  </span>
                ))}
              </div>
              <p className="text-sm text-muted">
                {room.participants.length === 1 ? `${personShort(room.participants[0])} is here. Recording starts when you join.` : `${room.participants.length} people inside`}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted">No one is here yet. Recording starts when a second person joins.</p>
          )}

          <div className="w-full rounded-2xl bg-rec-soft px-4 py-3 text-left text-sm">
            <p className="mb-1 flex items-center gap-2 font-semibold text-rec">
              <span className="size-2 rounded-full bg-rec" aria-hidden /> This room is recorded and transcribed
            </p>
            <p className="text-fg">
              Session recordings are kept for 120 days and transcripts for 3 years. {audienceLine(room, ch)}
              {room.restricted && ' Restricted sessions are never added to search or AI.'}
            </p>
          </div>

          <div className="flex w-full flex-col gap-2 sm:flex-row-reverse">
            <Button variant="primary" size="lg" className="w-full sm:flex-1" icon={<Mic size={18} />} onClick={() => joinRoom(room.id)}>Join</Button>
            <Button variant="ghost" size="lg" className="w-full sm:flex-1" onClick={back}>Not now</Button>
          </div>
          <p className="text-xs text-muted md:hidden">Your mic starts muted on a phone.</p>
        </div>
      </div>
    </div>
  )
}

// ── In room ───────────────────────────────────────────────────────────────────
function InRoom({ room }: { room: Room }) {
  const { state, navigate, leaveRoom, setSpeaking, toast } = useStore()
  const desktop = useIsDesktop()
  // Landscape tiles only once the stage is wide enough beside the room chat (from 1024px);
  // narrower, they'd be too short for the avatar and name.
  const roomy = useIsDesktop('(min-width: 1024px)')
  const [muted, setMuted] = useState(() => !window.matchMedia('(min-width: 768px)').matches)
  const [camera, setCamera] = useState(false)
  const [hand, setHand] = useState(false)
  const [picker, setPicker] = useState(false)
  const [floating, setFloating] = useState<{ id: number; emoji: string }[]>([])
  const [showNotice, setShowNotice] = useState(() => !noticeSeen.has(room.id))
  const ch = channelName(room, state.conversations)
  const recording = room.participants.length >= 2
  const elapsed = useElapsed(room.sessionStartedAt, state.clock)

  // Simulated speaking: cycle through the unmuted people (not you) every ~2.5 s.
  const roomMuted = mutedInRoom[room.id] ?? []
  const speakers = room.participants.filter(p => p !== ME && !roomMuted.includes(p))
  const speakersKey = speakers.join(',')
  const idx = useRef(0)
  useEffect(() => {
    const ids = speakersKey ? speakersKey.split(',') : []
    if (!ids.length) {
      setSpeaking(room.id, undefined)
      return
    }
    idx.current %= ids.length
    setSpeaking(room.id, ids[idx.current])
    const t = window.setInterval(() => {
      idx.current = (idx.current + 1) % ids.length
      setSpeaking(room.id, ids[idx.current])
    }, 2500)
    return () => clearInterval(t)
    // setSpeaking is recreated on every store change; the room and speakers are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id, speakersKey])

  const react = (emoji: string) => {
    const id = Date.now() + Math.random()
    setFloating(f => [...f, { id, emoji }])
    setPicker(false)
    window.setTimeout(() => setFloating(f => f.filter(x => x.id !== id)), 2200)
  }
  const leave = () => {
    leaveRoom()
    navigate({ name: 'rooms' })
  }
  const openChat = () => room.conversationId && navigate({ name: 'chats', conversationId: room.conversationId })

  const others = room.participants.filter(p => p !== ME)
  const tiles = [ME, ...others]
  const sharing = room.screenShareBy

  return (
    <div className="flex h-full flex-col bg-bg">
      <ScreenHeader
        title={room.name}
        back={() => navigate({ name: 'rooms' })}
        subtitle={
          <span className="flex items-center gap-2">
            {recording ? (
              <>
                <RecordingIndicator compact label="Recording · Transcribing" />
                <span className="tabular">{duration(elapsed)}</span>
              </>
            ) : (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold"><Pause size={11} aria-hidden /> Recording paused</span>
            )}
            {room.restricted && <Pill tone="warn" icon={<Lock size={10} />}>Restricted</Pill>}
            {ch && <span className="hidden truncate sm:inline">· #{ch}</span>}
          </span>
        }
        actions={
          <>
            <span className="hidden items-center gap-1 text-xs text-muted sm:flex"><Users size={14} /> {room.participants.length}</span>
            {room.conversationId && !desktop && (
              <Button variant="secondary" icon={<MessageSquare size={16} />} onClick={openChat} aria-label="Room chat" className="max-[359px]:px-2.5">
                <span className="max-[359px]:sr-only">Room chat</span>
              </Button>
            )}
          </>
        }
      />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-5 sm:py-4">
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
              {showNotice && (
                <div className="anim-in flex items-start gap-3 rounded-2xl bg-rec-soft px-4 py-3 text-sm">
                  <span className={cx('mt-1.5 size-2 shrink-0 rounded-full bg-rec', recording && 'anim-pulse')} aria-hidden />
                  <p className="min-w-0 flex-1">
                    <span className="font-semibold text-rec">This room is recorded and transcribed.</span> Recordings are kept for 120 days and transcripts for 3 years. {audienceLine(room, ch)}
                  </p>
                  <button aria-label="Dismiss notice" className="-m-2 grid size-10 shrink-0 place-items-center rounded-full hover:bg-surface" onClick={() => setShowNotice(false)}><X size={16} /></button>
                </div>
              )}
              {!recording && (
                <div className="flex items-center gap-3 rounded-2xl bg-warn-soft px-4 py-3 text-sm text-warn">
                  <Pause size={16} className="shrink-0" />
                  <p className="min-w-0 flex-1 font-medium">Recording paused — waiting for someone else to join</p>
                </div>
              )}

              <div className={cx(sharing && 'flex flex-col gap-3 md:grid md:grid-cols-[minmax(0,1fr)_9rem] md:items-start')}>
              {sharing && <ScreenShareTile by={sharing} />}

              <div className={cx('grid gap-3', sharing ? 'grid-cols-3 md:grid-cols-1' : gridCols(tiles.length))}>
                {tiles.map(p => {
                  const me = p === ME
                  return (
                    <ParticipantTile
                      key={p}
                      id={p}
                      small={!!sharing}
                      wide={!sharing && (roomy || tiles.length === 1)}
                      me={me}
                      muted={me ? muted : roomMuted.includes(p)}
                      speaking={!me && room.speakingId === p && recording}
                      camera={me && camera}
                      hand={me && hand}
                      floating={me ? floating : []}
                    />
                  )
                })}
              </div>
              </div>
              {muted && <p className="text-center text-xs text-muted">You’re muted. Tap the mic to talk.</p>}
            </div>
          </div>

          <Controls
            muted={muted}
            camera={camera}
            hand={hand}
            picker={picker}
            onMute={() => setMuted(m => !m)}
            onCamera={() => setCamera(c => !c)}
            onShare={() => toast('Screen sharing comes later in the demo')}
            onHand={() => setHand(h => !h)}
            onPicker={() => setPicker(p => !p)}
            onReact={react}
            onLeave={leave}
          />
        </div>

        {desktop && <RoomChat room={room} channel={ch} />}
      </div>
    </div>
  )
}

/** Seconds since the session started, ticking every second on top of the demo clock. */
function useElapsed(startedAt: number | undefined, demoClock: number) {
  const [base] = useState(() => ({ clock: demoClock, real: Date.now() }))
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  if (!startedAt) return 0
  return (base.clock - startedAt) / 1000 + (Date.now() - base.real) / 1000
}

function ParticipantTile({ id, me, muted, speaking, camera, hand, floating, small, wide }: { id: string; me: boolean; muted: boolean; speaking: boolean; camera: boolean; hand: boolean; floating: { id: number; emoji: string }[]; small: boolean; wide: boolean }) {
  return (
    <div
      className={cx(
        'relative flex flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border transition',
        camera ? 'bg-wall' : 'bg-surface',
        speaking ? 'border-ok ring-2 ring-ok' : 'border-line',
        small ? 'aspect-square p-2' : wide ? 'aspect-video p-4' : 'aspect-[4/5] p-3',
      )}
    >
      <Avatar id={id} size={small ? 'lg' : 'xl'} speaking={speaking} />
      <div className="flex max-w-full min-w-0 items-center gap-1.5 px-1">
        {muted && <MicOff size={small ? 12 : 14} className="shrink-0 text-rec" aria-label="Muted" />}
        {camera && <Video size={small ? 12 : 14} className="shrink-0 text-accent-ink" aria-label="Camera on" />}
        <span className={cx('truncate font-medium', small ? 'text-xs' : 'text-sm')}>{me ? 'You' : small ? personShort(id) : personName(id)}</span>
        {speaking && <SpeakingBars />}
      </div>
      {hand && <span className="absolute top-2 right-2 grid size-7 place-items-center rounded-full bg-accent text-accent-fg" aria-label="Hand raised"><Hand size={14} /></span>}
      {floating.map((f, i) => (
        <span key={f.id} className="anim-in pointer-events-none absolute bottom-2 text-3xl" style={{ right: `${8 + i * 14}%` }} aria-hidden>{f.emoji}</span>
      ))}
    </div>
  )
}

function SpeakingBars() {
  return (
    <span className="flex h-3 items-end gap-0.5" aria-label="Speaking">
      {[0, 0.2, 0.4].map(d => <span key={d} className="anim-bar block h-3 w-0.5 rounded-full bg-ok" style={{ animationDelay: `${d}s` }} />)}
    </span>
  )
}

/** A mock of Daniel's shared screen, drawn from shapes (no images). */
function ScreenShareTile({ by }: { by: string }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface">
      <div className="aspect-video w-full bg-surface-2 p-3 sm:p-5">
        <div className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-card">
          <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
            <span className="size-2 rounded-full bg-line" /><span className="size-2 rounded-full bg-line" /><span className="size-2 rounded-full bg-line" />
            <span className="ml-3 h-2 w-1/3 rounded-full bg-surface-2" />
          </div>
          <div className="flex min-h-0 flex-1 gap-3 p-3">
            <div className="hidden w-1/5 flex-col gap-2 sm:flex">
              {[70, 55, 80, 45].map((w, i) => <span key={i} className={cx('h-2 rounded-full', i === 0 ? 'bg-accent-soft' : 'bg-surface-2')} style={{ width: `${w}%` }} />)}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <span className="h-3 w-2/5 rounded-full bg-line" />
              <div className="grid min-h-0 flex-1 grid-cols-3 gap-2">
                <div className="relative col-span-2 overflow-hidden rounded-lg bg-agent-soft">
                  <span className="absolute top-[30%] left-[12%] h-0.5 w-[55%] rotate-12 rounded-full bg-agent opacity-40" />
                  <span className="absolute top-[24%] left-[10%] size-2.5 rounded-full bg-agent" />
                  <span className="absolute top-[55%] left-[62%] size-2.5 rounded-full bg-rec" />
                  <span className="absolute top-[70%] left-[30%] size-2.5 rounded-full bg-agent" />
                </div>
                <div className="flex flex-col gap-2">
                  {(['bg-rec-soft', 'bg-ok-soft', 'bg-ok-soft'] as const).map((tone, i) => (
                    <div key={i} className="flex flex-1 items-center gap-1.5 rounded-lg border border-line px-2">
                      <span className={cx('h-2 w-6 shrink-0 rounded-full', tone)} />
                      <span className="h-1.5 flex-1 rounded-full bg-surface-2" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-line px-3 py-2 text-xs text-muted">
        <MonitorUp size={14} className="text-agent" />
        <span className="truncate"><span className="font-medium text-fg">{personShort(by)}’s screen</span> · recorded with the session</span>
      </div>
    </div>
  )
}

function Controls(p: { muted: boolean; camera: boolean; hand: boolean; picker: boolean; onMute: () => void; onCamera: () => void; onShare: () => void; onHand: () => void; onPicker: () => void; onReact: (e: string) => void; onLeave: () => void }) {
  // Six controls fit from 320px (smaller below 360px), and beside the room chat at 768px
  // (Leave shows its label once there's room, from 1024px).
  const btn = (active: boolean, danger = false) =>
    cx('grid size-11 shrink-0 place-items-center rounded-full transition min-[360px]:size-12', danger ? 'bg-rec-soft text-rec' : active ? 'bg-accent-soft text-accent-ink' : 'bg-surface-2 text-fg hover:bg-line')
  return (
    <div className="relative border-t border-line bg-surface px-2 py-3 min-[360px]:px-3">
      {p.picker && (
        <div className="anim-in absolute bottom-full left-1/2 mb-2 flex -translate-x-1/2 gap-1 rounded-full border border-line bg-surface p-1.5 shadow-card" role="menu" aria-label="Reactions">
          {REACTIONS.map(e => (
            <button key={e} role="menuitem" aria-label={`React ${e}`} onClick={() => p.onReact(e)} className="grid size-10 place-items-center rounded-full text-xl hover:bg-surface-2">{e}</button>
          ))}
        </div>
      )}
      <div className="mx-auto flex max-w-lg items-center justify-center gap-1.5 min-[360px]:gap-2 lg:gap-3">
        <button className={btn(false, p.muted)} onClick={p.onMute} aria-label={p.muted ? 'Unmute' : 'Mute'} aria-pressed={p.muted} title={p.muted ? 'Unmute' : 'Mute'}>
          {p.muted ? <MicOff size={20} /> : <Mic size={20} />}
        </button>
        <button className={btn(p.camera)} onClick={p.onCamera} aria-label={p.camera ? 'Turn camera off' : 'Turn camera on'} aria-pressed={p.camera} title="Camera">
          {p.camera ? <Video size={20} /> : <VideoOff size={20} />}
        </button>
        <button className={btn(false)} onClick={p.onShare} aria-label="Share screen" title="Share screen"><MonitorUp size={20} /></button>
        <button className={btn(p.hand)} onClick={p.onHand} aria-label={p.hand ? 'Lower hand' : 'Raise hand'} aria-pressed={p.hand} title="Raise hand"><Hand size={20} /></button>
        <button className={btn(p.picker)} onClick={p.onPicker} aria-label="Reactions" aria-expanded={p.picker} title="Reactions"><Smile size={20} /></button>
        <button onClick={p.onLeave} className="flex h-11 shrink-0 items-center gap-2 rounded-full bg-rec px-3 font-semibold text-white transition hover:brightness-105 min-[360px]:h-12 min-[360px]:px-4 lg:px-5" aria-label="Leave room">
          <PhoneOff size={20} />
          <span className="hidden sm:inline md:hidden lg:inline">Leave</span>
        </button>
      </div>
    </div>
  )
}

// ── Room chat side panel (desktop, ROOM-06) ───────────────────────────────────
function preview(m: Message, sessions: { id: string; title: string }[]) {
  switch (m.kind) {
    case 'voice': return `Voice message ${duration(m.voice?.durationSec ?? 0)} · “${m.voice?.transcript ?? ''}”`
    case 'notes': return `Meeting notes · ${sessions.find(s => s.id === m.sessionId)?.title ?? 'session'}`
    case 'file': return m.text ? `${m.text} (${m.file?.name})` : m.file?.name ?? 'File'
    case 'suggest': return m.suggestion?.teaser ?? ''
    default: return m.text ?? ''
  }
}

function RoomChat({ room, channel }: { room: Room; channel?: string }) {
  const { state, navigate } = useStore()
  const msgs = room.conversationId ? state.messages.filter(m => m.conversationId === room.conversationId && !m.deleted).slice(-6) : []
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-surface lg:w-96">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <MessageSquare size={16} className="text-muted" />
        <div className="min-w-0 flex-1">
          <p className="font-display font-semibold">Room chat</p>
          {channel && <p className="truncate text-xs text-muted">#{channel}</p>}
        </div>
      </div>
      {!room.conversationId ? (
        <p className="px-4 py-6 text-sm text-muted">This room isn’t attached to a channel, so there’s no chat to show.</p>
      ) : (
        <>
          <ul className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {msgs.map(m =>
              m.kind === 'system' ? (
                <li key={m.id} className="text-center text-xs text-muted">{m.text}</li>
              ) : (
                <li key={m.id} className="flex gap-2.5">
                  <Avatar id={m.authorId} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-baseline gap-2 text-xs">
                      <span className="truncate font-semibold">{m.authorId === ME ? 'You' : personShort(m.authorId)}</span>
                      <span className="shrink-0 text-muted tabular">{isToday(m.ts) ? clock(m.ts) : `${dayLabel(m.ts)}, ${clock(m.ts)}`}</span>
                    </p>
                    <p className="line-clamp-3 text-sm break-words">{preview(m, state.sessions)}</p>
                  </div>
                </li>
              ),
            )}
          </ul>
          <div className="border-t border-line p-3">
            <Button className="w-full" icon={<MessageSquare size={16} />} onClick={() => navigate({ name: 'chats', conversationId: room.conversationId })}>Open #{channel}</Button>
          </div>
        </>
      )}
    </aside>
  )
}
