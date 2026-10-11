// Tests for inline formatting in docs (runs, shortcuts, Markdown, diffs). Run from demo/:
//   node --experimental-strip-types src/screens/docs/runs.test.ts
// The demo's sources use extensionless imports, so this registers a tiny
// resolver that adds ".ts" before loading them.
/* eslint-disable @typescript-eslint/no-explicit-any */
const nodeModule: any = await import('node:module' as string)
const hook = `export async function resolve(s, c, next) { try { return await next(s, c) } catch (e) { if (s.startsWith('.') && !/\\.[cm]?[jt]sx?$/.test(s)) return next(s + '.ts', c); throw e } }`
nodeModule.register('data:text/javascript,' + encodeURIComponent(hook), import.meta.url)

const R: typeof import('./runs') = await import('./runs.ts' as string)
const M: typeof import('./model') = await import('./model.ts' as string)
const W: typeof import('../../data/work') = await import('../../data/work.ts' as string)
type DocBlock = import('../../types').DocBlock

let failed = 0, passed = 0
function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++
  else { failed++; console.error(`✖ ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`) }
}

const B = (text: string) => ({ text, b: true })
const I = (text: string) => ({ text, i: true })

// ── normalise, runsOf, withRuns ──
eq('merges equal neighbours and drops empties', R.normalise([{ text: 'a' }, { text: '' }, { text: 'b' }, B('c'), B('d')]), [{ text: 'ab' }, B('cd')])
eq('false marks are dropped', R.normalise([{ text: 'a', b: false, i: true }]), [I('a')])
eq('runs that don’t spell the text are ignored', R.runsOf({ text: 'Hello', runs: [B('Help')] }), [{ text: 'Hello' }])
eq('plain blocks carry no runs', R.withRuns({ type: 'p', text: 'x', runs: [B('x')] }, [{ text: 'a' }, { text: 'b' }]), { type: 'p', text: 'ab' })
eq('withRuns keeps text in step and done', R.withRuns({ type: 'todo', text: '', done: true }, [{ text: 'Do ' }, B('this')]), { type: 'todo', text: 'Do this', done: true, runs: [{ text: 'Do ' }, B('this')] })

// ── slicing and marks ──
const runs = [{ text: 'We launch on ' }, B('2 Nov'), { text: ' with capacity.' }]
eq('slice across runs', R.sliceRuns(runs, 10, 16), [{ text: 'on ' }, B('2 N')])
eq('caret after bold inherits bold', R.caretMarks(runs, 18), { b: true })
eq('caret at start of bold inherits the plain text before it', R.caretMarks(runs, 13), {})
eq('caret at block start takes the first character', R.caretMarks([B('Note'), { text: ' x' }], 0), { b: true })
eq('rangeHas: all bold', R.rangeHas(runs, 13, 18, 'b'), true)
eq('rangeHas: partly bold', R.rangeHas(runs, 12, 18, 'b'), false)
eq('setMark on a range splits runs', R.setMark(runs, 3, 9, 'i', true), [{ text: 'We ' }, I('launch'), { text: ' on ' }, B('2 Nov'), { text: ' with capacity.' }])
eq('setMark off merges back', R.setMark(R.setMark(runs, 13, 18, 'b', false), 0, 0, 'b', true), [{ text: 'We launch on 2 Nov with capacity.' }])
eq('rangeMarks', R.rangeMarks([{ text: 'a', b: true, i: true }, B('b')], 0, 2), { b: true })
eq('replaceInRuns keeps the style of what it replaces', R.replaceInRuns([B('a\n'), { text: 'b' }], /\s*\n+\s*/g, ' '), [B('a '), { text: 'b' }])
eq('trimRuns', R.trimRuns([{ text: '  ' }, B('x '), { text: ' ' }]), [B('x')])

// ── textChange (what the browser did) ──
eq('typing "a" after "a" lands at the caret', R.textChange('aa', 'aaa', 2), { start: 1, removed: 0, inserted: 'a' })
eq('backspace', R.textChange('abc', 'ac', 1), { start: 1, removed: 1, inserted: '' })
eq('typing over a selection', R.textChange('hello world', 'hello x', 7), { start: 6, removed: 5, inserted: 'x' })
eq('autocorrect before the caret', R.textChange('teh ', 'the ', 4), { start: 1, removed: 3, inserted: 'he ' })
eq('no change', R.textChange('x', 'x', 1), null)

// ── setPlainText (the title field) and replaceOnce (restores) ──
eq('editing the title keeps bold elsewhere', R.setPlainText({ type: 'h1', text: 'Q4 plan', runs: [B('Q4'), { text: ' plan' }] }, 'Q4 plans'), { type: 'h1', text: 'Q4 plans', runs: [B('Q4'), { text: ' plans' }] })
eq('editing the start of the title keeps bold later on (no caret)', R.setPlainText({ type: 'h1', text: 'Q4 Launch plan', runs: [{ text: 'Q4 ' }, B('Launch'), { text: ' plan' }] }, 'Q5 Launch plan'), { type: 'h1', text: 'Q5 Launch plan', runs: [{ text: 'Q5 ' }, B('Launch'), { text: ' plan' }] })
eq('… and with the field’s caret', R.setPlainText({ type: 'h1', text: 'Q4 Launch plan', runs: [{ text: 'Q4 ' }, B('Launch'), { text: ' plan' }] }, 'Q Launch plan', 1), { type: 'h1', text: 'Q Launch plan', runs: [{ text: 'Q ' }, B('Launch'), { text: ' plan' }] })
eq('replaceOnce keeps formatting around it', R.replaceOnce({ type: 'p', text: 'a b c', runs: [B('a'), { text: ' b c' }] }, 'b', 'x'), { type: 'p', text: 'a x c', runs: [B('a'), { text: ' x c' }] })

