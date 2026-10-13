// The realtime role (C0.5): the WebSocket on /ws (realtime/socket.ts), wired to Postgres for the
// session checks and to Valkey for the revocation channel (revocation.ts). C0.7's gateway grows
// from it.
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { sql } from 'kysely'
import type { Logger } from 'pino'
import { SESSION, SOCKET_RECHECK_MS } from '#src/auth/policy.ts'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'
import { type Database, NoSystemPrincipal, withOrg } from '#src/db/database.ts'
import { type SessionIds, sessionByToken } from '#src/db/pre-org.ts'
import { attachSocketServer, type SocketServer } from '#src/realtime/socket.ts'
import { subscribeRevoked } from '#src/revocation.ts'
import { closeValkey } from '#src/valkey.ts'

export interface RealtimeDeps {
  db: Database
  // The revocation channel's own Valkey connection (valkey.ts createSubscriber). Without one,
  // sockets close only at the re-check.
  subscriber?: Redis
  keyPrefix: string
  // How often every open socket's session is re-checked; SOCKET_RECHECK_MS unless a test shortens it.
  recheckMs?: number
}

// How long to wait before subscribing to the revocation channel again after a failed try.
export const SUBSCRIBE_RETRY_MS = 1000

type LogTo = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>

export function registerRealtime(
  app: FastifyInstance,
  deps: RealtimeDeps & { appOrigin: string; logger: LogTo },
): SocketServer {
  const { db, logger } = deps
  const server = attachSocketServer(app, {
    appOrigin: deps.appOrigin,
    logger,
    lookup: tokenHash => sessionByToken(db, tokenHash, SESSION.idle),
    stillLive: sessions => liveSessions(db, sessions, logger),
    recheckMs: deps.recheckMs ?? SOCKET_RECHECK_MS,
  })
  const { subscriber } = deps
  if (subscriber !== undefined) {
    const stop = keepSubscribed(
      subscriber,
      deps.keyPrefix,
      (sessionIds, at) => server.closeSessions(sessionIds, 'revoked', at),
      logger,
    )
    // After the socket server's own preClose (hooks run in the order they're added), so the
    // sockets have closed by then; main.ts closing it again afterwards is harmless.
    app.addHook('preClose', async () => {
      stop()
      await closeValkey(subscriber)
    })
  }
  return server
}

// Of these sessions, the ids still live: not revoked, not expired, used within the idle limit, on
// a device still signed in, of a person who hasn't left. The same rules as session_by_token
// (0006), read in each org's own transaction acting as its system principal, with no row locks:
// it's a periodic re-check, not a refusal. An org with no system principal can't be checked, so
// its sessions count as ended (failing closed); any other error is thrown, and the re-check keeps
// every socket until its next try.
export async function liveSessions(
  db: Database,
  sessions: readonly SessionIds[],
  logger: Pick<Logger, 'error'>,
): Promise<Set<string>> {
  const byOrg = new Map<string, string[]>()
  for (const session of sessions) {
    const ids = byOrg.get(session.orgId)
    if (ids === undefined) byOrg.set(session.orgId, [session.sessionId])
    else ids.push(session.sessionId)
  }
  const live = new Set<string>()
  for (const [orgId, ids] of byOrg) {
    try {
      const { rows } = await withOrg(db, { orgId, system: true }, trx =>
        sql<{ id: string }>`
          select s.id from sessions s
          join devices d on d.org_id = s.org_id and d.user_id = s.user_id and d.id = s.device_id
          join people p on p.org_id = s.org_id and p.id = s.user_id
          where s.org_id = ${orgId} and s.id = any(${ids}::uuid[])
            and s.revoked_at is null
            and s.expires_at > now()
            and s.last_seen_at > now() - ${SESSION.idle}::interval
            and d.signed_out_at is null
            and p.deactivated_at is null`.execute(trx),
      )
      for (const row of rows) live.add(row.id)
    } catch (error) {
      if (!(error instanceof NoSystemPrincipal)) throw error
      logger.error({ err: error, event: 'ws_recheck_no_system_principal', orgId }, 'closing sockets of an org')
    }
  }
  return live
}

// Subscribes to the revocation channel, and keeps trying every SUBSCRIBE_RETRY_MS until it works:
// ioredis subscribes again by itself after a reconnect, but only to a channel a subscribe has
// already succeeded for, and one sent while Valkey is down fails. Until then sockets still close
// at the re-check. Returns a function that stops trying.
export function keepSubscribed(
  subscriber: Pick<Redis, 'subscribe' | 'on'>,
  keyPrefix: string,
  onRevoked: (sessionIds: string[], at: number) => void,
  logger: Pick<Logger, 'info' | 'warn' | 'error'>,
): () => void {
  const channel = valkeyKeys(keyPrefix).revoked
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  const subscribed = () => logger.info({ event: 'revocations_subscribed' }, 'listening for ended sessions')
  const retry = () => {
    if (stopped) return
    timer = setTimeout(() => {
      timer = undefined
      if (stopped) return
      // The channel's listener is already on the connection; only the subscribe is repeated.
      subscriber.subscribe(channel).then(subscribed, retry)
    }, SUBSCRIBE_RETRY_MS)
    timer.unref()
  }
  subscribeRevoked(subscriber, keyPrefix, onRevoked, logger).then(subscribed, (error: unknown) => {
    // Logged once; the connection's own errors are logged by valkey.ts.
    logger.warn({ err: error, event: 'revocations_subscribe_failed' }, 'could not listen for ended sessions yet')
    retry()
  })
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
