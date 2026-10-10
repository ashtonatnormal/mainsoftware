// Sheets opened from a conversation: conversation info (members, topic, AI
// participation level), a message thread (CHAT-03) and phone message actions.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Copy, Headphones, ListTodo, MessageSquareText, SendHorizontal, Sparkles } from 'lucide-react'
import type { Conversation, Message } from '../../types'
import { useStore } from '../../store'
import { ME, personById } from '../../data/people'
import { AgentBadge, Avatar, Button, cx, Pill, RecordingIndicator, Sheet } from '../../ui'
import { clock, shortDay } from '../../time'
import { participationLevels, quickReactions, type ThreadReply } from './content'
import { ConvAvatar, ConvTitle, counterpart, messageGist, RichText, Section, statusLabel, taskTitleFrom } from './parts'

// ── Conversation info ─────────────────────────────────────────────────────────
export function InfoSheet({ c, open, onClose }: { c: Conversation; open: boolean; onClose: () => void }) {
  const { state, navigate, joinRoom } = useStore()
  const room = c.roomId ? state.rooms.find(r => r.id === c.roomId) : undefined
  const pid = counterpart(c)
  const person = pid ? personById[pid] : undefined
  const members = [...c.members].sort((a, b) => {
    const rank = (id: string) => (id === ME ? 0 : personById[id]?.kind === 'human' ? 1 : 2)
    return rank(a) - rank(b) || (personById[a]?.name ?? '').localeCompare(personById[b]?.name ?? '')
  })
  const level = c.participation ?? 'mention'
  // The room this person is in right now (CHAT-10 presence), if you could join it too.
  const personRoom = person?.kind === 'human' ? state.rooms.find(r => r.participants.includes(person.id)) : undefined
  const canJoin = (roomId: string) => {
    const r = state.rooms.find(x => x.id === roomId)
    const channel = r?.conversationId ? state.conversations.find(x => x.id === r.conversationId) : undefined
    return !!r && (channel ? channel.members.includes(ME) : r.isPublic)
  }
  const enter = (roomId: string) => {
    onClose()
    if (state.myRoomId !== roomId) joinRoom(roomId)
    navigate({ name: 'rooms', roomId })
  }

  return (
    <Sheet open={open} onClose={onClose} title={c.kind === 'channel' ? 'Channel info' : c.kind === 'assistant' ? 'Your assistant' : c.kind === 'group' ? 'Group info' : 'Contact info'}>
      <div className="flex flex-col gap-6 pb-2">
        <div className="flex items-center gap-3">
          <ConvAvatar c={c} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-xl font-semibold">
              <ConvTitle c={c} />
            </p>
            <p className="text-sm text-muted">
              {c.kind === 'channel' ? `${c.private ? 'Private channel · invite only' : 'Public channel'} · ${c.members.length} members` : c.kind === 'group' ? `Group · ${c.members.length} members` : person?.title}
            </p>
          </div>
        </div>

        {c.topic && (
          <Section title="Topic">
            <p className="text-[15px]">{c.topic}</p>
          </Section>
        )}

        {person?.kind === 'human' && (
          <Section title="Status">
            <p className="flex min-w-0 items-center gap-2 text-[15px]">
              <span
                className={cx('size-2.5 shrink-0 rounded-full', person.status === 'online' ? 'bg-ok' : person.status === 'dnd' ? 'bg-rec' : person.status === 'away' ? 'bg-warn' : 'bg-muted')}
                aria-hidden
              />
              <span className="min-w-0">
                {statusLabel[person.status]}
                {person.customStatus && <span className="text-muted"> · {person.customStatus}</span>}
              </span>
            </p>
            {personRoom && (
              <div className="flex items-center gap-3 rounded-2xl bg-surface-2 px-3 py-2.5">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface text-accent-ink"><Headphones size={18} aria-hidden /></span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">In {personRoom.name}</p>
                  {personRoom.participants.length >= 2 && <RecordingIndicator compact label={`Recording · ${personRoom.participants.length} inside`} />}
                </div>
                {canJoin(personRoom.id) && (
                  <Button size="sm" variant="primary" onClick={() => enter(personRoom.id)}>
                    {state.myRoomId === personRoom.id ? 'Open' : 'Join'}
                  </Button>
                )}
              </div>
            )}
          </Section>
        )}

        {person?.kind === 'agent' && (
          <Section title="About this agent">
            <div className="flex flex-wrap items-center gap-2">
              <AgentBadge />
              <span className="text-sm text-muted">{person.team} team · owned by {personById[person.agentOwner ?? '']?.name}</span>
            </div>
            <p className="text-[15px]">{person.title}.</p>
            <p className="text-sm text-muted">It only answers from sources it’s allowed to read, and only with what you could open yourself. It asks before doing anything other than replying.</p>
          </Section>
        )}

        {c.kind === 'assistant' && (
          <Section title="Private to you">
            <p className="text-[15px]">Your assistant reads what you can see, so it can catch you up and answer questions. Nobody else can see this chat.</p>
            <p className="text-[15px]">It only suggests and drafts. It never sends messages, changes tasks or RSVPs for you. Drafts go into your composer for you to edit and send.</p>
            <div>
              <Button size="sm" icon={<Sparkles size={15} />} onClick={() => { onClose(); navigate({ name: 'settings', section: 'memory' }) }}>
                See what it remembers
              </Button>
            </div>
          </Section>
        )}

        {room && (
          <Section title="Voice room">
            <div className="flex items-center gap-3 rounded-2xl bg-surface-2 px-3 py-2.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface text-accent-ink"><Headphones size={18} /></span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{room.name}</p>
                {room.participants.length >= 2 ? (
                  <RecordingIndicator compact label={`Recording · ${room.participants.length} inside`} />
                ) : (
                  <p className="text-xs text-muted">{room.participants.length ? '1 person inside' : 'Nobody inside'} · recorded when 2 or more join</p>
                )}
              </div>
              <Button size="sm" variant="primary" onClick={() => enter(room.id)}>
                {state.myRoomId === room.id ? 'Open' : 'Join'}
              </Button>
            </div>
          </Section>
        )}

        {c.kind === 'channel' && (
          <Section title="AI participation">
            <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
              {participationLevels.map(l => {
                const current = l.value === level
                return (
                  <li key={l.value} className={cx('flex gap-3 px-3 py-2.5', current && 'bg-agent-soft')} aria-current={current ? 'true' : undefined}>
                    <span className={cx('mt-1 grid size-4 shrink-0 place-items-center rounded-full border-2', current ? 'border-agent' : 'border-line')} aria-hidden>
                      {current && <span className="size-2 rounded-full bg-agent" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className={cx('text-sm font-semibold', current ? 'text-agent' : 'text-fg')}>{l.label}</span>
                        {current && <Pill tone="agent">This channel</Pill>}
                      </span>
                      <span className={cx('block text-[13px] leading-snug', current ? 'text-fg' : 'text-muted')}>{l.body}</span>
                    </span>
                  </li>
                )
              })}
            </ul>
            <p className="text-xs text-muted">
              Channel owners set this. An agent never goes above the organisation’s default or its own, and never speaks unprompted in DMs or restricted rooms.
            </p>
          </Section>
        )}

        {(c.kind === 'channel' || c.kind === 'group') && (
          <Section title={`Members · ${c.members.length}`}>
            <ul className="-mx-1">
              {members.map(id => {
                const p = personById[id]
                if (!p) return null
                return (
                  <li key={id} className="flex items-center gap-3 rounded-xl px-1 py-1.5">
                    <Avatar id={id} size="md" status />
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate font-medium">
                        <span className="truncate">{id === ME ? `${p.name} (you)` : p.name}</span>
                        {p.kind === 'agent' && <AgentBadge />}
                      </p>
                      <p className="truncate text-xs text-muted">{p.title}</p>
                    </div>
                  </li>
                )
              })}
            </ul>
          </Section>
        )}
      </div>
    </Sheet>
  )
}

// ── Thread (CHAT-03) ──────────────────────────────────────────────────────────
export function ThreadSheet({
  c,
  parent,
  replies,
  onClose,
  onReply,
}: {
  c: Conversation
  parent: Message | null
  replies: ThreadReply[]
  onClose: () => void
  onReply: (text: string, alsoSend: boolean) => void
}) {
  const [text, setText] = useState('')
  const [alsoSend, setAlsoSend] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const seen = useRef({ id: '', count: 0 })
  const parentId = parent?.id ?? ''

  // A fresh thread starts with an empty reply box.
  useEffect(() => {
    setText('')
    setAlsoSend(false)
  }, [parentId])

  // When you add a reply, bring it into view (the thread opens at the top).
  useEffect(() => {
    const prev = seen.current
    seen.current = { id: parentId, count: replies.length }
    if (prev.id === parentId && replies.length > prev.count) {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      end.current?.scrollIntoView({ block: 'end', behavior: reduce ? 'auto' : 'smooth' })
    }
  }, [parentId, replies.length])

  if (!parent) return null
  const author = personById[parent.authorId]
  const submit = () => {
    const t = text.trim()
    if (!t) return
    onReply(t, alsoSend)
    setText('')
  }
  return (
    <Sheet
      open={!!parent}
      onClose={onClose}
      title="Thread"
      footer={
        <form className="flex w-full flex-col gap-2" onSubmit={e => { e.preventDefault(); submit() }}>
          <div className="flex items-end gap-2">
            <label htmlFor="thread-reply" className="sr-only">Reply in thread</label>
            <textarea
              id="thread-reply"
              rows={1}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  submit()
                }
              }}
              placeholder="Reply…"
              style={{ outline: 'none', borderRadius: 20 }}
              className="min-h-10 min-w-0 flex-1 resize-none bg-surface-2 px-4 py-2 text-[15px] leading-6 placeholder:text-muted focus:ring-2 focus:ring-accent"
            />
            <button type="submit" aria-label="Send reply" disabled={!text.trim()} className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-fg disabled:opacity-40">
              <SendHorizontal size={18} />
            </button>
          </div>
          {c.kind !== 'dm' && (
            <label className="flex items-center gap-2 text-[13px] text-muted">
              <input type="checkbox" checked={alsoSend} onChange={e => setAlsoSend(e.target.checked)} className="size-4 accent-accent" />
              Also send to {c.kind === 'channel' ? `#${c.name}` : c.name}
            </label>
          )}
        </form>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex gap-3">
          <Avatar id={parent.authorId} size="md" />
          <div className="min-w-0 flex-1">
            <p className="text-sm">
              <span className="font-semibold">{parent.authorId === ME ? 'You' : author?.name}</span>
              <span className="ml-2 text-xs text-muted">{shortDay(parent.ts)}, {clock(parent.ts)}</span>
            </p>
            <p className="whitespace-pre-wrap break-words text-[15px]">
              <RichText text={messageGist(parent)} />
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs font-semibold text-muted">
          <span>{replies.length} {replies.length === 1 ? 'reply' : 'replies'}</span>
          <span className="h-px flex-1 bg-line" />
        </div>
        <ul className="flex flex-col gap-3.5">
          {replies.map(r => (
            <li key={r.id} className="anim-in flex gap-3">
              <Avatar id={r.authorId} size="sm" className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="text-sm">
                  <span className="font-semibold">{r.authorId === ME ? 'You' : personById[r.authorId]?.name}</span>
                  <span className="ml-2 text-xs text-muted">{clock(r.ts)}</span>
                </p>
                <p className="whitespace-pre-wrap break-words text-[15px]">
                  <RichText text={r.text} />
                </p>
              </div>
            </li>
          ))}
        </ul>
        <div ref={end} aria-hidden />
      </div>
    </Sheet>
  )
}

