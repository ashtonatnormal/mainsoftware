// The open doc's working copy. Typing changes local blocks at once and saves to
// the store after a short pause ("Saving…" → "Saved to Drive"). Leaving a doc
// you changed adds one "You edited" version with line diffs (DOC-04), plus the
// lines whose formatting alone changed.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Doc, DocBlock, DocVersion } from '../../types'
import { newId, useStore } from '../../store'
import { ME } from '../../data/people'
import { clock, shortDay } from '../../time'
import { diffLines, formatChanges, linesOf, openingBlocks, sameBlocks, titleLinked, toBlocks, toItems, undoVersion, UNTITLED, type Item } from './model'
import { getSel, isBlockEl, keyOfEl } from './dom'
import { setPlainText } from './runs'

/** Where the caret goes: a block and an offset in its text, or a selection up to `end`. */
export interface Focus { key: string; caret: number | 'end'; end?: number }
interface Snapshot { items: Item[]; title: string; emoji: string; focus?: Focus }

// What a doc looked like right after a version was made, so restores made in
// this visit are exact. Older seed versions are worked out from their diffs.
const snapshots = new Map<string, DocBlock[]>()

const SAVE_DELAY = 700

export function useDocDraft(doc: Doc) {
  const store = useStore()
  const storeRef = useRef(store)
  storeRef.current = store
  const docRef = useRef(doc)
  docRef.current = doc

  const [items, setItems] = useState<Item[]>(() => toItems(openingBlocks(doc)))
  const itemsRef = useRef(items)
  // The title as typed ('' while untitled); saved as "Untitled document".
  const [title, setTitleState] = useState(doc.title === UNTITLED ? '' : doc.title)
  const titleRef = useRef(title)
  const [emoji, setEmojiState] = useState(doc.emoji ?? '📄')
  const emojiRef = useRef(emoji)
  const linked = useRef(titleLinked(doc))
  const baseline = useRef<DocBlock[]>(toBlocks(items))
  const baseTitle = useRef(doc.title)
  const aiUsed = useRef(false)
  const pending = useRef(false)
  const timer = useRef(0)
  const [saving, setSaving] = useState(false)
  const [savedOnce, setSavedOnce] = useState(false)
  const focusReq = useRef<Focus | null>(null)
  const [, bump] = useState(0)
  const [fresh, setFresh] = useState<Set<string>>(() => new Set())
  // Undo understands splits, merges and formatting, which the browser's own undo can't.
  const undoStack = useRef<Snapshot[]>([])
  const redoStack = useRef<Snapshot[]>([])
  const lastTyping = useRef({ at: 0, key: '' })

  if (doc.versions[0] && !snapshots.has(doc.versions[0].id)) snapshots.set(doc.versions[0].id, baseline.current)

  const savedTitle = () => titleRef.current.trim() || UNTITLED
  const now = () => storeRef.current.state.clock

  const write = useCallback((next: Doc) => {
    docRef.current = next
    storeRef.current.updateDoc(next)
  }, [])

  /** Everything typed so far, as the doc to store. */
  const current = useCallback((): Doc => ({
    ...docRef.current,
    title: savedTitle(),
    emoji: emojiRef.current,
    blocks: toBlocks(itemsRef.current),
    ...(pending.current ? { updatedAt: now(), updatedBy: ME } : {}),
  }), [])

  const save = useCallback(() => {
    window.clearTimeout(timer.current)
    if (!pending.current) return
    write(current())
    pending.current = false
    setSaving(false)
    setSavedOnce(true)
  }, [current, write])

  const schedule = () => {
    pending.current = true
    setSaving(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(save, SAVE_DELAY)
  }

  const caretNow = (): Focus | undefined => {
    const el = document.activeElement
    const sel = isBlockEl(el) ? getSel(el) : null
    return isBlockEl(el) && sel ? { key: keyOfEl(el), caret: sel.start, ...(sel.end !== sel.start ? { end: sel.end } : {}) } : undefined
  }

  /** Replace the blocks (and maybe the title), optionally moving the caret. Typing in one
   *  block within a second counts as one step for undo. */
  const change = (next: Item[], opts: { focus?: Focus; title?: string; typing?: string } = {}) => {
    const now = Date.now()
    if (!opts.typing || opts.typing !== lastTyping.current.key || now - lastTyping.current.at > 1000) {
      undoStack.current.push({ items: itemsRef.current, title: titleRef.current, emoji: emojiRef.current, focus: caretNow() })
      if (undoStack.current.length > 200) undoStack.current.shift()
    }
    lastTyping.current = { at: now, key: opts.typing ?? '' }
    redoStack.current = []
    apply(next, opts)
  }

  const apply = (next: Item[], opts: { focus?: Focus; title?: string } = {}) => {
    let t = opts.title ?? titleRef.current
    if (opts.title !== undefined) linked.current = next[0]?.block.type === 'h1' && next[0].block.text === opts.title
    else if (linked.current) {
      const h = next[0]?.block
      if (!h || h.type !== 'h1') linked.current = false
      else if (opts.title === undefined) t = h.text
    }
    itemsRef.current = next
    titleRef.current = t
    setItems(next)
    setTitleState(t)
    if (opts.focus) focusReq.current = opts.focus
    schedule()
  }

  /** The title field changed; `caret` is where its caret is now, so formatting in the heading stays put. */
  const setTitle = (t: string, caret?: number) => {
    const first = itemsRef.current[0]
    if (linked.current && first?.block.type === 'h1') change([{ ...first, block: setPlainText(first.block, t, caret) }, ...itemsRef.current.slice(1)], { title: t, typing: 'title' })
    else change(itemsRef.current, { title: t, typing: 'title' })
  }

  const step = (from: { current: Snapshot[] }, to: { current: Snapshot[] }) => {
    const snap = from.current.pop()
    if (!snap) return false
    to.current.push({ items: itemsRef.current, title: titleRef.current, emoji: emojiRef.current, focus: caretNow() })
    lastTyping.current = { at: 0, key: '' }
    const keys = new Set(snap.items.map(i => i.key))
    const focus = snap.focus && keys.has(snap.focus.key) ? snap.focus : snap.items[0] && { key: snap.items[snap.items.length - 1].key, caret: 'end' as const }
    // A template or meeting draft also set the emoji; undo puts it back too.
    emojiRef.current = snap.emoji
    setEmojiState(snap.emoji)
    apply(snap.items, { title: snap.title, focus })
    return true
  }
  const undo = () => step(undoStack, redoStack)
  const redo = () => step(redoStack, undoStack)

  const setEmoji = (e: string) => {
    emojiRef.current = e
    setEmojiState(e)
    schedule()
  }

  const focus = (f: Focus) => {
    focusReq.current = f
    bump(n => n + 1)
  }

  /** Content written with AI help: marked briefly so you can see what went in. */
  const markAI = (keys: string[]) => {
    aiUsed.current = true
    setFresh(new Set(keys))
    window.setTimeout(() => setFresh(new Set()), 2400)
  }

  /** Saves comments and other doc fields straight away, along with any unsaved typing. */
  const patchDoc = (patch: Partial<Doc>) => {
    window.clearTimeout(timer.current)
    write({ ...current(), ...patch })
    if (pending.current) setSavedOnce(true)
    pending.current = false
    setSaving(false)
  }

  const changed = () => !sameBlocks(toBlocks(itemsRef.current), baseline.current) || savedTitle() !== baseTitle.current

  /** Text added and removed since the visit began, and lines whose formatting changed. */
  const diffNow = () => {
    const blocks = toBlocks(itemsRef.current)
    const d = diffLines(linesOf(baseline.current), linesOf(blocks))
    const formatted = formatChanges(baseline.current, blocks, d.added)
    if (savedTitle() !== baseTitle.current && !linked.current) {
      d.removed.unshift(`Title: ${baseTitle.current}`)
      d.added.unshift(`Title: ${savedTitle()}`)
    }
    return { ...d, formatted }
  }

  const makeVersion = (summary?: string): DocVersion => {
    const blocks = toBlocks(itemsRef.current)
    const d = diffNow()
    const v: DocVersion = {
      id: newId('v'), authorId: ME, ts: now(),
      summary: summary ?? (aiUsed.current ? 'You edited · inserted AI-drafted text' : 'You edited'),
      ...(d.added.length ? { added: d.added } : {}),
      ...(d.removed.length ? { removed: d.removed } : {}),
      ...(d.formatted.length ? { formatted: d.formatted } : {}),
    }
    snapshots.set(v.id, blocks)
    return v
  }

  /** The version this visit will add when you leave, for the history panel. */
  const pendingVersion = (): { added: string[]; removed: string[]; formatted: string[] } | null => (changed() ? diffNow() : null)

  /** Restore an older version as a new one (DOC-04). Unsaved edits become their own version first. */
  const restore = (target: DocVersion) => {
    window.clearTimeout(timer.current)
    let versions = docRef.current.versions
    const cur = toBlocks(itemsRef.current)
    if (changed()) versions = [makeVersion(), ...versions]
    const idx = versions.findIndex(v => v.id === target.id)
    if (idx === -1) return
    const restored = snapshots.get(target.id) ?? versions.slice(0, idx).reduce(undoVersion, cur)
    const d = diffLines(linesOf(cur), linesOf(restored))
    const formatted = formatChanges(cur, restored, d.added)
    const rv: DocVersion = {
      id: newId('v'), authorId: ME, ts: now(), summary: `Restored the version from ${shortDay(target.ts)}, ${clock(target.ts)}`,
      ...(d.added.length ? { added: d.added } : {}), ...(d.removed.length ? { removed: d.removed } : {}), ...(formatted.length ? { formatted } : {}),
    }
    snapshots.set(rv.id, restored)
    const nextItems = toItems(restored)
    undoStack.current = []
    redoStack.current = []
    itemsRef.current = nextItems
    setItems(nextItems)
    if (linked.current && restored[0]?.type === 'h1') { titleRef.current = restored[0].text; setTitleState(restored[0].text) }
    write({ ...docRef.current, title: savedTitle(), blocks: restored, updatedAt: now(), updatedBy: ME, versions: [rv, ...versions] })
    baseline.current = restored
    baseTitle.current = savedTitle()
    aiUsed.current = false
    pending.current = false
    setSaving(false)
    setSavedOnce(true)
  }

  /** Called as you leave: save, and add one "You edited" version if anything changed. */
  const leave = useCallback(() => {
    window.clearTimeout(timer.current)
    if (!changed()) {
      if (pending.current) save()
      return
    }
    const v = makeVersion()
    write({ ...current(), versions: [v, ...docRef.current.versions] })
    baseline.current = toBlocks(itemsRef.current)
    baseTitle.current = savedTitle()
    aiUsed.current = false
    pending.current = false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => () => leave(), [leave])

  return {
    items, itemsRef, title, emoji, saving, savedOnce, fresh, focusReq,
    change, setTitle, setEmoji, focus, markAI, patchDoc, restore, leave, pendingVersion, undo, redo,
    canUndo: () => undoStack.current.length > 0, canRedo: () => redoStack.current.length > 0,
  }
}

export type DocDraft = ReturnType<typeof useDocDraft>
