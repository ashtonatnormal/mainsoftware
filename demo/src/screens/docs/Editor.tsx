// The doc body (DOC-01). Editing: every block is a contentEditable line laid
// over a mirror of its text, so comment highlights and live cursors still show.
// Lines hold inline formatting (bold, italic, underline, strikethrough) as runs;
// the browser only ever types plain text into them and the model decides the
// style, so the caret stays put through re-renders and saves. Enter splits,
// Backspace merges, arrows move between blocks, "/" opens the block menu and
// Markdown shortcuts change the type (# , - , [] , > ) or the style (**bold**,
// *italic*, _italic_, ~~strikethrough~~). Viewing: the same layout, read-only,
// with clickable comment highlights and select-to-comment (DOC-05).
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type HTMLAttributes, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { Check, Heading1, Heading2, List, ListChecks, MessageSquarePlus, Pilcrow, TextQuote } from 'lucide-react'
import type { Doc, DocBlock, DocComment, DocRun, PersonId } from '../../types'
import { personById } from '../../data/people'
import { cx, personName } from '../../ui'
import { newKey, nextType, parseLines, shortcutFor, typeHints, typeLabels, withType, blockOrder, type BlockType, type Item } from './model'
import { addMarks, applyInlineShortcut, caretMarks, concatRuns, editRuns, inlineShortcut, MARKS, marksAt, runsOf, runsText, sliceRuns, spliceRuns, textChange, withRuns, type Mark } from './runs'
import { blockEl, caretLines, EDITABLE, getSel, isBlockEl, offsetOf, readText, setSel, syncRuns } from './dom'
import { blocksFromHTML, blocksToHTML, inlineHTML } from './clipboard'
import type { DocDraft, Focus } from './useDocDraft'
import type { Inline } from './useInline'

export { blockEl }

export const typeIcons: Record<BlockType, typeof Pilcrow> = { p: Pilcrow, h1: Heading1, h2: Heading2, li: List, todo: ListChecks, quote: TextQuote }

export interface SlashAction { id: string; label: string; hint: string; icon: ReactNode; run: (key: string) => void }

/** Text styles per block type, shared by the editable line, its mirror and the read-only view. */
export function textCls(b: DocBlock) {
  const inline = '[&_u]:underline-offset-[0.18em] [&_s]:decoration-[0.08em]'
  switch (b.type) {
    case 'h1': return cx('font-display text-[26px] leading-tight font-semibold sm:text-[30px]', inline)
    case 'h2': return cx('font-display text-xl leading-snug font-semibold', inline)
    // Italic inside a quote reads as upright, the usual way to emphasise within italics.
    case 'quote': return cx('text-[16px] leading-relaxed italic text-muted [&_em]:not-italic', inline)
    default: return cx('text-[16px] leading-relaxed', b.type === 'todo' && b.done && 'text-muted', inline)
  }
}

/** One run with its marks, nested the same way the editable line writes them. */
function Run({ r }: { r: DocRun }) {
  let n: ReactNode = r.text
  if (r.s) n = <s>{n}</s>
  if (r.u) n = <u>{n}</u>
  if (r.i) n = <em>{n}</em>
  if (r.b) n = <strong>{n}</strong>
  return <>{n}</>
}
export const RunText = ({ runs }: { runs: DocRun[] }) => <>{runs.map((r, i) => <Run key={i} r={r} />)}</>

function gapCls(prev: DocBlock | undefined, b: DocBlock) {
  if (!prev) return ''
  if (b.type === 'h1') return 'mt-6'
  if (b.type === 'h2') return 'mt-7'
  if ((b.type === 'li' || b.type === 'todo') && prev.type === b.type) return 'mt-1.5'
  if (prev.type === 'h1' || prev.type === 'h2') return 'mt-2.5'
  return 'mt-3'
}

/** Splits text around open comment anchors. */
function segments(text: string, comments: DocComment[]): { text: string; id?: string }[] {
  let pool = comments.filter(c => !c.resolved && c.anchor && text.includes(c.anchor))
  const out: { text: string; id?: string }[] = []
  let rest = text
  while (rest) {
    let best: { i: number; c: DocComment } | null = null
    for (const c of pool) {
      const i = rest.indexOf(c.anchor)
      if (i !== -1 && (!best || i < best.i)) best = { i, c }
    }
    if (!best) { out.push({ text: rest }); break }
    const hit = best
    if (hit.i) out.push({ text: rest.slice(0, hit.i) })
    out.push({ text: hit.c.anchor, id: hit.c.id })
    rest = rest.slice(hit.i + hit.c.anchor.length)
    pool = pool.filter(c => c !== hit.c)
  }
  return out
}

