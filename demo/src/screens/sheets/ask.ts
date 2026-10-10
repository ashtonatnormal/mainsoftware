// "Ask about this sheet" (DOC-12, D16): answers computed from the sheet's own
// cells, never canned. Every answer names the cells it used so the person can
// check them. Pure: no React, no store.
import type { Sheet, SheetTab } from '../../types'
import { addrOf, colName, computeTab, formatValue, isError, rangeLabel, type Pos, type Range, type Value } from './formula'

export interface CellRef { label: string; tabId: string; range: Range }
export interface SheetAnswer { text: string; refs: CellRef[]; ok: boolean }

const cellRange = (r: number, c: number): Range => ({ r0: r, c0: c, r1: r, c1: c })
const ref = (tab: SheetTab, g: Range): CellRef => ({ label: rangeLabel(g), tabId: tab.id, range: g })
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)
const num = (v: Value | undefined) => (typeof v === 'number' ? v : null)

/** A tab's evaluated values plus a few ways to read them. */
export function readTab(tab: SheetTab) {
  const values = computeTab(tab.cells, tab)
  const at = (r: number, c: number) => values.get(addrOf({ r, c })) ?? null
  const show = (r: number, c: number) => formatValue(at(r, c), tab.cells[addrOf({ r, c })]?.fmt)
  return { values, at, show }
}

// ── Table shape: a header row and a block of data rows under it ─────────────
interface Table { headerRow: number; first: number; last: number; cols: { c: number; name: string; numeric: boolean }[] }

export function tableOf(tab: SheetTab): Table | null {
  const { at } = readTab(tab)
  let headerRow = -1
  for (let r = 0; r < Math.min(tab.rows, 10) && headerRow < 0; r++) {
    let texts = 0
    for (let c = 0; c < tab.cols; c++) if (typeof at(r, c) === 'string' && at(r, c) !== '') texts++
    if (texts >= 2) headerRow = r
  }
  if (headerRow < 0) return null
  const first = headerRow + 1
  let last = first - 1
  for (let r = first; r < tab.rows; r++) {
    let any = false
    for (let c = 0; c < tab.cols; c++) if (at(r, c) !== null && at(r, c) !== '') any = true
    if (!any) break
    last = r
  }
  if (last < first) return null
  const cols: Table['cols'] = []
  for (let c = 0; c < tab.cols; c++) {
    const h = at(headerRow, c)
    let n = 0, filled = 0
    for (let r = first; r <= last; r++) { const v = at(r, c); if (v !== null && v !== '') filled++; if (typeof v === 'number') n++ }
    if (filled === 0 && (h === null || h === '')) continue
    cols.push({ c, name: typeof h === 'string' && h ? h : `Column ${colName(c)}`, numeric: n > 0 && n >= filled / 2 })
  }
  return { headerRow, first, last, cols }
}

// ── Suggested questions, chosen per sheet ───────────────────────────────────
const SPECIAL: Record<string, string[]> = {
  sh_forecast: ['Which weeks go over capacity?', 'What is the peak week?', 'How many Meridian pallets in total?'],
  sh_ot: ['What is the total OT pay and is it within budget?', 'Who earns the most OT?', 'How many hours in the cold room?'],
  sh_movers: ['How much do we save with Kranji?', 'Which mover has more insurance cover?'],
}

export function suggestedQuestions(sheet: Sheet, tab: SheetTab): string[] {
  const special = SPECIAL[sheet.id]
  if (special && tab.id === sheet.tabs[0]?.id) return special
  const t = tableOf(tab)
  const numeric = t?.cols.filter(c => c.numeric) ?? []
  if (!t || !numeric.length) return ['Summarise this tab']
  const a = numeric[numeric.length - 1].name.toLowerCase()
  return [`What is the total ${a}?`, `Which row has the highest ${a}?`, 'Summarise this tab']
}

