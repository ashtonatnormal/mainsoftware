// /settings (C0.9 PD-47): the registry's sections (settings/sections.ts), each a link to its own
// page with its title and one line on what it holds, drawn as the More page's rows are: 56 px tall,
// the icon and the chevron decoration only. The h1 is the shell's (the route's title).
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { SETTINGS } from '@/strings/notice.ts'
import { Page } from '@/ui/Page.tsx'
import { SETTINGS_SECTIONS, type SettingsSection } from './sections.ts'

export function SettingsScreen({ sections = SETTINGS_SECTIONS }: { sections?: readonly SettingsSection[] }) {
  return (
    <Page>
      <nav aria-label={SETTINGS.sections.label}>
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {sections.map(section => {
            const Icon = section.icon
            return (
              <li key={section.id}>
                <Link
                  to={section.path}
                  className="flex min-h-14 items-center gap-3 px-4 py-3 hover:bg-bg focus-visible:-outline-offset-2"
                >
                  <Icon aria-hidden size={22} className="shrink-0 text-accent" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="break-words font-medium">{section.title}</span>
                    <span className="break-words text-small text-muted">{section.summary}</span>
                  </span>
                  <ChevronRight aria-hidden size={18} className="shrink-0 text-muted" />
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>
    </Page>
  )
}
