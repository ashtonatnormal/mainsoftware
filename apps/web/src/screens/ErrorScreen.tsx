// A screen that failed (T21; OD-42): the router's error component for every route. Inside the shell
// the screen keeps its h1 (the route's title, so the person still knows where they are) and its
// navigation, and this says what happened in an h2 with two ways on: Try again, which loads the
// route again (a chunk that failed to load is fetched anew), and Go to Chats. Above the shell (the
// shell's own chunk failed, say) it brings its own <main> and h1. It is imported statically by the
// router, never lazily, so it renders even when the network is what failed.
import { type ErrorComponentProps, Link, useRouter } from '@tanstack/react-router'
import { use } from 'react'
import { InShell } from '@/shell/in-shell.ts'
import { SHELL } from '@/strings/shell.ts'
import { Button, buttonClass } from '@/ui/Button.tsx'
import { Page } from '@/ui/Page.tsx'
import { PlainScreen } from './PlainScreen.tsx'

export function ErrorScreen(_props: ErrorComponentProps) {
  const router = useRouter()
  const inShell = use(InShell)
  const actions = (
    <>
      <p className="text-muted">{SHELL.error.body}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="primary" onClick={() => void router.invalidate()}>
          {SHELL.error.retry}
        </Button>
        <Link to="/chats" activeOptions={{ exact: true }} activeProps={{}} className={buttonClass('secondary')}>
          {SHELL.error.toChats}
        </Link>
      </div>
    </>
  )
  if (!inShell) return <PlainScreen title={SHELL.error.title}>{actions}</PlainScreen>
  return (
    <Page>
      <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
        <h2 className="font-display text-lg font-semibold">{SHELL.error.title}</h2>
        {actions}
      </div>
    </Page>
  )
}
