// The server runs its .ts source on Node with no build step (T2, docs/TECH-SPEC.md), so every
// file it loads must be one Node can run as it is. tsc and Vitest pass two things Node refuses:
// an import that names a .js file or no extension (nodenext accepts `./x.js` for x.ts), and
// syntax that type stripping can't remove (decorators and `accessor` fields pass
// erasableSyntaxOnly). server-runtime.test.ts refuses both in apps/server and every workspace
// package the server depends on, and checks the settings that make tsc resolve imports as Node
// does. The CI start-up check (scripts/check-server.sh) covers whatever this misses at start.
import ts from 'typescript'

// Why Node can't load this import specifier from a server file, or undefined if it can. Packages
// by name (fastify, @hearth/access) and node: built-ins resolve through package.json, so only
// relative and #imports-map specifiers must name the file, with a .ts (or .json) extension.
export function importProblem(specifier: string): string | undefined {
  if (!/^(?:\.{1,2}\/|#)/.test(specifier)) return undefined
  if (/\.(?:[cm]?ts|json)$/.test(specifier)) return undefined
  return /\.[cm]?jsx?$/.test(specifier)
    ? 'names a .js file, but Node runs the .ts source: import the .ts file'
    : 'has no file extension, which Node needs: add .ts'
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

interface Manifest {
  dir: string
  name: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

// The workspaces whose source Node loads when the server runs: apps/server and every workspace
// in its runtime dependencies, directly or through another workspace.
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
