// The server runs its .ts source on Node with no build step (T2, docs/TECH-SPEC.md), so every
// file it loads must be one Node can run as it is. tsc and Vitest pass several things Node
// refuses: an import naming a .js file or no extension (nodenext accepts `./x.js` for x.ts), a
// #specifier or package export whose target isn't a .ts file, a JSON import without its
// attribute, syntax type stripping can't remove (decorators and `accessor` fields pass
// erasableSyntaxOnly), and a package that works in development only because npm links every
// workspace. server-runtime.test.ts refuses all of these in apps/server and every workspace
// package the server depends on. The CI start-up check (scripts/check-server.sh) covers
// whatever this misses at start.
import { builtinModules } from 'node:module'
import { posix } from 'node:path'
import ts from 'typescript'
import { importTargets, mapImport, type TargetOptions } from './boundaries'
import { type ModuleImport, packageOf } from './imports'

export interface Manifest {
  dir: string
  name: string
  type?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  imports?: unknown
  exports?: unknown
}

const RUNNABLE = /\.(?:m?ts|json)$/
const BUILTINS = new Set(builtinModules)

// Why Node can't load this import from a file in `from`, or undefined if it can.
export function importProblem(entry: ModuleImport, from: Manifest): string | undefined {
  const { specifier, typeOnly, json } = entry
  // A house rule rather than a Node one, so it covers type-only imports too.
  if (from.dir === 'apps/server/' && specifier?.startsWith('.') && posix.normalize(specifier).startsWith('../')) {
    return "climbs out of its folder: use #src/… from the server's imports map"
  }
  // Erased before the code runs, so Node never resolves it (tsc still checks it).
  if (typeOnly) return undefined
  // The server's files are ES modules, which load with import. A function named require, and any
  // use of createRequire, counts as a CommonJS load, so a helper needs another name.
  if (entry.via === 'require') {
    return "calls require or createRequire: the server's files are ES modules, so use import (with { type: 'json' } for JSON)"
  }
  if (specifier === undefined) {
    return 'loads a module chosen at run time, which no check can see: import a literal path'
  }
  let target = specifier
  if (specifier.startsWith('#')) {
    const targets = mapImport(from.imports, specifier, { skipTypes: true })
    if (targets.length === 0) return `isn't in ${from.dir}package.json's imports map`
    const bad = targets.find(t => !RUNNABLE.test(t))
    if (bad) return `maps to ${bad}, which isn't a .ts file`
    target = targets[0] ?? specifier
  } else if (!specifier.startsWith('.')) {
    return undefined // a package by name or a built-in: checked through package.json
  }
  if (!RUNNABLE.test(target)) {
    if (/\.c[jt]s$/.test(target)) return "is CommonJS, but the server's files are ES modules"
    return /\.[cm]?jsx?$/.test(target)
      ? 'names a .js file, but Node runs the .ts source: import the .ts file'
      : 'has no file extension, which Node needs: add .ts'
  }
  if (target.endsWith('.json') && !json) return "is JSON, which Node loads only with { type: 'json' }"
  return undefined
}

// The package a runtime import names, if it must be in the importing workspace's dependencies:
// any package by name except Node's built-ins and the workspace itself.
export function runtimePackage(entry: ModuleImport, from: Manifest): string | undefined {
  if (entry.typeOnly || entry.specifier === undefined) return undefined
  const name = packageOf(entry.specifier)
  if (!name || name === from.name || BUILTINS.has(name)) return undefined
  return name
}

// Problems with a server workspace's package.json exports and imports, which Node follows
// exactly as written: a package the server imports by name declares exports (without them Node
// falls back to main or index.js, never the .ts source), no folder keys (Node dropped them), no
// export patterns (a subpath import by package name couldn't be checked), and every target
// outside the "types" condition names a .ts or .json file, except an imports pattern
// ("#src/*": "./src/*"), whose specifier names the file.
export function manifestProblems(m: Manifest): string[] {
  const problems: string[] = []
  if (m.exports === undefined && m.name !== '@hearth/server') {
    problems.push('has no exports, so Node would fall back to main or index.js, not the .ts source')
  }
  const maps: Array<[string, unknown]> = [
    ['exports', exportsMap(m.exports)],
    ['imports', m.imports],
  ]
  for (const [field, map] of maps) {
    if (!map || typeof map !== 'object') continue
    for (const [key, value] of Object.entries(map)) {
      if (key.endsWith('/')) problems.push(`${field} "${key}" maps a folder, which Node no longer supports`)
      if (field === 'exports' && key.includes('*')) problems.push(`exports "${key}" is a pattern`)
      for (const target of importTargets(value, { skipTypes: true })) {
        const pattern = field === 'imports' && key.endsWith('*') && target.endsWith('*')
        if (!pattern && !RUNNABLE.test(target)) problems.push(`${field} "${key}" → "${target}" isn't a .ts file`)
      }
    }
  }
  return problems
}

