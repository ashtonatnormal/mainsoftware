// The cross-site request check (CLAUDE.md, Security and privacy). Every state change from a
// browser must come from the app's own origin, so one hook at the root refuses any request that
// isn't a GET or HEAD unless its Origin header is exactly the app origin. A missing or "null"
// Origin is refused too. The WebSocket upgrade handler (realtime/socket.ts) calls isAppOrigin
// before accepting. Provider webhooks (LiveKit, SMS) will be exempt, and verify the provider's
// signature instead; none exist yet.
//
// The one other exemption is a CSP report whose Origin is "null" (T21 item 9), which is how
// Safari sends every one: WebKit's report-uri POST (PingLoader's sendViolationReport) gets its
// Origin from FrameLoader's addHTTPOriginIfNeeded with no origin to give, which attaches an opaque
// origin's "null". So the hook refused all of Safari's reports, and none was ever logged.
// POST /api/csp-report changes no state, reads no session and takes only application/csp-report,
// which no form can send and a cross-site fetch can't send without a preflight this hook refuses,
// so another site reaches it from a browser only through its own CSP reports. The route logs a
// report with a "null" Origin only when it is about one of the app's own pages, so those can't
// spend the log's allowance (web/csp-report.ts), and a client outside a browser could send the
// app's Origin anyway. A missing or foreign Origin there, and any other path or method with a
// "null" one, are still refused.
import { CSP_REPORT_PATH } from '@hearth/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { pathOf } from '#src/logger.ts'

const SAFE_METHODS = new Set(['GET', 'HEAD'])

export function isAppOrigin(origin: string | string[] | undefined, appOrigin: string): boolean {
  return typeof origin === 'string' && origin === appOrigin
}

// A CSP report whose Origin is "null", as Safari sends every one.
const isSafariReport = (request: Pick<FastifyRequest, 'method' | 'url' | 'headers'>): boolean =>
  request.method === 'POST' && pathOf(request.url) === CSP_REPORT_PATH && request.headers.origin === 'null'

// Registered on the root instance before any route or plugin, so every route inherits it,
// including the not-found handler and routes inside encapsulated plugins.
export function refuseCrossSiteWrites(app: FastifyInstance, appOrigin: string): void {
  app.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return
    if (isAppOrigin(request.headers.origin, appOrigin)) return
    if (isSafariReport(request)) return
    request.log.warn({ method: request.method, url: pathOf(request.url) }, 'refused a request from another origin')
    return reply.code(403).send({ error: 'Forbidden' })
  })
}
