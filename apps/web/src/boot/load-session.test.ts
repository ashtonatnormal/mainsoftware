import { describe, expect, it } from 'vitest'
import { loadSession, SESSION_TIMEOUT_MS } from './load-session.ts'

const answer = (response: Response | Error) =>
  (async () => {
    if (response instanceof Error) throw response
    return response
  }) as typeof fetch

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// Ahmad, from the Tembusu seed (db/seed/tembusu.sql), with his profile's zone.
const AHMAD = {
  personId: 'b0000000-0000-4000-8000-000000000006',
  name: 'Ahmad',
  timeZone: 'Asia/Kuala_Lumpur',
  capabilities: { registers: false },
}

describe('T21 D-01: who the document belongs to (boot/load-session.ts)', () => {
  it('BT-01 T21 item 10: 200 → signed_in; 401 → signed_out; network or 5xx → unavailable', async () => {
    expect(await loadSession(answer(json(200, AHMAD)))).toEqual({ kind: 'signed_in', session: AHMAD })
    expect(await loadSession(answer(json(401, { error: 'signed_out', message: 'Signed out.' })))).toEqual({
      kind: 'signed_out',
    })
    for (const failed of [
      new TypeError('Failed to fetch'),
      json(503, { error: 'unavailable', message: 'Later.' }),
      new Response('<html>Bad gateway</html>', { status: 502 }),
      // An answer that doesn't read is no basis for signing anyone in.
      json(200, { personId: '' }),
      json(403, { error: 'Forbidden' }),
    ])
      expect(await loadSession(answer(failed))).toEqual({ kind: 'unavailable' })
  })

  it('BT-01 T21 items 5 and 10: an answer that never comes reads as unavailable once the time limit passes', async () => {
    expect(SESSION_TIMEOUT_MS).toBe(15_000)
    let signal: AbortSignal | undefined
    // A connection that hangs: nothing settles until the request is aborted.
    const hangs = (async (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        signal = init?.signal ?? undefined
        signal?.addEventListener('abort', () => reject(signal?.reason))
      })) as typeof fetch
    expect(await loadSession(hangs, 20)).toEqual({ kind: 'unavailable' })
    expect(signal?.aborted).toBe(true)
  })

  it('BT-01 SW-03: an answer with an empty zone signs in with the pilot zone', async () => {
    expect(await loadSession(answer(json(200, { ...AHMAD, timeZone: '' })))).toEqual({
      kind: 'signed_in',
      session: { ...AHMAD, timeZone: 'Asia/Singapore' },
    })
  })
})
