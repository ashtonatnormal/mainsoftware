// The signed-in document's session runtime (T21 items 3 and 4, D-01; CHT-60, T17 item 11,
// T19 item 11). The boot starts one when GET /api/session names a person, and it holds everything
// that belongs to that person: their session answer, the QueryClient, the formatters for their
// zone, their standing with the privacy notice (session/notice.ts), and the live connection
// (live/gateway-client.ts), which holds the person's own topic, person:<id> (C0.14's inbox reads
// it; C0.8 holds it so the sub and ack path runs end to end).
//
// The live connection starts only once the person has acknowledged the current privacy notice
// (C0.9 PD-45, PD-46): the gateway admits nobody else, so a socket opened before would only be
// closed 4403. With the session answer's standing acknowledged it starts at once; otherwise the
// notice store starts it when the person acknowledges. What moves the standing (T22 item 31):
// - a 403 notice_required from any query or mutation (session/query-client.ts), or the gateway's
//   4403: a hint, so the tab goes to /notice, whose GET /api/notice decides;
// - every answer of GET /api/notice and GET /api/session, read here from the QueryCache: an answer
//   saying acknowledged moves it forward; one saying otherwise moves it back only when its request
//   was sent after the last acknowledgement here. A notice answer naming someone else ends the
//   document, as a session answer naming someone else does (B-11);
// - another tab's { t: 'notice' } on the identity channel: this tab asks GET /api/notice itself.
//
// What the live connection hears becomes Query work here, and nothing else (T19 item 10):
// - a topic acked ok, or its ev or reset: invalidate ['topic', <topic>], the key C1's topic-backed
//   queries use (none exists in C0.8);
// - a topic refused or dropped: remove ['topic', <topic>], wiping what was cached (Rule 6);
// - the flags nudge: invalidate the flags query, so it is fetched again (T17 item 11);
// - 4401, or the probe answering 401 while the connection is stalled or paused: end the session
//   (T21 item 4, T19 item 11);
// - 4426: reload for the new deploy, at most once a minute; when that is held back the live store
//   says so and ConnectionBanner offers a Reload button (T21 item 4), and the paused connection's
//   probe still ends a session that ends meanwhile;
// - 4403: the connection pauses with nothing wiped (T19 item 10), its probe running as for 4426,
//   and the notice store sends the tab to /notice; acknowledging there resumes it (C0.9 PD-46). A
//   document whose person hasn't acknowledged the current version starts in that pause.
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
// 4. stop watching the session and notice answers, cancel what Query has in flight and clear its
//    cache;
// 5. leave the document (session/document.ts): the next one starts from nothing.
// C1.8 offers unsynced edits as a copy before 2 (NFR-04).
//
// Sign out in flight: the server revokes the session and publishes it, so this tab's socket can
// close 4401, or a query here answer 401, before the POST's own answer arrives. While signOut()
// waits, an end for session_ended is read as signed_out_here, so the person who pressed Sign out
// reads "You've signed out.", not "You've been signed out." A sign-out that fails (a 5xx, no
// answer, or none within 20 s, SIGN_OUT_TIMEOUT_MS, when the POST is abandoned) leaves the session,
// and its live connection, running, and Sign out can be pressed again. If the server did end the
// session meanwhile, the socket's 4401 or the next 401 still ends the document.
import type { NoticeForClient } from '@hearth/shared'
import { type QueryClient, QueryObserver } from '@tanstack/react-query'
import { ApiFailure, apiPost, haltRequests } from '@/api/http.ts'
import { flagsQuery, noticeQuery, sessionQuery } from '@/api/queries.ts'
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
import { createNoticeStore, type NoticeMark, type NoticeStore } from '@/session/notice.ts'
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
  // The person's standing with the privacy notice (C0.9 PD-46): the router's guard and /notice
  // read it, and /notice tells it when the person acknowledges.
  readonly notice: NoticeStore
  // POST /api/auth/sign-out: a 2xx or a 401 ends the session ('ended'); anything else, no answer
  // within SIGN_OUT_TIMEOUT_MS included, leaves it running ('failed'), and the caller says so.
  signOut(): Promise<'ended' | 'failed'>
  // Idempotent; see the steps above.
  end(reason: SessionEndReason): void
}

