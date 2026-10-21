// GET /api/session and GET /api/flags at the api (web/routes.ts), on a scripted pool: what they
// answer, that they run read only, which one counts as use of the session, and that no refusal of
// theirs clears the cookie (T21 item 10). The integration suite (routes.integration.test.ts) runs
// them on the Compose stack. Then POST /api/csp-report (web/csp-report.ts, OD-12): its scoped
// parser, the Origin hook and its one exception for WebKit's report (origin.ts, T21 item 9), what
// it logs and the cap on that log; csp-report.test.ts tests the
// reduction and the cap alone.
import { Writable } from 'node:stream'
import { CSP_REPORT_PATH, FLAGS, type FlagSpec, FlagsResponse, MESSAGES, SessionResponse } from '@hearth/shared'
import type { Redis } from 'ioredis'
import type { Pool } from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Api, type ApiDeps, registerApi } from '#src/api.ts'
import { buildApp } from '#src/app.ts'
import type { AuthKeys } from '#src/auth/crypto.ts'
import { ApiError } from '#src/auth/errors.ts'
import { createDatabase, type Database } from '#src/db/database.ts'
import type { FlagVerdict } from '#src/flags/cache.ts'
import type { FlagSubject } from '#src/flags/evaluate.ts'
import { AfterResponse, type ReqInfo } from '#src/http.ts'
import { createLogger } from '#src/logger.ts'
import { staticFlags } from '#src/testing/flags.ts'
import { type Statement, scriptedPool } from '#src/testing/pool.ts'
import { CSP_REPORT_LIMIT } from '#src/web/csp-report.ts'
import { readFlags } from '#src/web/flags.ts'
import { keepCookie } from '#src/web/routes.ts'

const APP_ORIGIN = 'https://hearth.example.com'
const ORG = 'a0000000-0000-4000-8000-000000000001'
const PERSON = 'b0000000-0000-4000-8000-000000000001'
const DEVICE = 'b0000000-0000-4000-8000-0000000000d1'
const TEAM = 'd0000000-0000-4000-8000-000000000001'
// A well-formed token (43 base64url characters), made of one letter so no scanner takes it for a
// secret.
const TOKEN = 't'.repeat(43)
const COOKIE = `__Host-hearth_session=${TOKEN}`
const ROUTES = ['/api/session', '/api/flags'] as const

// Each case its own session id: the once-a-minute touch memory is per process (sessions.ts).
let sessions = 0
const nextSession = () => `b0000000-0000-4000-8000-${String(0xe00 + ++sessions).padStart(12, '0')}`

// A database the test must never reach: its pool refuses every connection and counts them.
function unreachableDb(): { db: Database; touched: () => number } {
  let touched = 0
  const pool = {
    connect: async () => {
      touched++
      throw new Error('the database was touched')
    },
    end: async () => {},
    options: {},
  } as unknown as Pool
  return { db: createDatabase(pool), touched: () => touched }
}

interface Script {
  // The session the cookie's lookup finds (a new id unless given); 'none' finds nothing, 'fails'
  // throws as a lost connection does.
  session?: string | 'none' | 'fails'
  // Whether the acting session is still live when the request's own transaction re-reads it.
  live?: boolean
  // The person's deactivation as the World's own read finds it: a deactivation that committed
  // after the acting session was re-read live (READ COMMITTED).
  leftMidRequest?: boolean
  // The person's role rows (each unrevoked).
  roles?: { role: string; team_id: string | null }[]
  // What the session answer's read finds.
  found?: { name: string; time_zone: string }
}

