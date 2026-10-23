// The api's test-only overrides stay in tests (TECH-SPEC T20): otpForTests (a shorter floor on
// refused code checks, a breaker policy of its own) and passkeysForTests (the dormant passkeys
// switched on) may be named only by apps/server/src/api.ts, which defines them, the server's
// testing/ folder and tests, and never by main.ts, so production always runs OTP's floor and
// breaker and keeps passkeys off (D46). PASSKEYS_ON is assigned only in auth/policy.ts. Read with
// comments stripped.
//
// The api's transfer gate (C0.9 PD-15, TECH-SPEC T22 item 8) is the same kind of seam: registerApi
// sets Api.transfers to DB_TRANSFERS, which asks transfer_send_state() in each send's transaction
// (C0.9 PD-59), and unit tests assign their own (testing/transfers.ts). So in the server's code,
// outside api.ts, testing/ and tests, nothing assigns a transfers property (api.transfers = …,
// ['transfers'] = …, Object.assign, Object.defineProperty, Reflect.set) or keys one in an object
// literal shaped like an Api (one that spreads another object or sets an Api's own field:
// keyPrefix, afterResponse, appOrigin, names, rp, otp, passkeys, publishRevoked); and main.ts never
// names it, so a permissive check can't stand in for the register in production. The registers' own
// answer, whose transfers are rows, is no Api and passes. Read from the syntax tree, so comments
// don't count.
//
// The gateway's admission is the third (C0.9 PD-45, B-07, C-07): registerRealtime always wires
// NOTICE_ADMISSION unless RealtimeDeps.admissionForTests says otherwise, so only realtime/index.ts
// (which defines it), apps/server/src/testing/ and *.test.ts files may name admissionForTests;
// main.ts never does. Read with comments stripped.
//
// And publishing (C0.9 PD-62, B-14): publish_notice() re-derives a version's sources but takes its
// words as given, so the publish route, which regenerates the draft and holds the DPO's free text
// to AI_COPY first, is its only caller. Outside a comment, only compliance/notice.ts, the server's
// testing/ folder, *.test.ts files and CI's checks against throwaway databases
// (apps/server/scripts/) name it, apart from its signature as a catalogue key (coverage.ts). Read
// with comments stripped.
//
// From C0.9 PR 3a (PD-65, PD-86; design 5.5) the notice's two other writers of the DPO's free text
// are held the same way: set_dpo_contact() records the DPO's business contact and
// record_notice_acknowledgement() an acknowledgement's note, each as given, and only the route
// holds that text to AI_COPY first (the contact through contactProblems(), the note through
// aiCopyIn()), since AI_COPY is a code list a migration can't follow. So outside a comment only
// compliance/routes.ts names set_dpo_contact and only compliance/notice.ts names
// record_notice_acknowledgement, with publish_notice's exceptions (testing/, tests, CI's checks)
// and apart from each one's signature as a catalogue key; and each route runs its check before its
// call.
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
const REALTIME = `${SERVER}realtime/index.ts`
const ADMISSION = /\badmissionForTests\b/
const PUBLISHER = `${SERVER}compliance/notice.ts`
const CI_CHECKS = 'apps/server/scripts/'
// A mention of the function, other than its signature as a catalogue key ('publish_notice(integer,
// text, …)'): a call in any form (public.publish_notice(…), from publish_notice(…), a name passed
// to a query builder).
const PUBLISH_NOTICE = /\bpublish_notice\b(?!\s*\(\s*integer\s*,)/
// The contact's writer and its one caller (C0.9 PD-65), and the recorder's, the publisher's file.
const CONTACT_ROUTE = `${SERVER}compliance/routes.ts`
const SET_DPO_CONTACT = /\bset_dpo_contact\b(?!\s*\(\s*integer\s*,)/
const RECORD_ACKNOWLEDGEMENT = /\brecord_notice_acknowledgement\b(?!\s*\(\s*uuid\s*,)/
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

  it('C0.9 PD-45 B-07 C-07: only realtime/index.ts (which defines it), testing/ and *.test.ts files name admissionForTests; main.ts never does', () => {
    const found = scripts.filter(
      path =>
        path !== REALTIME &&
        !path.startsWith(TESTING) &&
        !isTest(path) &&
        path !== SELF &&
        ADMISSION.test(withoutComments(path, readRepoFile(path))),
    )
    expect(found).toEqual([])
    expect(ADMISSION.test(readRepoFile(MAIN))).toBe(false)
    // registerRealtime falls back to production's hook when a test sets nothing.
    expect(withoutComments(REALTIME, readRepoFile(REALTIME))).toMatch(/deps\.admissionForTests \?\? NOTICE_ADMISSION/)
    expect(ADMISSION.test('registerRealtime(app, { ...deps, admissionForTests: "none" })')).toBe(true)
    expect(ADMISSION.test('const admissionForTestsish = 1')).toBe(false)
  })

  it('C0.9 PD-62 B-14: only the publish route (compliance/notice.ts) calls publish_notice(), outside testing/, tests and CI’s checks', () => {
    const found = scripts.filter(
      path =>
        path !== PUBLISHER &&
        path !== SELF &&
        !path.startsWith(TESTING) &&
        !path.startsWith(CI_CHECKS) &&
        !isTest(path) &&
        PUBLISH_NOTICE.test(withoutComments(path, readRepoFile(path))),
    )
    expect(found).toEqual([])
    expect(withoutComments(PUBLISHER, readRepoFile(PUBLISHER))).toMatch(/from public\.publish_notice\(/)
    for (const call of [
      "pool.query('select * from public.publish_notice($1, $2)', [seen, body])",
      'sql`select notice from publish_notice ($1, $2)`',
      "db.selectFrom(eb => eb.fn('publish_notice', [seen]).as('v'))",
    ]) {
      expect(PUBLISH_NOTICE.test(call), call).toBe(true)
    }
    expect(
      PUBLISH_NOTICE.test(
        "'publish_notice(integer, text, text, text[], integer[], uuid[], integer, text, uuid, inet)'",
      ),
    ).toBe(false)
  })

  // The files outside the guard's exceptions that mention the pattern, comments stripped.
  const callersOf = (pattern: RegExp, allowed: string) =>
    scripts.filter(
      path =>
        path !== allowed &&
        path !== SELF &&
        !path.startsWith(TESTING) &&
        !path.startsWith(CI_CHECKS) &&
        !isTest(path) &&
        pattern.test(withoutComments(path, readRepoFile(path))),
    )

  it('C0.9 PD-65 OD-10: only the contact route (compliance/routes.ts) calls set_dpo_contact(), after contactProblems(), outside testing/, tests and CI’s checks', () => {
    expect(callersOf(SET_DPO_CONTACT, CONTACT_ROUTE)).toEqual([])
    const route = withoutComments(CONTACT_ROUTE, readRepoFile(CONTACT_ROUTE))
    const call = route.indexOf('from public.set_dpo_contact(')
    expect(call).toBeGreaterThan(0)
    // The route holds the body to the shared rules, AI_COPY included, before it calls the function.
    const checked = route.lastIndexOf('contactProblems(body)', call)
    expect(checked).toBeGreaterThan(route.lastIndexOf('export async function setContact(', call))
    for (const caller of [
      "pool.query('select * from public.set_dpo_contact($1, $2)', [seen, title])",
      'sql`select version from set_dpo_contact ($1, $2)`',
      "db.selectFrom(eb => eb.fn('set_dpo_contact', [seen]).as('v'))",
    ]) {
      expect(SET_DPO_CONTACT.test(caller), caller).toBe(true)
    }
    expect(SET_DPO_CONTACT.test("'set_dpo_contact(integer, text, text, text, text, text, uuid, inet)'")).toBe(false)
  })

  it('C0.9 PD-65 OD-19: only the record route (compliance/notice.ts) calls record_notice_acknowledgement(), after aiCopyIn() on the note, outside testing/, tests and CI’s checks', () => {
    expect(callersOf(RECORD_ACKNOWLEDGEMENT, PUBLISHER)).toEqual([])
    const route = withoutComments(PUBLISHER, readRepoFile(PUBLISHER))
    const call = route.indexOf('from public.record_notice_acknowledgement(')
    expect(call).toBeGreaterThan(0)
    const checked = route.lastIndexOf('aiCopyIn(flatText(body.note))', call)
    expect(checked).toBeGreaterThan(route.lastIndexOf('export async function recordAcknowledgement(', call))
    for (const caller of [
      "pool.query('select * from public.record_notice_acknowledgement($1, $2)', [person, notice])",
      'sql`select version from record_notice_acknowledgement ($1)`',
      "db.selectFrom(eb => eb.fn('record_notice_acknowledgement', [person]).as('v'))",
    ]) {
      expect(RECORD_ACKNOWLEDGEMENT.test(caller), caller).toBe(true)
    }
    expect(
      RECORD_ACKNOWLEDGEMENT.test("'record_notice_acknowledgement(uuid, uuid, date, text, text, uuid, inet)'"),
    ).toBe(false)
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
