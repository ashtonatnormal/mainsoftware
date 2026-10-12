// The Fastify app every role serves. In C0.2 that's the Origin check and the two probes; the api
// routes (C0.5 on), the realtime gateway (C0.7) and the worker's jobs register on top of it.
import { type FastifyBaseLogger, type FastifyInstance, fastify } from 'fastify'
import type { LevelWithSilent, Logger } from 'pino'
import { refuseCrossSiteWrites } from '#src/origin.ts'
import { type Check, checkReadiness } from '#src/ready.ts'

export interface AppOptions {
  appOrigin: string
  logger: Logger
  checks: Record<string, Check>
}

export function buildApp({ appOrigin, logger, checks }: AppOptions): FastifyInstance {
  const loggerInstance: FastifyBaseLogger = logger
  const app = fastify({ loggerInstance })
  refuseCrossSiteWrites(app, appOrigin)

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

  return app
}
