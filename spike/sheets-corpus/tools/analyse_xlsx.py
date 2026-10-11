"""Static, read-only analysis of .xlsx workbooks for the Sheets spike corpus.

SHEET-08 list: the 109 functions of the finished PRD v0.4 (RAND and RANDBETWEEN are post-v1; HYPERLINK is in).

Opens each file as a zip and reads its XML. Nothing in the file is executed:
no macros, no external links, no formula evaluation. Run with `python3 -I`.

Usage: python3 -I tools/analyse_xlsx.py OUT.json FILE_OR_DIR [FILE_OR_DIR ...]
Writes a JSON list with one record per workbook.
"""
import hashlib, json, os, re, sys, zipfile
from xml.etree import ElementTree as ET

SHEET08 = """SUM SUMIF SUMIFS SUMPRODUCT PRODUCT SUBTOTAL ROUND ROUNDUP ROUNDDOWN MROUND CEILING FLOOR INT TRUNC ABS MOD POWER SQRT
AVERAGE AVERAGEIF AVERAGEIFS MEDIAN MIN MINIFS MAX MAXIFS COUNT COUNTA COUNTBLANK COUNTIF COUNTIFS LARGE SMALL RANK STDEV VAR
IF IFS IFERROR IFNA AND OR NOT XOR SWITCH TRUE FALSE
VLOOKUP HLOOKUP XLOOKUP LOOKUP INDEX MATCH XMATCH CHOOSE ROW ROWS COLUMN COLUMNS
CONCAT CONCATENATE TEXTJOIN LEFT RIGHT MID LEN LOWER UPPER PROPER TRIM CLEAN SUBSTITUTE REPLACE FIND SEARCH TEXT VALUE EXACT REPT HYPERLINK
TODAY NOW DATE TIME YEAR MONTH DAY HOUR MINUTE SECOND WEEKDAY WEEKNUM ISOWEEKNUM EDATE EOMONTH DAYS DATEDIF NETWORKDAYS WORKDAY DATEVALUE
ISBLANK ISNUMBER ISTEXT ISLOGICAL ISERROR ISNA ISEVEN ISODD NA""".split()
# Excel's newer names for the same function count as the SHEET-08 function (SHEET-08: "Excel's newer
# names also work"). NETWORKDAYS.INTL and WORKDAY.INTL are different functions, so they are not folded.
ALIASES = {'STDEV.S': 'STDEV', 'VAR.S': 'VAR', 'RANK.EQ': 'RANK', 'CEILING.MATH': 'CEILING', 'FLOOR.MATH': 'FLOOR'}
LOOKUPS = {'VLOOKUP', 'HLOOKUP', 'XLOOKUP', 'LOOKUP', 'INDEX', 'MATCH', 'XMATCH', 'SUMIFS', 'COUNTIFS', 'AVERAGEIFS', 'SUMIF', 'COUNTIF', 'SUMPRODUCT'}
VOLATILE = {'NOW', 'TODAY', 'RAND', 'RANDBETWEEN', 'OFFSET', 'INDIRECT', 'CELL', 'INFO'}
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
FUNC_RE = re.compile(r'(?<![A-Za-z0-9_.])((?:_xlfn\.|_xlws\.|_xludf\.)?[A-Z][A-Z0-9.]*)\(')
STR_RE = re.compile(r'"(?:[^"]|"")*"')
MAX_UNZIPPED = 400 * 1024 * 1024  # refuse zip bombs


def func_names(formula):
    out = []
    for m in FUNC_RE.finditer(STR_RE.sub('""', formula)):
        n = m.group(1)
        for p in ('_xlfn.', '_xlws.', '_xludf.'):
            if n.startswith(p):
                n = n[len(p):]
        out.append(n)
    return out


