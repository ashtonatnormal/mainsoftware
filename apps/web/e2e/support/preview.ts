// The e2e suite's web server (D-04, D-06; T21 items 7 and 11): the built app over HTTPS
// on https://localhost:5180, with the production document headers and CSP from the one builder,
// documentHeaders(E2E_ORIGIN), the same headers C0.12's CloudFront policy will serve. /api goes to
// the suite's api role and /ws to its realtime role, on the same origin as the page, as CloudFront
// will route them (OD-11). Neither proxy entry changes the Origin header, so the server's Origin
// checks see the browser's own (changeOrigin off, as in vite.config.ts).
//
// Playwright starts it as its third web server (playwright.config.ts). It runs under plain Node 24
// (type stripping), so its relative imports name the .ts file, and it imports @hearth/shared, whose
// real path is outside node_modules, as the server does. In order:
// 1. it refuses to start when dist/ is missing or older than any source it was built from, so a
//    local run never passes on an old build (T21 item 11): build first with
//    npm run build -w @hearth/web;
// 2. it makes a throwaway self-signed certificate for localhost with openssl, kept a week under
//    playwright/tls/ (git-ignored), when there is none or it is older than six days;
// 3. it starts Vite's preview server, and closes it on SIGTERM or SIGINT.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { DOCUMENT_CACHE_CONTROL, documentHeaders } from '@hearth/shared'
import { createLogger, type Logger, preview } from 'vite'
import { DIST_DIR, E2E_ORIGIN, E2E_PORTS, REPO_DIR, TLS_DIR, WEB_DIR } from './env.ts'

// What a build of apps/web is made from.
export const BUILD_SOURCES = [
  join(WEB_DIR, 'src'),
  join(WEB_DIR, 'public'),
  join(WEB_DIR, 'index.html'),
  join(WEB_DIR, 'vite.config.ts'),
  join(REPO_DIR, 'packages/shared/src'),
]

// The newest modification time under a file or folder, and the file that has it.
export function newest(path: string): { at: number; path: string } {
  const stat = statSync(path)
  if (!stat.isDirectory()) return { at: stat.mtimeMs, path }
  let best = { at: 0, path }
  for (const entry of readdirSync(path)) {
    const found = newest(join(path, entry))
    if (found.at > best.at) best = found
  }
  return best
}

// Why the build can't be served, or undefined when it can.
export function staleBuild(): string | undefined {
  const index = join(DIST_DIR, 'index.html')
  if (!existsSync(index)) return 'there is no build (apps/web/dist/index.html is missing)'
  const built = statSync(index).mtimeMs
  for (const source of BUILD_SOURCES) {
    if (!existsSync(source)) continue
    const found = newest(source)
    if (found.at > built) return `${relative(REPO_DIR, found.path)} changed after the last build`
  }
  return undefined
}

const CERT_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000

function tlsPair(): { key: Buffer; cert: Buffer } {
  const key = join(TLS_DIR, 'key.pem')
  const cert = join(TLS_DIR, 'cert.pem')
  const fresh = existsSync(key) && existsSync(cert) && Date.now() - statSync(cert).mtimeMs < CERT_MAX_AGE_MS
  if (!fresh) {
    mkdirSync(TLS_DIR, { recursive: true })
    try {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'ec',
          '-pkeyopt',
          'ec_paramgen_curve:P-256',
          '-nodes',
          '-days',
          '7',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:localhost',
          '-keyout',
          key,
          '-out',
          cert,
        ],
        { stdio: 'ignore' },
      )
    } catch {
      throw new Error('The e2e preview needs openssl to make its throwaway localhost certificate; install it.')
    }
  }
  return { key: readFileSync(key), cert: readFileSync(cert) }
}

// Vite's logger at warn, without the lines its WebSocket proxy writes when a browser closes a
// socket it was proxying (every test's context does as it ends): those say only that the other
// side hung up. Every other error still shows.
function quietLogger(): Logger {
  const logger = createLogger('warn')
  const error = logger.error.bind(logger)
  logger.error = (message, options) => {
    const code = (options?.error as NodeJS.ErrnoException | undefined)?.code
    if (message.includes('ws proxy') && (code === 'ECONNRESET' || code === 'EPIPE')) return
    error(message, options)
  }
  return logger
}

async function main(): Promise<void> {
  const stale = staleBuild()
  if (stale !== undefined) {
    console.error(`The e2e preview refuses to serve an old build: ${stale}. Build first: npm run build -w @hearth/web`)
    process.exit(1)
  }
  const server = await preview({
    configFile: false,
    root: WEB_DIR,
    customLogger: quietLogger(),
    build: { outDir: 'dist' },
    preview: {
      host: 'localhost',
      port: E2E_PORTS.preview,
      strictPort: true,
      https: tlsPair(),
      headers: { ...documentHeaders(E2E_ORIGIN), 'Cache-Control': DOCUMENT_CACHE_CONTROL },
      proxy: {
        '/api': { target: `http://127.0.0.1:${E2E_PORTS.api}` },
        '/ws': { target: `ws://127.0.0.1:${E2E_PORTS.realtime}`, ws: true },
      },
    },
  })
  console.log(`e2e preview: ${E2E_ORIGIN}`)
  const stop = () => {
    void server.close().then(() => process.exit(0))
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

// Started as a script (node e2e/support/preview.ts), not when a test imports its checks.
if (import.meta.main) await main()
