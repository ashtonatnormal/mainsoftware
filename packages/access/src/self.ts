import type { Id } from './model.ts'
import type { RequestContext, SelfRequest } from './requests.ts'
import type { World } from './world.ts'

// What anyone active may do about their own session, devices and passkeys (ACC-02, ACC-04, T14,
// T21), and the privacy notice (C0.9 PD-49). Reading your own session and client flags, signing
// out and listing devices, and reading and acknowledging the notice need no re-authentication, so
// a lost phone can always be signed out, the shell can always load, and the notice gate never
// stands between anyone and the notice it asks them to acknowledge.
// A device or passkey the request names must be the person's own and not already ended; one the
// snapshot doesn't hold is refused like someone else's, so the answer never shows what exists.
export function selfCan(world: World, me: Id, request: SelfRequest, context: RequestContext): boolean {
  if (!world.isActivePerson(me)) return false
  switch (request.action) {
    case 'session.read_own':
    case 'notice.read_own':
    case 'notice.acknowledge_own':
      return true
    case 'devices.list_own':
      return true
    case 'devices.sign_out_own': {
      if (request.device === undefined) return true
      const device = world.device(request.device)
      return device !== undefined && device.userId === me && device.signedOutAt === null
    }
    case 'passkeys.add_own':
      return context.reauthenticated === true
    case 'passkeys.remove_own': {
      const passkey = world.passkey(request.passkey)
      return (
        context.reauthenticated === true && passkey !== undefined && passkey.userId === me && passkey.removedAt === null
      )
    }
    default:
      return false
  }
}
