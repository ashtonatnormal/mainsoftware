// Sign-in, device and admin events in the audit log (ADM-06, T14). One row per event, with the
// device, the client's IP (request.ip, which trusts X-Forwarded-For only from the TRUST_PROXY
// list) and the request id, so a row can be tied to the server's logs. hearth_app may only insert
// into audit_events, so this is a plain INSERT, never INSERT … RETURNING (CLAUDE.md, Database).
//
// Who is recorded:
// - actor_id: the person, or the admin acting on them; null when whoever holds the phone isn't
//   known to be the person yet (a code request or check, a failed PIN or passkey at sign-in).
//   Rows written before a session exists are written acting as the org's system principal.
// - target: always the person whose account it is, so a PDPA-05 access request finds them.
// - details: never a phone number, code, PIN, token or credential id. auth.code_requested's send
//   says what became of the code: attempted, or skipped_left, skipped_number_removed,
//   skipped_not_cleared (the provider isn't yet cleared in PDPA-10's transfer register, C0.9) or
//   skipped_cap (the global SMS cap). auth.sign_in's method is sms (the code alone), sms_new_pin or
//   sms_pin (a PIN-role holder's code, then the PIN), and pinRule says whether the session was
//   issued under the PIN rule: the person held a PIN role when it was issued (D46). A
//   re-authentication's code request and failed check carry during: 'reauth' (D46, AQ-01), and
//   auth.reauth's method is pin, sms or passkey.
import type { InOrg } from '#src/db/database.ts'

export type AuditAction =
  | 'auth.code_requested'
  | 'auth.code_failed'
  | 'auth.sign_in'
  | 'auth.pin_set'
  | 'auth.pin_failed'
  | 'auth.pin_locked'
  | 'auth.passkey_added'
  | 'auth.passkey_removed'
  | 'auth.passkey_failed'
  | 'auth.reauth'
  | 'auth.sign_out'
  | 'auth.device_sign_out'
  | 'person.deactivate'
  | 'person.reset_pin'
  | 'person.sign_out_devices'

export interface AuditEntry {
  orgId: string
  // Null when whoever holds the phone isn't known to be the person.
  actorId: string | null
  action: AuditAction
  targetType: 'person'
  // Always the person whose account it is (PDPA-05 finds them).
  targetId: string
  // An admin's note (person.reset_pin).
  reason?: string
  deviceId: string | null
  ip: string | null
  requestId: string
  // Never a number, code, PIN, token or credential id.
  details?: Record<string, string | number | boolean | string[]>
}

export async function writeAudit(trx: InOrg, entry: AuditEntry): Promise<void> {
  await trx
    .insertInto('audit_events')
    .values({
      org_id: entry.orgId,
      actor_id: entry.actorId,
      action: entry.action,
      target_type: entry.targetType,
      target_id: entry.targetId,
      reason: entry.reason ?? null,
      device_id: entry.deviceId,
      ip: entry.ip,
      request_id: entry.requestId,
      details: entry.details ?? {},
    })
    .execute()
}
