// Tests for the Sheets formula engine. Run from demo/:
//   node --experimental-strip-types src/screens/sheets/formula.test.ts
// The demo's sources use extensionless imports, so this registers a tiny
// resolver that adds ".ts" before loading the engine and the seed sheets.
/* eslint-disable @typescript-eslint/no-explicit-any */
const nodeModule: any = await import('node:module' as string)
const hook = `export async function resolve(s, c, next) { try { return await next(s, c) } catch (e) { if (s.startsWith('.') && !/\\.[cm]?[jt]sx?$/.test(s)) return next(s + '.ts', c); throw e } }`
nodeModule.register('data:text/javascript,' + encodeURIComponent(hook), import.meta.url)

const F: typeof import('./formula') = await import('./formula.ts' as string)
const data: typeof import('../../data/drive') = await import('../../data/drive.ts' as string)
const { computeTab, formatValue, parseLiteral, shiftFormula, fromTSV, toTSV, isError } = F

let failed = 0, passed = 0
function eq(name: string, got: unknown, want: unknown) {
  const ok = typeof want === 'number' && typeof got === 'number' ? Math.abs(got - want) < 1e-9 : JSON.stringify(got) === JSON.stringify(want)
  if (ok) passed++
  else { failed++; console.error(`✖ ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`) }
}

// Evaluate formulas typed into a scratch tab.
function calc(cells: Record<string, string>, addr: string, bounds = { rows: 50, cols: 12 }) {
  const c = Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, { v }]))
  return computeTab(c, bounds).get(addr) ?? null
}
const one = (f: string, extra: Record<string, string> = {}) => calc({ ...extra, Z1: f }, 'Z1', { rows: 50, cols: 26 })

// ── Seed sheets ──────────────────────────────────────────────────────────────
const sheet = (id: string) => data.sheets.find(s => s.id === id)!
{
  const t = sheet('sh_ot').tabs[0]
  const v = computeTab(t.cells, t)
  // Hand-computed: hours × rate × 1.5 for each of the 11 people.
  const pay = [[8, 18], [8, 15], [8, 15], [8, 18], [8, 15], [8, 14], [6, 15], [6, 15], [6, 18], [8, 16], [8, 16]].map(([h, r]) => h * r * 1.5)
  const total = pay.reduce((a, b) => a + b, 0)
  eq('sh_ot hand total is 1956', total, 1956)
  eq('sh_ot F14 total OT pay', v.get('F14'), total)
  eq('sh_ot D14 total hours', v.get('D14'), 82)
  eq('sh_ot F16 left in budget', v.get('F16'), 2200 - total)
  eq('sh_ot E17 average rate', v.get('E17'), 175 / 11)
  eq('sh_ot F2 row pay', v.get('F2'), 216)
  eq('sh_ot F14 display', formatValue(v.get('F14')!, 'currency'), 'S$1,956.00')
  eq('sh_ot F16 display', formatValue(v.get('F16')!, 'currency'), 'S$244.00')
  eq('sh_ot E17 display', formatValue(v.get('E17')!, 'currency'), 'S$15.91')
}
{
  const t = sheet('sh_forecast').tabs[0]
  const v = computeTab(t.cells, t)
  eq('forecast E9 week 8 total', v.get('E9'), 1090)
  eq('forecast G9 week 8 utilisation', v.get('G9'), 1.09)
  eq('forecast G9 shows 109.0%', formatValue(v.get('G9')!, 'percent'), '109.0%')
  eq('forecast G8 week 7 is over capacity too', (v.get('G8') as number) > 1, true)
  eq('forecast G7 week 6 is exactly at capacity', v.get('G7'), 1)
  eq('forecast C11 Meridian total', v.get('C11'), 2130)
  eq('forecast E11 total pallets', v.get('E11'), 7575)
  eq('forecast E11 display', formatValue(v.get('E11')!, 'integer'), '7,575')
  eq('forecast E12 average', v.get('E12'), 946.875)
  eq('forecast E13 peak', v.get('E13'), 1090)
  eq('forecast G12 average utilisation', formatValue(v.get('G12')!, 'percent'), '94.7%')
}
{
  const t = sheet('sh_movers').tabs[0]
  const v = computeTab(t.cells, t)
  eq('movers B4 Kranji total', v.get('B4'), 18400)
  eq('movers C4 SwiftMove total', v.get('C4'), 22200)
  eq('movers B8 saving', v.get('B8'), 3800)
  eq('movers B8 display', formatValue(v.get('B8')!, 'currency'), 'S$3,800.00')
  eq('movers B9 display', formatValue(v.get('B9')!, 'percent'), '17.1%')
}

