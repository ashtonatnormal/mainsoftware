// Settings' sections (PDPA-02 "always available in Settings", PRD:148; C0.9 PD-47): a registry, so
// each later step adds its own section here and /settings lists it with no other change (C0.14's
// notifications, C0.16's devices and more, A4's assistant settings). Each section is a page of its
// own under /settings (router/router.tsx registers it, and APP_PATHS lists its path). It holds:
// - Privacy (C0.9): the privacy notice and your own acknowledgements of it. C0.9 PR 3 adds the
//   Data Protection Officer's contact and the requests form there.
import type { LucideIcon } from 'lucide-react'
import { ShieldCheck } from 'lucide-react'
import type { AppPath } from '@/router/paths.ts'
import { SETTINGS } from '@/strings/notice.ts'
import { SHELL } from '@/strings/shell.ts'

export interface SettingsSection {
  readonly id: string
  // The section's page, and its title there (the route's, strings/shell.ts).
  readonly path: AppPath
  readonly title: string
  // One line under the title on /settings.
  readonly summary: string
  readonly icon: LucideIcon
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: 'privacy',
    path: '/settings/privacy',
    title: SHELL.settings.privacy,
    summary: SETTINGS.sections.privacy,
    icon: ShieldCheck,
  },
]
