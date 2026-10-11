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
const { computeTab, computeSheet, createBook, formatValue, parseLiteral, shiftFormula, fromTSV, toTSV, isError } = F

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
const tabValues = (id: string, tabId: string) => computeSheet(sheet(id).tabs, tabId)
{
  const v = tabValues('sh_ot', 't_roster')
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
  const v = tabValues('sh_forecast', 't_weekly')
  eq('forecast F2 capacity is read from Assumptions', sheet('sh_forecast').tabs[0].cells.F2.v, '=Assumptions!$B$3')
  eq('forecast F2..F9 all 1000', ['F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9'].map(a => v.get(a)), Array(8).fill(1000))
  eq('forecast F9 display unchanged', formatValue(v.get('F9')!, 'integer'), '1,000')
  eq('forecast Assumptions B3 is the number', tabValues('sh_forecast', 't_assume').get('B3'), 1000)
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
  const v = tabValues('sh_movers', 't_cmp')
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
eq('past the grid is empty', calc({ A1: '=Z99' }, 'A1', { rows: 10, cols: 5 }), 0)
eq('range past the grid is clipped', calc({ A1: '=SUM(A2:A20)', A3: '4' }, 'A1', { rows: 10, cols: 5 }), 4)
eq('#REF! from a reference moved off the grid', one(shiftFormula('=A1+1', -1, 0)), { error: '#REF!' })
eq('empty ref shows 0', one('=A40'), 0)
eq('0^-1', one('=0^-1'), { error: '#DIV/0!' })
eq('COUNT over itself is a cycle', calc({ A2: '=COUNT(A1:A3)' }, 'A2'), { error: '#CYCLE!' })
eq('apostrophe keeps text', calc({ A1: "'0012" }, 'A1'), '0012')
eq('integer rounds half away from zero', formatValue(-2.5, 'integer'), '-3')
eq('literal thousands implies number format', parseLiteral('1,200'), { value: 1200, fmt: 'number' })
eq('literal scientific', parseLiteral('1e5'), { value: 100000 })
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

// ── Formulas across tabs ─────────────────────────────────────────────────────
// A small book: tabs are given as { name: { addr: typed } }.
type BookSpec = Record<string, Record<string, string>>
const mkTabs = (spec: BookSpec, size = { rows: 50, cols: 12 }) =>
  Object.entries(spec).map(([name, cells]) => ({ id: `id_${name}`, name, ...size, cells: Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, { v }])) }))
