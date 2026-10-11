// Inline formatting inside a doc block: bold, italic, underline and
// strikethrough as runs of text. A block keeps its plain `text` (what search,
// previews and the assistant read) and adds `runs` only when some of it is
// formatted. Everything here is pure, so the editor, the viewer, Markdown
// export and version history share one model.
import type { DocBlock, DocRun } from '../../types'

export type Mark = 'b' | 'i' | 'u' | 's'
export const MARKS: Mark[] = ['b', 'i', 'u', 's']
export type Marks = Partial<Record<Mark, boolean>>

export const markLabels: Record<Mark, string> = { b: 'Bold', i: 'Italic', u: 'Underline', s: 'Strikethrough' }

/** Just the marks that are on, as a clean object. */
export function marksOf(r: Marks): Marks {
  const m: Marks = {}
  for (const k of MARKS) if (r[k]) m[k] = true
  return m
}
export const sameMarks = (a: Marks, b: Marks) => MARKS.every(k => !!a[k] === !!b[k])
const run = (text: string, m: Marks): DocRun => ({ text, ...marksOf(m) })

export const runsText = (runs: DocRun[]) => runs.map(r => r.text).join('')
export const hasMarks = (runs: DocRun[]) => runs.some(r => MARKS.some(k => r[k]))

/** Merges neighbours in the same style and drops empty runs. */
export function normalise(runs: DocRun[]): DocRun[] {
  const out: DocRun[] = []
  for (const r of runs) {
    if (!r.text) continue
    const last = out[out.length - 1]
    if (last && sameMarks(last, r)) out[out.length - 1] = { ...last, text: last.text + r.text }
    else out.push(run(r.text, r))
  }
  return out
}

/** A block's runs: its own when they spell its text, otherwise its text as one plain run. */
export function runsOf(b: Pick<DocBlock, 'text' | 'runs'>): DocRun[] {
  if (b.runs && runsText(b.runs) === b.text) return b.runs
  return b.text ? [{ text: b.text }] : []
}

/** The block with these runs. Its text follows them, and plain blocks carry no runs at all. */
export function withRuns<T extends DocBlock>(b: T, runs: DocRun[]): T {
  const n = normalise(runs)
  const rest = { ...b }
  delete rest.runs
  return (hasMarks(n) ? { ...rest, text: runsText(n), runs: n } : { ...rest, text: runsText(n) }) as T
}

/** The formatting of a block as a short key; '' when it has none. Used to spot formatting-only changes. */
export function formatKey(b: Pick<DocBlock, 'text' | 'runs'>): string {
  const runs = runsOf(b)
  if (!hasMarks(runs)) return ''
  return normalise(runs).map(r => `${MARKS.filter(k => r[k]).join('')}${r.text.length}`).join('|')
}

export function sameRuns(a: DocRun[], b: DocRun[]) {
  const x = normalise(a)
  const y = normalise(b)
  return x.length === y.length && x.every((r, i) => r.text === y[i].text && sameMarks(r, y[i]))
}

/** The runs covering [start, end). */
export function sliceRuns(runs: DocRun[], start: number, end = Infinity): DocRun[] {
  const out: DocRun[] = []
  let at = 0
  for (const r of runs) {
    const a = at
    const z = at + r.text.length
    at = z
    const s = Math.max(start, a)
    const e = Math.min(end, z)
    if (s < e) out.push({ ...r, text: r.text.slice(s - a, e - a) })
  }
  return out
}

export const concatRuns = (...parts: DocRun[][]) => normalise(parts.flat())

/** Replaces [start, end) with other runs. */
export const spliceRuns = (runs: DocRun[], start: number, end: number, insert: DocRun[]) =>
  concatRuns(sliceRuns(runs, 0, start), insert, sliceRuns(runs, end))

/** Replaces [start, end) with text in one style. */
export const editRuns = (runs: DocRun[], start: number, end: number, text: string, marks: Marks) =>
  spliceRuns(runs, start, end, text ? [run(text, marks)] : [])

/** The style of the character at i (none past the end). */
export function marksAt(runs: DocRun[], i: number): Marks {
  let at = 0
  for (const r of runs) {
    if (i < at + r.text.length) return marksOf(r)
    at += r.text.length
  }
  return {}
}

