// Pure helpers for the doc editor: block keys, the line diff used by version
// history (DOC-04), Markdown export (DOC-11), the extractive summary and the
// meeting draft (DOC-09), restoring older versions, and pasted-text parsing.
// Inline formatting (bold, italic…) lives in ./runs; these keep it intact.
import type { Doc, DocBlock, DocTemplateId, DocVersion, PersonId, Session } from '../../types'
import { ME, personById } from '../../data/people'
import { clock, minutesLabel, shortDay } from '../../time'
import { formatKey, replaceInRuns, replaceOnce, runsOf, runsToMarkdown, trimRuns, withRuns } from './runs'

export type BlockType = DocBlock['type']
/** A block plus a stable key, so React keeps each editable line (and its caret) in place. */
export interface Item { key: string; block: DocBlock }

export const UNTITLED = 'Untitled document'

let keySeq = 0
export const newKey = () => `b${++keySeq}`
export const toItems = (blocks: DocBlock[]): Item[] => blocks.map(block => ({ key: newKey(), block }))
export const toBlocks = (items: Item[]): DocBlock[] => items.map(i => i.block)

export const typeLabels: Record<BlockType, string> = {
  p: 'Text', h1: 'Heading 1', h2: 'Heading 2', li: 'Bulleted list', todo: 'Checklist', quote: 'Quote',
}
/** The Markdown shortcut that makes each type, shown as a hint in the "/" menu. */
export const typeHints: Record<BlockType, string> = { p: '', h1: '#', h2: '##', li: '-', todo: '[]', quote: '>' }
export const blockOrder: BlockType[] = ['p', 'h1', 'h2', 'li', 'todo', 'quote']

/** Changes a block's type, keeping its text and formatting (headings stay on one line). */
export function withType(b: DocBlock, type: BlockType): DocBlock {
  const runs = type === 'h1' || type === 'h2' ? replaceInRuns(runsOf(b), /\s*\n+\s*/g, ' ') : runsOf(b)
  return withRuns(type === 'todo' ? { type, text: '', done: b.type === 'todo' ? !!b.done : false } : { type, text: '' }, runs)
}

/** The block that follows when you press Enter in a block of this type. */
export const nextType = (t: BlockType): BlockType => (t === 'li' || t === 'todo' ? t : 'p')

const SHORTCUTS: [RegExp, BlockType][] = [[/^## /, 'h2'], [/^# /, 'h1'], [/^[-*•] /, 'li'], [/^\[ ?\] /, 'todo'], [/^> /, 'quote']]

/** A Markdown shortcut just typed at the start of a block ("# ", "## ", "- ", "[] ", "> "). */
export function shortcutFor(prev: string, next: string): { type: BlockType; strip: number } | null {
  for (const [re, type] of SHORTCUTS) {
    const m = re.exec(next)
    if (m && !re.test(prev)) return { type, strip: m[0].length }
  }
  return null
}

/** Turns pasted lines into blocks, reading the same Markdown shortcuts. */
export function parseLines(text: string): DocBlock[] {
  return text.replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd()).filter(Boolean).map(line => {
    const todo = /^(?:[-*]\s+)?\[([ xX]?)\]\s+(.*)$/.exec(line)
    if (todo) return { type: 'todo', text: todo[2], done: todo[1].toLowerCase() === 'x' }
    for (const [re, type] of SHORTCUTS) {
      const m = re.exec(line)
      if (m) return { type, text: line.slice(m[0].length) }
    }
    return { type: 'p', text: line }
  })
}

export const isBlank = (blocks: DocBlock[]) => blocks.every((b, i) => (i === 0 && b.type === 'h1') || !b.text.trim())
export const hasText = (blocks: DocBlock[]) => blocks.some(b => b.type !== 'h1' && b.text.trim())
export const sameBlocks = (a: DocBlock[], b: DocBlock[]) =>
  a.length === b.length && a.every((x, i) => x.type === b[i].type && x.text === b[i].text && !!x.done === !!b[i].done && formatKey(x) === formatKey(b[i]))

/** A doc whose first block is a heading matching its title keeps the two in step. */
export function titleLinked(doc: Pick<Doc, 'title' | 'blocks'>) {
  const h = doc.blocks[0]
  if (!h || h.type !== 'h1') return false
  return h.text.trim() === doc.title.trim() || (doc.title === UNTITLED && (h.text === '' || h.text === UNTITLED))
}

/** Where the caret goes in a new doc: the first empty line, or a "Label: " line waiting for text. */
export const openLine = (items: Item[]): Item | undefined => items.find(it => !it.block.text.trim() || /: $/.test(it.block.text))

/** A brand-new blank doc shows an empty heading with an "Untitled document" placeholder. */
export function openingBlocks(doc: Doc): DocBlock[] {
  const [h, ...rest] = doc.blocks
  if (doc.title === UNTITLED && h?.type === 'h1' && h.text === UNTITLED) return [withRuns(h, []), ...rest]
  return doc.blocks.length ? doc.blocks : [{ type: 'h1', text: '' }, { type: 'p', text: '' }]
}

// ── Version diffs (DOC-04) ──────────────────────────────────────────────────
export const lineOf = (b: DocBlock) => (b.type === 'todo' ? `${b.done ? '☑' : '☐'} ${b.text.trim()}` : b.text.trim())
export const linesOf = (blocks: DocBlock[]) => blocks.filter(b => b.text.trim()).map(lineOf)

/**
 * Lines whose text stayed but whose formatting changed. Version history
 * compares plain text, so these are listed separately ("formatting changed").
 */
export function formatChanges(before: DocBlock[], after: DocBlock[], added: string[]): string[] {
  const fresh = new Set(added)
  const was = new Map<string, Set<string>>()
  for (const b of before) {
    if (!b.text.trim()) continue
    const l = lineOf(b)
    if (!was.has(l)) was.set(l, new Set())
    was.get(l)!.add(formatKey(b))
  }
  const out: string[] = []
  for (const b of after) {
    if (!b.text.trim()) continue
    const l = lineOf(b)
    const keys = was.get(l)
    if (!fresh.has(l) && keys && !keys.has(formatKey(b)) && !out.includes(l)) out.push(l)
  }
  return out
}

/** Lines added and removed between two versions (longest common subsequence). */
export function diffLines(a: string[], b: string[]): { added: string[]; removed: string[] } {
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const added: string[] = []
  const removed: string[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) removed.push(a[i++])
    else added.push(b[j++])
  }
  while (i < n) removed.push(a[i++])
  while (j < m) added.push(b[j++])
  return { added, removed }
}

