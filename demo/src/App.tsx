import { useState, type ComponentType } from 'react'
import { BarChart3, Calendar, CheckSquare, FileText, Flame, Home, LayoutGrid, MessageCircle, Mic, Search, Settings, Sparkles } from 'lucide-react'
import { StoreProvider, useStore } from './store'
import type { Route, RouteName } from './types'
import { ME, ORG_NAME } from './data/people'
import { Avatar, cx, RecordingIndicator, Sheet, UnreadBadge } from './ui'
import TodayScreen from './screens/Today'
import ChatsScreen from './screens/Chats'
import RoomsScreen from './screens/Rooms'
import SessionScreen from './screens/Session'
import TasksScreen from './screens/Tasks'
import CalendarScreen from './screens/Calendar'
import DocsScreen from './screens/Docs'
import InsightsScreen from './screens/Insights'
import AskScreen from './screens/Ask'
import SettingsScreen from './screens/Settings'
import OnboardingScreen from './screens/Onboarding'

const screens: Record<RouteName, ComponentType> = {
  today: TodayScreen,
  chats: ChatsScreen,
  rooms: RoomsScreen,
  session: SessionScreen,
  tasks: TasksScreen,
  calendar: CalendarScreen,
  docs: DocsScreen,
  insights: InsightsScreen,
  ask: AskScreen,
  settings: SettingsScreen,
}

interface NavItem { name: RouteName; label: string; icon: ComponentType<{ size?: number; className?: string }>; route: Route }
const mainNav: NavItem[] = [
  { name: 'today', label: 'Today', icon: Home, route: { name: 'today' } },
  { name: 'chats', label: 'Chats', icon: MessageCircle, route: { name: 'chats' } },
  { name: 'rooms', label: 'Rooms', icon: Mic, route: { name: 'rooms' } },
  { name: 'tasks', label: 'Tasks', icon: CheckSquare, route: { name: 'tasks' } },
]
const moreNav: NavItem[] = [
  { name: 'calendar', label: 'Calendar', icon: Calendar, route: { name: 'calendar' } },
  { name: 'docs', label: 'Docs', icon: FileText, route: { name: 'docs' } },
  { name: 'insights', label: 'People insights', icon: BarChart3, route: { name: 'insights' } },
  { name: 'ask', label: 'Ask', icon: Sparkles, route: { name: 'ask' } },
  { name: 'settings', label: 'Settings', icon: Settings, route: { name: 'settings' } },
]

/** Detail views take over the whole phone screen (no top bar or tabs). */
function isImmersive(r: Route) {
  return (r.name === 'chats' && !!r.conversationId) || (r.name === 'rooms' && !!r.roomId) || r.name === 'session' || (r.name === 'docs' && !!r.docId) || (r.name === 'calendar' && !!r.eventId)
}

function useBadges() {
  const { state } = useStore()
  const unread = state.conversations.reduce((n, c) => n + (c.muted ? 0 : c.unread), 0)
  const live = state.rooms.filter(r => r.participants.length >= 2).length
  return { chats: unread, rooms: live, tasks: state.suggested.length, today: state.actionables.length } as Partial<Record<RouteName, number>>
}

function Rail() {
  const { state, navigate } = useStore()
  const badges = useBadges()
  const item = (n: NavItem) => {
    const active = state.route.name === n.name || (n.name === 'rooms' && state.route.name === 'session')
    return (
      <button
        key={n.name}
        onClick={() => navigate(n.route)}
        aria-current={active ? 'page' : undefined}
        className={cx('group relative flex w-16 flex-col items-center gap-1 rounded-2xl py-2 text-[11px] font-medium transition', active ? 'text-accent-ink' : 'text-muted hover:text-fg')}
      >
        <span className={cx('grid h-8 w-12 place-items-center rounded-full transition', active ? 'bg-accent-soft' : 'group-hover:bg-surface-2')}>
          <n.icon size={20} />
        </span>
        {n.label === 'People insights' ? 'Insights' : n.label}
        {!!badges[n.name] && <span className="absolute top-0.5 right-2"><UnreadBadge count={badges[n.name]!} muted={n.name === 'rooms'} /></span>}
      </button>
    )
  }
  return (
    <nav className="hidden w-20 shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-3 md:flex" aria-label="Main">
      <div className="mb-3 grid size-10 place-items-center rounded-2xl bg-accent text-accent-fg" title={`Hearth · ${ORG_NAME}`}>
        <Flame size={22} />
      </div>
      {[...mainNav, ...moreNav.filter(n => n.name !== 'settings' && n.name !== 'ask')].map(item)}
      <div className="flex-1" />
      <button onClick={() => navigate({ name: 'settings' })} aria-label="Profile and settings" className="rounded-full p-1 hover:bg-surface-2">
        <Avatar id={ME} size="md" status />
      </button>
    </nav>
  )
}

