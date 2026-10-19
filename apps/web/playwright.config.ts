// The web app's end-to-end suite (T21; BUILD-PLAN C0.8, DESIGN-SHELL §9.4, INTEGRATION.md item 5).
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
// others share, runs after them all (K-21). Snapshots: local runs never write or compare PNGs, and
// CI compares against baselines made only on its own runner (D-07).
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

// A Chromium of the machine's own, when PW_CHROMIUM_EXECUTABLE names one (cloud sessions only).
const localChromium = () =>
  process.env.PW_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PW_CHROMIUM_EXECUTABLE } : {}

// Shared by both server roles: their own database, Valkey keys and provider (D-06, K-43).
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
  // D-07: local runs never write or compare PNGs; CI never writes them either, and fails on a
  // missing or changed one (adopt-baselines.ts takes them from CI's artifact).
  updateSnapshots: 'none',
  ignoreSnapshots: !CI,
  forbidOnly: true,
  retries: 0,
  fullyParallel: true,
  workers: CI ? 2 : undefined,
  timeout: 60_000,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './e2e/global-setup.ts',
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.005,
      threshold: 0.2,
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
    // Ends sessions, so it runs only after every project that uses them (K-21).
    {
      name: 'chromium-session-end',
      testMatch: /session-end\.spec\.ts/,
      dependencies: ['chromium', 'webkit', 'firefox'],
      use: { browserName: 'chromium', launchOptions: localChromium() },
    },
  ],
})
