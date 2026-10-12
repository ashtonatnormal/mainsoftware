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

// One module a source file loads, as written.
export interface ModuleImport {
  // undefined when the module is chosen at run time: import(name) or require(name) with a value
  // that isn't a literal string.
  specifier: string | undefined
  // Erased before the code runs, so nothing is loaded: `import type`, `export type`, and a type
  // written as import('x').
  typeOnly: boolean
  // Declares `with { type: 'json' }`, statically or as import()'s second argument.
  json: boolean
  // How it loads: an import, or CommonJS require (which reads JSON without an attribute).
  via: 'import' | 'require'
}

// How TypeScript should parse a file, from its extension (a page's inline scripts are JavaScript).
function scriptKind(path: string): ts.ScriptKind {
  if (/\.tsx$/.test(path)) return ts.ScriptKind.TSX
  if (/\.jsx$/.test(path)) return ts.ScriptKind.JSX
  if (/\.[cm]?js$|\.html?$/.test(path)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

const isJsonType = (node: ts.Node | undefined): boolean =>
  !!node &&
  ts.isObjectLiteralExpression(node) &&
  node.properties.some(
    p =>
      ts.isPropertyAssignment(p) &&
      p.name.getText().replace(/['"]/g, '') === 'type' &&
      ts.isStringLiteralLike(p.initializer) &&
      p.initializer.text === 'json',
  )

// The text of a string literal, seen through the wrappers TypeScript allows around it:
// ('x'), 'x' as string, 'x' satisfies string, <string>'x' and 'x'!.
function literalText(node: ts.Expression | undefined): string | undefined {
  let inner = node
  while (
    inner &&
    (ts.isParenthesizedExpression(inner) ||
      ts.isAsExpression(inner) ||
      ts.isSatisfiesExpression(inner) ||
      ts.isTypeAssertionExpression(inner) ||
      ts.isNonNullExpression(inner))
  ) {
    inner = inner.expression
  }
  return inner && ts.isStringLiteralLike(inner) ? inner.text : undefined
}

// Whether a file declares its own `require` that isn't a module loader: a function, a parameter,
// or a variable set to anything but createRequire(…). Its calls then load nothing.
function bindsOwnRequire(file: ts.SourceFile): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isParameter(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'require'
    ) {
      found = true
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'require') {
      const init = node.initializer
      const isLoader =
        !!init &&
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        init.expression.text === 'createRequire'
      if (!isLoader) found = true
    }
    if (!found) ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

// Every module a source file loads: imports and re-exports of any form (`export * as ns from`
// included), import-equals, import(), require() and module.require(), and AMD's
// define(['x'], …), read from TypeScript's syntax tree, so comments and strings don't count. The
// path picks the parser (TS, TSX, JS). A require function stored under another name than
// `require` isn't followed.
export function moduleImports(source: string, path = 'file.ts'): ModuleImport[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path))
  const ownRequire = bindsOwnRequire(file)
  const found: ModuleImport[] = []
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const typeOnly = ts.isImportDeclaration(node) ? !!node.importClause?.isTypeOnly : node.isTypeOnly
      const json = !!node.attributes?.elements.some(
        a => a.name.text === 'type' && ts.isStringLiteralLike(a.value) && a.value.text === 'json',
      )
      if (ts.isStringLiteralLike(node.moduleSpecifier))
        found.push({ specifier: node.moduleSpecifier.text, typeOnly, json, via: 'import' })
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const target = node.moduleReference.expression
      found.push({ specifier: literalText(target), typeOnly: node.isTypeOnly, json: false, via: 'require' })
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument
      if (ts.isLiteralTypeNode(arg) && ts.isStringLiteralLike(arg.literal)) {
        found.push({ specifier: arg.literal.text, typeOnly: true, json: false, via: 'import' })
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [first, options] = node.arguments
      const withClause =
        options && ts.isObjectLiteralExpression(options)
          ? options.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText() === 'with')
          : undefined
      found.push({
        specifier: literalText(first),
        typeOnly: false,
        json: !!withClause && ts.isPropertyAssignment(withClause) && isJsonType(withClause.initializer),
        via: 'import',
      })
    } else if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 'require' && !ownRequire) ||
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'require'))
    ) {
      found.push({ specifier: literalText(node.arguments[0]), typeOnly: false, json: false, via: 'require' })
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'define' &&
      node.arguments[0] &&
      ts.isArrayLiteralExpression(node.arguments[0])
    ) {
      for (const element of node.arguments[0].elements) {
        const specifier = literalText(element)
        if (specifier) found.push({ specifier, typeOnly: false, json: false, via: 'require' })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

// The module specifiers a file names, wherever they are written.
export function importsOf(source: string, path = 'file.ts'): string[] {
  return moduleImports(source, path).flatMap(i => (i.specifier === undefined ? [] : [i.specifier]))
}

// The code a file runs: a script's own text, or a page's inline <script> bodies.
export function scriptsOf(path: string, text: string): string[] {
  if (!/\.html?$/.test(path)) return [text]
  return [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(match => match[1] ?? '')
}

// A script with its comments removed, printed back by TypeScript, so a comment that names something
// isn't mistaken for code that uses it. String and template contents are kept.
export function withoutComments(path: string, source: string): string {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, scriptKind(path))
  return ts.createPrinter({ removeComments: true }).printFile(file)
}

// The code a script or page runs, comments stripped. A page runs code from attributes too (onclick,
// javascript: and data: URLs), so a page is kept whole, minus HTML comments and the comments inside
// each inline script.
export function codeOf(path: string, text: string): string {
  if (!/\.html?$/.test(path)) return withoutComments(path, text)
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(
      /(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi,
      (_, open: string, body: string, close: string) => open + withoutComments(path, body) + close,
    )
}
