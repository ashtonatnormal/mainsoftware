// The realtime role (C0.5): the WebSocket on /ws (realtime/socket.ts), wired to Postgres for the
// session checks and to Valkey for the revocation channels (revocation/channels.ts): revoked, the
// api's push, and from C0.7 access, on which the worker's revocation jobs publish the sessions
// they found ended (closed at once, as on revoked) and the people whose keys changed (left to the
// re-check of every socket until the gateway's targeted re-checks). It keeps the flags of every org
// it has a socket for (C0.6, flags/cache.ts), so a change reaches it within 10 s. C0.7's gateway
// grows from it.
import type { FastifyInstance } from 'fastify'
import { sql } from 'kysely'
import type { Logger } from 'pino'
import { SESSION, SOCKET_RECHECK_MS } from '#src/auth/policy.ts'
import { type Database, NoSystemPrincipal, withOrg } from '#src/db/database.ts'
import { type SessionIds, sessionByToken } from '#src/db/pre-org.ts'
import type { FlagCache } from '#src/flags/cache.ts'
import type { Subscriptions } from '#src/pubsub.ts'
import { attachSocketServer, type SocketServer } from '#src/realtime/socket.ts'
import { listenAccess, listenRevoked } from '#src/revocation/channels.ts'

export interface RealtimeDeps {
  db: Database
  // The process's pub/sub channels (pubsub.ts), on which this listens for ended sessions. Without
  // them, sockets close only at the re-check. Whoever made them closes them.
  subscriptions?: Pick<Subscriptions, 'add'>
  // The process's flags (C0.6): each socket's org is kept from its first upgrade on.
  flags?: Pick<FlagCache, 'track'>
  keyPrefix: string
  // How often every open socket's session is re-checked; SOCKET_RECHECK_MS unless a test shortens it.
  recheckMs?: number
}

type LogTo = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>

export function registerRealtime(
  app: FastifyInstance,
  deps: RealtimeDeps & { appOrigin: string; logger: LogTo },
): SocketServer {
  const { db, logger, flags } = deps
  const server = attachSocketServer(app, {
    appOrigin: deps.appOrigin,
    logger,
    lookup: async tokenHash => {
      const session = await sessionByToken(db, tokenHash, SESSION.idle)
      // Starts keeping the org's flags (it never rejects; the cache keeps trying by itself).
      if (session !== undefined) void flags?.track(session.orgId)
      return session
    },
    stillLive: sessions => liveSessions(db, sessions, logger),
    recheckMs: deps.recheckMs ?? SOCKET_RECHECK_MS,
  })
  if (deps.subscriptions !== undefined) {
    // Each resolves once subscribed; until then (Valkey down, say) sockets still close at the
    // re-check.
    void listenRevoked(
      deps.subscriptions,
      deps.keyPrefix,
      (sessionIds, at) => server.closeSessions(sessionIds, 'revoked', at),
      logger,
    )
    void listenAccess(
      deps.subscriptions,
      deps.keyPrefix,
      message => {
        // Publishers name only sessions that have ended (the api after its commit, the worker after
        // its re-read), so they close at once, with no database read.
        if (message.sessions !== undefined) server.closeSessions(message.sessions, 'revoked', message.at)
        // People whose keys changed: the next re-check of every socket finds what they lost.
        if (message.people !== undefined) {
          logger.debug({ event: 'access_people_signal', path: message.path, people: message.people.length })
        }
      },
      logger,
    )
  }
  return server
}

// Of these sessions, the ids still live: not revoked, not expired, used within the idle limit, on
// a device still signed in, of a person who hasn't left. The same rules as session_by_token
// (0006), read in each org's own transaction acting as its system principal, with no row locks:
// it's a periodic re-check, not a refusal. An org with no system principal can't be checked, so
// its sessions count as ended (failing closed); any other error is thrown, and the failed re-check
// closes only the sockets it can no longer confirm in time (socket.ts closeUnconfirmed).
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
