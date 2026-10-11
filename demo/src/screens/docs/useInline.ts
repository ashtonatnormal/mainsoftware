// Bold, italic, underline and strikethrough for the open doc: what the
// selection (or caret) is styled as, for the toolbars' pressed states, and
// toggling a mark. With text selected a toggle changes it at once (one undo
// step); with a collapsed caret it sets the style for what you type next,
// until you move the caret.
import { useCallback, useEffect, useRef, useState } from 'react'
import { getSel, isBlockEl, keyOfEl } from './dom'
import { caretMarks, marksOf, rangeHas, rangeMarks, runsOf, sameMarks, setMark, withRuns, type Mark, type Marks } from './runs'
import type { DocDraft } from './useDocDraft'

export interface InlineState { key: string; marks: Marks; range: boolean }
interface Where { key: string; start: number; end: number }

export function useInline(draft: DocDraft, enabled: boolean) {
  const [state, setState] = useState<InlineState | null>(null)
  const pending = useRef<{ key: string; at: number; marks: Marks } | null>(null)
  const last = useRef<Where | null>(null)
  const itemsRef = draft.itemsRef

  /** The selection, when it's in one of the doc's lines. */
  const where = (): Where | null => {
    const el = document.activeElement
    if (!isBlockEl(el)) return null
    const s = getSel(el)
    return s ? { key: keyOfEl(el), ...s } : null
  }

  const refresh = useCallback(() => {
    const here = where()
    if (here) last.current = here
    const w = here ?? last.current
    const it = w && itemsRef.current.find(i => i.key === w.key)
    if (!w || !it) { setState(null); return }
    const p = pending.current
    if (p && p.key !== w.key) pending.current = null
    const runs = runsOf(it.block)
    const len = it.block.text.length
    const start = Math.min(w.start, len)
    const end = Math.min(w.end, len)
    const range = start !== end
    const marks = range ? rangeMarks(runs, start, end) : p && p.key === w.key && p.at === start ? marksOf(p.marks) : caretMarks(runs, start)
    setState(prev => (prev && prev.key === w.key && prev.range === range && sameMarks(prev.marks, marks) ? prev : { key: w.key, marks, range }))
  }, [itemsRef])

  useEffect(() => {
    if (!enabled) {
      pending.current = null
      last.current = null
      setState(null)
      return
    }
    document.addEventListener('selectionchange', refresh)
    return () => document.removeEventListener('selectionchange', refresh)
  }, [enabled, refresh])

  // Formatting or typing changes what the caret sits in.
  useEffect(() => {
    if (enabled) refresh()
  }, [enabled, draft.items, refresh])

  const toggle = (mark: Mark) => {
    const w = where() ?? last.current
    if (!w) return
    const items = itemsRef.current
    const idx = items.findIndex(i => i.key === w.key)
    if (idx === -1) return
    const it = items[idx]
    const runs = runsOf(it.block)
    const len = it.block.text.length
    const start = Math.min(w.start, len)
    const end = Math.min(w.end, len)
    if (start !== end) {
      const block = withRuns(it.block, setMark(runs, start, end, mark, !rangeHas(runs, start, end, mark)))
      draft.change(items.map((x, i) => (i === idx ? { ...x, block } : x)), { focus: { key: w.key, caret: start, end } })
      return
    }
    const p = pending.current
    const base = p && p.key === w.key && p.at === start ? p.marks : caretMarks(runs, start)
    pending.current = { key: w.key, at: start, marks: { ...marksOf(base), [mark]: !base[mark] } }
    if (!where()) draft.focus({ key: w.key, caret: start })
    refresh()
  }

  /** The style set for the caret, used up by text typed there. Any edit in that line clears it. */
  const consume = (key: string, at: number): Marks | undefined => {
    const p = pending.current
    if (!p || p.key !== key) return undefined
    pending.current = null
    return p.at === at ? marksOf(p.marks) : undefined
  }

  /** Called alongside an edit that moves the caret (to key/at); the toolbars catch up after it renders. */
  const setPending = (key: string, at: number, marks: Marks) => {
    pending.current = { key, at, marks: marksOf(marks) }
  }

  const clearPending = () => {
    if (!pending.current) return
    pending.current = null
    refresh()
  }

  return { state, toggle, consume, setPending, clearPending }
}

export type Inline = ReturnType<typeof useInline>
