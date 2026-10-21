// The SMS providers are built only where they're meant to be (TECH-SPEC T7, T20; PDPA-10):
// - Twilio Verify's host is named only in apps/server/src/auth/sms/twilio.ts (and in docs), so no
//   other code can reach it;
// - only main.ts calls the guarded factories, createTwilioVerify() and createFakeVerify(), which
//   refuse the wrong machine (tests of the factories themselves aside);
// - new TwilioVerify( only in twilio.ts and tests; new FakeVerify( only in fake.ts, the server's
//   testing/ folder and tests (the unguarded classes never reach production);
// - the loopback Twilio fake (testing/fake-twilio.ts) is loaded only by testing/ and tests.
// Calls and imports are read with comments stripped; the host anywhere in a file, comments included.
import { describe, expect, it } from 'vitest'
import { moduleImports, withoutComments } from './imports'
import { isScript, readRepoFile, repoFiles } from './repo-files'

// Built here, so this file never names the host itself.
const HOST = ['verify', 'twilio', 'com'].join('.')
const SERVER = 'apps/server/src/'
const TWILIO = `${SERVER}auth/sms/twilio.ts`
const FAKE = `${SERVER}auth/sms/fake.ts`
const MAIN = `${SERVER}main.ts`
const TESTING = `${SERVER}testing/`
const isTest = (path: string) => /\.test\.tsx?$/.test(path)

const scripts = repoFiles().filter(path => isScript(path) && !path.startsWith('demo/') && !path.startsWith('spike/'))

function where(pattern: RegExp, allowed: (path: string) => boolean): string[] {
  return scripts.filter(path => !allowed(path) && pattern.test(withoutComments(path, readRepoFile(path))))
}

describe('T20 SMS providers are built only where they may run', () => {
  it("names Twilio Verify's host only in twilio.ts", () => {
    const found = repoFiles().filter(
      path => !path.endsWith('.md') && path !== TWILIO && readRepoFile(path).includes(HOST),
    )
    expect(found).toEqual([])
  })

  it('calls the guarded factories only from main.ts and their own tests', () => {
    expect(
      where(/\bcreate(?:Twilio|Fake)Verify\s*\(/, path => [MAIN, TWILIO, FAKE].includes(path) || isTest(path)),
    ).toEqual([])
  })

  it('constructs TwilioVerify only in twilio.ts and tests, and FakeVerify only in fake.ts, testing/ and tests', () => {
    expect(where(/\bnew\s+TwilioVerify\s*\(/, path => path === TWILIO || isTest(path))).toEqual([])
    expect(where(/\bnew\s+FakeVerify\s*\(/, path => path === FAKE || path.startsWith(TESTING) || isTest(path))).toEqual(
      [],
    )
  })

  it('loads the loopback Twilio fake only from testing/ and tests', () => {
    const found = scripts.filter(
      path =>
        !path.startsWith(TESTING) &&
        !isTest(path) &&
        moduleImports(readRepoFile(path), path).some(i => i.specifier !== undefined && /fake-twilio/.test(i.specifier)),
    )
    expect(found).toEqual([])
  })

  it('the patterns catch what they guard against', () => {
    const code = (text: string) => withoutComments('x.ts', text)
    expect(/\bnew\s+TwilioVerify\s*\(/.test(code('const t = new TwilioVerify({})'))).toBe(true)
    expect(/\bcreate(?:Twilio|Fake)Verify\s*\(/.test(code('// createFakeVerify(x)\nconst a = 1'))).toBe(false)
    expect(/\bcreate(?:Twilio|Fake)Verify\s*\(/.test(code('createTwilioVerify(o)'))).toBe(true)
  })
})
