// Import boundaries between workspaces (BUILD-PLAN INF-ARCHLINT; CLAUDE.md, Code and docs). Shared
// code goes in packages/, so an app never imports another app (apps/web never imports apps/server),
// packages/* import no app and not infra/, and nothing imports demo/: it is the reference UI, ported
// by copying (BUILD-PLAN 1E.5), never a library. INF-ARCHLINT's other rules live elsewhere: the
// model-SDK ban in ai-free.ts, and the sole index reader (A2) and the Rule 9 module's allow-list
// (privileged-imports.test.ts) land with the modules they guard.
import { posix } from 'node:path'
import { packageOf } from './imports'

// A workspace's folder (ending in '/') and its package name.
export interface Workspace {
  dir: string
  name: string
}

// The workspace an import lands in, if any: by package name, or by a relative path.
export function landsIn(file: string, specifier: string, workspaces: Workspace[]): Workspace | undefined {
  if (specifier.startsWith('.')) {
    const target = `${posix.normalize(posix.join(posix.dirname(file), specifier))}/`
    return workspaces.find(w => target.startsWith(w.dir))
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
