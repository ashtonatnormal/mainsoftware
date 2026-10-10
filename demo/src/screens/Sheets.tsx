// Sheets (DOC-12): a small spreadsheet editor inside the Drive. Formulas are
// evaluated by sheets/formula.ts; "Ask about this sheet" answers from the
// cells (sheets/ask.ts) and only suggests. Restricted editing per DOC-03.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { ArrowLeft, Check, ChevronRight, ClipboardCopy, Copy, FilePlus2, Lock, MoreHorizontal, MoreVertical, Pencil, Plus, Share2, Sheet as SheetIcon, Sparkles, Star, Trash2, X } from 'lucide-react'
import type { PersonId, Sheet, SheetCell, SheetTab } from '../types'
import { newId, useStore } from '../store'
import { ME } from '../data/people'
import { canEdit, folderPath } from '../drive'
import { clock, listStamp } from '../time'
import { AvatarStack, Button, cx, EmptyState, IconButton, personName, personShort, Sheet as Dialog } from '../ui'
import { ShareDialog } from '../ui/share'
import { addrOf, cellsIn, colName, computeTab, formatValue, fromTSV, isError, parseAddr, parseLiteral, rangeLabel, rangeOf, shiftFormula, toCSV, toTSV, type Pos, type Range, type Value } from './sheets/formula'
import { errorHelp, Grid, type EditState } from './sheets/Grid'
import { Toolbar, type QuickFn } from './sheets/Toolbar'
import { AskPanel, AskTitle } from './sheets/AskPanel'
import { numericRunAbove, suggestFormula, type CellRef } from './sheets/ask'
import { MenuItem, Popover } from './sheets/Popover'

function useMedia(q: string) {
  const [on, setOn] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches)
  useEffect(() => {
    const mq = window.matchMedia(q)
    const f = () => setOn(mq.matches)
    mq.addEventListener('change', f)
    return () => mq.removeEventListener('change', f)
  }, [q])
  return on
}

export default function SheetsScreen() {
  const { state, back } = useStore()
  const id = state.route.name === 'sheets' ? state.route.sheetId : undefined
  const sheet = state.sheets.find(s => s.id === id)
  if (!sheet) {
    return (
      <div className="flex h-full flex-col bg-bg">
        <header className="flex h-14 items-center gap-2 border-b border-line bg-surface px-2">
          <IconButton label="Back" onClick={back}><ArrowLeft size={20} /></IconButton>
        </header>
        <EmptyState icon={<SheetIcon size={28} />} title="This sheet isn’t here" body="It may have been deleted, or you don’t have access. Ask the owner to share it with you." />
      </div>
    )
  }
  return <SheetEditor key={sheet.id} sheet={sheet} />
}

// ── Per-sheet memory while the page is open ──────────────────────────────────
interface History { undo: SheetTab[][]; redo: SheetTab[][] }
const histories = new Map<string, History>()
const seen = new Set<string>()
/** What we last copied, so pasting it back keeps formulas (shifted) instead of values. */
let clip: { text: string; raw: string[][]; origin: Pos } | null = null

const conditional: Record<string, (tab: SheetTab, values: Map<string, Value>) => ((addr: string, v: Value) => 'warn' | undefined) | undefined> = {
  // Q4 forecast: any week whose total goes over the cold-room capacity shows amber.
  sh_forecast: tab => {
    if (tab.id !== 't_weekly') return undefined
    return (addr, v) => {
      const p = parseAddr(addr)
      if (!p || p.r < 1 || p.r > 8) return undefined
      if (p.c === 6 && typeof v === 'number' && v > 1) return 'warn'
      return undefined
    }
  },
}

type Sel = { a: Pos; f: Pos }

