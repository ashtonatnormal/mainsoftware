// The suite's test function (T21 item 11). Every spec imports `test` and `expect`
// from here, never from @playwright/test, so every page it opens is watched by the guard.
//
// - open(options): a new context and page at a viewport and colour scheme, with reduced motion,
//   a phone's touch and pixel ratio on request (isMobile only where the engine has it: not
//   Firefox), signed in as the project's persona (signedIn: true), as a saved state (a path), or
//   signed out (the default). Its contexts close when the test ends.
// - guard (auto): fails the test, after it ran, on anything the app shouldn't do:
//   - a CSP violation (recorded by an init script Playwright injects; nothing ships);
//   - an uncaught page error;
//   - a console error, unless it is the browser's line for a response the test declared
//     (expectResponses), a request it aborts itself (allowFailedRequest), a violation it expects
//     (allowViolation), or a line it allows (allowConsole);
//   - a failed request, other than one a navigation cancelled or one the test aborts itself;
//   - a request or socket to any origin but the app's own (T21 item 3), unless the CSP blocked it
//     before it left the page (the violation is then the guard's to judge);
//   - any 4xx or 5xx from the app's origin that the test didn't declare (a test that answers a
//     request with a 503 itself declares it).
//   A signed-out page's boot answers GET /api/session 401. open() expects that of a context it
//   opens signed out only until the context is signed in (a 2xx from GET /api/session there;
//   signed-out.ts), so a 401 after the sign-in is the test's to declare. A spec whose default page
//   is signed out marks that context itself (expectSignedOut, as sign-in.spec.ts does), and marks
//   it again before a sign-out it expects to land on a signed-out boot.
import {
  type BrowserContext,
  test as base,
  type ConsoleMessage,
  expect,
  type Page,
  type Request,
} from '@playwright/test'
import { E2E_ORIGIN } from './env.ts'
import { SignedOutContexts } from './signed-out.ts'

export { SESSION_401 } from './signed-out.ts'
export { expect }

export interface OpenOptions {
  width: number
  height: number
  scheme?: 'light' | 'dark'
  // A phone: touch, a pixel ratio of 2, and isMobile where the engine has it.
  phone?: boolean
  // true: the project's storage state; a path: that state; false or absent: signed out.
  signedIn?: boolean | string
  // Lets a test inject a style the CSP would block (withTextSpacing, withTextZoom).
  bypassCSP?: boolean
  // 'reduce' unless a test asks otherwise.
  reducedMotion?: 'reduce' | 'no-preference'
}

export type Open = (options: OpenOptions) => Promise<Page>

export interface Guard {
  // Responses the test expects (a 4xx, or a 5xx it answers itself), and the browser's console lines
  // for them.
  expectResponses(list: readonly { path: string | RegExp; status: number }[]): void
  // The one directive a test expects to be violated (CS-03).
  allowViolation(directive: string): void
  allowConsole(pattern: RegExp): void
  // A request the test aborts itself (route.abort()), and its console line.
  allowFailedRequest(path: string | RegExp): void
  // The context starts signed out: its boots' GET /api/session 401 is expected until it is signed
  // in, which a 2xx from GET /api/session in it shows (open() calls this, and a spec whose default
  // page starts signed out). A 401 from then on is undeclared unless the test declares it, or marks
  // the context signed out again (a sign-out it expects).
  expectSignedOut(context: BrowserContext): void
  // Starts watching a context and its pages (open() and the default context do this).
  watch(context: BrowserContext): Promise<void>
  // Every CSP violation seen so far.
  readonly violations: readonly Violation[]
  // open() calls it when the test body ends, before it closes its contexts: what happens from then
  // on is the harness's, not the page's (closing a context, Playwright takes a throwaway screenshot
  // of each page, which in WebKit adds an inline style the CSP blocks), so it is printed, not counted.
  end(): void
}

export interface Violation {
  directive: string
  blocked: string
  // Where the violation came from: file, line and column.
  source: string
  page: string
}

const matches = (pattern: string | RegExp, path: string) =>
  typeof pattern === 'string' ? path === pattern : pattern.test(path)

// A navigation cancels what the old document had in flight; each engine words it its own way.
const CANCELLED = /ERR_ABORTED|NS_BINDING_ABORTED|NS_ERROR_ABORT|cancelled|Load request cancelled/i
// The CSP blocked the request before it was sent.
const BLOCKED = /^csp$|ERR_BLOCKED_BY_CSP|NS_ERROR_CONTENT_BLOCKED|Content Security Policy/i

