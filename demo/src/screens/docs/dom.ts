// The DOM side of an editable block. Each block is a contentEditable element
// whose children are only text, <strong>, <em>, <u> and <s>, written from the
// block's runs. These helpers read it back, and map between plain-text offsets
// (what the model uses) and DOM selection points, so the caret survives a
// re-render. Elements marked data-ui (a collaborator's name tag) are skipped.
import type { DocRun } from '../../types'
import { normalise, runsText, type Marks } from './runs'

export const blockEl = (key: string) => document.getElementById(`blk-${key}`) as HTMLElement | null
export const isBlockEl = (el: Element | null): el is HTMLElement => !!el && el instanceof HTMLElement && el.id.startsWith('blk-')
export const keyOfEl = (el: HTMLElement) => el.id.slice(4)

const TAG_MARK: Record<string, keyof Marks> = { STRONG: 'b', B: 'b', EM: 'i', I: 'i', U: 'u', S: 's', STRIKE: 's', DEL: 's' }
const LINEISH = new Set(['DIV', 'P', 'LI'])

/** Text and <br> leaves in order, with how much plain text each stands for. */
function leaves(root: Node): { node: Node; len: number; marks: Marks }[] {
  const out: { node: Node; len: number; marks: Marks }[] = []
  const walk = (n: Node, m: Marks) => {
    if (n.nodeType === 3) { out.push({ node: n, len: n.nodeValue?.length ?? 0, marks: m }); return }
    if (!(n instanceof Element) || n.hasAttribute('data-ui')) return
    if (n.tagName === 'BR') { out.push({ node: n, len: 1, marks: m }); return }
    const mark = TAG_MARK[n.tagName]
    const mm = mark ? { ...m, [mark]: true } : m
    // A browser that wraps a new line in its own <div> still reads as a newline.
    if (n !== root && LINEISH.has(n.tagName) && out.length) out.push({ node: n, len: 1, marks: m })
    for (const c of n.childNodes) walk(c, mm)
  }
  walk(root, {})
  // A <br> at the very end only holds the last line open; it isn't text.
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].node.nodeType === 3 && out[i].len === 0) continue
    if ((out[i].node as Element).tagName === 'BR') out[i] = { ...out[i], len: 0 }
    break
  }
  return out
}

const leafText = (l: { node: Node; len: number }) => (l.node.nodeType === 3 ? l.node.nodeValue ?? '' : l.len ? '\n' : '')

/** What the element holds, as runs. */
export function readRuns(root: HTMLElement): DocRun[] {
  return normalise(leaves(root).map(l => ({ text: leafText(l), ...l.marks })))
}
export const readText = (root: HTMLElement) => runsText(readRuns(root))

/** Writes runs into the element: <strong>, <em>, <u> and <s> around plain text. */
export function writeRuns(root: HTMLElement, runs: DocRun[]) {
  const nodes: Node[] = runs.map(r => {
    let n: Node = document.createTextNode(r.text)
    for (const [m, tag] of [['s', 's'], ['u', 'u'], ['i', 'em'], ['b', 'strong']] as const) {
      if (!r[m]) continue
      const el = document.createElement(tag)
      el.appendChild(n)
      n = el
    }
    return n
  })
  // A trailing newline needs something after it to show as a line.
  if (runsText(runs).endsWith('\n')) nodes.push(document.createElement('br'))
  root.replaceChildren(...nodes)
}

// The only elements writeRuns makes. Typing over styled text can leave the browser's
// own (<strike>, <b>, a styled <span>), which read the same but don't take our styles.
const OWN = new Set(['STRONG', 'EM', 'U', 'S', 'BR'])

/** Rewrites the element if it doesn't show these runs, keeping the selection where it was. */
export function syncRuns(root: HTMLElement, runs: DocRun[]) {
  const shown = readRuns(root)
  const same = shown.length === normalise(runs).length && JSON.stringify(shown) === JSON.stringify(normalise(runs))
  if (same && [...root.querySelectorAll('*')].every(el => OWN.has(el.tagName))) return false
  const sel = document.activeElement === root ? getSel(root) : null
  writeRuns(root, runs)
  if (sel) setSel(root, sel.start, sel.end)
  return true
}

