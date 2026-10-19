// POST /api/csp-report (OD-12, T21): where browsers send the content security policy's violation
// reports (the policy's report-uri, packages/shared web-headers.ts). Each report becomes at most
// one warn line of four reduced fields, and nothing is stored. It takes no session and asks no
// can(), since it decides no access (as a code request doesn't), and reaches neither Postgres nor
// Valkey. The lines reach CloudWatch, which C0.9 lists in PDPA-10.
//
// What a line keeps (reduceReport): the directive; what was blocked, as a keyword, an http(s)
// origin or a scheme alone; the page's path on the app origin, with id-like segments replaced; and
// the disposition. Everything else a report carries is dropped: the script sample, the original
// policy, the referrer, the source file, line and column, the status code and every query string.
// A browser extension's URL keeps its scheme only: its host is the extension's id, and Firefox's
// moz-extension id is made per install, so it would single out a person's browser.
//
// The route has its own child scope, whose one body parser takes application/csp-report, the type
// browsers send to a report-uri, as JSON of at most 8 KiB. Every other /api route keeps JSON only,
// and this one takes no other type: not JSON, and not application/reports+json, since the policy
// has no report-to (C-21). The root Origin hook applies with no exemption: a browser's same-origin
// report carries the page's Origin, which Referrer-Policy same-origin keeps from being null. A
// report without it is refused 403 and lost, which is harmless.
//
// The log is capped at 60 reports a minute per process, however many addresses they come from
// (createLogCap). Past the cap a report is answered as usual and not logged, and the first report
// after the minute ends logs one csp_reports_dropped line with the count. The route's request
// lines (incoming, completed) are logged only at warn, as the probes' are, so a flood of reports
// writes no more than the cap allows; the root hook's refusals are logged as for any route.
import type { FastifyInstance } from 'fastify'
import type { LevelWithSilent } from 'pino'
import { z } from 'zod'
import type { Api } from '#src/api.ts'
import { parse } from '#src/http.ts'

// The largest report body read, in bytes; a larger one is refused 400 before it is parsed.
export const CSP_REPORT_LIMIT = 8_192
// Per process: bounds the log even when reports come from many addresses.
export const CSP_LOG_PER_MINUTE = 60

const MINUTE_MS = 60_000
const PATH_MAX = 200
const QUIETER_THAN_WARN: ReadonlySet<string> = new Set(['error', 'fatal', 'silent'])

// Lenient, since browsers add fields of their own: z.object drops every key it doesn't name, so
// nothing but these five can reach reduceReport.
const CspReportBody = z.object({
  'csp-report': z.object({
    'effective-directive': z.string().max(128).optional(),
    'violated-directive': z.string().max(1024).optional(),
    'blocked-uri': z.string().max(4096).optional(),
    'document-uri': z.string().max(4096).optional(),
    disposition: z.string().max(16).optional(),
  }),
})
export type CspReport = z.infer<typeof CspReportBody>

export interface CspReportLog {
  // From effective-directive, else violated-directive's first word (older browsers send the
  // directive with its sources), when it reads /^[a-z-]{1,40}$/; else 'unknown'.
  directive: string
  // 'inline', 'eval', 'wasm-eval', 'data', 'blob' or 'self' as browsers send them; an http or https
  // URL's origin (scheme, host and any port); any other scheme alone (data:…, blob:…,
  // chrome-extension://<id>/… → 'data', 'blob', 'chrome-extension'); else 'other'.
  blocked: string
  // The page's pathname when it is on the app origin, each segment that isn't a plain route word
  // replaced by ':id', cut to 200 characters; any other page, or none, is 'other-origin'.
  path: string
  disposition: 'enforce' | 'report' | 'unknown'
}

const DIRECTIVE = /^[a-z-]{1,40}$/
const KEYWORDS = new Set(['inline', 'eval', 'wasm-eval', 'data', 'blob', 'self'])
// A URL scheme (RFC 3986 §3.1), of at most 32 characters.
const SCHEME = /^([a-z][a-z0-9+.-]{0,31}):/
// A path segment kept as it is: lower-case words joined by single hyphens, as the app's routes
// are (/chats, /sign-in). Anything else (a uuid, a number, a token, upper case, a percent-encoded
// name) reads ':id'. A uuid always holds a digit, its version, so none is a route word.
const ROUTE_WORD = /^[a-z]{1,32}(?:-[a-z]{1,32})*$/
const ROUTE_WORD_MAX = 32

