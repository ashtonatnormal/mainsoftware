// The signed-in document's session runtime (T21, D-01; R-42, R-54, CHT-60). The boot starts one when
// GET /api/session names a person, and it holds everything that belongs to that person: their
// session answer, the QueryClient, and the formatters for their zone. C0.8 S9 adds the gateway
// client, holding the person's own topic.
//
// It ends the document when the session ends, whichever way that is learnt: a refusal with
// signed_out from any query or mutation (session/query-client.ts), a session answer naming someone
// else, another tab's identity message, or this tab's own Sign out. end() runs once, each step on
// its own, so one that throws doesn't stop the rest:
// 1. mark the runtime ended (a second end() returns at once);
// 2. halt requests (api/http.ts): from here nothing reaches the server, so an observer refetching
//    while React is still mounted sends nothing, and in the other_tab case never uses the next
//    person's cookie;
// 3. stop watching the session answer, cancel what Query has in flight and clear its cache;
// 4. leave the document (session/document.ts): the next one starts from nothing.
// C0.8 S9 stops the gateway between 2 and 3; C1.8 offers unsynced edits as a copy before 2 (NFR-04).
//
// Sign out in flight: the server revokes the session and publishes it, so a query here can answer
// 401 before the POST's own answer arrives. While signOut() waits, an end for session_ended is
// read as signed_out_here, so the person who pressed Sign out reads "You've signed out.", not
// "You've been signed out." A sign-out that fails (no answer, a 5xx) leaves the session running.
import { type QueryClient, QueryObserver } from '@tanstack/react-query'
import { ApiFailure, apiPost, haltRequests } from '@/api/http.ts'
import { sessionQuery } from '@/api/queries.ts'
import type { SessionInfo } from '@/boot/load-session.ts'
import { type Formatters, formattersFor } from '@/lib/time.ts'
import {
  browserDocumentEnv,
  type DocumentEnv,
  type LeftReason,
  leaveDocument,
  openIdentityChannel,
} from '@/session/document.ts'
import { createQueryClient } from '@/session/query-client.ts'

export type SessionEndReason = LeftReason

export interface RuntimeEnv extends DocumentEnv {
  // For the retry delays' jitter.
  random(): number
}

export interface SessionRuntime {
  readonly info: SessionInfo
  readonly queryClient: QueryClient
  readonly formatters: Formatters
  // POST /api/auth/sign-out: a 2xx or a 401 ends the session ('ended'); anything else leaves it
  // running ('failed'), and the caller says so.
  signOut(): Promise<'ended' | 'failed'>
  // Idempotent; see the steps above.
  end(reason: SessionEndReason): void
}

export function browserEnv(): RuntimeEnv {
  return { ...browserDocumentEnv(), random: Math.random }
}

// Runs one step of end(), whatever the others do.
function step(run: () => void): void {
  try {
    run()
  } catch (error) {
    console.error(error)
  }
}

export function startSessionRuntime(info: SessionInfo, env: RuntimeEnv): SessionRuntime {
  let ended = false
  let signingOut: Promise<'ended' | 'failed'> | undefined

  const queryClient = createQueryClient(() => end('session_ended'), { random: env.random })
  queryClient.setQueryData(sessionQuery.queryKey, info)

  // The session answer, watched for as long as the document lives: a focus or reconnect refetches
  // it at most once a minute (api/queries.ts), and an answer naming anyone else ends the document.
  const sessionObserver = new QueryObserver(queryClient, sessionQuery)
  const stopWatching = sessionObserver.subscribe(result => {
    if (result.data !== undefined && result.data.personId !== info.personId) end('person_changed')
  })

  openIdentityChannel(env, () => end('other_tab'))

  function end(reason: SessionEndReason): void {
    if (ended) return
    ended = true
    const why = signingOut !== undefined && reason === 'session_ended' ? 'signed_out_here' : reason
    step(haltRequests)
    step(stopWatching)
    step(() => {
      void queryClient.cancelQueries()
      queryClient.clear()
    })
    step(() => leaveDocument(why, env))
  }

  async function sendSignOut(): Promise<'ended' | 'failed'> {
    try {
      await apiPost('/api/auth/sign-out', {})
    } catch (error) {
      // A 401 means the session had already gone; halted means it is ending anyway.
      const gone = ended || (error instanceof ApiFailure && (error.status === 401 || error.code === 'halted'))
      if (!gone) {
        signingOut = undefined
        return 'failed'
      }
    }
    end('signed_out_here')
    return 'ended'
  }

  return {
    info,
    queryClient,
    formatters: formattersFor(info.timeZone),
    signOut() {
      if (ended) return Promise.resolve('ended')
      signingOut ??= sendSignOut()
      return signingOut
    },
    end,
  }
}
