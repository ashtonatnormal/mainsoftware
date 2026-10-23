// The realtime role (C0.5; the gateway from C0.7, TECH-SPEC T19): the gateway on /ws
// (realtime/socket.ts), wired to Postgres for the session lookup and the checks (realtime/checks.ts,
// read only and acting as each org's system principal), to Valkey for the revocation channels
// (revocation/channels.ts) and the org event streams (realtime/stream.ts, for fan-out only: clients
// resubscribe and refetch over REST, T19 item 9), and to the flags it keeps for every org it has a
// socket in (C0.6, flags/cache.ts).
//   - revoked (the api's push) and access (the worker's durable jobs, and from C0.16 the api's push
//     for team and role changes) name ended sessions, whose sockets close at once with no database
//     read, and people whose keys changed, whom the decision lane re-checks against Postgres.
//   - A change to a flag the browser may see (client: true) nudges every socket of its org, with no
//     values, coalesced on its trailing edge (T19 item 10, P4).
//   - The admission hook (C0.9 PD-45, realtime/admission.ts) is asked inside the gateway's own
//     transactions: only someone who has acknowledged the org's latest notice holds a socket. It is
//     always wired; only a test sets admissionForTests, to another hook or to 'none' (C0.7's
//     behaviour: everyone admitted, nothing queried), and main.ts never names it
//     (scripts/guards/api-test-overrides.test.ts).
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
import type { Database } from '#src/db/database.ts'
import { sessionByToken } from '#src/db/pre-org.ts'
import type { FlagCache } from '#src/flags/cache.ts'
import type { Subscriptions } from '#src/pubsub.ts'
import type { Check } from '#src/ready.ts'
import { NOTICE_ADMISSION } from '#src/realtime/admission.ts'
import { type Admission, type CheckOrg, orgChecker } from '#src/realtime/checks.ts'
import { type GatewayPolicy, gatewayPolicy } from '#src/realtime/policy.ts'
import { attachSocketServer, type SocketServer } from '#src/realtime/socket.ts'
import { StreamReader } from '#src/realtime/stream.ts'
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
  // both, the gateway reads each org's event stream and fans its events out to its sockets (it runs
  // no script and appends nothing). Without them, no event reaches a socket, and clients see only
  // what they fetch over REST. Whoever made them closes them.
  valkey?: Pick<Redis, 'get' | 'set' | 'pexpire' | 'xrevrange' | 'multi'>
  reader?: Pick<Redis, 'xread' | 'on'>
  keyPrefix: string
  // How often every open socket is checked; SOCKET_RECHECK_MS unless a test shortens it.
  recheckMs?: number
  // Tests only (main.ts never sets it): C0.9's acknowledgement gate replaced by another hook, or
  // 'none' for C0.7's behaviour (no admission, nothing queried). Unset, production's
  // NOTICE_ADMISSION, with admission on (PD-45, B-07, C-07).
  admissionForTests?: Admission | 'none'
  // A test's shorter timings (realtime/policy.ts overrides, and the bound and the check's deadline).
  policy?: Partial<GatewayPolicy>
  revokeWithinMs?: number
  recheckTimeoutMs?: number
  // Tests only (main.ts never sets it): wraps each org's check, the lane's and the periodic one's, so
  // an integration test can hold a subscribe decision after its read (T19 item 6's race).
  wrapCheck?: (check: CheckOrg) => CheckOrg
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
  const latency = new RevocationLatency({ logger, summaryMs: 0 })
  const admission = deps.admissionForTests === 'none' ? undefined : (deps.admissionForTests ?? NOTICE_ADMISSION)
  const checker = orgChecker(db, { admission, policy })
  const server = attachSocketServer(app, {
    appOrigin: deps.appOrigin,
    logger,
    lookup: async tokenHash => {
      const session = await sessionByToken(db, tokenHash, SESSION.idle)
      // Starts keeping the org's flags (it never rejects; the cache keeps trying by itself).
      if (session !== undefined) void flags?.track(session.orgId)
      return session
    },
    check: deps.wrapCheck === undefined ? checker : deps.wrapCheck(checker),
    recheckMs: deps.recheckMs ?? SOCKET_RECHECK_MS,
    ...(deps.revokeWithinMs === undefined ? {} : { revokeWithinMs: deps.revokeWithinMs }),
    ...(deps.recheckTimeoutMs === undefined ? {} : { recheckTimeoutMs: deps.recheckTimeoutMs }),
    ...(deps.policy === undefined ? {} : { policy: deps.policy }),
    admission: admission !== undefined,
    latency,
    ...(valkey !== undefined && reader !== undefined
      ? { stream: target => new StreamReader({ valkey, reader, keyPrefix: deps.keyPrefix, target, logger, policy }) }
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

  // A change to a flag whose value may reach the browser nudges the org's sockets (T17 item 11),
  // until the gateway stops: the cache outlives it, so its listener goes at the drain.
  if (flags !== undefined) {
    const stopNudges = flags.onChange((orgId, changed) => {
      if (changed.some(key => Object.hasOwn(flags.registry, key) && flags.registry[key]?.client === true)) {
        server.nudge(orgId, 'flags')
      }
    })
    app.addHook('preClose', async () => {
      // The remover answers whether it removed anything; a close hook must resolve with nothing,
      // since Fastify treats anything else as an error.
      stopNudges()
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
