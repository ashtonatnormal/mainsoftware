// Formula engine for Sheets (DOC-12). Pure: no React, no store. It parses what a
// person typed into a cell, evaluates formulas across every tab of a sheet (a
// "book"), with cycle detection that follows references from tab to tab, and
// formats values for display. It also rewrites formulas when cells are copied,
// or when a tab is renamed or deleted.
import type { SheetCell } from '../../types'

// ── Addresses ────────────────────────────────────────────────────────────────
export interface Pos { r: number; c: number } // zero-based row and column

export function colName(c: number): string {
  let s = ''
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

export function colIndex(name: string): number {
  let n = 0
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

export const addrOf = (p: Pos) => `${colName(p.c)}${p.r + 1}`

export function parseAddr(a: string): Pos | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,6})$/.exec(a.trim())
  if (!m || Number(m[2]) < 1) return null
  return { r: Number(m[2]) - 1, c: colIndex(m[1]) }
}

export interface Range { r0: number; c0: number; r1: number; c1: number } // inclusive, normalised

export const rangeOf = (a: Pos, b: Pos): Range => ({ r0: Math.min(a.r, b.r), c0: Math.min(a.c, b.c), r1: Math.max(a.r, b.r), c1: Math.max(a.c, b.c) })

export function rangeLabel(g: Range): string {
  const a = addrOf({ r: g.r0, c: g.c0 })
  return g.r0 === g.r1 && g.c0 === g.c1 ? a : `${a}:${addrOf({ r: g.r1, c: g.c1 })}`
}

export function parseRange(s: string): Range | null {
  const [a, b] = s.split(':')
  const pa = parseAddr(a)
  const pb = b === undefined ? pa : parseAddr(b)
  return pa && pb ? rangeOf(pa, pb) : null
}

export function* cellsIn(g: Range): Generator<Pos> {
  for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) yield { r, c }
}

// ── Tab names in references ──────────────────────────────────────────────────
const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const LOOKS_LIKE_CELL = /^[A-Za-z]{1,3}\d+$/

/** How a tab's name is written in a formula: bare when it's a simple word (Roster), otherwise in single quotes with any quote doubled ('OT roster', 'Ashton''s'). */
export function quoteTabName(name: string): string {
  return PLAIN_NAME.test(name) && !LOOKS_LIKE_CELL.test(name) && !/^(true|false)$/i.test(name) ? name : `'${name.replace(/'/g, "''")}'`
}

/** A reference as it's typed in a formula: B2 on the same tab, or Roster!F2:F12 and 'OT roster'!B2 on another. */
export const refText = (g: Range, tabName?: string) => (tabName === undefined ? '' : `${quoteTabName(tabName)}!`) + rangeLabel(g)

/** One cell address inside a reference, as written. */
interface CellPart { text: string; r: number; c: number; absR: boolean; absC: boolean }
/** A tab prefix as written ("Roster!", "'OT roster'!"); name is null for "#REF!", a tab that was deleted. */
interface Prefix { text: string; name: string | null }
/** A reference found in formula text: an optional tab prefix, a cell, and the far corner of a range. */
interface RefMatch { start: number; end: number; pre?: Prefix; a: CellPart; preB?: Prefix; b?: CellPart }

const CELL_RE = /(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_(])/y
const BARE_PREFIX_RE = /([\p{L}_][\p{L}\p{N}_.]*)!/uy

function cellAt(src: string, i: number): CellPart | null {
  CELL_RE.lastIndex = i
  const m = CELL_RE.exec(src)
  if (!m) return null
  return { text: m[0], absC: !!m[1], c: colIndex(m[2]), absR: !!m[3], r: Number(m[4]) - 1 }
}

function prefixAt(src: string, i: number): Prefix | null {
  if (src.startsWith('#REF!', i)) return { text: '#REF!', name: null }
  if (src[i] === "'") {
    let j = i + 1, name = ''
    for (;;) {
      if (j >= src.length) return null
      if (src[j] === "'") {
        if (src[j + 1] === "'") { name += "'"; j += 2; continue }
        break
      }
      name += src[j++]
    }
    if (src[j + 1] !== '!' || !name) return null
    return { text: src.slice(i, j + 2), name }
  }
  BARE_PREFIX_RE.lastIndex = i
  const m = BARE_PREFIX_RE.exec(src)
  return m ? { text: m[0], name: m[1] } : null
}

/** A reference starting exactly at src[i], if there is one. */
function matchRefAt(src: string, i: number): RefMatch | null {
  const pre = prefixAt(src, i) ?? undefined
  const j = i + (pre?.text.length ?? 0)
  const a = cellAt(src, j)
  if (!a) return null
  const afterA = j + a.text.length
  if (src[afterA] === ':') {
    const preB = prefixAt(src, afterA + 1) ?? undefined
    const k = afterA + 1 + (preB?.text.length ?? 0)
    const b = cellAt(src, k)
    if (b) return { start: i, end: k + b.text.length, pre, a, preB, b }
  }
  return { start: i, end: afterA, pre, a }
}

