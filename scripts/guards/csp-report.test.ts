// The CSP report route stays stateless (TECH-SPEC T21 item 9, OD-12). It is the one route the root
// Origin hook lets through with Origin "null" (WebKit's own report, with Sec-Fetch-Site same-origin:
// apps/server/src/origin.ts), which is safe only while the route takes no session, reads no cookie,
// reaches neither Postgres nor Valkey and stores nothing. So this guard reads
// apps/server/src/web/csp-report.ts from TypeScript's syntax tree (comments never count) and fails
// on:
//   - any module it loads beyond the ones it loads today: a new import is a reviewed change;
//   - an identifier naming a cookie, a session, the database, Valkey, the outbox or the job queue;
//   - a read of the api's dependencies other than appOrigin.
// It also holds origin.ts to one exception: CSP_REPORT_PATH named once in its code, inside
// isSameOriginCspReport, which the hook calls once, and every way out of the hook either a pass on
// one of its three conditions (GET or HEAD, the app's Origin, the exception) or the 403. The fixture
// cases prove each check bites.
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { moduleImports } from './imports'
import { readRepoFile } from './repo-files'

const ROUTE = 'apps/server/src/web/csp-report.ts'
const ORIGIN = 'apps/server/src/origin.ts'

// What the route loads, as `<specifier>` or `type <specifier>` for an import erased before it runs.
const ALLOWED_IMPORTS = ['@hearth/shared', 'type fastify', 'type pino', 'zod', 'type #src/api.ts', '#src/http.ts']
// Names that would make the route stateful or tie it to a person.
const FORBIDDEN_NAMES =
  /^(?:cookies?|readCookie|session|sessions|SESSION_COOKIE|withOrg|db|database|valkey|redis|outbox|append|appendEvent|enqueue|privileged)$/i

const parse = (path: string, source: string) =>
  ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

function importsOf(path: string, source: string): string[] {
  return moduleImports(source, path).map(m => `${m.typeOnly ? 'type ' : ''}${m.specifier ?? '<computed>'}`)
}

function forbiddenNames(path: string, source: string): string[] {
  const names: string[] = []
  const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && FORBIDDEN_NAMES.test(node.text))
      names.push(node.text)
    if (ts.isStringLiteralLike(node) && /^(?:cookie|authorization)$/i.test(node.text)) names.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(parse(path, source))
  return names
}

// Every property read off the `api` parameter or variable.
function apiReads(path: string, source: string): string[] {
  const reads: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'api') {
      reads.push(node.name.text)
    }
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'api') {
      reads.push('[computed]')
    }
    // Destructuring the api (const { db } = api) reads every name it binds.
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer?.getText() === 'api'
    ) {
      for (const element of node.name.elements) reads.push(element.propertyName?.getText() ?? element.name.getText())
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(path, source))
  return reads
}

// Where origin.ts's code names CSP_REPORT_PATH (the enclosing function's name, or the import), and
// how many times it calls isSameOriginCspReport.
function originUses(path: string, source: string): { path: string[]; calls: number } {
  const uses: string[] = []
  let calls = 0
  const enclosing = (node: ts.Node): string => {
    for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
      if (ts.isImportDeclaration(at)) return 'import'
      if (ts.isFunctionDeclaration(at) && at.name) return at.name.text
    }
    return 'top level'
  }
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'CSP_REPORT_PATH') uses.push(enclosing(node))
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'isSameOriginCspReport'
    ) {
      calls++
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(path, source))
  return { path: uses, calls }
}

// Every way out of the Origin hook (the function refuseCrossSiteWrites hands to addHook), in order: a
// pass is named by the condition that guards it (a call by its callee, anything else by its text,
// and 'unconditional' when nothing does), the refusal by 'refuse' (a return of reply.…). Nested
// functions are their own, so their returns don't count.
function hookExits(path: string, source: string): string[] {
  const file = parse(path, source)
  const register = file.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'refuseCrossSiteWrites',
  )
  const hook = register?.body?.statements
    .flatMap(statement => (ts.isExpressionStatement(statement) ? [statement.expression] : []))
    .filter(ts.isCallExpression)
    .flatMap(call => call.arguments)
    .find(
      (argument): argument is ts.ArrowFunction | ts.FunctionExpression =>
        ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
    )
  if (hook === undefined) return ['no hook']
  const exits: string[] = []
  const guardOf = (node: ts.Node): string => {
    for (let at: ts.Node = node; at.parent !== undefined && at !== hook; at = at.parent) {
      const parent = at.parent
      if (ts.isIfStatement(parent) && at !== parent.expression) {
        const condition = parent.expression
        const name = ts.isCallExpression(condition) ? condition.expression.getText(file) : condition.getText(file)
        return at === parent.elseStatement ? `else of ${name}` : name
      }
    }
    return 'unconditional'
  }
  const visit = (node: ts.Node): void => {
    if (node !== hook && ts.isFunctionLike(node)) return
    if (ts.isReturnStatement(node)) {
      const refusal = node.expression !== undefined && /^reply\./.test(node.expression.getText(file))
      exits.push(refusal ? 'refuse' : guardOf(node))
    }
    ts.forEachChild(node, visit)
  }
  visit(hook.body)
  return exits
}

