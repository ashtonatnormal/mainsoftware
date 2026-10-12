// How the guard tests read source: the module specifiers a file loads, the npm package each names,
// and the code a script or page runs with its comments stripped.
import ts from 'typescript'

// The npm package an import specifier loads: 'openai/resources' and 'npm:openai@4' load openai.
// Relative paths, URLs, node: built-ins, # subpath imports and the @/ alias load no package by
// name; ai-free.test.ts refuses code from CDN URLs separately.
export function packageOf(specifier: string): string | undefined {
  const spec = specifier.replace(/^npm:/, '')
  if (/^(?:[a-z][a-z0-9+.-]*:|[./#]|@\/)/i.test(spec)) return undefined
  return spec.match(/^(@[^/@]+\/[^/@]+|[^/@]+)/)?.[1]
}

// Every module a source file loads: imports, re-exports, import-equals, require() and import().
// TypeScript's own pre-processor reads them, so comments and string contents don't count.
export function importsOf(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map(file => file.fileName)
}

// The code a file runs: a script's own text, or a page's inline <script> bodies.
export function scriptsOf(path: string, text: string): string[] {
  if (!/\.html?$/.test(path)) return [text]
  return [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(match => match[1] ?? '')
}

// A script with its comments removed, printed back by TypeScript, so a comment that names something
// isn't mistaken for code that uses it. String and template contents are kept.
export function withoutComments(path: string, source: string): string {
  const kind = /\.tsx$/.test(path)
    ? ts.ScriptKind.TSX
    : /\.jsx$/.test(path)
      ? ts.ScriptKind.JSX
      : /\.[cm]?js$|\.html?$/.test(path)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, kind)
  return ts.createPrinter({ removeComments: true }).printFile(file)
}

// The code a script or page runs, comments stripped.
export function codeOf(path: string, text: string): string {
  return scriptsOf(path, text)
    .map(script => withoutComments(path, script))
    .join('\n')
}
