// The doc body (DOC-01). Editing: every block is an auto-growing textarea laid
// over a mirror of its text, so comment highlights and live cursors still show.
// Enter splits, Backspace merges, arrows move between blocks, "/" opens the
// block menu and Markdown shortcuts change the type. Viewing: the same layout,
// read-only, with clickable comment highlights and select-to-comment (DOC-05).
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { Check, Heading1, Heading2, List, ListChecks, MessageSquarePlus, Pilcrow, TextQuote } from 'lucide-react'
import type { Doc, DocBlock, DocComment, PersonId } from '../../types'
import { personById } from '../../data/people'
import { cx, personName } from '../../ui'
import { newKey, nextType, parseLines, shortcutFor, typeHints, typeLabels, withType, blockOrder, type BlockType, type Item } from './model'
import type { DocDraft } from './useDocDraft'

export const typeIcons: Record<BlockType, typeof Pilcrow> = { p: Pilcrow, h1: Heading1, h2: Heading2, li: List, todo: ListChecks, quote: TextQuote }

export interface SlashAction { id: string; label: string; hint: string; icon: ReactNode; run: (key: string) => void }

/** Text styles per block type, shared by the textarea, its mirror and the read-only view. */
export function textCls(b: DocBlock) {
  switch (b.type) {
    case 'h1': return 'font-display text-[26px] leading-tight font-semibold sm:text-[30px]'
    case 'h2': return 'font-display text-xl leading-snug font-semibold'
    case 'quote': return 'text-[16px] leading-relaxed italic text-muted'
    default: return cx('text-[16px] leading-relaxed', b.type === 'todo' && b.done && 'text-muted')
  }
}

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
    <span className="relative inline-block h-[1.15em] w-0 align-[-0.2em]" role="img" aria-label={`${p.short} is editing here`}>
      <span className="anim-pulse absolute inset-y-0 left-0 w-0.5 rounded-full" style={{ background: color }} aria-hidden />
      <span className="absolute top-1/2 left-1.5 -translate-y-1/2 rounded px-1 py-0.5 font-sans text-[10px] leading-none font-semibold whitespace-nowrap text-white not-italic" style={{ background: color }} aria-hidden>{p.short}</span>
    </span>
  )
}

// ── Caret position: is it on the first or last visual line of a textarea? ──
const MIRRORED = ['box-sizing', 'width', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'line-height', 'text-transform', 'word-spacing', 'text-indent', 'tab-size']
let mirror: HTMLDivElement | null = null
function caretLines(el: HTMLTextAreaElement): { first: boolean; last: boolean } {
  if (!mirror) {
    mirror = document.createElement('div')
    mirror.setAttribute('aria-hidden', 'true')
    document.body.appendChild(mirror)
  }
  const cs = getComputedStyle(el)
  for (const p of MIRRORED) mirror.style.setProperty(p, cs.getPropertyValue(p))
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', height: 'auto' })
  const pos = el.selectionStart
  mirror.textContent = el.value.slice(0, pos)
  const span = document.createElement('span')
  span.textContent = el.value.slice(pos) || '​'
  mirror.appendChild(span)
  const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4
  const top = span.offsetTop
  const total = mirror.scrollHeight
  return { first: top < lh * 0.5, last: top + lh * 1.5 > total }
}

export const blockEl = (key: string) => document.getElementById(`blk-${key}`) as HTMLTextAreaElement | null

/** Sets a block's type from the toolbars, keeping the caret where it was. */
export function applyType(draft: DocDraft, key: string | null, type: BlockType) {
  const items = draft.itemsRef.current
  const idx = items.findIndex(i => i.key === key)
  if (idx === -1) return
  const it = items[idx]
  const el = blockEl(it.key)
  const caret = el && document.activeElement === el ? el.selectionStart : 'end'
  const next = it.block.type === type && type !== 'p' ? withType(it.block, 'p') : withType(it.block, type)
  draft.change(items.map((x, i) => (i === idx ? { ...x, block: next } : x)), { focus: { key: it.key, caret } })
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
  slashActions: SlashAction[]
  afterTitle?: ReactNode
  /** Shown under one block, e.g. an AI suggestion that will go in there. */
  afterBlock?: { key: string; node: ReactNode } | null
  end?: ReactNode
}

