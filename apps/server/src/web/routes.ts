// The web shell's own reads under /api (T21 item 10): GET /api/session (who is signed in) and
// GET /api/flags (the client flags evaluated for them). Both are registered inside the /api scope
// (api.ts), so they get its no-store header, error handler and not-found handler, and the root
// Origin hook leaves GETs alone. They run on the api role only.
//
// A GET never clears the session cookie. Every other signed-in route answers an ended session
// with a 401 that clears it (sessions.ts signedOut()), but the shell's boot sends these two before
// it knows whether anyone is signed in, and one that answered after another tab had just signed in
// would delete that tab's new session, costing the person another code. So their refusals carry no
// Set-Cookie: no session is 401 signed_out as is, and one that ends past the lookup (a leaver, by
// authorise()) is rethrown without its clear (keepCookie()). A stale cookie left in place is
// harmless: the server refuses it. Clearing stays with sign-out and the sign-in steps; the older
// GETs (your devices, the admin device list) still clear, which C0.16 aligns.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Api } from '#src/api.ts'
import { ApiError } from '#src/auth/errors.ts'
import { authenticate, type SessionIds } from '#src/auth/sessions.ts'
import { type Answer, type ReqInfo, requestInfo, send } from '#src/http.ts'
import { readFlags } from '#src/web/flags.ts'
import { readSession } from '#src/web/session.ts'

// The request's live session, or 401 signed_out without clearing the cookie. A lookup that fails
// is 503 unavailable (authenticate()).
async function sessionOf(api: Api, request: FastifyRequest): Promise<SessionIds> {
  const session = await authenticate(api.db, request)
  if (session === undefined) throw new ApiError(401, 'signed_out')
  return session
}

// Runs the work, and rethrows any refusal it throws without the cookies it would have cleared.
export async function keepCookie<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof ApiError && error.clear.length > 0) {
      throw new ApiError(error.status, error.code, error.extra, [], error.person)
    }
    throw error
  }
}

export function webRoutes(api: Api) {
  const read =
    (service: (api: Api, session: SessionIds, info: ReqInfo) => Promise<Answer>) =>
    async (request: FastifyRequest): Promise<Answer> =>
      keepCookie(async () => service(api, await sessionOf(api, request), requestInfo(api, request)))
  const session = read(readSession)
  const flags = read(readFlags)
  return async (scope: FastifyInstance): Promise<void> => {
    scope.get('/session', async (request, reply) => send(reply, await session(request)))
    scope.get('/flags', async (request, reply) => send(reply, await flags(request)))
  }
}