/** The plain-text offset of a DOM point inside root. */
export function offsetOf(root: Node, node: Node, offset: number): number {
  const point = document.createRange()
  point.setStart(node, offset)
  let at = 0
  for (const l of leaves(root)) {
    if (!l.len) continue
    if (l.node === node) return at + Math.min(offset, l.len)
    // Count the leaf when it ends at or before the point.
    const ends: [Node, number] = l.node.nodeType === 3 ? [l.node, l.len] : isBr(l.node) ? [l.node.parentNode!, indexIn(l.node) + 1] : [l.node, 0]
    if (point.comparePoint(ends[0], ends[1]) > 0) return at
    at += l.len
  }
  return at
}

const isBr = (n: Node) => (n as Element).tagName === 'BR'
const indexIn = (n: Node) => [...(n.parentNode?.childNodes ?? [])].indexOf(n as ChildNode)

/** The selection inside root as plain-text offsets, or null when it's elsewhere. */
export function getSel(root: HTMLElement): { start: number; end: number } | null {
  const sel = document.getSelection()
  if (!sel || !sel.rangeCount) return null
  const r = sel.getRangeAt(0)
  if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return null
  const start = offsetOf(root, r.startContainer, r.startOffset)
  const end = r.collapsed ? start : offsetOf(root, r.endContainer, r.endOffset)
  return { start: Math.min(start, end), end: Math.max(start, end) }
}

/** The DOM point for a plain-text offset. At a boundary between two runs it stays in the
 *  earlier one, which is the style typing takes there. */
function pointAt(root: HTMLElement, pos: number): [Node, number] {
  let at = 0
  let last: [Node, number] | null = null
  for (const l of leaves(root)) {
    if (l.node.nodeType === 3) {
      if (pos <= at + l.len) return [l.node, pos - at]
      last = [l.node, l.len]
    } else if (l.len) {
      const parent = l.node.parentNode!
      const index = indexIn(l.node)
      if (pos === at) return [parent, index]
      last = isBr(l.node) ? [parent, index + 1] : [l.node, 0]
    }
    at += l.len
  }
  return last ?? [root, 0]
}

export function setSel(root: HTMLElement, start: number, end = start) {
  const sel = document.getSelection()
  if (!sel) return
  const r = document.createRange()
  const [sn, so] = pointAt(root, start)
  r.setStart(sn, so)
  if (end !== start) {
    const [en, eo] = pointAt(root, end)
    r.setEnd(en, eo)
  } else r.collapse(true)
  sel.removeAllRanges()
  sel.addRange(r)
}

/** Is the caret on the first or last visual line of the block? Used to move between blocks with the arrow keys. */
export function caretLines(root: HTMLElement, caret: number): { first: boolean; last: boolean } {
  const text = readText(root)
  const box = root.getBoundingClientRect()
  const lh = parseFloat(getComputedStyle(root).lineHeight) || 24
  const rectFor = (a: number, b: number) => {
    if (a < 0 || b > text.length || text.slice(a, b) === '\n') return null
    const r = document.createRange()
    const [sn, so] = pointAt(root, a)
    const [en, eo] = pointAt(root, b)
    try { r.setStart(sn, so); r.setEnd(en, eo) } catch { return null }
    const rects = r.getClientRects()
    const rect = rects[a < caret ? rects.length - 1 : 0]
    return rect && rect.height ? rect : null
  }
  const rect = rectFor(caret, caret + 1) ?? rectFor(caret - 1, caret)
  if (!rect) return { first: caret === 0, last: caret === text.length }
  return { first: rect.top - box.top < lh * 0.6, last: box.bottom - rect.bottom < lh * 0.6 }
}

/** contentEditable="plaintext-only" keeps browsers from adding their own formatting; older ones get "true". */
export const EDITABLE: 'plaintext-only' | 'true' = (() => {
  try {
    const d = document.createElement('div')
    d.contentEditable = 'plaintext-only'
    return d.contentEditable === 'plaintext-only' ? 'plaintext-only' : 'true'
  } catch {
    return 'true'
  }
})()