const NUMBER_TOKEN_RE = /(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/y
const WORD_RE = /[\p{L}_][\p{L}\p{N}_.]*/uy

/** Calls fn for each reference in a formula (never inside "strings") and splices in what it returns; undefined keeps the reference as written. */
function mapRefs(src: string, fn: (m: RefMatch) => string | undefined): string {
  if (!src.startsWith('=')) return src
  let out = '='
  let i = 1
  while (i < src.length) {
    const ch = src[i]
    if (ch === '"') {
      let j = i + 1
      while (j < src.length) {
        if (src[j] === '"') { if (src[j + 1] === '"') { j += 2; continue } j++; break }
        j++
      }
      out += src.slice(i, j)
      i = j
      continue
    }
    // Numbers, references and words are read whole (as the parser does), so "1E5" or LOG10 never look like cells.
    NUMBER_TOKEN_RE.lastIndex = i
    const num = /[\d.]/.test(ch) ? NUMBER_TOKEN_RE.exec(src) : null
    if (num) { out += num[0]; i += num[0].length; continue }
    const m = matchRefAt(src, i)
    if (m) { out += fn(m) ?? src.slice(m.start, m.end); i = m.end; continue }
    WORD_RE.lastIndex = i
    const w = WORD_RE.exec(src)
    if (w) { out += w[0]; i += w[0].length; continue }
    out += ch
    i++
  }
  return out
}

/** A reference found in a formula. sheet is undefined for the formula's own tab, null for a deleted tab (#REF!), otherwise the tab's name as written. */
export interface FormulaRef { sheet?: string | null; range: Range }

export function formulaRefs(src: string): FormulaRef[] {
  const out: FormulaRef[] = []
  mapRefs(src, m => {
    const sheet = m.pre ? m.pre.name : m.preB ? m.preB.name : undefined
    if (m.a.r >= 0 && (!m.b || m.b.r >= 0)) out.push({ sheet, range: rangeOf(m.a, m.b ?? m.a) })
    return undefined
  })
  return out
}

/** Reads a typed reference such as "B2", "Roster!F2:F12" or "'OT roster'!B2" (the address box uses it). */
export function parseRef(text: string): { sheet?: string; range: Range } | null {
  const t = text.trim()
  const m = matchRefAt(t, 0)
  if (!m || m.end !== t.length || m.pre?.name === null || m.preB?.name === null) return null
  if (m.preB && m.preB.name!.toLowerCase() !== m.pre?.name?.toLowerCase()) return null
  if (m.a.r < 0 || (m.b && m.b.r < 0)) return null
  return { sheet: m.pre?.name ?? undefined, range: rangeOf(m.a, m.b ?? m.a) }
}

// ── Values ───────────────────────────────────────────────────────────────────
export type ErrorCode = '#DIV/0!' | '#REF!' | '#NAME?' | '#VALUE!' | '#CYCLE!' | '#ERROR!'
export interface ErrorValue { error: ErrorCode }
/** null is an empty cell. */
export type Value = number | string | boolean | null | ErrorValue

export const isError = (v: unknown): v is ErrorValue => typeof v === 'object' && v !== null && 'error' in v
const err = (error: ErrorCode): ErrorValue => ({ error })

/** What a typed number looks like: "1200", "1,200.5", "-3", ".5", "S$1,234", "12%". */
const NUMBER_RE = /^(-)?(S?\$)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(%)?$/
const SCI_RE = /^-?(\d+\.?\d*|\.\d+)[eE][+-]?\d+$/

/** Reads a typed literal. Returns the value and a format it implies (S$ → currency, % → percent). */
export function parseLiteral(raw: string): { value: Value; fmt?: SheetCell['fmt'] } {
  const t = raw.trim()
  if (t === '') return { value: null }
  const m = NUMBER_RE.exec(t)
  if (m) {
    let n = Number(m[3].replace(/,/g, ''))
    if (m[1]) n = -n
    if (m[4]) return { value: n / 100, fmt: m[2] ? undefined : 'percent' }
    return { value: n, fmt: m[2] ? 'currency' : m[3].includes(',') ? 'number' : undefined }
  }
  if (SCI_RE.test(t)) return { value: Number(t) }
  const u = t.toUpperCase()
  if (u === 'TRUE') return { value: true }
  if (u === 'FALSE') return { value: false }
  return { value: raw }
}

// ── Tokens ───────────────────────────────────────────────────────────────────
type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ref'; v: string; b?: string; sheet?: string; sheetB?: string; dead?: boolean }
  | { t: 'name'; v: string }
  | { t: 'op'; v: string }
  | { t: '('; } | { t: ')' } | { t: ',' } | { t: ':' }

class ParseError extends Error {}

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch)) { i++; continue }
    if (ch === '"') {
      let s = ''
      i++
      for (;;) {
        if (i >= src.length) throw new ParseError('Unclosed quote')
        if (src[i] === '"') {
          if (src[i + 1] === '"') { s += '"'; i += 2; continue }
          i++
          break
        }
        s += src[i++]
      }
      out.push({ t: 'str', v: s })
      continue
    }
    const num = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i))
    if (num) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue }
    const ref = matchRefAt(src, i)
    if (ref) {
      out.push({
        t: 'ref',
        v: ref.a.text.toUpperCase(),
        b: ref.b?.text.toUpperCase(),
        sheet: ref.pre?.name ?? undefined,
        sheetB: ref.preB?.name ?? undefined,
        dead: ref.pre?.name === null || ref.preB?.name === null,
      })
      i = ref.end
      continue
    }
    if (src[i] === "'") throw new ParseError('A tab name in quotes needs ! and a cell after it')
    const name = /^[\p{L}_][\p{L}\p{N}_.]*/u.exec(src.slice(i))
    if (name) {
      if (src[i + name[0].length] === '!') throw new ParseError('A tab name needs a cell after it')
      out.push({ t: 'name', v: name[0].toUpperCase() }); i += name[0].length; continue
    }
    const two = src.slice(i, i + 2)
    if (two === '<>' || two === '<=' || two === '>=') { out.push({ t: 'op', v: two }); i += 2; continue }
    if (src.startsWith('#REF!', i)) { out.push({ t: 'name', v: '#REF!' }); i += 5; continue }
    if ('+-*/^&=<>%'.includes(ch)) { out.push({ t: 'op', v: ch }); i++; continue }
    if (ch === '(' || ch === ')' || ch === ',' || ch === ':') { out.push({ t: ch } as Tok); i++; continue }
    throw new ParseError(`Unexpected ${ch}`)
  }
  return out
}

