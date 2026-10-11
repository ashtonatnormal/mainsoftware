// Undo and redo for a deck. Every change to a deck goes through record(), so the
// history is the one source of truth: the toolbar buttons, Ctrl/Cmd+Z and the
// "Slide deleted · Undo" bar all use it. The browser's own undo never runs on a
// deck (see Slides.tsx), so it can't change a field behind the app's back.
//
// One history per deck, kept for as long as the page is open (leave the deck and
// come back and it's still there), up to LIMIT steps. Typing in one field joins
// into one step until you pause for MERGE_MS, leave the field or do anything else.
import { useSyncExternalStore } from 'react'
import type { Deck, Slide } from '../../types'

/** The parts of a deck a step can change. */
export type DeckChange = Partial<Pick<Deck, 'title' | 'theme' | 'slides'>>

/**
 * Where to land after undo or redo: the slide to select and, for text, the field
 * to put the caret back in ("title", "bullets.2", "notes", or "deck-title" for the
 * deck's name). Without a caret hint it goes where the text changed.
 */
export interface Spot { slideId?: string; field?: string; caret?: 'start' | 'end' }

export interface Step {
  id: number
  /** What the step did, for "Undo …" and "Redo …": "typing on slide 3". */
  label: string
  /** Steps with the same key join while you keep typing (one field on one slide). */
  key?: string
  before: DeckChange
  after: DeckChange
  undoTo: Spot
  redoTo: Spot
  /** When it last grew, for the pause that ends a typing run. */
  at: number
  /** Closed to further typing (you left the field, paused, undid or redid). */
  sealed: boolean
}

export const MERGE_MS = 1000
export const LIMIT = 200

interface Stack {
  undo: Step[]
  redo: Step[]
  version: number
  listeners: Set<() => void>
  subscribe: (cb: () => void) => () => void
  getVersion: () => number
}
const stacks = new Map<string, Stack>()
let seq = 0

function stack(deckId: string): Stack {
  let s = stacks.get(deckId)
  if (!s) {
    const listeners = new Set<() => void>()
    const made: Stack = {
      undo: [], redo: [], version: 0, listeners,
      subscribe: cb => { listeners.add(cb); return () => { listeners.delete(cb) } },
      getVersion: () => made.version,
    }
    stacks.set(deckId, (s = made))
  }
  return s
}
function changed(s: Stack) {
  s.version++
  for (const l of [...s.listeners]) l()
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)
const isNoop = (st: Pick<Step, 'before' | 'after'>) => (Object.keys(st.after) as (keyof DeckChange)[]).every(k => same(st.before[k], st.after[k]))

/** What a change would do to the deck: the old and new value of each part it touches. */
export function diff(deck: Pick<Deck, 'title' | 'theme' | 'slides'>, next: DeckChange): { before: DeckChange; after: DeckChange } | null {
  const before: DeckChange = {}, after: DeckChange = {}
  for (const k of Object.keys(next) as (keyof DeckChange)[]) {
    if (next[k] === undefined || next[k] === deck[k]) continue
    ;(before as Record<string, unknown>)[k] = deck[k]
    ;(after as Record<string, unknown>)[k] = next[k]
  }
  return Object.keys(after).length ? { before, after } : null
}

/**
 * Add a step, or grow the open typing step when it has the same key and you
 * haven't paused (`join` grows it regardless of the pause, e.g. the blur that
 * names an emptied deck "Untitled presentation"). Clears redo.
 */
export function record(deckId: string, step: Omit<Step, 'id' | 'at' | 'sealed'>, opts: { join?: boolean; now?: number } = {}): Step | undefined {
  const s = stack(deckId)
  const now = opts.now ?? Date.now()
  const top = s.undo[s.undo.length - 1]
  s.redo = []
  if (step.key && top && !top.sealed && top.key === step.key && (opts.join || now - top.at < MERGE_MS)) {
    for (const k of Object.keys(step.after) as (keyof DeckChange)[]) {
      if (!(k in top.before)) (top.before as Record<string, unknown>)[k] = step.before[k]
      ;(top.after as Record<string, unknown>)[k] = step.after[k]
    }
    top.redoTo = step.redoTo
    top.at = now
    // Typed and then deleted it again: nothing left to undo.
    if (isNoop(top)) s.undo.pop()
  } else {
    s.undo.push({ ...step, id: ++seq, at: now, sealed: false })
    if (s.undo.length > LIMIT) s.undo.shift()
  }
  changed(s)
  return s.undo.at(-1)
}

/** End the current typing run, so the next keystroke starts a new step. */
export function seal(deckId: string) {
  const top = stacks.get(deckId)?.undo.at(-1)
  if (top) top.sealed = true
}

/** Take the newest step off the undo list (onto redo) and return it to apply its `before`. */
export function takeUndo(deckId: string): Step | undefined {
  const s = stack(deckId)
  const st = s.undo.pop()
  if (!st) return
  st.sealed = true
  s.redo.push(st)
  seal(deckId)
  changed(s)
  return st
}

/** Take the newest undone step back onto the undo list and return it to apply its `after`. */
export function takeRedo(deckId: string): Step | undefined {
  const s = stack(deckId)
  const st = s.redo.pop()
  if (!st) return
  st.sealed = true
  s.undo.push(st)
  changed(s)
  return st
}

/** The deck's history, re-rendering whenever it changes. */
export function useDeckHistory(deckId: string) {
  const s = stack(deckId)
  useSyncExternalStore(s.subscribe, s.getVersion, s.getVersion)
  return { undo: s.undo.at(-1), redo: s.redo.at(-1) }
}

// ── Text in a slide field ────────────────────────────────────────────────────
/** The text of a field path ("title", "bullets.2", "left.heading", "right.1", "notes"). */
export function fieldText(s: Slide | undefined, field: string): string {
  if (!s) return ''
  const [key, sub] = field.split('.')
  if (sub === undefined) {
    const v = (s as unknown as Record<string, unknown>)[key]
    return typeof v === 'string' ? v : ''
  }
  if (key === 'bullets') return s.bullets?.[Number(sub)] ?? ''
  const col = key === 'left' || key === 'right' ? s[key] : undefined
  if (sub === 'heading') return col?.heading ?? ''
  return col?.bullets[Number(sub)] ?? ''
}

/**
 * Where the caret goes in `shown` after it replaces `other`: just after the part
 * that differs, so undoing typing leaves the caret where the typing began and
 * redoing it leaves the caret after the retyped text.
 */
export function caretAfterChange(shown: string, other: string): number {
  const max = Math.min(shown.length, other.length)
  let p = 0
  while (p < max && shown[p] === other[p]) p++
  let s = 0
  while (s < max - p && shown[shown.length - 1 - s] === other[other.length - 1 - s]) s++
  return shown.length - s
}
