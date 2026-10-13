// Every transaction the server opens goes through withOrg() (apps/server/src/db/database.ts),
// except the two sign-in lookups that run before the org is known (db/pre-org.ts), and only
// withOrg() sets the org and user (CLAUDE.md, Database; C0.5). This guard reads the server's
// runtime source, comments stripped, and finds any other way in: Kysely's transaction(),
// startTransaction() or connection(), a BEGIN or START TRANSACTION sent by hand, a call to the
// pre-org functions, an app. setting set outside withOrg() (by a SET, its name quoted or spaced or
// not, or by a set_config() naming it or whose name isn't a literal), any setting set for the whole
// connection rather than the transaction (a set_config() whose third argument isn't true, or a SET
// other than SET LOCAL, SET TRANSACTION and SET CONSTRAINTS), and a query sent to the pool rather
// than a transaction (a query builder or execute() on anything but the transaction, trx; any call
// on a Database named db but opening a transaction; and query() or connect() on a pg pool or
// client named pool, pg, postgres or client). It goes by names, not types, so a Database handle
// named trx would pass. Test-only files are skipped.
import { describe, expect, it } from 'vitest'
import { withoutComments } from './imports'
import { readRepoFile, repoFiles } from './repo-files'
import { TEST_ONLY } from './server-runtime'

const DATABASE = 'apps/server/src/db/database.ts'
const PRE_ORG = 'apps/server/src/db/pre-org.ts'
// The migrator, on a connection of its own as hearth_owner at deploy, never the app's pool.
const MIGRATIONS = 'apps/server/src/db/migrations.ts'
// The readiness check, which reads no table.
const POOL = 'apps/server/src/db/pool.ts'

