import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { boundaryBreach, importTargetProblem, importTargets, landsIn, mapImport, type Workspace } from './boundaries'
import { importsOf } from './imports'
import { isScript, readRepoFile, repoFiles, root } from './repo-files'

const files = repoFiles()
const workspaces: Workspace[] = files
  .filter(path => /^(?:apps\/[^/]+|packages\/[^/]+|infra|demo)\/package\.json$/.test(path))
  .map(path => {
    const manifest = JSON.parse(readRepoFile(path))
    return { dir: path.slice(0, -'package.json'.length), name: manifest.name, imports: manifest.imports }
  })

const web = { dir: 'apps/web/', name: '@hearth/web' }
const server = { dir: 'apps/server/', name: '@hearth/server', imports: { '#src/*': './src/*' } }
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

  it('follows a path through node_modules/ to the workspace npm links there', () => {
    expect(landsIn('apps/server/src/a.ts', '../../../node_modules/@hearth/web/src/brand.ts', fixture)).toBe(web)
    expect(landsIn('apps/server/src/a.ts', '../node_modules/@hearth/access/src/x.ts', fixture)).toBe(access)
    expect(landsIn('apps/server/src/a.ts', '../../../node_modules/fastify/fastify.js', fixture)).toBeUndefined()
  })

  it("resolves an app's @/ alias against its own src/, so climbing out of it is seen", () => {
    expect(landsIn('apps/web/src/a.ts', '@/ui/button', fixture)).toBe(web)
    expect(landsIn('apps/web/src/a.ts', '@/../../server/src/db', fixture)).toBe(server)
  })

  it("resolves a #specifier through the importing workspace's imports map (T2)", () => {
    expect(landsIn('apps/server/src/a.ts', '#src/config.ts', fixture)).toBe(server)
    const leaky = { ...server, imports: { '#web/*': '@hearth/web/*', '#up/*': './../web/*' } }
    const withLeak = [web, leaky, access, infra, demo]
    expect(landsIn('apps/server/src/a.ts', '#web/src/x.ts', withLeak)).toBe(web)
    expect(landsIn('apps/server/src/a.ts', '#up/src/x.ts', withLeak)).toBe(web)
    expect(landsIn('apps/server/src/a.ts', '#missing', withLeak)).toBeUndefined()
  })

  it('matches imports-map keys as Node does: exact first, then the longest pattern prefix', () => {
    const map = {
      '#a': './exact.ts',
      '#a/*': './star/*',
      '#a/deep/*': './deep/*',
      '#c': { types: './t.ts', default: ['./d.ts'] },
    }
    expect(mapImport(map, '#a')).toEqual(['./exact.ts'])
    expect(mapImport(map, '#a/x.ts')).toEqual(['./star/x.ts'])
    expect(mapImport(map, '#a/deep/y.ts')).toEqual(['./deep/y.ts'])
    expect(mapImport(map, '#c')).toEqual(['./t.ts', './d.ts'])
    expect(importTargets({ node: { import: './n.ts' }, default: null })).toEqual(['./n.ts'])
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

  it("lets an imports map alias only the workspace's own files", () => {
    expect(importTargetProblem('./src/*')).toBeUndefined()
    expect(importTargetProblem('@hearth/web/*')).toMatch(/start with \.\//)
    expect(importTargetProblem('fastify')).toMatch(/start with \.\//)
    expect(importTargetProblem('./../web/*')).toMatch(/climb/)
    expect(importTargetProblem('/etc/passwd')).toMatch(/start with \.\//)
  })
})

describe('INF-ARCHLINT import boundaries: the repo', () => {
  it('every workspace has its own package name, since packages are imported by name', () => {
    const names = workspaces.map(w => w.name)
    expect(names.every(Boolean)).toBe(true)
    expect(new Set(names).size).toBe(names.length)
  })

  it("every imports-map target stays inside its workspace (T2's #src/*)", () => {
    const found = workspaces.flatMap(w =>
      Object.entries((w.imports ?? {}) as Record<string, unknown>).flatMap(([key, value]) =>
        importTargets(value).flatMap(target => {
          const problem = importTargetProblem(target)
          return problem ? [`${w.dir}package.json: "${key}" → "${target}" ${problem}`] : []
        }),
      ),
    )
    expect(found).toEqual([])
  })

  it('no tracked symlink lies inside a workspace, where it could lead an import into another one', () => {
    const links = execFileSync('git', ['ls-files', '-s'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .filter(line => line.startsWith('120000 '))
      .map(line => line.split('\t')[1] ?? '')
    expect(links.filter(path => workspaces.some(w => path.startsWith(w.dir)))).toEqual([])
  })

  it('no workspace imports across a boundary', () => {
    const found = files.filter(isScript).flatMap(path => {
      const from = workspaces.find(w => path.startsWith(w.dir))
      if (!from) return []
      return importsOf(readRepoFile(path), path).flatMap(spec => {
        const to = landsIn(path, spec, workspaces)
        const why = to && boundaryBreach(from, to)
        return why ? [`${path}: imports '${spec}' (${why})`] : []
      })
    })
    expect(found).toEqual([])
  })
})