// A signed-in request's statements, answered: the pre-org lookup, the acting session's re-read,
// the World loader's reads (the person, their roles, one live team, their device) and the session
// read.
function signedIn(script: Script = {}) {
  const sessionId = script.session ?? nextSession()
  return scriptedPool(({ text }: Statement) => {
    if (text.includes('public.session_by_token')) {
      if (sessionId === 'fails') return new Error('connection terminated')
      if (sessionId === 'none') return []
      return [{ session_id: sessionId, org_id: ORG, user_id: PERSON, device_id: DEVICE }]
    }
    if (text.includes('join devices d on')) {
      return script.live === false ? [] : [{ fresh: false, pin_set: false, issued_under_pin_rule: false }]
    }
    if (text.includes('from "people"')) {
      return [{ id: PERSON, deactivated_at: script.leftMidRequest === true ? new Date() : null }]
    }
    // TEAM is live, so a team_admin row of it counts as held (World.rolesOf).
    if (text.includes('from "teams"')) return [{ id: TEAM, archived_at: null }]
    if (text.includes('from "role_assignments"')) {
      return (script.roles ?? []).map(r => ({ person_id: PERSON, revoked_at: null, ...r }))
    }
    if (text.includes('from "devices"')) return [{ id: DEVICE, user_id: PERSON, signed_out_at: null }]
    if (text.includes('coalesce(pr.display_name')) return script.found === undefined ? [] : [script.found]
    return []
  })
}

function setup(deps: Partial<ApiDeps> = {}) {
  const logs: Record<string, unknown>[] = []
  const stream = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split('\n').filter(Boolean)) logs.push(JSON.parse(line))
      done()
    },
  })
  const logger = createLogger({ logLevel: 'debug', role: 'api' }, stream)
  const app = buildApp({ appOrigin: APP_ORIGIN, logger, checks: {} })
  const afterResponse = new AfterResponse()
  registerApi(app, {
    appOrigin: APP_ORIGIN,
    db: unreachableDb().db,
    // Neither GET sends a code or reads Valkey, and neither uses the keys.
    valkey: {} as Redis,
    keys: {} as AuthKeys,
    sms: undefined,
    keyPrefix: 'it:unit:',
    flags: staticFlags(),
    afterResponse,
    ...deps,
  })
  const get = (url: string, cookie?: string) =>
    app.inject({ method: 'GET', url, headers: cookie === undefined ? {} : { cookie } })
  // A POST from the app origin with a CSP report's content type, unless the headers say otherwise
  // (an undefined header is left out).
  const post = (url: string, payload: unknown, headers: Record<string, string | undefined> = {}) => {
    const sent: Record<string, string> = {}
    for (const [name, value] of Object.entries({
      origin: APP_ORIGIN,
      'content-type': 'application/csp-report',
      ...headers,
    })) {
      if (value !== undefined) sent[name] = value
    }
    return app.inject({
      method: 'POST',
      url,
      headers: sent,
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    })
  }
  return { app, logs, afterResponse, get, post }
}

// The test registry: production's flags, three a browser may see and one it may not.
const spec = (client: boolean): FlagSpec => ({
  description: 'A test flag',
  class: 'optional',
  default: true,
  locked: false,
  purposes: ['service_operation'],
  client,
  stage: 'C0.8',
})
const REGISTRY: Readonly<Record<string, FlagSpec>> = {
  ...FLAGS,
  'it.alpha': spec(true),
  'it.beta': spec(true),
  'it.gamma': spec(true),
  'it.server': spec(false),
}

// The request facts a service gets, with the work it queues kept for the test to run.
function requestFacts(): { info: ReqInfo; queued: (() => Promise<void>)[] } {
  const queued: (() => Promise<void>)[] = []
  return {
    queued,
    info: {
      ip: '198.51.100.7',
      requestId: 'f0000000-0000-4000-8000-000000000001',
      userAgent: undefined,
      log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as ReqInfo['log'],
      after: task => queued.push(task),
    },
  }
}