/** The style typing takes at a caret: the character before it, or the first one at the start of a block. */
export const caretMarks = (runs: DocRun[], at: number) => (at > 0 ? marksAt(runs, at - 1) : marksAt(runs, 0))

/** Does every character in [start, end) carry the mark? */
export function rangeHas(runs: DocRun[], start: number, end: number, mark: Mark) {
  const part = sliceRuns(runs, start, end)
  return part.length > 0 && part.every(r => !!r[mark])
}

/** The marks every character in [start, end) shares. */
export const rangeMarks = (runs: DocRun[], start: number, end: number): Marks => marksOf(Object.fromEntries(MARKS.map(m => [m, rangeHas(runs, start, end, m)])))

/** Turns a mark on or off for [start, end). */
export function setMark(runs: DocRun[], start: number, end: number, mark: Mark, on: boolean): DocRun[] {
  return concatRuns(sliceRuns(runs, 0, start), sliceRuns(runs, start, end).map(r => ({ ...r, [mark]: on })), sliceRuns(runs, end))
}

/** Gives every run these marks as well as its own (plain pasted text taking the caret's style). */
export const addMarks = (runs: DocRun[], marks: Marks) => normalise(runs.map(r => ({ ...r, ...marksOf(marks) })))

/** Replaces each regex match; the replacement takes the style of the first character it replaces. */
export function replaceInRuns(runs: DocRun[], re: RegExp, replacement: string): DocRun[] {
  const hits = [...runsText(runs).matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))]
  let out = runs
  for (let k = hits.length - 1; k >= 0; k--) {
    const s = hits[k].index ?? 0
    out = editRuns(out, s, s + hits[k][0].length, replacement, marksAt(out, s))
  }
  return normalise(out)
}

/** Drops whitespace at both ends. */
export function trimRuns(runs: DocRun[]): DocRun[] {
  const t = runsText(runs)
  const s = t.length - t.trimStart().length
  return sliceRuns(runs, s, Math.max(s, t.trimEnd().length))
}

/**
 * What changed between two texts, given where the caret is in the new one: the
 * edit ends at the caret where it can, so typing "a" after "a" lands in the right place.
 */
