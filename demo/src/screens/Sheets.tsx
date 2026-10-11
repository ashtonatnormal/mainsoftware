// Sheets (DOC-12): a small spreadsheet editor inside the Drive. Formulas are
// evaluated by sheets/formula.ts across all of a sheet's tabs (Roster!F14);
// "Ask about this sheet" answers from the cells (sheets/ask.ts) and only
// suggests. Restricted editing per DOC-03.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { ArrowLeft, Check, ClipboardCopy, Copy, Ellipsis, FilePlus2, Lock, MoreVertical, MousePointerClick, Pencil, Plus, Sheet as SheetIcon, Sparkles, Star, Trash2, TriangleAlert, Undo2, X } from 'lucide-react'
import type { PersonId, Sheet, SheetCell, SheetTab } from '../types'
import { newId, useStore } from '../store'
import { ME } from '../data/people'
import { canEdit, folderPath, isTrashed } from '../drive'
import { clock, listStamp } from '../time'
import { AvatarStack, Button, cx, EmptyState, IconButton, personName, personShort, Sheet as Dialog } from '../ui'
import { ShareDialog } from '../ui/share'
import { addrOf, cellsIn, colName, explainError, formatValue, formulasUsing, fromTSV, isError, parseAddr, parseLiteral, parseRef, rangeLabel, rangeOf, refText, removeTabFromBook, renameTabInBook, shiftFormula, tabValues, toCSV, toTSV, type Pos, type Range, type TabValues, type Value } from './sheets/formula'
import { Grid, type EditState } from './sheets/Grid'
import { Toolbar, type FillDir, type QuickFn } from './sheets/Toolbar'
import { AskPanel, AskTitle } from './sheets/AskPanel'
import { numericRunAbove, suggestFormula, type CellRef } from './sheets/ask'
import { MenuItem, Popover } from './sheets/Popover'
import { useCopy } from './drive/actions'
import { KindIcon } from './drive/art'
import { FileCrumbs, ShareButton } from './drive/header'
import { destinationFor } from './drive/create'

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
/** An edit in progress, and the cell it belongs to. While typing a formula you can visit other tabs to pick cells, so the cell isn't always on the tab you're looking at. */
type Editing = EditState & { home: { tabId: string; pos: Pos } }
const origin: Sel = { a: { r: 0, c: 0 }, f: { r: 0, c: 0 } }
/** Collaborators' seeded cursors are on the tab that was first when the sheet opened (they don't jump to another tab if it's deleted). */
const noCursors: Record<PersonId, string> = {}
const clampTo = (t: { rows: number; cols: number }, p: Pos): Pos => ({ r: Math.max(0, Math.min(t.rows - 1, p.r)), c: Math.max(0, Math.min(t.cols - 1, p.c)) })

