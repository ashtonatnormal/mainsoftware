// A page that isn't there, inside the shell (T21; OD-42, R-37). The splat route under the shell
// catches every path no other route matches (/xyz, /chats/abc), so a signed-in person keeps the tab
// bar or rail and the screen's one h1, "Page not found", which the shell takes from the route's
// title. The content says so and offers a way to Chats. Outside the shell (a notFound() thrown above
// it) it renders the plain backstop instead, which brings its own <main> and h1.
import { Link } from '@tanstack/react-router'
import { use } from 'react'
import { InShell } from '@/shell/in-shell.ts'
import { SHELL } from '@/strings/shell.ts'
import { buttonClass } from '@/ui/Button.tsx'
import { Page } from '@/ui/Page.tsx'
import { PlainNotFound } from './PlainNotFound.tsx'

export function NotFoundScreen() {
  if (!use(InShell)) return <PlainNotFound />
  return (
    <Page>
      <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
        <p className="text-muted">{SHELL.notFound.body}</p>
        {/* Active only on /chats itself, so on /chats/abc it doesn't claim to be the current page. */}
        <Link to="/chats" activeOptions={{ exact: true }} activeProps={{}} className={buttonClass('primary')}>
          {SHELL.notFound.toChats}
        </Link>
      </div>
    </Page>
  )
}
