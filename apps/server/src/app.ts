// The Fastify app every role serves: the Origin check, the not-found handler and the two probes.
// On top of that, the api role serves the sign-in, device and admin routes under /api (C0.5,
// api.ts), and the realtime role the WebSocket on /ws (C0.5's minimal one, realtime/; C0.7's
// gateway grows from it). The worker adds nothing yet; its jobs come as they're needed. main.ts
// chooses what a role gets, and scripts/check-server.sh checks each role serves only its own.
import { randomUUID } from 'node:crypto'
import { type FastifyBaseLogger, type FastifyInstance, fastify } from 'fastify'
import type { LevelWithSilent, Logger } from 'pino'
import { type ApiDeps, registerApi } from '#src/api.ts'
import { refuseCrossSiteWrites } from '#src/origin.ts'
import { type Check, checkReadiness } from '#src/ready.ts'
import { type RealtimeDeps, registerRealtime } from '#src/realtime/index.ts'

export interface AppOptions {
  appOrigin: string
  logger: Logger
  checks: Record<string, Check>
  // The proxies trusted for the client's address (TRUST_PROXY); false or absent: none, so the
  // address is the connection's own and X-Forwarded-For is ignored.
  trustProxy?: string[] | false
  // The api role's routes (C0.5): sign-in, devices and admin actions, under /api.
  api?: ApiDeps
  // The realtime role's socket on /ws (C0.5's minimal one; C0.7's gateway grows from it).
  realtime?: RealtimeDeps
}

export function buildApp({ appOrigin, logger, checks, trustProxy, api, realtime }: AppOptions): FastifyInstance {
  const loggerInstance: FastifyBaseLogger = logger
  const app = fastify({
    loggerInstance,
    trustProxy: trustProxy && trustProxy.length > 0 ? trustProxy : false,
    // Every request gets a random uuid, unique across processes, for its log lines and audit rows.
    // A client's X-Request-Id is never taken, so no client can choose what an audit row records.
    genReqId: () => randomUUID(),
    requestIdHeader: false,
  })
  refuseCrossSiteWrites(app, appOrigin)

  // Fastify's own 404 logs and returns the whole URL, query string included; this answers without
  // echoing it, and the request log line already records the path.
  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: 'Not Found' }))

  // The probes are called every few seconds, so their requests are logged only at warn and
  // above, unless the configured level is quieter still.
  const probeLogLevel = logger.isLevelEnabled('warn') ? 'warn' : (logger.level as LevelWithSilent)

  // Liveness: the process is up and its event loop answers. It checks no dependency, so a
  // database outage doesn't get every task restarted.
  app.get('/health', { logLevel: probeLogLevel }, async () => ({ status: 'ok' }))

  // Readiness: every dependency answers. The body names each check's result but no error
  // detail; the details go to the log.
  app.get('/ready', { logLevel: probeLogLevel }, async (request, reply) => {
    const { ready, checks: results } = await checkReadiness(checks, (name, error) =>
      request.log.warn({ check: name, err: error }, 'readiness check failed'),
    )
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not ready', checks: results })
  })

  if (api) registerApi(app, { appOrigin, ...api })
  if (realtime) registerRealtime(app, { appOrigin, logger, ...realtime })

  return app
}
