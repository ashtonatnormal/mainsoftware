// The one QueryClient a signed-in document makes (D-01; T21 item 3). It lives exactly as long
// as the document and the person: the session runtime makes it at the start and clears it at the
// end, and the next person's document makes its own. WS-02 keeps `new QueryClient(` in this file.
//
// Retries (shouldRetry): a query is tried again once on 409 try_again (another transaction got
// there first), and up to twice on a 5xx or no answer; never on any other 4xx, which another try
// won't change, nor once requests are halted. A mutation is tried again once on 409 try_again only:
// any other failed write may have landed, so repeating it is the screen's choice. The wait before
// each retry is full jitter: a random time up to 1 s, 2 s, 4 s… capped at 30 s, so tabs that failed
// together don't come back together.
//
// A refusal with signed_out (a 401) from any query or mutation ends the session: this is the one
// place that notices it (T21 item 3), and it calls onSignedOut once. halted is the session already
// ending.
//
// A refusal with notice_required (a 403: the person hasn't acknowledged the current privacy notice,
// C0.9 PD-43 and PD-46) from any query or mutation calls onNoticeRequired, each time: it is a hint,
// so the session runtime sends the tab to /notice, whose own answer decides. It is never retried,
// as no other 403 is.
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { ApiFailure } from '@/api/http.ts'

export const RETRY_BASE_MS = 1_000
export const RETRY_CAP_MS = 30_000

// failureCount is how many tries have failed before this one: 0 when the first try fails.
export function shouldRetry(kind: 'query' | 'mutation', failureCount: number, error: unknown): boolean {
  if (!(error instanceof ApiFailure) || error.code === 'halted') return false
  if (error.status === 409 && error.code === 'try_again') return failureCount < 1
  if (kind === 'mutation') return false
  if (error.status === 0 || error.status >= 500) return failureCount < 2
  return false
}

// The wait before the retry after failureCount failures (0 for the first retry).
export function retryDelay(failureCount: number, random: () => number = Math.random): number {
  return Math.floor(random() * Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** failureCount))
}

export interface QueryClientOptions {
  random?: () => number
  onNoticeRequired?: () => void
}

export function createQueryClient(onSignedOut: () => void, options: QueryClientOptions = {}): QueryClient {
  const random = options.random ?? Math.random
  let signedOut = false
  const onError = (error: unknown) => {
    if (signedOut || !(error instanceof ApiFailure)) return
    if (error.status === 403 && error.code === 'notice_required') {
      options.onNoticeRequired?.()
      return
    }
    if (error.code !== 'signed_out') return
    signedOut = true
    onSignedOut()
  }
  return new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        staleTime: 0,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        networkMode: 'online',
        retry: (failureCount, error) => shouldRetry('query', failureCount, error),
        retryDelay: failureCount => retryDelay(failureCount, random),
      },
      mutations: {
        retry: (failureCount, error) => shouldRetry('mutation', failureCount, error),
        retryDelay: failureCount => retryDelay(failureCount, random),
      },
    },
  })
}
