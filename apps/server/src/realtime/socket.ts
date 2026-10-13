// The realtime role's WebSocket on /ws (C0.5's minimal one; C0.7's gateway grows from it). A
// socket is opened only for a live session, from the app's own origin (CLAUDE.md, Security and
// privacy), and closed as soon as that session ends (T5, ACC-05): at once when the api says so on
// the revocation channel (realtime/index.ts), and otherwise at the next re-check of every open
// socket's session, within SOCKET_RECHECK_MS.
//
// Once a listener for 'upgrade' exists, Node hands every upgrade request to it and never to
// Fastify, and leaves one it doesn't answer hanging. So the handler here answers every upgrade,
// whatever its path, and never lets a client's error reach the process: main.ts exits on an
// uncaught exception, so one client resetting its connection would otherwise end every socket.
// The api and worker roles have no listener, so Node answers an upgrade there as an ordinary
// request, which their 404 handler refuses.
//
// The server sends nothing yet and ignores what clients send; C0.7 adds the protocol, the
// heartbeat and the revoke-to-close metric.
import { type IncomingMessage, STATUS_CODES } from 'node:http'
import type { Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import type { FastifyInstance } from 'fastify'
import type { Logger } from 'pino'
import { WebSocket, WebSocketServer } from 'ws'
import { readCookie, SESSION_COOKIE } from '#src/auth/cookies.ts'
import { sha256 } from '#src/auth/crypto.ts'
import { SIGNED_OUT_CLOSE, SOCKETS_PER_SESSION } from '#src/auth/policy.ts'
import type { SessionIds } from '#src/db/pre-org.ts'
import { pathOf } from '#src/logger.ts'
import { isAppOrigin } from '#src/origin.ts'

export const SOCKET_PATH = '/ws'

// A frame from a client may be at most 4 KiB; a larger one closes that socket.
export const MAX_FRAME_BYTES = 4096

// How long a session lookup may take before the upgrade is refused 503.
export const LOOKUP_TIMEOUT_MS = 5000

// How long one re-check may take, at most, before it counts as failed (never longer than the
// re-check interval), so a query on a connection that has stopped answering can't hold up every
// later re-check and keep ended sessions' sockets open past T5's 60 s.
export const RECHECK_TIMEOUT_MS = 10_000

// How long a client gets to finish the closing handshake before its socket is cut.
export const CLOSE_GRACE_MS = 1000

// The close every socket gets when the server stops: the client reconnects (to another task).
export const STOPPING_CLOSE = { code: 1001, reason: 'server stopping' } as const

// Refused upgrades are logged at debug, since anyone can repeat them without limit, and summed up
// at info at most this often.
const REFUSAL_LOG_MS = 60_000

// Why an upgrade was refused, and what it was answered.
const REFUSALS = {
  path: { status: 404, error: 'not_found' },
  origin: { status: 403, error: 'forbidden' },
  session: { status: 401, error: 'signed_out' },
  busy: { status: 429, error: 'too_many_requests' },
  error: { status: 503, error: 'unavailable' },
} as const
export type Refusal = keyof typeof REFUSALS
const REFUSAL_NAMES = Object.keys(REFUSALS) as Refusal[]

export interface SocketServerOptions {
  appOrigin: string
  logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>
  // The live session behind a token's SHA-256, or undefined (db/pre-org.ts sessionByToken in
  // production; a fake in unit tests). A throw refuses the upgrade 503.
  lookup: (tokenHash: Buffer) => Promise<SessionIds | undefined>
  // Of these sessions, the ids still live. A throw keeps every socket open until the next try.
  stillLive: (sessions: readonly SessionIds[]) => Promise<Set<string>>
  recheckMs: number
  lookupTimeoutMs?: number
  // RECHECK_TIMEOUT_MS, or the re-check interval if that is shorter, unless a test sets it.
  recheckTimeoutMs?: number
}

export interface SocketCounts {
  // Sockets open now.
  open: number
  // Upgrades refused since the server started, by reason.
  refused: Record<Refusal, number>
  // Sockets closed because their session ended: told by the api, or found by the re-check.
  closedRevoked: number
  closedRecheck: number
}

export interface SocketServer {
  // Closes every open socket of these sessions with 4401 signed_out, and returns how many.
  // `at` is when the api published the revocation (epoch ms), for the revoke-to-close time.
  closeSessions(sessionIds: readonly string[], cause: 'revoked' | 'recheck', at?: number): number
  counts(): SocketCounts
}

function zeroRefusals(): Record<Refusal, number> {
  return { path: 0, origin: 0, session: 0, busy: 0, error: 0 }
}

export function attachSocketServer(app: FastifyInstance, options: SocketServerOptions): SocketServer {
  const { appOrigin, logger } = options
  const lookupTimeoutMs = options.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS
  const recheckTimeoutMs = options.recheckTimeoutMs ?? Math.min(options.recheckMs, RECHECK_TIMEOUT_MS)
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false })

  // Each open socket's session, and each session's open sockets.
  const sessionOf = new Map<WebSocket, SessionIds>()
  const socketsOf = new Map<string, Set<WebSocket>>()

  const refused = zeroRefusals()
  let refusalsLogged = zeroRefusals()
  let refusalsLoggedAt = Date.now()
  let closedRevoked = 0
  let closedRecheck = 0
  let stopping = false

  function refuse(socket: Duplex, reason: Refusal): void {
    refused[reason]++
    const { status, error } = REFUSALS[reason]
    logger.debug({ event: 'ws_refused', reason, status })
    if (!socket.writable) {
      socket.destroy()
      return
    }
    const body = JSON.stringify({ error })
    // As ws answers a refused handshake: end() sends the answer, and the socket goes once it has.
    socket.once('finish', () => socket.destroy())
    socket.end(
      `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\n` +
        'Connection: close\r\n' +
        'Cache-Control: no-store\r\n' +
        'Content-Type: application/json\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    )
  }

  async function lookupWithin(tokenHash: Buffer): Promise<SessionIds | undefined | 'timed out'> {
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<'timed out'>(resolve => {
      timer = setTimeout(() => resolve('timed out'), lookupTimeoutMs)
    })
    try {
      // A lookup that settles after the timer is still handled here, so its rejection is never
      // unhandled.
      return await Promise.race([Promise.resolve().then(() => options.lookup(tokenHash)), timedOut])
    } finally {
      clearTimeout(timer)
    }
  }

  async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    // First, before anything can wait: Node takes its own error listener off the socket when it
    // emits 'upgrade', so a client that resets now would raise an uncaught ECONNRESET.
    const onSocketError = () => socket.destroy()
    socket.on('error', onSocketError)
    if (stopping) return refuse(socket, 'error')
    if (pathOf(request.url) !== SOCKET_PATH) return refuse(socket, 'path')
    // A missing Origin, "null", the user-content origin and any other origin are all refused,
    // before anything is looked up.
    if (!isAppOrigin(request.headers.origin, appOrigin)) return refuse(socket, 'origin')
    const token = readCookie(request.headers.cookie, SESSION_COOKIE)
    if (token === undefined) return refuse(socket, 'session')

    let session: SessionIds | undefined | 'timed out'
    try {
      session = await lookupWithin(sha256(token))
    } catch (error) {
      logger.warn({ err: error, event: 'ws_lookup_failed' }, 'session lookup failed')
      return refuse(socket, 'error')
    }
    // The client went away while the session was looked up.
    if (socket.destroyed) return
    if (session === 'timed out') {
      logger.warn({ event: 'ws_lookup_timed_out' }, 'session lookup timed out')
      return refuse(socket, 'error')
    }
    if (session === undefined) return refuse(socket, 'session')
    if (stopping) return refuse(socket, 'error')
    if ((socketsOf.get(session.sessionId)?.size ?? 0) >= SOCKETS_PER_SESSION) return refuse(socket, 'busy')

    // ws adds its own error listener. handleUpgrade calls back in this same tick (there's no
    // verifyClient), so no other upgrade can pass the cap above before this one is counted.
    socket.removeListener('error', onSocketError)
    const ids = session
    wss.handleUpgrade(request, socket, head, ws => accept(ws, ids))
  }

  function accept(ws: WebSocket, session: SessionIds): void {
    // A frame over MAX_FRAME_BYTES, or any other protocol error, ends this socket and nothing
    // else. Without a listener the error would be thrown, and end the process.
    ws.on('error', error => {
      const code = (error as { code?: unknown }).code
      logger.info({
        event: 'ws_error',
        code: typeof code === 'string' ? code : undefined,
        sessionId: session.sessionId,
      })
      ws.terminate()
    })
    sessionOf.set(ws, session)
    let sockets = socketsOf.get(session.sessionId)
    if (sockets === undefined) {
      sockets = new Set()
      socketsOf.set(session.sessionId, sockets)
    }
    sockets.add(ws)
    ws.on('close', () => {
      sessionOf.delete(ws)
      const open = socketsOf.get(session.sessionId)
      open?.delete(ws)
      if (open?.size === 0) socketsOf.delete(session.sessionId)
    })
    logger.info({ event: 'ws_open', sessionId: session.sessionId })
  }

  // Closes the socket, and cuts it if the client hasn't finished the closing handshake within
  // CLOSE_GRACE_MS. Resolves once it has closed.
  function closeSocket(ws: WebSocket, code: number, reason: string): Promise<void> {
    return new Promise(resolve => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve()
        return
      }
      const timer = setTimeout(() => ws.terminate(), CLOSE_GRACE_MS)
      ws.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      ws.close(code, reason)
    })
  }

  function closeSessions(sessionIds: readonly string[], cause: 'revoked' | 'recheck', at?: number): number {
    let sockets = 0
    let sessions = 0
    for (const sessionId of sessionIds) {
      // Only sockets still open: one already closing has been counted.
      const open = [...(socketsOf.get(sessionId) ?? [])].filter(ws => ws.readyState === WebSocket.OPEN)
      if (open.length === 0) continue
      sessions++
      for (const ws of open) {
        sockets++
        void closeSocket(ws, SIGNED_OUT_CLOSE.code, SIGNED_OUT_CLOSE.reason)
      }
    }
    if (sockets === 0) return 0
    if (cause === 'revoked') closedRevoked += sockets
    else closedRecheck += sockets
    logger.info({
      event: 'ws_closed',
      cause,
      sessions,
      sockets,
      revokeToCloseMs: at === undefined ? undefined : Date.now() - at,
    })
    return sockets
  }

  // Logs the refusals since the last summary, at most once a minute and only when there were some.
  function logRefusals(): void {
    const now = Date.now()
    if (now - refusalsLoggedAt < REFUSAL_LOG_MS) return
    refusalsLoggedAt = now
    const since = zeroRefusals()
    for (const reason of REFUSAL_NAMES) since[reason] = refused[reason] - refusalsLogged[reason]
    refusalsLogged = { ...refused }
    if (REFUSAL_NAMES.some(reason => since[reason] > 0)) {
      logger.info({ event: 'ws_refused', ...since }, 'refused WebSocket upgrades in the last minute')
    }
  }

  // The re-check: every open socket's session, asked whether it's still live. One run at a time;
  // a tick that finds the last one still going is skipped. A failed check closes nothing, since
  // Postgres being down isn't a revocation; the next tick tries again. A check that takes longer
  // than recheckTimeoutMs has failed, so one that never answers doesn't stop the ticks after it.
  let checking = false
  async function recheck(): Promise<void> {
    if (checking) return
    checking = true
    let timer: NodeJS.Timeout | undefined
    try {
      const sessions = new Map<string, SessionIds>()
      for (const session of sessionOf.values()) sessions.set(session.sessionId, session)
      if (sessions.size === 0) return
      const timedOut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('the re-check timed out')), recheckTimeoutMs)
      })
      let live: Set<string>
      try {
        // A check that settles after the deadline is still handled here, so its rejection is
        // never unhandled.
        live = await Promise.race([Promise.resolve().then(() => options.stillLive([...sessions.values()])), timedOut])
      } catch (error) {
        logger.error({ err: error, event: 'ws_recheck_failed' }, 'could not re-check the open sockets')
        return
      }
      const ended = [...sessions.keys()].filter(id => !live.has(id))
      closeSessions(ended, 'recheck')
    } finally {
      clearTimeout(timer)
      checking = false
    }
  }

  const timer = setInterval(() => {
    logRefusals()
    void recheck()
  }, options.recheckMs)
  timer.unref()

  app.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    upgrade(request, socket, head).catch(error => {
      // Nothing above should throw; if something does, this socket goes and the process stays.
      logger.error({ err: error, event: 'ws_upgrade_failed' }, 'WebSocket upgrade failed')
      socket.destroy()
    })
  })

  // Before Fastify closes the HTTP server, which would otherwise wait for every open socket:
  // close each with 1001, cut any that hasn't closed within CLOSE_GRACE_MS, then stop ws.
  app.addHook('preClose', async () => {
    stopping = true
    clearInterval(timer)
    await Promise.all([...sessionOf.keys()].map(ws => closeSocket(ws, STOPPING_CLOSE.code, STOPPING_CLOSE.reason)))
    await Promise.race([
      new Promise<void>(resolve => wss.close(() => resolve())),
      delay(CLOSE_GRACE_MS, undefined, { ref: false }),
    ])
  })

  return {
    closeSessions,
    counts: () => ({ open: sessionOf.size, refused: { ...refused }, closedRevoked, closedRecheck }),
  }
}