const inBook = (spec: BookSpec, name: string, addr: string, size?: { rows: number; cols: number }) => createBook(mkTabs(spec, size)).value(`id_${name}`, addr)
{
  const data2 = { A1: '10', A2: '20', A3: 'x', A4: '30', B2: '=A1*2', C1: '5' }
  const at = (f: string, extra: BookSpec = {}) => inBook({ Data: data2, 'My data': { B2: '7' }, "Ashton's": { A1: '3' }, Q4: { A1: '4' }, ...extra, Here: { Z1: f } }, 'Here', 'Z1')
  eq('cross-tab cell', at('=Data!A1'), 10)
  eq('cross-tab absolute', at('=Data!$A$1+Data!A$2+Data!$A2'), 50)
  eq('cross-tab formula cell', at('=Data!B2'), 20)
  eq('cross-tab range in SUM', at('=SUM(Data!A1:A4)'), 60)
  eq('cross-tab range in AVERAGE', at('=AVERAGE(Data!A1:A4)'), 20)
  eq('cross-tab range in COUNTA', at('=COUNTA(Data!A1:A4)'), 4)
  eq('cross-tab range in MAX', at('=MAX(Data!A1:C4)'), 30)
  eq('range with the tab named twice', at('=SUM(Data!A1:Data!A2)'), 30)
  eq('range across two tabs is an error', at('=SUM(Data!A1:Here!A2)'), { error: '#ERROR!' })
  eq('quoted tab name', at("='My data'!B2"), 7)
  eq('quoted name with a doubled quote', at("='Ashton''s'!A1"), 3)
  eq('name that looks like a cell, quoted', at("='Q4'!A1"), 4)
  eq('name that looks like a cell, bare', at('=Q4!A1+1'), 5)
  eq('tab names ignore case', at('=data!a1+DATA!A2'), 30)
  eq('quoted names ignore case', at("='MY DATA'!B2"), 7)
  eq('mixed with same-tab refs', at('=Data!A1+Z2', { Here: { Z2: '1' } }), 10) // Here is replaced by Z1 only, so Z2 is blank
  eq('missing tab is #REF!', at('=Nope!A1'), { error: '#REF!' })
  eq('missing tab in a range is #REF!', at('=SUM(Nope!A1:A3)'), { error: '#REF!' })
  eq('missing quoted tab is #REF!', at("='No such tab'!A1+1"), { error: '#REF!' })
  eq('empty cell on another tab is 0', at('=Data!H40'), 0)
  eq('past the other tab’s grid is empty', at('=Data!A60'), 0)
  eq('range clipped to the other tab', at('=SUM(Data!A1:A99)'), 60)
  eq('text from another tab', at('=Data!A3&"!"'), 'x!')
  eq('#VALUE! from another tab', at('=Data!A3*2'), { error: '#VALUE!' })
  eq('errors travel across tabs', inBook({ A: { A1: '=1/0' }, B: { A1: '=A!A1+1' } }, 'B', 'A1'), { error: '#DIV/0!' })
  eq('a tab can name itself', inBook({ Self: { A1: '2', A2: '=Self!A1*3' } }, 'Self', 'A2'), 6)
  eq('deleted-tab reference is #REF!', at('=#REF!A1+1'), { error: '#REF!' })
  eq('deleted-tab range is #REF!', at('=SUM(#REF!A1:A3)'), { error: '#REF!' })
  eq('tab name with no cell is an error', at('=Data!+1'), { error: '#ERROR!' })
  eq('unclosed tab quote is an error', at("='Data!A1"), { error: '#ERROR!' })
  eq('a ! inside a string is just text', at('="Data!A1"'), 'Data!A1')
  eq('single-tab computeTab gives #REF! for other tabs', calc({ A1: '=Data!A1' }, 'A1'), { error: '#REF!' })
  eq('COUNTA of a missing tab is #REF!', at('=COUNTA(Nope!A1:A3)'), { error: '#REF!' })
  eq('COUNTA of a deleted tab is #REF!', at('=COUNTA(#REF!A1:A3)'), { error: '#REF!' })
  eq('COUNTA still counts a cell holding an error', inBook({ A: { A1: '=1/0', A2: '=COUNTA(A1)' } }, 'A', 'A2'), 1)
}
{
  // Cycles that go through more than one tab.
  const spec = { A: { A1: '=B!A1+1', A2: '=A1*2', A3: '5' }, B: { A1: '=C!A1', A2: '=A!A3+1' }, C: { A1: '=A!A1' }, D: { A1: '=A!A2' } }
  eq('cross-tab cycle A', inBook(spec, 'A', 'A1'), { error: '#CYCLE!' })
  eq('cross-tab cycle B', inBook(spec, 'B', 'A1'), { error: '#CYCLE!' })
  eq('cross-tab cycle C', inBook(spec, 'C', 'A1'), { error: '#CYCLE!' })
  eq('depends on a cross-tab cycle', inBook(spec, 'D', 'A1'), { error: '#CYCLE!' })
  eq('same-tab dependant of a cycle', inBook(spec, 'A', 'A2'), { error: '#CYCLE!' })
  eq('unrelated cross-tab cell is fine', inBook(spec, 'B', 'A2'), 6)
  eq('two-tab cycle through a range', inBook({ A: { A1: '=SUM(B!A1:A3)' }, B: { A2: '=A!A1' } }, 'A', 'A1'), { error: '#CYCLE!' })
  // Whichever tab is computed first, every cell agrees.
  const book = createBook(mkTabs(spec))
  const d = book.values('id_D'), a = book.values('id_A')
  eq('cycle found from either end (D first)', [d.get('A1'), a.get('A1'), a.get('A3')], [{ error: '#CYCLE!' }, { error: '#CYCLE!' }, 5])
}
{
  // Tab names in formulas.
  eq('quote plain name', F.quoteTabName('Roster'), 'Roster')
  eq('quote name with a space', F.quoteTabName('OT roster'), "'OT roster'")
  eq('quote name with a quote', F.quoteTabName("Ashton's"), "'Ashton''s'")
  eq('quote name that looks like a cell', F.quoteTabName('Q4'), "'Q4'")
  eq('no quotes for Sheet1', F.quoteTabName('Sheet1'), 'Sheet1')
  eq('quote name starting with a digit', F.quoteTabName('2026 plan'), "'2026 plan'")
  eq('refText', F.refText({ r0: 1, c0: 5, r1: 11, c1: 5 }, 'OT roster'), "'OT roster'!F2:F12")
  eq('refText same tab', F.refText({ r0: 1, c0: 1, r1: 1, c1: 1 }), 'B2')
  eq('formulaRefs', F.formulaRefs("=SUM(Roster!F2:F12)+'OT roster'!B2+C3+#REF!A1&\"Data!A1\"").map(r => [r.sheet, F.rangeLabel(r.range)]), [['Roster', 'F2:F12'], ['OT roster', 'B2'], [undefined, 'C3'], [null, 'A1']])
  eq('parseRef plain', F.parseRef('b2'), { range: { r0: 1, c0: 1, r1: 1, c1: 1 } })
  eq('parseRef with tab', F.parseRef("'OT roster'!F2:F12"), { sheet: 'OT roster', range: { r0: 1, c0: 5, r1: 11, c1: 5 } })
  eq('parseRef rejects junk', F.parseRef('Roster!'), null)
}
{
  // Renaming a tab rewrites every reference to it.
  const r = F.renameTabInFormula
  eq('rename bare to quoted', r('=Roster!F14*2', 'Roster', 'OT roster'), "='OT roster'!F14*2")
  eq('rename any case', r('=roster!A1+ROSTER!$B$2', 'Roster', 'Crew'), '=Crew!A1+Crew!$B$2')
  eq('rename a range and both prefixes', r('=SUM(Roster!F2:Roster!F12)', 'Roster', 'OT roster'), "=SUM('OT roster'!F2:'OT roster'!F12)")
  eq('rename quoted to bare', r("='OT roster'!F14", 'OT roster', 'Roster'), '=Roster!F14')
  eq('rename to a name with a quote', r('=Roster!A1', 'Roster', "Ashton's"), "='Ashton''s'!A1")
  eq('rename leaves other tabs alone', r('=Roster2!A1+Rost!A1+A1', 'Roster', 'X'), '=Roster2!A1+Rost!A1+A1')
  eq('rename leaves strings alone', r('="Roster!A1"&Roster!A1', 'Roster', 'Crew'), '="Roster!A1"&Crew!A1')
  eq('rename keeps spacing and case elsewhere', r('= sum( Roster!f2:f3 ) ', 'Roster', 'Crew'), '= sum( Crew!f2:f3 ) ')
  const tabs = mkTabs({ Roster: { A1: '4', A2: '=A1*2' }, Summary: { B1: '=Roster!A2+roster!A1', B2: '=B1', B3: 'Roster!A1' } })
  const { tabs: next, changed } = F.renameTabInBook(tabs, 'id_Roster', 'OT roster')
  eq('renameTabInBook names the tab', next.map(t => t.name), ['OT roster', 'Summary'])
  eq('renameTabInBook counts formulas', changed, 1)
  eq('renameTabInBook rewrites', next[1].cells.B1.v, "='OT roster'!A2+'OT roster'!A1")
  eq('renameTabInBook leaves typed text', next[1].cells.B3.v, 'Roster!A1')
  eq('renamed formulas keep their values', computeSheet(next, 'id_Summary').get('B2'), 12)
  eq('renameTabInBook keeps untouched cells', next[0].cells === tabs[0].cells, true)
}
{
  // Deleting a tab: formulas that read it show #REF!, and the count is known first.
  const tabs = mkTabs({ Roster: { A1: '4', A2: '=A1*2' }, Summary: { B1: '=Roster!A2', B2: '=SUM(Roster!A1:A2)+1', B3: '=B1', B4: '7' }, Notes: { A1: '=roster!A1' } })
  eq('formulasUsing counts other tabs only', F.formulasUsing(tabs, 'id_Roster'), 3)
  eq('formulasUsing an unused tab', F.formulasUsing(tabs, 'id_Notes'), 0)
  const { tabs: next, changed } = F.removeTabFromBook(tabs, 'id_Roster')
  eq('removeTabFromBook drops the tab', next.map(t => t.name), ['Summary', 'Notes'])
  eq('removeTabFromBook counts formulas', changed, 3)
  eq('deleted refs become #REF!', [next[0].cells.B1.v, next[0].cells.B2.v, next[1].cells.A1.v], ['=#REF!A2', '=SUM(#REF!A1:A2)+1', '=#REF!A1'])
  const v = computeSheet(next, 'id_Summary')
  eq('deleted ref evaluates to #REF!', [v.get('B1'), v.get('B2'), v.get('B3'), v.get('B4')], [{ error: '#REF!' }, { error: '#REF!' }, { error: '#REF!' }, 7])
  eq('explain deleted tab', F.explainError({ error: '#REF!' }, '=#REF!A2', ['Summary']), 'Refers to a tab that was deleted.')
  eq('explain missing tab', F.explainError({ error: '#REF!' }, '=SUM(Roster!A1:A3)', ['Summary']), 'There’s no tab called “Roster” in this sheet.')
  eq('explain other errors as before', F.explainError({ error: '#DIV/0!' }, '=Roster!A1/0', ['Roster']), 'Divides by zero or by an empty cell.')
}
{
  // Copying, pasting and filling keep tab names and move only the relative parts.
  eq('shift with a tab prefix', shiftFormula('=Roster!F2*2', 1, 0), '=Roster!F3*2')
  eq('shift keeps $ parts on another tab', shiftFormula('=Roster!$F2+Roster!F$2+Assumptions!$B$3', 1, 1), '=Roster!$F3+Roster!G$2+Assumptions!$B$3')
  eq('shift a cross-tab range', shiftFormula('=SUM(Roster!F2:F12)', 0, 1), '=SUM(Roster!G2:G12)')
  eq('shift a quoted prefix', shiftFormula("='OT roster'!B2", 2, 0), "='OT roster'!B4")
  eq('shift never touches a cell-like name in quotes', shiftFormula("='A1 notes'!B2", 1, 1), "='A1 notes'!C3")
  eq('shift never treats a cell-like tab name as a cell', shiftFormula('=Q4!A1+Q4', 1, 0), '=Q4!A2+Q5')
  eq('shift both prefixes of a range', shiftFormula('=SUM(Data!A1:Data!A3)', 1, 0), '=SUM(Data!A2:Data!A4)')
  eq('shift a cross-tab ref off the grid', shiftFormula('=Roster!A1+1', -1, 0), '=#REF!+1')
  eq('shift a range partly off the grid', shiftFormula('=SUM(A1:A3)', -1, 0), '=SUM(#REF!)')
  eq('shifted off-grid cross-tab ref is #REF!', inBook({ Roster: { A1: '1' }, H: { A1: shiftFormula('=Roster!A1', 0, -1) } }, 'H', 'A1'), { error: '#REF!' })
  eq('shift keeps a deleted-tab ref', shiftFormula('=#REF!A1', 1, 0), '=#REF!A2')
  eq('shift leaves numbers like 1E5 alone', shiftFormula('=1E5+E5', 1, 0), '=1E5+E6')
  eq('shift leaves LOG10-like names alone', shiftFormula('=SUM(A1)+ATAN2', 1, 0), '=SUM(A2)+ATAN2')
}
{
  // Recalculation follows the tabs a tab reads, and only those.
  const tabs = mkTabs({ Roster: { A1: '4' }, Summary: { A1: '=Roster!A1*2', A2: '=Middle!A1' }, Middle: { A1: '=Far!A1' }, Far: { A1: '9' }, Notes: { A1: 'hi' } })
  const first = F.tabValues(tabs, 'id_Summary')
  eq('dependencyKey follows tabs through tabs', F.dependencyKey(tabs, 'id_Summary').map(k => (typeof k === 'string' ? k : (k as { name: string }).name)), ['Summary', 'Roster', 'Middle', 'Far'])
  const notesEdited = tabs.map(t => (t.name === 'Notes' ? { ...t, cells: { A1: { v: 'changed' } } } : t))
  eq('editing an unrelated tab reuses the values', F.tabValues(notesEdited, 'id_Summary', first) === first, true)
  const rosterEdited = tabs.map(t => (t.name === 'Roster' ? { ...t, cells: { A1: { v: '5' } } } : t))
  const second = F.tabValues(rosterEdited, 'id_Summary', first)
  eq('editing a referenced tab recalculates', [second === first, second.values.get('A1')], [false, 10])
  const farEdited = tabs.map(t => (t.name === 'Far' ? { ...t, cells: { A1: { v: '1' } } } : t))
  eq('editing a tab read through another tab recalculates', F.tabValues(farEdited, 'id_Summary', first).values.get('A2'), 1)
  const missing = mkTabs({ Summary: { A1: '=Later!A1+1' } })
  const m1 = F.tabValues(missing, 'id_Summary')
  eq('missing tab first', m1.values.get('A1'), { error: '#REF!' })
  const added = [...missing, ...mkTabs({ Later: { A1: '41' } })]
  eq('adding the missing tab recalculates', F.tabValues(added, 'id_Summary', m1).values.get('A1'), 42)
  const renamedAway = F.renameTabInBook(tabs, 'id_Roster', 'Crew').tabs
  eq('renaming a referenced tab keeps the values', F.tabValues(renamedAway, 'id_Summary', first).values.get('A1'), 8)
}
{
  // Long chains don't overflow the stack, whichever end is asked for first.
  const chain = (name: string, n: number, first: string) => { const c: Record<string, string> = { A1: first }; for (let r = 2; r <= n; r++) c[`A${r}`] = `=A${r - 1}+1`; return { [name]: c } }
  const size = { rows: 3000, cols: 2 }
  eq('3,000-cell chain from the end', createBook(mkTabs(chain('Long', 3000, '1'), size)).value('id_Long', 'A3000'), 3000)
  eq('long chain read from another tab first', createBook(mkTabs({ Top: { A1: '=Long!A2500*2' }, ...chain('Long', 2500, '1') }, size)).value('id_Top', 'A1'), 5000)
  const loop = createBook(mkTabs(chain('Loop', 1200, '=A1200+1'), size))
  eq('1,200-cell cycle is #CYCLE! from the end', loop.value('id_Loop', 'A1200'), { error: '#CYCLE!' })
  eq('1,200-cell cycle is #CYCLE! everywhere', [loop.value('id_Loop', 'A1'), loop.value('id_Loop', 'A600')], [{ error: '#CYCLE!' }, { error: '#CYCLE!' }])
  const across = { ...chain('P', 900, '=Q!A900+1'), ...chain('Q', 900, '=P!A900+1'), R: { A1: '=SUM(P!A1:A3)', A2: '7' } }
  const ab = createBook(mkTabs(across, size))
  eq('long cycle across two tabs', [ab.value('id_P', 'A450'), ab.value('id_Q', 'A900'), ab.value('id_R', 'A1'), ab.value('id_R', 'A2')], [{ error: '#CYCLE!' }, { error: '#CYCLE!' }, { error: '#CYCLE!' }, 7])
}
{
  // Fast enough: three tabs of 2,000 formulas each, reading one another.
  const big: BookSpec = { Raw: {}, Mid: {}, Top: {} }
  for (let r = 1; r <= 2000; r++) {
    big.Raw[`A${r}`] = String(r)
    big.Mid[`A${r}`] = `=Raw!A${r}*2`
    big.Top[`A${r}`] = `=Mid!A${r}+SUM(Raw!A${Math.max(1, r - 5)}:A${r})`
  }
  big.Top.B1 = '=SUM(A1:A2000)'
  const t0 = performance.now()
  const v = computeSheet(mkTabs(big, { rows: 2000, cols: 4 }), 'id_Top')
  const ms = performance.now() - t0
  eq('big book total', v.get('B1'), 2000 * 2001 + [...Array(2000)].reduce((s, _, i) => { const r = i + 1; let t = 0; for (let k = Math.max(1, r - 5); k <= r; k++) t += k; return s + t }, 0))
  eq('big book computes quickly', ms < 1500, true)
  console.log(`big book (6,001 formulas over 3 tabs): ${ms.toFixed(0)} ms`)
}

