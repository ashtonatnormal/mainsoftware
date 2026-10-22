// The cross-site request check (CLAUDE.md, Security and privacy). Every state change from a
// browser must come from the app's own origin, so one hook at the root refuses any request that
// isn't a GET or HEAD unless its Origin header is exactly the app origin. A missing or "null"
// Origin is refused too, with one exception (isSameOriginCspReport, TECH-SPEC T21 item 9): WebKit,
// the engine of Safari and of every browser on iPhone, sends a page's CSP report with Origin "null"
// whatever the page's referrer policy, so POST /api/csp-report, matched as a route, is let through
// with Origin "null" when Sec-Fetch-Site is same-origin. The browser sets Sec-Fetch-Site and no page
// can, so a report, form, fetch or beacon from another site (cross-site) or from the user-content
// origin (same-site) is still refused. The route stores nothing and reads no session
// (web/csp-report.ts). The WebSocket upgrade handler (realtime/socket.ts) calls isAppOrigin, with
// no exception, before accepting. Provider webhooks (LiveKit, SMS) will be the only other
// exemption, and they verify the provider's signature instead; none exist yet.
import { CSP_REPORT_PATH } from '@hearth/shared'
import type { FastifyInstance } from 'fastify'
import { pathOf } from '#src/logger.ts'

const SAFE_METHODS = new Set(['GET', 'HEAD'])
// The values of Sec-Fetch-Site (Fetch Metadata).
const FETCH_SITES: ReadonlySet<string> = new Set(['same-origin', 'same-site', 'cross-site', 'none'])

export function isAppOrigin(origin: string | string[] | undefined, appOrigin: string): boolean {
  return typeof origin === 'string' && origin === appOrigin
}

export interface ReportRequest {
  method: string
  // The route Fastify matched (request.routeOptions.url), never the raw URL: undefined when no
  // route matched.
  route: string | undefined
  origin: string | string[] | undefined
  fetchSite: string | string[] | undefined
}

// WebKit's own CSP report, the hook's one exception: a POST to the CSP report route with Origin
// exactly "null" and Sec-Fetch-Site exactly same-origin, which Safari sends from 16.4, the pilot's
// floor. Any other method, route, Origin or Sec-Fetch-Site, a duplicate header included, is not.
export function isSameOriginCspReport({ method, route, origin, fetchSite }: ReportRequest): boolean {
  return method === 'POST' && route === CSP_REPORT_PATH && origin === 'null' && fetchSite === 'same-origin'
}

// What kind of Origin a refused request carried, never its value: another site's origin, or an
// extension's per-install id, could single out a person's browser.
export function originKind(origin: string | string[] | undefined): 'absent' | 'null' | 'other' {
  if (origin === undefined) return 'absent'
  return origin === 'null' ? 'null' : 'other'
}

// Sec-Fetch-Site as one of its four values, else 'absent' or 'other'.
export function fetchSiteOf(fetchSite: string | string[] | undefined): string {
  if (fetchSite === undefined) return 'absent'
  return typeof fetchSite === 'string' && FETCH_SITES.has(fetchSite) ? fetchSite : 'other'
}

// Registered on the root instance before any route or plugin, so every route inherits it,
// including the not-found handler and routes inside encapsulated plugins.
export function refuseCrossSiteWrites(app: FastifyInstance, appOrigin: string): void {
  app.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return
    const { origin, 'sec-fetch-site': fetchSite } = request.headers
    if (isAppOrigin(origin, appOrigin)) return
    if (isSameOriginCspReport({ method: request.method, route: request.routeOptions.url, origin, fetchSite })) return
    request.log.warn(
      {
        event: 'origin_refused',
        method: request.method,
        url: pathOf(request.url),
        originKind: originKind(origin),
        fetchSite: fetchSiteOf(fetchSite),
      },
      'refused a request from another origin',
    )
    return reply.code(403).send({ error: 'Forbidden' })
  })
}
