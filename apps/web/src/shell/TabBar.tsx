// The phone's tab bar (T21; PRD §6.1, PRD-66, OD-02, D-08): Today, Chats, Rooms, Tasks and More,
// five equal cells at the bottom of the frame, in the thumb's reach, padded clear of the home
// indicator. It is the "Main" navigation below the rail breakpoint (48rem wide and 30rem tall, so a
// phone on its side keeps it), and display: none from there, which takes it out of the tab order
// and the accessibility tree while the rail's own "Main" shows.
import { useLocation } from '@tanstack/react-router'
import { SHELL } from '@/strings/shell.ts'
import { NavLink } from './NavLink.tsx'
import { currentOf, TABS } from './nav.ts'

export function TabBar() {
  const pathname = useLocation({ select: location => location.pathname })
  return (
    <nav aria-label={SHELL.mainNav} className="border-t border-line bg-surface pb-safe px-safe rail:hidden">
      <ul className="grid grid-cols-5">
        {TABS.map(entry => (
          <li key={entry.id} className="flex min-w-0">
            <NavLink entry={entry} current={currentOf(entry, pathname, 'phone')} layout="phone" />
          </li>
        ))}
      </ul>
    </nav>
  )
}
