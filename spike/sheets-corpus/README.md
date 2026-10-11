# Sheets spike corpus

27 public Excel workbooks for the Sheets spike (build plan step C3.7, PRD Appendix B.7 part b). They are used to test the formula engine (IronCalc, behind the adapter, with HyperFormula and Univer as fallbacks) and Excel import and export.

## Why public files

The PRD asks the spike to test "20–30 of the org's most-used workbooks" (Q16). You chose to use openly licensed public workbooks instead of the company's own files. So this corpus stands in for the org's files: it holds the same kinds of workbook (rosters, timesheets, trackers, forecasts, quotes, invoices, cash-flow models) plus test files that pin down exact Excel behaviour.

Every file:

- is a byte-identical copy of a file in a public GitHub repository, taken at a fixed commit (sha256 in `manifest.json`);
- is under a licence on the agreed list, or is a US federal work in the public domain. Each one passed a licence and provenance check (not a copied vendor template, no all-rights-reserved terms);
- was last saved by Excel, so its formula cells hold the values Excel calculated. Those saved values are the answer key.

Totals: 12.3 MB, 332,660 formulas, of which 332,627 carry an Excel-saved value, and about 713,000 non-empty cells.

## How the spike uses it

1. **Formula check.** Load each file through the engine adapter, recalculate, and compare every formula cell with the value Excel saved: numbers within a small tolerance, text exactly, errors by type. Report each cell as *match*, *mismatch*, *kept as fixed value* (outside SHEET-08 or otherwise not computed under SHEET-31) or *no saved value*. Run the same files through HyperFormula and Univer so the engines can be compared. The O files are the main test; the E and P files show how real models behave.
2. **Round trip.** Import each file, export it to XLSX, import the export again, and compare. List what is kept, kept as values and dropped (SHEET-31, SHEET-32), with cell addresses. The F and X files each target one structure: tables, conditional formatting, number formats, threaded comments, hidden sheets, links, macros.
3. **Performance.** P01 first (71,000 cells, every formula computable), then P02 (209,000 cells, 83% of the P0 cap) and P03 (388,000 cells and 5.1 MB, over the P0 cap, so it must stay a file with a message). Measure open time, first calculation and recalculation after an edit (p50/p95). Generated workbooks fill the rest (see Gaps).
4. **Edge and safety cases.** Very hidden sheets (X01), every kind of link (X02), a macro workbook whose results come from a VBA function (X03). Macros must never run.

Before comparing, pin TODAY/NOW to each file's saved time in Asia/Singapore, or skip those cells (E02, E06, E10, F03). Check RAND and RANDBETWEEN (F06) for type and range only.

## The files

Ids: O = oracle (function tests), F = feature, E = everyday, P = performance, X = edge. F05, E03 and E04 failed the licence check and were dropped (see the end).