const BINDING = '__e2eCspViolation'

class PageGuard implements Guard {
  readonly problems: string[] = []
  // What the pages did after the test body ended (end()), printed by the guard, never counted.
  readonly late: string[] = []
  readonly violations: Violation[] = []
  #ended = false
  readonly #responses: { path: string | RegExp; status: number }[] = []
  readonly #directives = new Set<string>()
  readonly #console: RegExp[] = []
  readonly #failed: (string | RegExp)[] = []
  readonly #watched = new WeakSet<BrowserContext>()
  // Contexts still signed out since expectSignedOut().
  readonly #signedOut = new SignedOutContexts<BrowserContext>()
  // Requests to another origin, unless the CSP blocks them before they leave (requestfailed).
  readonly #elsewhere = new Set<Request>()

  // Everything wrong so far, read when the test ends.
  report(): string[] {
    return [...this.problems, ...[...this.#elsewhere].map(request => `request to another origin: ${request.url()}`)]
  }

  expectResponses(list: readonly { path: string | RegExp; status: number }[]): void {
    this.#responses.push(...list)
  }

  end(): void {
    this.#ended = true
  }

  #problem(line: string): void {
    if (this.#ended) this.late.push(line)
    else this.problems.push(line)
  }

  allowViolation(directive: string): void {
    this.#directives.add(directive)
  }

  allowConsole(pattern: RegExp): void {
    this.#console.push(pattern)
  }

  allowFailedRequest(path: string | RegExp): void {
    this.#failed.push(path)
  }

  expectSignedOut(context: BrowserContext): void {
    this.#signedOut.expect(context)
  }

  // Declared by the test, or a signed-out boot's session check in a context not yet signed in.
  #declared(path: string, status: number, page: Page): boolean {
    if (this.#responses.some(entry => entry.status === status && matches(entry.path, path))) return true
    return this.#signedOut.allows(page.context(), path, status)
  }

  #failedAllowed(path: string): boolean {
    return this.#failed.some(entry => matches(entry, path))
  }

  async watch(context: BrowserContext): Promise<void> {
    if (this.#watched.has(context)) return
    this.#watched.add(context)
    await context.exposeBinding(BINDING, (source, detail: { directive: string; blocked: string; source: string }) => {
      const violation = { ...detail, page: source.page.url() }
      const line = `CSP violation: ${detail.directive} blocked ${detail.blocked} on ${violation.page} (from ${detail.source})`
      if (this.#ended) {
        this.late.push(line)
        return
      }
      this.violations.push(violation)
      if (!this.#directives.has(detail.directive)) this.problems.push(line)
    })
    await context.addInitScript(binding => {
      document.addEventListener('securitypolicyviolation', event => {
        const report = (window as unknown as Record<string, (detail: unknown) => void>)[binding]
        // What was blocked, as well as where: an inline style or script with no file to name
        // (one an engine or a library inserted) is found by the element it was on.
        const target = event.target instanceof Element ? event.target.outerHTML.slice(0, 120) : ''
        report?.({
          directive: event.effectiveDirective,
          blocked: event.blockedURI,
          source: `${event.sourceFile}:${event.lineNumber}:${event.columnNumber}${target === '' ? '' : `, on ${target}`}`,
        })
      })
    }, BINDING)
    for (const page of context.pages()) this.#attach(page)
    context.on('page', page => this.#attach(page))
  }

  #attach(page: Page): void {
    page.on('pageerror', error => this.#problem(`page error: ${error.message}`))
    page.on('console', message => this.#onConsole(message, page))
    page.on('request', request => {
      const url = request.url()
      if (url.startsWith('data:') || url.startsWith('blob:') || url === 'about:blank') {
        if (!url.startsWith('about:')) this.#problem(`request to ${url.slice(0, 40)}`)
        return
      }
      if (new URL(url).origin === E2E_ORIGIN) return
      if (this.#ended) this.late.push(`request to another origin: ${url}`)
      else this.#elsewhere.add(request)
    })
    page.on('websocket', socket => {
      const url = new URL(socket.url())
      if (`https://${url.host}` !== E2E_ORIGIN || url.protocol !== 'wss:') {
        this.#problem(`socket to another origin: ${socket.url()}`)
      }
    })
    page.on('requestfailed', request => {
      const path = new URL(request.url()).pathname
      const why = request.failure()?.errorText ?? ''
      // The CSP stopped it before it left the page: the violation it raised is the guard's to judge.
      if (BLOCKED.test(why)) {
        this.#elsewhere.delete(request)
        return
      }
      if (this.#elsewhere.has(request)) return
      if (CANCELLED.test(why) || this.#failedAllowed(path)) return
      this.#problem(`request failed: ${request.method()} ${path} (${why})`)
    })
    page.on('response', response => {
      const url = new URL(response.url())
      if (url.origin !== E2E_ORIGIN) return
      const status = response.status()
      this.#signedOut.saw(page.context(), url.pathname, status)
      if (status >= 400 && !this.#declared(url.pathname, status, page)) {
        const line = `undeclared ${status} from ${response.request().method()} ${url.pathname}`
        if (this.#ended) {
          this.late.push(line)
          return
        }
        const at = this.problems.push(line) - 1
        // A 403 is most often the Origin hook's: name the Origin the request carried (allHeaders,
        // since headers() leaves out the security-related ones).
        if (status === 403) {
          response
            .request()
            .allHeaders()
            .then(headers => {
              this.problems[at] = `${line} (Origin: ${headers.origin ?? 'none'})`
            })
            .catch(() => {})
        }
      }
    })
  }

  #onConsole(message: ConsoleMessage, page: Page): void {
    if (message.type() !== 'error') return
    const text = message.text()
    if (this.#console.some(pattern => pattern.test(text))) return
    // The browser's own line for a failed load names the resource as its location.
    const where = message.location().url
    if (/Failed to load resource/i.test(text) && where !== '') {
      const url = new URL(where, E2E_ORIGIN)
      const status = Number(/status of (\d{3})/.exec(text)?.[1] ?? Number.NaN)
      if (this.#declared(url.pathname, status, page) || this.#failedAllowed(url.pathname)) return
    }
    // Chromium and WebKit write "Content Security Policy", Firefox "Content-Security-Policy".
    if (
      /Content[- ]Security[- ]Policy/i.test(text) &&
      [...this.#directives].some(directive => text.includes(directive))
    ) {
      return
    }
    this.#problem(`console error: ${text}`)
  }
}

// The phone settings an engine supports: Firefox has no isMobile.
const phoneOptions = (browserName: string) =>
  browserName === 'firefox'
    ? { hasTouch: true, deviceScaleFactor: 2 }
    : { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }

export const test = base.extend<{ guard: Guard; open: Open }>({
  guard: [
    async ({ context }, use, testInfo) => {
      const guard = new PageGuard()
      await guard.watch(context)
      await use(guard)
      if (guard.late.length > 0)
        console.log(`the page guard, after the test (not counted):\n  ${guard.late.join('\n  ')}`)
      // Checked after the test, so a test that already failed reports its own error first.
      if (testInfo.status === testInfo.expectedStatus) expect(guard.report(), 'the page guard').toEqual([])
    },
    { auto: true },
  ],
  open: async ({ browser, browserName, guard }, use, testInfo) => {
    const contexts: BrowserContext[] = []
    const projectState = testInfo.project.use.storageState
    await use(async options => {
      const signedIn = options.signedIn ?? false
      const storageState =
        signedIn === true ? projectState : typeof signedIn === 'string' ? signedIn : { cookies: [], origins: [] }
      if (signedIn === true && projectState === undefined) throw new Error('this project has no signed-in state')
      const context = await browser.newContext({
        // The config's `use`, which a context made here doesn't inherit.
        baseURL: E2E_ORIGIN,
        ignoreHTTPSErrors: true,
        locale: 'en-GB',
        timezoneId: 'Asia/Singapore',
        serviceWorkers: 'block',
        viewport: { width: options.width, height: options.height },
        colorScheme: options.scheme ?? 'light',
        reducedMotion: options.reducedMotion ?? 'reduce',
        storageState,
        bypassCSP: options.bypassCSP ?? false,
        ...(options.phone ? phoneOptions(browserName) : {}),
      })
      contexts.push(context)
      if (signedIn === false) guard.expectSignedOut(context)
      await guard.watch(context)
      return context.newPage()
    })
    guard.end()
    for (const context of contexts) await context.close()
  },
})