/** A collaborator's simulated caret with a name tag (DOC-02). */
export function CursorFlag({ personId }: { personId: PersonId }) {
  const p = personById[personId]
  if (!p) return null
  const color = `oklch(0.58 0.12 ${p.hue})`
  return (
    <span data-ui className="relative inline-block h-[1.15em] w-0 align-[-0.2em]" role="img" aria-label={`${p.short} is editing here`}>
      <span className="anim-pulse absolute inset-y-0 left-0 w-0.5 rounded-full" style={{ background: color }} aria-hidden />
      <span className="absolute top-1/2 left-1.5 -translate-y-1/2 rounded px-1 py-0.5 font-sans text-[10px] leading-none font-semibold whitespace-nowrap text-white not-italic" style={{ background: color }} aria-hidden>{p.short}</span>
    </span>
  )
}

/** Sets a block's type from the toolbars, keeping the caret where it was. */
export function applyType(draft: DocDraft, key: string | null, type: BlockType) {
  const items = draft.itemsRef.current
  const idx = items.findIndex(i => i.key === key)
  if (idx === -1) return
  const it = items[idx]
  const el = blockEl(it.key)
  const sel = el && document.activeElement === el ? getSel(el) : null
  const next = it.block.type === type && type !== 'p' ? withType(it.block, 'p') : withType(it.block, type)
  draft.change(items.map((x, i) => (i === idx ? { ...x, block: next } : x)), { focus: sel ? { key: it.key, caret: sel.start, end: sel.end } : { key: it.key, caret: 'end' } })
}

interface EditorProps {
  doc: Doc
  draft: DocDraft
  mode: 'edit' | 'view'
  editable: boolean
  commentable: boolean
  cursor?: { key: string; personId: PersonId }
  focusComment: string | null
  onAnchor: (commentId: string, passive?: boolean) => void
  onActive: (key: string) => void
  onSelectText: (sel: { key: string; text: string } | null) => void
  onComment: (anchor: string) => void
  /** Bold, italic, underline and strikethrough: the caret's style and toggling it. */
  inline: Inline
  slashActions: SlashAction[]
  afterTitle?: ReactNode
  /** Shown under one block, e.g. an AI suggestion that will go in there. */
  afterBlock?: { key: string; node: ReactNode } | null
  end?: ReactNode
}

