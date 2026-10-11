// Copy and paste for docs. Copying writes plain text plus simple HTML built
// from the blocks (so formatting survives a paste into this or another doc).
// Pasting HTML keeps bold, italic, underline and strikethrough, and the lines'
// headings, lists and quotes; colours, fonts, sizes, links and images go.
import type { DocBlock, DocRun } from '../../types'
import { marksOf, runsOf, runsText, runsToHTML, trimRuns, replaceInRuns, withRuns, type Marks } from './runs'
import type { BlockType } from './model'

/** Blocks as clipboard HTML: headings, paragraphs, lists (checklists keep their boxes) and quotes. */
export function blocksToHTML(blocks: DocBlock[]): string {
  const out: string[] = []
  let list = false
  for (const b of blocks) {
    const inner = runsToHTML(runsOf(b))
    const item = b.type === 'li' || b.type === 'todo'
    if (item && !list) out.push('<ul>')
    if (!item && list) out.push('</ul>')
    list = item
    if (b.type === 'h1' || b.type === 'h2') out.push(`<${b.type}>${inner}</${b.type}>`)
    else if (b.type === 'li') out.push(`<li>${inner}</li>`)
    else if (b.type === 'todo') out.push(`<li><input type="checkbox"${b.done ? ' checked' : ''}> ${inner}</li>`)
    else if (b.type === 'quote') out.push(`<blockquote><p>${inner}</p></blockquote>`)
    else out.push(`<p>${inner}</p>`)
  }
  if (list) out.push('</ul>')
  return `<meta charset="utf-8">${out.join('')}`
}

/** Part of one line as clipboard HTML, with no block around it, so a paste keeps the target line's type. */
export const inlineHTML = (runs: DocRun[]) => `<meta charset="utf-8"><span>${runsToHTML(runs)}</span>`

const BLOCK_TAGS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TFOOT', 'THEAD', 'TR', 'UL'])
const SKIP_TAGS = new Set(['HEAD', 'STYLE', 'SCRIPT', 'TEMPLATE', 'NOSCRIPT', 'TITLE', 'META', 'LINK', 'SVG', 'IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'CANVAS', 'BUTTON', 'SELECT', 'TEXTAREA', 'MATH'])
const HEADING = /^H[1-6]$/

function typeFor(tag: string, inherited: BlockType): BlockType {
  if (tag === 'H1') return 'h1'
  if (HEADING.test(tag)) return 'h2'
  if (tag === 'LI') return 'li'
  if (tag === 'BLOCKQUOTE') return 'quote'
  return inherited
}

/** The marks an element adds or takes away, from its tag and its inline style. */
function marksFor(el: HTMLElement, tag: string, inherited: Marks, inLink: boolean): Marks {
  const m: Marks = { ...inherited }
  if (tag === 'B' || tag === 'STRONG') m.b = true
  if (tag === 'I' || tag === 'EM' || tag === 'CITE' || tag === 'DFN') m.i = true
  if (tag === 'U' || tag === 'INS') m.u = true
  if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') m.s = true
  // Headings and table headers are bold by nature; the block type already says so.
  if (HEADING.test(tag) || tag === 'TH') m.b = false
  const st = el.style
  const w = st?.fontWeight
  if (w && !HEADING.test(tag)) {
    // Google Docs wraps everything in <b style="font-weight:normal">, so the style wins over the tag.
    if (w === 'bold' || w === 'bolder' || Number(w) >= 700) m.b = true
    else if (w === 'normal' || w === 'lighter' || Number(w) <= 500) m.b = false
  }
  const fs = st?.fontStyle
  if (fs) m.i = fs === 'italic' || fs.startsWith('oblique')
  // A link's own underline is part of being a link, which a paste drops. Google Docs
  // puts it on a <span> inside the <a>, so styles anywhere inside a link don't count.
  const deco = (st?.textDecorationLine || st?.textDecoration || '').toLowerCase()
  if (deco && tag !== 'A') {
    if (deco.includes('none')) { m.u = false; m.s = false }
    if (deco.includes('underline') && !inLink) m.u = true
    if (deco.includes('line-through')) m.s = true
  }
  return m
}

/** Blocks from pasted HTML. Empty when there's nothing to keep (an image, say), so plain text takes over. */
export function blocksFromHTML(html: string): DocBlock[] {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return []
  }
  const out: DocBlock[] = []
  let line: { type: BlockType; runs: DocRun[]; done?: boolean } | null = null
  const end = () => {
    if (!line) return
    const runs = trimRuns(replaceInRuns(line.runs, /[ \t]{2,}/, ' '))
    if (runsText(runs).trim()) {
      const base: DocBlock = line.type === 'todo' ? { type: 'todo', text: '', done: !!line.done } : { type: line.type, text: '' }
      out.push(withRuns(base, runs))
    }
    line = null
  }
  const add = (text: string, type: BlockType, m: Marks) => {
    if (!text) return
    if (!line) {
      if (!text.trim()) return
      line = { type, runs: [] }
    }
    line.runs.push({ text, ...marksOf(m) })
  }
  const walk = (n: Node, type: BlockType, m: Marks, pre: boolean, link = false) => {
    if (n.nodeType === 3) {
      const t = (n.nodeValue ?? '').replace(/ /g, ' ')
      if (pre) t.replace(/\r\n?/g, '\n').split('\n').forEach((part, i) => { if (i) end(); add(part, type, m) })
      else add(t.replace(/\s+/g, ' '), type, m)
      return
    }
    if (n.nodeType !== 1) return
    const el = n as HTMLElement
    const tag = el.tagName.toUpperCase()
    if (SKIP_TAGS.has(tag)) return
    if (tag === 'BR') { end(); return }
    if (tag === 'INPUT') {
      // A ticked or unticked box at the start of a list item makes it a checklist item.
      const box = el as HTMLInputElement
      if (box.type === 'checkbox' && (type === 'li' || type === 'p')) {
        line ??= { type, runs: [] }
        line.type = 'todo'
        line.done = box.checked || box.hasAttribute('checked')
      }
      return
    }
    const block = BLOCK_TAGS.has(tag)
    const nextType = typeFor(tag, type)
    const nextLink = link || tag === 'A'
    const nextMarks = marksFor(el, tag, m, nextLink)
    const nextPre = pre || tag === 'PRE' || /^pre/.test(el.style?.whiteSpace ?? '')
    if (block) end()
    for (const c of el.childNodes) walk(c, nextType, nextMarks, nextPre, nextLink)
    if (block) end()
    else if (tag === 'TD' || tag === 'TH') add(' ', nextType, m)
  }
  walk(doc.body, 'p', {}, false)
  end()
  return out
}

