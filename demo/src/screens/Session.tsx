// Session page (REC-15/16/17/21, J3): recording player, synced transcript,
// AI notes, the "viewed by" list and "Ask this meeting".
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Eye, Languages, Lock, Pause, Pencil, Play, Search, Send, Sparkles } from 'lucide-react'
import { useStore } from '../store'
import type { Notes, Route, Session, SourceRef } from '../types'
import { ME } from '../data/people'
import { NotesCard } from '../ui/notes'
import { AIMarker, Avatar, AvatarStack, Button, cx, EmptyState, IconButton, personName, personShort, Pill, ScreenHeader, SectionTitle, Segmented, Sheet, SourceChips, CitedText } from '../ui'
import { clock, duration, minutesLabel, shortDay } from '../time'

const RETENTION_DAYS = 120
const SPEEDS = ['1', '1.5', '2'] as const
type Speed = (typeof SPEEDS)[number]
type Tab = 'notes' | 'transcript' | 'details'

function useIsDesktop() {
  const query = '(min-width: 768px)'
  const [desktop, setDesktop] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setDesktop(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return desktop
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Index of the passage playing at `sec` (the last one that has started). */
function activeIndex(s: Session, sec: number) {
  let idx = -1
  s.transcript.forEach((p, i) => {
    if (p.startSec <= sec + 0.01) idx = i
  })
  // After the last passage ends no one is speaking, so nothing stays highlighted.
  if (idx === s.transcript.length - 1 && sec > s.transcript[idx].endSec + 5) return -1
  return idx
}

const youOr = (id: string) => (id === ME ? 'You' : personShort(id))

export default function SessionScreen() {
  const { state } = useStore()
  const route = state.route as Extract<Route, { name: 'session' }>
  const session = state.sessions.find(s => s.id === route.sessionId)
  if (!session) {
    return (
      <div className="flex h-full flex-col">
        <ScreenHeader title="Session" back />
        <EmptyState title="Session not found" body="It may have been deleted under the retention policy, or you don’t have access." />
      </div>
    )
  }
  return <SessionView key={session.id} session={session} t={route.t} />
}

function SessionView({ session, t }: { session: Session; t?: number }) {
  const { state, toast } = useStore()
  const desktop = useIsDesktop()
  const [current, setCurrent] = useState(() => Math.min(t ?? 0, session.durationSec))
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<Speed>('1')
  const [tab, setTab] = useState<Tab>(t !== undefined || !session.notes ? 'transcript' : 'notes')
  const [query, setQuery] = useState('')
  const [corrections, setCorrections] = useState<Record<number, string>>({})
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [openedAt] = useState(state.clock)

  // Playback is simulated: advance a local clock while "playing".
  useEffect(() => {
    if (!playing) return
    const step = 0.25
    const timer = window.setInterval(() => {
      setCurrent(c => {
        const next = c + step * Number(speed)
        if (next >= session.durationSec) {
          setPlaying(false)
          return session.durationSec
        }
        return next
      })
    }, step * 1000)
    return () => clearInterval(timer)
  }, [playing, speed, session.durationSec])

  // Timestamp links (notes action items, Ask answers) navigate with ?t — seek to it.
  const firstT = useRef(true)
  useEffect(() => {
    if (firstT.current) {
      firstT.current = false
      return
    }
    if (t === undefined) return
    setCurrent(t)
    setTab('transcript')
  }, [t])

  const active = activeIndex(session, current)
  const seek = (sec: number) => setCurrent(Math.max(0, Math.min(sec, session.durationSec)))
  const keptUntil = session.startedAt + RETENTION_DAYS * 86_400_000
  const keptLabel = `${shortDay(keptUntil)} ${new Date(keptUntil).getFullYear()}`

  const header = (
    <ScreenHeader
      title={session.title}
      back
      subtitle={`${shortDay(session.startedAt)}, ${clock(session.startedAt)} · ${minutesLabel(session.durationSec)}`}
      actions={
        <span className="flex items-center gap-2">
          {session.restricted && <Pill tone="warn" icon={<Lock size={10} />}>Restricted</Pill>}
          <AvatarStack ids={session.participants} max={desktop ? 4 : 3} size={desktop ? 'sm' : 'xs'} />
        </span>
      }
    />
  )

  const meta = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      <span className="min-w-0">{session.participants.map(youOr).join(', ')}</span>
      <span className="hidden sm:inline" aria-hidden>·</span>
      <span>Recording kept until {keptLabel}</span>
      {session.restricted && <span>· Only the people in this session can open it</span>}
    </div>
  )

  const player = <Player session={session} current={current} playing={playing} speed={speed} active={active} onPlay={() => { if (current >= session.durationSec) setCurrent(0); setPlaying(p => !p) }} onSeek={seek} onSpeed={setSpeed} />

  const transcript = (
    <Transcript
      session={session}
      active={active}
      query={query}
      onQuery={setQuery}
      corrections={corrections}
      onSeek={sec => { seek(sec); setPlaying(true) }}
      onCorrect={i => { setEditing(i); setDraft(corrections[i] ?? session.transcript[i].text) }}
      scrollKey={`${active}-${t ?? ''}`}
    />
  )

  const notes = session.notes ? (
    <NotesCard sessionId={session.id} />
  ) : (
    <div className="rounded-2xl border border-line bg-surface px-4 py-5 text-sm">
      <p className="font-medium">Short session · transcript saved, no notes</p>
      <p className="mt-1 text-muted">Notes are made for sessions of 5 minutes or more, or when someone makes a decision or takes an action item.</p>
    </div>
  )

  const sheet = (
    <Sheet
      open={editing !== null}
      onClose={() => setEditing(null)}
      title="Suggest a correction"
      footer={
        <>
          <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!draft.trim()}
            onClick={() => {
              if (editing === null) return
              setCorrections(c => ({ ...c, [editing]: draft.trim() }))
              setEditing(null)
              toast('Correction saved. The original is kept.')
            }}
          >
            Save correction
          </Button>
        </>
      }
    >
      {editing !== null && (
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2 text-xs text-muted">
            <Avatar id={session.transcript[editing].speakerId} size="xs" />
            <span>{personName(session.transcript[editing].speakerId)} · {duration(session.transcript[editing].startSec)}</span>
          </div>
          <blockquote className="rounded-xl bg-surface-2 px-3 py-2 text-muted">{session.transcript[editing].text}</blockquote>
          <label htmlFor="correction" className="block text-xs font-semibold">Corrected text</label>
          <textarea id="correction" value={draft} onChange={e => setDraft(e.target.value)} rows={4} className="w-full resize-none rounded-xl border border-line bg-surface px-3 py-2 outline-none focus:border-accent" />
          <p className="text-xs text-muted">Your correction is saved as a new version with your name. The machine-generated original is kept.</p>
        </div>
      )}
    </Sheet>
  )

  if (desktop) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="space-y-3 border-b border-line bg-surface px-5 py-4">
              {meta}
              {player}
            </div>
            {transcript}
          </div>
          <aside className="w-[400px] shrink-0 overflow-y-auto border-l border-line bg-bg xl:w-[440px]">
            <div className="space-y-6 p-5">
              {notes}
              <AskMeeting session={session} />
              <ViewedBy session={session} openedAt={openedAt} />
            </div>
          </aside>
        </div>
        {sheet}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="space-y-3 border-b border-line bg-surface px-4 py-3">
        {player}
        <Segmented<Tab>
          className="flex w-full [&>button]:flex-1"
          value={tab}
          onChange={setTab}
          options={[{ value: 'notes', label: 'Notes' }, { value: 'transcript', label: 'Transcript' }, { value: 'details', label: 'Details' }]}
        />
      </div>
      {tab === 'transcript' ? (
        transcript
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="space-y-6 px-4 py-4">
            {tab === 'notes' ? (
              <>
                {notes}
                <AskMeeting session={session} />
              </>
            ) : (
              <>
                <section>
                  <SectionTitle>About this session</SectionTitle>
                  <div className="space-y-2 rounded-2xl border border-line bg-surface px-4 py-3 text-sm">
                    <Detail label="When">{shortDay(session.startedAt)}, {clock(session.startedAt)} · {minutesLabel(session.durationSec)}</Detail>
                    <Detail label="People">{session.participants.map(youOr).join(', ')}</Detail>
                    <Detail label="Recording">Kept until {keptLabel}</Detail>
                    <Detail label="Transcript">Kept for 3 years</Detail>
                    {session.restricted && <Detail label="Access">Only the people in this session</Detail>}
                  </div>
                </section>
                <ViewedBy session={session} openedAt={openedAt} />
              </>
            )}
          </div>
        </div>
      )}
      {sheet}
    </div>
  )
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-24 shrink-0 text-muted">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}

