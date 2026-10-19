// The app's start (T21, D-01, D-02). main.ts loads this module by its one dynamic import, after
// preBoot() has removed the router's scroll cache, so React, Query, zod and the router evaluate
// only now. It asks who the document belongs to and starts that person's session runtime.
//
// C0.8 S10 adds the rest: the router with the shell and screens, rendered into #root with React's
// error hooks, and the boot error screen in place of the plain text below.
import { loadSession } from '@/boot/load-session.ts'
import { openIdentityChannel, takeLeftReason } from '@/session/document.ts'
import { browserEnv, startSessionRuntime } from '@/session/runtime.ts'
import { BOOT } from '@/strings/boot.ts'

// Says so in #root, as plain text: the screen the boot can't get past.
function cantReach(): void {
  const root = document.getElementById('root')
  if (root) root.textContent = BOOT.cantReach
}

export async function boot(): Promise<void> {
  try {
    const env = browserEnv()
    const state = await loadSession()
    if (state.kind === 'unavailable') return cantReach()
    if (state.kind === 'signed_in') {
      // Why an earlier document left is for the sign-in screen alone; a signed-in document drops
      // it, so it can't be shown later for a session it doesn't describe.
      takeLeftReason(env.storage)
      startSessionRuntime(state.session, env)
      return
    }
    // Signed out: when another tab signs in or out, reload, so the new document opens as whoever
    // the cookie now names.
    openIdentityChannel(env, () => env.location.reload())
  } catch (error) {
    console.error(error)
    cantReach()
  }
}
