// The web app's end-to-end suite (BUILD-PLAN C0.8, T21 item 11).
// `npm run e2e` (this workspace) builds nothing: build first (npm run build -w @hearth/web); the
// preview refuses a build older than its sources.
//
// Three web servers, which Playwright starts one after another, each awaited, and all before global
// setup (so the api's command is the one place that can rebuild the database before anything uses
// it):
// 1. api: rebuilds hearth_e2e (migrations, the Tembusu seed, local logins; scripts/db-local.sh with
//    HEARTH_DB), flushes Valkey DB 9, then runs the api role from source on 3210;
// 2. realtime: the realtime role from source on 3211;
// 3. preview: the built app over HTTPS on https://localhost:5180 with the production headers and
//    CSP, proxying /api and /ws to the two (e2e/support/preview.ts).
// Both server roles run with DEPLOY_ENV test (Valkey keys and channels under h:test:) and the fake
// SMS provider, which prints each code to stderr, masked, never to the JSON log (T20); the specs
// read it from playwright/logs/api.log (e2e/support/codes.ts). Variables set here win over
// .env.example, since Node never overrides a set variable, and a developer's .env isn't read.
//
// Projects: Chromium runs every spec but session-end; WebKit and Firefox run the @smoke tests
// (NFR-01, OD-07, OD-16: CI is their gate); chromium-session-end, which ends the sessions the
// others share, runs after them all (T21 item 11). Snapshots: local runs never write or compare
// PNGs, and CI compares against baselines made only on its own runner (D-07). One failing CI run
// writes the actual screenshot of every shot that is missing or changed, all 34 on a first run, so
// one artifact holds every baseline to adopt (e2e/support/adopt-baselines.ts).
//
// Cloud sessions can't download Playwright's browsers. There, PW_CHROMIUM_EXECUTABLE points at a
// Chromium already on the machine, an unsupported pairing for functional local runs only:
//   PW_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium npm run e2e -- --project=chromium
//   PW_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium npm run e2e -- --project=chromium-session-end --no-deps
// CI never sets it (scripts/guards/e2e-setup.test.ts, ES-09).
import { defineConfig } from '@playwright/test'
import {
  E2E_DATABASE,
  E2E_DATABASE_URL,
  E2E_DEPLOY_ENV,
  E2E_ORIGIN,
  E2E_PORTS,
  E2E_VALKEY_DB,
  E2E_VALKEY_URL,
  LOG_DIR,
  REPO_DIR,
  SERVER_DIR,
  stateFile,
} from './e2e/support/env.ts'

const CI = !!process.env.CI
// GitHub's runner itself, not a local run with CI set (where a written baseline would reach the
// auto-push hook, T21 item 11).
const ON_RUNNER = CI && process.env.GITHUB_ACTIONS === 'true'

// A Chromium of the machine's own, when PW_CHROMIUM_EXECUTABLE names one (cloud sessions only).
const localChromium = () =>
  process.env.PW_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PW_CHROMIUM_EXECUTABLE } : {}

// Shared by both server roles: their own database, Valkey keys and provider (D-06, T21 item 13).
const serverEnv = {
  APP_ORIGIN: E2E_ORIGIN,
  DEPLOY_ENV: E2E_DEPLOY_ENV,
  SMS_PROVIDER: 'fake',
  DATABASE_URL: E2E_DATABASE_URL,
  VALKEY_URL: E2E_VALKEY_URL,
}

