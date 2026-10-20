// Every id from C0.8's sign-in design that code cites is one TECH-SPEC T20 records, so a reader
// can look it up (T20's preamble). The AQ ids (the defaults C0.8 took) are checked wherever code
// cites them in apps/, packages/ and scripts/; "AQ-05/06" records or cites both ids. The Q ids (the
// design's open points) are checked only in the sign-in code, apps/server/src/auth/ and
// apps/web/src/sign-in/, since elsewhere a Q id is the PRD's (PRD §13) or fixture text (the Q4
// group DM). Comments count: a citation is a comment or a test's name.
import { describe, expect, it } from 'vitest'
import { readRepoFile, repoFiles } from './repo-files'

const SELF = 'scripts/guards/design-ids.test.ts'
const CODE = /^(?:apps|packages|scripts)\/.+\.(?:[cm]?[jt]sx?|sh|sql)$/
const SIGN_IN_CODE = /^apps\/(?:server\/src\/auth|web\/src\/sign-in)\//

// The ids a text names: AQ-nn (AQ-nn/mm names both) and, when asked for, Qn.
function idsIn(text: string, options: { q: boolean }): Set<string> {
  const ids = new Set<string>()
  for (const [, first, second] of text.matchAll(/\bAQ-(\d+)(?:\/(\d+))?\b/g)) {
    ids.add(`AQ-${first}`)
    if (second !== undefined) ids.add(`AQ-${second}`)
  }
  if (options.q) for (const [id] of text.matchAll(/\bQ\d+\b/g)) ids.add(id)
  return ids
}

// TECH-SPEC's T20 section, from its heading to the next.
function t20Of(spec: string): string {
  const start = spec.indexOf('\n## T20:')
  if (start === -1) throw new Error('docs/TECH-SPEC.md has no T20 section')
  const end = spec.indexOf('\n## ', start + 1)
  return spec.slice(start, end === -1 ? undefined : end)
}

// Each cited id T20 doesn't record, as "path: id".
function dangling(files: ReadonlyMap<string, string>, recorded: ReadonlySet<string>): string[] {
  const found: string[] = []
  for (const [path, text] of files) {
    for (const id of idsIn(text, { q: SIGN_IN_CODE.test(path) })) {
      if (!recorded.has(id)) found.push(`${path}: ${id}`)
    }
  }
  return found
}

describe('T20: the sign-in design ids code cites are recorded in TECH-SPEC T20', () => {
  it('finds a dangling id on planted files, and passes recorded ones', () => {
    const recorded = idsIn('(AQ-01) (AQ-05/06, Q10) Q27', { q: true })
    expect([...recorded].sort()).toEqual(['AQ-01', 'AQ-05', 'AQ-06', 'Q10', 'Q27'])
    const files = new Map([
      ['apps/server/src/auth/a.ts', '// AQ-01, AQ-05 and AQ-06/05 (Q10); and Q5'],
      ['apps/server/src/web/b.ts', '// AQ-99, and the Q4 group DM'],
      ['apps/web/src/sign-in/c.tsx', "it('AQ-05/07 Q27')"],
      ['packages/access/d.ts', '// PRD Q19'],
    ])
    expect(dangling(files, recorded)).toEqual([
      'apps/server/src/auth/a.ts: Q5',
      'apps/server/src/web/b.ts: AQ-99',
      'apps/web/src/sign-in/c.tsx: AQ-07',
    ])
  })

  it('every AQ id in code, and every Q id in the sign-in code, is one T20 records', () => {
    const recorded = idsIn(t20Of(readRepoFile('docs/TECH-SPEC.md')), { q: true })
    const files = new Map(
      repoFiles()
        .filter(path => CODE.test(path) && path !== SELF)
        .map(path => [path, readRepoFile(path)] as const),
    )
    // Code does cite the design, so an empty match would mean the guard reads nothing.
    expect([...files.values()].some(text => idsIn(text, { q: false }).size > 0)).toBe(true)
    expect(dangling(files, recorded)).toEqual([])
  })
})