const parseLine = (line: string): { text: string; done?: boolean } => {
  const m = /^([☐☑]) (.*)$/s.exec(line)
  return m ? { text: m[2], done: m[1] === '☑' } : { text: line }
}

/**
 * What the doc looked like before version v, worked out from v's added and
 * removed lines: each added line is swapped back for a removed one where it
 * stood, or taken out (a sentence inside a longer paragraph is cut from it).
 */
export function undoVersion(blocks: DocBlock[], v: DocVersion): DocBlock[] {
  const out = blocks.map(b => ({ ...b }))
  const removed = [...(v.removed ?? [])]
  for (const line of v.added ?? []) {
    const { text } = parseLine(line)
    let i = out.findIndex(b => lineOf(b) === line || b.text.trim() === text)
    const partial = i === -1
    if (partial) i = out.findIndex(b => text.length > 8 && b.text.includes(text))
    if (i === -1) continue
    const back = removed.shift()
    if (back !== undefined) {
      const r = parseLine(back)
      // A whole line swapped back loses its formatting; a sentence put back inside a line keeps the rest's.
      out[i] = r.done !== undefined ? { type: 'todo', text: r.text, done: r.done } : partial ? replaceOnce(out[i], text, r.text) : withRuns(out[i], [{ text: r.text }])
      if (out[i].type !== 'todo') delete out[i].done
    } else if (partial) {
      const cut = replaceOnce(out[i], text, '')
      out[i] = withRuns(cut, trimRuns(replaceInRuns(runsOf(cut), /\s{2,}/g, ' ')))
      if (!out[i].text) out.splice(i, 1)
    } else out.splice(i, 1)
  }
  for (const back of removed) {
    const r = parseLine(back)
    out.push(r.done !== undefined ? { type: 'todo', text: r.text, done: r.done } : { type: 'p', text: r.text })
  }
  return out
}

// ── Markdown (DOC-11) ───────────────────────────────────────────────────────
/** The doc as Markdown, with **bold**, *italic*, ~~strikethrough~~ and <u>underline</u> (Markdown has no underline of its own). */
export function toMarkdown(title: string, blocks: DocBlock[]): string {
  const list = (t?: BlockType) => t === 'li' || t === 'todo'
  const parts: string[] = []
  let prev: BlockType | undefined
  if (blocks[0]?.type !== 'h1' || !blocks[0].text.trim()) { parts.push(`# ${title}`); prev = 'h1' }
  for (const b of blocks) {
    if (!b.text.trim()) continue
    const text = runsToMarkdown(trimRuns(runsOf(b)))
    const md =
      b.type === 'h1' ? `# ${text}`
      : b.type === 'h2' ? `## ${text}`
      : b.type === 'li' ? `- ${text}`
      : b.type === 'todo' ? `- [${b.done ? 'x' : ' '}] ${text}`
      : b.type === 'quote' ? text.split('\n').map(l => `> ${l}`).join('\n')
      : text
    if (parts.length) parts.push(list(prev) && list(b.type) ? '\n' : '\n\n')
    parts.push(md)
    prev = b.type
  }
  return `${parts.join('')}\n`
}