function SheetEditor({ sheet }: { sheet: Sheet }) {
  const store = useStore()
  const { state, updateSheet, renameItem, toggleStar, trashItem, restoreItem, createSheet, navigate, toast } = store
  const desktop = useMedia('(min-width: 768px)')
  const wide = useMedia('(min-width: 1024px)')
  const editable = canEdit(sheet) && !sheet.trashed
  const rowH = desktop ? 30 : 36
  const headH = desktop ? 26 : 30

  const [tabId, setTabId] = useState(sheet.tabs[0]?.id)
  const tab = sheet.tabs.find(t => t.id === tabId) ?? sheet.tabs[0]
  const [sel, setSel] = useState<Sel>({ a: { r: 0, c: 0 }, f: { r: 0, c: 0 } })
  const [edit, setEditState] = useState<EditState | null>(null)
  const editRef = useRef<EditState | null>(null)
  const setEdit = (e: EditState | null) => { editRef.current = e; setEditState(e) }
  const [widths, setWidths] = useState<Record<string, number>>({})
  const [saving, setSaving] = useState(false)
  const [askOpen, setAskOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)
  const [cursors, setCursors] = useState<Record<PersonId, string>>(() => ({ ...(sheet.cursors ?? {}) }))
  const gridRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const barRef = useRef<HTMLInputElement>(null)
  const [, bump] = useState(0)
  const history = histories.get(sheet.id) ?? (histories.set(sheet.id, { undo: [], redo: [] }), histories.get(sheet.id)!)
  const refInsert = useRef<{ start: number; anchor: Pos; after: string } | null>(null)

  const values = useMemo(() => computeTab(tab.cells, tab), [tab])
  const highlight = useMemo(() => conditional[sheet.id]?.(tab, values), [sheet.id, tab, values])
  const range = rangeOf(sel.a, sel.f)
  const active = sel.a
  const activeAddr = addrOf(active)
  const activeCell = tab.cells[activeAddr]

  // New sheet: title first, then A1.
  const isNew = useRef(!seen.has(sheet.id) && sheet.ownerId === ME && sheet.title === 'Untitled sheet' && sheet.tabs.every(t => Object.keys(t.cells).length === 0))
  useEffect(() => {
    seen.add(sheet.id)
    if (isNew.current && titleRef.current) { titleRef.current.focus(); titleRef.current.select() }
    else gridRef.current?.focus({ preventScroll: true })
  }, [sheet.id])

  // Collaborators wander a little so the sheet feels live.
  useEffect(() => {
    const ids = Object.keys(cursors)
    if (!ids.length || sheet.presence.length === 0) return
    const t = window.setInterval(() => {
      setCursors(cur => {
        const pid = ids[Math.floor(Math.random() * ids.length)]
        const p = parseAddr(cur[pid] ?? 'A1')
        if (!p) return cur
        const home = parseAddr(sheet.cursors?.[pid] ?? 'B2') ?? { r: 1, c: 1 }
        const next = { r: Math.max(1, Math.min(home.r + 3, p.r + [-1, 0, 1][Math.floor(Math.random() * 3)])), c: Math.max(0, Math.min(home.c + 1, p.c + [-1, 0, 1][Math.floor(Math.random() * 3)])) }
        return { ...cur, [pid]: addrOf(next) }
      })
    }, 6500)
    return () => clearInterval(t)
  }, [sheet.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the active cell in view (not when a whole row or column was picked).
  const skipScroll = useRef(false)
  useEffect(() => {
    if (skipScroll.current) { skipScroll.current = false; return }
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-addr="${addrOf(sel.f)}"]`)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [sel.f.r, sel.f.c, tab.id])

  // ── Changes (all go through here so undo and "Saved" work) ─────────────
  // Several changes can land in one event (commit an edit, then apply a style),
  // so they build on the latest sheet in sheetRef, not on this render's props.
  const sheetRef = useRef(sheet)
  sheetRef.current = sheet
  const curTab = () => sheetRef.current.tabs.find(t => t.id === tab.id) ?? sheetRef.current.tabs[0]
  const saveTimer = useRef<number | undefined>(undefined)
  const commitTabs = (tabs: SheetTab[], opts: { record?: boolean } = {}) => {
    const prev = sheetRef.current
    if (opts.record !== false) {
      history.undo.push(prev.tabs)
      if (history.undo.length > 100) history.undo.shift()
      history.redo = []
    }
    const next = { ...prev, tabs, updatedAt: state.clock, updatedBy: ME }
    sheetRef.current = next
    updateSheet(next)
    setSaving(true)
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => setSaving(false), 700)
  }
  useEffect(() => () => window.clearTimeout(saveTimer.current), [])

  const patchTab = (patch: Partial<SheetTab>, id = tab.id) => commitTabs(sheetRef.current.tabs.map(t => (t.id === id ? { ...t, ...patch } : t)))

  /** Writes cells; null clears a cell's value (formatting stays). */
  const writeCells = (changes: Record<string, Partial<SheetCell> | null>, grow?: { rows: number; cols: number }) => {
    const t = curTab()
    const cells = { ...t.cells }
    for (const [addr, ch] of Object.entries(changes)) {
      const prev = cells[addr]
      const next: SheetCell = ch === null ? { ...(prev ?? { v: '' }), v: '' } : { ...(prev ?? { v: '' }), ...ch }
      const styled = next.b || next.i || next.align || next.fmt || next.fill
      if (!next.v && !styled) delete cells[addr]
      else cells[addr] = next
    }
    patchTab({ cells, ...(grow ? { rows: Math.max(t.rows, grow.rows), cols: Math.max(t.cols, grow.cols) } : {}) })
  }

  // After undo/redo the tab may be gone or smaller, so keep the selection inside it.
  const afterHistory = (tabs: SheetTab[]) => {
    const t = tabs.find(x => x.id === tab.id) ?? tabs[0]
    if (t.id !== tab.id) setTabId(t.id)
    const fit = (p: Pos): Pos => ({ r: Math.min(p.r, t.rows - 1), c: Math.min(p.c, t.cols - 1) })
    setSel(s => ({ a: fit(s.a), f: fit(s.f) }))
  }
  const undo = () => {
    const prev = history.undo.pop()
    if (!prev) return
    history.redo.push(sheetRef.current.tabs)
    commitTabs(prev, { record: false })
    afterHistory(prev)
    bump(n => n + 1)
  }
  const redo = () => {
    const next = history.redo.pop()
    if (!next) return
    history.undo.push(sheetRef.current.tabs)
    commitTabs(next, { record: false })
    afterHistory(next)
    bump(n => n + 1)
  }

  // Ctrl+Z with nothing focused would run the browser's own undo (and revert
  // the title field), so route it to the sheet instead.
  const undoRef = useRef({ undo, redo, editable })
  undoRef.current = { undo, redo, editable }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      if (el && el !== document.body && (el.tagName !== 'BUTTON' || !rootRef.current?.contains(el))) return
      const k = e.key.toLowerCase()
      if (!(e.ctrlKey || e.metaKey) || (k !== 'z' && k !== 'y')) return
      e.preventDefault()
      const u = undoRef.current
      if (!u.editable) return
      if (k === 'y' || e.shiftKey) u.redo()
      else u.undo()
      gridRef.current?.focus({ preventScroll: true })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ── Selection ───────────────────────────────────────────────────────────
  const clamp = (p: Pos): Pos => ({ r: Math.max(0, Math.min(tab.rows - 1, p.r)), c: Math.max(0, Math.min(tab.cols - 1, p.c)) })
  const select = (a: Pos, f: Pos = a) => setSel({ a: clamp(a), f: clamp(f) })
  const move = (dr: number, dc: number, extend = false) => {
    if (extend) setSel(s => ({ a: s.a, f: clamp({ r: s.f.r + dr, c: s.f.c + dc }) }))
    else select({ r: active.r + dr, c: active.c + dc })
  }
  const focusGrid = () => gridRef.current?.focus({ preventScroll: true })

  // ── Editing ─────────────────────────────────────────────────────────────
  const startEdit = (mode: EditState['mode'], value = activeCell?.v ?? '') => {
    if (!editable) return
    refInsert.current = null
    setEdit({ value, mode })
  }
  const commitEdit = (dr = 0, dc = 0) => {
    const e = editRef.current
    if (!e) return
    setEdit(null)
    refInsert.current = null
    const prev = activeCell?.v ?? ''
    if (e.value !== prev && !(e.value.trim() === '' && prev === '')) {
      const lit: { fmt?: SheetCell['fmt'] } = e.value.startsWith('=') ? {} : parseLiteral(e.value)
      writeCells({ [activeAddr]: e.value.trim() === '' ? null : { v: e.value, ...(lit.fmt && !activeCell?.fmt ? { fmt: lit.fmt } : {}) } })
    }
    if (dr || dc) select({ r: active.r + dr, c: active.c + dc })
    focusGrid()
  }
  const cancelEdit = () => { setEdit(null); refInsert.current = null; focusGrid() }

  /** While typing a formula, clicking cells inserts their references. */
  const refMode = () => {
    const e = editRef.current
    if (!e || !e.value.startsWith('=')) return false
    if (refInsert.current && refInsert.current.after === e.value) return true
    return /[=(,+\-*/^&<>:]\s*$/.test(e.value)
  }
  const insertRef = (anchor: Pos, to: Pos = anchor) => {
    const e = editRef.current!
    const ri = refInsert.current && refInsert.current.after === e.value ? refInsert.current : null
    const start = ri ? ri.start : e.value.length
    const label = rangeLabel(rangeOf(ri && to !== anchor ? ri.anchor : anchor, to))
    const value = e.value.slice(0, start) + label
    refInsert.current = { start, anchor: ri && to !== anchor ? ri.anchor : anchor, after: value }
    setEdit({ ...e, value })
    window.requestAnimationFrame(() => (e.mode === 'bar' ? barRef.current : inputRef.current)?.focus())
  }

  const dragging = useRef(false)
  // On touch the editor blurs before the tap on another cell arrives. While a
  // formula is waiting for a reference, hold the commit briefly so the tap can
  // insert the reference instead.
  const blurTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(blurTimer.current), [])
  const onEditorBlur = () => {
    if (!editRef.current) return
    if (refMode()) {
      window.clearTimeout(blurTimer.current)
      blurTimer.current = window.setTimeout(() => {
        const a = document.activeElement
        if (editRef.current && a !== inputRef.current && a !== barRef.current) commitEdit()
      }, 400)
      return
    }
    commitEdit()
  }
  const onCellPointerDown = (p: Pos, e: ReactPointerEvent) => {
    const up = () => { dragging.current = false; window.removeEventListener('pointerup', up) }
    window.addEventListener('pointerup', up)
    dragging.current = true
    if (editRef.current && refMode()) {
      e.preventDefault()
      insertRef(p)
      return
    }
    if (editRef.current) commitEdit()
    if (e.shiftKey) setSel(s => ({ a: s.a, f: clamp(p) }))
    else select(p)
    if (document.activeElement !== gridRef.current) { e.preventDefault(); focusGrid() }
  }
  const onCellPointerEnter = (p: Pos) => {
    if (!dragging.current) return
    if (editRef.current && refInsert.current) { insertRef(refInsert.current.anchor, p); return }
    if (!editRef.current) setSel(s => ({ a: s.a, f: clamp(p) }))
  }
  const onCellTap = (p: Pos) => {
    window.clearTimeout(blurTimer.current)
    if (editRef.current && refMode()) { insertRef(p); return }
    const same = p.r === active.r && p.c === active.c && range.r0 === range.r1 && range.c0 === range.c1
    if (editRef.current) commitEdit()
    if (same && editable && !editRef.current) startEdit('inplace')
    else select(p)
  }
  const onHeaderSelect = (kind: 'row' | 'col', i: number, extend: boolean) => {
    if (editRef.current) commitEdit()
    skipScroll.current = true
    if (kind === 'col') {
      if (extend) setSel(s => ({ a: { r: 0, c: s.a.c }, f: { r: tab.rows - 1, c: i } }))
      else setSel({ a: { r: 0, c: i }, f: { r: tab.rows - 1, c: i } })
    } else {
      if (extend) setSel(s => ({ a: { r: s.a.r, c: 0 }, f: { r: i, c: tab.cols - 1 } }))
      else setSel({ a: { r: i, c: 0 }, f: { r: i, c: tab.cols - 1 } })
    }
    focusGrid()
  }

  const clearRange = () => {
    const ch: Record<string, null> = {}
    const cur = curTab().cells
    for (const p of cellsIn(range)) if (cur[addrOf(p)]?.v) ch[addrOf(p)] = null
    if (Object.keys(ch).length) writeCells(ch)
  }

  const styleRange = (patch: Partial<SheetCell>) => {
    if (!editable) return
    if (editRef.current) commitEdit()
    const ch: Record<string, Partial<SheetCell>> = {}
    for (const p of cellsIn(range)) ch[addrOf(p)] = patch
    // Undefined values clear a style.
    const cells = { ...curTab().cells }
    for (const [addr, pt] of Object.entries(ch)) {
      const next: SheetCell = { ...(cells[addr] ?? { v: '' }), ...pt }
      for (const k of Object.keys(pt) as (keyof SheetCell)[]) if (pt[k] === undefined) delete next[k]
      if (!next.v && !(next.b || next.i || next.align || next.fmt || next.fill)) delete cells[addr]
      else cells[addr] = next
    }
    patchTab({ cells })
  }

  // Σ: a function for the selection, or for the numbers above the cell.
  const quick = (fn: QuickFn) => {
    if (!editable) return
    if (editRef.current) commitEdit()
    const multi = range.r0 !== range.r1 || range.c0 !== range.c1
    if (multi) {
      const ch: Record<string, Partial<SheetCell>> = {}
      let targets: Pos[]
      if (range.r0 === range.r1) {
        const t = { r: range.r0, c: range.c1 + 1 }
        ch[addrOf(t)] = { v: `=${fn}(${rangeLabel(range)})` }
        targets = [t]
      } else {
        targets = []
        for (let c = range.c0; c <= range.c1; c++) {
          const t = { r: range.r1 + 1, c }
          ch[addrOf(t)] = { v: `=${fn}(${rangeLabel({ r0: range.r0, c0: c, r1: range.r1, c1: c })})`, fmt: tab.cells[addrOf({ r: range.r1, c })]?.fmt }
          targets.push(t)
        }
      }
      const last = targets[targets.length - 1]
      writeCells(ch, { rows: last.r + 1, cols: last.c + 1 })
      setSel({ a: targets[0], f: last })
      return
    }
    const run = numericRunAbove(tab, values, active)
    if (run && !activeCell?.v) {
      writeCells({ [activeAddr]: { v: `=${fn}(${rangeLabel(run)})`, ...(activeCell?.fmt ? {} : { fmt: tab.cells[addrOf({ r: run.r1, c: run.c0 })]?.fmt }) } })
      return
    }
    startEdit('inplace', `=${fn}(`)
  }

  // ── Keyboard ────────────────────────────────────────────────────────────
  const onGridKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.target !== gridRef.current) return
    const mod = e.ctrlKey || e.metaKey
    const k = e.key
    if (mod && !e.altKey) {
      const lk = k.toLowerCase()
      if (lk === 'z') { e.preventDefault(); if (!editable) return; if (e.shiftKey) redo(); else undo(); return }
      if (lk === 'y') { e.preventDefault(); if (editable) redo(); return }
      if (lk === 'b') { e.preventDefault(); styleRange({ b: !activeCell?.b }); return }
      if (lk === 'i') { e.preventDefault(); styleRange({ i: !activeCell?.i }); return }
      if (lk === 'a') { e.preventDefault(); skipScroll.current = true; setSel({ a: { r: 0, c: 0 }, f: { r: tab.rows - 1, c: tab.cols - 1 } }); return }
      if (k.startsWith('Arrow')) {
        e.preventDefault()
        const to = { ArrowUp: { r: 0, c: active.c }, ArrowDown: { r: tab.rows - 1, c: active.c }, ArrowLeft: { r: active.r, c: 0 }, ArrowRight: { r: active.r, c: tab.cols - 1 } }[k]!
        if (e.shiftKey) setSel(s => ({ a: s.a, f: clamp({ r: k === 'ArrowUp' || k === 'ArrowDown' ? to.r : s.f.r, c: k === 'ArrowLeft' || k === 'ArrowRight' ? to.c : s.f.c }) }))
        else select(to)
      }
      return
    }
    switch (k) {
      case 'ArrowUp': e.preventDefault(); move(-1, 0, e.shiftKey); return
      case 'ArrowDown': e.preventDefault(); move(1, 0, e.shiftKey); return
      case 'ArrowLeft': e.preventDefault(); move(0, -1, e.shiftKey); return
      case 'ArrowRight': e.preventDefault(); move(0, 1, e.shiftKey); return
      case 'Tab': e.preventDefault(); move(0, e.shiftKey ? -1 : 1); return
      case 'Enter': e.preventDefault(); move(e.shiftKey ? -1 : 1, 0); return
      case 'Home': e.preventDefault(); select({ r: active.r, c: 0 }); return
      case 'End': e.preventDefault(); select({ r: active.r, c: tab.cols - 1 }); return
      case 'PageDown': e.preventDefault(); move(10, 0, e.shiftKey); return
      case 'PageUp': e.preventDefault(); move(-10, 0, e.shiftKey); return
      case 'F2': e.preventDefault(); startEdit('inplace'); return
      case 'Escape': e.preventDefault(); select(active); return
      case 'Delete': case 'Backspace': e.preventDefault(); if (editable) clearRange(); return
    }
    if (k.length === 1 && !e.altKey && editable) {
      e.preventDefault()
      startEdit('type', k)
    }
  }

  const onEditKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const k = e.key
    if (k === 'Enter') { e.preventDefault(); commitEdit(e.shiftKey ? -1 : 1, 0); return }
    if (k === 'Tab') { e.preventDefault(); commitEdit(0, e.shiftKey ? -1 : 1); return }
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(); return }
    const ed = editRef.current
    if (ed?.mode === 'type' && !ed.value.startsWith('=') && k.startsWith('Arrow')) {
      e.preventDefault()
      commitEdit(k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0, k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0)
    }
  }

  // ── Clipboard (TSV through the copy/cut/paste events) ───────────────────
  const clipRef = useRef({ range, tab, values, editable, writeCells, clearRange })
  clipRef.current = { range, tab, values, editable, writeCells, clearRange }
  useEffect(() => {
    const ours = () => document.activeElement === gridRef.current && !editRef.current
    const copy = (e: ClipboardEvent, cut: boolean) => {
      if (!ours()) return
      const { range: g, tab: t, values: vals, editable: canWrite, clearRange: clear } = clipRef.current
      const shown: string[][] = [], raw: string[][] = []
      for (let r = g.r0; r <= g.r1; r++) {
        const sr: string[] = [], rr: string[] = []
        for (let c = g.c0; c <= g.c1; c++) {
          const a = addrOf({ r, c })
          sr.push(formatValue(vals.get(a) ?? null, t.cells[a]?.fmt))
          rr.push(t.cells[a]?.v ?? '')
        }
        shown.push(sr); raw.push(rr)
      }
      const text = toTSV(shown)
      e.clipboardData?.setData('text/plain', text)
      e.preventDefault()
      clip = { text, raw, origin: { r: g.r0, c: g.c0 } }
      if (cut && canWrite) clear()
      toast(`${cut ? 'Cut' : 'Copied'} ${rangeLabel(g)}`)
    }
    const onCopy = (e: ClipboardEvent) => copy(e, false)
    const onCut = (e: ClipboardEvent) => copy(e, true)
    const onPaste = (e: ClipboardEvent) => {
      if (!ours()) return
      const { range: g, editable: canWrite, writeCells: write } = clipRef.current
      e.preventDefault()
      if (!canWrite) { toast('This sheet is view only'); return }
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (!text) return
      const internal = clip && clip.text === text ? clip : null
      const grid = internal ? internal.raw : fromTSV(text)
      const dr = g.r0 - (internal?.origin.r ?? 0), dc = g.c0 - (internal?.origin.c ?? 0)
      const ch: Record<string, Partial<SheetCell> | null> = {}
      const MAX_COLS = 52, MAX_ROWS = 2000
      grid.forEach((row, i) => row.forEach((v, j) => {
        if (g.c0 + j >= MAX_COLS || g.r0 + i >= MAX_ROWS) return
        const a = addrOf({ r: g.r0 + i, c: g.c0 + j })
        const val = internal ? shiftFormula(v, dr, dc) : v
        ch[a] = val === '' ? null : { v: val }
      }))
      const rows = Math.min(g.r0 + grid.length, MAX_ROWS), cols = Math.min(g.c0 + Math.max(...grid.map(r => r.length)), MAX_COLS)
      write(ch, { rows, cols })
      setSel({ a: { r: g.r0, c: g.c0 }, f: { r: rows - 1, c: cols - 1 } })
    }
    document.addEventListener('copy', onCopy)
    document.addEventListener('cut', onCut)
    document.addEventListener('paste', onPaste)
    return () => { document.removeEventListener('copy', onCopy); document.removeEventListener('cut', onCut); document.removeEventListener('paste', onPaste) }
  }, [toast])

  // ── Tabs ────────────────────────────────────────────────────────────────
  const switchTab = (id: string) => {
    if (editRef.current) commitEdit()
    setTabId(id)
    setSel({ a: { r: 0, c: 0 }, f: { r: 0, c: 0 } })
    setWidths({})
  }
  const addTab = () => {
    if (editRef.current) commitEdit()
    let n = sheet.tabs.length + 1
    while (sheet.tabs.some(t => t.name === `Sheet${n}`)) n++
    const t: SheetTab = { id: newId('tab'), name: `Sheet${n}`, rows: 50, cols: 12, cells: {} }
    commitTabs([...sheetRef.current.tabs, t])
    setTabId(t.id)
    setSel({ a: { r: 0, c: 0 }, f: { r: 0, c: 0 } })
  }
  const renameTab = (id: string, name: string) => {
    const n = name.trim()
    if (!n || sheet.tabs.find(t => t.id === id)?.name === n) return
    if (sheet.tabs.some(t => t.id !== id && t.name.toLowerCase() === n.toLowerCase())) { toast(`There’s already a tab called “${n}”`); return }
    patchTab({ name: n }, id)
  }
  const deleteTab = (id: string) => {
    const i = sheet.tabs.findIndex(t => t.id === id)
    const rest = sheetRef.current.tabs.filter(t => t.id !== id)
    if (!rest.length) return
    commitTabs(rest)
    if (id === tab.id) switchTab(rest[Math.max(0, i - 1)].id)
    toast('Tab deleted. Undo brings it back.')
    window.requestAnimationFrame(focusGrid)
  }

  // ── Ask ────────────────────────────────────────────────────────────────
  const onRef = (r: CellRef) => {
    if (r.tabId !== tab.id) setTabId(r.tabId)
    setSel({ a: { r: r.range.r0, c: r.range.c0 }, f: { r: r.range.r1, c: r.range.c1 } })
    if (!wide) setAskOpen(false)
    focusGrid()
  }
  const acceptFormula = (addr: string, formula: string) => {
    const p = parseAddr(addr)!
    const run = numericRunAbove(tab, values, p)
    writeCells({ [addr]: { v: formula, ...(tab.cells[addr]?.fmt || !run ? {} : { fmt: tab.cells[addrOf({ r: run.r1, c: run.c0 })]?.fmt }) } })
    toast(`Formula added to ${addr}`)
    if (!wide) setAskOpen(false)
  }
  const suggestion = editable && !activeCell?.v ? suggestFormula(tab, active) : null

  // ── Title ──────────────────────────────────────────────────────────────
  const [title, setTitle] = useState(sheet.title)
  useEffect(() => setTitle(sheet.title), [sheet.title])
  const titleKey = useRef<'enter' | 'escape' | null>(null)
  const saveTitle = () => {
    const how = titleKey.current
    titleKey.current = null
    const t = title.trim()
    if (how === 'escape' || !t) setTitle(sheet.title)
    else if (t !== sheet.title) {
      renameItem(sheet.id, t)
      sheetRef.current = { ...sheetRef.current, title: t }
      setSaving(true); window.clearTimeout(saveTimer.current); saveTimer.current = window.setTimeout(() => setSaving(false), 700)
    }
    // New sheet: Enter (or Escape) moves on to A1; clicking somewhere else goes there instead.
    if (isNew.current) {
      isNew.current = false
      if (how) { select({ r: 0, c: 0 }); window.requestAnimationFrame(focusGrid) }
    }
  }

  // ── More menu ──────────────────────────────────────────────────────────
  const copyCsv = () => {
    const rows: string[][] = []
    let maxR = -1, maxC = -1
    for (const a of Object.keys(tab.cells)) { const p = parseAddr(a); if (p && tab.cells[a].v) { maxR = Math.max(maxR, p.r); maxC = Math.max(maxC, p.c) } }
    for (let r = 0; r <= maxR; r++) rows.push(Array.from({ length: maxC + 1 }, (_, c) => { const a = addrOf({ r, c }); return formatValue(values.get(a) ?? null, tab.cells[a]?.fmt) }))
    const csv = toCSV(rows)
    try {
      navigator.clipboard.writeText(csv).then(
        () => toast(`Copied “${tab.name}” as CSV (${rows.length} rows)`),
        () => toast('Couldn’t reach the clipboard here. Select the cells and press Ctrl+C instead.'),
      )
    } catch {
      toast('Couldn’t reach the clipboard here. Select the cells and press Ctrl+C instead.')
    }
  }
  const makeCopy = () => {
    const tabs = sheet.tabs.map(t => ({ ...t, id: newId('tab'), cells: { ...t.cells }, colWidths: t.colWidths && { ...t.colWidths } }))
    createSheet({ folderId: sheet.folderId, title: `Copy of ${sheet.title}`, tabs })
    toast('Copy made. You own it, and only you can edit it until you share it.')
  }
  const moveToTrash = () => {
    trashItem(sheet.id)
    toast('Moved to trash. You can restore it from Trash in Drive.')
    navigate(sheet.folderId ? { name: 'drive', folderId: sheet.folderId } : { name: 'drive', view: 'my' })
  }

  // ── Derived labels ─────────────────────────────────────────────────────
  const path = folderPath(state.folders, sheet.folderId)
  const editors = [...new Set([sheet.ownerId, ...sheet.editors])]
  const editorNames = (() => {
    const n = editors.map(id => (id === ME ? 'you' : personName(id)))
    return n.length <= 1 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`
  })()
  const savedLabel = saving ? 'Saving…' : sheet.updatedBy === ME ? 'All changes saved' : `Edited by ${personShort(sheet.updatedBy ?? sheet.ownerId)} · ${listStamp(sheet.updatedAt)}${listStamp(sheet.updatedAt).includes(':') ? '' : `, ${clock(sheet.updatedAt)}`}`
  const others = sheet.presence.filter(p => p !== ME)

  // Status line: range maths, an error explained, or a hint.
  const status = (() => {
    const multi = range.r0 !== range.r1 || range.c0 !== range.c1
    if (multi) {
      const ns: number[] = []
      let fmt: SheetCell['fmt']
      let filled = 0
      for (const p of cellsIn(range)) {
        const a = addrOf(p)
        const v = values.get(a)
        if (v !== undefined && v !== null && v !== '') filled++
        if (typeof v === 'number') { ns.push(v); fmt ??= tab.cells[a]?.fmt }
      }
      const f = fmt === 'text' ? undefined : fmt === 'integer' ? 'number' : fmt
      if (!ns.length) return { kind: 'range' as const, text: `${rangeLabel(range)} · Count ${filled}` }
      const sum = ns.reduce((a, b) => a + b, 0)
      return {
        kind: 'range' as const,
        parts: [['Sum', formatValue(sum, f ?? 'number')], ['Average', formatValue(sum / ns.length, f === 'percent' || f === 'currency' ? f : 'number')], ['Count', String(ns.length)]] as [string, string][],
      }
    }
    const v = values.get(activeAddr)
    if (isError(v)) return { kind: 'error' as const, text: `${v.error} ${errorHelp(v.error)}` }
    return null
  })()

  const rangeOn = range.r0 !== range.r1 || range.c0 !== range.c1

  const header = (
    <header className="flex min-h-14 shrink-0 items-center gap-1.5 border-b border-line bg-surface px-2 py-1.5 md:gap-2 md:px-3">
      <IconButton label="Back" onClick={store.back}><ArrowLeft size={20} /></IconButton>
      <span className="hidden size-9 shrink-0 place-items-center rounded-xl bg-ok-soft text-ok sm:grid" aria-hidden><SheetIcon size={18} /></span>
      <div className="min-w-0 flex-1">
        {editable ? (
          <>
            <label htmlFor="sheet-title" className="sr-only">Sheet title</label>
            <input
              id="sheet-title"
              ref={titleRef}
              value={title}
              onChange={e => setTitle(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); titleKey.current = 'enter'; e.currentTarget.blur() } if (e.key === 'Escape') { titleKey.current = 'escape'; e.currentTarget.blur() } }}
              className="-ml-1 w-full min-w-0 truncate rounded-md bg-transparent px-1 font-display text-[17px] leading-tight font-semibold outline-none hover:bg-surface-2 focus:bg-surface-2 md:text-lg"
            />
          </>
        ) : (
          <h1 className="truncate font-display text-[17px] leading-tight font-semibold md:text-lg">{sheet.title}</h1>
        )}
        <div className="flex min-w-0 items-center gap-1 text-xs text-muted">
          <nav aria-label="Folder" className="flex max-w-[60%] min-w-0 shrink-0 items-center gap-0.5 truncate">
            {path.length === 0 ? (
              <button className="shrink-0 hover:text-fg hover:underline" onClick={() => navigate({ name: 'drive', view: sheet.ownerId === ME ? 'my' : 'shared' })}>{sheet.ownerId === ME ? 'My Drive' : 'Shared with me'}</button>
            ) : (
              path.map((f, i) => (
                <span key={f.id} className={cx('flex min-w-0 items-center gap-0.5', i < path.length - 1 && 'hidden sm:flex')}>
                  {i > 0 && <ChevronRight size={11} className="shrink-0" aria-hidden />}
                  <button className="truncate hover:text-fg hover:underline" onClick={() => navigate({ name: 'drive', folderId: f.id })}>{f.title}</button>
                </span>
              ))
            )}
          </nav>
          <span aria-hidden>·</span>
          <span className="flex min-w-0 items-center gap-1" aria-live="polite">
            {!saving && sheet.updatedBy === ME && <Check size={12} className="text-ok" aria-hidden />}
            <span className="truncate">{savedLabel}</span>
          </span>
        </div>
      </div>
      {others.length > 0 && (
        <span className="flex items-center" title={`${others.map(personShort).join(', ')} ${others.length === 1 ? 'is' : 'are'} here`}>
          <AvatarStack ids={others} size="sm" />
        </span>
      )}
      <IconButton label={sheet.starred ? 'Unstar' : 'Star'} className="hidden md:grid" onClick={() => toggleStar(sheet.id)}>
        <Star size={18} className={cx(sheet.starred && 'fill-current text-warn')} />
      </IconButton>
      {!wide && <IconButton label="Ask about this sheet" onClick={() => setAskOpen(true)} className="text-agent"><Sparkles size={19} /></IconButton>}
      {wide && <Button size="sm" variant={askOpen ? 'agent' : 'ghost'} icon={<Sparkles size={15} />} onClick={() => setAskOpen(o => !o)} aria-pressed={askOpen}>Ask</Button>}
      <span className="md:hidden"><IconButton label="Share" onClick={() => setShareOpen(true)}><Share2 size={18} /></IconButton></span>
      <span className="hidden md:block"><Button size="sm" variant="primary" icon={<Share2 size={15} />} onClick={() => setShareOpen(true)}>Share</Button></span>
      <button ref={moreRef} aria-label="More" title="More" aria-expanded={moreOpen} onClick={() => setMoreOpen(o => !o)} className="grid size-10 shrink-0 place-items-center rounded-full transition hover:bg-surface-2"><MoreHorizontal size={19} /></button>
    </header>
  )

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col bg-bg">
      {header}
      <Popover label="More" anchor={moreRef.current} open={moreOpen} onClose={() => setMoreOpen(false)} align="right">
        <div className="md:hidden">
          <MenuItem icon={<Star size={16} />} onClick={() => { toggleStar(sheet.id); setMoreOpen(false) }}>{sheet.starred ? 'Remove star' : 'Star'}</MenuItem>
        </div>
        <MenuItem icon={<FilePlus2 size={16} />} onClick={() => { setMoreOpen(false); createSheet({ folderId: editable ? sheet.folderId : null }) }}>New sheet</MenuItem>
        <MenuItem icon={<Copy size={16} />} onClick={() => { setMoreOpen(false); makeCopy() }}>Make a copy</MenuItem>
        <MenuItem icon={<ClipboardCopy size={16} />} onClick={() => { setMoreOpen(false); copyCsv() }} hint={tab.name}>Copy as CSV</MenuItem>
        <div className="my-1 h-px bg-line" />
        <MenuItem icon={<Trash2 size={16} />} danger disabled={!editable} onClick={() => { setMoreOpen(false); moveToTrash() }}>Move to trash</MenuItem>
        {!editable && !sheet.trashed && <p className="px-3 pb-1 text-[11px] text-muted">Only editors can move it to trash.</p>}
      </Popover>
      <ShareDialog itemId={sheet.id} open={shareOpen} onClose={() => setShareOpen(false)} />

      {sheet.trashed ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-line bg-rec-soft px-4 py-2 text-sm">
          <Trash2 size={16} className="shrink-0 text-rec" aria-hidden />
          <span className="min-w-0 flex-1">This sheet is in the trash, so it can’t be edited.</span>
          <Button size="sm" onClick={() => { restoreItem(sheet.id); toast('Restored') }}>Restore</Button>
        </div>
      ) : !editable && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-4 py-2 text-[13px] text-muted">
          <Lock size={14} className="shrink-0" aria-hidden />
          <span className="min-w-0">View only. {editorNames.charAt(0).toUpperCase() + editorNames.slice(1)} can edit.</span>
        </div>
      )}

      {editable && (
        <Toolbar
          cell={activeCell}
          canUndo={history.undo.length > 0}
          canRedo={history.redo.length > 0}
          onUndo={undo}
          onRedo={redo}
          onStyle={styleRange}
          onQuick={quick}
        />
      )}

      {/* Formula bar */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-surface px-2 md:px-3">
        <label htmlFor="sheet-goto" className="sr-only">Cell address (type one to jump)</label>
        <AddressBox id="sheet-goto" label={rangeOn ? rangeLabel(range) : activeAddr} onGo={a => { const g = a.includes(':') ? a.split(':').map(parseAddr) : [parseAddr(a)]; if (g[0]) { select(g[0], g[1] ?? g[0]); focusGrid() } else toast(`“${a}” isn’t a cell address`) }} />
        <span className="font-serif text-sm text-muted italic" aria-hidden>fx</span>
        <label htmlFor="sheet-formula" className="sr-only">Contents of {activeAddr}</label>
        <input
          id="sheet-formula"
          ref={barRef}
          readOnly={!editable}
          value={edit ? edit.value : activeCell?.v ?? ''}
          placeholder={editable ? 'Type a value or a formula, like =SUM(B2:B9)' : ''}
          onFocus={() => { if (editable && !editRef.current) startEdit('bar') }}
          onChange={e => setEdit({ value: e.target.value, mode: editRef.current?.mode ?? 'bar' })}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commitEdit(e.shiftKey ? -1 : 1, 0) }
            else if (e.key === 'Tab') { e.preventDefault(); commitEdit(0, e.shiftKey ? -1 : 1) }
            else if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
          }}
          onBlur={() => { if (editRef.current?.mode === 'bar') onEditorBlur() }}
          spellCheck={false}
          autoComplete="off"
          className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-1.5 font-mono text-base md:text-[13px] outline-none placeholder:font-sans placeholder:text-muted focus:bg-surface-2"
        />
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          <Grid
            tab={tab}
            values={values}
            range={range}
            active={active}
            edit={edit}
            readOnly={!editable}
            rowH={rowH}
            headH={headH}
            widths={widths}
            cursors={cursors}
            highlight={highlight}
            gridRef={gridRef}
            inputRef={inputRef}
            onGridKeyDown={onGridKeyDown}
            onCellPointerDown={onCellPointerDown}
            onCellPointerEnter={onCellPointerEnter}
            onCellTap={onCellTap}
            onCellDoubleClick={() => { if (editable) startEdit('inplace') }}
            onHeaderSelect={onHeaderSelect}
            onEditChange={v => setEdit({ value: v, mode: editRef.current?.mode ?? 'inplace' })}
            onEditKeyDown={onEditKeyDown}
            onEditBlur={() => { if (editRef.current && editRef.current.mode !== 'bar') onEditorBlur() }}
            onResize={(col, w, done) => {
              setWidths(ws => ({ ...ws, [col]: w }))
              if (done) { patchTab({ colWidths: { ...(tab.colWidths ?? {}), [col]: w } }); setWidths({}) }
            }}
            onAddRows={() => { if (editRef.current) commitEdit(); patchTab({ rows: curTab().rows + 20 }) }}
          />
        </div>
        {wide && askOpen && (
          <aside aria-label="Ask about this sheet" className="flex w-[340px] shrink-0 flex-col border-l border-line bg-bg">
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-4">
              <h2 className="flex-1 font-display text-base font-semibold"><AskTitle /></h2>
              <IconButton label="Close Ask" className="size-8" onClick={() => setAskOpen(false)}><X size={16} /></IconButton>
            </div>
            <AskPanel sheet={sheet} tab={tab} active={active} canEdit={editable} onRef={onRef} onAcceptFormula={acceptFormula} className="flex-1" />
          </aside>
        )}
      </div>
      {!wide && (
        <Dialog open={askOpen} onClose={() => setAskOpen(false)} title={<AskTitle />}>
          <div className="-mx-5 -my-4 flex h-[62vh] flex-col">
            <AskPanel sheet={sheet} tab={tab} active={active} canEdit={editable} onRef={onRef} onAcceptFormula={acceptFormula} className="flex-1" />
          </div>
        </Dialog>
      )}

      {/* Status line */}
      <div className="flex h-8 shrink-0 items-center gap-3 overflow-hidden border-t border-line bg-surface px-3 text-xs text-muted" aria-live="polite">
        {status?.kind === 'range' && 'parts' in status && status.parts ? (
          <div className="flex min-w-0 items-center gap-3 overflow-hidden whitespace-nowrap">
            <span className="hidden font-mono sm:inline">{rangeLabel(range)}</span>
            {status.parts.map(([k, v]) => (
              <span key={k} className="tabular"><span className="text-muted">{k}</span> <b className="font-semibold text-fg">{v}</b></span>
            ))}
          </div>
        ) : status?.kind === 'range' ? (
          <span className="truncate">{status.text}</span>
        ) : status?.kind === 'error' ? (
          <span className="truncate text-rec">{status.text}</span>
        ) : suggestion ? (
          <button className="inline-flex min-w-0 items-center gap-1.5 truncate font-medium text-agent hover:underline" onClick={() => setAskOpen(true)}>
            <Sparkles size={13} aria-hidden /> Suggest a formula for {activeAddr}
          </button>
        ) : highlight ? (
          <span className="flex min-w-0 items-center gap-1.5 pl-0.5"><span className="size-3 shrink-0 rounded-sm bg-warn-soft ring-1 ring-warn" aria-hidden /><span className="truncate">Amber: over the cold-room capacity</span></span>
        ) : (
          <span className="truncate">{editable ? (desktop ? 'Shift-click or drag to select a range' : 'Tap a cell to select it, tap again to edit') : 'Tap a cell to see its formula'}</span>
        )}
      </div>

      <TabsBar sheet={sheet} activeId={tab.id} editable={editable} onSwitch={switchTab} onAdd={addTab} onRename={renameTab} onDelete={deleteTab} />
    </div>
  )
}

