// Who this document belongs to (D-01; T21 item 10): the boot's first request, GET /api/session. Its
// answer decides everything after it. Signed in, the session runtime starts for that person; signed
// out, the sign-in screen shows; and when the api can't answer, a boot error with a reload, never a
// guess. A 401 here clears no cookie (the server's GETs never do, T21 item 10), so a boot can't
// delete a session another tab has just made.
import { type SessionForClient, SessionResponseForClient } from '@hearth/shared'
import { ApiFailure, apiGet } from '@/api/http.ts'

// The person a signed-in document belongs to: their id, the name to show, and the zone their
// times are shown in (the profile's, else the org's; OD-10).
export type SessionInfo = SessionForClient

export type BootState =
  | { readonly kind: 'signed_in'; readonly session: SessionInfo }
  | { readonly kind: 'signed_out' }
  | { readonly kind: 'unavailable' }

// How long the boot waits for the answer, its body included. A connection that hangs would
// otherwise leave "Loading Hearth…" up for good; past this the boot shows its error screen, with
// Try again.
export const SESSION_TIMEOUT_MS = 15_000

// 200 → signed_in; 401 → signed_out; anything else (offline, no answer within timeoutMs, a 5xx, an
// answer that doesn't read) → unavailable.
export async function loadSession(fetchImpl?: typeof fetch, timeoutMs = SESSION_TIMEOUT_MS): Promise<BootState> {
  try {
    const session = await apiGet('/api/session', SessionResponseForClient, {
      fetch: fetchImpl,
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { kind: 'signed_in', session }
  } catch (error) {
    if (error instanceof ApiFailure && error.status === 401) return { kind: 'signed_out' }
    return { kind: 'unavailable' }
  }
}
