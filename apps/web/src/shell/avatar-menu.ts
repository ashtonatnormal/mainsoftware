// What the avatar menu holds (T21; OD-05): a registry, so each later step adds its own entry here
// and the menu itself never changes (C0.9's notice, C0.14 to C0.18's devices, notifications and
// settings, A4's assistant settings). In C0.8 it holds Sign out alone.
//
// Sign out asks the session runtime to sign out (session/runtime.ts): a 2xx or a 401 ends the
// document, and the next one is the sign-in screen with "You've signed out." When no answer comes
// back (offline, a 5xx), the session and this document stay as they were, and an error toast says
// so; it stays until it is closed (X5), and focus is back on the menu's button already.
import { LogOut, type LucideIcon } from 'lucide-react'
import type { SessionRuntime } from '@/session/runtime.ts'
import { SHELL } from '@/strings/shell.ts'
import { toast } from '@/ui/toast.ts'

export interface AvatarMenuItem {
  readonly id: string
  readonly label: string
  readonly icon: LucideIcon
  run(runtime: SessionRuntime): Promise<void>
}

export const signOutItem: AvatarMenuItem = {
  id: 'sign-out',
  label: SHELL.account.signOut,
  icon: LogOut,
  async run(runtime) {
    if ((await runtime.signOut()) === 'failed') toast({ tone: 'error', text: SHELL.account.signOutFailed })
  },
}

export const AVATAR_MENU: readonly AvatarMenuItem[] = [signOutItem]
