// The cross-site request check (CLAUDE.md, Security and privacy). Every state change from a
// browser must come from the app's own origin, so one hook at the root refuses any request that
// isn't a GET or HEAD unless its Origin header is exactly the app origin. A missing or "null"
// Origin is refused too, with one exception: WebKit's same-origin CSP report (isSameOriginReport).
// The WebSocket upgrade handler (realtime/socket.ts) calls isAppOrigin before accepting. Provider
// webhooks (LiveKit, SMS) will be exempt too, and they verify the provider's signature instead;
// none exist yet.
import { CSP_REPORT_PATH } from '@hearth/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { pathOf } from '#src/logger.ts'

const SAFE_METHODS = new Set(['GET', 'HEAD'])

export function isAppOrigin(origin: string | string[] | undefined, appOrigin: string): boolean {
  return typeof origin === 'string' && origin === appOrigin
}

// The media type of a Content-Type header, without its parameters, in lower case.
function mediaTypeOf(contentType: string | undefined): string | undefined {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase()
}

// The one exception (owner, 21 Oct 2026; TECH-SPEC T21 item 9). WebKit sends every report-uri
// report with Origin "null", whatever the Referrer-Policy: its PingLoader stamps an opaque Origin on
// the report before the request's own Origin step runs. So Safari's CSP reports, from every iPhone
// and iPad browser among them, would never reach the log. A POST of application/csp-report to
// exactly CSP_REPORT_PATH (no trailing slash, query string or other spelling) with Origin "null"
// passes when Sec-Fetch-Site is same-origin: the browser sets that header from the page's own
// origin, and no page can set or change it, so a page on another site still can't make a browser
// post here. The route reads no session, changes nothing and stores nothing (web/csp-report.ts).
function isSameOriginReport(request: FastifyRequest): boolean {
  const { headers } = request
  return (
    request.method === 'POST' &&
    request.url === CSP_REPORT_PATH &&
    headers.origin === 'null' &&
    headers['sec-fetch-site'] === 'same-origin' &&
    mediaTypeOf(headers['content-type']) === 'application/csp-report'
  )
}

// Registered on the root instance before any route or plugin, so every route inherits it,
// including the not-found handler and routes inside encapsulated plugins.
export function refuseCrossSiteWrites(app: FastifyInstance, appOrigin: string): void {
  app.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return
    if (isAppOrigin(request.headers.origin, appOrigin)) return
    if (isSameOriginReport(request)) return
    request.log.warn({ method: request.method, url: pathOf(request.url) }, 'refused a request from another origin')
    return reply.code(403).send({ error: 'Forbidden' })
  })
}
