import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { root } from './guards/repo-files'

const SCRIPT = join(root, 'scripts/check-migration-order.sh')
const repos: string[] = []

// A throwaway repo whose main holds the given migrations, checked out on a branch from it.
function repo(onMain: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'hearth-order-'))
  repos.push(dir)
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: dir,
      stdio: 'pipe',
    })
  git('init', '-q', '-b', 'main')
  mkdirSync(join(dir, 'db/migrations'), { recursive: true })
  writeFileSync(join(dir, 'README'), 'test\n')
  for (const name of onMain) writeFileSync(join(dir, 'db/migrations', name), `-- ${name}\n`)
  git('add', '-A')
  git('commit', '-qm', 'main')
  git('checkout', '-qb', 'feature')
  return dir
}

function commit(dir: string, change: (migrations: string) => void): void {
  change(join(dir, 'db/migrations'))
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'branch'],
    {
      cwd: dir,
    },
  )
}

function check(dir: string): { status: number | null; output: string } {
  const result = spawnSync('bash', [SCRIPT, 'main'], { cwd: dir, encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('C0.3 scripts/check-migration-order.sh (T3, CLAUDE.md Database)', () => {
  it('passes a new migration numbered above the highest on main, and a first migration', () => {
    const dir = repo(['0001_a.sql', '0002_b.sql'])
    commit(dir, m => writeFileSync(join(m, '0003_c.sql'), 'select 3;\n'))
    expect(check(dir)).toMatchObject({ status: 0 })
    const first = repo([])
    commit(first, m => writeFileSync(join(m, '0001_a.sql'), 'select 1;\n'))
    expect(check(first)).toMatchObject({ status: 0 })
  })

  it('refuses a new migration numbered at or below the highest on main', () => {
    const dir = repo(['0001_a.sql', '0003_c.sql'])
    commit(dir, m => {
      writeFileSync(join(m, '0002_b.sql'), 'select 2;\n')
      writeFileSync(join(m, '0003_other.sql'), 'select 3;\n')
    })
    const { status, output } = check(dir)
    expect(status).toBe(1)
    expect(output).toContain('0002_b.sql is numbered 0002')
    expect(output).toContain('0003_other.sql is numbered 0003')
  })

  it('sees main having moved on since the branch started', () => {
    const dir = repo(['0001_a.sql'])
    commit(dir, m => writeFileSync(join(m, '0002_mine.sql'), 'select 2;\n'))
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: dir })
    commit(dir, m => writeFileSync(join(m, '0002_theirs.sql'), 'select 2;\n'))
    execFileSync('git', ['checkout', '-q', 'feature'], { cwd: dir })
    const { status, output } = check(dir)
    expect(status).toBe(1)
    expect(output).toContain('0002_mine.sql is numbered 0002')
  })

  it('refuses changing, renaming or deleting a migration main has', () => {
    for (const change of [
      (m: string) => writeFileSync(join(m, '0001_a.sql'), '-- edited\n'),
      (m: string) => rmSync(join(m, '0001_a.sql')),
      (m: string) => {
        rmSync(join(m, '0001_a.sql'))
        writeFileSync(join(m, '0003_a.sql'), '-- 0001_a.sql\n')
      },
    ]) {
      const dir = repo(['0001_a.sql', '0002_b.sql'])
      commit(dir, change)
      const { status, output } = check(dir)
      expect(status).toBe(1)
      expect(output).toContain('0001_a.sql is on main')
    }
  })
})
