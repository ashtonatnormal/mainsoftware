// The app's root (T21, D-01): the router, and for a signed-in document the person's QueryClient and
// session runtime around it. A signed-out document has neither, so nothing in it can query the api
// as anyone. The app's one announcer (X11) is mounted from the first render, so its live regions
// exist before anything is said. RootErrorBoundary catches what fails above every screen (the
// router's own error component handles each route): it shows a plain screen with a reload, never a
// blank page.
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { Component, type ReactNode } from 'react'
import type { AppRouter } from '@/router/router.tsx'
import { BootErrorScreen } from '@/screens/BootErrorScreen.tsx'
import type { SessionRuntime } from '@/session/runtime.ts'
import { Announcer } from '@/ui/Announcer.tsx'
import { RuntimeContext } from './runtime-context.ts'

export interface AppProps {
  router: AppRouter
  runtime: SessionRuntime | null
}

export function App({ router, runtime }: AppProps) {
  const routed = <RouterProvider router={router} />
  return (
    <RootErrorBoundary>
      <Announcer />
      {runtime === null ? (
        routed
      ) : (
        <QueryClientProvider client={runtime.queryClient}>
          <RuntimeContext value={runtime}>{routed}</RuntimeContext>
        </QueryClientProvider>
      )}
    </RootErrorBoundary>
  )
}

// React reports what this catches through createRoot's onCaughtError (app/boot.tsx).
export class RootErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override render() {
    return this.state.failed ? <BootErrorScreen kind="crashed" /> : this.props.children
  }
}