export default function Editor(props: EditorProps) {
  const { doc, draft, mode, editable, commentable, cursor, focusComment, onAnchor, onActive, onSelectText, onComment, slashActions, afterTitle, afterBlock, end } = props
  const editing = mode === 'edit' && editable
  const [focused, setFocused] = useState<string | null>(null)
  const [slash, setSlash] = useState<{ key: string; index: number } | null>(null)
  const [pick, setPick] = useState<{ text: string; x: number; y: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const items = draft.items
  const comments = doc.comments

  // Apply a pending caret move after each render.
  useLayoutEffect(() => {
    const f = draft.focusReq.current
    if (!f) return
    const el = blockEl(f.key)
    if (!el) return
    draft.focusReq.current = null
    el.focus()
    const c = f.caret === 'end' ? el.value.length : Math.min(f.caret, el.value.length)
    el.setSelectionRange(c, c)
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

  const set = (next: Item[], focus?: { key: string; caret: number | 'end' }, typing?: string) => draft.change(next, { focus, typing })

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
      set(cur.map(i => (i.key === key ? { ...i, block: withType({ ...i.block, text: '' }, option.type!) } : i)), { key, caret: 0 })
    } else {
      set(cur.map(i => (i.key === key ? { ...i, block: { ...i.block, text: '' } } : i)), { key, caret: 0 })
      option.run?.(key)
    }
  }

  const onText = (it: Item, el: HTMLTextAreaElement) => {
    const prev = it.block.text
    let text = el.value
    let block: DocBlock = { ...it.block, text }
    let focus: { key: string; caret: number } | undefined
    const sc = shortcutFor(prev, text)
    if (sc && el.selectionStart === sc.strip) {
      block = withType({ ...block, text: text.slice(sc.strip) }, sc.type)
      focus = { key: it.key, caret: 0 }
    } else if ((block.type === 'h1' || block.type === 'h2') && text.includes('\n')) {
      text = text.replace(/\n/g, ' ')
      block = { ...block, text }
    }
    if (block.text.startsWith('/') && !block.text.includes('\n') && block.text.length <= 24 && (prev === '' || prev.startsWith('/'))) {
      setSlash({ key: it.key, index: 0 })
    } else if (slash?.key === it.key) setSlash(null)
    set(draft.itemsRef.current.map(i => (i.key === it.key ? { ...i, block } : i)), focus, focus ? undefined : it.key)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>, it: Item) => {
    if (e.nativeEvent.isComposing) return
    const el = e.currentTarget
    const all = draft.itemsRef.current
    const idx = all.findIndex(i => i.key === it.key)
    const b = all[idx].block
    const s = el.selectionStart
    const en = el.selectionEnd
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
        setSlash(null)
        return
      }
    }

    const mod = e.metaKey || e.ctrlKey
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
    shiftEnter.current = e.key === 'Enter' && e.shiftKey

    if (e.key === 'Backspace' && s === 0 && en === 0) {
      e.preventDefault()
      backspaceAtStart(it)
      return
    }

    if (e.key === 'Delete' && s === text.length && en === s && idx < all.length - 1) {
      e.preventDefault()
      const nb = all[idx + 1]
      const merged = { ...it, block: { ...b, text: text + nb.block.text } }
      set([...all.slice(0, idx), merged, ...all.slice(idx + 2)], { key: it.key, caret: s })
      return
    }

    if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return
    if (e.key === 'ArrowUp' && idx > 0 && s === en && (s === 0 || caretLines(el).first)) {
      e.preventDefault()
      draft.focus({ key: all[idx - 1].key, caret: 'end' })
    } else if (e.key === 'ArrowDown' && idx < all.length - 1 && s === en && (s === text.length || caretLines(el).last)) {
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
    // Enter on an empty list item, checklist item or quote turns it back into text.
    if ((b.type === 'li' || b.type === 'todo' || b.type === 'quote') && !text.trim()) {
      set(replaceAt(idx, { type: 'p', text: '' }), { key: it.key, caret: 0 })
      return
    }
    // At the start of a non-empty block: open a new line above (not above the title).
    if (s === 0 && en === 0 && text && idx > 0) {
      const t = nextType(b.type)
      const above: Item = { key: newKey(), block: t === 'todo' ? { type: t, text: '', done: false } : { type: t, text: '' } }
      set([...all.slice(0, idx), above, ...all.slice(idx)], { key: it.key, caret: 0 })
      return
    }
    const before = text.slice(0, s)
    const after = text.slice(en)
    const nb = all[idx + 1]
    // A heading followed by an empty paragraph: just move down into it.
    if ((b.type === 'h1' || b.type === 'h2') && !after && nb?.block.type === 'p' && !nb.block.text) {
      set(replaceAt(idx, { ...b, text: before }), { key: nb.key, caret: 0 })
      return
    }
    const t = nextType(b.type)
    const fresh: Item = { key: newKey(), block: t === 'todo' ? { type: t, text: after, done: false } : { type: t, text: after } }
    set([...all.slice(0, idx), { ...it, block: { ...b, text: before } }, fresh, ...all.slice(idx + 1)], { key: fresh.key, caret: 0 })
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
    const merged = { ...prev, block: { ...prev.block, text: prev.block.text + text } }
    set([...all.slice(0, idx - 1), merged, ...all.slice(idx + 1)], { key: prev.key, caret: join })
  }

  // Some phone keyboards don't send key codes for Enter or Backspace, only input events.
  const shiftEnter = useRef(false)
  const handlers = useRef({ enter, backspaceAtStart })
  handlers.current = { enter, backspaceAtStart }
  useEffect(() => {
    const root = rootRef.current
    if (!root || !editing) return
    const onBefore = (e: InputEvent) => {
      const el = e.target as HTMLTextAreaElement
      if (!el.id?.startsWith('blk-') || e.isComposing) return
      const it = draft.itemsRef.current.find(i => `blk-${i.key}` === el.id)
      if (!it) return
      if ((e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') && !shiftEnter.current) {
        e.preventDefault()
        handlers.current.enter(it, el.selectionStart, el.selectionEnd)
      } else if (e.inputType === 'deleteContentBackward' && el.selectionStart === 0 && el.selectionEnd === 0) {
        e.preventDefault()
        handlers.current.backspaceAtStart(it)
      }
      shiftEnter.current = false
    }
    root.addEventListener('beforeinput', onBefore)
    return () => root.removeEventListener('beforeinput', onBefore)
  }, [editing, draft.itemsRef])

  // Pasting several lines makes several blocks.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>, it: Item) => {
    const raw = e.clipboardData.getData('text/plain')
    if (!raw.includes('\n')) return
    const parsed = parseLines(raw)
    if (!parsed.length) return
    e.preventDefault()
    const el = e.currentTarget
    const all = draft.itemsRef.current
    const idx = all.findIndex(i => i.key === it.key)
    const b = all[idx].block
    const before = b.text.slice(0, el.selectionStart)
    const after = b.text.slice(el.selectionEnd)
    const [first, ...rest] = parsed
    // An empty block takes the pasted line's own type ("## …", "- …"); otherwise it keeps its own.
    const headBlock: DocBlock = !b.text && (first.type !== 'p' || b.type === 'p') ? { ...first } : { ...b, text: before + first.text }
    if (!rest.length) {
      headBlock.text += after
      set(all.map((x, j) => (j === idx ? { ...x, block: headBlock } : x)), { key: it.key, caret: headBlock.text.length - after.length })
      return
    }
    const tail = rest.map(block => ({ key: newKey(), block }))
    const last = tail[tail.length - 1]
    const caret = last.block.text.length
    last.block = { ...last.block, text: last.block.text + after }
    set([...all.slice(0, idx), { ...it, block: headBlock }, ...tail, ...all.slice(idx + 1)], { key: last.key, caret })
  }

  const onSelectArea = (el: HTMLTextAreaElement, it: Item) => {
    const s = el.selectionStart
    const en = el.selectionEnd
    if (s !== en) {
      const text = el.value.slice(s, en).replace(/\s+/g, ' ').trim()
      onSelectText(text.length >= 2 ? { key: it.key, text: text.slice(0, 160) } : null)
      return
    }
    onSelectText(null)
    // The caret inside highlighted text brings up that comment.
    let at = 0
    for (const seg of segments(it.block.text, comments)) {
      if (seg.id && s >= at && s <= at + seg.text.length) { onAnchor(seg.id, true); return }
      at += seg.text.length
    }
  }

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

  const content = (it: Item, interactive: boolean) => {
    const segs = segments(it.block.text, comments)
    return (
      <>
        {segs.map((seg, i) =>
          !seg.id ? (
            <span key={i}>{seg.text}</span>
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
              {seg.text}
            </span>
          ) : (
            <mark key={i} className={cx('rounded-sm border-b-2 border-warn bg-warn-soft text-transparent', focusComment === seg.id && 'ring-2 ring-warn')}>{seg.text}</mark>
          ),
        )}
        {cursor?.key === it.key && <CursorFlag personId={cursor.personId} />}
      </>
    )
  }

  return (
    <div ref={rootRef} className="flex flex-col">
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
                className={cx('grid size-5 place-items-center rounded-md border-2 transition disabled:cursor-not-allowed', b.done ? 'border-ok bg-ok text-white' : 'border-muted', editable && !b.done && 'hover:border-accent')}
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
                  <div aria-hidden className={cx(textCls(b), 'pointer-events-none whitespace-pre-wrap break-words text-transparent', b.type === 'todo' && b.done && 'line-through decoration-muted')}>
                    {content(it, false)}
                    {'​'}
                  </div>
                  <textarea
                    id={`blk-${it.key}`}
                    aria-label={idx === 0 && b.type === 'h1' ? 'Title heading' : typeLabels[b.type]}
                    rows={1}
                    value={b.text}
                    placeholder={placeholder(b, idx, isFocused)}
                    spellCheck
                    onChange={e => onText(it, e.currentTarget)}
                    onKeyDown={e => onKeyDown(e, it)}
                    onPaste={e => onPaste(e, it)}
                    onSelect={e => onSelectArea(e.currentTarget, it)}
                    onFocus={() => { setFocused(it.key); onActive(it.key) }}
                    onBlur={() => { setFocused(f => (f === it.key ? null : f)); setSlash(s => (s?.key === it.key ? null : s)) }}
                    className={cx(textCls(b), 'absolute inset-0 block h-full w-full resize-none overflow-hidden bg-transparent outline-none placeholder:text-muted/70', b.type === 'quote' && 'placeholder:not-italic')}
                  />
                  {slash?.key === it.key && (
                    <SlashMenu ref={menuRef} options={slashFor(b.text)} index={slash.index} onPick={o => chooseSlash(it.key, o)} onHover={i => setSlash({ key: it.key, index: i })} />
                  )}
                </div>
              ) : (
                <div data-block-key={it.key} className={cx(textCls(b), 'whitespace-pre-wrap break-words', b.type === 'todo' && b.done && 'line-through decoration-muted')}>
                  {b.text ? content(it, true) : <span className="text-muted/60">{idx === 0 && b.type === 'h1' ? 'Untitled document' : '​'}</span>}
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
