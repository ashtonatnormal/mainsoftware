import type { FlagKey } from '@hearth/shared'
import { focusManager, QueryObserver } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/session/query-client.ts'
import { flagOn, flagsQuery, sessionQuery } from './queries.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  focusManager.setFocused(undefined)
})

// Wei Ling, from the Tembusu seed (db/seed/tembusu.sql).
const WEI_LING = { personId: 'b0000000-0000-4000-8000-000000000005', name: 'Wei Ling', timeZone: '' }

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

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

  it('QY-01 R-50 T17 item 11: flags refetch every 60 s while visible and on focus (options)', async () => {
    // Query runs the 60 s poll only in a browser (it skips intervals where there is no window), so
    // the poll itself is the e2e suite's (LV-01); here, its options and the refetch on focus.
    expect(flagsQuery.queryKey).toEqual(['flags'])
    expect(flagsQuery).toMatchObject({
      staleTime: 0,
      refetchInterval: 60_000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    })

    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: RequestInfo | URL) => {
      calls.push(String(url))
      return json(200, { flags: {} })
    })
    const client = createQueryClient(() => {})
    client.mount()
    const stop = new QueryObserver(client, flagsQuery).subscribe(() => {})
    try {
      await vi.waitFor(() => expect(client.getQueryState(['flags'])?.fetchStatus).toBe('idle'))
      expect(calls).toEqual(['/api/flags'])
      // Hidden and shown again: asked at once, since the answer is never fresh (staleTime 0).
      focusManager.setFocused(false)
      focusManager.setFocused(true)
      await vi.waitFor(() => expect(calls).toHaveLength(2))
    } finally {
      stop()
      client.unmount()
    }
  })

  it('QY-02 R-53 P6: a missing key reads off; unknown keys are ignored; only true reads on', async () => {
    vi.stubGlobal('fetch', async () =>
      json(200, {
        flags: { 'ai.ask': true, 'Not A Key': true, 'core.system': 'yes', 'later.flag': true },
        revision: 7,
      }),
    )
    const client = createQueryClient(() => {})
    const flags = await client.fetchQuery(flagsQuery)
    expect({ ...flags }).toEqual({ 'ai.ask': true, 'core.system': false, 'later.flag': true })
    expect(flagOn(flags, 'ai.ask')).toBe(true)
    expect(flagOn(flags, 'core.system')).toBe(false)
    expect(flagOn(flags, 'ai.notes')).toBe(false)
    expect(flagOn(undefined, 'ai.ask')).toBe(false)
    // Nothing inherited reads on.
    expect(flagOn(flags, 'constructor' as FlagKey)).toBe(false)

    // A poll that says the same keeps the cached object, so nothing renders again.
    const cached = client.getQueryData(flagsQuery.queryKey)
    await client.fetchQuery({ ...flagsQuery, staleTime: 0 })
    expect(client.getQueryData(flagsQuery.queryKey)).toBe(cached)

    // An answer of the wrong shape reads as no flags at all.
    vi.stubGlobal('fetch', async () => json(200, ['ai.ask']))
    expect({ ...(await client.fetchQuery({ ...flagsQuery, staleTime: 0 })) }).toEqual({})
  })

  it('QY-03 R-53 OD-21: a failed poll (503) keeps the last answer; with none yet, every flag reads off', async () => {
    let answer = () => json(200, { flags: { 'ai.ask': true } })
    vi.stubGlobal('fetch', async () => answer())
    const client = createQueryClient(() => {}, { random: () => 0 })
    await client.fetchQuery(flagsQuery)
    answer = () => json(503, { error: 'unavailable', message: 'Hearth is busy. Try again in a moment.' })
    await client.refetchQueries({ queryKey: ['flags'] })
    expect(client.getQueryState(['flags'])?.status).toBe('error')
    expect(flagOn(client.getQueryData(flagsQuery.queryKey), 'ai.ask')).toBe(true)

    const fresh = createQueryClient(() => {}, { random: () => 0 })
    await fresh.fetchQuery(flagsQuery).catch(() => {})
    expect(fresh.getQueryData(flagsQuery.queryKey)).toBeUndefined()
    expect(flagOn(fresh.getQueryData(flagsQuery.queryKey), 'ai.ask')).toBe(false)
  })
})