// ── Answering ────────────────────────────────────────────────────────────────
const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'what', 'which', 'who', 'how', 'many', 'much', 'of', 'in', 'on', 'for', 'and', 'to', 'do', 'we', 'it', 'this', 'that', 'with', 'by', 'there', 'tab', 'sheet', 'total', 'sum', 'average', 'highest', 'lowest', 'most', 'least', 'max', 'min', 'row', 'has', 'have', 'all', 'our', 'me', 'tell', 'give', 'mean', 'peak', 'top', 'biggest', 'smallest', 'largest', 'count', 'number'])
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w))
const stem = (w: string) => w.replace(/(ies|es|s)$/, '')
const overlap = (a: string[], b: string[]) => a.filter(x => b.some(y => stem(x) === stem(y) || (x.length > 3 && y.startsWith(x)) || (y.length > 3 && x.startsWith(y)))).length

export function answerQuestion(sheet: Sheet, tab: SheetTab, q: string): SheetAnswer {
  const special = specialAnswer(sheet, tab, q)
  if (special) return special
  return genericAnswer(tab, q)
}

function genericAnswer(tab: SheetTab, q: string): SheetAnswer {
  const t = tableOf(tab)
  const { at, show } = readTab(tab)
  const lq = q.toLowerCase()
  if (!t) {
    const filled = Object.values(tab.cells).filter(c => c.v !== '').length
    return {
      ok: false, refs: [],
      text: filled ? `I couldn't find a table with a header row in “${tab.name}”. Put labels in the first row and numbers under them, then ask again.` : `“${tab.name}” is empty. Add a header row and some numbers, then ask again.`,
    }
  }
  const numeric = t.cols.filter(c => c.numeric)
  const labelCol = t.cols.find(c => !c.numeric)
  const rowName = (r: number) => (labelCol ? show(r, labelCol.c) : `Row ${r + 1}`)
  const dataRange = (c: number): Range => ({ r0: t.first, c0: c, r1: t.last, c1: c })
  const rows = t.last - t.first + 1

  if (/summar|overview|what.*in this/.test(lq) || !numeric.length) {
    const parts = numeric.slice(0, 4).map(col => {
      const ns = rowsOf(t).map(r => num(at(r, col.c))).filter((n): n is number => n !== null)
      return `${col.name} adds up to ${fmtLike(tab, col.c, t.first, ns.reduce((a, b) => a + b, 0))}`
    })
    return {
      ok: true,
      text: `“${tab.name}” has ${rows} row${rows === 1 ? '' : 's'} of data under ${t.cols.length} headings (${list(t.cols.slice(0, 6).map(c => c.name))}).${parts.length ? ` ${parts.join('; ')}.` : ''}`,
      refs: [ref(tab, { r0: t.headerRow, c0: t.cols[0].c, r1: t.last, c1: t.cols[t.cols.length - 1].c })],
    }
  }

  // Which column? Best word overlap with a numeric heading.
  const qw = words(q)
  const scored = numeric.map(col => ({ col, s: overlap(qw, words(col.name)) })).sort((a, b) => b.s - a.s)
  const col = scored[0]?.s ? scored[0].col : numeric.length === 1 ? numeric[0] : null
  // Optional filter: a value from a text column named in the question, e.g. "cold room".
  let filter: { c: number; value: string } | null = null
  for (const tc of t.cols.filter(c => !c.numeric)) {
    for (const r of rowsOf(t)) {
      const v = at(r, tc.c)
      if (typeof v === 'string' && v.length > 2 && lq.includes(v.toLowerCase())) { filter = { c: tc.c, value: v }; break }
    }
    if (filter) break
  }
  const kind = /average|mean/.test(lq) ? 'avg' : /highest|most|max|peak|largest|biggest|top/.test(lq) ? 'max' : /lowest|least|min|smallest/.test(lq) ? 'min' : /how many|count|number of/.test(lq) && !col ? 'count' : /total|sum|how much|how many|add/.test(lq) ? 'sum' : null

  if (kind === 'count') {
    const rs = rowsOf(t).filter(r => !filter || at(r, filter.c) === filter.value)
    return { ok: true, text: `There ${rs.length === 1 ? 'is' : 'are'} ${rs.length} row${rs.length === 1 ? '' : 's'}${filter ? ` where ${t.cols.find(c => c.c === filter!.c)?.name} is “${filter.value}”` : ''} in “${tab.name}”.`, refs: [ref(tab, { r0: t.first, c0: t.cols[0].c, r1: t.last, c1: t.cols[0].c })] }
  }
  if (!col || !kind) {
    return {
      ok: false, refs: [],
      text: `I can work out totals, averages, the highest and the lowest for a column, optionally for one group (like “hours in the cold room”). Columns with numbers here: ${list(numeric.map(c => c.name))}.`,
    }
  }
  const rs = rowsOf(t).filter(r => !filter || at(r, filter.c) === filter.value)
  const pairs = rs.map(r => ({ r, n: num(at(r, col.c)) })).filter((p): p is { r: number; n: number } => p.n !== null)
  if (!pairs.length) return { ok: false, refs: [], text: `There are no numbers in ${col.name}${filter ? ` for “${filter.value}”` : ''}.` }
  const scope = filter ? ` for ${filter.value}` : ''
  const fmt = (n: number) => fmtLike(tab, col.c, pairs[0].r, n)
  if (kind === 'sum' || kind === 'avg') {
    const total = pairs.reduce((a, p) => a + p.n, 0)
    const v = kind === 'sum' ? total : total / pairs.length
    const refs = filter ? pairs.map(p => ref(tab, cellRange(p.r, col.c))) : [ref(tab, dataRange(col.c))]
    return { ok: true, text: `The ${kind === 'sum' ? 'total' : 'average'} for ${col.name}${scope} is ${fmt(v)}, across ${pairs.length} row${pairs.length === 1 ? '' : 's'}.`, refs: refs.slice(0, 8) }
  }
  const best = pairs.reduce((a, p) => ((kind === 'max' ? p.n > a.n : p.n < a.n) ? p : a))
  const ties = pairs.filter(p => p.n === best.n)
  return {
    ok: true,
    text: `${list(ties.map(p => rowName(p.r)))} ${ties.length > 1 ? 'have' : 'has'} the ${kind === 'max' ? 'highest' : 'lowest'} ${col.name}${scope}: ${fmt(best.n)}.`,
    refs: ties.slice(0, 6).map(p => ref(tab, cellRange(p.r, col.c))),
  }
}