def analyse(path):
    rec = {'file': path, 'bytes': os.path.getsize(path)}
    with open(path, 'rb') as f:
        rec['sha256'] = hashlib.sha256(f.read()).hexdigest()
    try:
        z = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        rec['error'] = 'not a zip (not OOXML)'
        return rec
    names = z.namelist()
    if sum(i.file_size for i in z.infolist()) > MAX_UNZIPPED:
        rec['error'] = 'unzipped size over limit'
        return rec
    def read(n):
        try:
            return z.read(n)
        except KeyError:
            return b''
    app = read('docProps/app.xml').decode('utf8', 'replace')
    m = re.search(r'<Application>([^<]*)</Application>', app)
    rec['application'] = m.group(1) if m else ''
    m = re.search(r'<AppVersion>([^<]*)</AppVersion>', app)
    rec['app_version'] = m.group(1) if m else ''
    core = read('docProps/core.xml').decode('utf8', 'replace')
    m = re.search(r'<dc:title>([^<]*)</dc:title>', core)
    rec['title'] = m.group(1) if m else ''
    wb = read('xl/workbook.xml').decode('utf8', 'replace')
    sheets = re.findall(r'<sheet\b[^>]*>', wb)
    rec['sheets'] = len(sheets)
    rec['hidden_sheets'] = sum(1 for s in sheets if 'state="hidden"' in s or 'state="veryHidden"' in s)
    rec['defined_names'] = len(re.findall(r'<definedName\b', wb))
    feats = {
        'macros': any(n.lower().endswith('vbaproject.bin') for n in names),
        'charts': sum(1 for n in names if n.startswith('xl/charts/chart')),
        'pivot_tables': sum(1 for n in names if n.startswith('xl/pivotTables/')),
        'tables': sum(1 for n in names if n.startswith('xl/tables/')),
        'comments': sum(1 for n in names if re.match(r'xl/(comments|threadedComments/)', n)),
        'images': sum(1 for n in names if n.startswith('xl/media/')),
        'external_links': sum(1 for n in names if n.startswith('xl/externalLinks/')),
    }
    styles = read('xl/styles.xml').decode('utf8', 'replace')
    feats['custom_num_formats'] = len(re.findall(r'<numFmt\b', styles))
    cells = formulas = cached = arrays = shared = cross_sheet = 0
    merges = cond = valid = autofilter = frozen = hidden_rows = hidden_cols = protected = 0
    funcs = {}
    for n in names:
        if not re.match(r'xl/worksheets/sheet\d+\.xml$', n):
            continue
        x = read(n).decode('utf8', 'replace')
        merges += len(re.findall(r'<mergeCell\b', x))
        cond += len(re.findall(r'<conditionalFormatting\b', x))
        valid += len(re.findall(r'<dataValidation\b', x))
        autofilter += len(re.findall(r'<autoFilter\b', x))
        frozen += len(re.findall(r'state="frozen"', x))
        hidden_rows += len(re.findall(r'<row\b[^>]*hidden="1"', x))
        hidden_cols += len(re.findall(r'<col\b[^>]*hidden="1"', x))
        protected += len(re.findall(r'<sheetProtection\b', x))
        for cm in re.finditer(r'<c\b([^>]*?)(?:/>|>(.*?)</c>)', x, re.S):
            cells += 1
            inner = cm.group(2) or ''
            fm = re.search(r'<f\b([^>]*)>(.*?)</f>|<f\b([^>]*)/>', inner, re.S)
            if not fm:
                continue
            formulas += 1
            attrs = (fm.group(1) or fm.group(3) or '')
            if 't="array"' in attrs:
                arrays += 1
            if 't="shared"' in attrs:
                shared += 1
            if '<v>' in inner or '<v/>' in inner:
                cached += 1
            text = (fm.group(2) or '')
            text = text.replace('&quot;', '"').replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
            if '!' in text:
                cross_sheet += 1
            for fn in func_names(text):
                funcs[fn] = funcs.get(fn, 0) + 1
    feats.update({'merged_cells': merges, 'conditional_formatting': cond, 'data_validation': valid,
                  'autofilter': autofilter, 'frozen_panes': frozen, 'hidden_rows': hidden_rows,
                  'hidden_cols': hidden_cols, 'sheet_protection': protected})
    rec.update({'cells': cells, 'formulas': formulas, 'formulas_with_cached_value': cached,
                'array_formulas': arrays, 'shared_formulas': shared, 'cross_sheet_formulas': cross_sheet,
                'features': feats, 'functions': dict(sorted(funcs.items(), key=lambda kv: -kv[1]))})
    canon = {ALIASES.get(f, f) for f in funcs}
    rec['sheet08_functions_used'] = sorted(canon & set(SHEET08))
    rec['functions_outside_sheet08'] = sorted(canon - set(SHEET08))
    rec['lookup_calls'] = sum(c for f, c in funcs.items() if ALIASES.get(f, f) in LOOKUPS)
    rec['volatile_functions'] = sorted(canon & VOLATILE)
    app = rec['application']
    rec['excel_saved'] = ('Excel' in app) and not any(k in app for k in ('Openpyxl', 'Compatible', 'IronCalc', 'LibreOffice'))
    return rec


def main():
    out = sys.argv[1]
    paths = []
    for a in sys.argv[2:]:
        if os.path.isdir(a):
            for root, _, files in os.walk(a):
                paths += [os.path.join(root, f) for f in files if f.lower().endswith(('.xlsx', '.xlsm'))]
        else:
            paths.append(a)
    recs = []
    for p in sorted(paths):
        try:
            recs.append(analyse(p))
        except Exception as e:  # keep going; report the failure
            recs.append({'file': p, 'error': f'{type(e).__name__}: {e}'})
    with open(out, 'w') as f:
        json.dump(recs, f, indent=1)
    ok = [r for r in recs if 'error' not in r]
    print(f'{len(recs)} files, {len(ok)} parsed, {sum(r["formulas"] for r in ok)} formulas, '
          f'{sum(1 for r in ok if r["excel_saved"])} saved by Excel -> {out}')


if __name__ == '__main__':
    main()