function SheetEditor({ sheet }: { sheet: Sheet }) {
  const store = useStore()
  const { state, updateSheet, renameItem, toggleStar, trashItem, restoreItem, createSheet, navigate, toast, patchItem } = store
  const desktop = useMedia('(min-width: 768px)')
  const wide = useMedia('(min-width: 1024px)')
  // In the trash itself, or inside a folder that is (as in Docs and Slides).
  const trashed = isTrashed(state.folders, sheet)
  const editable = canEdit(sheet) && !trashed
  const rowH = desktop ? 30 : 36
  const headH = desktop ? 26 : 30

  const [tabId, setTabId] = useState(sheet.tabs[0]?.id)
  const tab = sheet.tabs.find(t => t.id === tabId) ?? sheet.tabs[0]
  const [sel, setSel] = useState<Sel>(origin)
  const [edit, setEditState] = useState<Editing | null>(null)
  const editRef = useRef<Editing | null>(null)
  const setEdit = (e: Editing | null) => { editRef.current = e; setEditState(e) }
  const [widths, setWidths] = useState<Record<string, number>>({})
  const [saving, setSaving] = useState(false)
  const [askOpen, setAskOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)
  const [cursors, setCursors] = useState<Record<PersonId, string>>(() => ({ ...(sheet.cursors ?? {}) }))
  const cursorTab = useRef(sheet.tabs[0]?.id)
  const gridRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const barRef = useRef<HTMLInputElement>(null)
  const [, bump] = useState(0)
  const history = histories.get(sheet.id) ?? (histories.set(sheet.id, { undo: [], redo: [] }), histories.get(sheet.id)!)
  const refInsert = useRef<{ start: number; anchor: Pos; after: string } | null>(null)

  // Values for the tab on show. Formulas can read other tabs, so this recalculates
  // when this tab or any tab it reads changes, and not for edits elsewhere.
  const valuesCache = useRef<TabValues | null>(null)
  const values = useMemo(() => (valuesCache.current = tabValues(sheet.tabs, tab.id, valuesCache.current)).values, [sheet.tabs, tab.id])
  const highlight = useMemo(() => conditional[sheet.id]?.(tab, values), [sheet.id, tab, values])
  const range = rangeOf(sel.a, sel.f)
  const active = sel.a
  const activeAddr = addrOf(active)
  const activeCell = tab.cells[activeAddr]
  // Picking cells on another tab for a formula that belongs to the home tab.
  const away = !!edit && edit.home.tabId !== tab.id
  const homeTab = edit ? sheet.tabs.find(t => t.id === edit.home.tabId) : undefined

  // New sheet: title first, then A1.
  const isNew = useRef(!seen.has(sheet.id) && sheet.ownerId === ME && sheet.title === 'Untitled sheet' && sheet.tabs.every(t => Object.keys(t.cells).length === 0))
  useEffect(() => {
    seen.add(sheet.id)
    // Opening a sheet counts as opening it in the Drive (Recent), wherever you came from.
    patchItem(sheet.id, { lastOpenedAt: state.clock })
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
  const curTab = (id = tab.id) => sheetRef.current.tabs.find(t => t.id === id) ?? sheetRef.current.tabs[0]
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
  const writeCells = (changes: Record<string, Partial<SheetCell> | null>, grow?: { rows: number; cols: number }, tabId = tab.id) => {
    const t = curTab(tabId)
    const cells = { ...t.cells }
    for (const [addr, ch] of Object.entries(changes)) {
      const prev = cells[addr]
      const next: SheetCell = ch === null ? { ...(prev ?? { v: '' }), v: '' } : { ...(prev ?? { v: '' }), ...ch }
      const styled = next.b || next.i || next.align || next.fmt || next.fill
      if (!next.v && !styled) delete cells[addr]
      else cells[addr] = next
    }
    patchTab({ cells, ...(grow ? { rows: Math.max(t.rows, grow.rows), cols: Math.max(t.cols, grow.cols) } : {}) }, t.id)
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
    setEdit({ value, mode, home: { tabId: tab.id, pos: active } })
  }
  const changeEdit = (value: string) => {
    const e = editRef.current
    setEdit(e ? { ...e, value } : { value, mode: 'bar', home: { tabId: tab.id, pos: active } })
  }
  /** Shows a tab with one cell selected (finishing an edit made on another tab comes back here). */
  const showTab = (id: string, p: Pos) => {
    if (id !== tab.id) { setTabId(id); setWidths({}) }
    setSel({ a: p, f: p })
  }
  const commitEdit = (dr = 0, dc = 0, refocus = true) => {
    const e = editRef.current
    if (!e) return
    setEdit(null)
    refInsert.current = null
    const home = sheetRef.current.tabs.find(t => t.id === e.home.tabId)
    if (!home) return
    const addr = addrOf(e.home.pos)
    const cell = home.cells[addr]
    const prev = cell?.v ?? ''
    if (e.value !== prev && !(e.value.trim() === '' && prev === '')) {
      const lit: { fmt?: SheetCell['fmt'] } = e.value.startsWith('=') ? {} : parseLiteral(e.value)
      writeCells({ [addr]: e.value.trim() === '' ? null : { v: e.value, ...(lit.fmt && !cell?.fmt ? { fmt: lit.fmt } : {}) } }, undefined, home.id)
    }
    // Enter, Tab and Done take you back to the cell you were editing, wherever you picked cells.
    if (home.id !== tab.id || dr || dc) showTab(home.id, clampTo(home, { r: e.home.pos.r + dr, c: e.home.pos.c + dc }))
    if (refocus) focusGrid()
  }
  const cancelEdit = () => {
    const e = editRef.current
    setEdit(null)
    refInsert.current = null
    if (e && e.home.tabId !== tab.id && sheetRef.current.tabs.some(t => t.id === e.home.tabId)) showTab(e.home.tabId, e.home.pos)
    focusGrid()
  }

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
    const from = ri && to !== anchor ? ri.anchor : anchor
    // On another tab the reference carries the tab's name: Roster!F2:F12.
    const label = away ? refText(rangeOf(from, to), tab.name) : rangeLabel(rangeOf(from, to))
    const value = e.value.slice(0, start) + label
    refInsert.current = { start, anchor: from, after: value }
    setEdit({ ...e, value })
    // The edited cell isn't on this tab, so the selection is free to show what you picked.
    if (away) setSel({ a: from, f: to })
    // The caret goes to the end of what's there by then: typing straight after a click mustn't land before it.
    // An edit finished in the meantime (Enter straight after the click) leaves focus where that put it.
    window.requestAnimationFrame(() => {
      const el = e.mode === 'bar' ? barRef.current : inputRef.current
      if (!el || !editRef.current) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
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
    if (editRef.current) { commitEdit(); if (away) { e.preventDefault(); return } }
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
    if (editRef.current) { commitEdit(); if (away) return }
    if (same && editable && !editRef.current) startEdit('inplace')
    else select(p)
  }
  const onHeaderSelect = (kind: 'row' | 'col', i: number, extend: boolean) => {
    if (editRef.current) { commitEdit(); if (away) return }
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

  // Fill down or right (Ctrl+D, Ctrl+R): copies the selection's first row or
  // column (or, for one row or column, the cells just above or to the left) into
  // the rest, moving relative references and keeping tab names (Roster!F2 → Roster!F3).
  const fill = (dir: FillDir) => {
    if (!editable) return
    if (editRef.current) commitEdit()
    const t = curTab()
    const down = dir === 'down'
    const src = down ? (range.r0 === range.r1 ? range.r0 - 1 : range.r0) : (range.c0 === range.c1 ? range.c0 - 1 : range.c0)
    if (src < 0) { toast(down ? 'There’s nothing above to fill down from' : 'There’s nothing to the left to fill right from'); return }
    const cells = { ...t.cells }
    for (let r = range.r0; r <= range.r1; r++) {
      for (let c = range.c0; c <= range.c1; c++) {
        if (down ? r === src : c === src) continue
        const from = down ? { r: src, c } : { r, c: src }
        const s = t.cells[addrOf(from)]
        if (!s) delete cells[addrOf({ r, c })]
        else cells[addrOf({ r, c })] = { ...s, v: s.fmt === 'text' ? s.v : shiftFormula(s.v, r - from.r, c - from.c) }
      }
    }
    patchTab({ cells })
  }

  // ── Keyboard ────────────────────────────────────────────────────────────
  // Tab walks along the row like a spreadsheet, but never traps focus (WCAG 2.1.2):
  // it leaves the grid past the last filled column (Shift+Tab before column A),
  // and straight away after Escape.
  const leaving = useRef(false)
  const lastCol = useMemo(() => Object.keys(tab.cells).reduce((m, a) => (tab.cells[a].v ? Math.max(m, parseAddr(a)?.c ?? 0) : m), 0), [tab])
  const onGridKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.target !== gridRef.current) return
    const mod = e.ctrlKey || e.metaKey
    const k = e.key
    const wasLeaving = leaving.current
    if (k !== 'Shift') leaving.current = false
    if (mod && !e.altKey) {
      const lk = k.toLowerCase()
      if (lk === 'z') { e.preventDefault(); if (!editable) return; if (e.shiftKey) redo(); else undo(); return }
      if (lk === 'y') { e.preventDefault(); if (editable) redo(); return }
      if (lk === 'b') { e.preventDefault(); styleRange({ b: !activeCell?.b }); return }
      if (lk === 'i') { e.preventDefault(); styleRange({ i: !activeCell?.i }); return }
      if (lk === 'a') { e.preventDefault(); skipScroll.current = true; setSel({ a: { r: 0, c: 0 }, f: { r: tab.rows - 1, c: tab.cols - 1 } }); return }
      if (lk === 'd' || lk === 'r') { e.preventDefault(); fill(lk === 'd' ? 'down' : 'right'); return }
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
      case 'Tab':
        if (wasLeaving || (e.shiftKey ? active.c <= 0 : active.c >= lastCol)) return
        e.preventDefault(); move(0, e.shiftKey ? -1 : 1); return
      case 'Enter': e.preventDefault(); move(e.shiftKey ? -1 : 1, 0); return
      case 'Home': e.preventDefault(); select({ r: active.r, c: 0 }); return
      case 'End': e.preventDefault(); select({ r: active.r, c: tab.cols - 1 }); return
      case 'PageDown': e.preventDefault(); move(10, 0, e.shiftKey); return
      case 'PageUp': e.preventDefault(); move(-10, 0, e.shiftKey); return
      case 'F2': e.preventDefault(); startEdit('inplace'); return
      case 'Escape': e.preventDefault(); select(active); leaving.current = true; return
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
    const e = editRef.current
    if (e && id === tab.id) return
    // Typing a formula and waiting for a reference: stay in the edit and pick
    // cells on the other tab, as in Google Sheets. Enter or Done brings you back.
    if (e && refMode()) {
      window.clearTimeout(blurTimer.current)
      if (e.mode !== 'bar') setEdit({ ...e, mode: 'bar' })
      setTabId(id)
      setWidths({})
      setSel(id === e.home.tabId ? { a: e.home.pos, f: e.home.pos } : origin)
      window.requestAnimationFrame(() => { const el = barRef.current; if (!el || !editRef.current) return; el.focus(); el.setSelectionRange(el.value.length, el.value.length) })
      return
    }
    if (e) commitEdit()
    setTabId(id)
    setSel(origin)
    setWidths({})
  }
  const addTab = () => {
    if (editRef.current) commitEdit()
    let n = sheet.tabs.length + 1
    while (sheet.tabs.some(t => t.name.toLowerCase() === `sheet${n}`)) n++
    const t: SheetTab = { id: newId('tab'), name: `Sheet${n}`, rows: 50, cols: 12, cells: {} }
    commitTabs([...sheetRef.current.tabs, t])
    setTabId(t.id)
    setSel(origin)
  }
  // Renaming rewrites every formula that reads the tab, on every tab, as one undo step.
  const renameTab = (id: string, name: string) => {
    const n = name.trim()
    const cur = sheetRef.current.tabs
    const old = cur.find(t => t.id === id)
    if (!old || !n || old.name === n) return
    if (cur.some(t => t.id !== id && t.name.toLowerCase() === n.toLowerCase())) { toast(`There’s already a tab called “${n}”`); return }
    const { tabs, changed } = renameTabInBook(cur, id, n)
    commitTabs(tabs)
    if (changed) toast(`Renamed to “${n}”. ${changed === 1 ? '1 formula now uses' : `${changed} formulas now use`} the new name.`)
  }
  // Formulas on other tabs that read a deleted tab show #REF! (Undo puts them back).
  const deleteTab = (id: string) => {
    const i = sheet.tabs.findIndex(t => t.id === id)
    const { tabs: rest, changed } = removeTabFromBook(sheetRef.current.tabs, id)
    if (!rest.length) return
    commitTabs(rest)
    if (id === tab.id) switchTab(rest[Math.max(0, i - 1)].id)
    toast(changed ? `Tab deleted. ${changed === 1 ? '1 formula shows' : `${changed} formulas show`} #REF! now. Undo brings it back.` : 'Tab deleted. Undo brings it back.')
    window.requestAnimationFrame(focusGrid)
  }
  /** Goes to cells on any tab (Ask's chips, the address box). */
  const goTo = (tabId: string, g: Range) => {
    const t = sheetRef.current.tabs.find(x => x.id === tabId)
    if (!t) { toast('That tab has been deleted'); return false }
    if (editRef.current) commitEdit(0, 0, false)
    setTabId(t.id)
    if (t.id !== tab.id) setWidths({})
    setSel({ a: clampTo(t, { r: g.r0, c: g.c0 }), f: clampTo(t, { r: g.r1, c: g.c1 }) })
    return true
  }
  // The address box takes B2, B2:D9, or a cell on another tab: Roster!F14, 'OT roster'!F2:F12.
  const goToTyped = (text: string) => {
    const ref = parseRef(text)
    if (!ref) { toast(`“${text}” isn’t a cell address`); return }
    const t = ref.sheet === undefined ? tab : sheet.tabs.find(x => x.name.toLowerCase() === ref.sheet!.toLowerCase())
    if (!t) { toast(`There’s no tab called “${ref.sheet}”`); return }
    if (goTo(t.id, ref.range)) focusGrid()
  }

  // ── Ask ────────────────────────────────────────────────────────────────
  const onRef = (r: CellRef) => {
    if (!goTo(r.tabId, r.range)) return
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
  const suggestion = editable && !activeCell?.v && !edit ? suggestFormula(tab, active, sheet.tabs) : null

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
    // Where the browser won't allow copying, show the CSV to select and copy (as Docs does).
    try {
      navigator.clipboard.writeText(csv).then(() => toast(`Copied “${tab.name}” as CSV (${rows.length} rows)`), () => setCsvOut(csv))
    } catch {
      setCsvOut(csv)
    }
  }
  const [csvOut, setCsvOut] = useState<string | null>(null)
  // Make a copy and New sheet follow the Drive's rule: next to this sheet if you can add files there, else My Drive.
  const copy = useCopy()
  const makeCopy = () => copy({ kind: 'sheet', item: sheet })
  const newSheet = () => {
    const dest = destinationFor(state, sheet.folderId ?? undefined)
    createSheet({ folderId: dest.folderId })
    if (dest.blocked) toast(`You can only view ${dest.blocked}, so the new sheet is in My Drive.`)
  }
  const moveToTrash = () => {
    trashItem(sheet.id)
    toast('Moved to trash. You can restore it from Trash in Drive.')
    navigate(sheet.folderId ? { name: 'drive', folderId: sheet.folderId } : { name: 'drive', view: 'my' })
  }

  // ── Derived labels ─────────────────────────────────────────────────────
  const path = folderPath(state.folders, sheet.folderId)
  // Restoring brings back whichever is in the trash: the sheet, the folders above it, or both.
  const trashedFolders = path.filter(f => f.trashed)
  const inFolder = !sheet.trashed && trashedFolders.length > 0
  const canRestore = (!sheet.trashed || canEdit(sheet)) && trashedFolders.every(f => canEdit(f))
  const restore = () => {
    if (sheet.trashed) restoreItem(sheet.id)
    for (const f of trashedFolders) restoreItem(f.id)
    toast(trashedFolders.length ? `Restored “${trashedFolders[0].title}” from trash` : 'Restored from trash')
  }
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
    if (isError(v)) return { kind: 'error' as const, text: `${v.error} ${explainError(v, activeCell?.v, sheet.tabs.map(t => t.name))}` }
    return null
  })()

  const rangeOn = range.r0 !== range.r1 || range.c0 !== range.c1

  const header = (
    <header className="flex min-h-14 shrink-0 items-center gap-0.5 border-b border-line bg-surface px-2 py-1.5 sm:gap-2 sm:px-3">
      <IconButton label="Back" onClick={store.back}><ArrowLeft size={20} /></IconButton>
      <KindIcon kind="sheet" size="md" className="hidden sm:grid" />
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
        <FileCrumbs
          item={sheet}
          compact={!desktop}
          trailing={
            <span className="flex min-w-0 items-center gap-1" aria-live="polite">
              {trashed ? <Trash2 size={12} className="shrink-0 text-rec" aria-hidden /> : !saving && sheet.updatedBy === ME && <Check size={12} className="shrink-0 text-ok" aria-hidden />}
              <span className={cx('truncate', trashed && 'text-rec')}>{trashed ? 'In trash' : savedLabel}</span>
            </span>
          }
        />
      </div>
      {others.length > 0 && (
        <span className="hidden items-center min-[360px]:flex" title={`${others.map(personShort).join(', ')} ${others.length === 1 ? 'is' : 'are'} here`}>
          <AvatarStack ids={others} size="sm" />
        </span>
      )}
      {wide && <Button size="sm" variant={askOpen ? 'agent' : 'ghost'} icon={<Sparkles size={15} />} onClick={() => setAskOpen(o => !o)} aria-pressed={askOpen}>Ask</Button>}
      <IconButton label={sheet.starred ? 'Remove from Starred' : 'Add to Starred'} aria-pressed={!!sheet.starred} onClick={() => toggleStar(sheet.id)}>
        <Star size={19} className={sheet.starred ? 'fill-current text-warn' : 'text-muted'} />
      </IconButton>
      <ShareButton itemId={sheet.id} onClick={() => setShareOpen(true)} compact={!desktop} />
      {!wide && <IconButton label="Ask about this sheet" onClick={() => setAskOpen(true)} className="text-agent"><Sparkles size={19} /></IconButton>}
      <button ref={moreRef} aria-label="More" title="More" aria-expanded={moreOpen} onClick={() => setMoreOpen(o => !o)} className={cx('grid size-10 shrink-0 place-items-center rounded-full transition hover:bg-surface-2', moreOpen && 'bg-surface-2 text-accent-ink')}><Ellipsis size={20} /></button>
    </header>
  )

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col bg-bg">
      {header}
      <Popover label="More" anchor={moreRef.current} open={moreOpen} onClose={() => setMoreOpen(false)} align="right">
        <MenuItem icon={<FilePlus2 size={16} />} onClick={() => { setMoreOpen(false); newSheet() }}>New sheet</MenuItem>
        <MenuItem icon={<Copy size={16} />} onClick={() => { setMoreOpen(false); makeCopy() }}>Make a copy</MenuItem>
        <MenuItem icon={<ClipboardCopy size={16} />} onClick={() => { setMoreOpen(false); copyCsv() }} hint={tab.name}>Copy as CSV</MenuItem>
        <div className="my-1 h-px bg-line" />
        <MenuItem icon={<Trash2 size={16} />} danger disabled={!editable} onClick={() => { setMoreOpen(false); moveToTrash() }}>Move to trash</MenuItem>
        {!editable && !trashed && <p className="px-3 pb-1 text-[11px] text-muted">Only editors can move it to trash.</p>}
      </Popover>
      <ShareDialog itemId={sheet.id} open={shareOpen} onClose={() => setShareOpen(false)} />
      <Dialog open={csvOut !== null} onClose={() => setCsvOut(null)} title="Copy as CSV">
        <p className="mb-2 text-sm text-muted">Copying isn’t allowed here. Select the text below and copy it.</p>
        <label htmlFor="csv-out" className="sr-only">CSV</label>
        <textarea id="csv-out" readOnly value={csvOut ?? ''} rows={12} onFocus={e => e.currentTarget.select()} className="w-full resize-none rounded-xl bg-surface-2 p-3 font-mono text-xs outline-none focus:ring-2 focus:ring-accent" />
      </Dialog>

      {trashed ? (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line bg-rec-soft px-4 py-2 text-sm">
          <Trash2 size={16} className="shrink-0 text-rec" aria-hidden />
          <span className="min-w-0 flex-1 basis-56">
            {inFolder ? `This sheet is in “${trashedFolders[0].title}”, which is in the trash, so it can’t be edited.` : 'This sheet is in the trash, so it can’t be edited.'}
            {!canRestore && ` Only ${inFolder ? personName(trashedFolders[0].ownerId) : editorNames} can restore it.`}
          </span>
          {canRestore && <Button size="sm" variant="secondary" icon={<Undo2 size={14} />} onClick={restore}>{inFolder ? 'Restore folder' : 'Restore'}</Button>}
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
          onFill={fill}
          locked={away}
        />
      )}

      {/* Formula bar */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-surface px-2 md:px-3">
        <label htmlFor="sheet-goto" className="sr-only">Cell address (type one to jump)</label>
        <AddressBox id="sheet-goto" label={rangeOn ? rangeLabel(range) : activeAddr} onGo={goToTyped} />
        <span className="font-serif text-sm text-muted italic" aria-hidden>fx</span>
        <label htmlFor="sheet-formula" className="sr-only">Contents of {away && homeTab ? `${homeTab.name}!${addrOf(edit.home.pos)}` : activeAddr}</label>
        <input
          id="sheet-formula"
          ref={barRef}
          readOnly={!editable}
          value={edit ? edit.value : activeCell?.v ?? ''}
          placeholder={editable ? 'Type a value or a formula, like =SUM(B2:B9)' : ''}
          onFocus={() => { if (editable && !editRef.current) startEdit('bar') }}
          onChange={e => changeEdit(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commitEdit(e.shiftKey ? -1 : 1, 0) }
            else if (e.key === 'Tab') commitEdit(0, 0, false) // commit, then Tab moves on as usual
            else if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
          }}
          onBlur={() => { if (editRef.current?.mode === 'bar') onEditorBlur() }}
          spellCheck={false}
          autoComplete="off"
          className={cx('h-8 min-w-0 flex-1 rounded-md bg-transparent px-1.5 font-mono text-base md:text-[13px] outline-none placeholder:font-sans placeholder:text-muted focus:bg-surface-2', away && 'bg-surface-2 ring-2 ring-accent')}
        />
      </div>

      {/* Picking cells on another tab for a formula: where it's going, and how to finish. */}
      {away && edit && homeTab && (
        <div role="status" onMouseDown={e => e.preventDefault()} className="flex shrink-0 items-center gap-2 border-b border-line bg-accent-soft py-1 pr-2 pl-3 text-[13px] md:pr-3">
          <MousePointerClick size={16} className="shrink-0 text-accent-ink" aria-hidden />
          {/* The cell being edited stays readable on narrow phones; the words before it give way first. */}
          <p className="flex min-w-0 flex-1 items-baseline gap-1">
            <span className="min-w-0 truncate">
              <span className="hidden sm:inline">{desktop ? 'Click or drag cells on' : 'Tap cells on'} “{tab.name}” to add them to</span>
              <span className="hidden min-[360px]:inline sm:hidden">Adding cells to</span>
              <span className="min-[360px]:hidden">For</span>
            </span>
            <b className="max-w-[70%] shrink-0 truncate font-mono font-semibold text-accent-ink">{homeTab.name}!{addrOf(edit.home.pos)}</b>
          </p>
          <Button size="sm" variant="ghost" className="h-10" onClick={cancelEdit}>Cancel</Button>
          <Button size="sm" variant="primary" className="h-10" icon={<Check size={15} />} onClick={() => commitEdit()}>Done</Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          <Grid
            tab={tab}
            values={values}
            range={range}
            active={active}
            edit={away ? null : edit}
            readOnly={!editable}
            rowH={rowH}
            headH={headH}
            widths={widths}
            cursors={tab.id === cursorTab.current ? cursors : noCursors}
            highlight={highlight}
            gridRef={gridRef}
            inputRef={inputRef}
            onGridKeyDown={onGridKeyDown}
            onCellPointerDown={onCellPointerDown}
            onCellPointerEnter={onCellPointerEnter}
            onCellTap={onCellTap}
            onCellDoubleClick={() => { if (editable && !editRef.current) startEdit('inplace') }}
            onHeaderSelect={onHeaderSelect}
            onEditChange={changeEdit}
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
        ) : away ? (
          <span className="truncate">{desktop ? 'Enter finishes the formula, Escape cancels it' : 'Tap Done to finish the formula'}</span>
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

      <TabsBar sheet={sheet} activeId={tab.id} editable={editable} editing={!!edit} picking={away} onSwitch={switchTab} onAdd={addTab} onRename={renameTab} onDelete={deleteTab} />
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
        if (e.key === 'Enter') { e.preventDefault(); const a = (v ?? '').trim(); setV(null); if (a) onGo(a) }
        if (e.key === 'Escape') { setV(null); e.currentTarget.blur() }
      }}
      spellCheck={false}
      autoComplete="off"
      className="h-7 w-[4.5rem] shrink-0 rounded-md border border-line bg-surface-2 text-center font-mono text-xs font-semibold outline-none focus:border-accent md:w-24"
    />
  )
}

