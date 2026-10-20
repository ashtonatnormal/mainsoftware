// A screen that failed (T21 item 5, X11): the router's error component for every route. Inside the
// shell the screen keeps its h1 (the route's title, so the person still knows where they are) and
// its navigation, says what happened in an h2, and announces it (the h1 that focus lands on names
// only the place). Two ways on: Try again, and Go to Chats. Try again reloads the page when the
// screen's code failed to load, since this document can't fetch it again, and otherwise loads the
// route again (error-screen-model.ts says why). Above the shell (the shell's own chunk failed, say)
// it brings its own <main> and h1. It is imported statically by the router, never lazily, so it
// renders even when the network is what failed.
import { type ErrorComponentProps, Link, useRouter } from '@tanstack/react-router'
import { use, useEffect } from 'react'
import { InShell } from '@/shell/in-shell.ts'
import { SHELL } from '@/strings/shell.ts'
import { announce } from '@/ui/announce.ts'
import { Button, buttonClass } from '@/ui/Button.tsx'
import { Page } from '@/ui/Page.tsx'
import { failureAnnouncement, retryFor } from './error-screen-model.ts'
import { PlainScreen } from './PlainScreen.tsx'

export function ErrorScreen({ error }: ErrorComponentProps) {
  const router = useRouter()
  const inShell = use(InShell)
  useEffect(() => {
    const said = failureAnnouncement(inShell)
    if (said) announce(said.text, said.politeness)
  }, [inShell])
  const retry = () => {
    if (retryFor(error) === 'reload') window.location.reload()
    else void router.invalidate()
  }
  const actions = (
    <>
      <p className="text-muted">{SHELL.error.body}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="primary" onClick={retry}>
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