| Id | What it is | Sheets | Formulas | Key features | Licence |
|---|---|---:|---:|---|---|
| O01 | Apache POI formula matrix, one row per function | 4 | 1,295 | 75 SHEET-08 functions plus 55 others; INDIRECT, OFFSET | Apache-2.0 |
| O02 | LibreOffice dynamic-array fixture | 3 | 639 | 77 dynamic-array cells, CSE arrays, `@` and `#` operators, LET | MPL-2.0 |
| O03 | LibreOffice Excel 2010 functions, self-checking | 2 | 517 | NETWORKDAYS.INTL, WORKDAY.INTL, RANK.EQ, STDEV.S, AGGREGATE | MPL-2.0 |
| O04 | IronCalc error propagation | 2 | 86 | #DIV/0!, #N/A, #VALUE! through operators and 72 arrays | MIT or Apache-2.0 |
| O05 | IronCalc SUMIFS family | 2 | 285 | Wildcards, operators inside criteria, numbers stored as text | MIT or Apache-2.0 |
| F01 | IronCalc multi-feature example | 11 | 36 | Chart sheet, hidden tab, pivot table, charts, table, notes, merges, CF, split panes, names | MIT or Apache-2.0 |
| F02 | IronCalc tables and structured references | 9 | 212 | 9 tables, totals rows, SUBTOTAL over 21 hidden rows | MIT or Apache-2.0 |
| F03 | PhpSpreadsheet conditional formatting | 10 | 197 | 28 CF blocks plus 12 newer-style (x14) rules; TODAY | MIT |
| F04 | Apache POI number formats | 2 | 325 | About 127 custom formats through TEXT(); 1904 date system | Apache-2.0 |
| F06 | Packt book: lookups and dynamic arrays | 17 | 107 | XLOOKUP, XMATCH, spills, #SPILL! data, 17 notes with picture fills | MIT |
| F07 | LibreOffice threaded comment | 1 | 0 | Threaded comment with a reply, persons part | MPL-2.0 |
| E01 | Microsoft on-call rota | 1 | 0 | Excel table of names and dates; no formulas | CC BY 4.0 |
| E02 | IronCalc weekly timesheet | 3 | 109 | ISOWEEKNUM, EOMONTH, spills, hidden tab, TODAY | MIT or Apache-2.0 |
| E05 | IronCalc travel expense tracker | 2 | 40 | SUMIF, LARGE/INDEX/MATCH top 3, UNIQUE, names | MIT or Apache-2.0 |
| E06 | IronCalc Gantt project tracker | 4 | 444 | CF Gantt across 128 columns, MINIFS, TODAY | MIT or Apache-2.0 |
| E07 | CBO record log with summary tabs | 8 | 1,800 | 360 SUMIFS over a 400-row log, autofilter, frozen panes | Public domain (US) |
| E08 | CBO ten-year cost projection | 5 | 872 | XLOOKUP as array formulas, IFS, names (6 broken), validation | Public domain (US) |
| E09 | cloud.gov cost estimator (quote builder) | 3 | 131 | VLOOKUP price tiers, 11 tables, LET, 21 number formats | CC0 |
| E10 | IronCalc invoice | 3 | 25 | 12 named settings, WORKDAY due date, hidden tab | MIT or Apache-2.0 |
| E11 | Packt book: loan amortisation table | 1 | 192 | EOMONTH dates, PMT, balance chain | MIT |
| E12 | NREL SAM 25-year cash-flow model | 3 | 16,574 | 294 names, LOOKUP/HLOOKUP, IRR/NPV, array formulas | BSD-3-Clause |
| P01 | EIA air-travel model input | 1 | 11,655 | 71k cells, all computable under P0 | Apache-2.0 |
| P02 | DECC 2050 Pathways model | 75 | 161,165 | 209k cells, INDIRECT, 1,939 arrays, 372 names, 233 tables, external links | MIT |
| P03 | EIA gas pipeline capacity tracker | 15 | 135,691 | 388k cells, 5.1 MB, 9 pivot tables, GETPIVOTDATA, images | Apache-2.0 |
| X01 | calamine sheet states | 4 | 0 | Hidden, very hidden and chart sheets | MIT |
| X02 | IronCalc hyperlinks | 2 | 9 | Every link type, link to a missing external workbook | MIT or Apache-2.0 |
| X03 | CBO credit subsidy tool (.xlsm) | 9 | 254 | VBA user-defined function, auto-run macro, 5 protected sheets, form controls | Public domain (US) |

`manifest.json` has the full record for each file: source and commit, licence evidence, sha256, the analyser's counts, functions used, features, what it tests and cautions.

## Coverage

**SHEET-08 functions: 97 of 109** (the finished PRD v0.4 dropped RAND and RANDBETWEEN to post-v1 and added HYPERLINK). Missing: DATEDIF, DATEVALUE, DAYS, EDATE, ISEVEN, ISODD, MROUND, PROPER, SWITCH, TEXTJOIN, WEEKNUM, XOR. Strictly it is 96: plain NETWORKDAYS appears nowhere, only NETWORKDAYS.INTL (O03), which the analyser counts as NETWORKDAYS. Many functions sit in a single file (O01 alone carries 30 of them), so a bad file would hide a lot. `manifest.json`'s coverage fields were computed against the earlier 110-function list.

IronCalc's own test suite (259 workbooks, 74,590 formulas, at the same commit) covers 108 of the 109. Run it alongside this corpus; only WEEKNUM is in neither.

**Features** (number of files that have each): custom number formats 19, defined names 14, merged cells 11, array formulas 11, dynamic-array cells 10, conditional formatting 10, notes 8, frozen panes 7, hidden sheets 7, Excel tables 6, hyperlinks 6, data validation 5, charts 3, hidden rows 3, pivot tables 2, chart sheets 2, autofilter 2, external workbook links 2, images 2, sheet protection 2, and one each of very hidden sheet, threaded comment, form controls, VBA macros, 1904 dates and hidden columns. Also present: newer-style CF rules (F01, F03), a Power Query query (P03) and Microsoft sensitivity labels (E01, E12).

**Not covered:** sparklines, slicers and timelines, What-If data tables, external data connections, Power Pivot, pictures in cells, password-protected files, workbook-structure protection, a resolved threaded comment, Singapore number and date formats.

