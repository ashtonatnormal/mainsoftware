// The realtime role (C0.5; the gateway from C0.7, TECH-SPEC T19): the gateway on /ws
// (realtime/socket.ts), wired to Postgres for the session lookup and the checks (realtime/checks.ts,
// read only and acting as each org's system principal), to Valkey for the revocation channels
// (revocation/channels.ts) and the org event streams (realtime/stream.ts), and to the flags it keeps
// for every org it has a socket in (C0.6, flags/cache.ts).
//   - revoked (the api's push) and access (the worker's durable jobs, and from C0.16 the api's push
//     for team and role changes) name ended sessions, whose sockets close at once with no database
//     read, and people whose keys changed, whom the decision lane re-checks against Postgres.
//   - A change to a flag the browser may see (client: true) nudges every socket of its org, with no
//     values, coalesced on its trailing edge (T19 item 10, P4).
//   - The admission hook (C0.9) is asked inside the gateway's own transactions; unset, everyone is
//     admitted and nothing is queried.
//   - Readiness: the full check fails while the process stops, while either revocation channel isn't
//     subscribed, while the stream reader is stuck, and while the last two periodic checks with
//     sockets to check both failed; the local one, for the load balancer, only before both channels
//     have been subscribed once and while the process stops (T19 item 12, P2).
// Realtime writes nothing to Postgres: apart from C0.5's pre-org session lookup, every transaction it
// opens is read only (T19 item 14).
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import type { Logger } from 'pino'
import { SESSION, SOCKET_RECHECK_MS } from '#src/auth/policy.ts'
import { valkeyKeys } from '#src/auth/valkey-keys.ts'
import type { Database } from '#src/db/database.ts'
import { sessionByToken } from '#src/db/pre-org.ts'
import type { FlagCache } from '#src/flags/cache.ts'
import type { Subscriptions } from '#src/pubsub.ts'
import type { Check } from '#src/ready.ts'
import { type Admission, orgChecker } from '#src/realtime/checks.ts'
import { type GatewayPolicy, gatewayPolicy } from '#src/realtime/policy.ts'
import { attachSocketServer, type SocketServer } from '#src/realtime/socket.ts'
import { planResume, StreamReader } from '#src/realtime/stream.ts'
import { listenAccess, listenRevoked } from '#src/revocation/channels.ts'
import { RevocationLatency } from '#src/revocation/latency.ts'

export interface RealtimeDeps {
  db: Database
  // The process's pub/sub channels (pubsub.ts), on which this listens for ended sessions and changed
  // access. Without them, sockets close only at the checks. Whoever made them closes them.
  subscriptions?: Pick<Subscriptions, 'add' | 'isLive'>
  // The process's flags (C0.6): each socket's org is kept from its first upgrade on, and a change to
  // a client flag nudges the org's sockets.
  flags?: Pick<FlagCache, 'track' | 'onChange' | 'registry'>
  // The command client and the blocking reader's connection (valkey.ts createBlockingReader): with
  // both, the gateway reads each org's event stream (fan-out and resume). Without them, positions are
  // unknown and every resume answers reset. Whoever made them closes them.
  valkey?: Pick<Redis, 'get' | 'set' | 'pexpire' | 'xrange' | 'xrevrange' | 'xinfo'>
  reader?: Pick<Redis, 'xread' | 'on'>
  keyPrefix: string
  // How often every open socket is checked; SOCKET_RECHECK_MS unless a test shortens it.
  recheckMs?: number
  // C0.9's acknowledgement gate.
  admission?: Admission
  // A test's shorter timings (realtime/policy.ts overrides, and the bound and the check's deadline).
  policy?: Partial<GatewayPolicy>
  revokeWithinMs?: number
  recheckTimeoutMs?: number
}

// The gateway, and its two readiness checks.
export interface Gateway extends SocketServer {
  check: Check
  localCheck: Check
}

type LogTo = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>

export function registerRealtime(
  app: FastifyInstance,
  deps: RealtimeDeps & { appOrigin: string; logger: LogTo },
): Gateway {
  const { db, logger, flags, valkey, reader, subscriptions } = deps
  const policy = gatewayPolicy(deps.policy)
  const keys = valkeyKeys(deps.keyPrefix)
  const latency = new RevocationLatency({ logger, summaryMs: 0 })
  const server = attachSocketServer(app, {
    appOrigin: deps.appOrigin,
    logger,
    lookup: async tokenHash => {
      const session = await sessionByToken(db, tokenHash, SESSION.idle)
      // Starts keeping the org's flags (it never rejects; the cache keeps trying by itself).
      if (session !== undefined) void flags?.track(session.orgId)
      return session
    },
    check: orgChecker(db, { admission: deps.admission, policy }),
    recheckMs: deps.recheckMs ?? SOCKET_RECHECK_MS,
    ...(deps.revokeWithinMs === undefined ? {} : { revokeWithinMs: deps.revokeWithinMs }),
    ...(deps.recheckTimeoutMs === undefined ? {} : { recheckTimeoutMs: deps.recheckTimeoutMs }),
    ...(deps.policy === undefined ? {} : { policy: deps.policy }),
    admission: deps.admission !== undefined,
    latency,
    ...(valkey !== undefined && reader !== undefined
      ? {
          stream: target => new StreamReader({ valkey, reader, keyPrefix: deps.keyPrefix, target, logger, policy }),
          resume: (orgId, request, current) => planResume(valkey, keys.stream(orgId), request, current, { policy }),
        }
      : {}),
  })

  // Whether each revocation channel has been subscribed at least once since the start.
  const subscribed = { revoked: false, access: false }
  if (subscriptions !== undefined) {
    // Each resolves once subscribed; until then (Valkey down, say) sockets still close at the checks.
    void listenRevoked(
      subscriptions,
      deps.keyPrefix,
      (sessionIds, at) => server.closeSessions(sessionIds, { path: 'push', cause: 'sessions_ended', at }),
      logger,
    ).then(() => {
      subscribed.revoked = true
    })
    void listenAccess(
      subscriptions,
      deps.keyPrefix,
      message => {
        const trigger = { path: message.path, cause: message.cause, at: message.at }
        // Publishers name only sessions that have ended (the api after its commit, the worker after
        // its re-read), so they close at once, with no database read.
        if (message.sessions !== undefined) server.closeSessions(message.sessions, trigger)
        // People whose access changed (an unknown cause included): re-checked against Postgres.
        if (message.people !== undefined) server.peopleChanged(message.org, message.people, trigger)
      },
      logger,
    ).then(() => {
      subscribed.access = true
    })
  }

  // A change to a flag whose value may reach the browser nudges the org's sockets (T17 item 11).
  if (flags !== undefined) {
    flags.onChange((orgId, changed) => {
      if (changed.some(key => Object.hasOwn(flags.registry, key) && flags.registry[key]?.client === true)) {
        server.nudge(orgId, 'flags')
      }
    })
  }

  const check: Check = async () => {
    if (server.stopping()) throw new Error('the gateway is stopping')
    if (subscriptions === undefined || !subscriptions.isLive('revoked') || !subscriptions.isLive('access')) {
      throw new Error('the gateway isn’t listening on both revocation channels')
    }
    if (server.readerStuck()) throw new Error('the gateway’s stream reader is stuck')
    if (server.checksFailing()) throw new Error('the gateway’s last two checks failed')
  }
  const localCheck: Check = async () => {
    if (server.stopping()) throw new Error('the gateway is stopping')
    if (!subscribed.revoked || !subscribed.access) {
      throw new Error('the gateway hasn’t listened on both revocation channels yet')
    }
  }
  return Object.assign(server, { check, localCheck })
}