// ── Parser (precedence: comparison < & < + - < * / < ^ < unary - < %) ─────
export type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'ref'; a: string; sheet?: string }
  | { k: 'range'; a: string; b: string; sheet?: string }
  | { k: 'fn'; name: string; args: Node[] }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'neg'; e: Node }
  | { k: 'pct'; e: Node }
  | { k: 'name'; v: string }
  | { k: 'refErr' } // a reference moved off the grid, or to a tab that was deleted

export function parseFormula(src: string): Node {
  const toks = tokenize(src)
  let p = 0
  const peek = () => toks[p]
  const isOp = (...ops: string[]) => { const t = toks[p]; return !!t && t.t === 'op' && ops.includes(t.v) }
  const expect = (t: Tok['t']) => { if (toks[p]?.t !== t) throw new ParseError(`Expected ${t}`); p++ }

  const level = (ops: string[], next: () => Node) => (): Node => {
    let l = next()
    while (isOp(...ops)) { const op = (toks[p++] as { v: string }).v; l = { k: 'bin', op, l, r: next() } }
    return l
  }
  const primary = (): Node => {
    const t = peek()
    if (!t) throw new ParseError('Unexpected end')
    p++
    switch (t.t) {
      case 'num': return { k: 'num', v: t.v }
      case 'str': return { k: 'str', v: t.v }
      case 'ref': {
        if (t.dead) return { k: 'refErr' }
        if (t.b !== undefined) {
          // Roster!A1:Roster!B3 is fine; a range can't start on one tab and end on another.
          if (t.sheetB !== undefined && t.sheetB.toLowerCase() !== t.sheet?.toLowerCase()) throw new ParseError('A range must stay on one tab')
          return { k: 'range', a: t.v, b: t.b, sheet: t.sheet }
        }
        if (peek()?.t === ':') {
          p++
          const b = peek()
          if (b?.t !== 'ref' || b.b !== undefined || b.dead || (b.sheet !== undefined && b.sheet.toLowerCase() !== t.sheet?.toLowerCase())) throw new ParseError('Bad range')
          p++
          return { k: 'range', a: t.v, b: b.v, sheet: t.sheet }
        }
        return { k: 'ref', a: t.v, sheet: t.sheet }
      }
      case 'name':
        if (peek()?.t === '(') {
          p++
          const args: Node[] = []
          if (peek()?.t !== ')') {
            for (;;) { args.push(compare()); if (peek()?.t === ',') { p++; continue } break }
          }
          expect(')')
          return { k: 'fn', name: t.v, args }
        }
        if (t.v === 'TRUE' || t.v === 'FALSE') return { k: 'bool', v: t.v === 'TRUE' }
        if (t.v === '#REF!') return { k: 'refErr' }
        return { k: 'name', v: t.v }
      case '(': { const e = compare(); expect(')'); return e }
      default: throw new ParseError('Unexpected token')
    }
  }
  const postfix = (): Node => { let e = primary(); while (isOp('%')) { p++; e = { k: 'pct', e } } return e }
  const unary = (): Node => {
    if (isOp('-')) { p++; return { k: 'neg', e: unary() } }
    if (isOp('+')) { p++; return unary() }
    return postfix()
  }
  const power = level(['^'], unary)
  const mul = level(['*', '/'], power)
  const add = level(['+', '-'], mul)
  const concat = level(['&'], add)
  const compare = level(['=', '<>', '<', '>', '<=', '>='], concat)

  const root = compare()
  if (p < toks.length) throw new ParseError('Unexpected input')
  return root
}

