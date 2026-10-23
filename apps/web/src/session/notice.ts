// Where this document's person stands with the privacy notice (PDPA-03, ACC-12; C0.9 PD-43 to
// PD-46, TECH-SPEC T22 items 28 to 31): one store per document, made by the session runtime and
// held in memory only (WS-01), so nothing of it outlives the person. It reads no flag (WS-11): the
// acknowledgement gate is never one.
//
// The standing starts as the boot's session answer says (acknowledged, required or unpublished) and
// moves on what the document learns:
// - required(): a hint that the person must acknowledge: a 403 notice_required from any request
//   (session/query-client.ts), the gateway's 4403, or the DPO's own publish (/dpo/notice). The
//   router sends the tab to /notice (router/router.tsx, NoticeWatcher), and the cached notice answer
//   is reset, so /notice shows what GET /api/notice says now, never an older answer. A hint while
//   the standing is required already changes nothing;
// - heard(): an answer that states the standing, GET /api/notice's or the session's, with the mark
//   its request was sent at (mark()). An answer saying acknowledged moves the standing forward
//   unless its request was sent before the last move to required, since it may speak of a version
//   since replaced; one saying anything else moves it back only when its request was sent after the
//   last acknowledgement here, so a request that crossed the acknowledgement can't send the tab back
//   to /notice. A session answer saying required resets the cached notice answer as required() does;
// - acknowledged(from): the person acknowledged, here (this tab's POST /api/notice/acknowledge) or
//   elsewhere (another tab's { t: 'notice' }, or an answer that says so). The live connection
//   starts, if the standing kept it off since the boot (the runtime starts it only once the
//   standing is acknowledged), or resumes from a 4403 pause (never a 4426 one,
//   live/gateway-client.ts); every query is fetched again, since what was refused before may be
//   answered now; and only from here, the other tabs are told.
// - check(): another tab says its person acknowledged: ask GET /api/notice, whose answer decides
//   through heard(). A tab already acknowledged has nothing to learn, and asks nothing.
//
// The path a tab was on when the notice took it to /notice is kept here too, in memory (never in
// storage, WS-01), and only when it is an app path (APP_PATHS): /notice opens it again once the
// person has acknowledged, read once.
import type { NoticeStanding } from '@hearth/shared'
import { type AppPath, isAppPath } from '@/router/paths.ts'

export type NoticeSource = 'here' | 'elsewhere'

// Which answer states the standing: GET /api/notice's, or the session's (GET /api/session).
export type NoticeAnswerFrom = 'notice' | 'session'

// What a request knew when it was sent: how many acknowledgements, and how many moves to required,
// this document had made or heard by then. An answer whose request crossed one may be out of date.
export interface NoticeMark {
  readonly acknowledgements: number
  readonly requirements: number
}

export interface NoticeStore {
  standing(): NoticeStanding
  // Calls the listener after each change of standing; returns the stop.
  subscribe(listener: () => void): () => void
  required(): void
  // asked: the mark the answer's request was sent at.
  heard(standing: NoticeStanding, asked: NoticeMark, from: NoticeAnswerFrom): void
  acknowledged(from: NoticeSource): void
  check(): void
  // The mark a request sent now carries (heard()'s asked).
  mark(): NoticeMark
  rememberReturn(path: string): void
  takeReturn(): AppPath | undefined
}

export interface NoticeStoreDeps {
  // The boot's session answer's standing.
  readonly initial: NoticeStanding
  // The live connection's start and resume: start() opens it the first time and does nothing after;
  // resume() reconnects after a 4403 pause and does nothing otherwise (live/gateway-client.ts).
  readonly live: { start(): void; resume(): void }
  // Every query fetched again.
  refetchAll(): void
  // The cached notice answer dropped, and fetched again if /notice or Settings shows it.
  resetNotice(): void
  // GET /api/notice, whose answer reaches heard() through the runtime.
  fetchNotice(): void
  // Tells this browser's other tabs: { t: 'notice' } on the identity channel (session/document.ts).
  post(): void
}

// Runs one step of a change, whatever the others do, as the runtime's end() does.
function step(run: () => void): void {
  try {
    run()
  } catch (error) {
    console.error(error)
  }
}

export function createNoticeStore(deps: NoticeStoreDeps): NoticeStore {
  let standing: NoticeStanding = deps.initial
  let count = 0
  let requirements = 0
  let kept: AppPath | undefined
  const listeners = new Set<() => void>()

  const set = (next: NoticeStanding) => {
    if (next === standing) return
    if (next === 'required') requirements += 1
    standing = next
    for (const listener of [...listeners]) step(listener)
  }

  const acknowledged = (from: NoticeSource) => {
    const was = standing
    count += 1
    set('acknowledged')
    step(() => {
      deps.live.start()
      deps.live.resume()
    })
    // Another tab's message, or a second answer that says so, changes nothing more here.
    if (was !== 'acknowledged' || from === 'here') step(deps.refetchAll)
    if (from === 'here') step(deps.post)
  }

  return {
    standing: () => standing,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    required() {
      // Already required: the hint says nothing new, and /notice keeps what it shows.
      if (standing === 'required') return
      step(deps.resetNotice)
      set('required')
    },
    heard(next, asked, from) {
      if (next === 'acknowledged') {
        // Sent before the last move to required: it may speak of a version since replaced.
        if (asked.requirements !== requirements) return
        if (standing !== 'acknowledged') acknowledged('elsewhere')
        return
      }
      // Sent before the last acknowledgement here: it may speak of a version since acknowledged.
      if (asked.acknowledgements !== count) return
      // The session asking for the notice: a newer version was published, and the cached notice
      // answer may still say the older one was acknowledged, so it goes, as with required().
      if (next === 'required' && from === 'session' && standing !== 'required') step(deps.resetNotice)
      set(next)
    },
    acknowledged,
    check() {
      if (standing !== 'acknowledged') step(deps.fetchNotice)
    },
    mark: () => ({ acknowledgements: count, requirements }),
    rememberReturn(path) {
      kept = isAppPath(path) ? path : undefined
    },
    takeReturn() {
      const path = kept
      kept = undefined
      return path
    },
  }
}
