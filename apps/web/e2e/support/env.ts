// The e2e suite's own environment (T21, D-06; INTEGRATION.md item 5). Everything here is fixed, so
// a run never meets the developer's stack: its own ports (dev keeps 3000, 3001 and 5173, and
// scripts/check-server.sh its own), its own database, hearth_e2e, rebuilt by every run, Valkey DB 9,
// flushed by every run, and DEPLOY_ENV test, which puts every Valkey key and channel under h:test:
// (apps/server/src/auth/valkey-keys.ts). The app is served over HTTPS on localhost, because
// __Host- cookies on http://localhost are unverified in WebKit and Firefox (K-29).
//
// Every path is absolute, resolved from this file, so the working directory never matters:
// `npx playwright test -c apps/web/playwright.config.ts` from the root behaves like `npm run e2e`.
// The config, the preview launcher, global setup, the specs and scripts/guards/e2e-setup.test.ts
// import it.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const E2E_PORTS = { api: 3210, realtime: 3211, preview: 5180 } as const
export const E2E_ORIGIN = `https://localhost:${E2E_PORTS.preview}`
export const E2E_DATABASE = 'hearth_e2e'
// The local login scripts/db-local.sh gives hearth_app (the password .env.example's URLs use; not a
// secret: the database is bound to 127.0.0.1 and holds only the seed's made-up data).
export const E2E_DATABASE_URL = `postgres://hearth_app:hearth-local@127.0.0.1:5432/${E2E_DATABASE}`
export const E2E_VALKEY_DB = 9
export const E2E_VALKEY_URL = `redis://127.0.0.1:6379/${E2E_VALKEY_DB}`
export const E2E_DEPLOY_ENV = 'test'

const here = dirname(fileURLToPath(import.meta.url))
export const WEB_DIR = resolve(here, '../..')
export const REPO_DIR = resolve(WEB_DIR, '../..')
export const SERVER_DIR = resolve(REPO_DIR, 'apps/server')
// Git-ignored (.gitignore: apps/web/playwright/), and outside Playwright's outputDir, which each run
// empties: storage state, the servers' logs (which hold the fake provider's codes) and the TLS pair.
export const STATE_DIR = resolve(WEB_DIR, 'playwright')
export const AUTH_DIR = resolve(STATE_DIR, '.auth')
export const LOG_DIR = resolve(STATE_DIR, 'logs')
export const TLS_DIR = resolve(STATE_DIR, 'tls')
export const API_LOG = resolve(LOG_DIR, 'api.log')
export const REALTIME_LOG = resolve(LOG_DIR, 'realtime.log')
export const DIST_DIR = resolve(WEB_DIR, 'dist')

// The storage state global setup saves for a browser project's persona.
export const stateFile = (project: string) => resolve(AUTH_DIR, `${project}.json`)