// ── Tabs bar ──────────────────────────────────────────────────────────────
function TabsBar({ sheet, activeId, editable, editing, picking, onSwitch, onAdd, onRename, onDelete }: {
  sheet: Sheet
  activeId: string
  editable: boolean
  /** A cell is being edited: tabs keep the editor's focus, so a formula can take references from another tab. */
  editing: boolean
  /** Picking cells on another tab for a formula: renaming and tab options wait until it's done. */
  picking: boolean
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
    if (!editable || picking) return
    setDraft(sheet.tabs.find(t => t.id === id)?.name ?? '')
    setRenaming(id)
  }
  const confirmTab = sheet.tabs.find(t => t.id === confirm)
  const uses = confirmTab ? formulasUsing(sheet.tabs, confirmTab.id) : 0
  const filled = confirmTab ? Object.values(confirmTab.cells).filter(c => c.v).length : 0

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-t border-line bg-surface-2 px-2">
      {editable && <IconButton label="Add a tab" className="size-9" disabled={picking} onClick={onAdd}><Plus size={17} /></IconButton>}
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
              <button
                role="tab"
                aria-selected={on}
                onMouseDown={e => { if (editing) e.preventDefault() }}
                onClick={() => onSwitch(t.id)}
                onDoubleClick={() => startRename(t.id)}
                className={cx('h-full max-w-40 truncate pl-3', on && editable && !picking ? 'pr-1' : 'pr-3')}
                title={picking ? `Pick cells on ${t.name}` : editable ? 'Double-click to rename' : undefined}
              >
                {t.name}
              </button>
              {on && editable && !picking && (
                <button
                  aria-label={`Options for ${t.name}`}
                  aria-expanded={menuFor === t.id}
                  ref={el => { if (on) menuAnchor.current = el }}
                  onClick={() => setMenuFor(menuFor === t.id ? null : t.id)}
                  className="relative mr-1 grid size-6 place-items-center rounded-md text-muted after:absolute after:-inset-2 after:content-[''] hover:bg-surface-2 hover:text-fg"
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
          {filled ? `${filledLabel(filled)} go${filled === 1 ? 'es' : ''} with it.` : 'It’s empty.'} You can bring it back with Undo while this page is open.
        </p>
        {uses > 0 && (
          <p className="mt-3 flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2 text-sm">
            <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden />
            <span>{uses === 1 ? '1 formula on another tab uses' : `${uses} formulas on other tabs use`} “{confirmTab?.name}”. {uses === 1 ? 'It' : 'They'}’ll show #REF! once it’s gone.</span>
          </p>
        )}
      </Dialog>
    </div>
  )
}

const filledLabel = (n: number) => (n === 1 ? 'Its 1 filled cell' : `Its ${n} filled cells`)