// How long Sign out waits for its answer, as sign-in waits for each of its calls
// (sign-in/api.ts AUTH_TIMEOUT_MS). Past it the POST is abandoned and reads as network, so a stalled
// request can't leave the press pending for good, and the person can press again.
export const SIGN_OUT_TIMEOUT_MS = 20_000

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
// would otherwise hand the probe that fetch, with its retries and its wait for the network, so a
// poll paused offline would hold this one too. When the gateway lets the probe go (unanswered
// after 20 s, or the client stopping), its signal cancels the flags fetch the probe waits on, so a
// request that hangs doesn't stay open until the next probe. Query owns that fetch's own signal,
// and Safari 16.4 lacks AbortSignal.any, so the cancel goes through Query.
async function probeSession(queryClient: QueryClient, signal: AbortSignal): Promise<ProbeAnswer> {
  const letGo = () => void queryClient.cancelQueries({ queryKey: flagsQuery.queryKey, exact: true })
  signal.addEventListener('abort', letGo, { once: true })
  try {
    await queryClient.cancelQueries({ queryKey: flagsQuery.queryKey, exact: true })
    if (signal.aborted) return 'unknown'
    await queryClient.fetchQuery({ ...flagsQuery, staleTime: 0, retry: false, networkMode: 'always' })
    return 'signed_in'
  } catch (error) {
    return error instanceof ApiFailure && error.code === 'signed_out' ? 'signed_out' : 'unknown'
  } finally {
    signal.removeEventListener('abort', letGo)
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

// The queries whose answers state the person's standing with the notice.
const STANDING_KEYS: ReadonlySet<unknown> = new Set([sessionQuery.queryKey[0], noticeQuery.queryKey[0]])

export function startSessionRuntime(info: SessionInfo, env: RuntimeEnv): SessionRuntime {
  let ended = false
  let signingOut: Promise<'ended' | 'failed'> | undefined

  const queryClient = createQueryClient(() => end('session_ended'), {
    random: env.random,
    onNoticeRequired: () => notice.required(),
  })
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
    // /notice shows the notice; acknowledging it there calls gateway.resume().
    onNoticeRequired: () => notice.required(),
    onOutdated: () => {
      if (reloadForUpdate(env) === 'blocked') live.set({ updateBlocked: true })
    },
    probe: signal => probeSession(queryClient, signal),
    onStatus: status => live.set({ status }),
  })
  // Unacknowledged, it starts paused for the notice: no socket, which the gateway would refuse, and
  // the probe hearing a sign-out elsewhere within 30 s (GW-26), on /notice and on the DPO's pages
  // before v0 alike; acknowledging resumes it (session/notice.ts).
  if (info.notice === 'acknowledged') gateway.start()
  else gateway.startPaused()
  gateway.hold(`person:${info.personId}`)
  const stopVisible = env.live.onVisible(() => gateway.visible())

  const identity = openIdentityChannel(
    env,
    () => end('other_tab'),
    () => notice.check(),
  )

  // Each standing query's request is tagged with the notice store's mark when it was sent (how many
  // acknowledgements and moves to required this document had made or heard), so an answer that
  // crossed one is known (heard()'s asked). Query dispatches no new fetch when a refetch replaces
  // one in flight, so the refetch after an acknowledgement tags the queries it sends again itself.
  const askedAt = new Map<string, NoticeMark>()
  const tagActive = () => {
    for (const query of queryClient.getQueryCache().getAll())
      if (STANDING_KEYS.has(query.queryKey[0]) && query.isActive()) askedAt.set(query.queryHash, notice.mark())
  }

  const notice: NoticeStore = createNoticeStore({
    initial: info.notice,
    live: gateway,
    refetchAll: () => {
      tagActive()
      void queryClient.invalidateQueries()
    },
    resetNotice: () => void queryClient.resetQueries({ queryKey: noticeQuery.queryKey, exact: true }),
    fetchNotice: () => void queryClient.fetchQuery(noticeQuery).catch(() => {}),
    // A fetch in flight is cancelled first (fetchQuery would share it, and a refetch cancels one
    // only once the query holds data), then the notice is fetched again; what it shows stays.
    refreshNotice: () =>
      void queryClient
        .cancelQueries({ queryKey: noticeQuery.queryKey, exact: true })
        .then(() => queryClient.refetchQueries({ queryKey: noticeQuery.queryKey, exact: true })),
    post: () => identity.postNotice(),
  })

  // Every answer that states the standing, whoever fetched it: /notice's poll, Settings, check(),
  // the session observer's refetch.
  const stopHearing = queryClient.getQueryCache().subscribe(event => {
    if (event.type !== 'updated' || !STANDING_KEYS.has(event.query.queryKey[0])) return
    const { action, query } = event
    if (action.type === 'fetch') {
      askedAt.set(query.queryHash, notice.mark())
      return
    }
    // The runtime's own seeding is no answer.
    if (action.type !== 'success' || action.manual === true) return
    const asked = askedAt.get(query.queryHash) ?? notice.mark()
    if (query.queryKey[0] === noticeQuery.queryKey[0]) {
      const answer = action.data as Partial<Pick<NoticeForClient, 'person' | 'standing'>> | undefined
      if (answer?.person !== undefined && answer.person !== info.personId) end('person_changed')
      else if (answer?.standing !== undefined) notice.heard(answer.standing, asked, 'notice')
      return
    }
    const answer = action.data as Partial<Pick<SessionInfo, 'personId' | 'notice'>> | undefined
    if (answer?.personId === info.personId && answer.notice !== undefined) notice.heard(answer.notice, asked, 'session')
  })

  // The session answer, watched for as long as the document lives: a focus or reconnect refetches
  // it at most once a minute (api/queries.ts), and an answer naming anyone else ends the document.
  const sessionObserver = new QueryObserver(queryClient, sessionQuery)
  const stopWatching = sessionObserver.subscribe(result => {
    if (result.data !== undefined && result.data.personId !== info.personId) end('person_changed')
  })

  function end(reason: SessionEndReason): void {
    if (ended) return
    ended = true
    const why = signingOut !== undefined && reason === 'session_ended' ? 'signed_out_here' : reason
    step(haltRequests)
    step(() => gateway.stop())
    step(stopVisible)
    step(stopWatching)
    step(stopHearing)
    step(() => {
      void queryClient.cancelQueries()
      queryClient.clear()
    })
    step(() => leaveDocument(why, env))
  }

  async function sendSignOut(): Promise<'ended' | 'failed'> {
    // The deadline runs on the live connection's clock, which the tests drive.
    const deadline = new AbortController()
    const timer = env.live.clock.set(() => deadline.abort(), SIGN_OUT_TIMEOUT_MS)
    try {
      await apiPost('/api/auth/sign-out', {}, undefined, { signal: deadline.signal })
    } catch (error) {
      // A 401 means the session had already gone; halted means it is ending anyway.
      const gone = ended || (error instanceof ApiFailure && (error.status === 401 || error.code === 'halted'))
      if (!gone) {
        signingOut = undefined
        return 'failed'
      }
    } finally {
      env.live.clock.clear(timer)
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
    notice,
    signOut() {
      if (ended) return Promise.resolve('ended')
      signingOut ??= sendSignOut()
      return signingOut
    },
    end,
  }
}
