// The live connection's line under the screen's header (T21; OD-42, X11, K-42). It renders nothing
// while the connection is up, connecting, or down for under 30 s. Stalled (30 s of failed
// reconnects) it reads "Reconnecting…"; when a new deploy needs a reload the page couldn't make
// itself (one a minute at most), it says so with a Reload button. The line is not a live region:
// each change is spoken once through the app's announcer (liveAnnouncement), so it never
// chatters. The shell mounts it with the runtime's store (C0.8 S10).
import { type ReactNode, useEffect, useRef } from 'react'
import { LIVE } from '@/strings/live.ts'
import { announce } from '@/ui/announce.ts'
import { Button } from '@/ui/Button.tsx'
import { type LiveSource, liveAnnouncement, useLiveStatus } from './live-status.ts'

export interface ConnectionBannerProps {
  live: LiveSource
  // The Reload button's action; the page's own reload unless a test passes one.
  reload?: () => void
}

const reloadPage = () => window.location.reload()

export function ConnectionBanner({ live, reload = reloadPage }: ConnectionBannerProps): ReactNode {
  const state = useLiveStatus(live)
  const before = useRef(state)
  useEffect(() => {
    const text = liveAnnouncement(before.current, state)
    before.current = state
    if (text !== undefined) announce(text)
  }, [state])

  if (state.updateBlocked) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-surface-2 px-4 py-1 text-fg">
        <p className="min-w-0 flex-1 py-2">{LIVE.updated}</p>
        <Button variant="primary" onClick={reload}>
          {LIVE.reload}
        </Button>
      </div>
    )
  }
  if (state.status === 'stalled') return <p className="bg-surface-2 px-4 py-2 text-fg">{LIVE.reconnecting}</p>
  return null
}
