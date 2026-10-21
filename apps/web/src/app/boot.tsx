// The app's start (T21, D-01, D-02). main.ts loads this module by its one dynamic import, after
// preBoot() has removed the router's scroll cache, so React, Query, zod and the router evaluate
// only now. In order:
// 1. ask who the document belongs to (GET /api/session);
// 2. when the api can't say, show the boot error screen alone (no router, no guess) and stop;
// 3. signed in, start that person's session runtime; signed out, follow another tab's sign-in;
// 4. make the router with the runtime (or none) in its context, and load the first route before
//    the first render, so "Loading Hearth…" gives way to the real screen, not a blank one;
// 5. render the app into #root, with React's error hooks logging what it catches (C0.13 adds RUM).
// When anything here throws, #root says "Can't reach Hearth" in plain text.
//
// zod builds no code from strings here: main.ts's preBoot() set its jitless setting before this
// module, or zod, loaded (boot/pre-boot.ts item 4).
import type { RouterHistory } from '@tanstack/react-router'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@/app/App.tsx'
import { loadSession } from '@/boot/load-session.ts'
import { createAppRouter } from '@/router/router.tsx'
import { BootErrorScreen } from '@/screens/BootErrorScreen.tsx'
import { openIdentityChannel, takeLeftReason } from '@/session/document.ts'
import { browserEnv, type RuntimeEnv, type SessionRuntime, startSessionRuntime } from '@/session/runtime.ts'
import { BOOT } from '@/strings/boot.ts'

// What boot() works with: the browser's own, unless a test passes its own.
export interface BootDeps {
  readonly env: RuntimeEnv
  // #root, where the boot's plain text goes.
  readonly root: Pick<HTMLElement, 'textContent'> | null
  // Renders the app (or the boot error screen) into #root.
  render(element: ReactElement): void
  // The router's history: the browser's own unless a test passes one.
  readonly history?: RouterHistory
}

const logError = (error: unknown) => console.error(error)

function browserDeps(): BootDeps {
  const root = document.getElementById('root')
  return {
    env: browserEnv(),
    root,
    render: element => {
      if (root === null) throw new Error('index.html has no #root')
      createRoot(root, { onCaughtError: logError, onUncaughtError: logError }).render(element)
    },
  }
}

// Says so in #root, as plain text: the screen the boot can't get past.
function cantReach(root: BootDeps['root']): void {
  if (root) root.textContent = BOOT.cantReach
}

// A signed-out document's answer to another tab's identity message (D-01). A sign-in there changes
// whom the cookie names, so this document asks GET /api/session again and reloads when it names a
// person. A sign-out there, or its session ending, changes nothing here, so a sign-in step in
// progress keeps its place (T21 item 13) and its code isn't spent. A message that arrives
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
    if (state.kind === 'unavailable') return deps.render(<BootErrorScreen />)
    let runtime: SessionRuntime | null = null
    if (state.kind === 'signed_in') {
      // Why an earlier document left is for the sign-in screen alone; a signed-in document drops
      // it, so it can't be shown later for a session it doesn't describe.
      takeLeftReason(deps.env.storage)
      runtime = startSessionRuntime(state.session, deps.env)
    } else {
      followSignIn(deps.env)
    }
    const router = createAppRouter({ runtime, storage: deps.env.storage }, deps.history)
    await router.load()
    deps.render(<App router={router} runtime={runtime} />)
  } catch (error) {
    console.error(error)
    cantReach(deps.root)
  }
}
