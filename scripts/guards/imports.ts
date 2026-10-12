// What a source file imports, shared by the guard tests: the module specifiers it loads and the npm
// package each one names.
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