// Kysely's own ways to hold a connection or open a transaction.
const OPENS = /\.(?:startTransaction|transaction|connection)\s*\(/
// A sql`…` template (with or without a type argument), whose text is checked for BEGIN.
const SQL_TEMPLATE = /\bsql\s*(?:<(?:[^<>`]|<[^<>`]*>)*>)?\s*`((?:[^`\\]|\\.)*)`/g
const BEGINS = /\b(?:begin|start\s+transaction)\b/i
// A string or template that is itself a BEGIN, as in client.query('begin').
const BEGIN_STRING = /['"`]\s*(?:begin|start\s+transaction)\b/i
const PRE_ORG_FUNCTIONS = /\b(?:session_by_token|person_by_phone)\b/
// SET app.… by hand, the name quoted or spaced or not. set_config() calls are read argument by
// argument (setConfigCalls).
const SET_APP = /\bset\s+(?:local\s+|session\s+)?"?app"?\s*\./i
// A SET statement that outlives its transaction: anything but SET LOCAL, SET TRANSACTION and SET
// CONSTRAINTS, which end with it. Matched at the start of each statement of a sql`…` template, so
// an UPDATE's SET never counts, and at the start of a string given to query() or sql.raw().
const SESSION_SET = /^\s*set\s+(?!local\b|transaction\b|constraints\b)/i
const STRING_SET = /\.\s*(?:query|raw)\s*\(\s*['"`]\s*set\s+(?!local\b|transaction\b|constraints\b)/i
// A set_config() name that can't be an app. setting: a literal naming something else.
const OTHER_SETTING = /^'(?!app\.)[a-z_][a-z0-9_.]*'$/i
// A query run on something other than the withOrg() transaction. The server always calls that
// transaction trx, so .execute() given anything else counts as a query on the pool, unless it's
// given a function (a transaction's own work, which OPENS answers for), and so does a query
// builder started on anything else: a Database however it is named, cast or reached (api['db']),
// and a subquery, which can be started on trx too.
const EXECUTE_ON = /\.execute\s*\(\s*([^)\s][^)]*?)\s*\)/g
const ON_TRANSACTION = /^(?:trx\s*,?|async\b.*|\(.*|[\w$]+\s*=>.*)$/s
const ON_BUILDER =
  /([\w$]+|[)\]])\s*[?!]?\s*\.\s*(?:selectFrom|insertInto|updateTable|deleteFrom|mergeInto|replaceInto|selectNoFrom|executeQuery|getExecutor)\s*[(<]/g
// A Database handle (db, api.db, deps.db, api.db?, api.db!) used directly, other than to open a
// transaction (OPENS), and pg's own query() and connect() on a pool or client.
const ON_DATABASE =
  /\b(?:[\w$]+\s*[?!]?\s*\.\s*)*db\s*[?!]?\s*\.\s*(?!transaction\b|startTransaction\b|connection\b)[\w$]+\s*[(<]/
const ON_POOL = /\b(?:pool|pg|postgres|client)\s*[?!]?\s*\.\s*(?:query|connect)\s*[(<]/

// Each set_config(…) call's arguments, split at the commas outside any brackets.
function setConfigCalls(code: string): string[][] {
  const calls: string[][] = []
  for (const match of code.matchAll(/\bset_config\s*\(/gi)) {
    const args: string[] = []
    let depth = 0
    let arg = ''
    for (const char of code.slice((match.index ?? 0) + match[0].length)) {
      if (char === ')' && depth === 0) break
      if ('([{'.includes(char)) depth++
      if (')]}'.includes(char)) depth--
      if (char === ',' && depth === 0) {
        args.push(arg.trim())
        arg = ''
      } else arg += char
    }
    args.push(arg.trim())
    calls.push(args)
  }
  return calls
}

function entryProblems(code: string): {
  opens: boolean
  begins: boolean
  preOrg: boolean
  setsApp: boolean
  wholeConnection: boolean
  queriesPool: boolean
} {
  const templates = [...code.matchAll(SQL_TEMPLATE)].map(match => match[1] ?? '')
  const setConfigs = setConfigCalls(code)
  return {
    opens: OPENS.test(code),
    begins: templates.some(text => BEGINS.test(text)) || BEGIN_STRING.test(code),
    preOrg: PRE_ORG_FUNCTIONS.test(code),
    setsApp: SET_APP.test(code) || setConfigs.some(([name = '']) => !OTHER_SETTING.test(name)),
    // set_config()'s third argument, is_local, must be true, and a SET must be SET LOCAL (or
    // TRANSACTION or CONSTRAINTS): otherwise the setting stays on the pooled connection for
    // whichever request takes it next.
    wholeConnection:
      setConfigs.some(args => args[2] !== 'true') ||
      templates.some(text => text.split(';').some(statement => SESSION_SET.test(statement.replace(/--[^\n]*/g, '')))) ||
      STRING_SET.test(code),
    queriesPool:
      [...code.matchAll(EXECUTE_ON)].some(([, on = '']) => !ON_TRANSACTION.test(on)) ||
      [...code.matchAll(ON_BUILDER)].some(([, on]) => on !== 'trx') ||
      ON_DATABASE.test(code) ||
      ON_POOL.test(code),
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
      wholeConnection: false,
      queriesPool: false,
    })
  })

  it('finds an app. setting whose name is not written out, and a setting kept past the transaction', () => {
    expect(entryProblems(`await sql\`select set_config(\${name}, \${org}, true)\`.execute(trx)`).setsApp).toBe(true)
    expect(
      entryProblems(`await sql\`select set_config(\${sql.lit('app.org_id')}, \${org}, true)\`.execute(trx)`).setsApp,
    ).toBe(true)
    expect(entryProblems("await client.query('select set_config($1, $2, true)', [name, org])").setsApp).toBe(true)
    expect(entryProblems("await sql`select set_config('lock_timeout', '5s', false)`.execute(trx)")).toMatchObject({
      setsApp: false,
      wholeConnection: true,
    })
    expect(
      entryProblems(`await sql\`select set_config('lock_timeout', \${timeout}, \${local})\`.execute(trx)`)
        .wholeConnection,
    ).toBe(true)
    // Setting the org for the whole pooled connection, by a name that isn't written out, on the pool.
    expect(entryProblems(`await sql\`select set_config(\${name}, \${org}, false)\`.execute(db)`)).toMatchObject({
      setsApp: true,
      wholeConnection: true,
      queriesPool: true,
    })
    expect(
      entryProblems(
        `await sql\`select set_config('lock_timeout', \${sql.lit(LOCK_TIMEOUT)}, true), set_config('synchronous_commit', 'off', true)\`.execute(trx)`,
      ),
    ).toMatchObject({ setsApp: false, wholeConnection: false })
  })

  it('finds a SET kept past the transaction, and an app. SET however its name is written (CLAUDE.md, Database)', () => {
    const shapes: [string, { setsApp: boolean; wholeConnection: boolean }][] = [
      ["await sql`set lock_timeout = '5s'`.execute(trx)", { setsApp: false, wholeConnection: true }],
      [`await sql\`set app.org_id = \${org}\`.execute(trx)`, { setsApp: true, wholeConnection: true }],
      [`await sql\`set session app.org_id = \${org}\`.execute(trx)`, { setsApp: true, wholeConnection: true }],
      [`await sql\`set local "app".org_id = \${org}\`.execute(trx)`, { setsApp: true, wholeConnection: false }],
      [`await sql\`set app . user_id = \${user}\`.execute(trx)`, { setsApp: true, wholeConnection: true }],
      [`await sql\`SET "app"."org_id" TO \${org}\`.execute(trx)`, { setsApp: true, wholeConnection: true }],
      // A later statement of the same template.
      ["await sql`select 1; set statement_timeout = '1s'`.execute(trx)", { setsApp: false, wholeConnection: true }],
      ["await client.query('set statement_timeout = 0')", { setsApp: false, wholeConnection: true }],
      ["await sql.raw('set search_path = public').execute(trx)", { setsApp: false, wholeConnection: true }],
    ]
    for (const [code, expected] of shapes) expect(entryProblems(code), code).toMatchObject(expected)
    // What ends with the transaction, and an UPDATE's SET, pass.
    for (const code of [
      "await sql`set local lock_timeout = '2s'`.execute(trx)",
      'await sql`set transaction isolation level repeatable read`.execute(trx)',
      'await sql`set constraints all deferred`.execute(trx)',
      "await client.query('set local statement_timeout = 0')",
      "await sql`select set_config('lock_timeout', '2s', true)`.execute(trx)",
      `await sql\`update people set deactivated_at = now() where id = \${id}\`.execute(trx)`,
      `await sql\`update users\n    set pin_hash = null, pin_failures = 0\n  where id = \${id}\`.execute(trx)`,
      `await sql\`insert into devices (id) values (\${id}) on conflict (id) do update set label = \${label}\`.execute(trx)`,
      "await trx.updateTable('people').set({ deactivated_at: now }).execute()",
    ]) {
      expect(entryProblems(code), code).toMatchObject({ setsApp: false, wholeConnection: false })
    }
  })

  it('finds a query sent to the pool rather than a transaction', () => {
    for (const code of [
      'await sql`select id from people`.execute(db)',
      'await sql`select id from people`.execute(api.db)',
      'await sql`select id from people`.execute(database)',
      "await db.selectFrom('people').select('id').execute()",
      "await api.db.insertInto('audit_events').values(row).execute()",
      "await deps.db\n  .updateTable('people')\n  .set(values)\n  .execute()",
      "await pool.query('select id from people')",
      'const client = await pool.connect()',
      // A Database by another name, reached through optional chaining, a cast or brackets.
      "async function people(database: Database) {\n  return database.selectFrom('people').selectAll().execute()\n}",
      "const k = api.db\nawait k.selectFrom('people').selectAll().execute()",
      "await api.db?.selectFrom('people').selectAll().execute()",
      "await api.db!.selectFrom('people').selectAll().execute()",
      "await (api.db as Database).selectFrom('people').selectAll().execute()",
      "await api['db'].selectFrom('people').selectAll().execute()",
      'await kysely.executeQuery(compiled)',
      "await deps.pg.query('select id from people')",
      "await client.query('select id from people')",
    ]) {
      expect(entryProblems(code).queriesPool, code).toBe(true)
    }
    for (const code of [
      "await trx.selectFrom('people').select('id').execute()",
      "await trx\n  .updateTable('people')\n  .set(values)\n  .execute()",
      "await trx.selectFrom('people').where('id', 'in', trx.selectFrom('teams').select('lead_id')).execute()",
      'await sql`select 1`.execute(trx)',
      'await sql`select 1`.execute(\n  trx,\n)',
      'await withOrg(api.db, acting, work)',
      'await db.transaction().execute(async trx => work(trx))',
    ]) {
      expect(entryProblems(code).queriesPool, code).toBe(false)
    }
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

  it('keeps every setting to its transaction', () => {
    expect(sources.filter(({ code }) => entryProblems(code).wholeConnection).map(source => source.path)).toEqual([])
  })

  it('queries the pool outside a transaction only in the migrator and the readiness check', () => {
    expect(
      sources
        .filter(({ code }) => entryProblems(code).queriesPool)
        .map(source => source.path)
        .sort(),
    ).toEqual([MIGRATIONS, POOL])
  })
})