describe('C0.8 T21 item 10 GET /api/session and GET /api/flags: refusals', () => {
  it('WR-01 T19 item 11 T21 item 3: without a session, or with a stale cookie, both answer 401 signed_out with no Set-Cookie (a GET never clears the cookie)', async () => {
    const signedOut = { error: 'signed_out', message: MESSAGES.signed_out }
    // No cookie, a malformed one, or two of them: refused before the database.
    const { db, touched } = unreachableDb()
    const none = setup({ db })
    for (const url of ROUTES) {
      for (const cookie of [undefined, '__Host-hearth_session=short', `${COOKIE}; ${COOKIE}`]) {
        const response = await none.get(url, cookie)
        expect([url, cookie, response.statusCode], String(cookie)).toEqual([url, cookie, 401])
        expect(response.json()).toEqual(signedOut)
        expect(response.headers['set-cookie']).toBeUndefined()
      }
    }
    expect(touched()).toBe(0)
    // A stale cookie: the lookup finds no live session.
    const stale = setup({ db: signedIn({ session: 'none' }).db })
    // A session that ended between the lookup and the request's own transaction (a leaver, a sign-
    // out elsewhere): authorise()'s 401 clears the cookie on every other route, never here.
    const ended = setup({ db: signedIn({ live: false }).db })
    // A deactivation that commits after the acting session was re-read live, before the World's
    // reads: can() refuses session.read_own for someone who has left, and that is 401 signed_out
    // too, never 404 not_found, which the boot would show as a failed load.
    const left = setup({ db: signedIn({ leftMidRequest: true }).db })
    for (const app of [stale, ended, left]) {
      for (const url of ROUTES) {
        const response = await app.get(url, COOKIE)
        expect([url, response.statusCode]).toEqual([url, 401])
        expect(response.json()).toEqual(signedOut)
        expect(response.headers['set-cookie']).toBeUndefined()
      }
    }
  })

  it('T21 item 10: a session lookup that fails is 503 unavailable, with no Set-Cookie either', async () => {
    const { get, logs } = setup({ db: signedIn({ session: 'fails' }).db })
    for (const url of ROUTES) {
      const response = await get(url, COOKIE)
      expect(response.statusCode).toBe(503)
      expect(response.json()).toEqual({ error: 'unavailable', message: MESSAGES.unavailable })
      expect(response.headers['set-cookie']).toBeUndefined()
    }
    expect(logs.filter(line => line.event === 'session_lookup_failed')).toHaveLength(2)
  })

  it('T21 item 10: keepCookie rethrows a refusal without the cookies it would clear, and anything else as it is', async () => {
    const clearing = new ApiError(401, 'signed_out', {}, ['session'])
    const caught = await keepCookie(async () => {
      throw clearing
    }).catch((error: unknown) => error)
    expect(caught).toBeInstanceOf(ApiError)
    expect(caught).toMatchObject({ status: 401, code: 'signed_out', extra: {}, clear: [] })
    const refusal = new ApiError(404, 'not_found')
    await expect(
      keepCookie(async () => {
        throw refusal
      }),
    ).rejects.toBe(refusal)
    const broken = new Error('connection terminated')
    await expect(
      keepCookie(async () => {
        throw broken
      }),
    ).rejects.toBe(broken)
    expect(await keepCookie(async () => 'answered')).toBe('answered')
  })
})

