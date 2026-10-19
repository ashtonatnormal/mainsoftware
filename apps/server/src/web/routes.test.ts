// GET /api/session and GET /api/flags at the api (web/routes.ts), on a scripted pool: what they
// answer, that they run read only, which one counts as use of the session, and that no refusal of
// theirs clears the cookie (T21 item 10). The integration suite (routes.integration.test.ts) runs
// them on the Compose stack.
import { Writable } from 'node:stream'
import { FLAGS, type FlagSpec, FlagsResponse, MESSAGES, SessionResponse } from '@hearth/shared'
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
      return script.live === false ? [] : [{ fresh: false, pin_set: false, issued_privileged: false }]
    }
    if (text.includes('from "people"')) return [{ id: PERSON, deactivated_at: null }]
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
  return { app, logs, afterResponse, get }
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
  it('WR-01 T19 item 11 R-54 T21: without a session, or with a stale cookie, both answer 401 signed_out with no Set-Cookie (a GET never clears the cookie)', async () => {
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
    for (const app of [stale, ended]) {
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

  it('WR-02 T17 item 11 R-51: on is true, off and not_in_cohort are false, and only client: true keys are sent', async () => {
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

  it('WR-04 R-52 R-53: with a client key, the wait for the first read is bounded at 2.5 s and comes after the transaction; unconfirmed answers 503 unavailable', async () => {
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

  it('R-53: an org whose flags went unconfirmed answers 503 unavailable at once, and the route says so', async () => {
    const flags = staticFlags(REGISTRY)
    flags.verdict.mockImplementation((_org: string, key: string) => (key === 'it.beta' ? 'unconfirmed' : 'on'))
    const { get } = setup({ db: signedIn().db, flags })
    const response = await get('/api/flags', COOKIE)
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ error: 'unavailable', message: MESSAGES.unavailable })
    expect(response.headers['set-cookie']).toBeUndefined()
  })
})

describe('C0.8 OD-14 C-23 which GET counts as use of the session', () => {
  // The transaction each statement ran in, by the start statement before it.
  const transactionOf = (texts: string[], match: (text: string) => boolean): string | undefined => {
    const at = texts.findIndex(match)
    return texts
      .slice(0, at)
      .reverse()
      .find(text => text.startsWith('start transaction'))
  }
  const READ_ONLY = 'start transaction isolation level read committed read only'

  it('WR-05 OD-14 C-23 T21: GET /api/flags runs read only and queues no touch; GET /api/session runs read only and queues one', async () => {
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

describe('C0.8 OD-22 GET /api/session', () => {
  it('WR-07 OD-22 OD-10: the answer is the profile’s name and zone, else the full name and the org’s zone, read for the session’s own person', async () => {
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
