// The api's test-only overrides stay in tests (TECH-SPEC T20): otpForTests (a shorter floor on
// refused code checks, a breaker policy of its own) and passkeysForTests (the dormant passkeys
// switched on) may be named only by apps/server/src/api.ts, which defines them, the server's
// testing/ folder and tests, and never by main.ts, so production always runs OTP's floor and
// breaker and keeps passkeys off (D46). PASSKEYS_ON is assigned only in auth/policy.ts. Read with
// comments stripped.
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
