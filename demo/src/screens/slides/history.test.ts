// Tests for the Slides undo history. Run from demo/:
//   node --experimental-strip-types src/screens/slides/history.test.ts
// The demo's sources use extensionless imports, so this registers a tiny
// resolver that adds ".ts" before loading the module.
/* eslint-disable @typescript-eslint/no-explicit-any */
const nodeModule: any = await import('node:module' as string)
const hook = `export async function resolve(s, c, next) { try { return await next(s, c) } catch (e) { if (s.startsWith('.') && !/\\.[cm]?[jt]sx?$/.test(s)) return next(s + '.ts', c); throw e } }`
nodeModule.register('data:text/javascript,' + encodeURIComponent(hook), import.meta.url)

const H: typeof import('./history') = await import('./history.ts' as string)
const { record, seal, takeUndo, takeRedo, diff, fieldText, caretAfterChange, MERGE_MS, LIMIT } = H
type Slide = import('../../types').Slide

let failed = 0, passed = 0
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) passed++
  else { failed++; console.log(`✖ ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`) }
}

const s1: Slide = { id: 'a', layout: 'bullets', title: 'Plan', bullets: ['One', 'Two'], notes: 'Hi' }
const typing = (deckId: string, from: string, to: string, now: number, opts: { join?: boolean } = {}) =>
  record(deckId, { label: 'typing on slide 1', key: 'text:a:title', before: { title: from }, after: { title: to }, undoTo: { slideId: 'a', field: 'title' }, redoTo: { slideId: 'a', field: 'title' } }, { now, ...opts })
const other = (deckId: string, label: string, now: number) =>
  record(deckId, { label, before: { theme: 'ember' }, after: { theme: 'slate' }, undoTo: {}, redoTo: {} }, { now })

// Typing joins into one step until a pause.
typing('d1', 'P', 'Pl', 0)
typing('d1', 'Pl', 'Pla', 400)
typing('d1', 'Pla', 'Plan', 400 + MERGE_MS - 1)
let st = takeUndo('d1')
eq('keystrokes inside the pause join into one step', st && [st.before, st.after], [{ title: 'P' }, { title: 'Plan' }])
eq('nothing older', takeUndo('d1'), undefined)

typing('d2', 'P', 'Pl', 0)
typing('d2', 'Pl', 'Pla', MERGE_MS + 1)
eq('a pause starts a new step', takeUndo('d2')?.before, { title: 'Pl' })
eq('and the first is still there', takeUndo('d2')?.before, { title: 'P' })

// Seal (leaving the field) starts a new step even without a pause.
typing('d3', 'P', 'Pl', 0)
seal('d3')
typing('d3', 'Pl', 'Pla', 10)
eq('seal ends the run', takeUndo('d3')?.before, { title: 'Pl' })

// join grows the open step across a pause (an emptied title named "Untitled presentation" on blur).
typing('d4', 'Plan', '', 0)
typing('d4', '', 'Untitled presentation', 5000, { join: true })
st = takeUndo('d4')
eq('join ignores the pause', st && [st.before, st.after], [{ title: 'Plan' }, { title: 'Untitled presentation' }])

// Typing then deleting it again leaves nothing to undo.
other('d5', 'change theme', 0)
typing('d5', 'Plan', 'Plans', 10)
typing('d5', 'Plans', 'Plan', 20)
eq('a run that ends where it began is dropped', takeUndo('d5')?.label, 'change theme')

// Undo, redo and a new change.
other('d6', 'first', 0)
other('d6', 'second', 10)
eq('undo takes the newest', takeUndo('d6')?.label, 'second')
eq('redo brings it back', takeRedo('d6')?.label, 'second')
takeUndo('d6')
other('d6', 'third', 20)
eq('a new change clears redo', takeRedo('d6'), undefined)
eq('undo order after a new change', [takeUndo('d6')?.label, takeUndo('d6')?.label, takeUndo('d6')], ['third', 'first', undefined])

// Undo seals, so typing after an undo is its own step.
typing('d7', 'P', 'Pl', 0)
typing('d7', 'Pl', 'Pla', 10)
seal('d7')
typing('d7', 'Pla', 'Plan', 20)
takeUndo('d7')
typing('d7', 'Pla', 'Plat', 30)
eq('typing after an undo does not join the step before it', takeUndo('d7')?.before, { title: 'Pla' })

// The cap.
for (let i = 0; i < LIMIT + 25; i++) other('d8', `step ${i}`, i * 10)
let n = 0
while (takeUndo('d8')) n++
eq(`history keeps the newest ${LIMIT} steps`, n, LIMIT)

// Each deck has its own history.
other('d9', 'mine', 0)
eq('decks don\'t share history', takeUndo('d10'), undefined)

// diff: only the parts that changed, with their old values.
const deck = { title: 'T', theme: 'ember' as const, slides: [s1] }
eq('diff of a no-op is null', diff(deck, { title: 'T', slides: deck.slides }), null)
eq('diff keeps what changed', diff(deck, { title: 'U', theme: 'ember' }), { before: { title: 'T' }, after: { title: 'U' } })
eq('a new list of the same slides is no change (picking the current layout)', diff(deck, { slides: deck.slides.map(x => x) }), null)
eq('nor is a copy of a slide with the same content', diff(deck, { slides: deck.slides.map(x => ({ ...x })) }), null)
eq('a changed slide in a new list is a change', diff(deck, { slides: deck.slides.map(x => ({ ...x, title: 'New' })) })?.after.slides?.[0].title, 'New')

// fieldText and the caret.
const two: Slide = { id: 'b', layout: 'two-column', title: 'X', left: { heading: 'Risks', bullets: ['A', 'B'] }, right: { bullets: ['C'] } }
eq('field paths', [fieldText(s1, 'title'), fieldText(s1, 'bullets.1'), fieldText(s1, 'notes'), fieldText(two, 'left.heading'), fieldText(two, 'right.0'), fieldText(two, 'right.heading'), fieldText(s1, 'subtitle')], ['Plan', 'Two', 'Hi', 'Risks', 'C', '', ''])
eq('undo typing at the end: caret where it began', caretAfterChange('Hello', 'Hello world'), 5)
eq('redo it: caret after the text', caretAfterChange('Hello world', 'Hello'), 11)
eq('typing in the middle', [caretAfterChange('Helo', 'Hello'), caretAfterChange('Hello', 'Helo')], [3, 4])
eq('replaced text: caret after the restored part', caretAfterChange('cat', 'dog'), 3)
eq('repeated letters', [caretAfterChange('aa', 'aaa'), caretAfterChange('aaa', 'aa')], [2, 3])

console.log(failed ? `\n${failed} failed, ${passed} passed` : `all ${passed} passed`)
if (failed) (globalThis as any).process.exit(1)
