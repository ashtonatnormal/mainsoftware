// AI help for slides (D16). Everything here is computed from the demo data the
// person can open; the editor only shows it as a suggestion to accept or discard.
import type { Doc, DocBlock, Folder, Slide } from '../../types'
import { ME, people, personById } from '../../data/people'
import { accessOf, canEdit, isTrashed } from '../../drive'
import { slideId } from './model'
import { slideText } from './render'

/** Docs this person can open: their own, shared with them, or open to the team or organisation. */
export function openableDocs(docs: Doc[], folders: Folder[]): Doc[] {
  return docs
    .filter(d => !isTrashed(folders, d))
    .filter(d => d.ownerId === ME || canEdit(d) || d.sharedWith?.some(g => g.personId === ME) || accessOf(folders, d) !== 'restricted')
    .sort((a, b) => (b.lastOpenedAt ?? b.updatedAt) - (a.lastOpenedAt ?? a.updatedAt))
}

// A "big number": thousands with separators, a percentage, or a dollar amount.
const BIG = /(S?\$\s?\d[\d,.]*(?:\s?[km]\b)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?%)/i

/** Shorten a line for a slide: drop asides, keep the first sentence, cap the length. */
export function shorten(text: string, max = 64): string {
  let t = text.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim()
  const first = t.split(/(?<=[.!?])\s+/)[0]
  if (first) t = first
  t = t.replace(/[.;:,]$/, '')
  if (t.length <= max) return t
  // Prefer ending at a clause ("…, unless…", "… and …"), so a point still reads whole.
  const cut = t.slice(0, max + 1)
  const clause = Math.max(cut.lastIndexOf(', '), cut.lastIndexOf('; '), cut.lastIndexOf(' – '), cut.lastIndexOf(': '))
  if (clause > max * 0.45) return t.slice(0, clause)
  const sp = cut.lastIndexOf(' ')
  let head = t.slice(0, sp > max * 0.6 ? sp : max)
  // Don't end on a word that needs what follows it.
  head = head.replace(/\s+(a|an|the|to|of|in|on|for|by|with|and|or|up|at|from|into|unless|if|that|which|our|your|their)$/i, '')
  return `${head.replace(/[,;:]$/, '')}…`
}

const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean)

/** Turn a line with a big number into a big-number slide. */
function bigNumber(line: string, section: string): Slide | null {
  const m = line.match(BIG)
  if (!m || m.index === undefined) return null
  const stat = m[0].trim()
  const before = line.slice(0, m.index)
  const after = line.slice(m.index + m[0].length).replace(/^[\s,.;:!?]+/, '')
  const colon = before.indexOf(':')
  const title = colon > 0 ? before.slice(0, colon).trim() : section
  let label = after.split(/\s+/).length >= 2 ? after : `${before.slice(colon + 1)} ${after}`
  label = label.trim().replace(/[.;:!?]+$/, '').replace(/\b(by\s+)?(about|around|roughly|nearly|over|some)\s*$/i, '').replace(/^\s*(about|around|roughly)\s+/i, '')
  // "With one forklift out, picking slows" → "slower picking with one forklift out" reads oddly;
  // keep the doc's words but start lower-case so it reads as a label under the number.
  label = label.trim()
  if (/^[A-Z][a-z]/.test(label) && !/^[A-Z][a-z]+ [A-Z]/.test(label)) label = label[0].toLowerCase() + label.slice(1)
  return { id: slideId(), layout: 'big-number', title: shorten(title, 48), stat, statLabel: shorten(label.trim(), 90) }
}

/** Where a line of doc text came from, so bullet slides keep doc order. */
type Line = { text: string; block: DocBlock }

export interface DraftResult {
  slides: Slide[]
  counts: { bullets: number; numbers: number; quotes: number }
  /** The doc's title, tidied for a deck name. */
  title: string
}

/**
 * Draft slides from a doc: a title slide from its h1, a bullets slide for each
 * h2 from the list, to-do and paragraph lines under it (shortened), a big-number
 * slide for any line with a big number, and a quote slide for a pull quote.
 */
