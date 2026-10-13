// Every transaction the server opens goes through withOrg() (apps/server/src/db/database.ts),
// except the two sign-in lookups that run before the org is known (db/pre-org.ts), and only
// withOrg() sets the org and user (CLAUDE.md, Database; C0.5). This guard reads the server's
// runtime source, comments stripped, and finds any other way in: Kysely's transaction(),
// startTransaction() or connection(), a BEGIN or START TRANSACTION sent by hand, a call to the
// pre-org functions, or an app. setting set outside withOrg(). Test-only files are skipped.
import { describe, expect, it } from 'vitest'
import { withoutComments } from './imports'
import { readRepoFile, repoFiles } from './repo-files'
import { TEST_ONLY } from './server-runtime'

const DATABASE = 'apps/server/src/db/database.ts'
const PRE_ORG = 'apps/server/src/db/pre-org.ts'

// Kysely's own ways to hold a connection or open a transaction.
const OPENS = /\.(?:startTransaction|transaction|connection)\s*\(/
// A sql`…` template (with or without a type argument), whose text is checked for BEGIN.
const SQL_TEMPLATE = /\bsql\s*(?:<(?:[^<>`]|<[^<>`]*>)*>)?\s*`((?:[^`\\]|\\.)*)`/g
const BEGINS = /\b(?:begin|start\s+transaction)\b/i
// A string or template that is itself a BEGIN, as in client.query('begin').
const BEGIN_STRING = /['"`]\s*(?:begin|start\s+transaction)\b/i
const PRE_ORG_FUNCTIONS = /\b(?:session_by_token|person_by_phone)\b/
const SETS_APP = /set_config\s*\(\s*'app\.|\bset\s+(?:local\s+|session\s+)?app\./i

function entryProblems(code: string): {
  opens: boolean
  begins: boolean
  preOrg: boolean
  setsApp: boolean
} {
  const templates = [...code.matchAll(SQL_TEMPLATE)].map(match => match[1] ?? '')
  return {
    opens: OPENS.test(code),
    begins: templates.some(text => BEGINS.test(text)) || BEGIN_STRING.test(code),
    preOrg: PRE_ORG_FUNCTIONS.test(code),
    setsApp: SETS_APP.test(code),
  }
}

const sources = repoFiles()
  .filter(path => path.startsWith('apps/server/src/') && /\.ts$/.test(path) && !TEST_ONLY.test(path))
  .map(path => ({ path, code: withoutComments(path, readRepoFile(path)) }))

describe('db entry guard: transactions only through withOrg() and the pre-org lookups (CLAUDE.md, Database)', () => {
  it('finds each way in', () => {
    expect(entryProblems('await db.transaction().execute(work)').opens).toBe(true)
    expect(entryProblems('const trx = await db.startTransaction().execute()').opens).toBe(true)
    expect(entryProblems('await db.connection().execute(c => c)').opens).toBe(true)
    expect(entryProblems('await sql`BEGIN`.execute(db)').begins).toBe(true)
    expect(entryProblems('await sql<{ id: string }>`start transaction; select 1`.execute(db)').begins).toBe(true)
    expect(entryProblems("await client.query('begin')").begins).toBe(true)
    expect(entryProblems('await sql`select * from public.person_by_phone($1)`.execute(db)').preOrg).toBe(true)
    expect(entryProblems("await sql`select set_config('app.user_id', $1, true)`.execute(trx)").setsApp).toBe(true)
    expect(entryProblems('await sql`set local app.org_id = 1`.execute(trx)').setsApp).toBe(true)
    expect(entryProblems('await sql`select 1 as begins`.execute(trx)')).toEqual({
      opens: false,
      begins: false,
      preOrg: false,
      setsApp: false,
    })
  })

  it('reads the server source', () => {
    const paths = sources.map(source => source.path)
    expect(paths).toContain(DATABASE)
    expect(paths).toContain(PRE_ORG)
    expect(paths.some(path => TEST_ONLY.test(path))).toBe(false)
  })

  it('opens transactions only in database.ts and pre-org.ts', () => {
    const found = sources.filter(({ code }) => {
      const problems = entryProblems(code)
      return problems.opens || problems.begins
    })
    expect(found.map(source => source.path).sort()).toEqual([DATABASE, PRE_ORG])
  })

  it('calls the pre-org functions only from pre-org.ts', () => {
    expect(sources.filter(({ code }) => entryProblems(code).preOrg).map(source => source.path)).toEqual([PRE_ORG])
  })

  it('sets app. settings only in database.ts', () => {
    expect(sources.filter(({ code }) => entryProblems(code).setsApp).map(source => source.path)).toEqual([DATABASE])
  })
})
