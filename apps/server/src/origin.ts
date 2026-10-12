// The cross-site request check (CLAUDE.md, Security and privacy). Every state change from a
// browser must come from the app's own origin, so one hook at the root refuses any request that
// isn't a GET or HEAD unless its Origin header is exactly the app origin. A missing or "null"
// Origin is refused too. The WebSocket upgrade handler (C0.5, C0.7) calls isAppOrigin before
// accepting. Provider webhooks (LiveKit, SMS) will be the only exemption, and they verify the
// provider's signature instead; none exist yet.
import type { FastifyInstance } from 'fastify'
import { pathOf } from '#src/logger.ts'

const SAFE_METHODS = new Set(['GET', 'HEAD'])

export function isAppOrigin(origin: string | string[] | undefined, appOrigin: string): boolean {
  return typeof origin === 'string' && origin === appOrigin
}

// Registered on the root instance before any route or plugin, so every route inherits it,
// including the not-found handler and routes inside encapsulated plugins.
export function refuseCrossSiteWrites(app: FastifyInstance, appOrigin: string): void {
  app.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return
    if (isAppOrigin(request.headers.origin, appOrigin)) return
    request.log.warn({ method: request.method, url: pathOf(request.url) }, 'refused a request from another origin')
    return reply.code(403).send({ error: 'Forbidden' })
  })
}