describe('C0.8 T17 item 11 GET /api/flags', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('WR-02 T17 item 11: on is true, off and not_in_cohort are false, and only client: true keys are sent', async () => {
    const flags = staticFlags(REGISTRY)
    const verdicts: Record<string, FlagVerdict> = {
      'it.alpha': 'on',
      'it.beta': 'off',
      'it.gamma': 'not_in_cohort',
      'it.server': 'on',
    }
    flags.verdict.mockImplementation((_org: string, key: string) => verdicts[key] ?? 'off')
    const { get } = setup({
      db: signedIn({
        roles: [
          { role: 'owner', team_id: null },
          { role: 'team_admin', team_id: TEAM },
        ],
      }).db,
      flags,
    })
    const response = await get('/api/flags', COOKIE)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ flags: { 'it.alpha': true, 'it.beta': false, 'it.gamma': false } })
    expect(FlagsResponse.safeParse(response.json()).success).toBe(true)
    // Asked about the client keys alone, for this person as the cohorts see them: still at the org,
    // with the org-wide roles a cohort can name. The team_admin row is held (TEAM is live) and left
    // out because no cohort names it.
    const subject: FlagSubject = { personId: PERSON, active: true, roles: ['owner'] }
    expect(flags.verdict.mock.calls).toEqual([
      [ORG, 'it.alpha', subject],
      [ORG, 'it.beta', subject],
      [ORG, 'it.gamma', subject],
    ])
    expect(flags.track).toHaveBeenCalledWith(ORG)
  })

  it('WR-03 OD-13: with no client flag in the registry the answer is {flags:{}}, without waiting for the cache or asking it', async () => {
    const flags = staticFlags(FLAGS)
    // The org's first read never ends, so any wait would show.
    flags.track.mockImplementation(() => new Promise<void>(() => {}))
    const { get } = setup({ db: signedIn().db, flags })
    const response = await get('/api/flags', COOKIE)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ flags: {} })
    expect(flags.verdict).not.toHaveBeenCalled()
    // The service itself: it never waits.
    const wait = vi.fn(async () => {})
    const { info } = requestFacts()
    const api = { db: signedIn().db, flags } as unknown as Api
    const session = { sessionId: nextSession(), orgId: ORG, userId: PERSON, deviceId: DEVICE }
    expect(await readFlags(api, session, info, wait)).toEqual({ body: { flags: {} } })
    expect(wait).not.toHaveBeenCalled()
  })

  it('WR-04 T17 item 11: with a client key, the wait for the first read is bounded at 2.5 s and comes after the transaction; unconfirmed answers 503 unavailable', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const flags = staticFlags(REGISTRY)
    flags.track.mockImplementation(() => new Promise<void>(() => {}))
    flags.verdict.mockImplementation(() => 'unconfirmed')
    const pool = signedIn()
    const api = { db: pool.db, flags } as unknown as Api
    const session = { sessionId: nextSession(), orgId: ORG, userId: PERSON, deviceId: DEVICE }
    const { info } = requestFacts()
    let outcome: unknown
    void readFlags(api, session, info).then(
      answer => {
        outcome = answer
      },
      (error: unknown) => {
        outcome = error
      },
    )
    await vi.advanceTimersByTimeAsync(2499)
    expect(outcome).toBeUndefined()
    // The transaction has committed: nothing holds a connection while the answer waits.
    expect(pool.texts().at(-1)).toBe('commit')
    expect(flags.verdict).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome).toBeInstanceOf(ApiError)
    expect(outcome).toMatchObject({ status: 503, code: 'unavailable' })
    expect(pool.texts().at(-1)).toBe('commit')
  })

  it('T17 item 11: an org whose flags went unconfirmed answers 503 unavailable at once, and the route says so', async () => {
    const flags = staticFlags(REGISTRY)
    flags.verdict.mockImplementation((_org: string, key: string) => (key === 'it.beta' ? 'unconfirmed' : 'on'))
    const { get } = setup({ db: signedIn().db, flags })
    const response = await get('/api/flags', COOKIE)
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ error: 'unavailable', message: MESSAGES.unavailable })
    expect(response.headers['set-cookie']).toBeUndefined()
  })
})

describe('C0.8 OD-14 which GET counts as use of the session', () => {
  // The transaction each statement ran in, by the start statement before it.
  const transactionOf = (texts: string[], match: (text: string) => boolean): string | undefined => {
    const at = texts.findIndex(match)
    return texts
      .slice(0, at)
      .reverse()
      .find(text => text.startsWith('start transaction'))
  }
  const READ_ONLY = 'start transaction isolation level read committed read only'

  it('WR-05 OD-14 T21: GET /api/flags runs read only and queues no touch; GET /api/session runs read only and queues one', async () => {
    const flagsPool = signedIn({ roles: [] })
    const flagsApp = setup({ db: flagsPool.db, flags: staticFlags(REGISTRY) })
    expect((await flagsApp.get('/api/flags', COOKIE)).statusCode).toBe(200)
    await flagsApp.afterResponse.idle()
    const flagTexts = flagsPool.texts()
    expect(transactionOf(flagTexts, text => text.includes('join devices d on'))).toBe(READ_ONLY)
    expect(flagTexts.some(text => /^(insert|update|delete)\b/.test(text))).toBe(false)

    const sessionPool = signedIn({ found: { name: 'Ahmad', time_zone: 'Asia/Kuala_Lumpur' } })
    const sessionApp = setup({ db: sessionPool.db })
    expect((await sessionApp.get('/api/session', COOKIE)).statusCode).toBe(200)
    await sessionApp.afterResponse.idle()
    const sessionTexts = sessionPool.texts()
    expect(transactionOf(sessionTexts, text => text.includes('join devices d on'))).toBe(READ_ONLY)
    expect(transactionOf(sessionTexts, text => text.includes('coalesce(pr.display_name'))).toBe(READ_ONLY)
    // The touch, after the response, in a transaction of its own that may write.
    const writes = sessionTexts.filter(text => /^(insert|update|delete)\b/.test(text))
    expect(writes.map(text => /^update \w+ set last_seen_at = now\(\)/.exec(text)?.[0])).toEqual([
      'update devices set last_seen_at = now()',
      'update sessions set last_seen_at = now()',
    ])
    expect(transactionOf(sessionTexts, text => text.startsWith('update devices'))).toBe(
      'start transaction isolation level read committed',
    )
  })

  it('WR-06 T21: both answer Cache-Control no-store, errors included', async () => {
    const answered = setup({
      db: signedIn({ found: { name: 'Ahmad', time_zone: 'Asia/Kuala_Lumpur' } }).db,
      flags: staticFlags(REGISTRY),
    })
    const signedOutApp = setup()
    const down = setup({ db: signedIn({ session: 'fails' }).db })
    const responses = []
    for (const url of ROUTES) {
      responses.push(await answered.get(url, COOKIE), await signedOutApp.get(url), await down.get(url, COOKIE))
    }
    expect(responses.map(r => r.statusCode)).toEqual([200, 401, 503, 200, 401, 503])
    for (const response of responses) expect(response.headers['cache-control']).toBe('no-store')
  })
})

