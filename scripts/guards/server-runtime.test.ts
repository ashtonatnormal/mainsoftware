import { join, posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import { landsIn } from './boundaries'
import { type ModuleImport, moduleImports } from './imports'
import { readRepoFile, repoFiles, root } from './repo-files'
import {
  importedPaths,
  importProblem,
  type Manifest,
  manifestProblems,
  moduleSettings,
  packageJsonProblem,
  runtimePackage,
  serverWorkspaces,
  TEST_ONLY,
  unstrippableSyntax,
} from './server-runtime'

const files = repoFiles()
const manifests: Manifest[] = files
  .filter(path => /^(?:apps\/[^/]+|packages\/[^/]+|infra|demo)\/package\.json$/.test(path))
  .map(path => ({ dir: path.slice(0, -'package.json'.length), ...JSON.parse(readRepoFile(path)) }))
const server = serverWorkspaces(manifests)
const serverFiles = files.filter(path => server.some(w => path.startsWith(w.dir)))
const serverScripts = serverFiles.filter(path => /\.[cm]?tsx?$/.test(path) && !path.endsWith('.d.ts'))
const workspaceOf = (path: string) => server.find(w => path.startsWith(w.dir)) as Manifest
const isTest = (path: string) => TEST_ONLY.test(path)

const serverApp: Manifest = { dir: 'apps/server/', name: '@hearth/server', imports: { '#src/*': './src/*' } }
const pkg: Manifest = { dir: 'packages/access/', name: '@hearth/access' }
const load = (specifier: string | undefined, extra: Partial<ModuleImport> = {}): ModuleImport => ({
  specifier,
  typeOnly: false,
  json: false,
  via: 'import',
  ...extra,
})

describe('T2 server runtime: the rules', () => {
  it('lets packages by name, built-ins, .ts files and #src/ .ts files through', () => {
    for (const spec of ['fastify', '@hearth/access', 'node:fs', './a.ts', './b/c.mts', '#src/config.ts']) {
      expect(importProblem(load(spec), serverApp), spec).toBeUndefined()
    }
  })

  it('refuses .js, extensionless and .tsx imports, directly or through the imports map', () => {
    for (const spec of ['./a.js', './b/c', '#src/config', '#src/config.js', './x.tsx', './y.jsx']) {
      expect(importProblem(load(spec), serverApp), spec).toBeDefined()
    }
  })

  it('judges a #specifier by where the imports map sends it, ignoring the types condition', () => {
    const exact: Manifest = { ...serverApp, imports: { '#config': './src/config.ts' } }
    expect(importProblem(load('#config'), exact)).toBeUndefined()
    const toJs: Manifest = { ...serverApp, imports: { '#lib/*.ts': { types: './src/*.ts', default: './src/*.js' } } }
    expect(importProblem(load('#lib/a.ts'), toJs)).toMatch(/isn't a \.ts file/)
    expect(importProblem(load('#nowhere/a.ts'), serverApp)).toMatch(/isn't in .*imports map/)
  })

  it('makes the server leave a folder through #src/, not ../, while packages may use ../', () => {
    expect(importProblem(load('../config.ts'), serverApp)).toMatch(/#src/)
    expect(importProblem(load('./../config.ts'), serverApp)).toMatch(/#src/)
    expect(importProblem(load('../config.ts', { typeOnly: true }), serverApp)).toMatch(/#src/)
    expect(importProblem(load('./a/../b.ts'), serverApp)).toBeUndefined()
    expect(importProblem(load('../config.ts'), pkg)).toBeUndefined()
  })

  it("needs { type: 'json' } on a JSON import, which tsc checks only on static imports", () => {
    expect(importProblem(load('./d.json', { json: true }), pkg)).toBeUndefined()
    expect(importProblem(load('./d.json'), pkg)).toMatch(/type: 'json'/)
  })

  it("refuses require in the server's ES modules, which load with import", () => {
    for (const via of ['./d.json', './x.ts', 'fastify', undefined]) {
      expect(importProblem(load(via, { via: 'require' }), pkg), String(via)).toMatch(/require/)
    }
    const loader =
      "import { createRequire } from 'node:module'\nconst require = createRequire(import.meta.url)\nrequire('./data.json')"
    expect(moduleImports(loader).map(i => [i.specifier, i.via])).toEqual([
      ['node:module', 'import'],
      [undefined, 'require'],
      [undefined, 'require'],
      ['./data.json', 'require'],
    ])
    const renamed =
      "import { createRequire as make } from 'node:module'\nconst load = make(import.meta.url)\nload('./x.js')"
    expect(moduleImports(renamed).some(i => i.via === 'require')).toBe(true)
    expect(moduleImports("module.require('./a.cjs')")).toEqual([load('./a.cjs', { via: 'require' })])
  })

  it("doesn't read another object's require method, or a define() outside JavaScript, as a load", () => {
    expect(moduleImports("env.require('PORT')\nthis.require(name)")).toEqual([])
    expect(moduleImports("const define = (f: string[]) => f\ndefine(['title', 'body'])")).toEqual([])
    expect(moduleImports("define(['a'], f)\ndefine('id', ['b'], f)", 'vendor.js').map(i => i.specifier)).toEqual([
      'a',
      'b',
    ])
  })

  it("needs { type: 'json' } on an import by name that a package's exports send to JSON", () => {
    const data: Manifest = {
      ...pkg,
      name: '@hearth/data',
      exports: { '.': './src/index.ts', './countries': './src/countries.json' },
    }
    const all = [serverApp, data]
    const from = 'apps/server/src/a.ts'
    expect(packageJsonProblem(load('@hearth/data/countries'), from, serverApp, all)).toMatch(/type: 'json'/)
    expect(packageJsonProblem(load('@hearth/data/countries', { json: true }), from, serverApp, all)).toBeUndefined()
    expect(packageJsonProblem(load('@hearth/data'), from, serverApp, all)).toBeUndefined()
  })

  it('finds the files an import loads, so a test-only one can be refused', () => {
    const access: Manifest = { ...pkg, exports: { '.': './src/index.ts', './testing': './src/testing/index.ts' } }
    const all = [serverApp, access]
    const from = 'apps/server/src/jobs/a.ts'
    expect(importedPaths(load('#src/testing/fixture.ts'), from, serverApp, all)).toEqual([
      'apps/server/src/testing/fixture.ts',
    ])
    expect(importedPaths(load('./x.test.ts'), from, serverApp, all)).toEqual(['apps/server/src/jobs/x.test.ts'])
    expect(importedPaths(load('@hearth/access/testing'), from, serverApp, all)).toEqual([
      'packages/access/src/testing/index.ts',
    ])
    expect(importedPaths(load('fastify'), from, serverApp, all)).toEqual([])
    for (const path of [
      'apps/server/src/testing/fixture.ts',
      'apps/server/src/jobs/x.test.ts',
      'packages/access/src/testing/index.ts',
    ]) {
      expect(TEST_ONLY.test(path), path).toBe(true)
    }
    expect(TEST_ONLY.test('apps/server/src/jobs/testing-ground.ts')).toBe(false)
  })

  it('refuses a module chosen at run time, and ignores imports erased before the code runs', () => {
    expect(importProblem(load(undefined), pkg)).toMatch(/run time/)
    expect(importProblem(load('./types', { typeOnly: true }), pkg)).toBeUndefined()
  })

  it('reads every import form, including export * as and import() with options', () => {
    const source = [
      "export * as config from './config.js'",
      "const re = [/'/, await import('./late.js')]",
      "const data = await import('./d.json', { with: { type: 'json' } })",
      "import seed from './seed.json' with { type: 'json' }",
      "import type { T } from './t'",
      "export type { U } from './u'",
      "type V = import('./v').V",
      'const pick = await import(name)',
      "const r = require('./r.cjs')",
      "const cast = await import('./cast.js' as string)",
    ].join('\n')
    expect(moduleImports(source)).toEqual([
      load('./config.js'),
      load('./late.js'),
      load('./d.json', { json: true }),
      load('./seed.json', { json: true }),
      load('./t', { typeOnly: true }),
      load('./u', { typeOnly: true }),
      load('./v', { typeOnly: true }),
      load(undefined),
      load('./r.cjs', { via: 'require' }),
      load('./cast.js'),
    ])
  })

  it('names the packages a runtime import needs listed: not built-ins, itself or type-only imports', () => {
    expect(runtimePackage(load('fastify/types'), serverApp)).toBe('fastify')
    expect(runtimePackage(load('@hearth/shared'), pkg)).toBe('@hearth/shared')
    for (const entry of [load('fs'), load('node:fs'), load('@hearth/access'), load('pino', { typeOnly: true })]) {
      expect(runtimePackage(entry, pkg), entry.specifier).toBeUndefined()
    }
  })

  it('refuses folder keys, export patterns and targets Node would read as JavaScript', () => {
    expect(manifestProblems({ ...pkg, exports: { '.': './src/index.ts' } })).toEqual([])
    expect(manifestProblems(pkg)).toEqual([expect.stringMatching(/has no exports/)])
    expect(manifestProblems({ ...pkg, exports: './src/index.ts' })).toEqual([])
    expect(manifestProblems(serverApp)).toEqual([])
    expect(manifestProblems({ ...pkg, exports: { './rules': './src/rules.js' } })).toHaveLength(1)
    expect(manifestProblems({ ...pkg, exports: { './*': './src/*.ts' } })).toHaveLength(1)
    expect(manifestProblems({ ...serverApp, imports: { '#lib/': './src/' } })).toHaveLength(2)
    expect(
      manifestProblems({ ...pkg, exports: { '.': { types: './src/index.d.ts', default: './src/index.ts' } } }),
    ).toEqual([])
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
      moduleImports(readRepoFile(path), path).flatMap(entry => {
        // Vitest, not Node, resolves a test's computed import.
        if (isTest(path) && entry.specifier === undefined) return []
        const problem =
          importProblem(entry, workspaceOf(path)) ?? packageJsonProblem(entry, path, workspaceOf(path), server)
        return problem ? [`${path}: '${entry.specifier ?? '(computed)'}' ${problem}`] : []
      }),
    )
    expect(found).toEqual([])
  })

  it('every package the server and its packages load at run time is in their dependencies', () => {
    // Otherwise it works only because npm links every workspace and hoists dev dependencies, and
    // the image, which installs the server's production dependencies alone, doesn't have it.
    const found = serverScripts
      .filter(path => !isTest(path))
      .flatMap(path => {
        const from = workspaceOf(path)
        return moduleImports(readRepoFile(path), path).flatMap(entry => {
          const name = runtimePackage(entry, from)
          return name && !Object.hasOwn(from.dependencies ?? {}, name)
            ? [
                `${path}: '${name}' isn't in ${from.dir}package.json dependencies (test-only code goes in a ` +
                  'testing/ folder or a *.test.ts file, which the image leaves out)',
              ]
            : []
        })
      })
    expect(found).toEqual([])
  })

  it('runtime code never loads a test-only file, which the image leaves out', () => {
    const found = serverScripts
      .filter(path => !isTest(path))
      .flatMap(path =>
        moduleImports(readRepoFile(path), path).flatMap(entry =>
          importedPaths(entry, path, workspaceOf(path), server)
            .filter(target => TEST_ONLY.test(target))
            .map(target => `${path}: '${entry.specifier}' loads ${target}, which is test-only`),
        ),
      )
    expect(found).toEqual([])
  })

  it('a relative or #specifier stays inside its own workspace (another workspace is imported by name)', () => {
    // Otherwise a file would load without being part of a dependency, so neither these rules nor
    // the image would cover it.
    const found = serverScripts.flatMap(path =>
      moduleImports(readRepoFile(path), path).flatMap(entry => {
        const spec = entry.specifier
        if (entry.typeOnly || !spec || !(spec.startsWith('.') || spec.startsWith('#'))) return []
        const own = workspaceOf(path)
        if (spec.startsWith('.') && !posix.join(posix.dirname(path), spec).startsWith(own.dir)) {
          const to = landsIn(path, spec, manifests)
          return [
            to
              ? `${path}: '${spec}' reaches into ${to.dir}: import ${to.name} by name and list it in dependencies`
              : `${path}: '${spec}' leaves its workspace for a folder the image doesn't hold`,
          ]
        }
        const to = landsIn(path, spec, manifests)
        return to && to.dir !== own.dir
          ? [`${path}: '${spec}' reaches into ${to.dir}: import ${to.name} by name and list it in dependencies`]
          : []
      }),
    )
    expect(found).toEqual([])
  })

  it("the server's packages export and map only files Node can run", () => {
    expect(server.flatMap(w => manifestProblems(w).map(problem => `${w.dir}package.json: ${problem}`))).toEqual([])
  })

  it('no decorators or accessor fields where the server loads code', () => {
    const found = serverScripts.flatMap(path =>
      unstrippableSyntax(path, readRepoFile(path)).map(problem => `${path}, ${problem}`),
    )
    expect(found).toEqual([])
  })

  it('no .tsx, .jsx, .cts or .cjs files where the server loads code: its files are ES modules Node strips', () => {
    expect(serverFiles.filter(path => /\.(?:[jt]sx|c[jt]s)$/.test(path))).toEqual([])
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
