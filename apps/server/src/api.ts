// The api role's routes under /api (C0.5): sign-in, your own devices (and passkeys, dormant: D46,
// PASSKEYS_ON), the admin actions on a person, and from C0.6 changing a feature flag. Every
// response in the scope carries Cache-Control: no-store, errors and the scope's own 404 included.
// Every body is JSON of at most 16 KiB, parsed by a strict zod object (http.ts). Errors become
// `{ error, message, ...extra }` (auth/errors.ts); anything unexpected is a 500 whose detail goes
// only to the (redacted) log. Work a handler queues for after its response runs once that
// response has ended, sent or abandoned (http.ts AfterResponse).
import { setTimeout as delay } from 'node:timers/promises'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Redis } from 'ioredis'
import { adminRoutes } from '#src/admin/routes.ts'
import { Breaker, type BreakerPolicy } from '#src/auth/breaker.ts'
import { addCookie, clearedCookie } from '#src/auth/cookies.ts'
import { type AuthKeys, PinSlotsFull } from '#src/auth/crypto.ts'
import { ApiError, fromDatabase, messageFor } from '#src/auth/errors.ts'
import { loadWebAuthn, type RelyingParty, relyingParty } from '#src/auth/passkeys.ts'
import { OTP, PASSKEYS_ON } from '#src/auth/policy.ts'
import { authRoutes } from '#src/auth/routes.ts'
import type { SmsProvider } from '#src/auth/sms/provider.ts'
import { type ValkeyKeys, valkeyKeys } from '#src/auth/valkey-keys.ts'
import type { Database } from '#src/db/database.ts'
import { deviceRoutes } from '#src/devices/routes.ts'
import type { FlagCache } from '#src/flags/cache.ts'
import { AfterResponse, BODY_LIMIT } from '#src/http.ts'
import type { Gate } from '#src/jobs/gate.ts'

export interface ApiDeps {
  db: Database
  valkey: Redis
  keys: AuthKeys
  // undefined: no code can be sent, so code requests answer 503 unavailable.
  sms: SmsProvider | undefined
  // Whether the provider may receive a number at all (PDPA-10's transfer register). C06_GATE when
  // unset, which clears no provider, so nothing reaches one until C0.9 passes the real gate.
  gate?: Pick<Gate, 'providerCleared'>
  keyPrefix: string
  // The flags this process keeps (flags/cache.ts; T17): every signed-in request keeps its org's,
  // and the flags route takes the keys it accepts and their purposes from the cache's registry,
  // FLAGS in production (a test adds its own it.* flags, A5).
  flags: Pick<FlagCache, 'registry' | 'track' | 'reload'>
  // Whether the api publishes the sessions a commit ended on Valkey's revoked channel as soon as it
  // commits (a deactivation, a PIN reset, an admin's or your own device sign-out, a sign-out), so
  // their sockets close at once: the push path (true unless set false). The outbox carries the
  // same news to the worker's revocation consumer regardless (T16, T19 item 4); a test turns this
  // off to see the durable path alone (A6).
  publishRevoked?: boolean
  // The after-response queue. registerApi makes one if none is given; the integration harness
  // passes its own, to await its idle() after each request.
  afterResponse?: AfterResponse
  // The integration harness and unit tests only (scripts/guards/api-test-overrides.test.ts): a
  // shorter floor on refused code checks, so a suite making dozens of them doesn't wait 2 s each,
  // and a breaker policy of its own. Production takes OTP's.
  otpForTests?: { verifyFloorMs?: number; breaker?: Partial<BreakerPolicy> }
  // The integration harness and unit tests only (the same guard): turns the dormant passkey routes
  // and fields on (D46). Production takes PASSKEYS_ON, which is false.
  passkeysForTests?: boolean
}

// What every service gets: the deps, and what registerApi derives from them.
export interface Api extends ApiDeps {
  appOrigin: string
  afterResponse: AfterResponse
  // Every Valkey key and channel name (auth/valkey-keys.ts).
  names: ValkeyKeys
  rp: RelyingParty
  // The code checks' floor and circuit breaker (T20), built per registerApi from OTP.
  otp: { verifyFloorMs: number; breaker: Breaker }
  // Whether passkeys are switched on (D46): PASSKEYS_ON unless a test overrides it.
  passkeys: boolean
}

// A pending text or audit row gets this long to finish when the server stops.
const DRAIN_MS = 5000

