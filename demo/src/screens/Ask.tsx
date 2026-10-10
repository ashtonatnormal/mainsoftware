// Search & Ask (SRCH-01..06, PA-07): ask in plain words and get a cited answer
// from the personal assistant, followed by plain keyword results. Everything
// here is limited to what the signed-in user can open (Rule 1).
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react'
import { ArrowUp, Calendar, CheckSquare, ChevronRight, File as FileIcon, FileText, Film, Folder, Hash, Image as ImageIcon, Lock, MessageSquare, Mic, Music, Paperclip, Presentation, RotateCcw, Search, Sheet as SheetIcon, ShieldCheck, Sparkles, X } from 'lucide-react'
import { useStore } from '../store'
import type { SourceRef } from '../types'
import { askFallback, askSuggestions } from '../data/work'
import { ASSISTANT, people } from '../data/people'
import { AgentBadge, AIMarker, Avatar, CitedText, cx, Feedback, IconButton, Pill, SectionTitle, SourceChips } from '../ui'
import { conversationLabel, directConversation, driveLocation, search, termRegex, termsOf, type ResultGroup, type ResultIcon, type SearchResult } from './ask/search'
import { driveEntries, isTrashed, kindLabel } from '../drive'
import { canOpen } from './drive/model'
import { KindIcon } from './drive/art'

interface Entry {
  id: number
  q: string
  answer: string
  sources: SourceRef[]
  matched: boolean
}

// Questions asked during this visit. Kept at module level so the list survives
// opening a source and coming back (it resets when the page reloads).
let visitHistory: Entry[] = []
const revealed = new Set<string>()
let entrySeq = 0

const norm = (q: string) => q.trim().replace(/\s+/g, ' ')
const keyOf = (q: string) => norm(q).toLowerCase().replace(/[’]/g, "'")

