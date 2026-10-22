// What the avatar menu holds (T21; OD-05): a registry, so each later step adds its own entry here
// and the menu itself never changes (C0.9's notice, C0.14 to C0.18's devices, notifications and
// settings, A4's assistant settings). It holds, in order:
// - Data protection (C0.9 PD-26, OD-03): the DPO's registers, shown only when the session answer's
//   capabilities say can() allows reading them (registers). Hiding it is a courtesy, never the
//   check: the pages' every request is decided by the server, which refuses anyone else;
// - Sign out.
//
// Sign out asks the session runtime to sign out (session/runtime.ts): a 2xx or a 401 ends the
// document, and the next one is the sign-in screen with "You've signed out." When no answer comes
// back (offline, a 5xx), the session and this document stay as they were, and an error toast says
// so; it stays until it is closed (X5), and focus is back on the menu's button already.
import type { SessionForClient } from '@hearth/shared'
import { LogOut, type LucideIcon, ShieldCheck } from 'lucide-react'
import type { AppPath } from '@/router/paths.ts'
import type { SessionRuntime } from '@/session/runtime.ts'
import { SHELL } from '@/strings/shell.ts'
import { toast } from '@/ui/toast.ts'

// What an item may act with: the document's session runtime, and the router's way to another app
// path in this document.
export interface AvatarMenuContext {
  readonly runtime: SessionRuntime
  navigate(to: AppPath): void
}

// The session answer as an item reads it. Every field is optional, so an entry the cache holds
// unparsed, or a runtime's info from before a field existed, reads as "not allowed", never a crash.
export type MenuSession = { readonly capabilities?: Partial<SessionForClient['capabilities']> }

export interface AvatarMenuItem {
  readonly id: string
  readonly label: string
  readonly icon: LucideIcon
  // Whether the person sees it; always, when absent.
  shown?(session: MenuSession): boolean
  run(context: AvatarMenuContext): Promise<void>
}

export const dpoItem: AvatarMenuItem = {
  id: 'data-protection',
  label: SHELL.account.dataProtection,
  icon: ShieldCheck,
  // Only a literal true: the lenient session reading gives false for anything else (P6).
  shown: session => session.capabilities?.registers === true,
  async run({ navigate }) {
    navigate('/dpo/purposes')
  },
}

export const signOutItem: AvatarMenuItem = {
  id: 'sign-out',
  label: SHELL.account.signOut,
  icon: LogOut,
  async run({ runtime }) {
    if ((await runtime.signOut()) === 'failed') toast({ tone: 'error', text: SHELL.account.signOutFailed })
  },
}

export const AVATAR_MENU: readonly AvatarMenuItem[] = [dpoItem, signOutItem]

// The items this person sees, in the registry's order.
export function menuItemsFor(session: MenuSession): AvatarMenuItem[] {
  return AVATAR_MENU.filter(item => item.shown?.(session) ?? true)
}
