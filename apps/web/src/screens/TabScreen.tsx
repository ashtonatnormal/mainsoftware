// Each tab's screen in C0.8: an honest empty state (T21; OD-02, decision 8). The screen's h1 is the
// shell's (the route's title); this is its content, an icon and a line that says what is true now,
// with no promise of what comes later and no AI copy. Today and Chats hold the AI slots their
// A-stages fill (flags/ai-slots.tsx), which render nothing until then (D41).
//
// The router loads this module lazily, one named export per route (router/router.tsx). Each step
// that builds a screen (C1 onwards) gives its route its own module and leaves this one smaller.
import { Calendar, CheckSquare, HardDrive, Home, type LucideIcon, MessageCircle, Mic } from 'lucide-react'
import { AiSlot, type AiSlotName } from '@/flags/ai-slots.tsx'
import { SHELL } from '@/strings/shell.ts'
import { EmptyState } from '@/ui/EmptyState.tsx'
import { Page } from '@/ui/Page.tsx'

export type TabScreenId = keyof typeof SHELL.empty

export const TAB_SCREENS: Readonly<
  Record<TabScreenId, { readonly icon: LucideIcon; readonly title: string; readonly slot?: AiSlotName }>
> = {
  today: { icon: Home, title: SHELL.empty.today, slot: 'today.catch_up' },
  chats: { icon: MessageCircle, title: SHELL.empty.chats, slot: 'chats.agents_filter' },
  rooms: { icon: Mic, title: SHELL.empty.rooms },
  tasks: { icon: CheckSquare, title: SHELL.empty.tasks },
  calendar: { icon: Calendar, title: SHELL.empty.calendar },
  drive: { icon: HardDrive, title: SHELL.empty.drive },
}

export function TabScreen({ tab }: { tab: TabScreenId }) {
  const { icon, title, slot } = TAB_SCREENS[tab]
  return (
    <Page>
      {slot !== undefined && <AiSlot name={slot} />}
      <EmptyState icon={icon} title={title} />
    </Page>
  )
}

export const TodayScreen = () => <TabScreen tab="today" />
export const ChatsScreen = () => <TabScreen tab="chats" />
export const RoomsScreen = () => <TabScreen tab="rooms" />
export const TasksScreen = () => <TabScreen tab="tasks" />
export const CalendarScreen = () => <TabScreen tab="calendar" />
export const DriveScreen = () => <TabScreen tab="drive" />
