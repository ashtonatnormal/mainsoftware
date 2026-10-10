// One message in a conversation, in all its kinds: text, voice (CHAT-07),
// file (CHAT-06), meeting notes (REC-13), agent suggestion cards (AGT-08, J5)
// and system lines.
import { useEffect, useRef, useState, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { Captions, Check, CheckCheck, ChevronUp, Download, FileSpreadsheet, FileText, Image as ImageIcon, ListTodo, Pause, Play, X } from 'lucide-react'
import type { Conversation, Message, SourceRef } from '../../types'
import { useStore } from '../../store'
import { ME, personById } from '../../data/people'
import { AgentBadge, AIMarker, Avatar, AvatarStack, CitedText, cx, Feedback, IconButton, personName, SourceChips } from '../../ui'
import { NotesCard } from '../../ui/notes'
import { clock, duration, NOW } from '../../time'
import { quickReactions } from './content'
import { isAI, RichText, taskTitleFrom } from './parts'

export interface RowProps {
  m: Message
  c: Conversation
  /** First message of a run from the same author: shows the name and avatar. */
  first: boolean
  read: boolean
  threadCount: number
  threadIds: string[]
  lastReplyTs?: number
  sources?: SourceRef[]
  onThread: (m: Message) => void
  onActions: (m: Message) => void
}

export function MessageRow(props: RowProps) {
  const { m, c } = props
  if (m.kind === 'system') return <SystemLine text={m.text ?? ''} />
  if (m.kind === 'notes' && m.sessionId) return <NotesRow m={m} c={c} />
  return <BubbleRow {...props} />
}

// ── System lines ──────────────────────────────────────────────────────────────
function SystemLine({ text }: { text: string }) {
  const rec = /recording/i.test(text)
  return (
    <div className="my-2 flex justify-center px-4">
      <p className="inline-flex max-w-md items-center gap-2 rounded-xl bg-surface/80 px-3 py-1.5 text-center text-xs text-muted">
        {rec && <span className="size-2 shrink-0 rounded-full bg-rec anim-pulse" aria-label="Recording" />}
        <span className="min-w-0">{text}</span>
      </p>
    </div>
  )
}

// ── Meeting notes (REC-11/13) ─────────────────────────────────────────────────
function NotesRow({ m, c }: { m: Message; c: Conversation }) {
  return (
    <div className="my-3 flex flex-col items-center gap-1.5">
      <div className="w-full max-w-xl">
        <NotesCard sessionId={m.sessionId!} compact />
      </div>
      <p className="max-w-xl px-4 text-center text-[11px] text-muted">
        Posted {clock(m.ts)} for {c.kind === 'channel' ? `members of #${c.name}` : 'everyone here'}, the same people who could join the room.
      </p>
    </div>
  )
}

// ── Bubbles ───────────────────────────────────────────────────────────────────
function BubbleRow({ m, c, first, read, threadCount, threadIds, lastReplyTs, sources, onThread, onActions }: RowProps) {
  const { react, addTask, toast } = useStore()
  const mine = m.authorId === ME
  const author = personById[m.authorId]
  const multi = c.kind === 'channel' || c.kind === 'group'
  const ai = isAI(m.authorId)
  const showAvatarCol = multi && !mine
  const showName = multi && !mine && first && m.kind !== 'suggest'
  const ticks = mine && (c.kind === 'dm' || c.kind === 'group')
  const press = useLongPress(() => onActions(m))

  const createTask = () => {
    addTask(taskTitleFrom(m))
    toast('Added to My tasks', { label: 'View', route: { name: 'tasks' } })
  }

  const meta = (
    <span className="inline-flex items-center gap-1 text-[11px] leading-none text-muted tabular">
      {m.edited && <span>edited ·</span>}
      <time>{clock(m.ts)}</time>
      {ticks &&
        (read ? <CheckCheck size={15} className="text-accent-ink" aria-label="Read" /> : <Check size={15} aria-label="Sent" />)}
    </span>
  )

  let body: ReactNode
  if (m.kind === 'suggest' && m.suggestion) {
    body = <SuggestCard m={m} />
  } else {
    const plainText = (m.kind === 'text' || !m.kind) && !ai && !m.deleted
    // Leave room on the last line for the time (and ticks) floated bottom-right.
    const spacer = (m.edited ? 44 : 0) + (ticks ? 84 : 64)
    body = (
      <div
        className={cx(
          'relative min-w-0 rounded-2xl px-3 py-1.5',
          mine ? 'bg-accent-soft' : 'bg-surface',
          first && (mine ? 'rounded-tr-md' : 'rounded-tl-md'),
          (m.kind === 'voice' || m.kind === 'file') && 'w-72 max-w-full',
        )}
      >
        {showName && (
          <p className="mb-0.5 flex min-w-0 items-center gap-1.5 text-[13px] font-semibold">
            <span className={cx('truncate', ai ? 'text-agent' : 'text-accent-ink')}>{author?.name ?? 'Someone'}</span>
            {author?.kind === 'agent' && <AgentBadge />}
            {ai && <AIMarker />}
          </p>
        )}
        {ai && !showName && (
          <p className="mb-1 flex items-center gap-1.5">
            <AIMarker label={author?.kind === 'assistant' ? 'Assistant' : 'AI'} />
          </p>
        )}

        {m.deleted ? (
          <p className="pr-14 italic text-muted">This message was deleted</p>
        ) : m.kind === 'voice' && m.voice ? (
          <VoicePlayer m={m} mine={mine} />
        ) : m.kind === 'file' && m.file ? (
          <>
            <FileCard file={m.file} />
            {m.text && (
              <p className="mt-1.5 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                <RichText text={m.text} />
              </p>
            )}
          </>
        ) : ai ? (
          <CitedText text={m.text ?? ''} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]" />
        ) : (
          <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            <RichText text={m.text ?? ''} />
            {plainText && <span className="inline-block" style={{ width: spacer }} aria-hidden />}
          </p>
        )}

        {ai && sources && sources.length > 0 && (
          <div className="mt-2 flex flex-col gap-1.5">
            <p className="text-[11px] font-semibold text-muted">Based on</p>
            <SourceChips sources={sources} />
          </div>
        )}
        {ai && sources && sources.length === 0 && m.authorId !== ME && (
          <p className="mt-1.5 text-[11px] text-muted">No sources: nothing you can open matched.</p>
        )}

        {plainText ? (
          <span className="absolute right-2.5 bottom-1.5">{meta}</span>
        ) : (
          <div className={cx('mt-1 flex items-center justify-end gap-2', ai && 'justify-between')}>
            {ai && <Feedback />}
            {meta}
          </div>
        )}
      </div>
    )
  }

  const reactions = m.reactions ?? []
  return (
    <div className={cx('group flex items-start gap-2', mine && 'flex-row-reverse', first ? 'mt-3' : 'mt-0.5')}>
      {showAvatarCol && (first && m.kind !== 'suggest' ? <Avatar id={m.authorId} size="sm" className="mt-0.5" /> : <span className="w-7 shrink-0" aria-hidden />)}
      <div
        className={cx(
          'relative flex min-w-0 flex-col pointer-coarse:select-none',
          mine ? 'items-end' : 'items-start',
          m.kind === 'suggest' ? 'w-full max-w-xl' : 'max-w-[85%] sm:max-w-[75%]',
        )}
        {...press}
      >
        {body}

        {reactions.length > 0 && (
          <div className={cx('mt-1 flex flex-wrap gap-1', mine && 'justify-end')}>
            {reactions.map(r => {
              const byMe = r.by.includes(ME)
              const names = r.by.map(id => (id === ME ? 'You' : personName(id))).join(', ')
              return (
                <button
                  key={r.emoji}
                  onClick={() => react(m.id, r.emoji)}
                  aria-pressed={byMe}
                  aria-label={`${r.emoji} ${r.by.length}: ${names}. ${byMe ? 'Remove your reaction' : 'Add yours'}`}
                  title={names}
                  className={cx(
                    'inline-flex h-7 items-center gap-1 rounded-full border px-2 text-[13px] tabular transition',
                    byMe ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line bg-surface text-fg hover:border-muted',
                  )}
                >
                  <span aria-hidden>{r.emoji}</span>
                  <span className="text-xs font-semibold" aria-hidden>{r.by.length}</span>
                </button>
              )
            })}
          </div>
        )}

        {threadCount > 0 && (
          <button
            onClick={() => onThread(m)}
            className="mt-1 inline-flex max-w-full items-center gap-2 rounded-full py-0.5 pr-2 pl-1 text-[13px] font-semibold text-accent-ink hover:bg-surface/70"
          >
            <AvatarStack ids={threadIds} max={3} size="xs" />
            <span className="shrink-0">{threadCount} {threadCount === 1 ? 'reply' : 'replies'}</span>
            {lastReplyTs && <span className="truncate font-normal text-muted">Last reply {clock(lastReplyTs)}</span>}
          </button>
        )}

        {/* Desktop quick actions on hover (TASK-04 "Create task"). */}
        {!m.deleted && (
          <div
            className={cx(
              'absolute -top-4 z-10 hidden items-center gap-0.5 rounded-full border border-line bg-surface p-0.5 shadow-card md:flex',
              'md:pointer-events-none md:opacity-0 md:transition md:group-hover:pointer-events-auto md:group-hover:opacity-100 md:focus-within:pointer-events-auto md:focus-within:opacity-100',
              mine ? 'left-0 -translate-x-2' : 'right-0 translate-x-2',
            )}
          >
            {quickReactions.map(e => (
              <button key={e} onClick={() => react(m.id, e)} aria-label={`React with ${e}`} className="grid size-8 place-items-center rounded-full text-base hover:bg-surface-2">
                {e}
              </button>
            ))}
            <span className="mx-0.5 h-5 w-px bg-line" aria-hidden />
            <button onClick={createTask} className="inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium hover:bg-surface-2">
              <ListTodo size={15} aria-hidden /> Create task
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/** Long-press on touch screens opens the message actions sheet. */
function useLongPress(fn: () => void) {
  const timer = useRef<number | undefined>(undefined)
  const clear = () => window.clearTimeout(timer.current)
  return {
    onPointerDown: (e: RPointerEvent) => {
      if (e.pointerType !== 'touch') return
      clear()
      timer.current = window.setTimeout(fn, 480)
    },
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
    onPointerMove: (e: RPointerEvent) => {
      if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) clear()
    },
    onContextMenu: (e: RMouseEvent) => {
      if (window.matchMedia('(pointer: coarse)').matches) {
        e.preventDefault()
        clear()
        fn()
      }
    },
  }
}

// ── Voice messages (CHAT-07) ──────────────────────────────────────────────────
const transcribed = new Set<string>()
const speeds = [1, 1.5, 2]

function VoicePlayer({ m, mine }: { m: Message; mine: boolean }) {
  const v = m.voice!
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const [speed, setSpeed] = useState(1)
  // Freshly recorded notes show "Transcribing…" for a moment (D17).
  const [pending, setPending] = useState(() => mine && m.ts >= NOW && !transcribed.has(m.id))

  useEffect(() => {
    if (!pending) return
    const t = window.setTimeout(() => {
      transcribed.add(m.id)
      setPending(false)
    }, 1800)
    return () => window.clearTimeout(t)
  }, [pending, m.id])

  useEffect(() => {
    if (!playing) return
    const t = window.setInterval(() => setPos(p => Math.min(p + 0.1 * speed, v.durationSec)), 100)
    return () => window.clearInterval(t)
  }, [playing, speed, v.durationSec])

  useEffect(() => {
    if (pos >= v.durationSec) {
      setPlaying(false)
      setPos(0)
    }
  }, [pos, v.durationSec])

  const progress = pos / v.durationSec
  const author = personById[m.authorId]

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2.5">
        <button
          onClick={() => setPlaying(p => !p)}
          aria-label={playing ? 'Pause voice message' : `Play voice message from ${mine ? 'you' : author?.short ?? 'them'}, ${duration(v.durationSec)}`}
          className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-fg transition hover:brightness-105"
        >
          {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-0.5" />}
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div
            className="flex h-7 cursor-pointer items-center gap-[2px]"
            aria-hidden
            onClick={e => {
              const r = e.currentTarget.getBoundingClientRect()
              setPos(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * v.durationSec * 0.999)
              setPlaying(true)
            }}
          >
            {v.waveform.map((h, i) => (
              <span
                key={i}
                className={cx('min-w-0 flex-1 rounded-full transition-colors', (i + 0.5) / v.waveform.length <= progress ? 'bg-accent' : 'bg-muted/45')}
                style={{ height: `${Math.round(Math.max(0.18, h) * 100)}%` }}
              />
            ))}
          </div>
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted tabular">
            <span>{playing || pos > 0 ? duration(pos) : duration(v.durationSec)}</span>
            <button
              onClick={() => setSpeed(s => speeds[(speeds.indexOf(s) + 1) % speeds.length])}
              aria-label={`Playback speed ${speed}×. Change speed`}
              className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold text-fg"
            >
              {speed}×
            </button>
          </div>
        </div>
      </div>
      <div className={cx('rounded-xl px-2.5 py-2 text-[13px] leading-snug', mine ? 'bg-surface/60' : 'bg-surface-2')}>
        <p className="mb-0.5 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-muted">
          <Captions size={12} aria-hidden /> Auto-transcribed
          {v.nonEnglish && <span className="font-medium normal-case tracking-normal">· translated</span>}
        </p>
        {pending ? <p className="text-muted anim-pulse">Transcribing…</p> : <p className="break-words text-fg/90">{v.transcript}</p>}
      </div>
    </div>
  )
}

// ── Files (CHAT-06) ───────────────────────────────────────────────────────────
const fileKinds = {
  pdf: { icon: FileText, label: 'PDF' },
  doc: { icon: FileText, label: 'Document' },
  sheet: { icon: FileSpreadsheet, label: 'Spreadsheet' },
  image: { icon: ImageIcon, label: 'Image' },
} as const

function FileCard({ file }: { file: NonNullable<Message['file']> }) {
  const { toast } = useStore()
  const k = fileKinds[file.type]
  return (
    <button
      onClick={() => toast('File previews come later in the demo.')}
      className="mt-0.5 flex w-full items-center gap-3 rounded-xl bg-surface-2 p-2.5 text-left transition hover:bg-line"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-surface text-accent-ink">
        <k.icon size={20} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-sm leading-snug font-semibold break-words">{file.name}</span>
        <span className="block text-xs text-muted">{k.label} · {file.size}</span>
      </span>
      <Download size={16} className="shrink-0 text-muted" aria-hidden />
    </button>
  )
}

// ── Agent suggestion card (AGT-08 "Suggest", J5) ──────────────────────────────
const dismissedSuggestions = new Set<string>()

function SuggestCard({ m }: { m: Message }) {
  const s = m.suggestion!
  const agent = personById[s.agentId]
  const [open, setOpen] = useState(false)
  const [dismissed, setDismissed] = useState(() => dismissedSuggestions.has(m.id))

  if (dismissed)
    return (
      <p className="flex items-center gap-2 rounded-full bg-surface/70 px-3 py-1.5 text-xs text-muted">
        You hid a suggestion from {agent?.name ?? 'an agent'}.
        <button
          className="font-semibold text-agent hover:underline"
          onClick={() => {
            dismissedSuggestions.delete(m.id)
            setDismissed(false)
          }}
        >
          Undo
        </button>
      </p>
    )

  return (
    <div className="w-full overflow-hidden rounded-2xl border border-agent/30 bg-agent-soft">
      <div className="flex items-center gap-2.5 py-1.5 pr-1 pl-2.5">
        <Avatar id={s.agentId} size="sm" />
        <p className="min-w-0 flex-1 text-sm leading-snug">
          <span className="text-fg">{s.teaser}</span>
          {!open && (
            <>
              {' · '}
              <button onClick={() => setOpen(true)} className="font-semibold text-agent hover:underline" aria-expanded={false}>
                Show
              </button>
            </>
          )}
        </p>
        {open ? (
          <IconButton label="Hide answer" className="size-8 text-agent" onClick={() => setOpen(false)} aria-expanded>
            <ChevronUp size={16} />
          </IconButton>
        ) : (
          <IconButton
            label="Dismiss suggestion"
            className="size-8 text-muted"
            onClick={() => {
              dismissedSuggestions.add(m.id)
              setDismissed(true)
            }}
          >
            <X size={16} />
          </IconButton>
        )}
      </div>
      {open && (
        <div className="anim-in flex flex-col gap-2.5 border-t border-agent/20 bg-surface px-3.5 py-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold">{agent?.name}</span>
            <AgentBadge />
            <AIMarker />
          </div>
          <CitedText text={s.answer} className="text-[15px] leading-relaxed" />
          <SourceChips sources={s.sources} />
          <div className="flex items-center justify-between gap-2 border-t border-line pt-1.5">
            <p className="min-w-0 text-[11px] text-muted">
              Offered because {agent?.short ?? 'the agent'} could cite a source. Owned by {personName(agent?.agentOwner ?? '')}.
            </p>
            <Feedback />
          </div>
        </div>
      )}
    </div>
  )
}
