// The rail (OD-02, T21 item 5, D-08): from 48rem wide and 30rem tall it replaces the tab bar, down
// the left edge, with the Hearth mark, the "Main" navigation (Today, Chats, Rooms, Tasks, Calendar,
// Drive) and the avatar menu in its foot. Below that size it is display: none.
//
// Only the <nav> scrolls, so a short window (a tablet on its side, 480 px tall) still reaches every
// entry, and the foot never scrolls away. Neither the <header> nor the frame clips: the avatar menu
// opens upward from the foot and lies over the screen, wider than the rail (the Menu contract,
// ui/Menu.tsx).
import { useLocation } from '@tanstack/react-router'
import { Flame } from 'lucide-react'
import { SHELL } from '@/strings/shell.ts'
import { AvatarMenu } from './AvatarMenu.tsx'
import { NavLink } from './NavLink.tsx'
import { currentOf, RAIL } from './nav.ts'

export function Rail() {
  const pathname = useLocation({ select: location => location.pathname })
  return (
    <header className="hidden min-h-0 w-[calc(5rem+env(safe-area-inset-left,0px))] shrink-0 flex-col items-center border-r border-line bg-surface pt-safe pb-safe pl-safe rail:flex">
      <span
        aria-hidden
        className="mt-3 mb-2 grid size-10 shrink-0 place-items-center rounded-2xl bg-accent text-accent-fg"
      >
        <Flame size={22} />
      </span>
      <nav aria-label={SHELL.mainNav} className="min-h-0 w-full flex-1 overflow-y-auto">
        <ul className="flex flex-col items-center gap-1 py-1">
          {RAIL.map(entry => (
            <li key={entry.id}>
              <NavLink entry={entry} current={currentOf(entry, pathname, 'rail')} layout="rail" />
            </li>
          ))}
        </ul>
      </nav>
      <div className="relative shrink-0 py-3">
        <AvatarMenu placement="top-start" />
      </div>
    </header>
  )
}
