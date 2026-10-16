// The realtime role writes nothing to Postgres (TECH-SPEC T19 item 14; BUILD-PLAN C0.7): it reads
// sessions, people, teams and roles to decide who may hold a socket and its topics, and every change
// it reacts to is made elsewhere (the api, the worker). This guard reads every runtime file under
// apps/server/src/realtime/ from TypeScript's syntax tree (so comments never count), and fails on:
//   - a Kysely write builder (insertInto, updateTable, deleteFrom, mergeInto, replaceInto);
//   - a string or template, sql`…` and sql.raw() included, holding a write or a row lock (insert
//     into, update …, delete from, merge into, truncate, for update, for no key update, for share,
//     for key share), or a call to one of Hearth's own functions (public.<name>(), which is how a
//     SECURITY DEFINER write would be reached);
//   - a withOrg() call without { readOnly: true } as its options, written out;
//   - an import, of any form, of the outbox's append, the job queue's enqueue or a privileged module.
// C0.5's pre-org session lookup (db/pre-org.ts sessionByToken, outside realtime/) is the one
// read-write transaction the realtime role opens: it takes a FOR SHARE lock, and touches nothing
// (m5). Test-only files are skipped. The fixture cases below prove each pattern is caught.
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { moduleImports } from './imports'
import { readRepoFile, repoFiles } from './repo-files'
import { TEST_ONLY } from './server-runtime'

const REALTIME = 'apps/server/src/realtime/'

