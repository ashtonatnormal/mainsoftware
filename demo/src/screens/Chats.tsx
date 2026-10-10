// Chats: the WhatsApp-style heart of Hearth (CHAT-01..19). Phones show either
// the list or one open conversation; desktop shows both side by side.
import { MessageCircle, Sparkles } from 'lucide-react'
import { useStore } from '../store'
import { Button, cx } from '../ui'
import { ChatList } from './chats/ChatList'
import { Conversation } from './chats/Conversation'

export default function ChatsScreen() {
  const { state } = useStore()
  const cid = state.route.name === 'chats' ? state.route.conversationId : undefined

  return (
    <div className="flex h-full min-h-0">
      <aside
        aria-label="All chats"
        className={cx('h-full min-h-0 w-full flex-col bg-surface md:flex md:w-[336px] md:shrink-0 md:border-r md:border-line lg:w-[360px]', cid ? 'hidden' : 'flex')}
      >
        <ChatList activeId={cid} />
      </aside>
      <section aria-label="Conversation" className={cx('h-full min-h-0 min-w-0 flex-1 flex-col', cid ? 'flex' : 'hidden md:flex')}>
        {cid ? <Conversation key={cid} id={cid} /> : <Placeholder />}
      </section>
    </div>
  )
}

function Placeholder() {
  const { navigate } = useStore()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-wall px-8 text-center">
      <span className="grid size-16 place-items-center rounded-3xl bg-accent-soft text-accent-ink">
        <MessageCircle size={30} />
      </span>
      <p className="font-display text-xl font-semibold">Pick a chat to start</p>
      <p className="max-w-sm text-sm text-muted">
        Channels, people and agents all live in one list. Drafts stay where you left them, and live rooms show who’s inside.
      </p>
      <Button className="mt-1" icon={<Sparkles size={16} className="text-agent" />} onClick={() => navigate({ name: 'chats', conversationId: 'c_assistant' })}>
        Ask your assistant
      </Button>
    </div>
  )
}