// ── Message actions on phones (long-press)────────────────────────────────────
export function ActionsSheet({ m, onClose, onThread }: { m: Message | null; onClose: () => void; onThread: (m: Message) => void }) {
  const { react, addTask, toast } = useStore()
  if (!m) return null
  const text = messageGist(m)
  const done = (fn: () => void) => () => {
    fn()
    onClose()
  }
  return (
    <Sheet open={!!m} onClose={onClose} title="Message">
      <div className="flex flex-col gap-4 pb-2">
        <p className="line-clamp-3 rounded-2xl bg-surface-2 px-3 py-2 text-sm text-muted">{text}</p>
        <div className="flex justify-between gap-2" role="group" aria-label="React">
          {quickReactions.map(e => {
            const mine = m.reactions?.some(r => r.emoji === e && r.by.includes(ME))
            return (
              <button
                key={e}
                onClick={done(() => react(m.id, e))}
                aria-label={`React with ${e}`}
                aria-pressed={!!mine}
                className={cx('grid size-14 place-items-center rounded-2xl text-2xl transition', mine ? 'bg-accent-soft ring-2 ring-accent' : 'bg-surface-2 hover:bg-line')}
              >
                {e}
              </button>
            )
          })}
        </div>
        <ul className="-mx-2 flex flex-col">
          <li>
            <SheetAction icon={<MessageSquareText size={19} />} label="Reply in thread" onClick={done(() => onThread(m))} />
          </li>
          <li>
            <SheetAction
              icon={<ListTodo size={19} />}
              label="Create task"
              hint={taskTitleFrom(m)}
              onClick={done(() => {
                addTask(taskTitleFrom(m))
                toast('Added to My tasks', { label: 'View', route: { name: 'tasks' } })
              })}
            />
          </li>
          <li>
            <SheetAction
              icon={<Copy size={19} />}
              label="Copy text"
              onClick={done(() => {
                navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Couldn’t copy on this device'))
              })}
            />
          </li>
        </ul>
      </div>
    </Sheet>
  )
}

function SheetAction({ icon, label, hint, onClick }: { icon: ReactNode; label: string; hint?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left hover:bg-surface-2">
      <span className="text-muted">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{label}</span>
        {hint && <span className="block truncate text-xs text-muted">{hint}</span>}
      </span>
    </button>
  )
}

