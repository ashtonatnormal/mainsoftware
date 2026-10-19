// The api's answers as Query options (T21; OD-22, R-50, R-53). Every screen reads server data
// through Query, under one QueryClient per signed-in document (session/query-client.ts), so the
// cache can't outlive the person (D-01).
import { type FlagKey, readFlagsAnswer, SessionResponseForClient } from '@hearth/shared'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { apiGet } from '@/api/http.ts'
import { useRuntime } from '@/app/runtime-context.ts'
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

// The signed-in person, as the session answer last said (the avatar menu's name). The runtime seeds
// the cache with the boot's answer, and the boot's answer stands in whenever the cache is empty
// (after end() clears it, while the document leaves), so a screen never renders without one.
export function useSession(): SessionInfo {
  const runtime = useRuntime()
  return useQuery(sessionQuery).data ?? runtime.info
}

// The person's client flags (T17 item 11, R-50, R-53): each flag the registry marks client: true,
// evaluated for them, as a plain boolean. Read leniently (readFlagsAnswer): only true reads on, a
// key that isn't a flag key is dropped, and an answer of the wrong shape reads as no flags.
export type ClientFlags = Readonly<Record<string, boolean>>

export const FLAGS_POLL_MS = 60_000

const FlagsAnswer = z.unknown().transform(readFlagsAnswer)

// Two answers that say the same, so a poll that changes nothing keeps the old object and renders
// nothing again.
function sameFlags(a: unknown, b: unknown): boolean {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every(
    key => Object.hasOwn(b, key) && (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key],
  )
}

// GET /api/flags while anything shows a FlagSlot: on mount, every 60 s while the page is visible
// (Query pauses the poll in a hidden tab, and refetches on focus when it returns), and when the
// gateway's nudge invalidates it (the session runtime, R-47). The poll doesn't renew the session
// (OD-14: the server reads it without the touch). A failure keeps the last answer, which Query
// holds through errors; with none yet, every flag reads off (R-53). A 401 ends the session like
// any other (session/query-client.ts).
export const flagsQuery = queryOptions({
  queryKey: ['flags'] as const,
  queryFn: ({ signal }): Promise<ClientFlags> => apiGet('/api/flags', FlagsAnswer, { signal }),
  staleTime: 0,
  refetchInterval: FLAGS_POLL_MS,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
  structuralSharing: (before, after) => (sameFlags(before, after) ? before : after),
})

// Whether a flag reads on: only a true the answer holds itself. Missing, unknown, false or not yet
// loaded reads off (R-53).
export function flagOn(flags: ClientFlags | undefined, key: FlagKey): boolean {
  return flags !== undefined && Object.hasOwn(flags, key) && flags[key] === true
}

// The person's client flags, or undefined until the first answer.
export function useFlags(): ClientFlags | undefined {
  return useQuery(flagsQuery).data
}

export function useFlag(key: FlagKey): boolean {
  return flagOn(useFlags(), key)
}
