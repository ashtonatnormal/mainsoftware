// The live connection's state as the screens see it (T21; OD-42, X11): the gateway client's status
// (live/gateway-client.ts) and whether a reload for a new deploy was held back (K-42). The session
// runtime owns the one store a document has and feeds it; ConnectionBanner reads it through
// useLiveStatus. It holds no one's data, only a status.
import { useSyncExternalStore } from 'react'
import { LIVE } from '@/strings/live.ts'
import type { LiveStatus } from './gateway-client.ts'

export interface LiveState {
  readonly status: LiveStatus
  // The gateway asked for a reload (4426) within a minute of the last one, so the page didn't
  // reload itself: the banner asks the person to.
  readonly updateBlocked: boolean
}

export interface LiveSource {
  subscribe(listener: () => void): () => void
  // The same object until something changes, as useSyncExternalStore needs.
  snapshot(): LiveState
}

export interface LiveStore extends LiveSource {
  set(change: Partial<LiveState>): void
}

// Where every document's live state starts (session/runtime.ts makes its store connecting).
export const LIVE_START: LiveState = { status: 'connecting', updateBlocked: false }

export function createLiveStore(status: LiveStatus): LiveStore {
  let state: LiveState = { status, updateBlocked: false }
  const listeners = new Set<() => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    snapshot: () => state,
    set(change) {
      const next = { ...state, ...change }
      if (next.status === state.status && next.updateBlocked === state.updateBlocked) return
      state = next
      for (const listener of [...listeners]) listener()
    },
  }
}

export function useLiveStatus(source: LiveSource): LiveState {
  return useSyncExternalStore(source.subscribe, source.snapshot, source.snapshot)
}

// What to announce when the state changes, once a change (X11): going stalled says
// "Reconnecting…", the first welcome after it "Connected again.", and a held-back reload that it
// has been updated. Nothing else is spoken: a drop shorter than 30 s says nothing at all.
export function liveAnnouncement(before: LiveState, after: LiveState): string | undefined {
  if (after.updateBlocked && !before.updateBlocked) return LIVE.updated
  if (after.status === 'stalled' && before.status !== 'stalled') return LIVE.reconnecting
  if (after.status === 'live' && before.status === 'stalled') return LIVE.connectedAgain
  return undefined
}
