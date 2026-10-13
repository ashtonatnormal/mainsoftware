import type { IncomingHttpHeaders } from 'node:http'
import { type AddressInfo, connect } from 'node:net'
import { Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { buildApp } from '#src/app.ts'
import { sha256 } from '#src/auth/crypto.ts'
import { SOCKET_RECHECK_MS } from '#src/auth/policy.ts'
import type { SessionIds } from '#src/db/pre-org.ts'
import { createLogger } from '#src/logger.ts'
import { attachSocketServer, MAX_FRAME_BYTES, type SocketServerOptions } from '#src/realtime/socket.ts'

const APP_ORIGIN = 'https://hearth.example.com'
const USER_CONTENT_ORIGIN = 'https://content.hearth.example.net'
// Well-formed tokens (43 base64url characters), each one letter repeated, so no scanner takes
// them for secrets.
const TOKEN = 't'.repeat(43)
const OTHER_TOKEN = 'o'.repeat(43)
const UNKNOWN_TOKEN = 'u'.repeat(43)
const SESSION: SessionIds = {
  sessionId: 'b0000000-0000-4000-8000-0000000000e1',
  orgId: 'a0000000-0000-4000-8000-000000000001',
  userId: 'b0000000-0000-4000-8000-000000000001',
  deviceId: 'b0000000-0000-4000-8000-0000000000d1',
}
const OTHER_SESSION: SessionIds = {
  sessionId: 'b0000000-0000-4000-8000-0000000000e2',
  orgId: 'a0000000-0000-4000-8000-000000000001',
  userId: 'b0000000-0000-4000-8000-000000000002',
  deviceId: 'b0000000-0000-4000-8000-0000000000d2',
}

const signedIn = (token = TOKEN) => ({ origin: APP_ORIGIN, cookie: `__Host-hearth_session=${token}` })

// A client error that reached the process would end the realtime role (main.ts exits on one).
const uncaught = vi.fn()
beforeAll(() => {
  process.on('uncaughtException', uncaught)
})
afterAll(() => {
  process.off('uncaughtException', uncaught)
})

const running: FastifyInstance[] = []
afterEach(async () => {
  for (const app of running.splice(0)) await app.close()
  // Cleared each time, so a failure names the test that caused it.
  const errors = uncaught.mock.calls.map(([error]) => error)
  uncaught.mockClear()
  expect(errors).toEqual([])
})

// The two known tokens' sessions, as session_by_token would find them.
async function knownSessions(tokenHash: Buffer): Promise<SessionIds | undefined> {
  if (tokenHash.equals(sha256(TOKEN))) return SESSION
  if (tokenHash.equals(sha256(OTHER_TOKEN))) return OTHER_SESSION
  return undefined
}

async function start(options: Partial<SocketServerOptions> = {}) {
  const logs: Record<string, unknown>[] = []
  const stream = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split('\n').filter(Boolean)) logs.push(JSON.parse(line))
      done()
    },
  })
  const logger = createLogger({ logLevel: 'debug', role: 'realtime' }, stream)
  const app = buildApp({ appOrigin: APP_ORIGIN, logger, checks: {} })
  const lookup = vi.fn<SocketServerOptions['lookup']>(knownSessions)
  const stillLive = vi.fn<SocketServerOptions['stillLive']>(async sessions => new Set(sessions.map(s => s.sessionId)))
  const server = attachSocketServer(app, {
    appOrigin: APP_ORIGIN,
    logger,
    lookup,
    stillLive,
    recheckMs: SOCKET_RECHECK_MS,
    ...options,
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  running.push(app)
  const { port } = app.server.address() as AddressInfo
  return { app, server, port, url: `ws://127.0.0.1:${port}/ws`, logs, lookup, stillLive }
}

type Closed = { code: number; reason: string }
type Opened =
  | { status: number; body: string; headers: IncomingHttpHeaders }
  | { ws: WebSocket; closed: Promise<Closed> }

// Opens a socket as a browser would, with these headers: the socket once open, or the refusal.
function open(url: string, headers: Record<string, string> = {}): Promise<Opened> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers, perMessageDeflate: false })
    const closed = new Promise<Closed>(done => {
      ws.once('close', (code, reason) => done({ code, reason: reason.toString() }))
    })
    ws.on('error', reject)
    ws.once('open', () => resolve({ ws, closed }))
    ws.once('unexpected-response', (_request, response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        body += chunk
      })
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, body, headers: response.headers })
        ws.terminate()
      })
    })
  })
}