const WRITE_BUILDERS = new Set(['insertInto', 'updateTable', 'deleteFrom', 'mergeInto', 'replaceInto'])
const SQL_WRITES: [string, RegExp][] = [
  ['insert into', /\binsert\s+into\b/i],
  ['update', /\bupdate\s+(?!of\b)[\w"]/i],
  ['delete from', /\bdelete\s+from\b/i],
  ['merge into', /\bmerge\s+into\b/i],
  ['truncate', /\btruncate\b/i],
  ['for update', /\bfor\s+(?:no\s+key\s+)?update\b/i],
  ['for share', /\bfor\s+(?:key\s+)?share\b/i],
  ['a Hearth function', /\bpublic\s*\.\s*"?[a-z_][a-z0-9_]*"?\s*\(/i],
]
// What a realtime file may not load: the outbox's append, the queue's enqueue, the Rule 9 module or
// anything else named privileged.
const FORBIDDEN_IMPORTS = /(?:^|\/)(?:outbox\/append|jobs\/enqueue)(?:\.ts)?$|privileged/

// The text of every string and template in the file: a template's literal parts, joined where its
// substitutions were (so a statement split by ${…} still reads as one).
function textsOf(file: ts.SourceFile): string[] {
  const texts: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) texts.push(node.text)
    else if (ts.isTemplateExpression(node)) {
      texts.push([node.head.text, ...node.templateSpans.map(span => span.literal.text)].join(' $ '))
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return texts
}

// Whether an options argument is an object literal saying readOnly: true.
function isReadOnly(options: ts.Expression | undefined): boolean {
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return false
  return options.properties.some(
    p =>
      ts.isPropertyAssignment(p) &&
      p.name.getText().replace(/['"]/g, '') === 'readOnly' &&
      p.initializer.kind === ts.SyntaxKind.TrueKeyword,
  )
}

function writeProblems(source: string, path = 'file.ts'): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const problems: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : undefined
      if (name !== undefined && WRITE_BUILDERS.has(name)) problems.push(`a write builder: ${name}()`)
      if (name === 'withOrg' && !isReadOnly(node.arguments[3])) problems.push('a withOrg() not read only')
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  for (const text of textsOf(file)) {
    for (const [what, pattern] of SQL_WRITES) if (pattern.test(text)) problems.push(`SQL with ${what}`)
  }
  for (const entry of moduleImports(source, path)) {
    if (entry.specifier !== undefined && FORBIDDEN_IMPORTS.test(entry.specifier)) {
      problems.push(`an import of ${entry.specifier}`)
    }
  }
  return problems
}

const sources = repoFiles()
  .filter(path => path.startsWith(REALTIME) && /\.ts$/.test(path) && !TEST_ONLY.test(path))
  .map(path => ({ path, source: readRepoFile(path) }))

describe('realtime read-only guard: the realtime role writes nothing to Postgres (T19 item 14, m5)', () => {
  it('finds every write, lock, Hearth function call, non-read-only withOrg() and forbidden import', () => {
    const caught: [string, string][] = [
      ["await trx.insertInto('audit_events').values(row).execute()", 'a write builder: insertInto()'],
      ["await trx.updateTable('sessions').set({ last_seen_at: now }).execute()", 'a write builder: updateTable()'],
      ["await trx\n  .deleteFrom('team_memberships')\n  .execute()", 'a write builder: deleteFrom()'],
      ["await trx.mergeInto('people').using('x', 'a', 'b').execute()", 'a write builder: mergeInto()'],
      ["await trx.replaceInto('people').values(row).execute()", 'a write builder: replaceInto()'],
      [`await sql\`insert into audit_events (org_id) values (\${org})\`.execute(trx)`, 'SQL with insert into'],
      [`await sql\`UPDATE sessions SET last_seen_at = now() where id = \${id}\`.execute(trx)`, 'SQL with update'],
      [`await sql<{ n: number }>\`delete from jobs where id = \${id}\`.execute(trx)`, 'SQL with delete from'],
      [
        'await sql`merge into people p using x on true when matched then do nothing`.execute(trx)',
        'SQL with merge into',
      ],
      ["await sql.raw('truncate outbox_events').execute(trx)", 'SQL with truncate'],
      [`await sql\`select id from sessions where id = \${id} for update\`.execute(trx)`, 'SQL with for update'],
      [`await sql\`select id from people where id = \${id} for no key update\`.execute(trx)`, 'SQL with for update'],
      [`await sql\`select id from people where id = \${id} for share\`.execute(trx)`, 'SQL with for share'],
      ['await sql`select 1 from devices for key share of devices`.execute(trx)', 'SQL with for share'],
      [`await sql\`select public.set_feature_flag(\${a}, \${b})\`.execute(trx)`, 'SQL with a Hearth function'],
      ["const text = 'insert into people (id) values ($1)'", 'SQL with insert into'],
      ['await withOrg(db, { orgId, system: true }, work)', 'a withOrg() not read only'],
      ['await withOrg(db, { orgId }, work, { readOnly: false })', 'a withOrg() not read only'],
      ['await withOrg(db, { orgId }, work, options)', 'a withOrg() not read only'],
      ["import { appendOutbox } from '#src/outbox/append.ts'", 'an import of #src/outbox/append.ts'],
      ["import { enqueue } from '../jobs/enqueue.ts'", 'an import of ../jobs/enqueue.ts'],
      ["const m = await import('#src/db/privileged.ts')", 'an import of #src/db/privileged.ts'],
      ["export { enqueue } from '#src/jobs/enqueue.ts'", 'an import of #src/jobs/enqueue.ts'],
    ]
    for (const [code, problem] of caught) expect(writeProblems(code), code).toContain(problem)
    // What realtime does pass: a read-only check, and Map and Set operations named like writes.
    for (const code of [
      'await withOrg(db, { orgId, system: true }, work, { readOnly: true, transactionTimeout: "10s" })',
      `await sql\`select s.id, least(s.revoked_at, now()) as ended_at from sessions s where s.id = any(\${ids}::uuid[])\`.execute(trx)`,
      "await trx.selectFrom('teams').select(['id', 'archived_at']).execute()",
      'conns.delete(conn)\nindex.set(key, value)\nupdates.push(update)',
      "import { withOrg } from '#src/db/database.ts'",
      "logger.info({ event: 'ws_closed' }, 'the socket closed')",
    ]) {
      expect(writeProblems(code), code).toEqual([])
    }
  })

  it('every runtime file under apps/server/src/realtime/ is read only', () => {
    expect(sources.map(({ path }) => path)).toContain('apps/server/src/realtime/checks.ts')
    for (const { path, source } of sources) expect(writeProblems(source, path), path).toEqual([])
  })

  it('the checks read in a read-only withOrg() (the only transaction realtime opens beside the pre-org lookup)', () => {
    const checks = sources.find(({ path }) => path === 'apps/server/src/realtime/checks.ts')
    expect(checks?.source).toMatch(/withOrg\(/)
  })
})