function TopBar({ immersive }: { immersive: boolean }) {
  const { state, navigate } = useStore()
  const [q, setQ] = useState('')
  const title = [...mainNav, ...moreNav].find(n => n.name === state.route.name)?.label ?? 'Hearth'
  return (
    <header className={cx('items-center gap-3 border-b border-line bg-surface px-3 py-2 md:flex md:px-5', immersive ? 'hidden' : 'flex')}>
      <div className="flex min-w-0 items-center gap-2 md:hidden">
        <span className="grid size-8 place-items-center rounded-xl bg-accent text-accent-fg"><Flame size={18} /></span>
        <span className="truncate font-display text-xl font-semibold">{title}</span>
      </div>
      <form
        className="hidden min-w-0 flex-1 md:block"
        onSubmit={e => {
          e.preventDefault()
          navigate({ name: 'ask', q: q.trim() || undefined })
          setQ('')
        }}
      >
        <label htmlFor="global-ask" className="sr-only">Search or ask</label>
        <div className="flex h-10 max-w-xl items-center gap-2 rounded-full bg-surface-2 px-4 text-muted focus-within:ring-2 focus-within:ring-accent">
          <Search size={16} />
          <input id="global-ask" value={q} onChange={e => setQ(e.target.value)} placeholder="Search or ask anything at Tembusu…" className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-muted" />
          <span className="hidden items-center gap-1 text-[11px] lg:flex"><Sparkles size={12} className="text-agent" /> Ask</span>
        </div>
      </form>
      <div className="ml-auto flex items-center gap-1 md:hidden">
        <button onClick={() => navigate({ name: 'ask' })} aria-label="Search or ask" className="grid size-10 place-items-center rounded-full hover:bg-surface-2"><Search size={20} /></button>
        <button onClick={() => navigate({ name: 'settings' })} aria-label="Profile and settings" className="rounded-full p-1"><Avatar id={ME} size="sm" status /></button>
      </div>
      <div className="hidden text-xs text-muted md:block">{ORG_NAME}</div>
    </header>
  )
}

function TabBar({ hidden }: { hidden: boolean }) {
  const { state, navigate } = useStore()
  const badges = useBadges()
  const [more, setMore] = useState(false)
  const moreActive = moreNav.some(n => n.name === state.route.name)
  if (hidden) return null
  const tab = (n: NavItem) => {
    const active = state.route.name === n.name
    return (
      <button key={n.name} onClick={() => navigate(n.route)} aria-current={active ? 'page' : undefined} className={cx('relative flex flex-1 flex-col items-center gap-0.5 pt-2 pb-1.5 text-[11px] font-medium', active ? 'text-accent-ink' : 'text-muted')}>
        <span className={cx('grid h-7 w-12 place-items-center rounded-full', active && 'bg-accent-soft')}><n.icon size={20} /></span>
        {n.label}
        {!!badges[n.name] && <span className="absolute top-1 left-1/2 ml-2"><UnreadBadge count={badges[n.name]!} muted={n.name === 'rooms'} /></span>}
      </button>
    )
  }
  return (
    <>
      <nav className="flex border-t border-line bg-surface md:hidden" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }} aria-label="Main">
        {mainNav.map(tab)}
        <button onClick={() => setMore(true)} className={cx('flex flex-1 flex-col items-center gap-0.5 pt-2 pb-1.5 text-[11px] font-medium', moreActive ? 'text-accent-ink' : 'text-muted')}>
          <span className={cx('grid h-7 w-12 place-items-center rounded-full', moreActive && 'bg-accent-soft')}><LayoutGrid size={20} /></span>
          More
        </button>
      </nav>
      <Sheet open={more} onClose={() => setMore(false)} title="More">
        <div className="grid grid-cols-3 gap-3 pb-2">
          {moreNav.map(n => (
            <button key={n.name} onClick={() => { setMore(false); navigate(n.route) }} className="flex flex-col items-center gap-2 rounded-2xl bg-surface-2 px-2 py-4 text-sm font-medium">
              <n.icon size={22} className={n.name === 'ask' ? 'text-agent' : 'text-accent-ink'} />
              {n.label}
            </button>
          ))}
        </div>
      </Sheet>
    </>
  )
}

/** While you're in a room, a slim banner (like a phone's call bar) keeps you connected from anywhere.
    It sits in the layout flow, so it never covers a composer or the last item in a list. */
function InRoomBar() {
  const { state, navigate, leaveRoom } = useStore()
  const room = state.rooms.find(r => r.id === state.myRoomId)
  if (!room || (state.route.name === 'rooms' && state.route.roomId === room.id)) return null
  return (
    <div className="flex items-center gap-2 bg-fg px-3 py-1.5 text-bg sm:px-5">
      <button onClick={() => navigate({ name: 'rooms', roomId: room.id })} className="flex min-w-0 flex-1 items-center gap-2 text-left text-[13px] font-medium">
        <span className="size-2 shrink-0 rounded-full bg-rec anim-pulse" aria-hidden />
        <span className="truncate">{room.name} · {room.participants.length} in room · recording</span>
        <span className="ml-auto shrink-0 font-semibold text-accent">Return</span>
      </button>
      <button onClick={leaveRoom} className="shrink-0 rounded-full bg-rec px-3 py-1 text-xs font-semibold text-white">Leave</button>
    </div>
  )
}

function Toasts() {
  const { state, navigate, dismissToast } = useStore()
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
      {state.toasts.map(t => (
        <div key={t.id} className="anim-in pointer-events-auto flex max-w-md items-center gap-3 rounded-2xl bg-fg px-4 py-2.5 text-sm text-bg shadow-card">
          <span className="min-w-0 flex-1">{t.text}</span>
          {t.action && (
            <button className="shrink-0 font-semibold text-accent" onClick={() => { navigate(t.action!.route); dismissToast(t.id) }}>
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

function Shell() {
  const { state } = useStore()
  if (!state.onboarded) return <OnboardingScreen />
  const immersive = isImmersive(state.route)
  const Screen = screens[state.route.name]
  return (
    <div className="flex h-full bg-bg text-fg">
      <Rail />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar immersive={immersive} />
        <InRoomBar />
        <main className="relative min-h-0 flex-1 overflow-hidden">
          <Screen />
        </main>
        <TabBar hidden={immersive} />
      </div>
      <Toasts />
      <span className="sr-only">{state.myRoomId && <RecordingIndicator />}</span>
    </div>
  )
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  )
}