export default function Editor(props: EditorProps) {
  const { doc, draft, mode, editable, commentable, cursor, focusComment, onAnchor, onActive, onSelectText, onComment, inline, slashActions, afterTitle, afterBlock, end } = props
  const editing = mode === 'edit' && editable
  const [focused, setFocused] = useState<string | null>(null)
  const [slash, setSlash] = useState<{ key: string; index: number } | null>(null)
  // A "/" menu closed with Escape stays closed until "/" is typed into an empty block again.
  const slashDismissed = useRef<string | null>(null)
  const [pick, setPick] = useState<{ text: string; x: number; y: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const items = draft.items
  const comments = doc.comments

  // While an input method is composing (phone keyboards, Chinese and Japanese input)
  // the line is left alone; it's read once the composition ends.
  const composing = useRef(false)

  // Apply a pending caret move after each render. Lines have already written their text.
  useLayoutEffect(() => {
    const f = draft.focusReq.current
    if (!f) return
    const el = blockEl(f.key)
    if (!el) return
    draft.focusReq.current = null
    el.focus()
    const len = readText(el).length
    const c = f.caret === 'end' ? len : Math.min(f.caret, len)
    setSel(el, c, f.end === undefined ? c : Math.max(c, Math.min(f.end, len)))
  })

  useEffect(() => {
    if (slash) menuRef.current?.scrollIntoView({ block: 'nearest' })
  }, [slash])

  // Viewing: select text inside one block to comment on it.
  useEffect(() => {
    if (editing || !commentable) { setPick(null); return }
    const read = () => {
      const sel = document.getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount || !rootRef.current) { setPick(null); return }
      const host = (n: Node | null) => (n?.nodeType === 3 ? n.parentElement : (n as Element | null))?.closest('[data-block-key]')
      const a = host(sel.anchorNode)
      const b = host(sel.focusNode)
      const text = sel.toString().replace(/\s+/g, ' ').trim()
      const block = items.find(i => i.key === a?.getAttribute('data-block-key'))?.block
      if (!a || a !== b || !rootRef.current.contains(a) || text.length < 2 || text.length > 160 || !block?.text.includes(text)) { setPick(null); return }
      const r = sel.getRangeAt(0).getBoundingClientRect()
      setPick({ text, x: Math.min(Math.max(r.left + r.width / 2, 70), window.innerWidth - 70), y: r.bottom + 8 })
    }
    document.addEventListener('selectionchange', read)
    window.addEventListener('scroll', read, true)
    return () => {
      document.removeEventListener('selectionchange', read)
      window.removeEventListener('scroll', read, true)
    }
  }, [editing, commentable, items])

  const set = (next: Item[], focus?: Focus, typing?: string) => draft.change(next, { focus, typing })
  const withBlock = (key: string, block: DocBlock) => draft.itemsRef.current.map(i => (i.key === key ? { ...i, block } : i))

  const slashFor = (text: string): SlashOption[] => {
    const q = text.slice(1).trim().toLowerCase()
    const types: SlashOption[] = blockOrder.map(t => {
      const Icon = typeIcons[t]
      return { id: t, label: typeLabels[t], hint: typeHints[t], icon: <Icon size={16} />, type: t }
    })
    return [...types, ...slashActions].filter(o => !q || o.label.toLowerCase().includes(q) || (!!o.hint && o.hint.startsWith(q)))
  }

  const chooseSlash = (key: string, option: SlashOption) => {
    const cur = draft.itemsRef.current
    setSlash(null)
    if (option.type) {
      set(cur.map(i => (i.key === key ? { ...i, block: withType(withRuns(i.block, []), option.type!) } : i)), { key, caret: 0 })
    } else {
      set(cur.map(i => (i.key === key ? { ...i, block: withRuns(i.block, []) } : i)), { key, caret: 0 })
      option.run?.(key)
    }
  }

  /**
   * After the browser has typed, deleted or autocorrected text in a line: work
   * out what changed in the plain text, apply it to the runs (new text takes
   * the caret's style), then look for Markdown and "/" shortcuts.
   */
  const sync = (it: Item, el: HTMLElement, inputType?: string, data?: string | null) => {
    const cur = draft.itemsRef.current.find(i => i.key === it.key)
    if (!cur) return
    const runs = runsOf(cur.block)
    const prev = cur.block.text
    const shown = readText(el)
    const sel = getSel(el)
    const ch = textChange(prev, shown, sel ? sel.end : shown.length)
    if (!ch) {
      // Only the markup changed (a browser's own formatting): put the line back as the model has it.
      syncRuns(el, runs)
      return
    }
    const marks = inline.consume(it.key, ch.start) ?? (ch.removed ? marksAt(runs, ch.start) : caretMarks(runs, ch.start))
    const heading = cur.block.type === 'h1' || cur.block.type === 'h2'
    const inserted = heading ? ch.inserted.replace(/\n/g, ' ') : ch.inserted
    const caret = ch.start + inserted.length
    let block = withRuns(cur.block, editRuns(runs, ch.start, ch.start + ch.removed, inserted, marks))
    let focus: Focus | undefined
    const sc = shortcutFor(prev, block.text)
    if (sc && caret === sc.strip) {
      block = withType(withRuns(block, sliceRuns(runsOf(block), sc.strip)), sc.type)
      focus = { key: it.key, caret: 0 }
    } else if (inputType === 'insertText' && data?.length === 1 && !ch.removed) {
      const md = inlineShortcut(block.text, caret, data)
      if (md) {
        // The closing marker goes in as typed first, so Undo brings back the plain **text**.
        set(withBlock(it.key, block), undefined, it.key)
        const r = applyInlineShortcut(runsOf(block), md)
        set(withBlock(it.key, withRuns(block, r.runs)), { key: it.key, caret: r.caret })
        // What you type next goes back to the style around it.
        inline.setPending(it.key, r.caret, { ...caretMarks(r.runs, r.caret), [md.mark]: false })
        if (slash?.key === it.key) setSlash(null)
        return
      }
    }
    if (prev === '' && slashDismissed.current === it.key) slashDismissed.current = null
    if (block.text.startsWith('/') && !block.text.includes('\n') && block.text.length <= 24 && (prev === '' || prev.startsWith('/')) && slashDismissed.current !== it.key) {
      setSlash({ key: it.key, index: 0 })
    } else if (slash?.key === it.key) setSlash(null)
    set(withBlock(it.key, block), focus, focus ? undefined : it.key)
  }

  /** Puts text in place of [s, en) in the caret's style (a soft line break, for one). */
  const insertText = (it: Item, s: number, en: number, text: string) => {
    const cur = draft.itemsRef.current.find(i => i.key === it.key)
    if (!cur) return
    const runs = runsOf(cur.block)
    const marks = inline.consume(it.key, s) ?? (en > s ? marksAt(runs, s) : caretMarks(runs, s))
    set(withBlock(it.key, withRuns(cur.block, editRuns(runs, s, en, text, marks))), { key: it.key, caret: s + text.length })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>, it: Item) => {
    if (e.nativeEvent.isComposing || composing.current) return
    const el = e.currentTarget
    const all = draft.itemsRef.current
    const idx = all.findIndex(i => i.key === it.key)
    if (idx === -1) return
    const b = all[idx].block
    const sel = getSel(el)
    if (!sel) return
    const s = sel.start
    const en = sel.end
    const text = b.text
    const replaceAt = (i: number, block: DocBlock) => all.map((x, j) => (j === i ? { ...x, block } : x))

    if (slash?.key === it.key) {
      const opts = slashFor(text)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (opts.length) setSlash({ key: it.key, index: (slash.index + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length })
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && opts.length) {
        e.preventDefault()
        chooseSlash(it.key, opts[Math.min(slash.index, opts.length - 1)])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        slashDismissed.current = it.key
        setSlash(null)
        return
      }
    }

    const mod = e.metaKey || e.ctrlKey
    // Ctrl/Cmd+B, I and U, and Ctrl/Cmd+Shift+X for strikethrough.
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase()
      const mark: Mark | null = e.shiftKey ? (k === 'x' ? 's' : null) : k === 'b' ? 'b' : k === 'i' ? 'i' : k === 'u' ? 'u' : null
      if (mark) {
        e.preventDefault()
        inline.toggle(mark)
        return
      }
    }
    if (mod && !e.altKey && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
      e.preventDefault()
      if (e.key.toLowerCase() === 'y' || e.shiftKey) draft.redo()
      else draft.undo()
      return
    }

    // Ctrl/Cmd+Enter ticks a checklist item.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && b.type === 'todo') {
      e.preventDefault()
      set(replaceAt(idx, { ...b, done: !b.done }), { key: it.key, caret: s })
      return
    }

    if (e.key === 'Enter' && (!e.shiftKey || b.type === 'h1' || b.type === 'h2')) {
      e.preventDefault()
      enter(it, s, en)
      return
    }
    // Shift+Enter: a line break inside the block.
    if (e.key === 'Enter' && e.shiftKey && !mod) {
      e.preventDefault()
      insertText(it, s, en, '\n')
      return
    }

    if (e.key === 'Backspace' && s === 0 && en === 0) {
      e.preventDefault()
      backspaceAtStart(it)
      return
    }

    if (e.key === 'Delete' && s === text.length && en === s && idx < all.length - 1) {
      e.preventDefault()
      const nb = all[idx + 1]
      const merged = { ...it, block: withRuns(b, concatRuns(runsOf(b), runsOf(nb.block))) }
      set([...all.slice(0, idx), merged, ...all.slice(idx + 2)], { key: it.key, caret: s })
      return
    }

    // Moving the caret drops a style picked for the next thing you type.
    if (/^(Arrow|Home$|End$|Page)/.test(e.key)) inline.clearPending()
    if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return
    if (e.key === 'ArrowUp' && idx > 0 && s === en && (s === 0 || caretLines(el, s).first)) {
      e.preventDefault()
      draft.focus({ key: all[idx - 1].key, caret: 'end' })
    } else if (e.key === 'ArrowDown' && idx < all.length - 1 && s === en && (s === text.length || caretLines(el, s).last)) {
      e.preventDefault()
      draft.focus({ key: all[idx + 1].key, caret: 0 })
    } else if (e.key === 'ArrowLeft' && idx > 0 && s === 0 && en === 0) {
      e.preventDefault()
      draft.focus({ key: all[idx - 1].key, caret: 'end' })
    } else if (e.key === 'ArrowRight' && idx < all.length - 1 && s === text.length && en === s) {
      e.preventDefault()
      draft.focus({ key: all[idx + 1].key, caret: 0 })
    }
  }

  /** Enter: split the block at the caret (lists continue; an empty item becomes text). */
  const enter = (it: Item, s: number, en: number) => {
    const all = draft.itemsRef.current
    const idx = all.findIndex(i => i.key === it.key)
    if (idx === -1) return
    const b = all[idx].block
    const text = b.text
    const replaceAt = (i: number, block: DocBlock) => all.map((x, j) => (j === i ? { ...x, block } : x))
    const runs = runsOf(b)
    // Enter on an empty list item, checklist item or quote turns it back into text.
    if ((b.type === 'li' || b.type === 'todo' || b.type === 'quote') && !text.trim()) {
      set(replaceAt(idx, { type: 'p', text: '' }), { key: it.key, caret: 0 })
      return
    }
    const nb = all[idx + 1]
    // At the start of a non-empty block: open a new line above. The title stays first,
    // so there the new line goes just below it instead.
    if (s === 0 && en === 0 && text) {
      if (idx === 0 && b.type === 'h1') {
        if (nb && nb.block.type === 'p' && !nb.block.text) { draft.focus({ key: nb.key, caret: 0 }); return }
        const below: Item = { key: newKey(), block: { type: 'p', text: '' } }
        set([all[0], below, ...all.slice(1)], { key: below.key, caret: 0 })
        return
      }
      const t = nextType(b.type)
      const above: Item = { key: newKey(), block: t === 'todo' ? { type: t, text: '', done: false } : { type: t, text: '' } }
      set([...all.slice(0, idx), above, ...all.slice(idx)], { key: it.key, caret: 0 })
      return
    }
    const before = sliceRuns(runs, 0, s)
    const after = sliceRuns(runs, en)
    // The style you were typing in carries on to a new empty line, as in other editors.
    const carry = inline.consume(it.key, s) ?? caretMarks(runs, s)
    // A heading followed by an empty paragraph: just move down into it.
    if ((b.type === 'h1' || b.type === 'h2') && !after.length && nb?.block.type === 'p' && !nb.block.text) {
      set(replaceAt(idx, withRuns(b, before)), { key: nb.key, caret: 0 })
      return
    }
    const t = nextType(b.type)
    const fresh: Item = { key: newKey(), block: withRuns(t === 'todo' ? { type: t, text: '', done: false } : { type: t, text: '' }, after) }
    set([...all.slice(0, idx), { ...it, block: withRuns(b, before) }, fresh, ...all.slice(idx + 1)], { key: fresh.key, caret: 0 })
    if (!after.length && MARKS.some(m => carry[m])) inline.setPending(fresh.key, 0, carry)
  }

  /** Backspace at the start: a styled block becomes text, text merges into the block above, an empty block goes. */
  const backspaceAtStart = (it: Item) => {
    const all = draft.itemsRef.current
    const idx = all.findIndex(i => i.key === it.key)
    if (idx === -1) return
    const b = all[idx].block
    const text = b.text
    if (!text) {
      if (idx === 0 || all.length === 1) return
      set(all.filter((_, j) => j !== idx), { key: all[idx - 1].key, caret: 'end' })
      return
    }
    if (b.type !== 'p' && !(idx === 0 && b.type === 'h1')) {
      set(all.map((x, j) => (j === idx ? { ...x, block: withType(b, 'p') } : x)), { key: it.key, caret: 0 })
      return
    }
    if (idx === 0) return
    const prev = all[idx - 1]
    if (!prev.block.text) {
      set(all.filter((_, j) => j !== idx - 1), { key: it.key, caret: 0 })
      return
    }
    const join = prev.block.text.length
    const merged = { ...prev, block: withRuns(prev.block, concatRuns(runsOf(prev.block), runsOf(b))) }
    set([...all.slice(0, idx - 1), merged, ...all.slice(idx + 1)], { key: prev.key, caret: join })
  }

  // Some phone keyboards don't send key codes for Enter or Backspace, only input events.
  // Menus and touch bars send formatting and undo the same way.
  const handlers = useRef({ enter, backspaceAtStart, toggle: inline.toggle, undo: draft.undo, redo: draft.redo })
  handlers.current = { enter, backspaceAtStart, toggle: inline.toggle, undo: draft.undo, redo: draft.redo }
  useEffect(() => {
    const root = rootRef.current
    if (!root || !editing) return
    const formats: Record<string, Mark> = { formatBold: 'b', formatItalic: 'i', formatUnderline: 'u', formatStrikeThrough: 's' }
    const onBefore = (e: InputEvent) => {
      const el = e.target as HTMLElement
      if (!el.id?.startsWith('blk-') || e.isComposing) return
      const it = draft.itemsRef.current.find(i => `blk-${i.key}` === el.id)
      if (!it) return
      const sel = getSel(el)
      if (!sel) return
      if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
        e.preventDefault()
        handlers.current.enter(it, sel.start, sel.end)
      } else if (e.inputType === 'deleteContentBackward' && sel.start === 0 && sel.end === 0) {
        e.preventDefault()
        handlers.current.backspaceAtStart(it)
      } else if (formats[e.inputType]) {
        e.preventDefault()
        handlers.current.toggle(formats[e.inputType])
      } else if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
        e.preventDefault()
        if (e.inputType === 'historyUndo') handlers.current.undo()
        else handlers.current.redo()
      }
    }
    root.addEventListener('beforeinput', onBefore)
    return () => root.removeEventListener('beforeinput', onBefore)
  }, [editing, draft.itemsRef])

  /**
   * Pasting: rich text keeps bold, italic, underline and strikethrough (and its
   * headings, lists and quotes); plain text takes the caret's style. Several
   * lines make several blocks.
   */
  const onPaste = (e: ClipboardEvent<HTMLElement>, it: Item) => {
    e.preventDefault()
    const el = e.currentTarget
    const all = draft.itemsRef.current
    const idx = all.findIndex(i => i.key === it.key)
    if (idx === -1) return
    const b = all[idx].block
    const runs = runsOf(b)
    const sel = getSel(el) ?? { start: b.text.length, end: b.text.length }
    const html = e.clipboardData.getData('text/html')
    const raw = e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n')
    let lines = html ? blocksFromHTML(html) : []
    if (lines.length) {
      inline.consume(it.key, -1)
      // Reading HTML trims each line; one line of it keeps the spaces at its ends ("2 Nov " stays "2 Nov ").
      if (lines.length === 1 && !raw.includes('\n') && raw.trim() === lines[0].text) {
        lines = [withRuns(lines[0], [{ text: raw.slice(0, raw.length - raw.trimStart().length) }, ...runsOf(lines[0]), { text: raw.slice(raw.trimEnd().length) }])]
      }
    } else {
      if (!raw) return
      const marks = inline.consume(it.key, sel.start) ?? (sel.end > sel.start ? marksAt(runs, sel.start) : caretMarks(runs, sel.start))
      const plain: DocBlock[] = raw.includes('\n') ? parseLines(raw) : [{ type: 'p', text: raw }]
      lines = plain.map(l => withRuns(l, addMarks(runsOf(l), marks)))
    }
    if (!lines.length) return
    const heading = b.type === 'h1' || b.type === 'h2'
    const before = sliceRuns(runs, 0, sel.start)
    const after = sliceRuns(runs, sel.end)
    const [first, ...rest] = lines
    // An empty block takes the pasted line's own type ("## …", a list item); otherwise it keeps its own.
    // The title line always stays the title.
    const title = idx === 0 && b.type === 'h1'
    let head: DocBlock = !title && !b.text && (first.type !== 'p' || b.type === 'p') ? { ...first } : withRuns(b, concatRuns(before, runsOf(first)))
    if (heading && head.type === b.type) head = withType(head, b.type)
    if (!rest.length) {
      const caret = head.text.length
      set(all.map((x, j) => (j === idx ? { ...x, block: withRuns(head, concatRuns(runsOf(head), after)) } : x)), { key: it.key, caret })
      return
    }
    const tail = rest.map(block => ({ key: newKey(), block }))
    const last = tail[tail.length - 1]
    const caret = last.block.text.length
    last.block = withRuns(last.block, concatRuns(runsOf(last.block), after))
    set([...all.slice(0, idx), { ...it, block: head }, ...tail, ...all.slice(idx + 1)], { key: last.key, caret })
  }

  /** Copying from a line puts its formatting on the clipboard as simple HTML; cutting also takes it out. */
  const onCopy = (e: ClipboardEvent<HTMLElement>, it: Item, cut: boolean) => {
    const sel = getSel(e.currentTarget)
    const b = draft.itemsRef.current.find(i => i.key === it.key)?.block
    if (!sel || sel.start === sel.end || !b) return
    const part = sliceRuns(runsOf(b), sel.start, sel.end)
    e.preventDefault()
    e.clipboardData.setData('text/plain', runsText(part))
    e.clipboardData.setData('text/html', inlineHTML(part))
    if (cut) set(withBlock(it.key, withRuns(b, spliceRuns(runsOf(b), sel.start, sel.end, []))), { key: it.key, caret: sel.start })
  }

  /** Viewing: copying a selection across lines keeps their types and formatting. */
  const onViewCopy = (e: ClipboardEvent<HTMLDivElement>) => {
    if (editing) return
    const sel = document.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount || !rootRef.current) return
    const range = sel.getRangeAt(0)
    const parts: { block: DocBlock; whole: boolean }[] = []
    for (const el of rootRef.current.querySelectorAll<HTMLElement>('[data-block-key]')) {
      if (!range.intersectsNode(el)) continue
      const b = items.find(i => i.key === el.dataset.blockKey)?.block
      if (!b) continue
      const s = el.contains(range.startContainer) ? offsetOf(el, range.startContainer, range.startOffset) : 0
      const en = el.contains(range.endContainer) ? offsetOf(el, range.endContainer, range.endOffset) : b.text.length
      if (en > s) parts.push({ block: withRuns(b, sliceRuns(runsOf(b), s, en)), whole: s === 0 && en === b.text.length })
    }
    if (!parts.length) return
    e.preventDefault()
    e.clipboardData.setData('text/plain', parts.map(p => p.block.text).join('\n'))
    e.clipboardData.setData('text/html', parts.length === 1 && !parts[0].whole ? inlineHTML(runsOf(parts[0].block)) : blocksToHTML(parts.map(p => p.block)))
  }

  const lastPick = useRef('')
  const onSelectArea = (el: HTMLElement, it: Item) => {
    const sel = getSel(el)
    if (!sel) return
    const s = sel.start
    const en = sel.end
    const text = s !== en ? it.block.text.slice(s, en).replace(/\s+/g, ' ').trim().slice(0, 160) : ''
    const pick = text.length >= 2 ? `${it.key}:${text}` : ''
    if (pick !== lastPick.current) {
      lastPick.current = pick
      onSelectText(pick ? { key: it.key, text } : null)
    }
    if (s !== en) return
    // The caret inside highlighted text brings up that comment.
    let at = 0
    for (const seg of segments(it.block.text, comments)) {
      if (seg.id && s >= at && s <= at + seg.text.length) { onAnchor(seg.id, true); return }
      at += seg.text.length
    }
  }

  // Selecting text in a line enables Comment; a caret inside highlighted text shows that comment.
  // (React's onSelect skips plaintext-only lines, so this follows the document's selection.)
  const selectArea = useRef(onSelectArea)
  selectArea.current = onSelectArea
  useEffect(() => {
    if (!editing) return
    const on = () => {
      const el = document.activeElement
      if (!isBlockEl(el) || !rootRef.current?.contains(el)) return
      const it = draft.itemsRef.current.find(i => `blk-${i.key}` === el.id)
      if (it) selectArea.current(el, it)
    }
    document.addEventListener('selectionchange', on)
    return () => document.removeEventListener('selectionchange', on)
  }, [editing, draft.itemsRef])

  const toggle = (key: string) => {
    if (!editable) return
    const all = draft.itemsRef.current
    set(all.map(i => (i.key === key ? { ...i, block: { ...i.block, done: !i.block.done } } : i)))
  }

  const placeholder = (b: DocBlock, idx: number, isFocused: boolean) => {
    if (b.type === 'h1') return idx === 0 ? 'Untitled document' : typeLabels.h1
    if (b.type === 'h2') return typeLabels.h2
    if (b.type === 'li') return 'List item'
    if (b.type === 'todo') return 'To-do'
    if (b.type === 'quote') return 'Quote'
    const onlyBody = items.length <= 2 && idx === items.length - 1
    return isFocused || onlyBody ? 'Write something, or type “/” for blocks' : ''
  }

  /** A line's text with its formatting, and comment highlights over the top (DOC-05). */
  const content = (it: Item, interactive: boolean) => {
    const runs = runsOf(it.block)
    const segs = segments(it.block.text, comments)
    let at = 0
    const parts = segs.map(seg => {
      const part = sliceRuns(runs, at, at + seg.text.length)
      at += seg.text.length
      return <RunText runs={part} />
    })
    return (
      <>
        {segs.map((seg, i) =>
          !seg.id ? (
            <span key={i}>{parts[i]}</span>
          ) : interactive ? (
            <span
              key={i}
              role="button"
              tabIndex={0}
              onClick={() => onAnchor(seg.id!)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAnchor(seg.id!) } }}
              aria-label={`Comment from ${personName(comments.find(c => c.id === seg.id)?.authorId ?? '')} on “${seg.text}”`}
              className={cx('cursor-pointer rounded-sm border-b-2 border-warn bg-warn-soft [box-decoration-break:clone] transition hover:brightness-95', focusComment === seg.id && 'ring-2 ring-warn')}
            >
              {parts[i]}
            </span>
          ) : (
            <mark key={i} className={cx('rounded-sm border-b-2 border-warn bg-warn-soft text-transparent', focusComment === seg.id && 'ring-2 ring-warn')}>{parts[i]}</mark>
          ),
        )}
        {cursor?.key === it.key && <CursorFlag personId={cursor.personId} />}
      </>
    )
  }

  return (
    <div ref={rootRef} className="flex flex-col" onCopy={onViewCopy} onPointerDown={() => editing && inline.clearPending()}>
      {items.map((it, idx) => {
        const b = it.block
        const prev = items[idx - 1]?.block
        const isFocused = focused === it.key
        const isFresh = draft.fresh.has(it.key)
        const gutter =
          b.type === 'li' ? (
            <span className="flex h-[1.625em] w-5 shrink-0 items-center justify-center text-[16px]" aria-hidden><span className="size-1.5 rounded-full bg-fg" /></span>
          ) : b.type === 'todo' ? (
            <span className="flex h-[1.625em] w-5 shrink-0 items-center text-[16px]">
              <button
                role="checkbox"
                aria-checked={!!b.done}
                aria-label={b.text ? `Done: ${b.text}` : 'Done'}
                disabled={!editable}
                title={editable ? undefined : 'Only editors can tick this'}
                onMouseDown={e => editing && e.preventDefault()}
                onClick={() => toggle(it.key)}
                className={cx("relative grid size-5 place-items-center rounded-md border-2 transition after:absolute after:-inset-2.5 after:content-[''] disabled:cursor-not-allowed", b.done ? 'border-ok bg-ok text-white' : 'border-muted', editable && !b.done && 'hover:border-accent')}
              >
                {b.done && <Check size={13} strokeWidth={3} />}
              </button>
            </span>
          ) : null
        return (
          <Fragment key={it.key}>
          <div className={cx('relative flex gap-2.5', gapCls(prev, b), isFresh && 'anim-in -mx-2 rounded-lg bg-agent-soft/60 px-2')}>
            {gutter}
            <div className={cx('min-w-0 flex-1', b.type === 'quote' && 'border-l-4 border-accent pl-4')}>
              {editing ? (
                <div className="relative">
                  {/* The mirror sizes the line and draws comment highlights and a collaborator's caret under the text. */}
                  <div aria-hidden className={cx(textCls(b), 'pointer-events-none whitespace-pre-wrap break-words text-transparent')}>
                    {/* An empty block shows its placeholder here, and sizes to it so a long hint wraps instead of being cut. */}
                    {b.text ? content(it, false) : <span className={cx('text-muted/70', b.type === 'quote' && 'not-italic')}>{placeholder(b, idx, isFocused)}</span>}
                    {'​'}
                  </div>
                  <Line
                    id={`blk-${it.key}`}
                    block={b}
                    composing={composing}
                    label={idx === 0 && b.type === 'h1' ? 'Title heading' : typeLabels[b.type]}
                    placeholder={placeholder(b, idx, isFocused) || undefined}
                    onInput={e => {
                      const ne = e.nativeEvent as InputEvent
                      if (!composing.current && !ne.isComposing) sync(it, e.currentTarget, ne.inputType, ne.data)
                    }}
                    onCompositionStart={() => { composing.current = true }}
                    onCompositionEnd={e => { composing.current = false; sync(it, e.currentTarget) }}
                    onKeyDown={e => onKeyDown(e, it)}
                    onPaste={e => onPaste(e, it)}
                    onCopy={e => onCopy(e, it, false)}
                    onCut={e => onCopy(e, it, true)}
                    onFocus={() => { setFocused(it.key); onActive(it.key) }}
                    onBlur={() => { setFocused(f => (f === it.key ? null : f)); setSlash(s => (s?.key === it.key ? null : s)) }}
                    className={cx(textCls(b), 'absolute inset-0 block h-full w-full whitespace-pre-wrap break-words bg-transparent outline-none', b.type === 'todo' && b.done && 'line-through decoration-muted')}
                  />
                  {slash?.key === it.key && (
                    <SlashMenu ref={menuRef} options={slashFor(b.text)} index={slash.index} onPick={o => chooseSlash(it.key, o)} onHover={i => setSlash({ key: it.key, index: i })} />
                  )}
                </div>
              ) : (
                <div data-block-key={it.key} className={cx(textCls(b), 'whitespace-pre-wrap break-words', b.type === 'todo' && b.done && 'line-through decoration-muted')}>
                  {b.text ? content(it, true) : <span data-ui className="text-muted/60">{idx === 0 && b.type === 'h1' ? 'Untitled document' : '​'}</span>}
                </div>
              )}
            </div>
          </div>
          {idx === 0 && afterTitle}
          {afterBlock?.key === it.key && afterBlock.node}
          </Fragment>
        )
      })}
      {end}
      {pick && (
        <button
          onMouseDown={e => e.preventDefault()}
          onClick={() => { onComment(pick.text); document.getSelection()?.removeAllRanges(); setPick(null) }}
          className="anim-in fixed z-40 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-fg px-3 py-1.5 text-[13px] font-semibold text-bg shadow-card"
          style={{ left: pick.x, top: pick.y }}
        >
          <MessageSquarePlus size={15} aria-hidden /> Comment
        </button>
      )}
    </div>
  )
}