// Files that run under Vitest only and that the image leaves out (Dockerfile.dockerignore):
// tests, and helpers in a testing/ folder.
export const TEST_ONLY = /(^|\/)testing(\/|$)|\.test\.tsx?$/

// The repo paths a runtime import can load, for imports that name a file: relative, through
// the importing workspace's imports map, or by name into a workspace package's exports.
export function importedPaths(
  entry: ModuleImport,
  path: string,
  from: Manifest,
  workspaces: Manifest[],
  options: TargetOptions = { skipTypes: true },
): string[] {
  const { specifier } = entry
  if (entry.typeOnly || specifier === undefined) return []
  if (specifier.startsWith('.')) return [posix.join(posix.dirname(path), specifier)]
  if (specifier.startsWith('#')) {
    return mapImport(from.imports, specifier, options).map(t => posix.join(from.dir, t))
  }
  const name = packageOf(specifier)
  const target = workspaces.find(w => w.name === name)
  if (!target || !name) return []
  const subpath = `.${specifier.slice(name.length)}`
  return mapImport(exportsMap(target.exports), subpath, options).map(t => posix.join(target.dir, t))
}

// A package.json "exports" value as a map from subpath to target. Node also accepts the target
// alone (a string, an array, or conditions with no subpath keys) for ".".
export function exportsMap(exports: unknown): unknown {
  const sugar =
    typeof exports === 'string' ||
    Array.isArray(exports) ||
    (!!exports && typeof exports === 'object' && !Object.keys(exports).some(key => key.startsWith('.')))
  return sugar ? { '.': exports } : exports
}

// Why an import by package name can't load, when the package's exports send it to a JSON file
// and the import lacks { type: 'json' } (tsc checks that only on static imports).
export function packageJsonProblem(
  entry: ModuleImport,
  path: string,
  from: Manifest,
  workspaces: Manifest[],
): string | undefined {
  if (entry.json || entry.via !== 'import' || !entry.specifier || /^[.#]/.test(entry.specifier)) return undefined
  // Judged by the target Node actually loads, not by a fallback or a condition it never picks.
  return importedPaths(entry, path, from, workspaces, { nodeImport: true }).some(target => target.endsWith('.json'))
    ? "loads a JSON export, which Node loads only with { type: 'json' }"
    : undefined
}

// Syntax tsc accepts that Node's type stripping can't run, with the line it's on.
export function unstrippableSyntax(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: string[] = []
  const line = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
  const visit = (node: ts.Node): void => {
    if (ts.isDecorator(node)) found.push(`line ${line(node)}: a decorator`)
    if (node.kind === ts.SyntaxKind.AccessorKeyword) found.push(`line ${line(node)}: an accessor field`)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

// The workspaces whose source Node loads when the server runs: apps/server and every workspace
// in its runtime dependencies, directly or through another workspace. The repo tests keep it
// complete: they refuse a workspace imported at run time without being a dependency, and a
// relative or #specifier that reaches into another workspace.
export function serverWorkspaces(manifests: Manifest[]): Manifest[] {
  const byName = new Map(manifests.map(m => [m.name, m]))
  const server = byName.get('@hearth/server')
  if (!server) return []
  const found = new Map([[server.name, server]])
  const queue = [server]
  for (let next = queue.shift(); next; next = queue.shift()) {
    for (const name of Object.keys(next.dependencies ?? {})) {
      const dep = byName.get(name)
      if (dep && !found.has(name)) {
        found.set(name, dep)
        queue.push(dep)
      }
    }
  }
  return [...found.values()]
}

// The module settings tsc applies to a workspace, after following `extends`.
export function moduleSettings(tsconfigPath: string): { module: string; moduleResolution: string } {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    tsconfigPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: diagnostic => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      },
    },
  )
  const options = parsed?.options ?? {}
  return {
    module: ts.ModuleKind[options.module ?? ts.ModuleKind.None],
    moduleResolution: ts.ModuleResolutionKind[options.moduleResolution ?? ts.ModuleResolutionKind.Classic],
  }
}
