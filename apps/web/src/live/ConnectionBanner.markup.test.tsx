// The live connection's banner and what it announces (T21; OD-42, X11, K-42). The markup is rendered
// with react-dom/server; what it announces is a pure function of the state before and after.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LIVE } from '@/strings/live.ts'
import { ConnectionBanner } from './ConnectionBanner.tsx'
import type { LiveStatus } from './gateway-client.ts'
import { createLiveStore, type LiveState, liveAnnouncement } from './live-status.ts'

const STATUSES: LiveStatus[] = ['connecting', 'live', 'reconnecting', 'stalled', 'paused', 'stopped']

function banner(status: LiveStatus, updateBlocked = false): string {
  const store = createLiveStore(status)
  store.set({ updateBlocked })
  return renderToStaticMarkup(<ConnectionBanner live={store} reload={() => {}} />)
}

const state = (status: LiveStatus, updateBlocked = false): LiveState => ({ status, updateBlocked })

describe('T21 OD-42: the connection banner (live/ConnectionBanner.tsx)', () => {
  it('CB-01 OD-42 X11: it shows nothing until the connection has failed for 30 s, then Reconnecting… in a line that is not a live region', () => {
    for (const status of STATUSES.filter(status => status !== 'stalled')) expect(banner(status), status).toBe('')
    const stalled = banner('stalled')
    expect(stalled).toContain(LIVE.reconnecting)
    expect(stalled).not.toMatch(/aria-live|role="(?:status|alert)"/)
  })

  it('CB-02 K-42: a held-back reload shows the update line with a 44 px Reload button, whatever the status', () => {
    for (const status of STATUSES) {
      const markup = banner(status, true)
      expect(markup, status).toContain(LIVE.updated)
      expect(markup, status).toMatch(/<button type="button" class="[^"]*min-h-11[^"]*"[^>]*>Reload<\/button>/)
      expect(markup, status).not.toContain(LIVE.reconnecting)
    }
  })

  it('CB-03 X11: each change is announced once: stalled says Reconnecting…, the welcome after it Connected again., a held-back reload that Hearth was updated; a short drop says nothing', () => {
    expect(liveAnnouncement(state('live'), state('reconnecting'))).toBeUndefined()
    expect(liveAnnouncement(state('reconnecting'), state('live'))).toBeUndefined()
    expect(liveAnnouncement(state('connecting'), state('live'))).toBeUndefined()
    expect(liveAnnouncement(state('reconnecting'), state('stalled'))).toBe(LIVE.reconnecting)
    expect(liveAnnouncement(state('connecting'), state('stalled'))).toBe(LIVE.reconnecting)
    expect(liveAnnouncement(state('stalled'), state('stalled'))).toBeUndefined()
    expect(liveAnnouncement(state('stalled'), state('live'))).toBe(LIVE.connectedAgain)
    expect(liveAnnouncement(state('stalled'), state('stopped'))).toBeUndefined()
    expect(liveAnnouncement(state('live'), state('paused', true))).toBe(LIVE.updated)
    expect(liveAnnouncement(state('paused', true), state('paused', true))).toBeUndefined()
  })

  it('CB-04: the store keeps its snapshot until something changes, and tells its listeners only then', () => {
    const store = createLiveStore('connecting')
    const first = store.snapshot()
    let heard = 0
    const stop = store.subscribe(() => heard++)
    store.set({ status: 'connecting' })
    expect(store.snapshot()).toBe(first)
    expect(heard).toBe(0)
    store.set({ status: 'live' })
    expect(store.snapshot()).toEqual({ status: 'live', updateBlocked: false })
    expect(heard).toBe(1)
    stop()
    store.set({ status: 'stalled' })
    expect(heard).toBe(1)
  })
})