/** Parsed formulas by their text: the same formula typed in many cells (or recalculated) is read once. */
const parseCache = new Map<string, Node | ErrorValue>()
function parsed(body: string): Node | ErrorValue {
  let n = parseCache.get(body)
  if (n === undefined) {
    try { n = parseFormula(body) } catch { n = err('#ERROR!') }
    if (parseCache.size > 5000) parseCache.clear()
    parseCache.set(body, n)
  }
  return n
}

// ── Evaluation ───────────────────────────────────────────────────────────────
export interface Bounds { rows: number; cols: number }
type Cells = Record<string, SheetCell>
/** A range evaluates to a flat list of cell values; scalars are single values. */
type Arg = { range: Value[] } | Value

const isRange = (a: Arg): a is { range: Value[] } => typeof a === 'object' && a !== null && 'range' in a

function toNumber(v: Value): number | ErrorValue {
  if (isError(v)) return v
  if (v === null) return 0
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  const lit = parseLiteral(v)
  return typeof lit.value === 'number' ? lit.value : err('#VALUE!')
}

function toText(v: Value): string {
  if (v === null) return ''
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') return formatAuto(v)
  if (isError(v)) return v.error
  return v
}

function toBool(v: Value): boolean | ErrorValue {
  if (isError(v)) return v
  if (typeof v === 'boolean') return v
  if (v === null) return false
  if (typeof v === 'number') return v !== 0
  const u = v.toUpperCase()
  if (u === 'TRUE') return true
  if (u === 'FALSE') return false
  return err('#VALUE!')
}

