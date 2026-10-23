import type { FlagKey } from '@hearth/shared'
import { environmentManager, focusManager, QueryObserver } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/session/query-client.ts'
import { flagOn, flagsQuery, noticeQuery, sessionQuery } from './queries.ts'

// Whether Query took this test run for a server (no window) before a case changed it.
const queryOnServer = environmentManager.isServer()

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  focusManager.setFocused(undefined)
  environmentManager.setIsServer(() => queryOnServer)
})

// Wei Ling, from the Tembusu seed (db/seed/tembusu.sql).
const WEI_LING = {
  personId: 'b0000000-0000-4000-8000-000000000005',
  name: 'Wei Ling',
  timeZone: '',
  capabilities: { registers: false },
  notice: 'acknowledged' as const,
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('T21: the api answers as Query options (api/queries.ts)', () => {
  it('T21 item 10 OD-14: sessionQuery reads GET /api/session leniently and is fresh for 60 s, so a focus refetch renews the session at most once a minute', async () => {
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

  it('QY-01 T21 item 3 T17 item 11: flags refetch every 60 s while visible, not while hidden, and at once on focus', async () => {
    expect(flagsQuery.queryKey).toEqual(['flags'])
    expect(flagsQuery).toMatchObject({
      staleTime: 0,
      refetchInterval: 60_000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    })

    // Query sets no poll timer where there is no window (it takes that for a server), so this case
    // tells it it's in a browser, and runs its timers on Vitest's clock.
    environmentManager.setIsServer(() => false)
    vi.useFakeTimers()
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: RequestInfo | URL) => {
      calls.push(String(url))
      return json(200, { flags: {} })
    })
    const client = createQueryClient(() => {})
    client.mount()
    const stop = new QueryObserver(client, flagsQuery).subscribe(() => {})
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toEqual(['/api/flags'])
      // Visible: asked again every 60 s.
      await vi.advanceTimersByTimeAsync(59_999)
      expect(calls).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls).toHaveLength(3)
      // Hidden: no poll, however long.
      focusManager.setFocused(false)
      await vi.advanceTimersByTimeAsync(600_000)
      expect(calls).toHaveLength(3)
      // Shown again: asked at once, since the answer is never fresh (staleTime 0), then every 60 s.
      focusManager.setFocused(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toHaveLength(4)
      await vi.advanceTimersByTimeAsync(59_999)
      expect(calls).toHaveLength(4)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toHaveLength(5)
      expect(new Set(calls)).toEqual(new Set(['/api/flags']))
    } finally {
      stop()
      client.unmount()
    }
  })

  it('QY-02 T17 item 11 P6: a missing key reads off; unknown keys are ignored; only true reads on', async () => {
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

  it('QY-03 T17 item 11 T21 item 10: a failed poll (503) keeps the last answer; with none yet, every flag reads off', async () => {
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

  it('NTW-03 C0.9 PD-46 T22 item 31: noticeQuery reads GET /api/notice leniently, is never fresh, and polls every 30 s while the page is visible and on focus', async () => {
    expect(noticeQuery.queryKey).toEqual(['notice'])
    expect(noticeQuery).toMatchObject({
      staleTime: 0,
      refetchInterval: 30_000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    })
    const answer = {
      person: WEI_LING.personId,
      standing: 'standing this build can’t read',
      current: { id: 'e1', version: 2, publishedAt: '2026-10-23T01:00:00.000Z', body: '## About this notice' },
      changes: { since: 'x' },
      mine: [{ version: 1, acknowledgedAt: '2026-10-01T01:00:00.000Z', method: 'in_app' }, { version: 'x' }],
      later: true,
    }
    const seen: string[] = []
    vi.stubGlobal('fetch', async (url: RequestInfo | URL) => {
      seen.push(String(url))
      return json(200, answer)
    })
    const client = createQueryClient(() => {})
    // An unreadable standing reads as required, and what else doesn't read is left out.
    expect(await client.fetchQuery(noticeQuery)).toEqual({
      person: WEI_LING.personId,
      standing: 'required',
      current: answer.current,
      changes: null,
      mine: [answer.mine[0]],
    })
    expect(seen).toEqual(['/api/notice'])
  })
})
