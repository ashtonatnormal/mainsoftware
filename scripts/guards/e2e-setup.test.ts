// The web e2e suite's set-up guard (T21; DESIGN-SHELL §9.3, INTEGRATION.md item 5; K-21–K-28,
// K-38, K-39, K-46, K-69, PRD-53). The suite runs only where its config says (its own ports,
// database, Valkey DB and provider), never inside `npm test`, never writes a PNG outside CI, and
// spends sign-in codes only within PRD-53's windows. This guard reads the Playwright config by
// importing it, the persona table and the screenshot matrix, and the files around them as text,
// and CI's workflows for the check job's runner and its e2e step (ES-05, ES-10).
import { execFileSync } from 'node:child_process'
import { relative } from 'node:path'
import { maskNumber } from '@hearth/shared'
import { describe, expect, it } from 'vitest'
import { codesIn } from '../../apps/web/e2e/support/codes'
import {
  AUTH_DIR,
  E2E_DATABASE,
  E2E_DATABASE_URL,
  E2E_DEPLOY_ENV,
  E2E_ORIGIN,
  E2E_PORTS,
  E2E_VALKEY_DB,
  E2E_VALKEY_URL,
  LOG_DIR,
  STATE_DIR,
  TLS_DIR,
} from '../../apps/web/e2e/support/env'
import { PERSONAS, type Persona, type Stage } from '../../apps/web/e2e/support/personas'
import { VISUAL_SHOTS } from '../../apps/web/e2e/support/visual-matrix'
import config from '../../apps/web/playwright.config'
import { codeOf } from './imports'
import { readRepoFile, repoFiles, root } from './repo-files'
import { type WorkflowJob, workflowJobs } from './workflow'

const WEB = 'apps/web/'
const E2E = `${WEB}e2e/`
const files = repoFiles()
const webPackage = JSON.parse(readRepoFile(`${WEB}package.json`)) as { scripts: Record<string, string> }
const servers = [config.webServer].flat().filter(server => server !== undefined)
const serverNamed = (name: string) => servers.find(server => server.name === name)

// CI's workflows, and the check job, the required check that runs the suite (K-51).
const workflowFiles = files.filter(path => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path))
const ciJobs = workflowJobs(readRepoFile('.github/workflows/ci.yml'))
const checkJob = (): WorkflowJob => {
  const job = ciJobs.find(each => each.id === 'check')
  if (job === undefined) throw new Error('ci.yml has no check job')
  return job
}
// A step that runs the e2e suite, by npm or by Playwright itself.
const runsE2e = (step: string) => /\bnpm run e2e\b|\bplaywright test\b/.test(step)

