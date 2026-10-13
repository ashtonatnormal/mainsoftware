import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, MigrationFilesError, migrationFiles, SqlFileMigrationProvider } from '#src/db/migrations.ts'

const made: string[] = []

async function folder(entries: Record<string, string | 'dir'>): Promise<URL> {
  const dir = await mkdtemp(join(tmpdir(), 'hearth-migrations-'))
  made.push(dir)
  for (const [name, content] of Object.entries(entries)) {
    if (content === 'dir') await mkdir(join(dir, name))
    else await writeFile(join(dir, name), content)
  }
  return pathToFileURL(`${dir}/`)
}

afterEach(async () => {
  await Promise.all(made.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('C0.3 migration files (T3, CLAUDE.md Database)', () => {
  it('lists <NNNN>_<name>.sql files in number order', async () => {
    const dir = await folder({ '0002_b.sql': 'select 2;', '0010_c.sql': '', '0001_a.sql': 'select 1;' })
    expect(await migrationFiles(dir)).toEqual(['0001_a.sql', '0002_b.sql', '0010_c.sql'])
  })

  it('refuses every file Kysely would skip or misorder, naming each', async () => {
    const dir = await folder({
      '0001_ok.sql': '',
      '0002_Upper.sql': '',
      '0003_dash-name.sql': '',
      '3_short.sql': '',
      '0004_notes.txt': '',
      '.0005_hidden.sql': '',
      '0006_folder': 'dir',
      '0001_twin.sql': '',
    })
    const error = await migrationFiles(dir).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MigrationFilesError)
    const message = (error as Error).message
    for (const name of [
      '0002_Upper.sql',
      '0003_dash-name.sql',
      '3_short.sql',
      '0004_notes.txt',
      '.0005_hidden.sql',
      '0006_folder',
    ]) {
      expect(message).toContain(name)
    }
    expect(message).toMatch(
      /0001_twin\.sql and 0001_ok\.sql share the number 0001|0001_ok\.sql and 0001_twin\.sql share/,
    )
  })

  it('refuses a link, which could point anywhere', async () => {
    const dir = await folder({ '0001_real.sql': 'select 1;' })
    await symlink(new URL('0001_real.sql', dir), new URL('0002_link.sql', dir))
    await expect(migrationFiles(dir)).rejects.toThrow(/0002_link\.sql is not a plain file/)
  })

  it('gives Kysely one migration per file, named without .sql, in order', async () => {
    const dir = await folder({ '0002_b.sql': 'select 2;', '0001_a.sql': 'select 1;' })
    const migrations = await new SqlFileMigrationProvider(dir, 'hearth_owner').getMigrations()
    expect(Object.keys(migrations)).toEqual(['0001_a', '0002_b'])
  })

  it("the repo's own db/migrations/ passes", async () => {
    const files = await migrationFiles(MIGRATIONS_DIR)
    expect(files.length).toBeGreaterThan(0)
    expect(files[0]).toBe('0001_tenancy.sql')
  })
})