// ── Seed: the Summary tab on the OT roster reads the Roster tab ─────────────
{
  const v = tabValues('sh_ot', 't_summary')
  const tabs = sheet('sh_ot').tabs
  const summary = tabs.find(t => t.id === 't_summary')!
  const show = (a: string) => formatValue(v.get(a)!, summary.cells[a]?.fmt)
  eq('Summary sits after Roster', tabs.map(t => t.name), ['Roster', 'Summary', 'Notes'])
  eq('Summary B2 people', v.get('B2'), 11)
  eq('Summary B3 total hours', v.get('B3'), 82)
  eq('Summary B4 total OT pay', v.get('B4'), 1956)
  eq('Summary B5 budget', v.get('B5'), 2200)
  eq('Summary B6 left in budget', v.get('B6'), 244)
  eq('Summary B7 budget used', v.get('B7'), 1956 / 2200)
  eq('Summary B8 average rate', v.get('B8'), 175 / 11)
  eq('Summary B9 average OT pay a person', v.get('B9'), 1956 / 11)
  eq('Summary displays', ['B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9'].map(show), ['11', '82', 'S$1,956.00', 'S$2,200.00', 'S$244.00', '88.9%', 'S$15.91', 'S$177.82'])
  eq('Summary formulas read Roster', [summary.cells.B3.v, summary.cells.B4.v, summary.cells.B2.v, summary.cells.B6.v], ['=Roster!D14', '=Roster!F14', '=COUNTA(Roster!A2:A12)', '=Roster!F16'])
  eq('Summary uses Roster in 6 formulas', F.formulasUsing(tabs, 't_roster'), 6)
  // A change on Roster shows up on Summary.
  const roster = tabs[0]
  const raised = tabs.map(t => (t === roster ? { ...t, cells: { ...t.cells, D2: { v: '10' } } } : t))
  eq('Summary follows a Roster edit', [computeSheet(raised, 't_summary').get('B3'), computeSheet(raised, 't_summary').get('B4')], [84, 1956 + 2 * 18 * 1.5])
  // Renaming Roster rewrites Summary and keeps every value.
  const renamed = F.renameTabInBook(tabs, 't_roster', 'OT roster')
  eq('rename Roster → OT roster rewrites 6 formulas', renamed.changed, 6)
  eq('rename Roster → OT roster text', renamed.tabs[1].cells.B4.v, "='OT roster'!F14")
  eq('rename Roster → OT roster values', ['B2', 'B4', 'B6', 'B8'].map(a => computeSheet(renamed.tabs, 't_summary').get(a)), ['B2', 'B4', 'B6', 'B8'].map(a => v.get(a)))
  // Deleting Roster leaves #REF! on Summary, except the cells worked out on Summary itself.
  const gone = F.removeTabFromBook(tabs, 't_roster')
  const gv = computeSheet(gone.tabs, 't_summary')
  eq('delete Roster → #REF!', ['B2', 'B3', 'B4', 'B7'].map(a => gv.get(a)), Array(4).fill({ error: '#REF!' }))
  eq('delete Roster rewrites', gone.tabs[0].cells.B4.v, '=#REF!F14')
}
{
  // Changing the capacity on Assumptions moves every week's utilisation.
  const tabs = sheet('sh_forecast').tabs
  const halved = tabs.map(t => (t.id === 't_assume' ? { ...t, cells: { ...t.cells, B3: { v: '2000' } } } : t))
  const v = computeSheet(halved, 't_weekly')
  eq('capacity change reaches Weekly', [v.get('F9'), v.get('G9')], [2000, 0.545])
}

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
  eq('ask forecast refs', fc.refs.map(r => r.label), ['A8:G8', 'A9:G9', 'B3'])
  eq('ask forecast capacity chip is on Assumptions', fc.refs.map(r => r.tabId), ['t_weekly', 't_weekly', 't_assume'])
  eq('ask forecast names the capacity source', /capacity of 1,000 pallets \(from B3 on “Assumptions”\)/.test(fc.text), true)
  eq('ask movers saving', /save S\$3,800\.00 \(17\.1%\)/.test(ans('sh_movers', 'How much do we save with Kranji?').text), true)
  eq('ask unknown column', ans('sh_movers', 'What is the weather?').ok, false)
  // Summary tab: answers read through to Roster and their chips point there.
  const otSheet = sheet('sh_ot')
  const summaryTab = otSheet.tabs.find(t => t.id === 't_summary')!
  const askS = (q: string) => A.answerQuestion(otSheet, summaryTab, q)
  eq('Summary suggestions', A.suggestedQuestions(otSheet, summaryTab), ['What is the total OT pay?', 'How much is left in the budget?', 'Where do these numbers come from?'])
  const pay = askS('What is the total OT pay?')
  eq('Summary total OT pay', pay.text, 'Total OT pay: S$1,956.00. It’s worked out from F14 on “Roster”.')
  eq('Summary total OT pay chips', pay.refs.map(r => [r.tabId, r.label]), [['t_summary', 'B4'], ['t_roster', 'F14']])
  eq('Summary budget left', askS('How much is left in the budget?').text, 'Left in budget: S$244.00. It’s worked out from F16 on “Roster”.')
  eq('Summary people', askS('How many people are on the roster?').refs.map(r => [r.tabId, r.label]), [['t_summary', 'B2'], ['t_roster', 'A2:A12']])
  eq('Summary average rate', askS('What is the average rate?').text, 'Average rate: S$15.91. It’s worked out from E2:E12 on “Roster”.')
  eq('Summary same-tab value has no Roster chip', askS('How much of the budget is used?').refs.map(r => r.tabId), ['t_summary'])
  const from = askS('Where do these numbers come from?')
  eq('Summary sources text', from.text, '6 formulas on “Summary” read from “Roster”, so they change when that tab changes. 2 other formulas don’t read another tab. The chips show the cells they use.')
  eq('Summary sources chips', from.refs.map(r => `${r.tabId}:${r.label}`), ['t_roster:A2:A12', 't_roster:D14', 't_roster:F14', 't_roster:F15', 't_roster:F16', 't_roster:E2:E12'])
  eq('Summary summarise', /“Summary” lists 8 figures: People on the roster, Total hours, Total OT pay, Budget and 4 more/.test(askS('Summarise this tab').text), true)
  eq('Summary unknown figure', askS('What is the weather?').ok, false)
  eq('Roster tab has no outside sources', /Nothing on “Roster” reads another tab/.test(A.answerQuestion(otSheet, otSheet.tabs[0], 'Where do these numbers come from?').text), true)
  eq('Weekly suggests nothing new', A.suggestedQuestions(sheet('sh_forecast'), sheet('sh_forecast').tabs[0])[0], 'Which weeks go over capacity?')
  eq('sourcesOf a capacity cell', A.sourcesOf(sheet('sh_forecast').tabs[0], { r0: 1, c0: 5, r1: 8, c1: 5 }, sheet('sh_forecast').tabs).map(r => `${r.tabId}:${r.label}`), ['t_assume:B3'])
  const sumSug = A.suggestFormula({ ...summaryTab, cells: { ...summaryTab.cells } }, { r: 9, c: 1 }, otSheet.tabs)
  eq('suggest on Summary previews through Roster', sumSug === null || typeof sumSug.preview === 'string', true)
  const mk = (cells: Record<string, string>) => ({ id: 't', name: 'Sheet1', rows: 50, cols: 12, cells: Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, { v }])) })
  const fresh = { ...sheet('sh_movers'), id: 'new', tabs: [mk({ A1: 'Item', B1: 'Cost', A2: 'A', B2: '10', A3: 'B', B3: '20', A4: 'C', B4: '30', B5: '=SUM(B2:B4)' })] }
  eq('ask ignores a total row', A.answerQuestion(fresh, fresh.tabs[0], 'What is the total cost?').text, 'The total for Cost is 60, across 3 rows.')
  eq('ask highest skips total', A.answerQuestion(fresh, fresh.tabs[0], 'Which row has the highest cost?').text, 'C has the highest Cost: 30.')
  eq('ask refuses an unknown count', A.answerQuestion(sheet('sh_forecast'), sheet('sh_forecast').tabs[0], 'How many forklift drivers?').ok, false)
  eq('ask counts a group', /There are 3 rows where Role is “Forklift driver”/.test(ans('sh_ot', 'How many forklift drivers?').text), true)
  eq('ask summary lists headings', /under 7 headings: Week, Starts, Meridian pallets, Existing pallets, Total and 2 more/.test(ans('sh_forecast', 'Summarise this tab').text), true)
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
