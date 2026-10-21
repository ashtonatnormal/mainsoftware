// The signed-in document's session runtime, for the screens inside the shell (T21, D-01). The boot
// starts one runtime per document (session/runtime.ts) and App.tsx provides it here; the router's
// _app route lets nobody into the shell without one, so a screen there can always read it. A
// signed-out document provides none, and the sign-in screens never read it.
import { createContext, use } from 'react'
import type { SessionRuntime } from '@/session/runtime.ts'

export const RuntimeContext = createContext<SessionRuntime | null>(null)

export function useRuntime(): SessionRuntime {
  const runtime = use(RuntimeContext)
  if (runtime === null) throw new Error('No session runtime: this screen belongs inside the shell')
  return runtime
}