async function opened(url: string, headers: Record<string, string> = signedIn()) {
  const result = await open(url, headers)
  if (!('ws' in result)) throw new Error(`expected the socket to open, got ${result.status}`)
  return result
}

async function refused(url: string, headers: Record<string, string> = {}) {
  const result = await open(url, headers)
  if ('ws' in result) throw new Error('expected the upgrade to be refused')
  return result
}

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await delay(10)
  }
}

describe('C0.5 T5 the WebSocket upgrade: path, Origin, then session (CLAUDE.md, Security and privacy)', () => {
  it('answers an upgrade to any other path 404', async () => {
    const { port, server, lookup } = await start()
    const response = await refused(`ws://127.0.0.1:${port}/elsewhere`, signedIn())
    expect(response.status).toBe(404)
    expect(JSON.parse(response.body)).toEqual({ error: 'not_found' })
    expect(lookup).not.toHaveBeenCalled()
    expect(server.counts().refused.path).toBe(1)
  })

  it('refuses a cross-origin upgrade 403: no Origin, "null", the user-content origin and any other, without a lookup', async () => {
    const { url, server, lookup } = await start()
    const cookie = signedIn().cookie
    const cases: Array<Record<string, string>> = [
      { cookie },
      { cookie, origin: 'null' },
      { cookie, origin: USER_CONTENT_ORIGIN },
      { cookie, origin: 'https://evil.example' },
      { cookie, origin: `${APP_ORIGIN}/` },
    ]
    for (const headers of cases) {
      const response = await refused(url, headers)
      expect(response.status, headers.origin).toBe(403)
      expect(response.headers['content-type']).toBe('application/json')
      expect(JSON.parse(response.body)).toEqual({ error: 'forbidden' })
    }
    expect(lookup).not.toHaveBeenCalled()
    expect(server.counts().refused.origin).toBe(cases.length)
  })

  it('refuses 401 signed_out without a session cookie, and for a token with no live session', async () => {
    const { url, server, lookup } = await start()
    const none = await refused(url, { origin: APP_ORIGIN })
    expect(none.status).toBe(401)
    expect(JSON.parse(none.body)).toEqual({ error: 'signed_out' })
    expect(lookup).not.toHaveBeenCalled()
    const unknown = await refused(url, signedIn(UNKNOWN_TOKEN))
    expect(unknown.status).toBe(401)
    // The lookup gets the token's SHA-256, never the token.
    expect(lookup).toHaveBeenCalledWith(sha256(UNKNOWN_TOKEN))
    expect(server.counts().refused.session).toBe(2)
  })

  it('refuses 503 unavailable when the lookup fails, or takes longer than its time limit', async () => {
    const failing = await start({
      lookup: async () => {
        throw new Error('connection refused')
      },
    })
    const failed = await refused(failing.url, signedIn())
    expect(failed.status).toBe(503)
    expect(JSON.parse(failed.body)).toEqual({ error: 'unavailable' })
    expect(failed.body).not.toContain('connection refused')

    const slow = await start({ lookup: () => new Promise(() => {}), lookupTimeoutMs: 50 })
    const started = Date.now()
    const timedOut = await refused(slow.url, signedIn())
    expect(timedOut.status).toBe(503)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(slow.server.counts().refused.error).toBe(1)
  })

  it('opens (101) for a live session from the app origin, and logs the session id but never the token', async () => {
    const { url, server, logs } = await start()
    const { ws } = await opened(url)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    expect(server.counts().open).toBe(1)
    expect(logs).toContainEqual(expect.objectContaining({ event: 'ws_open', sessionId: SESSION.sessionId }))
    expect(JSON.stringify(logs)).not.toContain(TOKEN)
    ws.close()
    await until(() => server.counts().open === 0)
  })

  it('still serves plain HTTP on the same port: the probes, and 404 for a GET to /ws that is no upgrade', async () => {
    const { port } = await start()
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200)
    expect((await fetch(`http://127.0.0.1:${port}/ws`)).status).toBe(404)
  })

  it('T14: refuses a session’s 9th socket 429, and takes another once one closes', async () => {
    const { url, server } = await start()
    const sockets = []
    for (let i = 0; i < 8; i++) sockets.push(await opened(url))
    const ninth = await refused(url, signedIn())
    expect(ninth.status).toBe(429)
    expect(JSON.parse(ninth.body)).toEqual({ error: 'too_many_requests' })
    expect(server.counts().refused.busy).toBe(1)
    // Another session isn't held to this one's count.
    await opened(url, signedIn(OTHER_TOKEN))
    sockets[0]?.ws.close()
    await until(() => server.counts().open === 8)
    await opened(url)
  })
})

