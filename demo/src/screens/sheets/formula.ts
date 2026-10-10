// Formula engine for Sheets (DOC-12). Pure: no React, no store. It parses what a
// person typed into a cell, evaluates formulas across one tab (with cycle
// detection) and formats values for display.
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

// ── Values ───────────────────────────────────────────────────────────────────
export type ErrorCode = '#DIV/0!' | '#REF!' | '#NAME?' | '#VALUE!' | '#CYCLE!' | '#ERROR!'
export interface ErrorValue { error: ErrorCode }
/** null is an empty cell. */
export type Value = number | string | boolean | null | ErrorValue

export const isError = (v: unknown): v is ErrorValue => typeof v === 'object' && v !== null && 'error' in v
const err = (error: ErrorCode): ErrorValue => ({ error })

/** What a typed number looks like: "1200", "1,200.5", "-3", ".5", "S$1,234", "12%". */
const NUMBER_RE = /^(-)?(S?\$)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(%)?$/

/** Reads a typed literal. Returns the value and a format it implies (S$ → currency, % → percent). */
export function parseLiteral(raw: string): { value: Value; fmt?: SheetCell['fmt'] } {
  const t = raw.trim()
  if (t === '') return { value: null }
  const m = NUMBER_RE.exec(t)
  if (m) {
    let n = Number(m[3].replace(/,/g, ''))
    if (m[1]) n = -n
    if (m[4]) return { value: n / 100, fmt: m[2] ? undefined : 'percent' }
    return { value: n, fmt: m[2] ? 'currency' : undefined }
  }
  const u = t.toUpperCase()
  if (u === 'TRUE') return { value: true }
  if (u === 'FALSE') return { value: false }
  return { value: raw }
}

// ── Tokens ───────────────────────────────────────────────────────────────────
type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ref'; v: string }
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
    const ref = /^\$?[A-Za-z]{1,3}\$?\d+(?![A-Za-z0-9_(])/.exec(src.slice(i))
    if (ref) { out.push({ t: 'ref', v: ref[0].toUpperCase() }); i += ref[0].length; continue }
    const name = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i))
    if (name) { out.push({ t: 'name', v: name[0].toUpperCase() }); i += name[0].length; continue }
    const two = src.slice(i, i + 2)
    if (two === '<>' || two === '<=' || two === '>=') { out.push({ t: 'op', v: two }); i += 2; continue }
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
  | { k: 'ref'; a: string }
  | { k: 'range'; a: string; b: string }
  | { k: 'fn'; name: string; args: Node[] }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'neg'; e: Node }
  | { k: 'pct'; e: Node }
  | { k: 'name'; v: string }

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
      case 'ref':
        if (peek()?.t === ':') {
          p++
          const b = peek()
          if (b?.t !== 'ref') throw new ParseError('Bad range')
          p++
          return { k: 'range', a: t.v, b: b.v }
        }
        return { k: 'ref', a: t.v }
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

