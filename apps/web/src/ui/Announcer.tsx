// The two visually hidden live regions announce() speaks through (T21; X11). Mounted once, in the
// app's root, from the first render, so each region exists before any text arrives (a region
// added with its text already in it is often not read).
import { useSyncExternalStore } from 'react'
import { announcer } from './announce.ts'

export function Announcer() {
  const state = useSyncExternalStore(announcer.subscribe, announcer.snapshot, announcer.snapshot)
  return (
    <>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {state.polite}
      </div>
      <div className="sr-only" aria-live="assertive" aria-atomic="true">
        {state.assertive}
      </div>
    </>
  )
}
