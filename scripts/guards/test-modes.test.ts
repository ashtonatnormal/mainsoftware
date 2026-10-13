import { matchesGlob } from 'node:path'
import { describe, expect, it } from 'vitest'
import config from '../../vitest.config'
import { repoFiles } from './repo-files'

// Which test files each Vitest mode picks up (vitest.config.ts): the default run (`npm test`, mode
// `test`) and the integration mode (`npm run test:integration`). CLAUDE.md (Testing and CI) and
// TECH-SPEC T10 say every `*.integration.test.ts` runs in the integration mode, and every other test
// in apps/*, packages/*, infra/ and scripts/ in the default run, so a test file that matches
// neither would never run, in CI or anywhere else.
function runsIn(mode: 'test' | 'integration', path: string): boolean {
  const { include = [], exclude = [] } = config({ mode, command: 'serve' }).test ?? {}
  return include.some(glob => matchesGlob(path, glob)) && !exclude.some(glob => matchesGlob(path, glob))
}

const modesOf = (path: string) => (['test', 'integration'] as const).filter(mode => runsIn(mode, path))

describe('Vitest modes: every test file runs in exactly one mode (CLAUDE.md, Testing and CI; T10)', () => {
  it('T10: an integration test runs in the integration mode only, wherever it sits', () => {
    for (const path of [
      'apps/server/src/auth/x.integration.test.ts',
      'apps/server/test/x.integration.test.ts',
      'apps/server/scripts/x.integration.test.ts',
      'apps/web/src/x.integration.test.ts',
      'packages/access/src/x.integration.test.ts',
      'packages/access/x.integration.test.ts',
      'infra/x.integration.test.ts',
      'infra/lib/x.integration.test.ts',
      'scripts/x.integration.test.ts',
      'scripts/guards/x.integration.test.ts',
    ]) {
      expect(modesOf(path), path).toEqual(['integration'])
    }
  })

  it('every other test runs in the default run only', () => {
    for (const path of [
      'apps/server/src/x.test.ts',
      'apps/server/test/x.test.ts',
      'apps/web/src/x.test.tsx',
      'packages/access/rules.test.ts',
      'packages/access/src/x.test.ts',
      'infra/x.test.ts',
      'scripts/x.test.ts',
      'scripts/guards/x.test.ts',
    ]) {
      expect(modesOf(path), path).toEqual(['test'])
    }
  })

  it('leaves out node_modules and build output in both modes', () => {
    for (const path of [
      'apps/server/node_modules/x/a.test.ts',
      'apps/server/node_modules/x/a.integration.test.ts',
      'apps/web/dist/a.test.ts',
      'infra/cdk.out/a.integration.test.ts',
    ]) {
      expect(modesOf(path), path).toEqual([])
    }
  })

  it('every test file in apps/*, packages/*, infra/ and scripts/ runs in one mode (demo/ keeps its own node:test suite)', () => {
    const tests = repoFiles().filter(
      path => /\.test\.[cm]?[jt]sx?$/.test(path) && /^(?:apps\/|packages\/|infra\/|scripts\/)/.test(path),
    )
    expect(tests.length).toBeGreaterThan(0)
    expect(tests.filter(path => path.endsWith('.integration.test.ts')).length).toBeGreaterThan(0)
    expect(tests.filter(path => modesOf(path).length !== 1)).toEqual([])
  })
})