/** Excel-style ordering: numbers < text < booleans; text compares without case. */
function compareValues(a: Value, b: Value): number {
  const rank = (v: Value) => (typeof v === 'number' || v === null ? 0 : typeof v === 'string' ? 1 : 2)
  if (a === null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0
  if (b === null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0
  const ra = rank(a), rb = rank(b)
  if (ra !== rb) return ra - rb
  if (typeof a === 'string' && typeof b === 'string') { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0 }
  const x = Number(a), y = Number(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/** Numbers for SUM-like functions: ranges skip text, booleans and blanks; typed arguments are coerced. */
function numbersOf(args: Arg[]): number[] | ErrorValue {
  const out: number[] = []
  for (const a of args) {
    if (isRange(a)) {
      for (const v of a.range) {
        if (isError(v)) return v
        if (typeof v === 'number') out.push(v)
      }
    } else {
      if (a === null) continue
      const n = toNumber(a)
      if (isError(n)) return n
      out.push(n)
    }
  }
  return out
}

function flat(args: Arg[]): Value[] {
  return args.flatMap(a => (isRange(a) ? a.range : [a]))
}

const round = (n: number, d: number) => {
  const f = 10 ** d
  return (Math.sign(n) * Math.round(Math.abs(n) * f + 1e-9)) / f
}

export const FUNCTIONS = ['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'ROUND', 'ABS', 'IF', 'AND', 'OR', 'CONCAT'] as const

function callFn(name: string, args: Arg[]): Value {
  const scalar = (i: number): Value => { const a = args[i]; return a === undefined ? null : isRange(a) ? (a.range.length === 1 ? a.range[0] : err('#VALUE!')) : a }
  switch (name) {
    case 'SUM': { const ns = numbersOf(args); return isError(ns) ? ns : ns.reduce((s, n) => s + n, 0) }
    case 'AVERAGE': {
      const ns = numbersOf(args)
      if (isError(ns)) return ns
      return ns.length ? ns.reduce((s, n) => s + n, 0) / ns.length : err('#DIV/0!')
    }
    case 'MIN': { const ns = numbersOf(args); return isError(ns) ? ns : ns.length ? Math.min(...ns) : 0 }
    case 'MAX': { const ns = numbersOf(args); return isError(ns) ? ns : ns.length ? Math.max(...ns) : 0 }
    case 'COUNT': return flat(args).filter(v => typeof v === 'number').length
    case 'COUNTA': return flat(args).filter(v => v !== null && v !== '').length
    case 'ROUND': {
      if (args.length < 1 || args.length > 2) return err('#VALUE!')
      const n = toNumber(scalar(0)); if (isError(n)) return n
      const d = args.length > 1 ? toNumber(scalar(1)) : 0; if (isError(d)) return d
      return round(n, Math.trunc(d))
    }
    case 'ABS': {
      if (args.length !== 1) return err('#VALUE!')
      const n = toNumber(scalar(0)); return isError(n) ? n : Math.abs(n)
    }
    case 'IF': {
      if (args.length < 2 || args.length > 3) return err('#VALUE!')
      const c = toBool(scalar(0)); if (isError(c)) return c
      return c ? scalar(1) : args.length > 2 ? scalar(2) : false
    }
    case 'AND': case 'OR': {
      const vs = flat(args).filter(v => v !== null && typeof v !== 'string')
      if (!vs.length) return err('#VALUE!')
      let acc = name === 'AND'
      for (const v of vs) {
        const b = toBool(v); if (isError(b)) return b
        acc = name === 'AND' ? acc && b : acc || b
      }
      return acc
    }
    case 'CONCAT': {
      const vs = flat(args)
      const bad = vs.find(isError); if (bad) return bad
      return vs.map(toText).join('')
    }
    default: return err('#NAME?')
  }
}

/** What the engine needs from a tab (SheetTab fits). */
export interface BookTab { id: string; name: string; rows: number; cols: number; cells: Cells }

/** Every tab of a sheet, evaluated together so formulas can read other tabs. */
export interface Book {
  /** Every non-empty cell of a tab, evaluated (keys are A1 addresses). Unknown tabs give an empty map. */
  values(tabId: string): Map<string, Value>
  value(tabId: string, addr: string): Value
}

const isFormulaCell = (c: SheetCell | undefined): boolean => !!c && c.v.startsWith('=') && c.fmt !== 'text'

/** Thrown when formulas nest deeper than MAX_DEPTH cells, so the cell is worked out on its own first (no stack overflow on long chains). */
class TooDeep {
  ti: number
  addr: string
  constructor(ti: number, addr: string) { this.ti = ti; this.addr = addr }
}
const MAX_DEPTH = 400

/**
 * Evaluates lazily: asking for a tab computes its cells, pulling in cells from
 * other tabs only as their formulas need them. Each cell is computed once per
 * book. A cell that is reached again while it is still being worked out (A1 on
 * Summary → Roster!F14 → Summary!A1) is a cycle and shows #CYCLE!, as does
 * anything that depends on it. A tab is found by name, ignoring case; a name
 * that matches no tab gives #REF!. Long chains (A2000 → A1999 → … → A1) are
 * worked out in stages, deepest first, so they never overflow the stack.
 */
export function createBook(tabs: readonly BookTab[]): Book {
  const byName = new Map<string, number>()
  tabs.forEach((t, i) => { const k = t.name.toLowerCase(); if (!byName.has(k)) byName.set(k, i) })
  const byId = new Map(tabs.map((t, i) => [t.id, i]))
  const done = tabs.map(() => new Map<string, Value>())
  const complete = tabs.map(() => false)
  const visiting = new Set<string>()
  let depth = 0

  const tabIndex = (from: number, sheet: string | undefined) => (sheet === undefined ? from : byName.get(sheet.toLowerCase()) ?? -1)

  const valueAt = (ti: number, addr: string): Value => {
    const memo = done[ti]
    const hit = memo.get(addr)
    if (hit !== undefined) return hit
    const key = `${ti}:${addr}`
    if (visiting.has(key)) return err('#CYCLE!')
    const cell = tabs[ti].cells[addr]
    let v: Value
    if (!cell || cell.v === '') v = null
    else if (isFormulaCell(cell)) {
      if (depth >= MAX_DEPTH) throw new TooDeep(ti, addr)
      visiting.add(key)
      depth++
      try {
        const node = parsed(cell.v.slice(1))
        v = isError(node) ? node : evalNode(node, ti)
      } finally {
        visiting.delete(key)
        depth--
      }
      if (v === null) v = 0 // =A9 on an empty cell shows 0, as in other spreadsheets
      // A cell that sits on a cycle reports the cycle, whatever operator wrapped it.
      if (isError(v) && v.error === '#CYCLE!') v = err('#CYCLE!')
    } else if (cell.v.startsWith("'")) v = cell.v.slice(1) // a leading apostrophe keeps text as typed
    else if (cell.fmt === 'text') v = cell.v
    else v = parseLiteral(cell.v).value
    memo.set(addr, v)
    return v
  }

  // Cells past a tab's current size are simply empty (adding rows fills them in).
  const refValue = (ti: number, a: string, sheet: string | undefined): Value => {
    const tj = tabIndex(ti, sheet)
    if (tj < 0) return err('#REF!')
    const p = parseAddr(a)
    if (!p) return err('#REF!')
    const t = tabs[tj]
    return p.r < t.rows && p.c < t.cols ? valueAt(tj, addrOf(p)) : null
  }

  const evalArg = (n: Node, ti: number): Arg => {
    if (n.k === 'range') {
      const tj = tabIndex(ti, n.sheet)
      if (tj < 0) return err('#REF!')
      const a = parseAddr(n.a), b = parseAddr(n.b)
      if (!a || !b) return err('#REF!')
      const g = rangeOf(a, b)
      const t = tabs[tj]
      const out: Value[] = []
      const clipped = { r0: g.r0, c0: g.c0, r1: Math.min(g.r1, t.rows - 1), c1: Math.min(g.c1, t.cols - 1) }
      if (clipped.r0 <= clipped.r1 && clipped.c0 <= clipped.c1) for (const p of cellsIn(clipped)) out.push(valueAt(tj, addrOf(p)))
      return { range: out }
    }
    return evalNode(n, ti)
  }

  const evalNode = (n: Node, ti: number): Value => {
    switch (n.k) {
      case 'num': return n.v
      case 'str': return n.v
      case 'bool': return n.v
      case 'name': return err('#NAME?')
      case 'refErr': return err('#REF!')
      case 'ref': return refValue(ti, n.a, n.sheet)
      case 'range': {
        const a = evalArg(n, ti)
        return isRange(a) ? (a.range.length === 1 ? a.range[0] : err('#VALUE!')) : a
      }
      case 'neg': { const x = toNumber(evalNode(n.e, ti)); return isError(x) ? x : -x }
      case 'pct': { const x = toNumber(evalNode(n.e, ti)); return isError(x) ? x : x / 100 }
      case 'fn': {
        if (!(FUNCTIONS as readonly string[]).includes(n.name)) return err('#NAME?')
        // A reference that points nowhere (a missing or deleted tab) is #REF!, even for COUNTA, which would count an error held in a cell.
        if (n.args.some(x => x.k === 'refErr' || ((x.k === 'ref' || x.k === 'range') && tabIndex(ti, x.sheet) < 0))) return err('#REF!')
        const args = n.args.map(x => evalArg(x, ti))
        // IF only evaluates the branch it takes, but errors in the condition still show.
        const cyc = (v: Value) => isError(v) && v.error === '#CYCLE!'
        if (args.some(a => (isRange(a) ? a.range.some(cyc) : cyc(a)))) return err('#CYCLE!')
        return callFn(n.name, args)
      }
      case 'bin': {
        const l = evalNode(n.l, ti), r = evalNode(n.r, ti)
        if (isError(l)) return l
        if (isError(r)) return r
        if (n.op === '&') return toText(l) + toText(r)
        if (['=', '<>', '<', '>', '<=', '>='].includes(n.op)) {
          const c = compareValues(l, r)
          return n.op === '=' ? c === 0 : n.op === '<>' ? c !== 0 : n.op === '<' ? c < 0 : n.op === '>' ? c > 0 : n.op === '<=' ? c <= 0 : c >= 0
        }
        const x = toNumber(l), y = toNumber(r)
        if (isError(x)) return x
        if (isError(y)) return y
        switch (n.op) {
          case '+': return x + y
          case '-': return x - y
          case '*': return x * y
          case '/': return y === 0 ? err('#DIV/0!') : x / y
          case '^': { if (x === 0 && y < 0) return err('#DIV/0!'); const v = x ** y; return Number.isFinite(v) ? v : err('#VALUE!') }
        }
        return err('#ERROR!')
      }
    }
  }

  // Works a cell out from a fresh stack. A cell too deep to reach is worked out
  // first, then the one that needed it again (its finished cells are kept). If
  // the deep cell is one already waiting here, the chain loops back on itself: a
  // cycle too long to see in one go.
  const force = (ti: number, addr: string): Value => {
    const roots: [number, string][] = [[ti, addr]]
    for (;;) {
      const [t, a] = roots[roots.length - 1]
      try {
        const v = valueAt(t, a)
        roots.pop()
        if (!roots.length) return v
      } catch (e) {
        if (!(e instanceof TooDeep)) throw e
        if (roots.some(([t2, a2]) => t2 === e.ti && a2 === e.addr)) done[e.ti].set(e.addr, err('#CYCLE!'))
        else roots.push([e.ti, e.addr])
      }
    }
  }

  return {
    values(tabId) {
      const ti = byId.get(tabId)
      if (ti === undefined) return new Map()
      if (!complete[ti]) {
        for (const addr of Object.keys(tabs[ti].cells)) force(ti, addr)
        complete[ti] = true
      }
      return done[ti]
    },
    value(tabId, addr) {
      const ti = byId.get(tabId)
      if (ti === undefined) return null
      const p = parseAddr(addr)
      return p ? force(ti, addrOf(p)) : err('#REF!')
    },
  }
}

/** One book per list of tabs: the editor, Ask and the status line all read the same results. */
const books = new WeakMap<readonly BookTab[], Book>()
export function bookOf(tabs: readonly BookTab[]): Book {
  let b = books.get(tabs)
  if (!b) { b = createBook(tabs); books.set(tabs, b) }
  return b
}

/** Evaluates one tab of a sheet, with references to the sheet's other tabs. */
export const computeSheet = (tabs: readonly BookTab[], tabId: string) => bookOf(tabs).values(tabId)

/** Evaluates a single tab on its own (references to other tabs give #REF!). Keys are A1 addresses. */
export function computeTab(cells: Cells, bounds: Bounds): Map<string, Value> {
  return createBook([{ id: '', name: '', cells, rows: bounds.rows, cols: bounds.cols }]).values('')
}

/** Convenience for one-off evaluation (tests, Ask answers). */
export function evaluate(cells: Cells, bounds: Bounds, addr: string): Value {
  return computeTab(cells, bounds).get(addr) ?? null
}

// ── Dependencies between tabs ────────────────────────────────────────────────
const namesCache = new WeakMap<BookTab, Set<string>>()

/** The tab names (lower case) that a tab's formulas mention directly. */
export function tabsReadBy(tab: BookTab): Set<string> {
  let s = namesCache.get(tab)
  if (!s) {
    s = new Set()
    for (const c of Object.values(tab.cells)) if (isFormulaCell(c)) for (const r of formulaRefs(c.v)) if (typeof r.sheet === 'string') s.add(r.sheet.toLowerCase())
    namesCache.set(tab, s)
  }
  return s
}

/**
 * What a tab's values depend on: the tab itself, then every tab its formulas
 * reach (directly or through other tabs). A name that matches no tab is kept as
 * a name, so adding or renaming a tab to it counts as a change.
 */
export function dependencyKey(tabs: readonly BookTab[], tabId: string): unknown[] {
  const self = tabs.find(t => t.id === tabId)
  if (!self) return []
  const key: unknown[] = [self]
  const seen = new Set([self.name.toLowerCase()])
  const queue = [self]
  while (queue.length) {
    for (const n of tabsReadBy(queue.shift()!)) {
      if (seen.has(n)) continue
      seen.add(n)
      const hit = tabs.find(x => x.name.toLowerCase() === n)
      key.push(hit ?? `missing:${n}`)
      if (hit) queue.push(hit)
    }
  }
  return key
}

/** A tab's values and what they were computed from. */
export interface TabValues { tabId: string; key: unknown[]; values: Map<string, Value> }

/** A tab's values, reusing prev when nothing it depends on has changed: editing an unrelated tab doesn't recalculate it; editing one it reads does. */
export function tabValues(tabs: readonly BookTab[], tabId: string, prev?: TabValues | null): TabValues {
  const key = dependencyKey(tabs, tabId)
  if (prev && prev.tabId === tabId && prev.key.length === key.length && prev.key.every((k, i) => k === key[i])) return prev
  return { tabId, key, values: computeSheet(tabs, tabId) }
}

// ── Formatting ───────────────────────────────────────────────────────────────
const group = (n: number, decimals: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })

/** Automatic number display: up to 10 significant digits, no trailing zeros. */
export function formatAuto(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n)
  const s = Number(n.toPrecision(10)).toString()
  return s
}

export function formatValue(v: Value, fmt?: SheetCell['fmt']): string {
  if (v === null) return ''
  if (isError(v)) return v.error
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'string') return v
  if (!Number.isFinite(v)) return '#VALUE!'
  switch (fmt) {
    case 'currency': return `${v < 0 ? '-' : ''}S$${group(Math.abs(v), 2)}`
    case 'percent': return `${(v * 100).toFixed(1)}%`
    case 'integer': return group(round(v, 0), 0)
    case 'number': return n2(v)
    case 'text': return formatAuto(v)
    default: return formatAuto(v)
  }
}
const n2 = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 2 })

