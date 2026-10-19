// The one builder of the web app's document headers and Content Security Policy (T21 item 7, D-04,
// OD-40). Vite's dev server, the e2e preview and, from C0.12, CloudFront's response-headers policy
// all serve documentHeaders(appOrigin), so what the tests see is what people get. Every source is
// derived from the app's own origin: the browser talks to nothing else, so no CDN or model host can
// enter the policy (R-59–R-61). scripts/guards/csp.test.ts parses the result against its own
// allow-list, and a new source (C0.13's RUM endpoint, C2's LiveKit host) changes both in one PR.
//
// The server loads this package on Node (T2) and the package compiles with no DOM or Node types,
// so the origin is read with a regular expression, not the URL global.

export const CSP_REPORT_PATH = '/api/csp-report'

// CloudFront's limit on the Content-Security-Policy value of a response-headers policy (OD-11).
export const CLOUDFRONT_CSP_MAX = 1783

// index.html is revalidated on every load, so a reload after a 4426 (a newer build) gets the new
// bundle; /assets/* are content-hashed, so they never change (T21 item 8).
export const DOCUMENT_CACHE_CONTROL = 'no-cache'
export const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable'

export interface AppOrigin {
  scheme: 'http' | 'https'
  // The host as the browser serialises it: lower case, an IPv6 address in brackets.
  host: string
  // Absent for the scheme's default port, which an origin never names.
  port?: number
  // On this machine (localhost, 127.0.0.1 or [::1]): the only hosts plain http is allowed for.
  loopback: boolean
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const ORIGIN = new RegExp(`^(https?)://(localhost|127\\.0\\.0\\.1|\\[::1\\]|${LABEL}(?:\\.${LABEL})*)(?::(\\d{1,5}))?$`)
const DEFAULT_PORTS = { http: 80, https: 443 } as const

// Reads an origin such as https://hearth.example.com: a scheme, a host and an optional port, as
// the browser sends it in the Origin header, which the server compares with APP_ORIGIN exactly
// (apps/server/src/config.ts). So it refuses what the browser would never send: a path, a trailing
// slash, a user name, upper case, a default or zero-padded port, and a host the browser would
// rewrite as an IPv4 address. Plain http is allowed only on this machine: anywhere else every
// request would cross the network in the clear, and the browser would refuse the Secure session
// cookie anyway.
export function parseAppOrigin(appOrigin: string): AppOrigin {
  const match = ORIGIN.exec(appOrigin)
  if (!match) {
    throw new Error(
      `${JSON.stringify(appOrigin)} is not an origin: write it as https://host or https://host:port, in lower case, with no path, trailing slash or user name`,
    )
  }
  const scheme = match[1] as 'http' | 'https'
  const host = match[2] ?? ''
  const loopback = LOOPBACK_HOSTS.includes(host)
  if (host.length > 253) throw new Error(`${JSON.stringify(appOrigin)} has a host longer than 253 characters`)
  // The URL parser reads a host whose last label is a number as an IPv4 address and rewrites it.
  if (!loopback && /(?:^|\.)(?:\d+|0x[0-9a-f]*)$/.test(host)) {
    throw new Error(`${JSON.stringify(appOrigin)} names an IP address: the app's origin is a host name`)
  }
  if (scheme === 'http' && !loopback) {
    throw new Error(`${JSON.stringify(appOrigin)} uses http on a host other than this machine: use https`)
  }
  const portText = match[3]
  if (portText === undefined) return { scheme, host, loopback }
  const port = Number(portText)
  if (!/^[1-9]\d*$/.test(portText) || port > 65_535 || port === DEFAULT_PORTS[scheme]) {
    throw new Error(
      `${JSON.stringify(appOrigin)} has a port the browser would not send: use 1 to 65535, without leading zeros, and leave out ${DEFAULT_PORTS[scheme]} for ${scheme}`,
    )
  }
  return { scheme, host, port, loopback }
}

// The realtime gateway's origin: /ws on the app's own host (OD-11, TECH-SPEC T19 item 16), named
// explicitly because older WebKit's reading of 'self' for wss: is unverified. ws: only for http on
// this machine.
function socketOrigin({ scheme, host, port }: AppOrigin): string {
  return `${scheme === 'https' ? 'wss' : 'ws'}://${host}${port === undefined ? '' : `:${port}`}`
}

// The policy as directives and their sources, in the order they're sent. Production (the e2e
// preview and CloudFront alike):
//   default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self';
//   connect-src 'self' wss://<host[:port]>; base-uri 'none'; form-action 'none';
//   frame-ancestors 'none'; object-src 'none'; report-uri /api/csp-report
// Dev ({ dev: true }) adds 'unsafe-inline' to script-src (Vite's React Refresh preamble) and to
// style-src (Vite injects CSS as <style>), and nothing else: connect-src stays the allow-list, so a
// new outbound host shows up the first time a developer runs the app.
//
// Left out on purpose (T21 item 7): 'strict-dynamic' and nonces (a static SPA has no per-request
// nonce); Trusted Types (Chromium only); report-to, which silences report-uri where both are set;
// upgrade-insecure-requests, which would break the http dev server; manifest-src and worker-src
// (C0.14 adds them); the user-content origin in img-src and media-src (C0.15, C1.5). React's
// style={{…}} writes through the CSSOM, which style-src doesn't block.
export function cspDirectives(
  appOrigin: string,
  options: { dev?: boolean } = {},
): ReadonlyArray<readonly [string, readonly string[]]> {
  const origin = parseAppOrigin(appOrigin)
  const inline = options.dev === true ? ["'unsafe-inline'"] : []
  return [
    ['default-src', ["'none'"]],
    ['script-src', ["'self'", ...inline]],
    ['style-src', ["'self'", ...inline]],
    ['img-src', ["'self'"]],
    ['font-src', ["'self'"]],
    ['connect-src', ["'self'", socketOrigin(origin)]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'none'"]],
    ['frame-ancestors', ["'none'"]],
    ['object-src', ["'none'"]],
    // Same-origin, so the report carries the page's Origin and passes the server's root Origin
    // hook with no exemption (OD-12). No 'report-sample': a sample would copy page text into logs.
    ['report-uri', [CSP_REPORT_PATH]],
  ]
}

export function contentSecurityPolicy(appOrigin: string, options: { dev?: boolean } = {}): string {
  return cspDirectives(appOrigin, options)
    .map(([directive, sources]) => [directive, ...sources].join(' '))
    .join('; ')
}

// Every header the app's document (index.html) is served with, beside its Cache-Control
// (DOCUMENT_CACHE_CONTROL). Referrer-Policy is same-origin, not no-referrer, because no-referrer
// makes a CSP report's Origin null, and the server refuses a POST with a null Origin. HSTS is sent
// only for an https host that isn't this machine, so the HTTPS e2e run can't pin a developer's
// localhost to https (K-30). C1.6 and C2 relax the microphone in Permissions-Policy.
export function documentHeaders(appOrigin: string, options: { dev?: boolean } = {}): Readonly<Record<string, string>> {
  const origin = parseAppOrigin(appOrigin)
  return Object.freeze({
    'Content-Security-Policy': contentSecurityPolicy(appOrigin, options),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    ...(origin.scheme === 'https' && !origin.loopback ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
  })
}