// ── Operators and precedence ─────────────────────────────────────────────────
eq('precedence', one('=1+2*3'), 7)
eq('parentheses', one('=(1+2)*3'), 9)
eq('power is right of unary minus (Excel)', one('=-2^2'), 4)
eq('power', one('=2^3^2'), 64)
eq('unary minus', one('=-A1', { A1: '5' }), -5)
eq('concat', one('="Week "&8'), 'Week 8')
eq('concat number formatting', one('=1/4&""'), '0.25')
eq('comparison =', one('=A1=5', { A1: '5' }), true)
eq('comparison <>', one('=A1<>5', { A1: '5' }), false)
eq('comparison <=', one('=3<=3'), true)
eq('comparison >=', one('=2>=3'), false)
eq('text comparison ignores case', one('="abc"="ABC"'), true)
eq('percent postfix', one('=50%'), 0.5)
eq('booleans', one('=TRUE'), true)
eq('boolean arithmetic', one('=TRUE+1'), 2)
eq('string with quotes', one('="say ""hi"""'), 'say "hi"')
eq('blank cell is 0', one('=A9+1'), 1)
eq('absolute refs', one('=$A$1*2', { A1: '21' }), 42)
eq('typed thousands', one('=A1+1', { A1: '1,200' }), 1201)

// ── Functions ────────────────────────────────────────────────────────────────
const nums = { A1: '1', A2: '2', A3: 'x', A4: '', A5: '7', B1: 'TRUE' }
eq('SUM range skips text', one('=SUM(A1:A5)', nums), 10)
eq('SUM args', one('=SUM(1,2,A1)', nums), 4)
eq('AVERAGE', one('=AVERAGE(A1:A5)', nums), 10 / 3)
eq('AVERAGE of nothing', one('=AVERAGE(C1:C3)'), { error: '#DIV/0!' })
eq('MIN', one('=MIN(A1:A5)', nums), 1)
eq('MAX', one('=MAX(A1:A5,9)', nums), 9)
eq('COUNT', one('=COUNT(A1:A5)', nums), 3)
eq('COUNTA', one('=COUNTA(A1:B1)', nums), 2)
eq('COUNTA skips blanks', one('=COUNTA(A1:A5)', nums), 4)
eq('ROUND', one('=ROUND(2.345,2)'), 2.35)
eq('ROUND half away from zero', one('=ROUND(-2.5)'), -3)
eq('ABS', one('=ABS(-4)'), 4)
eq('IF true', one('=IF(A1>0,"yes","no")', nums), 'yes')
eq('IF false without else', one('=IF(A1>5,"yes")', nums), false)
eq('AND', one('=AND(TRUE,A1>0)', nums), true)
eq('OR', one('=OR(FALSE,A1>5)', nums), false)
eq('CONCAT', one('=CONCAT("A",1,TRUE)'), 'A1TRUE')
eq('CONCAT range', one('=CONCAT(A1:A3)', nums), '12x')
eq('lower-case function names', one('=sum(1,2)'), 3)
eq('nested', one('=ROUND(AVERAGE(A1,A2)*100,0)&"%"', nums), '150%')

// ── Errors ───────────────────────────────────────────────────────────────────
eq('#DIV/0!', one('=1/0'), { error: '#DIV/0!' })
eq('#REF! out of bounds', calc({ A1: '=Z99' }, 'A1', { rows: 10, cols: 5 }), { error: '#REF!' })
eq('#REF! range', calc({ A1: '=SUM(A2:A20)' }, 'A1', { rows: 10, cols: 5 }), { error: '#REF!' })
eq('#NAME? unknown function', one('=VLOOKUP(1)'), { error: '#NAME?' })
eq('#NAME? bare word', one('=hello'), { error: '#NAME?' })
eq('#VALUE! text maths', one('="abc"+1'), { error: '#VALUE!' })
eq('#VALUE! from cell', one('=A3*2', nums), { error: '#VALUE!' })
eq('#ERROR! syntax', one('=1+'), { error: '#ERROR!' })
eq('#ERROR! unclosed', one('=SUM(1,2'), { error: '#ERROR!' })
eq('errors propagate', one('=A1+1', { A1: '=1/0' }), { error: '#DIV/0!' })
eq('SUM propagates errors', one('=SUM(A1:A2)', { A1: '=1/0', A2: '1' }), { error: '#DIV/0!' })
eq('self reference', calc({ A1: '=A1+1' }, 'A1'), { error: '#CYCLE!' })
{
  const c = { A1: '=B1+1', B1: '=C1*2', C1: '=A1', D1: '=A1+5', E1: '7' }
  eq('cycle A1', calc(c, 'A1'), { error: '#CYCLE!' })
  eq('cycle B1', calc(c, 'B1'), { error: '#CYCLE!' })
  eq('cycle C1', calc(c, 'C1'), { error: '#CYCLE!' })
  eq('depends on a cycle', calc(c, 'D1'), { error: '#CYCLE!' })
  eq('unrelated cell is fine', calc(c, 'E1'), 7)
  eq('cycle via range', calc({ A1: '=SUM(A1:A3)' }, 'A1'), { error: '#CYCLE!' })
}
eq('isError', isError({ error: '#REF!' }), true)