// ── Names and permissions (DOC-03) ──────────────────────────────────────────
export const shortName = (id: PersonId) => (id === ME ? 'you' : personById[id]?.short ?? 'someone')
export const fullName = (id: PersonId) => (id === ME ? 'You' : personById[id]?.name ?? 'Someone')
/** For "by …" phrases: "by you", "by Priya Nair". */
export const byName = (id: PersonId) => (id === ME ? 'you' : personById[id]?.name ?? 'someone')
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** "Priya", "Priya and you", "Marcus, Priya and Farah" */
export function nameList(ids: PersonId[]) {
  const ordered = ids.includes(ME) ? [...ids.filter(id => id !== ME), ME] : ids
  const n = ordered.map(shortName)
  return n.length <= 1 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`
}

export function editorIds(doc: Doc): PersonId[] {
  return [...new Set([doc.ownerId, ...doc.editors, ...(doc.sharedWith ?? []).filter(s => s.role === 'editor').map(s => s.personId)])]
}

export function canComment(doc: Doc, editable: boolean) {
  return editable || doc.commenters !== 'none' || !!doc.sharedWith?.some(s => s.personId === ME && s.role === 'commenter')
}

/** DOC-03: "Only Priya and you can edit · team can comment" */
export function permissionLine(doc: Doc) {
  const named = (doc.sharedWith ?? []).filter(s => s.role === 'commenter').map(s => s.personId)
  const comment = doc.commenters === 'team' ? ' · team can comment' : doc.commenters === 'org' ? ' · everyone can comment' : named.length ? ` · ${nameList(named)} can comment` : ''
  return `Only ${nameList(editorIds(doc))} can edit${comment}`
}

// ── AI writing help (DOC-09) ────────────────────────────────────────────────
const firstSentence = (t: string) => {
  const s = t.trim().replace(/\s*\n+\s*/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z0-9“"‘(])/)[0]
  return /[.!?:]$/.test(s) ? s : `${s}.`
}

export const SUMMARY_PREFIX = 'Summary: '

/** Extractive summary: the first sentence of each section, nothing invented. */
export function summarise(blocks: DocBlock[]): string | null {
  const parts: string[] = []
  let heading: string | null = null
  let taken = false
  for (const b of blocks) {
    if (b.type === 'h1') continue
    if (b.type === 'h2') { heading = b.text.trim() || null; taken = false; continue }
    if (taken || !b.text.trim() || b.text.startsWith(SUMMARY_PREFIX)) continue
    const s = firstSentence(b.text)
    parts.push(heading ? `${heading} — ${s}` : s)
    taken = true
  }
  return parts.length ? `${SUMMARY_PREFIX}${parts.join(' ')}` : null
}

const listNames = (ids: PersonId[]) => {
  const n = ids.map(id => personById[id]?.name ?? 'Someone')
  return n.length <= 1 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`
}
const dueLabel = (due: string) => (/^today/i.test(due) ? due.charAt(0).toLowerCase() + due.slice(1) : due)

/** Blocks built from a meeting's AI notes: summary, decisions, action items with owners, open questions. */
export function meetingDraft(s: Session): DocBlock[] {
  const n = s.notes
  if (!n) return []
  const out: DocBlock[] = [
    { type: 'p', text: `${shortDay(s.startedAt)}, ${clock(s.startedAt)} · ${minutesLabel(s.durationSec)} · ${listNames(s.participants)}` },
    { type: 'p', text: n.summary },
  ]
  if (n.decisions.length) out.push({ type: 'h2', text: 'Decisions' }, ...n.decisions.map(d => ({ type: 'li' as const, text: d })))
  if (n.actionItems.length) {
    out.push({ type: 'h2', text: 'Action items' }, ...n.actionItems.map(a => ({
      type: 'todo' as const, done: false,
      text: `${a.text} — ${personById[a.ownerId]?.name ?? 'Someone'}${a.due ? `, due ${dueLabel(a.due)}` : ''}`,
    })))
  }
  if (n.openQuestions.length) out.push({ type: 'h2', text: 'Open questions' }, ...n.openQuestions.map(q => ({ type: 'li' as const, text: q })))
  return out
}

export const meetingTitle = (s: Session) => `${s.title} · ${shortDay(s.startedAt)}`

/** The name createDoc gives a new doc from a template. */
export function templateTitle(id: DocTemplateId, name: string, now: number) {
  return id === 'blank' ? UNTITLED : id === 'meeting-notes' ? `Meeting notes · ${shortDay(now)}` : name
}

export const wordCount = (blocks: DocBlock[]) => blocks.reduce((n, b) => n + (b.text.trim() ? b.text.trim().split(/\s+/).length : 0), 0)