export function draftFromDoc(doc: Doc): DraftResult {
  const blocks = doc.blocks.filter(b => b.text.trim())
  const h1 = blocks.find(b => b.type === 'h1')?.text ?? doc.title
  const firstH2 = blocks.findIndex(b => b.type === 'h2')
  const introBlocks = blocks.slice(0, firstH2 < 0 ? blocks.length : firstH2).filter(b => b.type !== 'h1')
  // The intro paragraph becomes the subtitle, unless it carries a big number (that gets its own slide).
  const intro = introBlocks.find(b => b.type === 'p' && !BIG.test(b.text))
  const title = shorten(h1.replace(/\s*\((draft|wip)\)/i, ''), 70)
  const slides: Slide[] = [
    { id: slideId(), layout: 'title', title, subtitle: intro ? shorten(intro.text, 90) : doc.space },
  ]
  const counts = { bullets: 0, numbers: 0, quotes: 0 }
  const owner = personById[doc.ownerId]?.short ?? 'the author'

  // Group the blocks under each h2. Lines before the first h2 (other than the
  // subtitle) form an opening section named after the doc, so a doc with no
  // headings still gives slides.
  const sections: { title: string; lines: Line[]; quotes: string[] }[] = [{ title, lines: [], quotes: [] }]
  for (const b of blocks) {
    if (b.type === 'h1' || b === intro) continue
    if (b.type === 'h2') { sections.push({ title: b.text, lines: [], quotes: [] }); continue }
    const sec = sections[sections.length - 1]
    if (b.type === 'quote') { sec.quotes.push(b.text); continue }
    // Paragraphs split into sentences, so one big number doesn't swallow a whole paragraph.
    for (const text of b.type === 'p' ? sentences(b.text) : [b.text]) sec.lines.push({ text, block: b })
  }

  for (const sec of sections) {
    const bullets: string[] = []
    const numbers: Slide[] = []
    for (const l of sec.lines) {
      const n = bigNumber(l.text, sec.title)
      if (n) numbers.push(n)
      else bullets.push(shorten(l.text) + (l.block.type === 'todo' && l.block.done ? ' (done)' : ''))
    }
    for (let i = 0; i < bullets.length; i += 6) {
      slides.push({ id: slideId(), layout: 'bullets', title: shorten(sec.title, 56) + (i ? ' (cont.)' : ''), bullets: bullets.slice(i, i + 6) })
      counts.bullets++
    }
    slides.push(...numbers)
    counts.numbers += numbers.length
    for (const q of sec.quotes) slides.push({ id: slideId(), layout: 'quote', title: shorten(q, 120), subtitle: `From “${doc.title}” by ${owner}` })
    counts.quotes += sec.quotes.length
  }
  return { slides, counts, title }
}

// Words that keep their capital mid-sentence: people's names, places, days and months.
const proper = new Set([
  ...people.flatMap(p => p.name.split(/\s+/)),
  'Meridian', 'Kranji', 'Pasir', 'Woodlands', 'Sentosa', 'Tembusu', 'Hearth', 'Singapore',
  'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'October', 'November', 'December', 'I',
])
/** Lower-case the first letter for use mid-sentence, unless it starts with a name or an acronym. */
const lower = (s: string) => {
  const first = s.match(/^[A-Za-z]+/)?.[0] ?? ''
  if (!/^[A-Z][a-z]/.test(first) || proper.has(first)) return s
  if (/^[A-Z][a-z]+ [A-Z][a-z]/.test(s)) return s // a name like "Leave Policy"
  return s[0].toLowerCase() + s.slice(1)
}

/** A slide line made fit for a sentence: no asides, no trailing ellipsis or full stop. */
const clean = (t: string) => t.replace(/\s*\([^)]*\)/g, '').replace(/[….;:,\s]+$/, '').trim()

/** Speaker notes for a slide, written from what is on it. */
export function writeNotes(s: Slide, index: number, total: number): string {
  const title = s.title.trim()
  const open = index === 0 ? 'Welcome everyone.' : total > 1 && index === total - 1 ? 'Last slide.' : ''
  const lines: string[] = []
  switch (s.layout) {
    case 'title':
    case 'section':
      lines.push(title ? `${index === 0 ? 'Today is about' : 'Next up:'} ${lower(clean(title))}.` : 'Introduce what this part covers.')
      if (s.subtitle) lines.push(`Set the scene: ${lower(clean(s.subtitle.replace(/\s*·\s*/g, ', ')))}.`)
      if (index === 0 && total > 1) lines.push(`We have ${total - 1} slides after this one, so this should be quick.`)
      break
    case 'bullets': {
      const b = (s.bullets ?? []).map(clean).filter(Boolean)
      if (title) lines.push(`${clean(title)}.`)
      if (b.length === 1) lines.push(`One point here: ${b[0]}.`)
      else if (b.length) {
        lines.push(`${b.length} points, in order. First: ${b[0]}.`)
        if (b.length > 2) lines.push(`Then: ${b.slice(1, -1).join('; ')}.`)
        lines.push(`Last: ${b[b.length - 1]}. Check for questions before moving on.`)
      }
      break
    }
    case 'two-column': {
      const L = s.left, R = s.right
      if (title) lines.push(`${clean(title)}.`)
      if (L?.bullets.some(Boolean)) lines.push(`On the left${L.heading ? `, ${clean(L.heading)}` : ''}: ${L.bullets.map(clean).filter(Boolean).join('; ')}.`)
      if (R?.bullets.some(Boolean)) lines.push(`On the right${R.heading ? `, ${clean(R.heading)}` : ''}: ${R.bullets.map(clean).filter(Boolean).join('; ')}.`)
      lines.push('Read across the two columns so each line on the left meets its partner on the right.')
      break
    }
    case 'big-number':
      lines.push(`Let the number land first: ${s.stat || 'the figure'}${s.statLabel ? `, ${lower(clean(s.statLabel))}` : ''}.`)
      if (title) lines.push(`Context: ${clean(title)}.`)
      lines.push('Pause, then say what it means for us this quarter.')
      break
    case 'quote':
      lines.push(`Read the quote slowly${s.subtitle ? `, then credit it: ${clean(s.subtitle)}` : ''}.`)
      lines.push('Then say in one sentence why it matters now.')
      break
    case 'image':
      lines.push(title ? `Show the picture and name it: ${lower(title)}.` : 'Let people look at the picture for a moment.')
      if (s.subtitle) lines.push(`${clean(s.subtitle.replace(/\s*·\s*/g, ', '))}.`)
      break
  }
  if (!slideText(s).length) return 'This slide is empty. Add a title or points first, then ask again.'
  return [open, ...lines].filter(Boolean).join(' ').replace(/\.\./g, '.')
}