// ── Address box (shows the selection; type an address to jump) ────────────
function AddressBox({ id, label, onGo }: { id: string; label: string; onGo: (a: string) => void }) {
  const [v, setV] = useState<string | null>(null)
  return (
    <input
      id={id}
      value={v ?? label}
      onFocus={e => { setV(label); e.currentTarget.select() }}
      onChange={e => setV(e.target.value)}
      onBlur={() => setV(null)}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); const a = (v ?? '').trim().toUpperCase(); setV(null); if (a) onGo(a) }
        if (e.key === 'Escape') { setV(null); e.currentTarget.blur() }
      }}
      spellCheck={false}
      autoComplete="off"
      className="h-7 w-[4.5rem] shrink-0 rounded-md border border-line bg-surface-2 text-center font-mono text-xs font-semibold outline-none focus:border-accent md:w-24"
    />
  )
}

// ── Tabs bar ──────────────────────────────────────────────────────────────
function TabsBar({ sheet, activeId, editable, onSwitch, onAdd, onRename, onDelete }: {
  sheet: Sheet
  activeId: string
  editable: boolean
  onSwitch: (id: string) => void
  onAdd: () => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
}) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const menuAnchor = useRef<HTMLButtonElement | null>(null)
  const startRename = (id: string) => {
    if (!editable) return
    setDraft(sheet.tabs.find(t => t.id === id)?.name ?? '')
    setRenaming(id)
  }
  const confirmTab = sheet.tabs.find(t => t.id === confirm)

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-t border-line bg-surface-2 px-2">
      {editable && <IconButton label="Add a tab" className="size-9" onClick={onAdd}><Plus size={17} /></IconButton>}
      <div role="tablist" aria-label="Tabs" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        {sheet.tabs.map(t => {
          const on = t.id === activeId
          if (renaming === t.id) {
            return (
              <span key={t.id} className="shrink-0">
                <label htmlFor="sheet-tab-rename" className="sr-only">Tab name</label>
                <input
                  id="sheet-tab-rename"
                  autoFocus
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onFocus={e => e.currentTarget.select()}
                  onBlur={() => { onRename(t.id, draft); setRenaming(null) }}
                  onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setDraft(t.name); setRenaming(null) } }}
                  className="h-8 w-32 rounded-lg border border-accent bg-surface px-2 text-[13px] font-semibold outline-none"
                />
              </span>
            )
          }
          return (
            <span key={t.id} className={cx('flex h-8 shrink-0 items-center rounded-lg text-[13px]', on ? 'bg-surface font-semibold text-fg shadow-card' : 'text-muted hover:bg-surface/60')}>
              <button role="tab" aria-selected={on} onClick={() => onSwitch(t.id)} onDoubleClick={() => startRename(t.id)} className={cx('h-full max-w-40 truncate pl-3', on && editable ? 'pr-1' : 'pr-3')} title={editable ? 'Double-click to rename' : undefined}>
                {t.name}
              </button>
              {on && editable && (
                <button
                  aria-label={`Options for ${t.name}`}
                  aria-expanded={menuFor === t.id}
                  ref={el => { if (on) menuAnchor.current = el }}
                  onClick={() => setMenuFor(menuFor === t.id ? null : t.id)}
                  className="mr-1 grid size-6 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
                >
                  <MoreVertical size={14} />
                </button>
              )}
            </span>
          )
        })}
      </div>
      <Popover label="Tab options" anchor={menuAnchor.current} open={!!menuFor} onClose={() => setMenuFor(null)} align="right">
        <MenuItem icon={<Pencil size={16} />} onClick={() => { const id = menuFor!; setMenuFor(null); startRename(id) }}>Rename</MenuItem>
        <MenuItem icon={<Trash2 size={16} />} danger disabled={sheet.tabs.length < 2} onClick={() => { setConfirm(menuFor); setMenuFor(null) }}>Delete tab</MenuItem>
        {sheet.tabs.length < 2 && <p className="px-3 pb-1 text-[11px] text-muted">A sheet needs at least one tab.</p>}
      </Popover>
      <Dialog
        open={!!confirmTab}
        onClose={() => setConfirm(null)}
        title={`Delete “${confirmTab?.name ?? ''}”?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => { onDelete(confirm!); setConfirm(null) }}>Delete tab</Button>
          </>
        }
      >
        <p className="text-sm">
          {confirmTab && Object.keys(confirmTab.cells).length ? `${filledLabel(Object.values(confirmTab.cells).filter(c => c.v).length)} go${Object.values(confirmTab.cells).filter(c => c.v).length === 1 ? 'es' : ''} with it.` : 'It’s empty.'} You can bring it back with Undo while this page is open.
        </p>
      </Dialog>
    </div>
  )
}

const filledLabel = (n: number) => (n === 1 ? 'Its 1 filled cell' : `Its ${n} filled cells`)
