import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importsOf } from './imports'
import { readRepoFile, repoFiles, root } from './repo-files'
import { importProblem, moduleSettings, serverWorkspaces, unstrippableSyntax } from './server-runtime'

const files = repoFiles()
const manifests = files
  .filter(path => /^(?:apps\/[^/]+|packages\/[^/]+|infra|demo)\/package\.json$/.test(path))
  .map(path => ({ dir: path.slice(0, -'package.json'.length), ...JSON.parse(readRepoFile(path)) }))
const server = serverWorkspaces(manifests)
const serverFiles = files.filter(path => server.some(w => path.startsWith(w.dir)))
const serverScripts = serverFiles.filter(path => /\.[cm]?tsx?$/.test(path) && !path.endsWith('.d.ts'))

describe('T2 server runtime: the rules', () => {
  it('lets packages by name, built-ins and .ts or .json files through', () => {
    for (const spec of ['fastify', '@hearth/access', 'node:fs', './a.ts', '../b/c.mts', '#src/config.ts', './d.json']) {
      expect(importProblem(spec), spec).toBeUndefined()
    }
  })

  it('refuses relative and #src imports that name a .js file or no extension', () => {
    for (const spec of ['./a.js', '../b/c', '#src/config', '#src/config.js', './x.tsx', './y.jsx']) {
      expect(importProblem(spec), spec).toBeDefined()
    }
  })

  it('finds decorators and accessor fields, and passes plain classes', () => {
    const decorated = 'function log(..._: unknown[]) {}\n@log\nclass A {\n  @log method() {}\n}'
    expect(unstrippableSyntax('a.ts', decorated)).toEqual(['line 2: a decorator', 'line 4: a decorator'])
    expect(unstrippableSyntax('b.ts', 'class B {\n  accessor count = 0\n}')).toEqual(['line 2: an accessor field'])
    expect(unstrippableSyntax('c.ts', 'class C {\n  #count = 0\n  get count() { return this.#count }\n}')).toEqual([])
  })

  it('follows the server dependencies through other workspaces, not dev dependencies', () => {
    const found = serverWorkspaces([
      { dir: 'apps/server/', name: '@hearth/server', dependencies: { '@hearth/access': '*', fastify: '5' } },
      { dir: 'packages/access/', name: '@hearth/access', dependencies: { '@hearth/shared': '*' } },
      { dir: 'packages/shared/', name: '@hearth/shared' },
      { dir: 'packages/test-kit/', name: '@hearth/test-kit' },
      { dir: 'apps/web/', name: '@hearth/web', dependencies: { '@hearth/shared': '*' } },
    ])
    expect(found.map(w => w.name)).toEqual(['@hearth/server', '@hearth/access', '@hearth/shared'])
  })
})

describe('T2 server runtime: the repo', () => {
  it('finds the server among the workspaces', () => {
    expect(server.map(w => w.name)).toContain('@hearth/server')
  })

  it('every import in the server and its packages names a file Node can load', () => {
    const found = serverScripts.flatMap(path =>
      importsOf(readRepoFile(path)).flatMap(spec => {
        const problem = importProblem(spec)
        return problem ? [`${path}: '${spec}' ${problem}`] : []
      }),
    )
    expect(found).toEqual([])
  })

  it('no decorators or accessor fields where the server loads code', () => {
    const found = serverScripts.flatMap(path =>
      unstrippableSyntax(path, readRepoFile(path)).map(problem => `${path}, ${problem}`),
    )
    expect(found).toEqual([])
  })

  it('no .tsx or .jsx files where the server loads code: Node can only strip types from .ts', () => {
    expect(serverFiles.filter(path => /\.[jt]sx$/.test(path))).toEqual([])
  })

  it('tsc resolves imports as Node does in the server and its packages (nodenext)', () => {
    const found = server.flatMap(w => {
      const settings = moduleSettings(join(root, w.dir, 'tsconfig.json'))
      return settings.module === 'NodeNext' && settings.moduleResolution === 'NodeNext'
        ? []
        : [`${w.dir}tsconfig.json: module ${settings.module}, moduleResolution ${settings.moduleResolution}`]
    })
    expect(found).toEqual([])
  })

  it('every workspace is an ES module package, so Node loads its .ts files as ESM without a warning', () => {
    expect(manifests.filter(m => m.type !== 'module').map(m => m.dir)).toEqual([])
  })
})