describe('C0.8 T21 item 10 GET /api/session', () => {
  it('WR-07 T21 item 10 OD-10: the answer is the profile’s name and zone, else the full name and the org’s zone, read for the session’s own person', async () => {
    const pool = signedIn({ found: { name: 'Ahmad', time_zone: 'Asia/Kuala_Lumpur' } })
    const { get } = setup({ db: pool.db })
    const response = await get('/api/session', COOKIE)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ personId: PERSON, name: 'Ahmad', timeZone: 'Asia/Kuala_Lumpur' })
    expect(SessionResponse.safeParse(response.json()).success).toBe(true)
    // The fallbacks are the read's own: the profile first, then the roster's name and the org's
    // zone (NOT NULL), for the session's org and person only.
    const read = pool.statements.find(statement => statement.text.includes('coalesce(pr.display_name'))
    expect(read).toEqual({
      text: 'select coalesce(pr.display_name, p.full_name) as name, coalesce(pr.time_zone, o.time_zone) as time_zone from people p join orgs o on o.id = p.org_id left join profiles pr on pr.org_id = p.org_id and pr.person_id = p.id where p.org_id = $1 and p.id = $2',
      values: [ORG, PERSON],
    })
  })

  it('T21 item 10: a person the read can’t find reads as signed out, without clearing the cookie', async () => {
    const { get } = setup({ db: signedIn().db })
    const response = await get('/api/session', COOKIE)
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'signed_out', message: MESSAGES.signed_out })
    expect(response.headers['set-cookie']).toBeUndefined()
  })
})

// A report as Chromium sends one to a report-uri, with MARKER in every field a log line must not
// keep: the query strings, the referrer, the policy, the source file and the script sample.
const MARKER = 'csp-marker'
const CHAT = '0f9c2c4e-1b7a-4c1e-9f55-3d2a1b0c9e8d'
const REPORT = {
  'csp-report': {
    'document-uri': `${APP_ORIGIN}/chats/${CHAT}?invite=${MARKER}#${MARKER}`,
    referrer: `${APP_ORIGIN}/today?from=${MARKER}`,
    'violated-directive': 'img-src',
    'effective-directive': 'img-src',
    'original-policy': `default-src 'none'; img-src 'self' ${MARKER}`,
    disposition: 'enforce',
    'blocked-uri': `https://example.invalid/x.png?${MARKER}=1`,
    'line-number': 12,
    'column-number': 34,
    'source-file': `${APP_ORIGIN}/assets/index.js?${MARKER}`,
    'status-code': 200,
    'script-sample': `alert("${MARKER}")`,
  },
}
const REDUCED = { directive: 'img-src', blocked: 'https://example.invalid', path: '/chats/:id', disposition: 'enforce' }
// The headers of WebKit's report (T21 item 9): Origin "null", which its PingLoader stamps on every
// report-uri POST, and the fetch metadata of a no-cors request from the page's own origin.
const WEBKIT_REPORT: Readonly<Record<string, string>> = {
  origin: 'null',
  'content-type': 'application/csp-report',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'no-cors',
  'sec-fetch-dest': 'empty',
}
const REFUSED = { error: 'invalid_request', message: MESSAGES.invalid_request }

