// The signed-in document's session runtime (T21, D-01; R-42, R-47–R-49, R-54, CHT-60). The boot
// starts one when GET /api/session names a person, and it holds everything that belongs to that
// person: their session answer, the QueryClient, the formatters for their zone, and the live
// connection (live/gateway-client.ts), which holds the person's own topic, person:<id> (C0.14's
// inbox reads it; C0.8 holds it so the sub and ack path runs end to end).
//
// What the live connection hears becomes Query work here, and nothing else (T19 item 10):
// - a topic acked ok, or its ev or reset: invalidate ['topic', <topic>], the key C1's topic-backed
//   queries use (none exists in C0.8);
// - a topic refused or dropped: remove ['topic', <topic>], wiping what was cached (Rule 6);
// - the flags nudge: invalidate the flags query, so it is fetched again (R-47, T17 item 11);
// - 4401, or a stalled connection's probe answering 401: end the session (R-49, R-48);
// - 4426: reload for the new deploy, at most once a minute; when that is held back the live store
//   says so and ConnectionBanner offers a Reload button (K-42);
// - 4403: nothing until C0.9 shows the notice and resumes the connection. Nothing is wiped (R-43).
// The probe fetches the flags query only to learn whether the session still holds: it reads no
// flag (WS-11), and a 401 from it ends the session through the QueryClient like any other.
//
// It ends the document when the session ends, whichever way that is learnt: a refusal with
// signed_out from any query or mutation (session/query-client.ts), the gateway's 4401 or probe, a
// session answer naming someone else, another tab's identity message, or this tab's own Sign out.
// end() runs once, each step on its own, so one that throws doesn't stop the rest:
// 1. mark the runtime ended (a second end() returns at once);
// 2. halt requests (api/http.ts): from here nothing reaches the server, so an observer refetching
//    while React is still mounted sends nothing, and in the other_tab case never uses the next
//    person's cookie;
// 3. stop the live connection (close 1000, every timer cleared, never reconnecting) and its
//    visibility listener;
// 4. stop watching the session answer, cancel what Query has in flight and clear its cache;
// 5. leave the document (session/document.ts): the next one starts from nothing.
// C1.8 offers unsynced edits as a copy before 2 (NFR-04).
//
// Sign out in flight: the server revokes the session and publishes it, so this tab's socket can
// close 4401, or a query here answer 401, before the POST's own answer arrives. While signOut()
// waits, an end for session_ended is read as signed_out_here, so the person who pressed Sign out
// reads "You've signed out.", not "You've been signed out." A sign-out that fails (no answer, a
// 5xx) leaves the session, and its live connection, running.
import { type QueryClient, QueryObserver } from '@tanstack/react-query'
import { ApiFailure, apiPost, haltRequests } from '@/api/http.ts'
import { flagsQuery, sessionQuery } from '@/api/queries.ts'
import type { SessionInfo } from '@/boot/load-session.ts'
import { type Formatters, formattersFor } from '@/lib/time.ts'
import {
  GatewayClient,
  type GatewayClock,
  gatewayUrl,
  type ProbeAnswer,
  type WebSocketLike,
} from '@/live/gateway-client.ts'
import { createLiveStore, type LiveSource } from '@/live/live-status.ts'
import {
  browserDocumentEnv,
  type DocumentEnv,
  type LeftReason,
  leaveDocument,
  openIdentityChannel,
  reloadForUpdate,
} from '@/session/document.ts'
import { createQueryClient } from '@/session/query-client.ts'

export type SessionEndReason = LeftReason

// What the live connection needs from the browser.
export interface LiveEnv {
  // wss://<this page's host>/ws.
  readonly url: string
  readonly WebSocket: new (url: string) => WebSocketLike
  readonly clock: GatewayClock
  // Calls the listener when the page becomes visible or comes back online; returns the stop.
  onVisible(listener: () => void): () => void
}

export interface RuntimeEnv extends DocumentEnv {
  // For the retry delays' and the live connection's jitter.
  random(): number
  readonly live: LiveEnv
}

export interface SessionRuntime {
  readonly info: SessionInfo
  readonly queryClient: QueryClient
  readonly formatters: Formatters
  readonly gateway: GatewayClient
  // The live connection's status for ConnectionBanner.
  readonly live: LiveSource
  // POST /api/auth/sign-out: a 2xx or a 401 ends the session ('ended'); anything else leaves it
  // running ('failed'), and the caller says so.
  signOut(): Promise<'ended' | 'failed'>
  // Idempotent; see the steps above.
  end(reason: SessionEndReason): void
}

// The browser's timers, on a clock that only moves forward.
const browserClock: GatewayClock = {
  now: () => performance.now(),
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: id => window.clearTimeout(id),
}

function onVisible(listener: () => void): () => void {
  const shown = () => {
    if (document.visibilityState === 'visible') listener()
  }
  document.addEventListener('visibilitychange', shown)
  window.addEventListener('online', listener)
  return () => {
    document.removeEventListener('visibilitychange', shown)
    window.removeEventListener('online', listener)
  }
}

export function browserEnv(): RuntimeEnv {
  return {
    ...browserDocumentEnv(),
    random: Math.random,
    live: { url: gatewayUrl(window.location), WebSocket, clock: browserClock, onVisible },
  }
}

// The key a topic's server data is cached under (C1 onwards).
export const topicKey = (topic: string) => ['topic', topic] as const

// Whether the session still holds, from GET /api/flags (T19 item 11): an answer means yes, a 401
// no, anything else can't tell. It sends one request of its own at once, whatever the network says,
// since the gateway asks again in 30 s. A flags fetch already in flight is cancelled first: Query
// would otherwise hand the probe that fetch, with its retries and its wait for the network, and a
// poll paused offline would hold the probe, and the gateway's later probes, until it came back.
async function probeSession(queryClient: QueryClient): Promise<ProbeAnswer> {
  try {
    await queryClient.cancelQueries({ queryKey: flagsQuery.queryKey, exact: true })
    await queryClient.fetchQuery({ ...flagsQuery, staleTime: 0, retry: false, networkMode: 'always' })
    return 'signed_in'
  } catch (error) {
    return error instanceof ApiFailure && error.code === 'signed_out' ? 'signed_out' : 'unknown'
  }
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

  // The live connection, made before anything that can end the session, so end() always finds it.
  const live = createLiveStore('connecting')
  const gateway = new GatewayClient({
    url: env.live.url,
    WebSocket: env.live.WebSocket,
    clock: env.live.clock,
    random: env.random,
    onTopicStale: topic => void queryClient.invalidateQueries({ queryKey: topicKey(topic) }),
    onTopicGone: topic => queryClient.removeQueries({ queryKey: topicKey(topic) }),
    onNudge: what => {
      if (what === 'flags') void queryClient.invalidateQueries({ queryKey: flagsQuery.queryKey })
    },
    onSignedOut: () => end('session_ended'),
    // C0.9 shows the notice here, then calls gateway.resume().
    onNoticeRequired: () => {},
    onOutdated: () => {
      if (reloadForUpdate(env) === 'blocked') live.set({ updateBlocked: true })
    },
    probe: () => probeSession(queryClient),
    onStatus: status => live.set({ status }),
  })
  gateway.start()
  gateway.hold(`person:${info.personId}`)
  const stopVisible = env.live.onVisible(() => gateway.visible())

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
    step(() => gateway.stop())
    step(stopVisible)
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
    gateway,
    live,
    signOut() {
      if (ended) return Promise.resolve('ended')
      signingOut ??= sendSignOut()
      return signingOut
    },
    end,
  }
}
