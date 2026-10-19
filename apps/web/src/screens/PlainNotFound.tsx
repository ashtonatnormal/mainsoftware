// The router's backstop for a page that isn't there (T21; OD-42, R-37). Every unknown path reaches
// the splat route inside the shell first (router/router.tsx), so this shows only for a notFound()
// thrown outside it, which nothing in C0.8 throws. It needs no session runtime and no shell: its
// own <main>, one h1, and a link to Chats (which sends a signed-out visitor to sign-in).
import { Link } from '@tanstack/react-router'
import { SHELL } from '@/strings/shell.ts'
import { buttonClass } from '@/ui/Button.tsx'
import { PlainScreen } from './PlainScreen.tsx'

export function PlainNotFound() {
  return (
    <PlainScreen title={SHELL.notFound.title}>
      <p className="text-muted">{SHELL.notFound.body}</p>
      <Link to="/chats" activeOptions={{ exact: true }} activeProps={{}} className={buttonClass('primary')}>
        {SHELL.notFound.toChats}
      </Link>
    </PlainScreen>
  )
}