const startRole = (log: string) => `exec node --env-file=${REPO_DIR}/.env.example src/main.ts >> ${LOG_DIR}/${log} 2>&1`

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  outputDir: './test-results',
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  // D-07: local runs never write or compare PNGs (ignoreSnapshots), and CI fails on a missing or
  // changed one. Playwright takes no screenshot at all for a missing baseline under 'none', so on
  // the runner 'missing' writes the actual (and a copy into the runner's own checkout, thrown away
  // with the runner and never compared again: retries 0, each name taken once) and fails the test
  // without stopping it. visual.spec.ts makes every shot soft, so a changed one doesn't stop the
  // test either. adopt-baselines.ts takes the `-actual` files from CI's artifact.
  updateSnapshots: ON_RUNNER ? 'missing' : 'none',
  ignoreSnapshots: !CI,
  forbidOnly: true,
  retries: 0,
  fullyParallel: true,
  // 2 workers in every run, never Playwright's default of half the cores (T21 item 11). Every
  // signed-in page a project opens shares its persona's one session and opens a /ws socket, and
  // realtime refuses a 9th socket on one session (SOCKETS_PER_SESSION,
  // apps/server/src/auth/policy.ts) with a 429 the page guard fails on. A test keeps at most 3
  // signed-in pages open (SH-08, SH-09), so 2 workers hold at most 6, leaving room for sockets
  // still closing from tests just finished (ES-14).
  workers: 2,
  timeout: 60_000,
  // In CI the whole run (web servers and global setup included) stops and fails at 15 minutes, well
  // inside the check job's timeout-minutes in ci.yml, which also holds every step before the suite
  // and the report upload after it. Actions have no timeout of their own, so a build that never
  // shows what the specs wait for would hold each of the 76 tests its full 60 s on 2 workers,
  // about 38 minutes, which with the steps before it comes within minutes of the job's limit, or
  // past it on a slow runner, where GitHub would cancel the job instead, stopping the run before it
  // writes its report: the upload runs on a cancelled job too, but with only what the run had
  // written by then (ES-13).
  // Not maxFailures: a first run fails every visual test by design and must write all their actuals.
  globalTimeout: CI ? 15 * 60_000 : undefined,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './e2e/global-setup.ts',
  // VS-01 lets through only rounding noise, so a design token's colour change fails it, not only
  // moved text or shapes (T21 item 11). pixelmatch counts a pixel as changed when its colour
  // difference (YIQ) passes 35215 × threshold². Playwright's default of 0.2 passes a grey shift of
  // up to 52 levels in 255, and the re-theme (#23) passed four old-look baselines with it. Even 0.02
  // passes 5 levels: on the runner, --bg moved by 3 failed every light shot at 0.01 and none at
  // 0.02. At 0.005, a colour moved by 2 levels in every channel fails (or by 2 to 4 in one channel
  // alone), and ±1 in any channel passes. A probe of the pinned runner, on more than one CPU, found
  // two kinds of drift from run to run: a few edge pixels drawn differently (up to 17 in a shot),
  // which pixelmatch takes for anti-aliasing and skips at any threshold, and now and then 1 to 3
  // other pixels off by about one level, which 0.005 lets through. ES-18 holds the threshold to
  // both bounds against every token with Playwright's own comparator. No pixel allowance and no
  // ratio: 0.5% of a 1440 × 900 shot is 6,480 pixels, more than a button, a hairline or a line of
  // error text. A Playwright upgrade that changes how Chromium draws fails VS-01, and its baselines
  // are adopted again, as for a new runner image (D-07).
  expect: {
    toHaveScreenshot: {
      maxDiffPixels: 0,
      threshold: 0.005,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  use: {
    baseURL: E2E_ORIGIN,
    ignoreHTTPSErrors: true,
    locale: 'en-GB',
    timezoneId: 'Asia/Singapore',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: [
    {
      name: 'api',
      cwd: SERVER_DIR,
      url: `http://127.0.0.1:${E2E_PORTS.api}/ready`,
      timeout: 120_000,
      reuseExistingServer: false,
      command:
        `mkdir -p ${LOG_DIR} && : > ${LOG_DIR}/api.log && : > ${LOG_DIR}/realtime.log` +
        ` && HEARTH_DB=${E2E_DATABASE} ${REPO_DIR}/scripts/db-local.sh reset >> ${LOG_DIR}/api.log 2>&1` +
        ` && docker compose -f ${REPO_DIR}/docker-compose.yml exec -T valkey valkey-cli -n ${E2E_VALKEY_DB} flushdb >/dev/null` +
        ` && ${startRole('api.log')}`,
      env: { ...serverEnv, ROLE: 'api', PORT: String(E2E_PORTS.api) },
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    },
    {
      name: 'realtime',
      cwd: SERVER_DIR,
      url: `http://127.0.0.1:${E2E_PORTS.realtime}/ready`,
      timeout: 60_000,
      reuseExistingServer: false,
      command: startRole('realtime.log'),
      env: { ...serverEnv, ROLE: 'realtime', PORT: String(E2E_PORTS.realtime) },
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    },
    {
      name: 'preview',
      command: 'node e2e/support/preview.ts',
      url: `${E2E_ORIGIN}/`,
      ignoreHTTPSErrors: true,
      timeout: 60_000,
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
  ],
  projects: [
    {
      name: 'chromium',
      testIgnore: /session-end\.spec\.ts/,
      use: { browserName: 'chromium', storageState: stateFile('chromium'), launchOptions: localChromium() },
    },
    {
      name: 'webkit',
      grep: /@smoke/,
      testIgnore: /session-end\.spec\.ts/,
      use: { browserName: 'webkit', storageState: stateFile('webkit') },
    },
    {
      name: 'firefox',
      grep: /@smoke/,
      testIgnore: /session-end\.spec\.ts/,
      use: { browserName: 'firefox', storageState: stateFile('firefox') },
    },
    // Ends sessions, so it runs only after every project that uses them (T21 item 11).
    {
      name: 'chromium-session-end',
      testMatch: /session-end\.spec\.ts/,
      dependencies: ['chromium', 'webkit', 'firefox'],
      use: { browserName: 'chromium', launchOptions: localChromium() },
    },
  ],
})