export function registerApi(app: FastifyInstance, deps: ApiDeps & { appOrigin: string }): void {
  const api: Api = {
    ...deps,
    afterResponse: deps.afterResponse ?? new AfterResponse(),
    names: valkeyKeys(deps.keyPrefix),
    rp: relyingParty(deps.appOrigin),
    otp: otpChecks(deps),
    passkeys: deps.passkeysForTests ?? PASSKEYS_ON,
  }
  app.register(
    async scope => {
      // At start, so a package the image left out fails the api role's start (check-server.sh
      // sees it), not the first passkey request.
      await loadWebAuthn()
      scope.addHook('onRoute', route => {
        route.bodyLimit ??= BODY_LIMIT
      })
      scope.addHook('onSend', async (_request, reply, payload) => {
        reply.header('cache-control', 'no-store')
        return payload
      })
      // The raw response's 'close' comes after it has been sent, and also when the client goes away
      // first, which never reaches onResponse. onResponse starts the tasks too, for inject().
      scope.addHook('onRequest', async (request, reply) => {
        reply.raw.once('close', () => api.afterResponse.start(request))
      })
      scope.addHook('onResponse', async request => {
        api.afterResponse.start(request)
      })
      scope.addHook('onClose', async () => {
        await Promise.race([api.afterResponse.idle(), delay(DRAIN_MS, undefined, { ref: false })])
      })
      scope.setErrorHandler((error, request, reply) => answerError(error, request, reply))
      // An /api path with no route (the dormant passkey routes among them, D46) answers here, inside
      // the scope, so its 404 carries no-store like every other reply in it. The root handler
      // (app.ts) answers the same body for paths outside /api.
      scope.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: 'Not Found' }))
      await scope.register(authRoutes(api), { prefix: '/auth' })
      await scope.register(deviceRoutes(api), { prefix: '/devices' })
      await scope.register(adminRoutes(api), { prefix: '/admin' })
    },
    { prefix: '/api' },
  )
}

// The code checks' floor and breaker: OTP's, unless a test overrides them.
export function otpChecks(deps: Pick<ApiDeps, 'otpForTests'>): Api['otp'] {
  return {
    verifyFloorMs: deps.otpForTests?.verifyFloorMs ?? OTP.verifyFloorMs,
    breaker: new Breaker({ ...OTP.breaker, ...deps.otpForTests?.breaker }),
  }
}

// What a thrown error answers, or undefined for one the client shouldn't learn about (a 500).
export function apiErrorOf(error: unknown): ApiError | undefined {
  if (error instanceof ApiError) return error
  // A body Fastify couldn't parse: not JSON, the wrong content type, empty JSON, or too large.
  if (isBodyError(error)) return new ApiError(400, 'invalid_request')
  const conflict = fromDatabase(error)
  if (conflict) return conflict
  if (error instanceof PinSlotsFull) return new ApiError(503, 'unavailable')
  return undefined
}

function isBodyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || error instanceof ApiError) return false
  const { code, statusCode } = error as { code?: unknown; statusCode?: unknown }
  return (
    (typeof code === 'string' && code.startsWith('FST_ERR_CTP_')) ||
    statusCode === 400 ||
    statusCode === 413 ||
    statusCode === 415
  )
}

function answerError(error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  let known = apiErrorOf(error)
  if (known === undefined) {
    request.log.error({ err: error }, 'request failed')
    known = new ApiError(500, 'internal')
  } else if (known.code === 'try_again') {
    // Another transaction got there first; the client tries again.
    const code = (error as { code?: unknown }).code
    request.log.info({ event: 'db_conflict', code: typeof code === 'string' ? code : undefined }, 'database conflict')
  } else if (error instanceof PinSlotsFull) {
    request.log.warn({ event: 'pin_slots_full' }, 'too many PIN checks are waiting')
  } else if (known.person !== undefined) {
    // The re-authentication refusals carry the acting person for these lines only (D46). Each holds
    // the person's id and, for the wrong method, the route: never the method, a number or a code.
    if (known.code === 'reauth_method') {
      // A re-authentication route this session's method isn't (I2, AUTH-DESIGN §8.2). The web app
      // only calls the route the method names, so this is warn: it points to a non-app client. A
      // log line only, no audit row.
      request.log.warn(
        { event: 'reauth_wrong_method', personId: known.person, route: request.routeOptions.url },
        'this session re-authenticates another way',
      )
    }
    if (known.extra.method === 'sign_in') {
      // A session that only a new sign-in mends (D46): a privileged role reached a code-only
      // session, or a PIN-rule session lost its PIN. The person's id only.
      request.log.warn(
        { event: 'privileged_session_mismatch', personId: known.person },
        'this session must sign in again to re-authenticate',
      )
    }
  }
  for (const which of known.clear) addCookie(reply, clearedCookie(which))
  if (known.code === 'too_many_requests' && typeof known.extra.retryAfterSeconds === 'number') {
    reply.header('retry-after', String(known.extra.retryAfterSeconds))
  }
  return reply.code(known.status).send({ error: known.code, message: messageFor(known), ...known.extra })
}