/** One line on what an error means (the status line and cell tooltips). */
export function errorHelp(code: string): string {
  switch (code) {
    case '#DIV/0!': return 'Divides by zero or by an empty cell.'
    case '#REF!': return 'Refers to a cell or a tab that isn’t there.'
    case '#NAME?': return 'Uses a function or name this sheet doesn’t know.'
    case '#VALUE!': return 'Does maths on text, or a range where one value is needed.'
    case '#CYCLE!': return 'Refers back to itself, directly or through other cells.'
    case '#ERROR!': return 'The formula can’t be read. Check brackets, quotes and commas.'
    default: return ''
  }
}

/** errorHelp, made specific to the cell's own formula where it can be: a tab that isn't there, or one that was deleted. */
export function explainError(v: ErrorValue, src: string | undefined, tabNames: readonly string[]): string {
  if (v.error === '#REF!' && src?.startsWith('=')) {
    const names = new Set(tabNames.map(n => n.toLowerCase()))
    const refs = formulaRefs(src)
    const missing = refs.find(r => typeof r.sheet === 'string' && !names.has(r.sheet.toLowerCase()))
    if (missing) return `There’s no tab called “${missing.sheet}” in this sheet.`
    if (refs.some(r => r.sheet === null)) return 'Refers to a tab that was deleted.'
  }
  return errorHelp(v.error)
}

