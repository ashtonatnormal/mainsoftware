// "Ask about this sheet" panel (DOC-12, D16). Suggest-only: answers are worked
// out from the cells and link back to them; a suggested formula goes in only
// when the person accepts it.
import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Grid3x3, Lock, Sigma, Sparkles } from 'lucide-react'
import type { Sheet, SheetTab } from '../../types'
import { AIMarker, Button, cx, Feedback } from '../../ui'
import { addrOf, type Pos } from './formula'
import { answerQuestion, suggestedQuestions, suggestFormula, type CellRef, type SheetAnswer } from './ask'

export interface AskEntry { id: number; q: string; a: SheetAnswer; tabName: string }
/** Questions asked this visit, per sheet, so they survive closing the panel. */
const threads = new Map<string, AskEntry[]>()
let seq = 0

export function AskPanel({ sheet, tab, active, canEdit, onRef, onAcceptFormula, className }: {
  sheet: Sheet
  tab: SheetTab
  active: Pos
  canEdit: boolean
  onRef: (r: CellRef) => void
  onAcceptFormula: (addr: string, formula: string) => void
  className?: string
}) {
  const [entries, setEntries] = useState<AskEntry[]>(() => threads.get(sheet.id) ?? [])
  const [q, setQ] = useState('')
  const [dismissed, setDismissed] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { threads.set(sheet.id, entries) }, [sheet.id, entries])
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [entries.length])

  const ask = (text: string) => {
    const t = text.trim()
    if (!t) return
    setEntries(e => [...e, { id: ++seq, q: t, a: answerQuestion(sheet, tab, t), tabName: tab.name }])
    setQ('')
  }

  const addr = addrOf(active)
  const suggestion = canEdit ? suggestFormula(tab, active) : null
  const showSuggestion = suggestion && dismissed !== `${tab.id}:${addr}:${suggestion.formula}`

  return (
    <div className={cx('flex min-h-0 flex-col', className)}>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <div className="flex items-start gap-2 text-[13px] text-muted">
          <Lock size={14} className="mt-0.5 shrink-0" aria-hidden />
          <p>Answers are worked out from the cells in this sheet. Nothing changes unless you accept it.</p>
        </div>

        {/* Suggest a formula for the selected empty cell. */}
        <section aria-labelledby="sheet-suggest-h" className="rounded-2xl border border-line bg-surface p-3">
          <div className="mb-1.5 flex items-center gap-2">
            <Sigma size={15} className="text-agent" aria-hidden />
            <h3 id="sheet-suggest-h" className="flex-1 text-sm font-semibold">Suggest a formula</h3>
            {showSuggestion && <AIMarker label="Suggestion" />}
          </div>
          {showSuggestion ? (
            <div className="space-y-2">
              <p className="text-[13px] text-muted">For <b className="text-fg">{addr}</b>:</p>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-xl bg-agent-soft px-3 py-2">
                <code className="font-mono text-[13px] font-semibold break-all text-agent">{suggestion.formula}</code>
                <span className="text-[13px] text-muted tabular">= {suggestion.preview}</span>
              </div>
              <p className="text-[13px]">{suggestion.why}</p>
              <RefChips refs={suggestion.refs} onRef={onRef} />
              <div className="flex gap-2 pt-1">
                <Button size="sm" variant="primary" onClick={() => onAcceptFormula(addr, suggestion.formula)}>Accept</Button>
                <Button size="sm" variant="ghost" onClick={() => setDismissed(`${tab.id}:${addr}:${suggestion.formula}`)}>Discard</Button>
              </div>
            </div>
          ) : (
            <p className="text-[13px] text-muted">
              {canEdit ? 'Select an empty cell under a column of numbers and I’ll suggest a formula for it.' : 'Only people who can edit this sheet can add formulas.'}
            </p>
          )}
        </section>

        <section aria-label="Suggested questions">
          <p className="mb-2 text-[11px] font-bold tracking-[0.08em] text-muted uppercase">Try asking</p>
          <div className="flex flex-wrap gap-1.5">
            {suggestedQuestions(sheet, tab).map(s => (
              <button key={s} onClick={() => ask(s)} className="rounded-2xl border border-line bg-surface px-3 py-1.5 text-left text-[13px] transition hover:border-agent hover:text-agent">
                {s}
              </button>
            ))}
          </div>
        </section>

        {entries.map(e => (
          <article key={e.id} className="anim-in space-y-2">
            <p className="ml-auto w-fit max-w-[90%] rounded-2xl rounded-br-md bg-accent-soft px-3 py-2 text-sm">{e.q}</p>
            <div className="space-y-2 rounded-2xl rounded-bl-md border border-line bg-surface p-3">
              <div className="flex items-center gap-2">
                <AIMarker label="Answer" />
                <span className="min-w-0 truncate text-[11px] text-muted">from “{e.tabName}”</span>
              </div>
              <p className="text-sm leading-relaxed">{e.a.text}</p>
              <RefChips refs={e.a.refs} onRef={onRef} />
              <Feedback />
            </div>
          </article>
        ))}
        <div ref={endRef} />
      </div>
      <form
        className="flex shrink-0 items-center gap-2 border-t border-line bg-surface px-3 py-2.5"
        onSubmit={e => { e.preventDefault(); ask(q) }}
      >
        <label htmlFor="sheet-ask-input" className="sr-only">Ask about this sheet</label>
        <input
          id="sheet-ask-input"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Ask about this sheet…"
          autoComplete="off"
          className="h-10 min-w-0 flex-1 rounded-full bg-surface-2 px-4 text-sm outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-agent"
        />
        <button type="submit" aria-label="Ask" disabled={!q.trim()} className="grid size-10 shrink-0 place-items-center rounded-full bg-agent text-white transition disabled:opacity-40">
          <ArrowUp size={18} />
        </button>
      </form>
    </div>
  )
}

function RefChips({ refs, onRef }: { refs: CellRef[]; onRef: (r: CellRef) => void }) {
  if (!refs.length) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {refs.map((r, i) => (
        <button
          key={i}
          onClick={() => onRef(r)}
          title={`Select ${r.label}`}
          className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-0.5 font-mono text-xs text-fg transition hover:border-agent hover:text-agent"
        >
          <Grid3x3 size={11} className="text-muted" aria-hidden />
          {r.label}
        </button>
      ))}
    </div>
  )
}

export const AskTitle = () => (
  <span className="flex items-center gap-2"><Sparkles size={17} className="text-agent" aria-hidden />Ask about this sheet</span>
)
