// Import boundaries between workspaces (BUILD-PLAN INF-ARCHLINT; CLAUDE.md, Code and docs). Shared
// code goes in packages/, so an app never imports another app (apps/web never imports apps/server),
// packages/* import no app and not infra/, and nothing imports demo/: it is the reference UI, ported
// by copying (BUILD-PLAN 1E.5), never a library. INF-ARCHLINT's other rules live elsewhere: the
// model-SDK ban in ai-free.ts, and the sole index reader (A2) and the Rule 9 module's allow-list
// (privileged-imports.test.ts) land with the modules they guard.
import { posix } from 'node:path'
import { packageOf } from './imports'

// A workspace's folder (ending in '/'), its package name, and its package.json "imports" map,
// which can alias a #specifier to a file or to another package.
export interface Workspace {
  dir: string
  name: string
  imports?: unknown
}

// The conditions Node 24 matches when it imports a file, as the server's start commands run it
// (no --conditions or --no-addons flag). The order here doesn't matter: Node goes through an
// object's keys in their own order.
const NODE_IMPORT_CONDITIONS = new Set(['node', 'node-addons', 'import', 'module-sync', 'default'])

export interface TargetOptions {
  // Leave out the "types" condition: only tsc reads it, never Node.
  skipTypes?: boolean
  // Only the target Node itself loads for an import (see nodeTarget).
  nodeImport?: boolean
}

// Every target a package.json "imports" or "exports" entry can resolve to: a string, a list of
// fallbacks, or conditions ({ "types": …, "default": … }) holding either.
export function importTargets(value: unknown, options: TargetOptions = {}): string[] {
  if (options.nodeImport) {
    const target = nodeTarget(value)
    return typeof target === 'string' ? [target] : []
  }
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(v => importTargets(v, options))
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([condition, v]) =>
      options.skipTypes && condition === 'types' ? [] : importTargets(v, options),
    )
  }
  return []
}

// The target Node loads for an import, following its PACKAGE_TARGET_RESOLVE: a string as it is;
// in conditions, the first key it matches whose value resolves; in a fallback list, the first
// entry that resolves. null means "not exported", which ends the search in conditions, while
// undefined means nothing matched, so Node goes on to the next condition or entry. (Node also
// skips a list entry that is an invalid target, such as one without ./ in front; manifestProblems
// refuses those.)
function nodeTarget(value: unknown): string | null | undefined {
  if (typeof value === 'string' || value === null) return value
  if (Array.isArray(value)) {
    if (value.length === 0) return null
    let last: null | undefined
    for (const entry of value) {
      const target = nodeTarget(entry)
      if (typeof target === 'string') return target
      if (target === null) last = null
    }
    return last
  }
  if (typeof value === 'object') {
    for (const [condition, entry] of Object.entries(value)) {
      if (!NODE_IMPORT_CONDITIONS.has(condition)) continue
      const target = nodeTarget(entry)
      if (target !== undefined) return target
    }
  }
  return undefined
}

// The targets a #specifier maps to through an imports map, as Node matches keys: an exact key
// first, otherwise the pattern key ("#src/*") with the longest prefix before its *.
export function mapImport(imports: unknown, specifier: string, options: TargetOptions = {}): string[] {
  if (!imports || typeof imports !== 'object') return []
  const map = imports as Record<string, unknown>
  if (Object.hasOwn(map, specifier)) return importTargets(map[specifier], options)
  let best: { prefix: string; targets: string[] } | undefined
  for (const [key, value] of Object.entries(map)) {
    const star = key.indexOf('*')
    if (star < 0) continue
    const [prefix, suffix] = [key.slice(0, star), key.slice(star + 1)]
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue
    if (specifier.length < prefix.length + suffix.length || (best && best.prefix.length >= prefix.length)) continue
    const middle = specifier.slice(prefix.length, specifier.length - suffix.length)
    best = { prefix, targets: importTargets(value, options).map(target => target.replaceAll('*', middle)) }
  }
  return best?.targets ?? []
}

// The workspace a repo path lies in. A path through node_modules/ (where npm links every
// workspace) counts as the package it names, which is where Node would follow the link.
function inDir(path: string, workspaces: Workspace[]): Workspace | undefined {
  const normal = posix.normalize(path)
  const linked = normal.split('/node_modules/').at(-1) ?? normal
  if (normal.startsWith('node_modules/') || linked !== normal) {
    const name = packageOf(linked.replace(/^node_modules\//, ''))
    return workspaces.find(w => w.name === name)
  }
  return workspaces.find(w => `${normal}/`.startsWith(w.dir))
}

// The workspace an import lands in, if any: by package name, by a relative path, by the app's
// `@/` alias (its src/ folder), or through the importing workspace's imports map. When a
// #specifier has several targets, the first that leaves the importing workspace counts.
export function landsIn(file: string, specifier: string, workspaces: Workspace[]): Workspace | undefined {
  const from = inDir(file, workspaces)
  if (specifier.startsWith('.')) return inDir(posix.join(posix.dirname(file), specifier), workspaces)
  if (specifier.startsWith('@/')) return from && inDir(posix.join(from.dir, 'src', specifier.slice(2)), workspaces)
  if (specifier.startsWith('#')) {
    if (!from) return undefined
    const landed = mapImport(from.imports, specifier).map(target =>
      target.startsWith('.') ? inDir(posix.join(from.dir, target), workspaces) : landsIn(file, target, workspaces),
    )
    return landed.find(w => w && w.dir !== from.dir) ?? landed.find(Boolean)
  }
  const name = packageOf(specifier)
  return workspaces.find(w => w.name === name)
}

// Why an import from one workspace into another is refused, or undefined if it's allowed.
export function boundaryBreach(from: Workspace, to: Workspace): string | undefined {
  if (from.dir === to.dir) return undefined
  if (to.dir === 'demo/') return 'demo/ is the reference UI: port what you need (BUILD-PLAN 1E.5), never import it'
  if (from.dir.startsWith('apps/') && to.dir.startsWith('apps/')) {
    return 'an app never imports another app; shared code goes in packages/'
  }
  if (from.dir.startsWith('packages/') && (to.dir.startsWith('apps/') || to.dir === 'infra/')) {
    return 'packages/ hold shared code, so they import no app and not infra/'
  }
  return undefined
}

// Why an imports-map target is refused, or undefined. A workspace's imports map only aliases its
// own files ("./src/*"), so a #specifier can't reach another workspace, a package, or a path
// that climbs out of the workspace.
export function importTargetProblem(target: string): string | undefined {
  if (!target.startsWith('./')) return "must start with ./, since an imports map only aliases the workspace's own files"
  if (target.split('/').includes('..')) return 'must not climb out of the workspace with ..'
  return undefined
}
