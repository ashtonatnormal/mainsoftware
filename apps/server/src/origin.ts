// The cross-site request check (CLAUDE.md, Security and privacy). Every state change from a
// browser must come from the app's own origin, so one hook at the root refuses any request that
// isn't a GET or HEAD unless its Origin header is exactly the app origin. A missing or "null"
// Origin is refused too. The WebSocket upgrade handler (realtime/socket.ts) calls isAppOrigin
// before accepting. Provider webhooks (LiveKit, SMS) will be exempt, and verify the provider's
// signature instead; none exist yet.
//
// The one other exemption is a CSP report with no Origin at all (T21 item 9). Safari sends every
// report that way: WebKit's report-uri POST carries no Origin header (PingLoader's
// sendViolationReport sets none), so the hook refused all of Safari's reports and none was ever
// logged. POST /api/csp-report changes no state, reads no session and logs at most
// CSP_LOG_PER_MINUTE reduced lines (web/csp-report.ts), so letting it through without an Origin
// gives an attacker nothing: a page on another site still sends its own Origin and is refused, and
// a client outside a browser could send the app's Origin anyway. A "null" or foreign Origin, and
// any other path or method without one, are still refused.
import { CSP_REPORT_PATH } from '@hearth/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { pathOf } from '#src/logger.ts'

const SAFE_METHODS = new Set(['GET', 'HEAD'])

export function isAppOrigin(origin: string | string[] | undefined, appOrigin: string): boolean {
  return typeof origin === 'string' && origin === appOrigin
}

// A CSP report that carries no Origin header, as Safari sends every one.
const isReportWithoutOrigin = (request: Pick<FastifyRequest, 'method' | 'url' | 'headers'>): boolean =>
  request.method === 'POST' && pathOf(request.url) === CSP_REPORT_PATH && request.headers.origin === undefined

// Registered on the root instance before any route or plugin, so every route inherits it,
// including the not-found handler and routes inside encapsulated plugins.
export function refuseCrossSiteWrites(app: FastifyInstance, appOrigin: string): void {
  app.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return
    if (isAppOrigin(request.headers.origin, appOrigin)) return
    if (isReportWithoutOrigin(request)) return
    request.log.warn({ method: request.method, url: pathOf(request.url) }, 'refused a request from another origin')
    return reply.code(403).send({ error: 'Forbidden' })
  })
}