const countWord = (n: number) => ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'][n] ?? String(n)
const rowsOf = (t: Table) => Array.from({ length: t.last - t.first + 1 }, (_, i) => t.first + i)
function fmtLike(tab: SheetTab, c: number, r: number, n: number) {
  const fmt = tab.cells[addrOf({ r, c })]?.fmt
  return formatValue(n, fmt && fmt !== 'text' ? fmt : 'number')
}

// ── Sheet-specific answers (still computed from the live cells) ─────────────
function specialAnswer(sheet: Sheet, tab: SheetTab, q: string): SheetAnswer | null {
  if (tab.id !== sheet.tabs[0]?.id) return null
  const lq = q.toLowerCase()
  const { at, show } = readTab(tab)
  const t = tableOf(tab)
  if (!t) return null
  const colNamed = (re: RegExp) => t.cols.find(c => re.test(c.name.toLowerCase()))

  if (sheet.id === 'sh_forecast' && /capacity|over|exceed/.test(lq)) {
    const total = colNamed(/^total/), cap = colNamed(/capacity/), util = colNamed(/utilisation/), week = t.cols[0], starts = colNamed(/start/)
    if (!total || !cap) return null
    const over = rowsOf(t).filter(r => { const a = num(at(r, total.c)), b = num(at(r, cap.c)); return a !== null && b !== null && a > b })
    if (!over.length) return { ok: true, text: `No week goes over capacity. The busiest week is at ${show(t.first, total.c)} pallets.`, refs: [ref(tab, { r0: t.first, c0: total.c, r1: t.last, c1: total.c })] }
    const desc = over.map(r => `${show(r, week.c)}${starts ? ` (from ${show(r, starts.c)})` : ''} at ${show(r, total.c)} pallets${util ? ` (${show(r, util.c)})` : ''}`)
    return {
      ok: true,
      text: `${over.length === 1 ? 'One week goes' : `${countWord(over.length)} weeks go`} over the cold-room capacity of ${show(over[0], cap.c)} pallets: ${list(desc)}. Everything else fits.`,
      refs: over.map(r => ref(tab, { r0: r, c0: t.cols[0].c, r1: r, c1: (util ?? total).c })),
    }
  }
  if (sheet.id === 'sh_forecast' && /peak|busiest/.test(lq)) {
    const total = colNamed(/^total/), util = colNamed(/utilisation/)
    if (!total) return null
    const best = rowsOf(t).reduce((a, r) => ((num(at(r, total.c)) ?? -Infinity) > (num(at(a, total.c)) ?? -Infinity) ? r : a), t.first)
    return { ok: true, text: `${show(best, 0)} (starting ${show(best, 1)}) is the peak, with ${show(best, total.c)} pallets${util ? ` and utilisation at ${show(best, util.c)}` : ''}.`, refs: [ref(tab, { r0: best, c0: 0, r1: best, c1: (util ?? total).c })] }
  }
  if (sheet.id === 'sh_ot' && /budget|total ot|ot pay/.test(lq)) {
    const label = (s: RegExp) => { for (let r = 0; r < tab.rows; r++) { const v = at(r, 0); if (typeof v === 'string' && s.test(v.toLowerCase())) return r } return -1 }
    const payCol = colNamed(/ot pay/), hoursCol = colNamed(/hours/)
    const totalR = label(/^total/), budgetR = label(/^budget/)
    if (!payCol || totalR < 0 || budgetR < 0) return null
    const total = num(at(totalR, payCol.c)), budget = num(at(budgetR, payCol.c))
    if (total === null || budget === null) return { ok: false, refs: [ref(tab, cellRange(totalR, payCol.c))], text: `The total cell shows ${show(totalR, payCol.c)}, so I can't compare it with the budget yet.` }
    const people = rowsOf(t).filter(r => num(at(r, payCol.c)) !== null && r < totalR).length
    const left = budget - total
    const money = (n: number) => formatValue(n, 'currency')
    return {
      ok: true,
      text: `Total OT pay is ${money(total)} for ${people} people${hoursCol ? ` (${show(totalR, hoursCol.c)} hours)` : ''}. ${left >= 0 ? `That's within the ${money(budget)} budget, with ${money(left)} left (${formatValue(total / budget, 'percent')} used).` : `That's ${money(-left)} over the ${money(budget)} budget.`}`,
      refs: [ref(tab, { r0: t.first, c0: payCol.c, r1: t.last, c1: payCol.c }), ref(tab, cellRange(totalR, payCol.c)), ref(tab, cellRange(budgetR, payCol.c))],
    }
  }
  if (sheet.id === 'sh_movers' && /save|saving|cheaper|kranji/.test(lq)) {
    const totalR = rowWhere(tab, at, /^total/), insR = rowWhere(tab, at, /insurance/), daysR = rowWhere(tab, at, /days/)
    if (totalR < 0) return null
    const a = num(at(totalR, 1)), b = num(at(totalR, 2))
    if (a === null || b === null) return null
    const name = (c: number) => show(0, c)
    const cheap = a <= b ? 1 : 2, dear = cheap === 1 ? 2 : 1
    const extra: string[] = []
    if (insR >= 0) {
      const ia = num(at(insR, cheap)), ib = num(at(insR, dear))
      if (ia !== null && ib !== null && ib > ia) extra.push(`has ${ib / ia === 2 ? 'twice the' : 'more'} insurance cover (${show(insR, dear)} against ${show(insR, cheap)})`)
    }
    if (daysR >= 0) {
      const da = num(at(daysR, cheap)), db = num(at(daysR, dear))
      if (da !== null && db !== null && db < da) extra.push(`needs ${da - db === 1 ? 'one day' : `${da - db} days`} fewer on site`)
    }
    const diff = Math.abs(a - b)
    return {
      ok: true,
      text: `${name(cheap)} costs ${show(totalR, cheap)} against ${name(dear)}'s ${show(totalR, dear)}, so you save ${formatValue(diff, 'currency')} (${formatValue(diff / Math.max(a, b), 'percent')}).${extra.length ? ` ${name(dear)} ${extra.join(' and ')}.` : ''}`,
      refs: [ref(tab, { r0: totalR, c0: 1, r1: totalR, c1: 2 }), ...(insR >= 0 ? [ref(tab, { r0: insR, c0: 1, r1: insR, c1: 2 })] : [])],
    }
  }
  if (sheet.id === 'sh_movers' && /insurance|cover/.test(lq)) {
    const insR = rowWhere(tab, at, /insurance/)
    if (insR < 0) return null
    const a = num(at(insR, 1)), b = num(at(insR, 2))
    if (a === null || b === null) return null
    const more = a >= b ? 1 : 2, less = more === 1 ? 2 : 1
    return { ok: true, text: `${show(0, more)} has more cover: ${show(insR, more)} against ${show(insR, less)} for ${show(0, less)}.`, refs: [ref(tab, { r0: insR, c0: 1, r1: insR, c1: 2 })] }
  }
  return null
}

