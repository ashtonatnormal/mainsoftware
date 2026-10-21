// /api/auth (T14 item 16): signing in, which needs no session, and the signed-in self-service
// (re-authentication by PIN or SMS code, sign-out, and the dormant passkey routes, D46). Every
// route is a POST, so the root Origin check refuses any request that isn't from the app's own
// origin (origin.ts). Bodies are strict zod objects: an unknown key is 400 invalid_request, and
// nothing a client sends is echoed back.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Api } from '#src/api.ts'
import {
  reauthCodeRequest,
  reauthCodeVerify,
  reauthPasskeyOptions,
  reauthPasskeyVerify,
  reauthPin,
  registerOptions,
  registerVerify,
  removePasskey,
  signOut,
} from '#src/auth/account.ts'
import { ATTEMPT_COOKIE, readCookie } from '#src/auth/cookies.ts'
import { ApiError } from '#src/auth/errors.ts'
import { AuthenticationResponse, RegistrationResponse } from '#src/auth/passkeys.ts'
import { authenticate, requireSession } from '#src/auth/sessions.ts'
import { passkeyOptions, passkeyVerify, requestCode, setPin, verifyCode, verifyPinStep } from '#src/auth/sign-in.ts'
import { Empty, parse, requestInfo, send, Uuid } from '#src/http.ts'

const PhoneBody = z.strictObject({ phone: z.string().min(1).max(32) })
const CodeBody = z.strictObject({ code: z.string().max(16) })
const PinBody = z.strictObject({ pin: z.string().max(16) })
const AuthenticationBody = z.strictObject({ response: AuthenticationResponse })
const RegistrationBody = z.strictObject({ response: RegistrationResponse })
const RemovePasskeyBody = z.strictObject({ passkey: Uuid })

const attemptOf = (request: FastifyRequest) => readCookie(request.headers.cookie, ATTEMPT_COOKIE)

export function authRoutes(api: Api) {
  return async (scope: FastifyInstance): Promise<void> => {
    // Signing in: the attempt cookie carries the steps.
    scope.post('/otp/request', async (request, reply) => {
      const body = parse(PhoneBody, request.body)
      return send(reply, await requestCode(api, body, attemptOf(request), requestInfo(api, request)))
    })
    scope.post('/otp/verify', async (request, reply) => {
      const body = parse(CodeBody, request.body)
      // A code that isn't 6 digits gets its own error, so the web app can say what's wrong.
      if (!/^[0-9]{6}$/.test(body.code)) throw new ApiError(400, 'invalid_code')
      return send(reply, await verifyCode(api, body, attemptOf(request), requestInfo(api, request)))
    })
    scope.post('/pin/set', async (request, reply) => {
      const body = parse(PinBody, request.body)
      return send(reply, await setPin(api, body, attemptOf(request), requestInfo(api, request)))
    })
    scope.post('/pin/verify', async (request, reply) => {
      const body = parse(PinBody, request.body)
      return send(reply, await verifyPinStep(api, body, attemptOf(request), requestInfo(api, request)))
    })
    // Signing out works with or without a live session.
    scope.post('/sign-out', async (request, reply) => {
      parse(Empty, request.body)
      const session = await authenticate(api.db, request)
      return send(reply, await signOut(api, session, requestInfo(api, request)))
    })

    // Signed in: re-authentication.
    scope.post('/reauth/pin', async (request, reply) => {
      const body = parse(PinBody, request.body)
      const session = await requireSession(api.db, request)
      return send(reply, await reauthPin(api, body, session, requestInfo(api, request)))
    })
    scope.post('/reauth/code/request', async (request, reply) => {
      parse(Empty, request.body)
      const session = await requireSession(api.db, request)
      return send(reply, await reauthCodeRequest(api, session, requestInfo(api, request)))
    })
    scope.post('/reauth/code/verify', async (request, reply) => {
      const body = parse(CodeBody, request.body)
      if (!/^[0-9]{6}$/.test(body.code)) throw new ApiError(400, 'invalid_code')
      const session = await requireSession(api.db, request)
      return send(reply, await reauthCodeVerify(api, body, session, requestInfo(api, request)))
    })

    // Passkeys (D46): kept, switched off. While api.passkeys is false none of these is registered,
    // so each answers the /api scope's 404, after the Origin check and before any body is read
    // (api.ts).
    if (!api.passkeys) return
    scope.post('/passkey/options', async (request, reply) => {
      parse(Empty, request.body)
      return send(reply, await passkeyOptions(api, attemptOf(request), requestInfo(api, request)))
    })
    scope.post('/passkey/verify', async (request, reply) => {
      const body = parse(AuthenticationBody, request.body)
      return send(reply, await passkeyVerify(api, body, attemptOf(request), requestInfo(api, request)))
    })

    scope.post('/reauth/passkey/options', async (request, reply) => {
      parse(Empty, request.body)
      const session = await requireSession(api.db, request)
      return send(reply, await reauthPasskeyOptions(api, session, requestInfo(api, request)))
    })
    scope.post('/reauth/passkey/verify', async (request, reply) => {
      const body = parse(AuthenticationBody, request.body)
      const session = await requireSession(api.db, request)
      return send(reply, await reauthPasskeyVerify(api, body, session, requestInfo(api, request)))
    })
    scope.post('/passkeys/register/options', async (request, reply) => {
      parse(Empty, request.body)
      const session = await requireSession(api.db, request)
      return send(reply, await registerOptions(api, session, requestInfo(api, request)))
    })
    scope.post('/passkeys/register/verify', async (request, reply) => {
      const body = parse(RegistrationBody, request.body)
      const session = await requireSession(api.db, request)
      return send(reply, await registerVerify(api, body, session, requestInfo(api, request)))
    })
    scope.post('/passkeys/remove', async (request, reply) => {
      const body = parse(RemovePasskeyBody, request.body)
      const session = await requireSession(api.db, request)
      return send(reply, await removePasskey(api, body, session, requestInfo(api, request)))
    })
  }
}
