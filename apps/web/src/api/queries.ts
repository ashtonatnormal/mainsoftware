// The api's answers as Query options (T21; OD-22, R-50). Every screen reads server data through
// Query, under one QueryClient per signed-in document (session/query-client.ts), so the cache can't
// outlive the person (D-01). The flags query joins this file with the gateway client (C0.8 S9).
import { SessionResponseForClient } from '@hearth/shared'
import { queryOptions } from '@tanstack/react-query'
import { apiGet } from '@/api/http.ts'
import type { SessionInfo } from '@/boot/load-session.ts'

// GET /api/session, refetched at most once a minute (on focus or reconnect while something
// observes it): it renews the session's last use, so it shouldn't run on every return to the tab.
// The session runtime observes it and ends the document if it ever names someone else (CHT-60).
export const SESSION_STALE_MS = 60_000

export const sessionQuery = queryOptions({
  queryKey: ['session'] as const,
  queryFn: ({ signal }): Promise<SessionInfo> => apiGet('/api/session', SessionResponseForClient, { signal }),
  staleTime: SESSION_STALE_MS,
})