function directiveOf(report: CspReport['csp-report']): string {
  const candidates = [report['effective-directive'], report['violated-directive']?.trim().split(/\s+/, 1)[0]]
  for (const candidate of candidates) {
    const name = candidate?.trim().toLowerCase()
    if (name !== undefined && DIRECTIVE.test(name)) return name
  }
  return 'unknown'
}

function blockedOf(blockedUri: string | undefined): string {
  const value = (blockedUri ?? '').trim()
  const lower = value.toLowerCase()
  if (KEYWORDS.has(lower)) return lower
  const scheme = SCHEME.exec(lower)?.[1]
  if (scheme === undefined) return 'other'
  if (scheme !== 'http' && scheme !== 'https') return scheme
  // The origin alone: no user name, password, path, query or fragment.
  return URL.canParse(value) ? new URL(value).origin : 'other'
}

function segmentOf(segment: string): string {
  return segment === '' || (segment.length <= ROUTE_WORD_MAX && ROUTE_WORD.test(segment)) ? segment : ':id'
}

function pathOf(documentUri: string | undefined, appOrigin: string): string {
  if (documentUri === undefined || !URL.canParse(documentUri)) return 'other-origin'
  const url = new URL(documentUri)
  // APP_ORIGIN is its own URL's origin (config.ts), so the two compare as written.
  if (url.origin !== appOrigin) return 'other-origin'
  return url.pathname.split('/').map(segmentOf).join('/').slice(0, PATH_MAX)
}

// The four fields a report's line keeps, and nothing else (pure).
export function reduceReport(body: CspReport, appOrigin: string): CspReportLog {
  const report = body['csp-report']
  const disposition = report.disposition
  return {
    directive: directiveOf(report),
    blocked: blockedOf(report['blocked-uri']),
    path: pathOf(report['document-uri'], appOrigin),
    disposition: disposition === 'enforce' || disposition === 'report' ? disposition : 'unknown',
  }
}

// At most perMinute takes in each minute, a minute starting at the first take or dropped() call
// after the last one ended; a clock that goes back starts a new one. dropped() answers, once, how
// many takes an ended minute refused (summed over minutes not yet asked about), and undefined when
// there are none. now is a monotonic clock in milliseconds (performance.now in the route).
export function createLogCap(
  now: () => number,
  perMinute: number = CSP_LOG_PER_MINUTE,
): { take(): boolean; dropped(): number | undefined } {
  let start = Number.NEGATIVE_INFINITY
  let taken = 0
  let refused = 0
  let unreported = 0
  const roll = (): void => {
    const time = now()
    if (time >= start && time - start < MINUTE_MS) return
    unreported += refused
    start = time
    taken = 0
    refused = 0
  }
  return {
    take() {
      roll()
      if (taken < perMinute) {
        taken++
        return true
      }
      refused++
      return false
    },
    dropped() {
      roll()
      if (unreported === 0) return undefined
      const count = unreported
      unreported = 0
      return count
    },
  }
}

export function cspReportRoute(api: Api): (scope: FastifyInstance) => Promise<void> {
  // One cap for the process's api scope.
  const cap = createLogCap(() => performance.now())
  return async scope => {
    // This scope's parsers only: the /api scope and every other route keep their JSON parser.
    scope.removeAllContentTypeParsers()
    // Fastify's own JSON parser, as the other routes use, so a prototype-poisoning key is refused as
    // it is there. Malformed or empty JSON is an error with statusCode 400, and a body over the
    // limit one with 413, both answered 400 invalid_request (api.ts isBodyError), never 500.
    scope.addContentTypeParser(
      'application/csp-report',
      { parseAs: 'string', bodyLimit: CSP_REPORT_LIMIT },
      scope.getDefaultJsonParser('error', 'error'),
    )
    // Warn, as app.ts's probes are logged, unless the configured level is quieter still.
    const logLevel = (QUIETER_THAN_WARN.has(scope.log.level) ? scope.log.level : 'warn') as LevelWithSilent
    scope.post(
      '/',
      // Served at /api/csp-report only (CSP_REPORT_PATH), not also with a trailing slash.
      { bodyLimit: CSP_REPORT_LIMIT, logLevel, prefixTrailingSlash: 'no-slash' },
      async (request, reply) => {
        const dropped = cap.dropped()
        if (dropped !== undefined) {
          request.log.warn({ event: 'csp_reports_dropped', count: dropped }, 'CSP reports went unlogged past the cap')
        }
        const body = parse(CspReportBody, request.body)
        if (cap.take()) {
          request.log.warn({ event: 'csp_report', ...reduceReport(body, api.appOrigin) }, 'a page broke the CSP')
        }
        return reply.code(204).send()
      },
    )
  }
}
