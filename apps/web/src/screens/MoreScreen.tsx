// More, the phone's fifth tab (T21; OD-02, PRD §6.1): a page, not a sheet, listing what the rail
// shows from 48rem wide and a phone has no room for, Calendar and Drive. Each row is a link 56 px
// tall with its icon and label; the chevron is decoration. On the rail More has no entry, but the
// page still opens at /more.
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { MORE_ENTRIES } from '@/shell/nav.ts'
import { Page } from '@/ui/Page.tsx'

export function MoreScreen() {
  return (
    <Page>
      <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
        {MORE_ENTRIES.map(entry => {
          const Icon = entry.icon
          return (
            <li key={entry.id}>
              <Link
                to={entry.to}
                className="flex min-h-14 items-center gap-3 px-4 py-2 hover:bg-bg focus-visible:-outline-offset-2"
              >
                <Icon aria-hidden size={22} className="shrink-0 text-accent" />
                <span className="min-w-0 flex-1 break-words font-medium">{entry.label}</span>
                <ChevronRight aria-hidden size={18} className="shrink-0 text-muted" />
              </Link>
            </li>
          )
        })}
      </ul>
    </Page>
  )
}
