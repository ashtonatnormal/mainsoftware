// When only a new sign-in mends the session (C0.9 PD-26; T20 item 6): the reason, and Sign out,
// which is the avatar menu's own (shell/avatar-menu.ts), so it ends the document the same way.
import { useNavigate } from '@tanstack/react-router'
import { useRuntime } from '@/app/runtime-context.ts'
import { signOutItem } from '@/shell/avatar-menu.ts'
import { DPO } from '@/strings/dpo.ts'
import { Button } from '@/ui/Button.tsx'

export function SignOutNotice({ text }: { text: string }) {
  const runtime = useRuntime()
  const navigate = useNavigate()
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <p>{text}</p>
      <Button
        variant="primary"
        className="self-start"
        onClick={() => void signOutItem.run({ runtime, navigate: to => void navigate({ to }) })}
      >
        {DPO.reauth.signOut}
      </Button>
    </section>
  )
}
