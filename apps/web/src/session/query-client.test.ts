import { describe, expect, it, vi } from 'vitest'
import { ApiFailure } from '@/api/http.ts'
import { createQueryClient, RETRY_CAP_MS, retryDelay, shouldRetry } from './query-client.ts'

const failure = (status: number, code: string) => new ApiFailure(status, code, 'copy')

describe('T21: the QueryClient (session/query-client.ts)', () => {
  it('QC-01 OD-25: no retry on a 4xx, one on 409 try_again, for queries and mutations alike', () => {
    for (const kind of ['query', 'mutation'] as const) {
      expect(shouldRetry(kind, 0, failure(409, 'try_again'))).toBe(true)
      expect(shouldRetry(kind, 1, failure(409, 'try_again'))).toBe(false)
      for (const [status, code] of [
        [400, 'invalid_request'],
        [401, 'signed_out'],
        [403, 'forbidden'],
        [404, 'Not Found'],
        [409, 'wrong_step'],
        [422, 'pin_too_easy'],
        [429, 'too_many_requests'],
        [200, 'invalid_response'],
      ] as const)
        expect(shouldRetry(kind, 0, failure(status, code)), `${kind} ${status} ${code}`).toBe(false)
    }
  })

  it('QC-02 OD-25: queries retry up to 2 times on a 5xx or no answer; mutations never do; full jitter up to 30 s', () => {
    for (const error of [failure(503, 'unavailable'), failure(500, 'internal'), failure(0, 'network')]) {
      expect([0, 1, 2].map(count => shouldRetry('query', count, error))).toEqual([true, true, false])
      expect(shouldRetry('mutation', 0, error)).toBe(false)
    }
    // Not an ApiFailure (a bug, not the network) and halted (the session is ending): never.
    expect(shouldRetry('query', 0, new TypeError('x is undefined'))).toBe(false)
    expect(shouldRetry('query', 0, failure(0, 'halted'))).toBe(false)
    expect(shouldRetry('mutation', 0, failure(0, 'halted'))).toBe(false)

    // Full jitter: anywhere from 0 to 1 s, 2 s, 4 s… with a 30 s cap.
    expect([0, 1, 2, 3, 4, 5, 10].map(count => retryDelay(count, () => 0.999_999))).toEqual([
      999, 1_999, 3_999, 7_999, 15_999, 29_999, 29_999,
    ])
    expect(retryDelay(3, () => 0)).toBe(0)
    expect(retryDelay(3, () => 0.5)).toBe(4_000)
    for (let count = 0; count < 20; count++) expect(retryDelay(count)).toBeLessThan(RETRY_CAP_MS)
  })

  it('QC-02 OD-25: the client applies the policy: a query that keeps failing on a 503 is tried 3 times in all, then errors', async () => {
    vi.useFakeTimers()
    try {
      const client = createQueryClient(() => {}, { random: () => 0.5 })
      const queryFn = vi.fn(async () => {
        throw failure(503, 'unavailable')
      })
      const result = client.fetchQuery({ queryKey: ['x'], queryFn }).catch((error: unknown) => error)
      await vi.runAllTimersAsync()
      expect(await result).toMatchObject({ code: 'unavailable' })
      expect(queryFn).toHaveBeenCalledTimes(3)
      // The query defaults the design names (OD-25, R-50).
      expect(client.getDefaultOptions().queries).toMatchObject({
        staleTime: 0,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        networkMode: 'online',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('QC-03 R-54 T19 item 11: a 401 signed_out from any query or mutation calls onSignedOut once; other failures and halted never do', async () => {
    const onSignedOut = vi.fn()
    const client = createQueryClient(onSignedOut)
    const reject = (error: unknown) => async () => {
      throw error
    }
    const settle = (promise: Promise<unknown>) => promise.catch(() => {})

    await settle(client.fetchQuery({ queryKey: ['a'], queryFn: reject(failure(403, 'forbidden')) }))
    await settle(client.fetchQuery({ queryKey: ['b'], queryFn: reject(failure(0, 'halted')) }))
    await settle(
      client
        .getMutationCache()
        .build(client, { mutationFn: reject(failure(404, 'Not Found')) })
        .execute({}),
    )
    expect(onSignedOut).not.toHaveBeenCalled()

    await settle(client.fetchQuery({ queryKey: ['c'], queryFn: reject(failure(401, 'signed_out')) }))
    expect(onSignedOut).toHaveBeenCalledTimes(1)
    await settle(
      client
        .getMutationCache()
        .build(client, { mutationFn: reject(failure(401, 'signed_out')) })
        .execute({}),
    )
    await settle(client.fetchQuery({ queryKey: ['d'], queryFn: reject(failure(401, 'signed_out')) }))
    expect(onSignedOut).toHaveBeenCalledTimes(1)

    // A mutation alone reaches it too.
    const fromMutation = vi.fn()
    const other = createQueryClient(fromMutation)
    await settle(
      other
        .getMutationCache()
        .build(other, { mutationFn: reject(failure(401, 'signed_out')) })
        .execute({}),
    )
    expect(fromMutation).toHaveBeenCalledTimes(1)
  })
})
