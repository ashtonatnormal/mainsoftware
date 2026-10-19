// The api's test-only overrides stay in tests (TECH-SPEC T20): otpForTests (a shorter floor on
// refused code checks, a breaker policy of its own) may be named only by apps/server/src/api.ts,
// which defines it, the server's testing/ folder and tests, and never by main.ts, so production
// always runs OTP's floor and breaker (D46). Read with comments stripped.
import { describe, expect, it } from 'vitest'
import { withoutComments } from './imports'
import { isScript, readRepoFile, repoFiles } from './repo-files'

const SERVER = 'apps/server/src/'
const API = `${SERVER}api.ts`
const MAIN = `${SERVER}main.ts`
const TESTING = `${SERVER}testing/`
const isTest = (path: string) => /\.test\.tsx?$/.test(path)
const OVERRIDE = /\b(?:otpForTests)\b/

const scripts = repoFiles().filter(path => isScript(path) && !path.startsWith('demo/') && !path.startsWith('spike/'))

describe('T20 the api test overrides never reach production', () => {
  it('names otpForTests only in api.ts, testing/ and tests', () => {
    const found = scripts.filter(
      path =>
        path !== API &&
        !path.startsWith(TESTING) &&
        !isTest(path) &&
        OVERRIDE.test(withoutComments(path, readRepoFile(path))),
    )
    expect(found).toEqual([])
  })

  it('main.ts names no override', () => {
    expect(OVERRIDE.test(readRepoFile(MAIN))).toBe(false)
  })

  it('the pattern catches what it guards against', () => {
    expect(OVERRIDE.test('registerApi(app, { ...deps, otpForTests: { verifyFloorMs: 0 } })')).toBe(true)
    expect(OVERRIDE.test('const otpForTestsish = 1')).toBe(false)
  })
})