// ── Literals and display ─────────────────────────────────────────────────────
eq('literal number', parseLiteral('18400'), { value: 18400 })
eq('literal currency', parseLiteral('S$1,234.50'), { value: 1234.5, fmt: 'currency' })
eq('literal percent', parseLiteral('12.5%'), { value: 0.125, fmt: 'percent' })
eq('literal text with number', parseLiteral('1,000 pallets'), { value: '1,000 pallets' })
eq('literal boolean', parseLiteral('true'), { value: true })
eq('currency', formatValue(1234, 'currency'), 'S$1,234.00')
eq('negative currency', formatValue(-5.5, 'currency'), '-S$5.50')
eq('percent', formatValue(0.96, 'percent'), '96.0%')
eq('integer', formatValue(1234567.4, 'integer'), '1,234,567')
eq('number up to 2 decimals', formatValue(1234.5678, 'number'), '1,234.57')
eq('number drops trailing zeros', formatValue(3, 'number'), '3')
eq('automatic', formatValue(1 / 3), '0.3333333333')
eq('automatic float noise', formatValue(0.1 + 0.2), '0.3')
eq('error display', formatValue({ error: '#CYCLE!' }), '#CYCLE!')
eq('text format shows formula', computeTab({ A1: { v: '=1+1', fmt: 'text' } }, { rows: 5, cols: 5 }).get('A1'), '=1+1')

// ── Editing helpers ──────────────────────────────────────────────────────────
eq('shift relative', shiftFormula('=A1+$B$2+C$3+$D4', 1, 1), '=B2+$B$2+D$3+$D5')
eq('shift keeps strings', shiftFormula('="A1"&A1', 2, 0), '="A1"&A3')
eq('shift keeps functions', shiftFormula('=SUM(A1:A3)', 0, 1), '=SUM(B1:B3)')
eq('shift off grid', shiftFormula('=A1', -1, 0), '=#REF!')
eq('TSV round trip', fromTSV(toTSV([['a', 'b\tc'], ['1', 'say "x"']])), [['a', 'b\tc'], ['1', 'say "x"']])
eq('TSV from a spreadsheet', fromTSV('1\t2\r\n3\t4\r\n'), [['1', '2'], ['3', '4']])

// ── Ask about this sheet (answers computed from the cells) ──────────────────
{
  const A: typeof import('./ask') = await import('./ask.ts' as string)
  const ans = (id: string, q: string) => { const s = sheet(id); return A.answerQuestion(s, s.tabs[0], q) }
  const ot = ans('sh_ot', 'What is the total OT pay and is it within budget?')
  eq('ask OT total', /S\$1,956\.00/.test(ot.text) && /S\$244\.00 left/.test(ot.text), true)
  eq('ask OT refs', ot.refs.map(r => r.label), ['F2:F12', 'F14', 'F15'])
  eq('ask OT most', ans('sh_ot', 'Who earns the most OT?').text, 'Raj Kumar and Tan Boon Huat have the highest OT pay (1.5×): S$216.00.')
  eq('ask OT cold room hours', /total for Hours for Cold room is 26/.test(ans('sh_ot', 'How many hours in the cold room?').text), true)
  const fc = ans('sh_forecast', 'Which weeks go over capacity?')
  eq('ask forecast over capacity', /Week 7 .*1,040.*Week 8 .*1,090 pallets \(109\.0%\)/.test(fc.text), true)
  eq('ask forecast refs', fc.refs.map(r => r.label), ['A8:G8', 'A9:G9'])
  eq('ask movers saving', /save S\$3,800\.00 \(17\.1%\)/.test(ans('sh_movers', 'How much do we save with Kranji?').text), true)
  eq('ask unknown column', ans('sh_movers', 'What is the weather?').ok, false)
  const ot0 = sheet('sh_ot').tabs[0]
  const cells = { ...ot0.cells }; delete cells.F14
  const sug = A.suggestFormula({ ...ot0, cells }, { r: 13, c: 5 })
  eq('suggest SUM under OT pay', sug?.formula, '=SUM(F2:F12)')
  eq('suggest preview', sug?.preview, 'S$1,956.00')
  eq('no suggestion for a filled cell', A.suggestFormula(ot0, { r: 13, c: 5 }), null)
  const fcTab = sheet('sh_forecast').tabs[0]
  const fcCells = { ...fcTab.cells }; delete fcCells.C12
  eq('suggest AVERAGE from row label', A.suggestFormula({ ...fcTab, cells: fcCells }, { r: 11, c: 2 })?.formula, '=AVERAGE(C2:C9)')
}

console.log(`${passed} passed, ${failed} failed`)
if (failed) (globalThis as any).process.exit(1)
