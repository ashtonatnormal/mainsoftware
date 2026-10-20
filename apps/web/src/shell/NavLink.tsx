// One entry of the tab bar or the rail (T21; OD-02, X7, QA-05, WCAG 1.4.1). A router link, so each
// place has a real URL (X12). The icon is decoration and the visible label is the link's name. The
// current entry is marked three ways, never by colour alone: aria-current, a pill behind the icon
// (accent-soft) and a heavier label in accent-ink, plus an outline under forced colours (app.css).
// aria-current is "page" only on the link to the page shown, and "true" on More while it holds the
// page (nav.ts, currentOf). The focus ring sits inside the cell (QA-05), so a neighbour or the
// screen edge never hides it. Labels wrap at large text sizes, and the bar grows with them; the
// pill behind the icon, sized in rem, never grows past its cell, so 200 % text scrolls nothing
// sideways (WCAG 1.4.4, nfr02.spec.ts NF-09).
//
// Which entry is current is nav.ts's decision (activeTab, currentOf), not the router's own: on a
// phone, Calendar and Drive mark More. The router's own active state is kept to an exact match, so
// it never marks an entry activeTab doesn't.
import { Link } from '@tanstack/react-router'
import { cx } from '@/ui/cx.ts'
import type { NavCurrent, NavEntry, NavLayout } from './nav.ts'

export interface NavLinkProps {
  entry: NavEntry
  current: NavCurrent | undefined
  layout: NavLayout
}

export function NavLink({ entry, current, layout }: NavLinkProps) {
  const Icon = entry.icon
  return (
    <Link
      to={entry.to}
      activeOptions={{ exact: true }}
      activeProps={{}}
      aria-current={current}
      className={cx(
        'group flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-center text-xs focus-visible:-outline-offset-2',
        layout === 'rail' ? 'w-16 rounded-2xl' : 'w-full',
        current ? 'font-semibold text-accent-ink' : 'font-medium text-muted hover:text-fg',
      )}
    >
      <span
        aria-hidden
        className={cx(
          'grid h-7 w-12 max-w-full shrink-0 place-items-center rounded-full transition',
          current ? 'bg-accent-soft' : 'group-hover:bg-surface-2',
        )}
      >
        <Icon size={24} />
      </span>
      <span className="max-w-full break-words">{entry.label}</span>
    </Link>
  )
}