// ── Markdown shortcuts while typing ──
const sc = (text: string, typed: string, caret = text.length) => {
  const s = R.inlineShortcut(text, caret, typed)
  if (!s) return null
  const r = R.applyInlineShortcut([{ text }], s)
  return { runs: r.runs, caret: r.caret }
}
eq('**bold**', sc('say **hi**', '*'), { runs: [{ text: 'say ' }, B('hi')], caret: 6 })
eq('*italic*', sc('say *hi*', '*'), { runs: [{ text: 'say ' }, I('hi')], caret: 6 })
eq('_italic_', sc('_hi there_', '_'), { runs: [I('hi there')], caret: 8 })
eq('~~strike~~', sc('was ~~£40~~', '~'), { runs: [{ text: 'was ' }, { text: '£40', s: true }], caret: 7 })
eq('**bold* is not italic yet', sc('**bold*', '*'), null)
eq('snake_case_ stays', sc('my snake_case_', '_'), null)
eq('_x_ inside a word stays', sc('a_b_', '_'), null)
eq('2*3* stays', sc('2*3*', '*'), null)
eq('not when the closing marker is mid-word', sc('*hi*there', '*', 4), null)
eq('no space inside the markers', sc('** hi**', '*'), null)
eq('a lone pair of stars stays', sc('**', '*'), null)

// ── Markdown export ──
eq('bold, italic, strike, underline', R.runsToMarkdown([{ text: 'a ' }, B('b'), { text: ' ' }, I('c'), { text: ' ' }, { text: 'd', s: true }, { text: ' ' }, { text: 'e', u: true }]), 'a **b** *c* ~~d~~ <u>e</u>')
eq('spaces move outside markers', R.runsToMarkdown([B('bold '), { text: 'plain' }]), '**bold** plain')
eq('nested marks open and close in order', R.runsToMarkdown([B('bold '), { text: 'both', b: true, i: true }]), '**bold *both***')
eq('stacked marks: the longer one opens first', R.runsToMarkdown([{ text: 'x', b: true, i: true }, I('y')]), '***x**y*')
eq('a space that only carries a style waits outside the markers', R.runsToMarkdown([{ text: 'a', b: true, s: true }, { text: ' ', b: true }, { text: 'c', s: true }]), '**~~a~~** ~~c~~')
eq('literal * ~ ` and < are escaped; snake_case is left alone', R.runsToMarkdown([{ text: '2*3*4 ~x~ `c` <u> snake_case _y_ ' }, B('b*')]), '2\\*3\\*4 \\~x\\~ \\`c\\` \\<u> snake_case \\_y\\_ **b\\***')
const md = M.toMarkdown('T', [{ type: 'h1', text: 'T' }, { type: 'li', ...{ text: 'first 300 pallets', runs: [{ text: 'first ' }, B('300 pallets')] } }, { type: 'quote', text: 'go / no-go', runs: [B('go / no-go')] }])
eq('toMarkdown uses the runs', md, '# T\n\n- first **300 pallets**\n\n> **go / no-go**\n')

// ── Block types, sameness and diffs ──
eq('heading keeps formatting and goes onto one line', M.withType({ type: 'p', text: 'a\nb', runs: [B('a\n'), { text: 'b' }] }, 'h2'), { type: 'h2', text: 'a b', runs: [B('a '), { text: 'b' }] })
const before: DocBlock[] = [{ type: 'p', text: 'Same words' }, { type: 'p', text: 'Other' }]
const after: DocBlock[] = [{ type: 'p', text: 'Same words', runs: [B('Same'), { text: ' words' }] }, { type: 'p', text: 'Other changed' }]
eq('formatting-only change is not the same block', M.sameBlocks(before, [before[0], { ...before[1] }]), true)
eq('… but bold makes it differ', M.sameBlocks([before[0]], [after[0]]), false)
const d = M.diffLines(M.linesOf(before), M.linesOf(after))
eq('diff compares plain text', d, { added: ['Other changed'], removed: ['Other'] })
eq('formatChanges lists the reformatted line only', M.formatChanges(before, after, d.added), ['Same words'])

// ── Seed doc ──
const q4 = W.docs.find(x => x.id === 'd_q4')!
eq('d_q4 seed runs spell their text', q4.blocks.every(b => !b.runs || R.runsText(b.runs) === b.text), true)
eq('d_q4 has bold 2 Nov', R.runsOf(q4.blocks[1]).find(r => r.b)?.text, '2 Nov')
eq('undoVersion on formatted text still finds the line', M.undoVersion(q4.blocks, q4.versions[0]).find(b => b.text.startsWith('Week 2'))?.text, 'Week 2 (9–13 Nov): staff training continues')

console.log(`${passed} passed, ${failed} failed`)
if (failed) (globalThis as any).process.exit(1)
