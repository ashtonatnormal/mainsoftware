// The live connection's line under the screen's header (T21 item 4, X11). It renders nothing
// while the connection is up, connecting, or down for under 30 s. Stalled (30 s of failed
// reconnects) it reads "Reconnecting…"; when a new deploy needs a reload the page couldn't make
// itself (one a minute at most), it says so with a Reload button. The line is not a live region:
// each change is spoken once through the app's announcer (liveAnnouncement), so it never
// chatters. A change made before the banner mounted (a 4426 that arrives while the shell's chunk is
// still loading) is compared with the document's starting state, so it is spoken too. The shell
// mounts it under the screen's header, with the runtime's store (shell/Shell.tsx). Each line is
// one of finance's alerts across the screen: Updated on the info tint, Reconnecting… on the warning
// tint, each with a hairline of its tone and the text in ink (T21 item 6).
import { type ReactNode, useEffect, useRef } from 'react'
import { LIVE } from '@/strings/live.ts'
import { announce } from '@/ui/announce.ts'
import { Button } from '@/ui/Button.tsx'
import { LIVE_START, type LiveSource, type LiveState, liveAnnouncement, useLiveStatus } from './live-status.ts'

export interface ConnectionBannerProps {
  live: LiveSource
  // The Reload button's action; the page's own reload unless a test passes one.
  reload?: () => void
}

const reloadPage = () => window.location.reload()

export function ConnectionBanner({ live, reload = reloadPage }: ConnectionBannerProps): ReactNode {
  const state = useLiveStatus(live)
  const before = useRef<LiveState>(LIVE_START)
  useEffect(() => {
    const text = liveAnnouncement(before.current, state)
    before.current = state
    if (text !== undefined) announce(text)
  }, [state])

  if (state.updateBlocked) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-y border-accent/30 bg-accent-soft px-4 py-1 text-fg">
        <p className="min-w-0 flex-1 py-2">{LIVE.updated}</p>
        <Button variant="primary" onClick={reload}>
          {LIVE.reload}
        </Button>
      </div>
    )
  }
  if (state.status === 'stalled') {
    return <p className="border-y border-warn/30 bg-warn-soft px-4 py-2 text-fg">{LIVE.reconnecting}</p>
  }
  return null
}