// ── Editing helpers ──────────────────────────────────────────────────────────
const partText = (p: CellPart, r: number, c: number) => `${p.absC ? '$' : ''}${colName(c)}${p.absR ? '$' : ''}${r + 1}`

/**
 * Moves relative references in a formula by (dr, dc), as copying, pasting and
 * filling do. $-anchored parts and tab names stay put (Roster!F2 → Roster!F3).
 * A reference pushed off the grid becomes #REF!.
 */
export function shiftFormula(src: string, dr: number, dc: number): string {
  const move = (p: CellPart) => {
    const c = p.absC ? p.c : p.c + dc, r = p.absR ? p.r : p.r + dr
    return c < 0 || r < 0 ? null : partText(p, r, c)
  }
  return mapRefs(src, m => {
    const a = move(m.a), b = m.b ? move(m.b) : undefined
    if (a === null || b === null) return '#REF!'
    return (m.pre?.text ?? '') + a + (b !== undefined ? `:${m.preB?.text ?? ''}${b}` : '')
  })
}

/** Rewrites references to a tab after it's renamed (any case of the old name), quoting the new name when it needs it. */
export function renameTabInFormula(src: string, oldName: string, newName: string): string {
  const lc = oldName.toLowerCase(), q = `${quoteTabName(newName)}!`
  return mapRefs(src, m => {
    const hitA = m.pre?.name?.toLowerCase() === lc, hitB = m.preB?.name?.toLowerCase() === lc
    if (!hitA && !hitB) return undefined
    return (hitA ? q : m.pre?.text ?? '') + m.a.text + (m.b ? `:${hitB ? q : m.preB?.text ?? ''}${m.b.text}` : '')
  })
}

