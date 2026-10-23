// Who may use Hearth before acknowledging the current privacy notice (PDPA-03: "nobody can use
// Hearth until they acknowledge the current notice"; ACC-12; C0.9 PD-43 to PD-45, TECH-SPEC T22
// items 28 to 30). The server reads the person's standing (packages/shared NOTICE_STANDINGS) in
// the request's own transaction and asks noticeAdmits() before can(): in consider() for a
// request's action, in actingBy() for re-authentication, and in the realtime gateway's admission
// for a socket. A refusal is 403 notice_required, or 4403 on a socket. It is a rule, never a flag,
// and no flag reads it (T17 item 10). can() still decides every request it lets through.
import type { NoticeStanding } from '@hearth/shared'
import type { Id } from './model.ts'
import type { Request } from './requests.ts'
import type { World } from './world.ts'

export type { NoticeStanding }

// What the gate is asked about: a request's action, re-authenticating by PIN or code ('reauth',
// which isn't a request can() decides), or a socket on the realtime gateway ('gateway').
export type NoticeUse = Request['action'] | 'reauth' | 'gateway'

// Open in every standing (C0.9 PD-43, PD-44): the shell's two GETs (who you are, and your client
// flags), your devices and signing them out, so a lost phone can always be signed out, and the
// notice's own routes, so it can always be read and acknowledged. None of them reaches anyone
// else's data. Each is a request about your own account that needs no re-authentication (self.ts).
export const NOTICE_FREE: ReadonlySet<NoticeUse> = new Set<NoticeUse>([
  'session.read_own',
  'devices.list_own',
  'devices.sign_out_own',
  'notice.read_own',
  'notice.acknowledge_own',
])

// What the DPO alone may do before any version is published (C0.9 OD-01, PD-44): read and change
// the registers, read the draft and publish the first version, and re-authenticate with the PIN
// that each of those needs. Each is an admin action can() allows only to a holder of dpo.
export const NOTICE_SETUP: ReadonlySet<NoticeUse> = new Set<NoticeUse>([
  'register.read',
  'register.purpose.set',
  'register.transfer.set',
  'notice.read',
  'notice.publish',
  'reauth',
])

// Whether a socket is admitted to the realtime gateway (C0.9 PD-45; T19 item 10): only once the
// person has acknowledged the latest version, so before any version is published the gateway
// admits nobody, the DPO included.
export function admitsSocket(standing: NoticeStanding): boolean {
  return standing === 'acknowledged'
}

// Whether the notice lets a use through for the person, in their standing:
//   'gateway'      as admitsSocket()
//   NOTICE_FREE    always
//   acknowledged   everything else too
//   unpublished    NOTICE_SETUP, for a holder of dpo who is still at the organisation
//   required       nothing else, the DPO included: they acknowledge the version they published
export function noticeAdmits(world: World, me: Id, use: NoticeUse, standing: NoticeStanding): boolean {
  if (use === 'gateway') return admitsSocket(standing)
  if (NOTICE_FREE.has(use) || standing === 'acknowledged') return true
  return standing === 'unpublished' && NOTICE_SETUP.has(use) && world.holds(me, 'dpo')
}