**Everyday workbooks covered:** on-call rota (E01, no formulas), timesheet (E02), expense tracker (E05), project tracker (E06), record log with summaries (E07), multi-year forecast (E08), quote builder (E09), invoice (E10), loan schedule (E11), cash-flow model (E12).

**Missing:** budget, timesheet with overtime, shift roster with formulas, leave tracker, stock list, side-by-side vendor quote comparison, payroll, shipment or delivery tracker, chart-based dashboard, and anything Singapore-specific (S$, day-first dates, GST, public holidays). No public file with a clean licence was found for these.

## Gaps and how to close them

- **Everyday and Singapore gaps.** Before the spike, make 5–6 small workbooks in Excel with made-up data: a shift roster with OT pay, a leave tracker using NETWORKDAYS with Singapore public holidays, a stock list with reorder levels, a three-vendor quote comparison, a shipment tracker and a department budget, in S$ and day-first dates. Made-up data needs no licence. Include WEEKNUM, DATEDIF, DATEVALUE, DAYS, EDATE, PROPER, SWITCH, TEXTJOIN, XOR and plain NETWORKDAYS, which closes the function gap with files IronCalc did not write.
- **Performance.** No public file has XLOOKUP or SUMIFS at scale, so generate the SHEET-34 reference workbook (100,000 cells: values, row and column totals, IF, a few hundred lookups) and the B.7 stress case (5,000 rows of whole-column XLOOKUP and SUMIFS), plus files at each SHEET-33 limit. `manifest.json` → `generator_spec` describes the generator; open each generated file once in Excel and save it so Excel's values become the answer key.
- **Missing features.** Make a password-protected copy (it must stay a file, SHEET-30), a resolved threaded comment and a slicer in Excel. LibreOffice's test files hold sparklines and a What-If data table (MPL-2.0; not yet licence-checked file by file).
- **Security.** Make copies of E07 and X01 holding formula-injection strings for CSV export (cells starting `=`, `+`, `-`, `@`) and hidden instructions in cells, notes and hidden tabs (Rule 8).
- **Bias.** IronCalc's team made 9 of the 27 files (O04, O05, F01, F02, E02, E05, E06, E10, X02), and IronCalc will probably pass them. Judge IronCalc on the other 18; use those 9 to check the test harness and the fallback engines.
- **Old Excel versions.** P02 was saved by Excel 2011 for Mac, O01 and O03 by Excel 2013. Re-check a suspect mismatch in current Excel before calling it an engine bug.
- **Sensitivity labels.** The PRD does not say whether import keeps, shows or strips Microsoft sensitivity labels, or what happens to label-encrypted files. Add it to the spike checklist.

## Caveat

Public files test the engine and the import code, but they cannot answer Q16 for real: whether conversion and the SHEET-33 limits suit the org's own workbooks. Before the core launch, run the same checks on a few anonymised copies of real workbooks (the build plan already allows anonymised copies for C3.7). Until then, treat Q16 conclusions as provisional.

## Licences and handling

Licences: MIT or Apache-2.0 (9 files), MIT (5), Apache-2.0 (4), MPL-2.0 (3), US public domain (3), CC BY 4.0, CC0 and BSD-3-Clause (1 each). No GPL. `NOTICE.md` gives each file's source, licence, evidence, attribution and what the licence asks; `LICENSES/` holds the licence texts copied from the source repositories.

- Keep the corpus internal. The files carry authors' names and paths in their metadata.
- Do not edit the files in `files/`. If a round-tripped export is kept or shared, mark it as changed (Apache-2.0, CC BY 4.0 and CBO all ask for this); MPL-2.0 files stay MPL-2.0.
- Never open X03 in desktop Excel with macros enabled; inspect it statically.

## Rebuilding from source

`fetch.py` (Python standard library only) downloads every workbook again from its pinned URL and keeps it only if the sha256 matches `manifest.json`. It never opens the files.

```
python3 -I fetch.py NEW_FOLDER               # all 27 workbooks
python3 -I fetch.py NEW_FOLDER --licences    # and the licence texts
python3 -I fetch.py NEW_FOLDER --only O01 P02
python3 -I fetch.py --check                  # verify the copies here, no network
```

Last full rebuild: 11 October 2026, 27 of 27 workbooks and 18 of 18 licence texts matched.

## Dropped at the licence check

- **F05** Singapore Customs manufacturing cost statement: the repo's MIT notice conflicts with Singapore Customs' all-rights-reserved terms. A good data-entry case if Customs gives written permission.
- **E03** time tracker with overtime: no licence file, only a one-line README statement, and unclear ownership.
- **E04** Packt course budget file: third-party course material under the publisher's blanket licence.