describe('C0.5 T5 ACC-05 closing a session’s sockets', () => {
  it('closes every socket of a revoked session with 4401 signed_out, and no other', async () => {
    const { url, server, logs } = await start()
    const first = await opened(url)
    const second = await opened(url)
    const other = await opened(url, signedIn(OTHER_TOKEN))
    expect(server.closeSessions([SESSION.sessionId], 'revoked', Date.now())).toBe(2)
    expect(await first.closed).toEqual({ code: 4401, reason: 'signed_out' })
    expect(await second.closed).toEqual({ code: 4401, reason: 'signed_out' })
    expect(other.ws.readyState).toBe(WebSocket.OPEN)
    // The server's side of a socket closes just after the client's.
    await until(() => server.counts().open === 1)
    expect(server.counts()).toMatchObject({ closedRevoked: 2, closedRecheck: 0 })
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: 'ws_closed',
        cause: 'revoked',
        sockets: 2,
        revokeToCloseMs: expect.any(Number),
      }),
    )
    // Telling it again, or naming a session with no socket here, closes nothing.
    expect(server.closeSessions([SESSION.sessionId, 'b0000000-0000-4000-8000-0000000000ff'], 'revoked')).toBe(0)
  })

  it('the re-check closes a socket whose session has ended, counted as closedRecheck', async () => {
    const live = new Set([SESSION.sessionId, OTHER_SESSION.sessionId])
    const stillLive = vi.fn<SocketServerOptions['stillLive']>(async () => new Set(live))
    const { url, server } = await start({ recheckMs: 50, stillLive })
    const ending = await opened(url)
    const staying = await opened(url, signedIn(OTHER_TOKEN))
    // Both sessions live: the re-check runs and closes nothing.
    const calls = stillLive.mock.calls.length
    await until(() => stillLive.mock.calls.length >= calls + 2)
    expect(ending.ws.readyState).toBe(WebSocket.OPEN)
    live.delete(SESSION.sessionId)
    expect(await ending.closed).toEqual({ code: 4401, reason: 'signed_out' })
    expect(staying.ws.readyState).toBe(WebSocket.OPEN)
    await until(() => server.counts().open === 1)
    expect(server.counts()).toMatchObject({ closedRevoked: 0, closedRecheck: 1 })
  })

  it('a re-check that fails closes no socket while it can still be confirmed in time: Postgres being down is no revocation', async () => {
    const stillLive = vi.fn<SocketServerOptions['stillLive']>(async () => {
      throw new Error('connection refused')
    })
    const { url, server, logs } = await start({ recheckMs: 50, stillLive })
    const { ws } = await opened(url)
    await until(() => stillLive.mock.calls.length >= 3)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    expect(server.counts()).toMatchObject({ open: 1, closedRecheck: 0, closedUnchecked: 0 })
    expect(logs).toContainEqual(expect.objectContaining({ event: 'ws_recheck_failed' }))
  })

  it('T5 ACC-05: refuses re-check timings that could not close an ended session within revokeWithinMs', () => {
    const logger = createLogger({ logLevel: 'silent', role: 'realtime' })
    const app = buildApp({ appOrigin: APP_ORIGIN, logger, checks: {} })
    const base = { appOrigin: APP_ORIGIN, logger, lookup: knownSessions, stillLive: async () => new Set<string>() }
    // 50 s plus the 10 s deadline reaches the 60 s limit; 49 s plus 10 s doesn't.
    expect(() => attachSocketServer(app, { ...base, recheckMs: 50_000 })).toThrow(/shorter than revokeWithinMs/)
    expect(() => attachSocketServer(app, { ...base, recheckMs: 100, revokeWithinMs: 200 })).toThrow(
      /shorter than revokeWithinMs/,
    )
    expect(() => attachSocketServer(app, { ...base, recheckMs: 49_000 })).not.toThrow()
    void app.close()
  })

  it('T5 ACC-05: while re-checks keep failing, a socket closes with 1013 at the first failure the next could leave past revokeWithinMs', async () => {
    // A revocation whose message was lost, with Postgres down: only the deadline closes the socket.
    // The ticks and the clock are fake, so each re-check lands at an exact time; the sockets, and
    // each re-check's own deadline timer, stay real.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date', 'performance'] })
    try {
      const stillLive = vi.fn<SocketServerOptions['stillLive']>(async () => {
        throw new Error('connection refused')
      })
      // A re-check every 1 s with a 2 s deadline, against a 10 s limit: a failure at t only keeps
      // the limit if the next re-check settles by t + 3 s, so the socket (confirmed at 0) closes at
      // the first failure after 7 s.
      const { url, server, logs } = await start({
        recheckMs: 1000,
        recheckTimeoutMs: 2000,
        revokeWithinMs: 10_000,
        stillLive,
      })
      const { ws, closed } = await opened(url)
      // The host's clock jumping an hour moves no deadline: they run on the monotonic clock.
      vi.setSystemTime(Date.now() + 3_600_000)
      await vi.advanceTimersByTimeAsync(7000)
      expect(stillLive).toHaveBeenCalledTimes(7)
      expect(ws.readyState).toBe(WebSocket.OPEN)
      expect(server.counts()).toMatchObject({ closedUnchecked: 0 })
      await vi.advanceTimersByTimeAsync(1000)
      expect(stillLive).toHaveBeenCalledTimes(8)
      expect(await closed).toEqual({ code: 1013, reason: 'try again later' })
      await until(() => server.counts().open === 0)
      expect(server.counts()).toMatchObject({ closedUnchecked: 1, closedRecheck: 0, closedRevoked: 0 })
      expect(logs).toContainEqual(expect.objectContaining({ event: 'ws_closed', cause: 'unchecked', sockets: 1 }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('T5 ACC-05: a re-check that succeeds between failures confirms the session again, so its socket stays', async () => {
    let calls = 0
    // Every third re-check answers; the two in between fail.
    const stillLive = vi.fn<SocketServerOptions['stillLive']>(async sessions => {
      calls++
      if (calls % 3 !== 0) throw new Error('connection refused')
      return new Set(sessions.map(session => session.sessionId))
    })
    const { url, server } = await start({ recheckMs: 50, revokeWithinMs: 600, stillLive })
    const { ws } = await opened(url)
    // Well past 600 ms since the upgrade: only the successful re-checks keep it open.
    await until(() => stillLive.mock.calls.length >= 24, 5000)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    expect(server.counts()).toMatchObject({ open: 1, closedUnchecked: 0 })
  })

  it('T5 ACC-05: a re-check that never answers counts as failed, and the next one still runs and closes an ended session', async () => {
    let calls = 0
    const stillLive = vi.fn<SocketServerOptions['stillLive']>(() => {
      calls++
      // The first query never answers, as on a connection that died without closing; by the
      // next, the session has ended.
      return calls === 1 ? new Promise<Set<string>>(() => {}) : Promise.resolve(new Set<string>())
    })
    const { url, server, logs } = await start({ recheckMs: 50, stillLive })
    const { ws, closed } = await opened(url)
    await until(() => ws.readyState === WebSocket.CLOSED)
    expect(await closed).toEqual({ code: 4401, reason: 'signed_out' })
    expect(stillLive.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(server.counts()).toMatchObject({ closedRecheck: 1 })
    expect(logs).toContainEqual(expect.objectContaining({ event: 'ws_recheck_failed' }))
  })

  it('stopping the server closes its sockets with 1001 and returns promptly', async () => {
    const { app, url } = await start()
    const first = await opened(url)
    const second = await opened(url, signedIn(OTHER_TOKEN))
    const started = Date.now()
    await app.close()
    expect(Date.now() - started).toBeLessThan(2000)
    expect(await first.closed).toEqual({ code: 1001, reason: 'server stopping' })
    expect(await second.closed).toEqual({ code: 1001, reason: 'server stopping' })
    running.splice(running.indexOf(app), 1)
  })

  it('stopping the server cuts a socket whose client never finishes the closing handshake', async () => {
    const { app, port } = await start()
    // A raw client that completes the upgrade, then never reads or answers anything.
    const socket = connect(port, '127.0.0.1')
    socket.on('error', () => {})
    await new Promise(resolve => socket.once('connect', resolve))
    socket.write(upgradeRequest(TOKEN))
    const answer = await new Promise<Buffer>(resolve => socket.once('data', resolve))
    expect(answer.toString('latin1')).toMatch(/^HTTP\/1\.1 101 /)
    socket.pause()
    const started = Date.now()
    await app.close()
    expect(Date.now() - started).toBeLessThan(2500)
    running.splice(running.indexOf(app), 1)
    socket.destroy()
  })
})

function upgradeRequest(token: string): string {
  return [
    'GET /ws HTTP/1.1',
    'Host: 127.0.0.1',
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    // 16 zero bytes: a valid key that no secret scanner takes for one.
    'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==',
    `Origin: ${APP_ORIGIN}`,
    `Cookie: __Host-hearth_session=${token}`,
    '',
    '',
  ].join('\r\n')
}

describe('C0.5 T14 item 14: no client can end the realtime process', () => {
  it.each([
    ['refuses', undefined],
    ['accepts', SESSION],
  ] as const)(
    'a client that resets during a slow lookup, which then %s, leaves the process running',
    async (_outcome, answer) => {
      let release: (session: SessionIds | undefined) => void = () => {}
      let asked: () => void = () => {}
      const lookedUp = new Promise<void>(resolve => {
        asked = resolve
      })
      const { server, port } = await start({
        lookup: () => {
          asked()
          return new Promise(resolve => {
            release = resolve
          })
        },
      })
      const socket = connect(port, '127.0.0.1')
      await new Promise(resolve => socket.once('connect', resolve))
      socket.write(upgradeRequest(TOKEN))
      await lookedUp
      socket.resetAndDestroy()
      await delay(50)
      release(answer)
      await delay(50)
      await until(() => server.counts().open === 0)
      expect(uncaught).not.toHaveBeenCalled()
    },
  )

  it('a frame over 4 KiB closes that socket and no other', async () => {
    const { url, server } = await start()
    const sender = await opened(url)
    const bystander = await opened(url)
    sender.ws.send('x'.repeat(MAX_FRAME_BYTES + 1))
    const closed = await sender.closed
    // 1009 (message too big) when the close frame gets out before the socket is cut, else 1006.
    expect([1006, 1009]).toContain(closed.code)
    await until(() => server.counts().open === 1)
    expect(bystander.ws.readyState).toBe(WebSocket.OPEN)
    // The bystander still answers.
    const pong = new Promise(resolve => bystander.ws.once('pong', resolve))
    bystander.ws.ping()
    await pong
  })

  it('a frame of exactly 4 KiB is fine, and is ignored', async () => {
    const { url, server } = await start()
    const { ws } = await opened(url)
    ws.send('x'.repeat(MAX_FRAME_BYTES))
    const pong = new Promise(resolve => ws.once('pong', resolve))
    ws.ping()
    await pong
    expect(server.counts().open).toBe(1)
  })
})