type Filter = 'all' | ResultGroup
const filters: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'messages', label: 'Messages' },
  { value: 'docs', label: 'Files' },
  { value: 'meetings', label: 'Meetings' },
  { value: 'tasks', label: 'Tasks' },
  { value: 'people', label: 'People' },
]
const groupOrder: ResultGroup[] = ['messages', 'meetings', 'docs', 'tasks', 'people']
const groupLabel: Record<ResultGroup, string> = { messages: 'Messages', meetings: 'Meetings', docs: 'Files', tasks: 'Tasks', people: 'People' }
const resultIcons: Record<Exclude<ResultIcon, 'person'>, typeof MessageSquare> = {
  message: MessageSquare,
  voice: Mic,
  file: Paperclip,
  doc: FileText,
  session: Mic,
  event: Calendar,
  task: CheckSquare,
  folder: Folder,
  sheet: SheetIcon,
  slides: Presentation,
  pdf: FileText,
  image: ImageIcon,
  video: Film,
  audio: Music,
  upload: FileIcon,
}
// Drive results use the Drive's kind colours (doc ember, sheet green, slides amber, PDF red, media teal).
const resultTone: Partial<Record<ResultIcon, string>> = {
  session: 'bg-accent-soft text-accent-ink',
  doc: 'bg-accent-soft text-accent-ink',
  sheet: 'bg-ok-soft text-ok',
  slides: 'bg-warn-soft text-warn',
  pdf: 'bg-rec-soft text-rec',
  image: 'bg-agent-soft text-agent',
  video: 'bg-agent-soft text-agent',
  audio: 'bg-agent-soft text-agent',
}

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** Wraps matched words in <mark>. */
function Highlight({ text, re }: { text: string; re: RegExp | null }) {
  if (!re || !text) return <>{text}</>
  const parts: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0
    if (i > last) parts.push(text.slice(last, i))
    parts.push(<mark key={i} className="rounded-sm bg-accent-soft px-0.5 font-medium text-accent-ink">{m[0]}</mark>)
    last = i + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

export default function AskScreen() {
  const { state, ask, navigate } = useStore()
  const routeQ = state.route.name === 'ask' ? state.route.q : undefined
  const [input, setInput] = useState(routeQ ?? '')
  const [current, setCurrent] = useState<Entry | null>(null)
  const [history, setHistory] = useState<Entry[]>(visitHistory)
  const [filter, setFilter] = useState<Filter>('all')
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const run = useCallback((raw: string) => {
    const q = norm(raw)
    if (!q) return
    const known = visitHistory.find(e => keyOf(e.q) === keyOf(q))
    const entry: Entry = known ?? { id: ++entrySeq, q, ...ask(q) }
    visitHistory = [entry, ...visitHistory.filter(e => e.id !== entry.id)].slice(0, 12)
    setHistory(visitHistory)
    setCurrent(entry)
    setInput(q)
    setFilter('all')
  }, [ask])

  // Questions arriving through the route (top bar, Today, links) run at once.
  useEffect(() => {
    if (routeQ) run(routeQ)
  }, [routeQ, run])

  const submit = (raw: string) => {
    const q = norm(raw)
    if (!q) return
    inputRef.current?.blur()
    if (routeQ && keyOf(routeQ) === keyOf(q)) run(q)
    else navigate({ name: 'ask', q }, { replace: true })
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    submit(input)
  }

  const results = useMemo(
    () => (current ? search(current.q, state) : []),
    [current, state],
  )
  const re = useMemo(() => (current ? termRegex(termsOf(current.q)) : null), [current])

  const clear = () => {
    setInput('')
    setCurrent(null)
    if (routeQ) navigate({ name: 'ask' }, { replace: true })
    inputRef.current?.focus()
  }

  const typing = focused && norm(input).length >= 2 && (!current || keyOf(input) !== keyOf(current.q))
  const earlier = history.filter(h => h.id !== current?.id)

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-5 pb-24 sm:px-6 md:pt-8">
        <div className="flex flex-col gap-3">
          <h1 className="sr-only font-display text-3xl font-semibold md:not-sr-only">Search &amp; Ask</h1>
          <form
            onSubmit={onSubmit}
            role="search"
            className="relative"
            // The jump-to list stays open while focus is anywhere inside the form.
            onFocus={() => setFocused(true)}
            onBlur={e => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false)
            }}
            onKeyDown={e => {
              if (e.key === 'Escape') setFocused(false)
            }}
          >
            <label htmlFor="ask-input" className="sr-only">Ask a question or search</label>
            <div className="flex h-14 items-center gap-2 rounded-2xl border border-line bg-surface pr-2 pl-4 shadow-card transition focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
              <Sparkles size={20} className="shrink-0 text-agent" aria-hidden />
              <input
                id="ask-input"
                ref={inputRef}
                autoFocus={!routeQ}
                value={input}
                onChange={e => {
                  setInput(e.target.value)
                  setFocused(true)
                }}
                placeholder="Ask a question or search…"
                autoComplete="off"
                enterKeyHint="search"
                className="h-full min-w-0 flex-1 bg-transparent text-base text-fg placeholder:text-muted"
                style={{ outline: 'none' }} // the field's frame shows focus instead
              />
              {input && (
                <IconButton type="button" label="Clear" className="size-9 text-muted" onClick={clear}>
                  <X size={18} />
                </IconButton>
              )}
              <button
                type="submit"
                aria-label="Ask"
                disabled={!norm(input)}
                className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-accent-fg transition hover:brightness-105 disabled:bg-surface-2 disabled:text-muted"
              >
                <ArrowUp size={20} />
              </button>
            </div>
            {typing && <JumpTo q={input} onAsk={() => submit(input)} />}
          </form>

          {earlier.length > 0 && (
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-xs font-medium text-muted">Asked earlier</span>
              <div className="-my-1 flex min-w-0 flex-1 gap-1.5 overflow-x-auto py-1">
                {earlier.map(h => (
                  <button
                    key={h.id}
                    onClick={() => submit(h.q)}
                    className="inline-flex max-w-64 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-xs text-fg transition hover:border-muted"
                  >
                    <RotateCcw size={12} className="shrink-0 text-muted" aria-hidden />
                    <span className="truncate">{h.q}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {!current ? (
          <Idle onAsk={submit} />
        ) : (
          <>
            <section aria-labelledby="ask-q" className="flex flex-col gap-3">
              <h2 id="ask-q" className="font-display text-xl leading-snug font-semibold sm:text-2xl">{current.q}</h2>
              <AnswerCard key={current.id} entry={current} hasResults={results.length > 0} onAsk={submit} />
            </section>
            <Results results={results} re={re} filter={filter} setFilter={setFilter} q={current.q} />
          </>
        )}
      </div>
    </div>
  )
}

// ── Idle state ───────────────────────────────────────────────────────────────
function Idle({ onAsk }: { onAsk: (q: string) => void }) {
  return (
    <div className="anim-in flex flex-col gap-6">
      <section>
        <SectionTitle>Try asking</SectionTitle>
        <ul className="overflow-hidden rounded-2xl border border-line bg-surface">
          {askSuggestions.map((s, i) => (
            <li key={s} className={cx(i > 0 && 'border-t border-line')}>
              <button onClick={() => onAsk(s)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-surface-2">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-agent-soft text-agent"><Sparkles size={15} aria-hidden /></span>
                <span className="min-w-0 flex-1">{s}</span>
                <ChevronRight size={16} className="shrink-0 text-muted" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="flex gap-3 rounded-2xl bg-surface-2 px-4 py-4 text-sm">
        <ShieldCheck size={20} className="mt-0.5 shrink-0 text-agent" aria-hidden />
        <div className="min-w-0">
          <p className="font-semibold">Only what you can open</p>
          <p className="mt-0.5 text-muted">
            Answers and results come from messages, meeting transcripts, docs and files, tasks and people you already have access to. Every claim links to its source. Restricted rooms, like HR and performance 1:1s, are never searched.
          </p>
        </div>
      </section>
    </div>
  )
}

// ── Jump to (SRCH-06) ────────────────────────────────────────────────────────
function JumpTo({ q, onAsk }: { q: string; onAsk: () => void }) {
  const { state, navigate, openItem } = useStore()
  const matches = useMemo(() => {
    const terms = termsOf(q)
    const re = termRegex(terms.length ? terms : [norm(q).toLowerCase()], 'i')
    if (!re) return []
    const out: { key: string; label: string; sub: string; icon: ReactNode; go: () => void }[] = []
    for (const c of state.conversations) {
      if (c.kind !== 'channel' && c.kind !== 'group') continue
      if (re.test(c.name)) out.push({ key: c.id, label: conversationLabel(c), sub: c.kind === 'channel' ? 'Channel' : 'Group', icon: <Hash size={16} />, go: () => navigate({ name: 'chats', conversationId: c.id }) })
    }
    for (const p of people) {
      if (p.kind === 'assistant' || !re.test(p.name)) continue
      const conv = directConversation(state.conversations, p.id)
      if (!conv) continue
      out.push({ key: p.id, label: p.name, sub: p.kind === 'agent' ? 'Agent' : p.title, icon: <Avatar id={p.id} size="xs" />, go: () => navigate({ name: 'chats', conversationId: conv.id }) })
    }
    // Drive files and folders you can open, by name.
    for (const e of driveEntries(state)) {
      if (!re.test(e.item.title) || isTrashed(state.folders, e.item) || !canOpen(state, e)) continue
      const sub = `${kindLabel[e.kind]} · ${driveLocation(state, e)}`
      out.push({ key: e.item.id, label: e.item.title, sub, icon: <KindIcon kind={e.kind} size="sm" />, go: () => openItem(e.item.id) })
    }
    return out.slice(0, 5)
  }, [q, state, navigate, openItem])

  // Keep focus in the input while clicking an option.
  const keep = (e: MouseEvent) => e.preventDefault()
  return (
    <div className="anim-in absolute inset-x-0 top-full z-20 mt-2 overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
      <button type="button" onMouseDown={keep} onClick={onAsk} className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-surface-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-agent-soft text-agent"><Sparkles size={14} aria-hidden /></span>
        <span className="min-w-0 flex-1 truncate">Ask “{norm(q)}”</span>
        <span className="hidden shrink-0 text-xs text-muted sm:inline">Enter</span>
      </button>
      {matches.length > 0 && (
        <>
          <p className="border-t border-line px-4 pt-2.5 pb-1 text-[11px] font-bold tracking-[0.08em] text-muted uppercase">Jump to</p>
          <ul className="pb-1">
            {matches.map(m => (
              <li key={m.key}>
                <button type="button" onMouseDown={keep} onClick={m.go} className="flex w-full items-center gap-3 px-4 py-2 text-left transition hover:bg-surface-2">
                  <span className="grid size-7 shrink-0 place-items-center text-muted">{m.icon}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{m.label}</span>
                  <span className="max-w-[45%] shrink-0 truncate text-xs text-muted">{m.sub}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

// ── Answer ───────────────────────────────────────────────────────────────────
function AnswerCard({ entry, hasResults, onAsk }: { entry: Entry; hasResults: boolean; onAsk: (q: string) => void }) {
  const restricted = entry.matched && entry.sources.length === 0
  // An honest fallback: when nothing answers the question but keyword search
  // still finds the words, say so instead of claiming nothing exists. A couple
  // of words without a question mark reads as a search, so say what's below.
  const keywordsOnly = !entry.q.includes('?') && entry.q.split(' ').length <= 3
  const text = entry.matched
    ? entry.answer
    : !hasResults
      ? askFallback
      : keywordsOnly
        ? `Here’s everything you can open that mentions “${entry.q}”. Ask me a full question and I’ll answer it with sources.`
        : 'I couldn’t find a clear answer to that. Some of the words appear in the results below, so one of them may help. You can also try asking in a different way.'
  // Citation markers sit right after the word they support: "month[1]."
  const words = useMemo(() => text.replace(/\s+(\[\d+\])/g, '$1').split(' '), [text])
  const instant = revealed.has(keyOf(entry.q)) || prefersReducedMotion()
  const [thinking, setThinking] = useState(!instant)
  const [shown, setShown] = useState(instant ? words.length : 0)
  const done = !thinking && shown >= words.length

  useEffect(() => {
    if (instant) return
    let timer = 0
    const start = window.setTimeout(() => {
      setThinking(false)
      const step = Math.max(1, Math.ceil(words.length / 60))
      const every = Math.max(16, Math.round(1200 / Math.ceil(words.length / step)))
      timer = window.setInterval(() => {
        setShown(n => {
          const next = Math.min(words.length, n + step)
          if (next >= words.length) {
            window.clearInterval(timer)
            revealed.add(keyOf(entry.q))
          }
          return next
        })
      }, every)
    }, 450)
    return () => {
      window.clearTimeout(start)
      window.clearInterval(timer)
    }
  }, [instant, words, entry.q])

  return (
    <article className="anim-in overflow-hidden rounded-2xl border border-line bg-surface" aria-busy={!done}>
      <div className="flex flex-wrap items-center gap-2 px-4 pt-4">
        <Avatar id={ASSISTANT} size="sm" />
        <span className="text-sm font-semibold">Your assistant</span>
        <AIMarker label="Answer" />
        {restricted && <Pill tone="warn" icon={<Lock size={10} aria-hidden />}>Restricted</Pill>}
      </div>
      <div className="px-4 pt-3 pb-4" aria-live="polite">
        {thinking ? (
          <p className="flex items-center gap-2 text-muted">
            <Search size={16} className="anim-pulse" aria-hidden />
            Looking through what you can open…
          </p>
        ) : (
          <CitedText text={words.slice(0, shown).join(' ')} className={cx('text-[16px] leading-relaxed', !entry.matched && 'text-muted')} />
        )}
        {done && restricted && (
          <p className="anim-in mt-3 flex items-start gap-2 text-sm text-muted">
            <ShieldCheck size={16} className="mt-0.5 shrink-0 text-agent" aria-hidden />
            <span className="min-w-0">Restricted rooms are left out of the search results below as well.</span>
          </p>
        )}
        {done && entry.sources.length > 0 && (
          <div className="anim-in mt-4">
            <p className="mb-1.5 text-[11px] font-bold tracking-[0.08em] text-muted uppercase">Sources</p>
            <SourceChips sources={entry.sources} />
          </div>
        )}
        {done && !entry.matched && (
          <div className="anim-in mt-4">
            <p className="mb-1.5 text-[11px] font-bold tracking-[0.08em] text-muted uppercase">Try one of these</p>
            <div className="flex flex-wrap gap-1.5">
              {askSuggestions.slice(0, 3).map(s => (
                <button key={s} onClick={() => onAsk(s)} className="max-w-full truncate rounded-full border border-line bg-surface px-3 py-1 text-xs transition hover:border-agent hover:text-agent">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-line py-1 pr-2 pl-4">
        <Lock size={13} className="shrink-0 text-muted" aria-hidden />
        <p className="min-w-0 flex-1 text-[11px] text-muted sm:text-xs">Answered only from what you can open.</p>
        {done && <Feedback />}
      </div>
    </article>
  )
}

// ── Keyword results ──────────────────────────────────────────────────────────
function Results({ results, re, filter, setFilter, q }: { results: SearchResult[]; re: RegExp | null; filter: Filter; setFilter: (f: Filter) => void; q: string }) {
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: results.length, messages: 0, docs: 0, meetings: 0, tasks: 0, people: 0 }
    for (const r of results) c[r.group]++
    return c
  }, [results])

  const groups = groupOrder.filter(g => counts[g] > 0 && (filter === 'all' || filter === g))

  return (
    <section aria-labelledby="results-title" className="anim-in flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="results-title" className="text-[11px] font-bold tracking-[0.08em] text-muted uppercase">
          Search results <span className="text-fg tabular">{results.length}</span>
        </h2>
      </div>
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0" role="group" aria-label="Filter results">
        <div className="flex w-max gap-1.5">
          {filters.map(f => (
            <button
              key={f.value}
              aria-pressed={filter === f.value}
              disabled={f.value !== 'all' && counts[f.value] === 0}
              onClick={() => setFilter(f.value)}
              className={cx(
                'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition disabled:opacity-40',
                filter === f.value ? 'border-fg bg-fg text-bg' : 'border-line bg-surface text-fg hover:border-muted',
              )}
            >
              {f.label}
              <span className={cx('tabular text-xs', filter === f.value ? 'opacity-70' : 'text-muted')}>{counts[f.value]}</span>
            </button>
          ))}
        </div>
      </div>

      {results.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
          No messages, files, meetings, tasks or people match “{q}”.
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map(g => {
            const items = results.filter(r => r.group === g)
            const shown = filter === 'all' ? items.slice(0, 3) : items
            return (
              <div key={g}>
                {filter === 'all' && (
                  <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
                    <h3 className="text-sm font-semibold">{groupLabel[g]}</h3>
                    {items.length > shown.length && (
                      <button onClick={() => setFilter(g)} className="text-xs font-medium text-accent-ink hover:underline">
                        Show all {items.length}
                      </button>
                    )}
                  </div>
                )}
                <ul className="overflow-hidden rounded-2xl border border-line bg-surface">
                  {shown.map((r, i) => (
                    <li key={r.id} className={cx(i > 0 && 'border-t border-line')}>
                      <ResultRow r={r} re={re} />
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function ResultRow({ r, re }: { r: SearchResult; re: RegExp | null }) {
  const { navigate, openItem } = useStore()
  const Icon = r.icon === 'person' ? null : resultIcons[r.icon]
  // Messages are short ("Rachel · #sales · 8:15 am"), so they fit on one line.
  // Longer titles get their context on a line of its own.
  const inline = r.group === 'messages'
  const context = r.context && r.context !== r.title ? r.context : undefined
  const sub = [context, r.meta].filter(Boolean).join(' · ')
  const body = (
    <>
      {r.personId ? (
        <Avatar id={r.personId} size="md" className="mt-0.5" />
      ) : (
        Icon && (
          <span className={cx('mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl', resultTone[r.icon] ?? 'bg-surface-2 text-muted')}>
            <Icon size={17} aria-hidden />
          </span>
        )
      )}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate font-semibold">
            <Highlight text={r.title} re={re} />
          </span>
          {r.agent && <AgentBadge />}
          {inline && context && <span className="min-w-0 truncate text-xs text-muted">{context}</span>}
          {inline && r.meta && <span className="ml-auto shrink-0 pl-1 text-xs text-muted">{r.meta}</span>}
        </span>
        {!inline && sub && <span className="block truncate text-xs text-muted">{sub}</span>}
        {r.snippet && (
          <span className="mt-0.5 line-clamp-2 text-sm text-muted">
            <Highlight text={r.snippet} re={re} />
          </span>
        )}
      </span>
    </>
  )
  if (!r.route) return <div className="flex gap-3 px-4 py-3">{body}</div>
  return (
    <button onClick={() => (r.driveId ? openItem(r.driveId) : navigate(r.route!))} className="flex w-full gap-3 px-4 py-3 text-left transition hover:bg-surface-2">
      {body}
    </button>
  )
}
