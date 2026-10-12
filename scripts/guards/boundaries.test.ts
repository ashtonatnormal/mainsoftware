import { describe, expect, it } from 'vitest'
import { boundaryBreach, landsIn, type Workspace } from './boundaries'
import { importsOf } from './imports'
import { isScript, readRepoFile, repoFiles } from './repo-files'

const files = repoFiles()
const workspaces: Workspace[] = files
  .filter(path => /^(?:apps\/[^/]+|packages\/[^/]+|infra|demo)\/package\.json$/.test(path))
  .map(path => ({ dir: path.slice(0, -'package.json'.length), name: JSON.parse(readRepoFile(path)).name }))

const web = { dir: 'apps/web/', name: '@hearth/web' }
const server = { dir: 'apps/server/', name: '@hearth/server' }
const access = { dir: 'packages/access/', name: '@hearth/access' }
const infra = { dir: 'infra/', name: '@hearth/infra' }
const demo = { dir: 'demo/', name: 'hearth-demo' }
const fixture = [web, server, access, infra, demo]

describe('INF-ARCHLINT import boundaries: the rules', () => {
  it('finds the workspace an import lands in, by package name or relative path', () => {
    expect(landsIn('apps/web/src/a.ts', '@hearth/server', fixture)).toBe(server)
    expect(landsIn('apps/web/src/a.ts', '@hearth/access/rules', fixture)).toBe(access)
    expect(landsIn('apps/web/src/a.ts', '../../server/src/db', fixture)).toBe(server)
    expect(landsIn('apps/web/src/a.ts', '../../../demo/src/ui', fixture)).toBe(demo)
    expect(landsIn('apps/web/src/a.ts', './b', fixture)).toBe(web)
    expect(landsIn('apps/web/src/a.ts', 'react', fixture)).toBeUndefined()
  })

  it('refuses app to app, package to app or infra, and any import of demo/', () => {
    expect(boundaryBreach(web, server)).toMatch(/another app/)
    expect(boundaryBreach(server, web)).toMatch(/another app/)
    expect(boundaryBreach(access, server)).toMatch(/no app/)
    expect(boundaryBreach(access, infra)).toMatch(/not infra/)
    expect(boundaryBreach(web, demo)).toMatch(/reference UI/)
  })

  it('lets apps and infra import packages, and a workspace import itself', () => {
    expect(boundaryBreach(web, access)).toBeUndefined()
    expect(boundaryBreach(server, access)).toBeUndefined()
    expect(boundaryBreach(infra, access)).toBeUndefined()
    expect(boundaryBreach(web, web)).toBeUndefined()
  })
})

describe('INF-ARCHLINT import boundaries: the repo', () => {
  it('every workspace has its own package name, since packages are imported by name', () => {
    const names = workspaces.map(w => w.name)
    expect(names.every(Boolean)).toBe(true)
    expect(new Set(names).size).toBe(names.length)
  })

  it('no workspace imports across a boundary', () => {
    const found = files.filter(isScript).flatMap(path => {
      const from = workspaces.find(w => path.startsWith(w.dir))
      if (!from) return []
      return importsOf(readRepoFile(path)).flatMap(spec => {
        const to = landsIn(path, spec, workspaces)
        const why = to && boundaryBreach(from, to)
        return why ? [`${path}: imports '${spec}' (${why})`] : []
      })
    })
    expect(found).toEqual([])
  })
})
