// What a source file imports, shared by the guard tests: the module specifiers it loads and the npm
// package each one names.
import ts from 'typescript'

// The npm package an import specifier loads: 'openai/resources' and 'npm:openai@4' load openai,
// and so do CDN URLs such as https://esm.sh/openai. Relative paths, node: built-ins, # subpath
// imports and the @/ alias load no package.
export function packageOf(specifier: string): string | undefined {
  let spec = specifier.replace(/^npm:/, '')
  const cdn = spec.match(
    /^https?:\/\/(?:esm\.sh|esm\.run|cdn\.skypack\.dev|unpkg\.com|cdn\.jsdelivr\.net\/npm|ga\.jspm\.io\/npm:)\/?(.+)$/,
  )
  if (cdn?.[1]) spec = cdn[1]
  else if (/^(?:[a-z][a-z0-9+.-]*:|[./#]|@\/)/i.test(spec)) return undefined
  const match = spec.match(/^(@[^/@]+\/[^/@]+|[^/@]+)/)
  return match?.[1]
}

// Every module a source file loads: imports, re-exports, import-equals, require() and import().
// TypeScript's own pre-processor reads them, so comments and string contents don't count.
export function importsOf(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map(file => file.fileName)
}
