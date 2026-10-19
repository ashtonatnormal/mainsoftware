// The app's start (T21, D-01, D-02). main.ts loads this module by its one dynamic import, after
// preBoot() has removed the router's scroll cache, so React, Query, zod and the router evaluate
// only now. It asks who the document belongs to and starts that person's session runtime.
//
// C0.8 S10 adds the rest: the router with the shell and screens, rendered into #root with React's
// error hooks, and the boot error screen in place of the plain text below.
//
// zod-jitless.ts comes first, before anything that loads @hearth/shared or builds a schema: zod reads
// the flag when a schema is built, and without it every page load would trip the CSP once.
import '@/app/zod-jitless.ts'
import { loadSession } from '@/boot/load-session.ts'
import { openIdentityChannel, takeLeftReason } from '@/session/document.ts'
import { browserEnv, type RuntimeEnv, startSessionRuntime } from '@/session/runtime.ts'
import { BOOT } from '@/strings/boot.ts'

// What boot() works with: the browser's own, unless a test passes its own.
export interface BootDeps {
  readonly env: RuntimeEnv
  // #root, where the boot's plain text goes.
  readonly root: Pick<HTMLElement, 'textContent'> | null
}

const browserDeps = (): BootDeps => ({ env: browserEnv(), root: document.getElementById('root') })

// Says so in #root, as plain text: the screen the boot can't get past.
function cantReach(root: BootDeps['root']): void {
  if (root) root.textContent = BOOT.cantReach
}

// A signed-out document's answer to another tab's identity message (D-01). A sign-in there changes
// whom the cookie names, so this document asks GET /api/session again and reloads when it names a
// person. A sign-out there, or its session ending, changes nothing here, so a sign-in step in
// progress keeps its place (AUTH-DESIGN §10.1) and its code isn't spent. A message that arrives
// while a check is in flight makes one more check after it, so a sign-in that lands meanwhile
// isn't missed.
function followSignIn(env: RuntimeEnv): void {
  let checking = false
  let again = false
  let reloaded = false
  const check = async (): Promise<void> => {
    if (reloaded) return
    if (checking) {
      again = true
      return
    }
    checking = true
    try {
      do {
        again = false
        if ((await loadSession()).kind === 'signed_in') {
          reloaded = true
          env.location.reload()
          return
        }
      } while (again)
    } finally {
      checking = false
    }
  }
  openIdentityChannel(env, () => void check())
}

export async function boot(deps: BootDeps = browserDeps()): Promise<void> {
  try {
    const state = await loadSession()
    if (state.kind === 'unavailable') return cantReach(deps.root)
    if (state.kind === 'signed_in') {
      // Why an earlier document left is for the sign-in screen alone; a signed-in document drops
      // it, so it can't be shown later for a session it doesn't describe.
      takeLeftReason(deps.env.storage)
      startSessionRuntime(state.session, deps.env)
      return
    }
    followSignIn(deps.env)
  } catch (error) {
    console.error(error)
    cantReach(deps.root)
  }
}
