// What the page shows when it can't start (T21 item 5, D-01): the boot couldn't learn who the page
// belongs to (GET /api/session failed or didn't answer), or the app failed above every screen. It
// renders with no router, no shell and no session runtime, never guessing who is signed in, and its
// one way on reloads the page, which asks again from the start.
import { SHELL } from '@/strings/shell.ts'
import { Button } from '@/ui/Button.tsx'
import { PlainScreen } from './PlainScreen.tsx'

export interface BootErrorScreenProps {
  // unavailable: the session check failed. crashed: the app failed while rendering.
  kind?: 'unavailable' | 'crashed'
  // The page's own reload unless a test passes one.
  reload?: () => void
}

const reloadPage = () => window.location.reload()

export function BootErrorScreen({ kind = 'unavailable', reload = reloadPage }: BootErrorScreenProps) {
  const copy =
    kind === 'unavailable'
      ? { title: SHELL.bootError.title, body: SHELL.bootError.body, action: SHELL.bootError.retry }
      : { title: SHELL.crashed.title, body: SHELL.crashed.body, action: SHELL.crashed.reload }
  return (
    <PlainScreen title={copy.title}>
      <p className="text-muted">{copy.body}</p>
      <Button variant="primary" onClick={reload}>
        {copy.action}
      </Button>
    </PlainScreen>
  )
}
