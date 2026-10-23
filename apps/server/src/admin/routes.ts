// /api/admin (T14 item 16): actions on a person, each needing a session, a re-authentication from the
// last 5 minutes and can()'s yes (admin/people.ts), from C0.6 changing a feature flag
// (flags/set.ts, T17 item 9), and from C0.9 the DPO's registers (compliance/routes.ts, TECH-SPEC
// T22 items 13 and 14) and, from C0.9 PR 2, the DPO's notice: its draft and publishing
// (compliance/notice.ts, T22 item 25). A person id in a path is fine: it isn't personal data, and
// the path is what gets logged.
import {
  ClearTransferBody,
  PublishBody,
  RecordTransferBody,
  SetPurposeBody,
  WithdrawTransferBody,
} from '@hearth/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { deactivate, listDevices, resetPin, signOutDevices } from '#src/admin/people.ts'
import type { Api } from '#src/api.ts'
import { requireSession } from '#src/auth/sessions.ts'
import { publishNotice, readNoticeAdmin } from '#src/compliance/notice.ts'
import { clearTransfer, readRegisters, recordTransfer, setPurpose, withdrawTransfer } from '#src/compliance/routes.ts'
import { SetFlagBody, setFlag } from '#src/flags/set.ts'
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
    scope.post('/flags/set', async (request, reply) => {
      const body = parse(SetFlagBody, request.body)
      const session = await requireSession(api.db, request)
      return send(reply, await setFlag(api, body, session, requestInfo(api, request)))
    })
    scope.get('/registers', async (request, reply) => {
      const session = await requireSession(api.db, request)
      return send(reply, await readRegisters(api, session, requestInfo(api, request)))
    })
    scope.post('/registers/purposes/set', async (request, reply) => {
      const body = parse(SetPurposeBody, request.body)
      const session = await requireSession(api.db, request)
      return send(reply, await setPurpose(api, body, session, requestInfo(api, request)))
    })
    scope.post('/registers/transfers/record', async (request, reply) => {
      const body = parse(RecordTransferBody, request.body)
      const session = await requireSession(api.db, request)
      return send(reply, await recordTransfer(api, body, session, requestInfo(api, request)))
    })
    scope.post('/registers/transfers/clear', async (request, reply) => {
      const body = parse(ClearTransferBody, request.body)
      const session = await requireSession(api.db, request)
      return send(reply, await clearTransfer(api, body, session, requestInfo(api, request)))
    })
    scope.post('/registers/transfers/withdraw', async (request, reply) => {
      const body = parse(WithdrawTransferBody, request.body)
      const session = await requireSession(api.db, request)
      return send(reply, await withdrawTransfer(api, body, session, requestInfo(api, request)))
    })
    scope.get('/notice', async (request, reply) => {
      const session = await requireSession(api.db, request)
      return send(reply, await readNoticeAdmin(api, session, requestInfo(api, request)))
    })
    scope.post('/notice/publish', async (request, reply) => {
      const body = parse(PublishBody, request.body)
      const session = await requireSession(api.db, request)
      return send(reply, await publishNotice(api, body, session, requestInfo(api, request)))
    })
  }
}