describe('T21 item 9: the CSP report route the Origin hook lets through stays stateless', () => {
  it('CG-01 OD-12 T21 item 9: csp-report.ts loads only what it loads today', () => {
    expect(importsOf(ROUTE, readRepoFile(ROUTE)).sort()).toEqual([...ALLOWED_IMPORTS].sort())
    // The check reads the kind of import: the same module loaded for its values is new.
    expect(importsOf('a.ts', "import { buildApp } from '#src/api.ts'")).toEqual(['#src/api.ts'])
    expect(importsOf('a.ts', "import type { Api } from '#src/api.ts'")).toEqual(['type #src/api.ts'])
    expect(importsOf('a.ts', "const m = await import('#src/db/database.ts')")).toEqual(['#src/db/database.ts'])
  })

  it('CG-02 OD-12 T21 item 9: csp-report.ts names no cookie, session, database, Valkey, outbox or queue, and reads only appOrigin from the api', () => {
    const source = readRepoFile(ROUTE)
    expect(forbiddenNames(ROUTE, source)).toEqual([])
    expect([...new Set(apiReads(ROUTE, source))]).toEqual(['appOrigin'])
    // The fixtures each check must catch, and a comment it must not.
    expect(forbiddenNames('a.ts', 'const token = request.cookies.hearth')).toEqual(['cookies'])
    expect(forbiddenNames('a.ts', "const raw = request.headers['cookie']")).toEqual(['cookie'])
    expect(forbiddenNames('a.ts', 'await withOrg(api.db, org, async tx => {})')).toEqual(['withOrg', 'db'])
    expect(forbiddenNames('a.ts', "await valkey.incr('k')")).toEqual(['valkey'])
    expect(forbiddenNames('a.ts', '// reads no session or cookie')).toEqual([])
    expect(apiReads('a.ts', 'api.appOrigin; api.valkey')).toEqual(['appOrigin', 'valkey'])
    expect(apiReads('a.ts', "api['keys']")).toEqual(['[computed]'])
    expect(apiReads('a.ts', 'const { appOrigin, sms } = api')).toEqual(['appOrigin', 'sms'])
  })

  it('CG-03 OD-12 T21 item 9: origin.ts names CSP_REPORT_PATH only in isSameOriginCspReport, which the hook calls once', () => {
    expect(originUses(ORIGIN, readRepoFile(ORIGIN))).toEqual({ path: ['import', 'isSameOriginCspReport'], calls: 1 })
    // A second use of the path, say a prefix match elsewhere in the hook, is caught.
    expect(
      originUses(
        'a.ts',
        "import { CSP_REPORT_PATH } from '@hearth/shared'\nfunction hook() { if (url.startsWith(CSP_REPORT_PATH)) return }",
      ),
    ).toEqual({ path: ['import', 'hook'], calls: 0 })
  })

  it('CG-04 OD-12 T21 item 9: the Origin hook passes a request only on GET or HEAD, the app’s Origin or the exception, and otherwise refuses it', () => {
    const expected = ['SAFE_METHODS.has', 'isAppOrigin', 'isSameOriginCspReport', 'refuse']
    expect(hookExits(ORIGIN, readRepoFile(ORIGIN))).toEqual(expected)
    // The fixtures: the hook as it is, then each way a second pass could slip in.
    const hook = (body: string) =>
      `export function refuseCrossSiteWrites(app, appOrigin) {\n  app.addHook('onRequest', async (request, reply) => {\n${body}\n  })\n}`
    const today = [
      'if (SAFE_METHODS.has(request.method)) return',
      'if (isAppOrigin(origin, appOrigin)) return',
      'if (isSameOriginCspReport({ method: request.method, route, origin, fetchSite })) return',
      "return reply.code(403).send({ error: 'Forbidden' })",
    ]
    expect(hookExits('a.ts', hook(today.join('\n')))).toEqual(expected)
    const extra = [...today.slice(0, 3), "if (origin === 'null') return", ...today.slice(3)]
    expect(hookExits('a.ts', hook(extra.join('\n')))).toEqual([...expected.slice(0, 3), "origin === 'null'", 'refuse'])
    const braced = [...today.slice(0, 3), "if (request.url === '/x') { return }", ...today.slice(3)]
    expect(hookExits('a.ts', hook(braced.join('\n')))).toContain("request.url === '/x'")
    expect(hookExits('a.ts', hook(['return', ...today].join('\n')))[0]).toBe('unconditional')
    const elsePass = ['if (isAppOrigin(origin, appOrigin)) {} else return', ...today]
    expect(hookExits('a.ts', hook(elsePass.join('\n')))[0]).toBe('else of isAppOrigin')
    // A callback inside the hook has returns of its own, which aren't the hook's.
    const nested = ['const keep = [1].filter(n => { return n > 0 })', ...today]
    expect(hookExits('a.ts', hook(nested.join('\n')))).toEqual(expected)
  })
})