const reportLines = (logs: Record<string, unknown>[]) => logs.filter(line => line.event === 'csp_report')

describe('C0.8 OD-12 POST /api/csp-report', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('CR-01 OD-12 T21 item 7: application/csp-report from the app origin answers 204 and logs only directive, blocked, path and disposition', async () => {
    // A session cookie is sent and ignored: the route reads no session, and the database and
    // Valkey (an empty object here) are never reached.
    const { db, touched } = unreachableDb()
    const { post, logs } = setup({ db })
    expect(CSP_REPORT_PATH).toBe('/api/csp-report')
    const response = await post(CSP_REPORT_PATH, REPORT, { cookie: COOKIE })
    expect([response.statusCode, response.body, response.headers['cache-control']]).toEqual([204, '', 'no-store'])
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(touched()).toBe(0)
    // One line for the request, and only the four fields beside pino's own: the route's request
    // lines are logged at warn only, so no incoming or completed line carries anything more.
    expect(logs).toHaveLength(1)
    const [line] = logs
    expect(line).toMatchObject({ level: 40, event: 'csp_report', ...REDUCED })
    expect(Object.keys(line ?? {}).sort()).toEqual(
      ['blocked', 'directive', 'disposition', 'event', 'level', 'msg', 'path', 'reqId', 'role', 'time'].sort(),
    )
    expect(JSON.stringify(logs)).not.toContain(MARKER)
    // A content type with parameters is the same type.
    const charset = await post(CSP_REPORT_PATH, REPORT, { 'content-type': 'application/csp-report; charset=utf-8' })
    expect(charset.statusCode).toBe(204)
    expect(reportLines(logs)).toHaveLength(2)
  })

  it('OD-12: the route is CSP_REPORT_PATH alone, for POST alone', async () => {
    const { app, post, logs } = setup()
    const slash = await post(`${CSP_REPORT_PATH}/`, REPORT)
    const get = await app.inject({ method: 'GET', url: CSP_REPORT_PATH })
    for (const response of [slash, get]) {
      expect([response.statusCode, response.json(), response.headers['cache-control']]).toEqual([
        404,
        { error: 'Not Found' },
        'no-store',
      ])
    }
    expect(reportLines(logs)).toEqual([])
  })

  it('CR-02 OD-12 CL Security: a report with another Origin, or none, or "null" without Sec-Fetch-Site same-origin, is refused 403 by the root hook', async () => {
    const { post, logs } = setup()
    for (const origin of ['https://evil.example', 'https://usercontent.hearth.example.com', 'null', undefined]) {
      const response = await post(CSP_REPORT_PATH, REPORT, { origin })
      expect([origin, response.statusCode, response.json()]).toEqual([origin, 403, { error: 'Forbidden' }])
    }
    expect(reportLines(logs)).toEqual([])
  })

  it("CR-07 T21 item 9 CL Security: WebKit's report, Origin null with Sec-Fetch-Site same-origin, answers 204 and is logged reduced like any other", async () => {
    const { db, touched } = unreachableDb()
    const { post, logs } = setup({ db })
    // As WebKit sends one (PingLoader::sendViolationReport): the fetch metadata of a no-cors
    // request from the page's own origin, and the type and url keys it adds around the report.
    const webkit = { type: 'csp-violation', url: REPORT['csp-report']['document-uri'], ...REPORT }
    const response = await post(CSP_REPORT_PATH, webkit, { ...WEBKIT_REPORT, cookie: COOKIE })
    expect([response.statusCode, response.body, response.headers['cache-control']]).toEqual([204, '', 'no-store'])
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(touched()).toBe(0)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ level: 40, event: 'csp_report', ...REDUCED })
    expect(JSON.stringify(logs)).not.toContain(MARKER)
    // A content type with parameters is the same type, here too.
    const charset = await post(CSP_REPORT_PATH, REPORT, {
      ...WEBKIT_REPORT,
      'content-type': 'Application/CSP-Report; charset=utf-8',
    })
    expect(charset.statusCode).toBe(204)
    expect(reportLines(logs)).toHaveLength(2)
  })

  it('CR-08 T21 item 9 CL Security: the exemption is that request alone; every near miss of it is refused 403 before any route runs', async () => {
    const { db, touched } = unreachableDb()
    const { app, post, logs } = setup({ db })
    const refused: [string, string, Record<string, string | undefined>][] = [
      // Another Sec-Fetch-Site, or none: the browser's own word that the page is the app's.
      ...[undefined, 'same-site', 'cross-site', 'none', 'Same-Origin', 'same-origin, same-origin'].map(
        (site): [string, string, Record<string, string | undefined>] => [
          `Sec-Fetch-Site ${site}`,
          CSP_REPORT_PATH,
          { ...WEBKIT_REPORT, 'sec-fetch-site': site },
        ],
      ),
      // Same-origin fetch metadata never stands in for an Origin other than "null".
      ...[undefined, 'Null', 'null, null', 'https://evil.example', 'https://usercontent.hearth.example.com'].map(
        (origin): [string, string, Record<string, string | undefined>] => [
          `Origin ${origin}`,
          CSP_REPORT_PATH,
          { ...WEBKIT_REPORT, origin },
        ],
      ),
      // Another type: the route's own parser would refuse it 400, but the hook refuses it first.
      ...['application/json', 'application/reports+json', 'text/plain', undefined].map(
        (type): [string, string, Record<string, string | undefined>] => [
          `Content-Type ${type}`,
          CSP_REPORT_PATH,
          { ...WEBKIT_REPORT, 'content-type': type },
        ],
      ),
      // Any other spelling of the path, and any other route, even one that would answer 200.
      ...[
        `${CSP_REPORT_PATH}/`,
        `${CSP_REPORT_PATH}?from=webkit`,
        '/API/csp-report',
        '/api//csp-report',
        '/api/csp-report%2F',
        '/api/auth/otp/request',
        '/api/auth/sign-out',
      ].map((url): [string, string, Record<string, string | undefined>] => [url, url, WEBKIT_REPORT]),
      ['sign-out as JSON', '/api/auth/sign-out', { ...WEBKIT_REPORT, 'content-type': 'application/json' }],
    ]
    for (const [name, url, headers] of refused) {
      const response = await post(url, url === '/api/auth/sign-out' ? {} : REPORT, headers)
      expect([name, response.statusCode, response.json()]).toEqual([name, 403, { error: 'Forbidden' }])
    }
    // Other methods, on the path itself.
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const response = await app.inject({
        method,
        url: CSP_REPORT_PATH,
        headers: { ...WEBKIT_REPORT },
        payload: JSON.stringify(REPORT),
      })
      expect([method, response.statusCode]).toEqual([method, 403])
    }
    expect(touched()).toBe(0)
    expect(reportLines(logs)).toEqual([])
  })

  it('CR-03 OD-12: malformed JSON or a body over 8 KiB is 400 invalid_request, never 500', async () => {
    const { post, logs } = setup()
    expect(CSP_REPORT_LIMIT).toBe(8_192)
    // Under the limit, fields the route doesn't read are dropped, however long.
    const padded = (size: number) => {
      const body = { 'csp-report': { ...REPORT['csp-report'], 'script-sample': '' } }
      body['csp-report']['script-sample'] = 'x'.repeat(size - JSON.stringify(body).length)
      return JSON.stringify(body)
    }
    expect(padded(CSP_REPORT_LIMIT)).toHaveLength(CSP_REPORT_LIMIT)
    expect((await post(CSP_REPORT_PATH, padded(CSP_REPORT_LIMIT))).statusCode).toBe(204)
    const refused = [
      `{"csp-report": {"blocked-uri": "${MARKER}"`,
      '',
      'null',
      '[]',
      `"${MARKER}"`,
      '{}',
      { 'csp-report': null },
      { 'csp-report': { 'blocked-uri': 5 } },
      { 'csp-report': { 'document-uri': `${APP_ORIGIN}/${'a'.repeat(4096)}` } },
      { 'csp-report': { disposition: 'enforce'.repeat(3) } },
      padded(CSP_REPORT_LIMIT + 1),
      padded(100_000),
      // Refused as Fastify's JSON parser refuses it on every other route.
      `{"csp-report": {}, "__proto__": {"${MARKER}": true}}`,
      `{"csp-report": {}, "constructor": {"prototype": {"${MARKER}": true}}}`,
    ]
    for (const payload of refused) {
      const response = await post(CSP_REPORT_PATH, payload)
      const shown = typeof payload === 'string' ? payload.slice(0, 60) : JSON.stringify(payload).slice(0, 60)
      expect([shown, response.statusCode, response.json()]).toEqual([shown, 400, REFUSED])
      expect(response.body).not.toContain(MARKER)
    }
    // One line, for the report that fitted; nothing at error level, and no marker anywhere.
    expect(reportLines(logs)).toHaveLength(1)
    expect(logs.filter(line => typeof line.level === 'number' && line.level >= 50)).toEqual([])
    expect(JSON.stringify(logs)).not.toContain(MARKER)
  })

  it('CR-04 OD-12: past 60 reports in a minute nothing more is logged, and one csp_reports_dropped line follows', async () => {
    // The cap reads a monotonic clock; Fastify reads the same one for response times only.
    let now = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const { post, logs } = setup()
    for (let i = 0; i < 61; i++) expect((await post(CSP_REPORT_PATH, REPORT)).statusCode).toBe(204)
    expect(reportLines(logs)).toHaveLength(60)
    expect(logs).toHaveLength(60)
    now += 59_999
    expect((await post(CSP_REPORT_PATH, REPORT)).statusCode).toBe(204)
    expect(logs).toHaveLength(60)
    // The first report after the minute ends reports the two dropped, then is logged itself.
    now += 1
    expect((await post(CSP_REPORT_PATH, REPORT)).statusCode).toBe(204)
    expect(logs.slice(60).map(line => [line.level, line.event, line.count])).toEqual([
      [40, 'csp_reports_dropped', 2],
      [40, 'csp_report', undefined],
    ])
    // Reported once.
    now += 60_000
    await post(CSP_REPORT_PATH, REPORT)
    expect(logs.slice(62).map(line => line.event)).toEqual(['csp_report'])
  })

  it('CR-05 OD-12: a plain JSON route under /api still refuses application/csp-report with 400 (the parser is scoped)', async () => {
    const { db, touched } = unreachableDb()
    const { post } = setup({ db })
    // Signing out takes {} as JSON, with or without a session (auth/routes.ts).
    const json = await post('/api/auth/sign-out', {}, { 'content-type': 'application/json' })
    expect([json.statusCode, json.json()]).toEqual([200, { status: 'signed_out' }])
    const report = await post('/api/auth/sign-out', {})
    expect([report.statusCode, report.json()]).toEqual([400, REFUSED])
    const otp = await post('/api/auth/otp/request', REPORT)
    expect([otp.statusCode, otp.json()]).toEqual([400, REFUSED])
    expect(touched()).toBe(0)
  })

  it('CR-06 T21 item 7: application/reports+json is refused, and so is JSON: the route takes application/csp-report alone', async () => {
    const { post, logs } = setup()
    // The Reporting API's shape (report-to), which the policy doesn't use.
    const reporting = [{ type: 'csp-violation', age: 0, url: `${APP_ORIGIN}/chats`, body: REPORT['csp-report'] }]
    const refused = [
      await post(CSP_REPORT_PATH, reporting, { 'content-type': 'application/reports+json' }),
      await post(CSP_REPORT_PATH, REPORT, { 'content-type': 'application/reports+json' }),
      await post(CSP_REPORT_PATH, REPORT, { 'content-type': 'application/json' }),
      await post(CSP_REPORT_PATH, REPORT, { 'content-type': 'text/plain' }),
      await post(CSP_REPORT_PATH, REPORT, { 'content-type': undefined }),
    ]
    for (const response of refused) expect([response.statusCode, response.json()]).toEqual([400, REFUSED])
    expect(reportLines(logs)).toEqual([])
  })
})
