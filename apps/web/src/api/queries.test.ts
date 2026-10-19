import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/session/query-client.ts'
import { sessionQuery } from './queries.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

// Wei Ling, from the Tembusu seed (db/seed/tembusu.sql).
const WEI_LING = { personId: 'b0000000-0000-4000-8000-000000000005', name: 'Wei Ling', timeZone: '' }

describe('T21: the api answers as Query options (api/queries.ts)', () => {
  it('OD-22 OD-14 T21: sessionQuery reads GET /api/session leniently and is fresh for 60 s, so a focus refetch renews the session at most once a minute', async () => {
    expect(sessionQuery.queryKey).toEqual(['session'])
    expect(sessionQuery.staleTime).toBe(60_000)

    const seen: { url: string; signal: AbortSignal | null | undefined }[] = []
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(url), signal: init?.signal })
      return new Response(JSON.stringify(WEI_LING), { status: 200 })
    })
    const client = createQueryClient(() => {})
    expect(await client.fetchQuery(sessionQuery)).toEqual({ ...WEI_LING, timeZone: 'Asia/Singapore' })
    // Query's own signal reaches the request, so a cancelled query stops it.
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('/api/session')
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal)
  })
})