/** Evaluates every non-empty cell of a tab. Keys are A1 addresses. */
export function computeTab(cells: Cells, bounds: Bounds): Map<string, Value> {
  const done = new Map<string, Value>()
  const visiting = new Set<string>()
  const parsed = new Map<string, Node | ErrorValue>()

  const inBounds = (p: Pos) => p.r >= 0 && p.c >= 0 && p.r < bounds.rows && p.c < bounds.cols

  const valueAt = (addr: string): Value => {
    const hit = done.get(addr)
    if (hit !== undefined) return hit
    if (visiting.has(addr)) return err('#CYCLE!')
    const cell = cells[addr]
    let v: Value
    if (!cell || cell.v === '') v = null
    else if (cell.v.startsWith('=') && cell.fmt !== 'text') {
      visiting.add(addr)
      let node = parsed.get(addr)
      if (!node) {
        try { node = parseFormula(cell.v.slice(1)) } catch { node = err('#ERROR!') }
        parsed.set(addr, node)
      }
      v = isError(node) ? node : evalNode(node)
      visiting.delete(addr)
      // A cell that sits on a cycle reports the cycle, whatever operator wrapped it.
      if (isError(v) && v.error === '#CYCLE!') v = err('#CYCLE!')
    } else if (cell.fmt === 'text') v = cell.v
    else v = parseLiteral(cell.v).value
    done.set(addr, v)
    return v
  }

  const refValue = (a: string): Value => {
    const p = parseAddr(a)
    if (!p || !inBounds(p)) return err('#REF!')
    return valueAt(addrOf(p))
  }

  const evalArg = (n: Node): Arg => {
    if (n.k === 'range') {
      const a = parseAddr(n.a), b = parseAddr(n.b)
      if (!a || !b || !inBounds(a) || !inBounds(b)) return err('#REF!')
      const out: Value[] = []
      for (const p of cellsIn(rangeOf(a, b))) out.push(valueAt(addrOf(p)))
      return { range: out }
    }
    return evalNode(n)
  }

  const evalNode = (n: Node): Value => {
    switch (n.k) {
      case 'num': return n.v
      case 'str': return n.v
      case 'bool': return n.v
      case 'name': return err('#NAME?')
      case 'ref': return refValue(n.a)
      case 'range': {
        const a = evalArg(n)
        return isRange(a) ? (a.range.length === 1 ? a.range[0] : err('#VALUE!')) : a
      }
      case 'neg': { const x = toNumber(evalNode(n.e)); return isError(x) ? x : -x }
      case 'pct': { const x = toNumber(evalNode(n.e)); return isError(x) ? x : x / 100 }
      case 'fn': {
        if (!(FUNCTIONS as readonly string[]).includes(n.name)) return err('#NAME?')
        const args = n.args.map(evalArg)
        // IF only evaluates the branch it takes, but errors in the condition still show.
        const bad = args.find(a => !isRange(a) && isError(a) && a.error === '#CYCLE!')
        if (bad) return bad as ErrorValue
        return callFn(n.name, args)
      }
      case 'bin': {
        const l = evalNode(n.l), r = evalNode(n.r)
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
          case '^': { const v = x ** y; return Number.isFinite(v) ? v : err('#VALUE!') }
        }
        return err('#ERROR!')
      }
    }
  }

  for (const addr of Object.keys(cells)) valueAt(addr)
  return done
}

/** Convenience for one-off evaluation (tests, Ask answers). */
export function evaluate(cells: Cells, bounds: Bounds, addr: string): Value {
  return computeTab(cells, bounds).get(addr) ?? null
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
    case 'integer': return group(Math.round(v), 0)
    case 'number': return n2(v)
    case 'text': return formatAuto(v)
    default: return formatAuto(v)
  }
}
const n2 = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 2 })

// ── Editing helpers ──────────────────────────────────────────────────────────
/** Moves relative references in a formula by (dr, dc); $-anchored parts stay put. Off-grid refs become #REF!. */
export function shiftFormula(src: string, dr: number, dc: number): string {
  if (!src.startsWith('=')) return src
  let out = ''
  const body = src.slice(1)
  let i = 0
  while (i < body.length) {
    if (body[i] === '"') {
      const end = body.indexOf('"', i + 1)
      const j = end === -1 ? body.length : end + 1
      out += body.slice(i, j); i = j; continue
    }
    const m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_(])/.exec(body.slice(i))
    const prev = i > 0 ? body[i - 1] : ''
    if (m && !/[A-Za-z0-9_.]/.test(prev)) {
      const c = m[1] ? colIndex(m[2]) : colIndex(m[2]) + dc
      const r = m[3] ? Number(m[4]) - 1 : Number(m[4]) - 1 + dr
      out += c < 0 || r < 0 ? '#REF!' : `${m[1]}${colName(c)}${m[3]}${r + 1}`
      i += m[0].length
      continue
    }
    out += body[i++]
  }
  return '=' + out
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
