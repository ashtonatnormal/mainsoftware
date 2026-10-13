// /api/admin (T14 item 16): actions on a person, each needing a session, a re-authentication from the
// last 5 minutes and can()'s yes (admin/people.ts). A person id in a path is fine: it isn't
// personal data, and the path is what gets logged.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { deactivate, listDevices, resetPin, signOutDevices } from '#src/admin/people.ts'
import type { Api } from '#src/api.ts'
import { requireSession } from '#src/auth/sessions.ts'
import { parse, requestInfo, send, Uuid } from '#src/http.ts'

const PersonBody = z.strictObject({ person: Uuid })
const ResetPinBody = z.strictObject({
  person: Uuid,
  // How the admin checked it was them (ACC-06).
  identityCheck: z.enum(['in_person', 'video_call']),
  // Kept as the audit row's reason.
  note: z.string().trim().min(1).max(500).optional(),
})
const PersonParams = z.strictObject({ person: Uuid })

export function adminRoutes(api: Api) {
  return async (scope: FastifyInstance): Promise<void> => {
    scope.post('/people/deactivate', async (request, reply) => {
      const body = parse(PersonBody, request.body)
      const session = await requireSession(api.db, request)
      return send(reply, await deactivate(api, body, session, requestInfo(api, request)))
    })
    scope.post('/people/reset-pin', async (request, reply) => {
      const body = parse(ResetPinBody, request.body)
      const session = await requireSession(api.db, request)
      return send(reply, await resetPin(api, body, session, requestInfo(api, request)))
    })
    scope.post('/people/sign-out-devices', async (request, reply) => {
      const body = parse(PersonBody, request.body)
      const session = await requireSession(api.db, request)
      return send(reply, await signOutDevices(api, body, session, requestInfo(api, request)))
    })
    scope.get('/people/:person/devices', async (request, reply) => {
      const { person } = parse(PersonParams, request.params)
      const session = await requireSession(api.db, request)
      return send(reply, await listDevices(api, person, session, requestInfo(api, request)))
    })
  }
}
