// The api's test-only overrides stay in tests (TECH-SPEC T20): otpForTests (a shorter floor on
// refused code checks, a breaker policy of its own) and passkeysForTests (the dormant passkeys
// switched on) may be named only by apps/server/src/api.ts, which defines them, the server's
// testing/ folder and tests, and never by main.ts, so production always runs OTP's floor and
// breaker and keeps passkeys off (D46). PASSKEYS_ON is assigned only in auth/policy.ts. Read with
// comments stripped.
//
// The api's transfer gate (C0.9 PD-15, TECH-SPEC T22 item 8) is the same kind of seam: registerApi
// sets Api.transfers to DB_TRANSFERS, which asks transfer_cleared() in each send's transaction, and
// unit tests assign their own (testing/transfers.ts). So in the server's code, outside api.ts,
// testing/ and tests, nothing assigns a transfers property (api.transfers = …, ['transfers'] = …,
// Object.assign, Object.defineProperty, Reflect.set) or keys one in an object literal shaped like an
// Api (one that spreads another object or sets an Api's own field: keyPrefix, afterResponse,
// appOrigin, names, rp, otp, passkeys, publishRevoked); and main.ts never names it, so a permissive
// check can't stand in for the register in production. The registers' own answer, whose
// transfers are rows, is no Api and passes. Read from the syntax tree, so comments don't count.
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { withoutComments } from './imports'
import { isScript, readRepoFile, repoFiles } from './repo-files'

const SERVER = 'apps/server/src/'
const API = `${SERVER}api.ts`
const MAIN = `${SERVER}main.ts`
const TESTING = `${SERVER}testing/`
const isTest = (path: string) => /\.test\.tsx?$/.test(path)
const OVERRIDE = /\b(?:otpForTests|passkeysForTests|PASSKEYS_ON)\b/
const POLICY = `${SERVER}auth/policy.ts`
const SELF = 'scripts/guards/api-test-overrides.test.ts'
// An assignment or declaration of the switch: `PASSKEYS_ON =`, `PASSKEYS_ON:` (an object key) or a
// `let`/`var`/`const` naming it. A comparison (`===`) isn't one.
const ASSIGNED = /\bPASSKEYS_ON\s*(?:=(?!=)|:)|\b(?:let|var|const)\s+(?:\{[^}]*\b)?PASSKEYS_ON\b/

const scripts = repoFiles().filter(path => isScript(path) && !path.startsWith('demo/') && !path.startsWith('spike/'))

// The field, and an Api's own fields that no other object a server file builds is likely to have.
const TRANSFERS = 'transfers'
const API_FIELDS = new Set([
  'keyPrefix',
  'afterResponse',
  'appOrigin',
  'names',
  'rp',
  'otp',
  'passkeys',
  'publishRevoked',
])
const ASSIGNMENT = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
])

const nameOf = (name: ts.Node | undefined): string | undefined =>
  name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : undefined

