// The app's places and where each is reached from (T21; PRD §6.1, OD-02, OD-30, R-32, R-36). On a
// phone the tab bar holds Today, Chats, Rooms, Tasks and More, and More lists Calendar and Drive; from
// the rail breakpoint (48rem wide and 30rem tall, app.css) the rail holds Today, Chats, Rooms, Tasks,
// Calendar and Drive, and More isn't needed. Every entry is a real route (router/router.tsx), so a
// tab is a link with a URL, and Back and Forward move between them (X12).
//
// There is no AI, Ask, assistant or agent entry, ever (R-36, Principle 3): agents are teammates who
// appear where people do, and the AI stages fill slots on existing screens (flags/ai-slots.tsx).
import { Calendar, CheckSquare, HardDrive, Home, LayoutGrid, type LucideIcon, MessageCircle, Mic } from 'lucide-react'
import type { AppPath } from '@/router/paths.ts'
import { SHELL } from '@/strings/shell.ts'

export type NavId = 'today' | 'chats' | 'rooms' | 'tasks' | 'calendar' | 'drive' | 'more'

export interface NavEntry {
  readonly id: NavId
  readonly label: string
  readonly to: AppPath
  readonly icon: LucideIcon
}

export const NAV: Readonly<Record<NavId, NavEntry>> = {
  today: { id: 'today', label: SHELL.nav.today, to: '/today', icon: Home },
  chats: { id: 'chats', label: SHELL.nav.chats, to: '/chats', icon: MessageCircle },
  rooms: { id: 'rooms', label: SHELL.nav.rooms, to: '/rooms', icon: Mic },
  tasks: { id: 'tasks', label: SHELL.nav.tasks, to: '/tasks', icon: CheckSquare },
  calendar: { id: 'calendar', label: SHELL.nav.calendar, to: '/calendar', icon: Calendar },
  drive: { id: 'drive', label: SHELL.nav.drive, to: '/drive', icon: HardDrive },
  more: { id: 'more', label: SHELL.nav.more, to: '/more', icon: LayoutGrid },
}

// The phone's tab bar, in order (PRD §6.1).
export const TABS: readonly NavEntry[] = [NAV.today, NAV.chats, NAV.rooms, NAV.tasks, NAV.more]

// The rail, in order: the four tabs, then what More holds on a phone.
export const RAIL: readonly NavEntry[] = [NAV.today, NAV.chats, NAV.rooms, NAV.tasks, NAV.calendar, NAV.drive]

// What the More page lists.
export const MORE_ENTRIES: readonly NavEntry[] = [NAV.calendar, NAV.drive]

export type NavLayout = 'phone' | 'rail'

// The entry a path marks current in one layout, or none. On a phone Calendar and Drive sit under
// More, so they mark More; the rail has its own entries for them and none for More. A path the app
// doesn't register (a not-found page) marks nothing, so no tab claims a page that isn't its own.
export function activeTab(pathname: string, layout: NavLayout): NavId | undefined {
  const path = samePlace(pathname)
  const entries = layout === 'phone' ? TABS : RAIL
  const own = entries.find(entry => entry.to === path)
  if (own) return own.id
  if (layout === 'phone' && MORE_ENTRIES.some(entry => entry.to === path)) return 'more'
  return undefined
}

// How an entry is current for a path, as its aria-current: "page" when the path is the entry's own,
// "true" when the entry is current as the section that holds the page (More on a phone, for Calendar
// and Drive), so no link claims to be a page it doesn't go to; else it isn't current.
export type NavCurrent = 'page' | 'true'

export function currentOf(entry: NavEntry, pathname: string, layout: NavLayout): NavCurrent | undefined {
  if (activeTab(pathname, layout) !== entry.id) return undefined
  return entry.to === samePlace(pathname) ? 'page' : 'true'
}

// A trailing slash is the same place, as the router reads it.
function samePlace(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
}