export function textChange(prev: string, next: string, caret: number): { start: number; removed: number; inserted: string } | null {
  if (prev === next) return null
  const c = Math.max(0, Math.min(caret, next.length))
  let suffix = 0
  const maxSuffix = Math.min(prev.length, next.length - c)
  while (suffix < maxSuffix && prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++
  let prefix = 0
  const maxPrefix = Math.min(prev.length - suffix, next.length - suffix)
  while (prefix < maxPrefix && prev[prefix] === next[prefix]) prefix++
  return { start: prefix, removed: prev.length - suffix - prefix, inserted: next.slice(prefix, next.length - suffix) }
}

/**
 * Sets a block's text from something that only knows plain text (the title
 * field): the parts that didn't change keep their style, new text takes the
 * style of what it replaced or follows.
 */
export function setPlainText<T extends DocBlock>(b: T, text: string): T {
  if (b.text === text) return b
  const runs = runsOf(b)
  if (!hasMarks(runs)) return withRuns(b, text ? [{ text }] : [])
  const ch = textChange(b.text, text, text.length)!
  return withRuns(b, editRuns(runs, ch.start, ch.start + ch.removed, ch.inserted, ch.removed ? marksAt(runs, ch.start) : caretMarks(runs, ch.start)))
}

/** Swaps the first occurrence of `find` for `repl`, keeping the formatting around it. */
export function replaceOnce<T extends DocBlock>(b: T, find: string, repl: string): T {
  const i = b.text.indexOf(find)
  if (i === -1) return b
  const runs = runsOf(b)
  return withRuns(b, editRuns(runs, i, i + find.length, repl, marksAt(runs, i)))
}

// ── Markdown-style shortcuts while typing (**bold**, *italic*, _italic_, ~~strike~~) ──
const INLINE: { char: string; re: RegExp; mark: Mark; len: number }[] = [
  { char: '*', re: /(^|[^*\\])\*\*([^*\s](?:[^*\n]*[^*\s])?)\*\*$/, mark: 'b', len: 2 },
  { char: '*', re: /(^|[^*\w\\])\*([^*\s](?:[^*\n]*[^*\s])?)\*$/, mark: 'i', len: 1 },
  { char: '_', re: /(^|[^_\w\\])_([^_\s](?:[^_\n]*[^_\s])?)_$/, mark: 'i', len: 1 },
  { char: '~', re: /(^|[^~\\])~~([^~\s](?:[^~\n]*[^~\s])?)~~$/, mark: 's', len: 2 },
]

export interface InlineShortcut { open: number; start: number; end: number; mark: Mark; len: number }

/**
 * A closing marker just typed at `caret` ("**", "*", "_" or "~~"). Never inside
 * a word: an underscore in snake_case or a star in 2*3*4 stays as it is.
 */
export function inlineShortcut(text: string, caret: number, typed: string): InlineShortcut | null {
  if (/\w/.test(text[caret] ?? '')) return null
  const before = text.slice(0, caret)
  for (const sc of INLINE) {
    if (sc.char !== typed) continue
    const m = sc.re.exec(before)
    if (!m) continue
    const open = m.index + m[1].length
    return { open, start: open + sc.len, end: caret - sc.len, mark: sc.mark, len: sc.len }
  }
  return null
}

/** Applies a shortcut: the markers go and the text between them takes the mark. */
export function applyInlineShortcut(runs: DocRun[], sc: InlineShortcut): { runs: DocRun[]; caret: number } {
  let r = spliceRuns(runs, sc.end, sc.end + sc.len, [])
  r = setMark(r, sc.start, sc.end, sc.mark, true)
  r = spliceRuns(r, sc.open, sc.open + sc.len, [])
  return { runs: r, caret: sc.end - sc.len }
}

// ── Markdown export (DOC-11) ─────────────────────────────────────────────────
// Underline has no Markdown of its own, so it goes out as <u>…</u>, which
// GitHub and most Markdown renderers show as underlined.
const MD: Record<Mark, [string, string]> = { b: ['**', '**'], i: ['*', '*'], s: ['~~', '~~'], u: ['<u>', '</u>'] }
const MD_ORDER: Mark[] = ['u', 's', 'b', 'i']

/** Whitespace at the edge of a styled run moves outside its markers, which Markdown needs. */
function spacesOut(runs: DocRun[]): DocRun[] {
  const out: DocRun[] = []
  runs.forEach((r, i) => {
    const prev = runs[i - 1] ?? {}
    const next = runs[i + 1] ?? {}
    const both = (a: Marks, b: Marks) => marksOf(Object.fromEntries(MARKS.map(m => [m, !!a[m] && !!b[m]])))
    const lead = r.text.length - r.text.trimStart().length
    if (lead === r.text.length) { out.push(run(r.text, both(r, both(prev, next)))); return }
    const tail = r.text.length - r.text.trimEnd().length
    out.push(run(r.text.slice(0, lead), both(r, prev)), run(r.text.slice(lead, r.text.length - tail), r), run(r.text.slice(r.text.length - tail), both(r, next)))
  })
  return normalise(out)
}

/** Runs as Markdown: **bold**, *italic*, ~~strikethrough~~ and <u>underline</u>. */
export function runsToMarkdown(runs: DocRun[]): string {
  let out = ''
  const open: Mark[] = []
  for (const r of spacesOut(runs)) {
    let keep = 0
    while (keep < open.length && r[open[keep]]) keep++
    while (open.length > keep) out += MD[open.pop()!][1]
    for (const m of MD_ORDER) if (r[m] && !open.includes(m)) { out += MD[m][0]; open.push(m) }
    out += r.text
  }
  while (open.length) out += MD[open.pop()!][1]
  return out
}

// ── HTML (copy and paste) ───────────────────────────────────────────────────
export const escapeHTML = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function runsToHTML(runs: DocRun[]): string {
  return normalise(runs).map(r => {
    let h = escapeHTML(r.text).replace(/\n/g, '<br>')
    if (r.s) h = `<s>${h}</s>`
    if (r.u) h = `<u>${h}</u>`
    if (r.i) h = `<em>${h}</em>`
    if (r.b) h = `<strong>${h}</strong>`
    return h
  }).join('')
}