/**
 * One editable line. React never renders its children: the line writes its
 * runs into the DOM itself, and only when what's shown differs from the model,
 * so typing never resets the caret.
 */
function Line({ block, composing, label, placeholder, ...rest }: Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'placeholder'> & { id: string; block: DocBlock; composing: { current: boolean }; label: string; placeholder?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (ref.current && !composing.current) syncRuns(ref.current, runsOf(block))
  }, [block, composing])
  const heading = block.type === 'h1' || block.type === 'h2'
  return (
    <div
      {...rest}
      ref={ref}
      role="textbox"
      aria-label={label}
      aria-multiline={!heading}
      aria-placeholder={block.text ? undefined : placeholder}
      contentEditable={EDITABLE}
      suppressContentEditableWarning
      spellCheck
    />
  )
}

interface SlashOption { id: string; label: string; hint: string; icon: ReactNode; type?: BlockType; run?: (key: string) => void }

function SlashMenu({ ref, options, index, onPick, onHover }: { ref: Ref<HTMLDivElement>; options: SlashOption[]; index: number; onPick: (o: SlashOption) => void; onHover: (i: number) => void }) {
  const firstAI = options.findIndex(o => !o.type)
  return (
    <div ref={ref} role="listbox" aria-label="Turn into" className="anim-in absolute top-full left-0 z-30 mt-1 w-[min(18rem,calc(100vw-2.5rem))] overflow-hidden rounded-2xl border border-line bg-surface py-1.5 font-sans text-[14px] not-italic shadow-card">
      {options.length === 0 && <p className="px-3 py-2 text-sm text-muted">No matches. Press Esc to keep typing.</p>}
      {options.map((o, i) => (
        <div key={o.id}>
          {i === 0 && o.type && <p className="px-3 pt-1 pb-1 text-[11px] font-bold uppercase tracking-[0.08em] text-muted">Turn into</p>}
          {i === firstAI && <p className={cx('px-3 pb-1 text-[11px] font-bold uppercase tracking-[0.08em] text-agent', i > 0 && 'mt-1 border-t border-line pt-2')}>Help me write</p>}
          <button
            role="option"
            aria-selected={i === index}
            onMouseDown={e => e.preventDefault()}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(o)}
            className={cx('flex w-full items-center gap-2.5 px-3 py-1.5 text-left', i === index ? 'bg-surface-2' : '')}
          >
            <span className={cx('grid size-7 shrink-0 place-items-center rounded-lg', o.type ? 'bg-surface-2 text-fg' : 'bg-agent-soft text-agent')}>{o.icon}</span>
            <span className="min-w-0 flex-1 truncate font-medium text-fg">{o.label}</span>
            {o.hint && <kbd className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">{o.hint}</kbd>}
          </button>
        </div>
      ))}
    </div>
  )
}