/** Turns references to a deleted tab into #REF! (keeping the cell, so the formula still shows what it pointed at). */
export function dropTabInFormula(src: string, name: string): string {
  const lc = name.toLowerCase()
  return mapRefs(src, m => (m.pre?.name?.toLowerCase() === lc || m.preB?.name?.toLowerCase() === lc ? `#REF!${m.a.text}${m.b ? `:${m.b.text}` : ''}` : undefined))
}

const usesTab = (src: string, lc: string) => formulaRefs(src).some(r => typeof r.sheet === 'string' && r.sheet.toLowerCase() === lc)

/** How many formulas on the other tabs read this tab (what deleting it would break). */
export function formulasUsing(tabs: readonly BookTab[], tabId: string): number {
  const t = tabs.find(x => x.id === tabId)
  if (!t) return 0
  const lc = t.name.toLowerCase()
  let n = 0
  for (const o of tabs) if (o.id !== tabId) for (const c of Object.values(o.cells)) if (isFormulaCell(c) && usesTab(c.v, lc)) n++
  return n
}

/** Applies a formula rewrite to every formula cell of every tab; returns the new tabs and how many formulas changed. Unchanged tabs keep their identity. */
function rewriteFormulas<T extends BookTab>(tabs: readonly T[], fn: (src: string) => string): { tabs: T[]; changed: number } {
  let changed = 0
  const next = tabs.map(t => {
    let cells: Cells | null = null
    for (const [a, c] of Object.entries(t.cells)) {
      if (!isFormulaCell(c)) continue
      const v = fn(c.v)
      if (v !== c.v) { (cells ??= { ...t.cells })[a] = { ...c, v }; changed++ }
    }
    return cells ? { ...t, cells } : t
  })
  return { tabs: next, changed }
}

/** Renames a tab and rewrites every reference to it, on every tab. */
export function renameTabInBook<T extends BookTab>(tabs: readonly T[], tabId: string, name: string): { tabs: T[]; changed: number } {
  const old = tabs.find(t => t.id === tabId)
  if (!old) return { tabs: [...tabs], changed: 0 }
  const r = rewriteFormulas(tabs, src => renameTabInFormula(src, old.name, name))
  return { tabs: r.tabs.map(t => (t.id === tabId ? { ...t, name } : t)), changed: r.changed }
}

/** Removes a tab; formulas on the other tabs that read it now show #REF!. */
export function removeTabFromBook<T extends BookTab>(tabs: readonly T[], tabId: string): { tabs: T[]; changed: number } {
  const old = tabs.find(t => t.id === tabId)
  if (!old) return { tabs: [...tabs], changed: 0 }
  return rewriteFormulas(tabs.filter(t => t.id !== tabId), src => dropTabInFormula(src, old.name))
}

/** Tab-separated text from a grid of strings (clipboard). */
export const toTSV = (rows: string[][]) => rows.map(r => r.map(v => (/[\t\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join('\t')).join('\n')

export function fromTSV(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', i = 0, quoted = false
  const t = text.replace(/\r\n?/g, '\n').replace(/\n$/, '')
  while (i < t.length) {
    const ch = t[i]
    if (quoted) {
      if (ch === '"' && t[i + 1] === '"') { cell += '"'; i += 2; continue }
      if (ch === '"') { quoted = false; i++; continue }
      cell += ch; i++; continue
    }
    if (ch === '"' && cell === '') { quoted = true; i++; continue }
    if (ch === '\t') { row.push(cell); cell = ''; i++; continue }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue }
    cell += ch; i++
  }
  row.push(cell)
  rows.push(row)
  return rows
}

/** CSV for "Copy as CSV". */
export const toCSV = (rows: string[][]) => rows.map(r => r.map(v => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n')