function rowWhere(tab: SheetTab, at: (r: number, c: number) => Value, re: RegExp) {
  for (let r = 0; r < tab.rows; r++) { const v = at(r, 0); if (typeof v === 'string' && re.test(v.toLowerCase())) return r }
  return -1
}

// ── Suggest a formula for an empty cell under a numeric column ──────────────
export interface FormulaSuggestion { formula: string; why: string; preview: string; refs: CellRef[] }

export function numericRunAbove(tab: SheetTab, values: Map<string, Value>, p: Pos): Range | null {
  const aggregate = (r: number) => /^=\s*(SUM|AVERAGE|MIN|MAX|COUNTA?)\(/i.test(tab.cells[addrOf({ r, c: p.c })]?.v ?? '')
  const blank = (r: number) => (values.get(addrOf({ r, c: p.c })) ?? null) === null
  let r = p.r - 1
  // Skip spacer rows and totals people put above, e.g. an average under a total.
  for (let skipped = 0; r >= 0 && skipped < 3 && (blank(r) || aggregate(r)); skipped++) r--
  const end = r
  while (r >= 0 && typeof values.get(addrOf({ r, c: p.c })) === 'number' && !aggregate(r)) r--
  const start = r + 1
  return end - start + 1 >= 2 ? { r0: start, c0: p.c, r1: end, c1: p.c } : null
}

export function suggestFormula(tab: SheetTab, p: Pos): FormulaSuggestion | null {
  const addr = addrOf(p)
  if (tab.cells[addr]?.v) return null
  const { values, at } = readTab(tab)
  const run = numericRunAbove(tab, values, p)
  if (!run) return null
  // The row label decides the function: "Average …" → AVERAGE, "Peak/Max" → MAX, and so on.
  let label = ''
  for (let c = p.c - 1; c >= 0 && !label; c--) { const v = at(p.r, c); if (typeof v === 'string') label = v.toLowerCase() }
  const fn = /average|mean/.test(label) ? 'AVERAGE' : /peak|max|highest/.test(label) ? 'MAX' : /min|lowest/.test(label) ? 'MIN' : /count|how many/.test(label) ? 'COUNT' : 'SUM'
  const formula = `=${fn}(${rangeLabel(run)})`
  const v = computeTab({ ...tab.cells, [addr]: { v: formula } }, tab).get(addr) ?? null
  const fmt = tab.cells[addrOf({ r: run.r1, c: run.c0 })]?.fmt
  const header = at(0, p.c)
  const what = typeof header === 'string' && header ? header : `column ${colName(p.c)}`
  const verb = { SUM: 'Adds up', AVERAGE: 'Averages', MAX: 'Finds the highest of', MIN: 'Finds the lowest of', COUNT: 'Counts' }[fn]
  return {
    formula,
    why: `${verb} the ${run.r1 - run.r0 + 1} numbers in ${what} above${label ? `, because this row is labelled “${label}”` : ''}.`,
    preview: isError(v) ? v.error : formatValue(v, fmt),
    refs: [ref(tab, run)],
  }
}