// Every toHaveScreenshot in a file's code: `expect.soft` or `expect` when it is called on
// `expect(<a plain argument>)`, and `toHaveScreenshot` for any other use (ES-04).
function screenshotCalls(path: string, source: string): string[] {
  return [
    ...codeOf(path, source).matchAll(
      /(expect(?:\.soft)?)\s*\([^()]*\)\s*\.\s*toHaveScreenshot\s*\(|\btoHaveScreenshot\b/g,
    ),
  ].map(match => match[1] ?? 'toHaveScreenshot')
}

// The persona table as a list.
const personas: Persona[] = Object.values(PERSONAS)

// The browser projects that run at the same time; global setup runs before them and session-end
// after (its dependencies), so neither overlaps them.
const CONCURRENT: readonly Stage[] = ['chromium', 'webkit', 'firefox']

// What the seed holds for a person, by the last two digits of their number (db/seed/tembusu.sql:
// +65 8000 00NN belongs to person b0…00NN).
function seedFacts() {
  const seed = readRepoFile('db/seed/tembusu.sql')
  const usersBlock = /insert into public\.users[\s\S]*?unnest\(array\[([^\]]*)\]/.exec(seed)?.[1] ?? ''
  const withAccount = new Set([...usersBlock.matchAll(/'(\d{2})'/g)].map(match => match[1] ?? ''))
  const acknowledgedBlock =
    /insert into public\.notice_acknowledgments[\s\S]*?unnest\(array\[([^\]]*)\]/.exec(seed)?.[1] ?? ''
  const acknowledged = new Set([...acknowledgedBlock.matchAll(/'(\d{2})'/g)].map(match => match[1] ?? ''))
  const numbersBlock = /insert into public\.phone_numbers[\s\S]*?unnest\(array\[([^\]]*)\]/.exec(seed)?.[1] ?? ''
  const onRoster = new Set([...numbersBlock.matchAll(/'(\d{2})'/g)].map(match => match[1] ?? ''))
  const rolesBlock = /insert into public\.role_assignments[\s\S]*?;\n/.exec(seed)?.[0] ?? ''
  const roles = new Map<string, string[]>()
  for (const match of rolesBlock.matchAll(/'b0000000-0000-4000-8000-0000000000(\d{2})', '([a-z_]+)'/g)) {
    const person = match[1] ?? ''
    roles.set(person, [...(roles.get(person) ?? []), match[2] ?? ''])
  }
  return { withAccount, acknowledged, onRoster, roles }
}

// The roles only an Owner grants, which keep a PIN (packages/access PIN_ROLES, D46, AQ-02).
const PIN_ROLE_NAMES = ['owner', 'admin', 'ai_admin', 'leadership', 'dpo', 'compliance_officer']

describe('T21: the web e2e set-up (apps/web/playwright.config.ts, e2e/support)', () => {
  it('ES-01 K-38: apps/web has no test script, so npm test stays browser-free; its e2e script runs playwright test', () => {
    expect(Object.keys(webPackage.scripts)).not.toContain('test')
    expect(webPackage.scripts.e2e).toBe('playwright test')
    const rootPackage = JSON.parse(readRepoFile('package.json')) as { scripts: Record<string, string> }
    // The trailing -- passes the root's own arguments on: npm run e2e -- --project=chromium.
    expect(rootPackage.scripts.e2e).toBe('npm run e2e -w @hearth/web --')
    // npm test and npm run check reach no e2e script.
    expect(rootPackage.scripts.test).not.toMatch(/e2e|playwright/)
    expect(rootPackage.scripts.check).not.toMatch(/e2e|playwright/)
  })

  it('ES-02 K-39 T10: every *.spec.ts sits in apps/web/e2e and matches testDir and testMatch; no *.test.* file sits under e2e/', () => {
    expect(config.testDir).toBe('./e2e')
    expect(config.testMatch).toBe('**/*.spec.ts')
    const specs = files.filter(path => /\.spec\.[cm]?[jt]sx?$/.test(path))
    expect(specs.length).toBeGreaterThanOrEqual(9)
    expect(specs.filter(path => !path.startsWith(E2E) || !path.endsWith('.spec.ts'))).toEqual([])
    expect(files.filter(path => path.startsWith(E2E) && /\.test\.[cm]?[jt]sx?$/.test(path))).toEqual([])
    expect(specs.map(path => path.slice(E2E.length)).sort()).toEqual(
      expect.arrayContaining([
        'a11y.spec.ts',
        'csp.spec.ts',
        'keyboard.spec.ts',
        'live.spec.ts',
        'nfr02.spec.ts',
        'session-end.spec.ts',
        'shell.spec.ts',
        'sign-in.spec.ts',
        'visual.spec.ts',
      ]),
    )
  })

  it('ES-03 K-23 K-69 D-06: the web servers use E2E_PORTS, never an existing server, and the preview a strict port; the api comes first and its command rebuilds hearth_e2e and flushes Valkey DB 9 before it starts; both roles use the e2e database, DEPLOY_ENV test, the e2e Valkey and the fake provider', () => {
    expect(E2E_PORTS).toEqual({ api: 3210, realtime: 3211, preview: 5180 })
    expect(E2E_ORIGIN).toBe('https://localhost:5180')
    expect(E2E_DATABASE).toBe('hearth_e2e')
    expect(E2E_DATABASE_URL).toMatch(/@127\.0\.0\.1:5432\/hearth_e2e$/)
    expect(E2E_VALKEY_URL).toBe(`redis://127.0.0.1:6379/${E2E_VALKEY_DB}`)
    expect(E2E_VALKEY_DB).toBe(9)
    expect(E2E_DEPLOY_ENV).toBe('test')

    expect(servers.map(server => server.name)).toEqual(['api', 'realtime', 'preview'])
    for (const server of servers) expect(server.reuseExistingServer, server.name).toBe(false)
    expect(serverNamed('api')?.url).toBe(`http://127.0.0.1:${E2E_PORTS.api}/ready`)
    expect(serverNamed('realtime')?.url).toBe(`http://127.0.0.1:${E2E_PORTS.realtime}/ready`)
    expect(serverNamed('preview')?.url).toBe(`${E2E_ORIGIN}/`)

    // The api's command: the reset and the flush, in that order, before the server starts.
    const command = serverNamed('api')?.command ?? ''
    const reset = command.indexOf(`HEARTH_DB=${E2E_DATABASE} `)
    const flush = command.indexOf(`valkey-cli -n ${E2E_VALKEY_DB} flushdb`)
    const start = command.indexOf('exec node')
    expect(reset).toBeGreaterThan(-1)
    expect(command.slice(reset)).toMatch(/^HEARTH_DB=hearth_e2e \S+\/scripts\/db-local\.sh reset /)
    expect(flush).toBeGreaterThan(reset)
    expect(start).toBeGreaterThan(flush)
    expect(serverNamed('realtime')?.command).toMatch(/^exec node /)

    for (const [role, port] of [
      ['api', E2E_PORTS.api],
      ['realtime', E2E_PORTS.realtime],
    ] as const) {
      expect(serverNamed(role)?.env, role).toEqual({
        APP_ORIGIN: E2E_ORIGIN,
        DEPLOY_ENV: 'test',
        SMS_PROVIDER: 'fake',
        DATABASE_URL: E2E_DATABASE_URL,
        VALKEY_URL: E2E_VALKEY_URL,
        ROLE: role,
        PORT: String(port),
      })
    }
    // The preview binds its port strictly, so a dev server already there fails the run instead of
    // the run moving to another port.
    const preview = codeOf('preview.ts', readRepoFile(`${E2E}support/preview.ts`))
    expect(preview).toMatch(/port: E2E_PORTS\.preview,\s*strictPort: true/)
    expect(serverNamed('preview')?.command).toBe('node e2e/support/preview.ts')
  })

  it("ES-04 K-26 K-27 D-07: updateSnapshots none except on GitHub's runner (missing, so a failing run writes every actual), ignoreSnapshots off only in CI, every screenshot a soft expect, a snapshot path without {platform}, no retries, forbidOnly", () => {
    const onRunner = !!process.env.CI && process.env.GITHUB_ACTIONS === 'true'
    expect(config.updateSnapshots).toBe(onRunner ? 'missing' : 'none')
    expect(config.ignoreSnapshots).toBe(!process.env.CI)
    const text = codeOf('playwright.config.ts', readRepoFile(`${WEB}playwright.config.ts`))
    expect(text).toMatch(/const CI = !!process\.env\.CI/)
    expect(text).toMatch(/const ON_RUNNER = CI && process\.env\.GITHUB_ACTIONS === ["']true["']/)
    expect(text).toMatch(/updateSnapshots: ON_RUNNER \? ["']missing["'] : ["']none["']/)
    expect(text).toMatch(/ignoreSnapshots: !CI/)
    // A hard expect would stop its test at the first changed shot, and the run would write that
    // one actual only, hiding every later change: every screenshot in the suite is soft.
    expect(screenshotCalls('a.spec.ts', 'await expect.soft(page).toHaveScreenshot("a.png")')).toEqual(['expect.soft'])
    expect(
      screenshotCalls(
        'a.spec.ts',
        'await expect(page).toHaveScreenshot("a.png"); await expect.soft(page.getByRole("main")).toHaveScreenshot()',
      ),
    ).toEqual(['expect', 'toHaveScreenshot'])
    const shots = files
      .filter(path => path.startsWith(E2E) && path.endsWith('.ts'))
      .flatMap(path => screenshotCalls(path, readRepoFile(path)).map(call => `${relative(E2E, path)}: ${call}`))
    expect(shots).toContain('visual.spec.ts: expect.soft')
    expect(shots.filter(shot => !shot.endsWith(': expect.soft'))).toEqual([])
    expect(config.snapshotPathTemplate).toBe('{testDir}/__screenshots__/{testFilePath}/{arg}{ext}')
    expect(config.snapshotPathTemplate).not.toContain('{platform}')
    expect(config.retries).toBe(0)
    expect(config.forbidOnly).toBe(true)
  })

  it('ES-05 K-26 D-07: the check job pins runs-on ubuntu-24.04, the image the visual baselines are made on', () => {
    // The reader found the workflow's jobs (a reformatted file must fail here, not pass unread).
    expect(ciJobs.map(job => job.id)).toEqual(expect.arrayContaining(['check', 'migrations']))
    expect(checkJob().steps.length).toBeGreaterThan(10)
    expect(checkJob().runsOn).toBe('ubuntu-24.04')
  })

  it('ES-06 K-27: every PNG under e2e/__screenshots__ is a VISUAL_SHOTS name in visual.spec.ts, and every VISUAL_SHOTS name is unique', () => {
    expect(VISUAL_SHOTS).toHaveLength(34)
    expect(new Set(VISUAL_SHOTS).size).toBe(VISUAL_SHOTS.length)
    for (const name of VISUAL_SHOTS) expect(name).toMatch(/^[a-z0-9-]+-(?:320|390|1440)-(?:light|dark)\.png$/)
    const baselines = files.filter(path => path.startsWith(`${E2E}__screenshots__/`))
    expect(
      baselines.filter(
        path =>
          !path.startsWith(`${E2E}__screenshots__/visual.spec.ts/`) ||
          !VISUAL_SHOTS.includes(path.slice(`${E2E}__screenshots__/visual.spec.ts/`.length)),
      ),
    ).toEqual([])
    // No PNG anywhere else in the web app (a local run must never leave one behind).
    expect(files.filter(path => path.startsWith(WEB) && path.endsWith('.png') && !baselines.includes(path))).toEqual([])
  })

  it('ES-07 K-21 PRD-53: no number is asked for more than twice a run (otp-n10m allows 3), a run asks for at most 25 codes (otp-ip allows 30), no number is used by two projects that run at once, and every roster persona matches the seed: an account and the notice acknowledged, no PIN role, unless marked', () => {
    const seed = seedFacts()
    // The seed was read: twelve people on the roster, eleven with accounts (Nadia has none).
    expect(seed.onRoster.size).toBe(12)
    expect(seed.withAccount.size).toBe(11)
    expect(seed.acknowledged.size).toBe(11)
    expect(seed.roles.get('01')).toEqual(['owner', 'dpo'])
    const numbers = personas.map(persona => persona.e164)
    expect(new Set(numbers).size).toBe(numbers.length)
    for (const persona of personas) {
      expect(persona.e164, persona.name).toMatch(/^\+658000\d{4}$/)
      const requests = persona.uses.reduce((sum, use) => sum + use.requests, 0)
      expect(requests, persona.name).toBeLessThanOrEqual(2)
      const concurrent = new Set(persona.uses.map(use => use.stage).filter(stage => CONCURRENT.includes(stage)))
      expect(concurrent.size, `${persona.name} in ${[...concurrent].join(', ')}`).toBeLessThanOrEqual(1)
    }
    const total = personas.flatMap(persona => persona.uses).reduce((sum, use) => sum + use.requests, 0)
    expect(total).toBeLessThanOrEqual(25)

    for (const persona of personas) {
      const nn = persona.e164.slice(-2)
      const onRoster = persona.e164.startsWith('+65800000') && seed.onRoster.has(nn)
      expect(persona.roster, `${persona.name}: on the roster`).toBe(onRoster)
      if (!onRoster) continue
      const roles = seed.roles.get(nn) ?? []
      expect(persona.pinRole, `${persona.name}: holds a PIN role`).toBe(
        roles.some(role => PIN_ROLE_NAMES.includes(role)),
      )
      expect(persona.account, `${persona.name}: has an account`).toBe(seed.withAccount.has(nn))
      if (persona.account) expect(seed.acknowledged.has(nn), `${persona.name}: acknowledged`).toBe(true)
    }
    // The marked exceptions: the two PIN-role holders (AQ-02) and the one without an account
    // (ACC-03); every storage-state persona signs in on the code alone and has an account.
    expect(personas.filter(persona => persona.pinRole).map(persona => persona.name)).toEqual(['Priya', 'Wei Ling'])
    expect(personas.filter(persona => persona.roster && !persona.account).map(persona => persona.name)).toEqual([
      'Nadia',
    ])
    for (const use of personas.flatMap(persona => persona.uses.map(each => ({ persona, each })))) {
      if (use.each.stage === 'global-setup') {
        expect(use.persona.pinRole, use.persona.name).toBe(false)
        expect(use.persona.account, use.persona.name).toBe(true)
      }
    }
  })

  it('ES-08 K-46: storage state, logs and certificates live under apps/web/playwright/, which git ignores', () => {
    for (const dir of [AUTH_DIR, LOG_DIR, TLS_DIR]) expect(relative(STATE_DIR, dir)).not.toMatch(/^\.\./)
    expect(relative(root, STATE_DIR)).toBe('apps/web/playwright')
    for (const path of ['apps/web/playwright/.auth/chromium.json', 'apps/web/playwright/logs/api.log']) {
      // check-ignore exits 0 and prints the path when git ignores it.
      expect(execFileSync('git', ['check-ignore', path], { cwd: root, encoding: 'utf8' }).trim()).toBe(path)
    }
    expect(files.filter(path => path.startsWith('apps/web/playwright/'))).toEqual([])
  })

  it("ES-09 K-28: no workflow sets PW_CHROMIUM_EXECUTABLE; the config reads it only from the environment, for Chromium's projects", () => {
    const workflows = files.filter(path => path.startsWith('.github/'))
    expect(workflows.length).toBeGreaterThan(0)
    expect(workflows.filter(path => readRepoFile(path).includes('PW_CHROMIUM_EXECUTABLE'))).toEqual([])
    const text = codeOf('playwright.config.ts', readRepoFile(`${WEB}playwright.config.ts`))
    expect([...text.matchAll(/PW_CHROMIUM_EXECUTABLE/g)]).toHaveLength(2)
    expect(text).toMatch(
      /process\.env\.PW_CHROMIUM_EXECUTABLE \? \{ executablePath: process\.env\.PW_CHROMIUM_EXECUTABLE \} : \{\}/,
    )
    for (const project of config.projects ?? []) {
      const launch = (project.use as { launchOptions?: { executablePath?: string } } | undefined)?.launchOptions
      if (project.use?.browserName === 'chromium') {
        expect(launch?.executablePath, project.name).toBe(process.env.PW_CHROMIUM_EXECUTABLE)
      } else {
        expect(launch, project.name).toBeUndefined()
      }
    }
  })

  it('ES-10 K-51 CL Testing and CI: npm run e2e is a step of the check job, the last but the report upload, after the browser install; the upload runs on failure and never takes playwright/.auth; no other job runs the suite', () => {
    const steps = checkJob().steps
    const e2e = steps.findIndex(step => /^run: npm run e2e$/m.test(step))
    expect(e2e, 'the e2e step').toBeGreaterThan(-1)
    expect(steps.filter(runsE2e)).toEqual([steps[e2e]])
    expect(e2e).toBe(steps.length - 2)
    // Chromium gates everything; WebKit and Firefox run the @smoke tests (OD-07, OD-16).
    const install = steps.findIndex(step =>
      /npx playwright install --with-deps --only-shell chromium webkit firefox\b/.test(step),
    )
    expect(install, 'the browser install').toBeGreaterThan(-1)
    expect(install).toBeLessThan(e2e)
    const upload = steps.at(-1) ?? ''
    expect(upload).toMatch(/^if: failure\(\)$/m)
    expect(upload).toMatch(/^uses: actions\/upload-artifact@v\d+$/m)
    expect(upload).toMatch(/^name: e2e-report$/m)
    // The report, the traces and actual screenshots, and the servers' logs; never the storage
    // state under playwright/.auth, which holds the run's session cookies (K-46).
    expect(upload.split('\n').filter(line => /^apps\//.test(line))).toEqual([
      'apps/web/playwright-report/',
      'apps/web/test-results/',
      'apps/web/playwright/logs/',
    ])
    expect(upload).not.toMatch(/\.auth|include-hidden-files:\s*true/)
    // No other job, in any workflow, runs the suite: it gates merging only as a step of check.
    expect(workflowFiles).toContain('.github/workflows/ci.yml')
    for (const path of workflowFiles) {
      for (const job of workflowJobs(readRepoFile(path))) {
        if (path === '.github/workflows/ci.yml' && job.id === 'check') continue
        expect(job.steps.filter(runsE2e), `${path} ${job.id}`).toEqual([])
      }
    }
  })

  it('ES-11 K-21 PRD-53: no +65 number appears in apps/web/e2e outside support/personas.ts, so every number a spec uses is in the budgeted table', () => {
    const number = /\+\s*65[\s-]*\d|\b658000\d{4}\b|\b8000[\s-]?\d{4}\b/
    // The pattern itself, on planted text.
    expect(number.test("phone: '+6580000003'")).toBe(true)
    expect(number.test("'+65 8000 0003'")).toBe(true)
    expect(number.test("fill('8000 0003')")).toBe(true)
    expect(number.test("'80000003'")).toBe(true)
    expect(number.test('timeout: 80_000')).toBe(false)
    const e2e = files.filter(path => path.startsWith(E2E) && /\.[cm]?[jt]sx?$/.test(path))
    expect(e2e).toContain(`${E2E}support/personas.ts`)
    expect(
      e2e.filter(path => path !== `${E2E}support/personas.ts` && number.test(codeOf(path, readRepoFile(path)))),
    ).toEqual([])
  })

  it('ES-12 K-43 INTEGRATION item 5: the code reader reads the line the fake provider writes (apps/server/src/auth/sms/fake.ts), for its number only', () => {
    // The template createFakeVerify() writes, filled in as it fills it.
    const fake = readRepoFile('apps/server/src/auth/sms/fake.ts')
    const template = /write\(`(\[local only[^`]*)`\)/.exec(fake)?.[1] ?? ''
    expect(template).toMatch(/^\[local only, not a log line\] Hearth code for \$\{maskNumber\(to\)\}: \$\{code\}\\n$/)
    const line = (e164: string, code: string) =>
      template
        .replace(/\$\{maskNumber\(to\)\}/, maskNumber(e164))
        .replace(/\$\{code\}/, code)
        .replace(/\\n$/, '\n')
    const log = `{"level":30,"msg":"a JSON line"}\n${line(PERSONAS.marcus.e164, '123456')}${line(PERSONAS.kelvin.e164, '654321')}`
    expect(codesIn(log, PERSONAS.marcus.e164)).toEqual(['123456'])
    expect(codesIn(log, PERSONAS.kelvin.e164)).toEqual(['654321'])
    expect(codesIn(log, PERSONAS.rachel.e164)).toEqual([])
  })
})