// ── Player ────────────────────────────────────────────────────────────────────
function Player({ session, current, playing, speed, active, onPlay, onSeek, onSpeed }: { session: Session; current: number; playing: boolean; speed: Speed; active: number; onPlay: () => void; onSeek: (s: number) => void; onSpeed: (s: Speed) => void }) {
  const speaker = active >= 0 ? session.transcript[active] : undefined
  const pct = (current / session.durationSec) * 100
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-3">
        <button
          onClick={onPlay}
          aria-label={playing ? 'Pause' : 'Play'}
          className="grid size-12 shrink-0 place-items-center rounded-full bg-accent text-accent-fg transition hover:brightness-105"
        >
          {playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" className="ml-0.5" />}
        </button>
        <div className="min-w-0 flex-1">
          {speaker ? (
            <div className="flex min-w-0 items-center gap-2">
              <Avatar id={speaker.speakerId} size="xs" speaking={playing} />
              <p className="truncate text-sm"><span className="font-semibold">{personShort(speaker.speakerId)}</span> <span className="text-muted">{speaker.text}</span></p>
            </div>
          ) : (
            <p className="truncate text-sm text-muted">Recording · {session.participants.length} people</p>
          )}
          <div className="mt-1.5 flex items-center gap-2">
            <label htmlFor="scrubber" className="sr-only">Playback position</label>
            <div className="relative h-5 min-w-0 flex-1">
              {/* Speaker passages as faint segments under the scrubber. */}
              <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-surface-2">
                {session.transcript.map((p, i) => (
                  <span key={i} className="absolute inset-y-0 bg-line" style={{ left: `${(p.startSec / session.durationSec) * 100}%`, width: `${Math.max(0.4, ((p.endSec - p.startSec) / session.durationSec) * 100)}%` }} />
                ))}
                <span className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${pct}%` }} />
              </div>
              <input
                id="scrubber"
                type="range"
                min={0}
                max={session.durationSec}
                step={1}
                value={Math.round(current)}
                onChange={e => onSeek(Number(e.target.value))}
                className="absolute inset-x-0 top-1/2 h-10 w-full -translate-y-1/2 cursor-pointer appearance-none bg-transparent accent-accent [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-accent [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent"
              />
            </div>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted tabular">{duration(current)} / {duration(session.durationSec)}</span>
        <Segmented<Speed> value={speed} onChange={onSpeed} options={SPEEDS.map(s => ({ value: s, label: `${s}×` }))} className="[&>button]:px-2.5 [&>button]:py-2 [&>button]:text-xs" />
      </div>
    </div>
  )
}

// ── Transcript ────────────────────────────────────────────────────────────────
function highlight(text: string, q: string) {
  const needle = q.trim()
  if (!needle) return text
  const re = new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
  return text.split(re).map((part, i) => (i % 2 === 1 ? <mark key={i} className="rounded bg-warn-soft px-0.5 font-semibold text-warn">{part}</mark> : part))
}

function Transcript({ session, active, query, onQuery, corrections, onSeek, onCorrect, scrollKey }: { session: Session; active: number; query: string; onQuery: (q: string) => void; corrections: Record<number, string>; onSeek: (s: number) => void; onCorrect: (i: number) => void; scrollKey: string }) {
  const box = useRef<HTMLDivElement>(null)
  const first = useRef(true)
  const items = useRef<(HTMLLIElement | null)[]>([])
  const q = query.trim().toLowerCase()
  const matches = q ? session.transcript.filter((p, i) => (corrections[i] ?? p.text).toLowerCase().includes(q)).length : 0

  // Keep the playing passage in view (inside the transcript's own scroller).
  useEffect(() => {
    const el = items.current[active]
    const c = box.current
    if (!el || !c || q) return
    const top = el.offsetTop
    if (top < c.scrollTop + 8 || top + el.offsetHeight > c.scrollTop + c.clientHeight * 0.75) {
      c.scrollTo({ top: Math.max(0, top - c.clientHeight / 3), behavior: first.current || reducedMotion() ? 'auto' : 'smooth' })
    }
    first.current = false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2.5 sm:px-5">
        <label htmlFor="transcript-search" className="sr-only">Search the transcript</label>
        <div className="flex h-9 min-w-0 flex-1 basis-48 items-center gap-2 rounded-full bg-surface-2 px-3 text-muted focus-within:ring-2 focus-within:ring-accent">
          <Search size={15} className="shrink-0" />
          <input id="transcript-search" value={query} onChange={e => onQuery(e.target.value)} placeholder="Search the transcript" className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-muted" />
          {q && <span className="shrink-0 text-xs tabular">{matches} {matches === 1 ? 'match' : 'matches'}</span>}
        </div>
        <span className="flex items-center gap-1.5 text-[11px] text-muted">
          <AIMarker label="Transcript" />
          Machine-generated · gpt-transcribe
        </span>
      </div>
      <div ref={box} className="relative min-h-0 flex-1 overflow-y-auto bg-bg">
        <ol className="mx-auto max-w-3xl space-y-1 px-2 py-3 sm:px-4">
          {session.transcript.map((p, i) => {
            const text = corrections[i] ?? p.text
            const hit = q && text.toLowerCase().includes(q)
            return (
              <li
                key={i}
                ref={el => { items.current[i] = el }}
                className={cx('group flex gap-3 rounded-2xl px-3 py-2.5 transition', i === active ? 'bg-accent-soft' : 'hover:bg-surface', q && !hit && 'opacity-50')}
                aria-current={i === active ? 'true' : undefined}
              >
                <Avatar id={p.speakerId} size="sm" className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold">{personName(p.speakerId)}</span>
                    <button onClick={() => onSeek(p.startSec)} className="relative shrink-0 rounded-full px-1.5 text-xs text-accent-ink tabular after:absolute after:-inset-x-1 after:-inset-y-3 hover:bg-surface-2" aria-label={`Play from ${duration(p.startSec)}`}>
                      {duration(p.startSec)}
                    </button>
                  </div>
                  <p className="text-[15px] leading-relaxed break-words">{highlight(text, query)}</p>
                  {corrections[i] && <p className="mt-0.5 text-[11px] text-muted">Corrected by you · original kept</p>}
                  {p.nonEnglish && (
                    <p className="mt-1 flex items-center gap-1 text-[11px] text-warn"><Languages size={12} /> Non-English speech — may be inaccurate</p>
                  )}
                </div>
                <IconButton label="Suggest a correction" className="size-8 text-muted opacity-60 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => onCorrect(i)}>
                  <Pencil size={14} />
                </IconButton>
              </li>
            )
          })}
        </ol>
        <p className="px-5 pb-5 text-center text-[11px] text-muted">Machine-generated transcript. Speakers come from each person’s own microphone. Anyone in the session can suggest a correction.</p>
      </div>
    </div>
  )
}

// ── Ask this meeting (REC-17) ─────────────────────────────────────────────────
interface Answer { q: string; text: string; sources: SourceRef[] }

const stamp = (sec: number) => duration(sec)

function answerFrom(session: Session, notes: Notes | undefined, q: string): Omit<Answer, 'q'> {
  const lower = q.toLowerCase()
  const fallback = { text: 'I can only answer from this meeting’s transcript.', sources: [] }
  if (!notes) return fallback
  const at = (i: number | undefined, label: string): SourceRef | undefined => {
    if (i === undefined || !session.transcript[i]) return undefined
    const sec = session.transcript[i].startSec
    return { label: `${stamp(sec)} · ${label}`, kind: 'session', route: { name: 'session', sessionId: session.id, t: sec } }
  }
  if (/(who|own|action|doing|responsib|task)/.test(lower)) {
    const sources: SourceRef[] = []
    const lines = notes.actionItems.map(a => {
      const src = at(a.passageIndex, youOr(a.ownerId))
      if (src) sources.push(src)
      return `${youOr(a.ownerId)}: ${a.text.charAt(0).toLowerCase()}${a.text.slice(1)}${a.due ? ` (${a.due})` : ''}.${src ? `[${sources.length}]` : ''}`
    })
    if (!lines.length) return { text: 'No one took an action item in this meeting.', sources: [] }
    return { text: lines.join('\n'), sources }
  }
  if (/(decid|decision|agree|conclu)/.test(lower)) {
    const idx = session.transcript.findIndex(p => /agreed|so hold|goes ahead|let’s leave/i.test(p.text))
    const src = at(idx >= 0 ? idx : undefined, idx >= 0 ? personShort(session.transcript[idx].speakerId) : '')
    return { text: notes.decisions.join(' ') + (src ? ' [1]' : ''), sources: src ? [src] : [] }
  }
  if (/(open|question|unresolved|follow|left|pending)/.test(lower)) {
    return { text: notes.openQuestions.length ? `Still open: ${notes.openQuestions.join(' ')}` : 'Nothing was left open in this meeting.', sources: [] }
  }
  if (/(summar|about|happen|recap|tl;?dr)/.test(lower)) return { text: notes.summary, sources: [] }
  return fallback
}

function AskMeeting({ session }: { session: Session }) {
  const [q, setQ] = useState('')
  const [answers, setAnswers] = useState<Answer[]>([])
  const suggestions = session.notes ? ['Who owns what?', 'What did we decide?', 'What’s still open?'] : []
  const run = (question: string) => {
    const text = question.trim()
    if (!text) return
    setAnswers(a => [{ q: text, ...answerFrom(session, session.notes, text) }, ...a].slice(0, 3))
    setQ('')
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    run(q)
  }
  return (
    <section>
      <SectionTitle>Ask this meeting</SectionTitle>
      <div className="space-y-3 rounded-2xl border border-line bg-surface p-3">
        <form onSubmit={submit} className="flex items-center gap-2">
          <label htmlFor="ask-meeting" className="sr-only">Ask a question about this meeting</label>
          <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full bg-surface-2 px-3 focus-within:ring-2 focus-within:ring-accent">
            <Sparkles size={15} className="shrink-0 text-agent" />
            <input id="ask-meeting" value={q} onChange={e => setQ(e.target.value)} placeholder="Ask about this meeting…" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted" />
          </div>
          <IconButton label="Ask" type="submit" className="bg-agent-soft text-agent hover:bg-agent-soft" disabled={!q.trim()}><Send size={16} /></IconButton>
        </form>
        {answers.length === 0 && suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map(s => (
              <button key={s} onClick={() => run(s)} className="rounded-full border border-line px-3 py-1 text-xs hover:border-agent hover:text-agent">{s}</button>
            ))}
          </div>
        )}
        {answers.map((a, i) => (
          <div key={answers.length - i} className="anim-in space-y-2 border-t border-line pt-3 text-sm">
            <p className="font-medium">{a.q}</p>
            <div className="flex items-center gap-2"><AIMarker label="Answer" /><span className="text-[11px] text-muted">From this meeting only</span></div>
            {a.text.split('\n').map((line, k) => <CitedText key={k} text={line} className="leading-relaxed" />)}
            <SourceChips sources={a.sources} />
          </div>
        ))}
      </div>
    </section>
  )
}

// ── Viewed by (REC-21) ────────────────────────────────────────────────────────
function ViewedBy({ session, openedAt }: { session: Session; openedAt: number }) {
  // Opening this page is itself a logged view, so it shows up here too.
  const views = [{ personId: ME, at: openedAt }, ...session.viewedBy].sort((a, b) => b.at - a.at)
  return (
    <section>
      <SectionTitle count={views.length}>Viewed by</SectionTitle>
      <div className="rounded-2xl border border-line bg-surface">
        <ul className="divide-y divide-line">
          {views.map((v, i) => (
            <li key={i} className="flex items-center gap-3 px-4 py-2.5">
              <Avatar id={v.personId} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm">{v.personId === ME ? 'You' : personName(v.personId)}</span>
              <span className="shrink-0 text-xs text-muted tabular">{shortDay(v.at)}, {clock(v.at)}</span>
            </li>
          ))}
        </ul>
        <p className="flex items-center gap-1.5 border-t border-line px-4 py-2 text-[11px] text-muted"><Eye size={12} /> Every view is logged.</p>
      </div>
    </section>
  )
}