// Each place a file sets a transfers property: by assignment, through Object.assign,
// Object.defineProperty or Reflect.set, or as a key of an Api-shaped object literal. One line each,
// "line: what".
function transfersSet(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: string[] = []
  const at = (node: ts.Node, what: string) =>
    found.push(`${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${what}`)
  const keyed = (literal: ts.ObjectLiteralExpression) =>
    literal.properties.some(
      property =>
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        nameOf(property.name) === TRANSFERS,
    )
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && ASSIGNMENT.has(node.operatorToken.kind)) {
      const target = node.left
      if (ts.isPropertyAccessExpression(target) && target.name.text === TRANSFERS) at(node, 'assigns .transfers')
      if (ts.isElementAccessExpression(target) && nameOf(target.argumentExpression) === TRANSFERS) {
        at(node, "assigns ['transfers']")
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = `${node.expression.expression.getText(file)}.${node.expression.name.text}`
      if (['Object.assign', 'Object.defineProperty', 'Object.defineProperties', 'Reflect.set'].includes(callee)) {
        const names = node.arguments.some(
          argument => nameOf(argument) === TRANSFERS || (ts.isObjectLiteralExpression(argument) && keyed(argument)),
        )
        if (names) at(node, `${callee} sets transfers`)
      }
    }
    if (ts.isObjectLiteralExpression(node) && keyed(node)) {
      const apiShaped = node.properties.some(
        property =>
          ts.isSpreadAssignment(property) ||
          (!ts.isSpreadAssignment(property) && API_FIELDS.has(nameOf(property.name) ?? '')),
      )
      if (apiShaped) at(node, 'keys transfers in an Api-shaped object')
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

describe('T20 D46 the api test overrides never reach production', () => {
  it('names otpForTests and passkeysForTests only in api.ts, testing/ and tests', () => {
    const found = scripts.filter(
      path =>
        path !== API &&
        !path.startsWith(TESTING) &&
        !isTest(path) &&
        /\b(?:otpForTests|passkeysForTests)\b/.test(withoutComments(path, readRepoFile(path))),
    )
    expect(found).toEqual([])
  })

  it('D46: assigns PASSKEYS_ON only in auth/policy.ts', () => {
    // This file names the shapes it looks for in its own strings.
    const found = scripts.filter(
      path => path !== POLICY && path !== SELF && ASSIGNED.test(withoutComments(path, readRepoFile(path))),
    )
    expect(found).toEqual([])
    expect(ASSIGNED.test(withoutComments(POLICY, readRepoFile(POLICY)))).toBe(true)
  })

  it('main.ts names no override', () => {
    expect(OVERRIDE.test(readRepoFile(MAIN))).toBe(false)
  })

  it('C0.9 PD-15 T22 item 8: sets Api.transfers only in api.ts, testing/ and tests, and main.ts never names it', () => {
    const found = scripts
      .filter(path => path.startsWith('apps/server/') && path !== API && !path.startsWith(TESTING) && !isTest(path))
      .flatMap(path => transfersSet(path, readRepoFile(path)).map(line => `${path}:${line}`))
    expect(found).toEqual([])
    expect(/\btransfers\b/.test(readRepoFile(MAIN))).toBe(false)
    // registerApi sets it after the deps it spreads, so no dep can stand in for it.
    const api = readRepoFile(API)
    expect(transfersSet(API, api)).toEqual([expect.stringMatching(/keys transfers in an Api-shaped object$/)])
    expect(withoutComments(API, api)).toMatch(/\.\.\.deps,[^}]*\btransfers: DB_TRANSFERS,?\s*\}/)
  })

  it('C0.9 PD-15: the transfers check catches what it guards against, and passes the registers’ answer', () => {
    const caught = [
      'api.transfers = { cleared: async () => true }',
      'api.transfers ??= ALWAYS',
      "api['transfers'] = ALWAYS",
      'const api = { ...deps, transfers: ALWAYS }',
      'const api = { keyPrefix, transfers }',
      'Object.assign(api, { transfers: ALWAYS })',
      "Object.defineProperty(api, 'transfers', { value: ALWAYS })",
      "Reflect.set(api, 'transfers', ALWAYS)",
    ]
    for (const source of caught) expect(transfersSet('x.ts', source), source).toHaveLength(1)
    const passed = [
      'const body = { today, purposes, transfers }',
      'const body = { today, purposes, transfers: rows.map(transferRow) }',
      'if (api.transfers === DB_TRANSFERS) {}',
      'await api.transfers.cleared(trx, provider)',
      'const { transfers } = api',
    ]
    for (const source of passed) expect(transfersSet('x.ts', source), source).toEqual([])
  })

  it('the pattern catches what it guards against', () => {
    expect(OVERRIDE.test('registerApi(app, { ...deps, otpForTests: { verifyFloorMs: 0 } })')).toBe(true)
    expect(OVERRIDE.test('registerApi(app, { ...deps, passkeysForTests: true })')).toBe(true)
    expect(OVERRIDE.test('const otpForTestsish = 1')).toBe(false)
    expect(ASSIGNED.test('export const PASSKEYS_ON = true')).toBe(true)
    expect(ASSIGNED.test('policy.PASSKEYS_ON = true')).toBe(true)
    expect(ASSIGNED.test('vi.mock(policy, () => ({ PASSKEYS_ON: true }))')).toBe(true)
    expect(ASSIGNED.test('expect(PASSKEYS_ON === false)')).toBe(false)
  })
})
