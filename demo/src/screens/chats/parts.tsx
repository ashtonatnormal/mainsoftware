// Small building blocks shared by the chat list and the conversation view.
import { Fragment, type ReactNode } from 'react'
import { Hash, Lock } from 'lucide-react'
import type { Conversation, Message, PersonId, Room } from '../../types'
import { ASSISTANT, ME, people, personById } from '../../data/people'
import { Avatar, cx } from '../../ui'

export const statusLabel = { online: 'Online', away: 'Away', dnd: 'Do not disturb', offline: 'Offline' } as const

/** The person (or agent / assistant) on the other side of a 1:1 conversation. */
export function counterpart(c: Conversation): PersonId | undefined {
  if (c.kind === 'assistant') return ASSISTANT
  if (c.kind === 'dm' || c.kind === 'agent') return c.members.find(m => m !== ME)
  return undefined
}

export const isAI = (id: PersonId) => {
  const k = personById[id]?.kind
  return k === 'agent' || k === 'assistant'
}

/** Shows avatars and author names for multi-person conversations only. */
export const isMulti = (c: Conversation) => c.kind === 'channel' || c.kind === 'group'

/** The conversation's room, when two or more people are in it (live and recording). */
export function liveRoom(c: Conversation, rooms: Room[]): Room | undefined {
  const r = c.roomId ? rooms.find(x => x.id === c.roomId) : undefined
  return r && r.participants.length >= 2 ? r : undefined
}

/** "#ops-north-site", or a lock + name for private channels. */
export function ConvTitle({ c, className }: { c: Conversation; className?: string }) {
  if (c.kind !== 'channel') return <span className={className}>{c.name}</span>
  return (
    <span className={className}>
      {c.private ? <Lock size={14} className="mr-1 inline-block align-[-1px]" aria-label="Private channel" /> : <span aria-hidden>#</span>}
      {c.name}
    </span>
  )
}

export const convLabel = (c: Conversation) => (c.kind === 'channel' ? `${c.private ? '' : '#'}${c.name}` : c.name)

export function ConvAvatar({ c, size = 'lg' }: { c: Conversation; size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'size-12' : 'size-9'
  if (c.kind === 'channel') {
    return (
      <span className={cx('grid shrink-0 place-items-center rounded-[30%] bg-surface-2 text-fg', box)} aria-hidden>
        {c.private ? <Lock size={size === 'lg' ? 20 : 16} /> : <Hash size={size === 'lg' ? 22 : 17} />}
      </span>
    )
  }
  if (c.kind === 'group') {
    // Two overlapping faces, WhatsApp-style. Avatar sets its own `relative`, so
    // the positioning lives on wrapper spans.
    const others = c.members.filter(m => m !== ME)
    const s = size === 'lg' ? 'sm' : 'xs'
    return (
      <span className={cx('relative block shrink-0', box)} aria-hidden>
        <span className="absolute top-0 left-0 flex">
          <Avatar id={others[0]} size={s} />
        </span>
        <span className="absolute right-0 bottom-0 flex rounded-full ring-2 ring-surface">
          <Avatar id={others[1] ?? others[0]} size={s} />
        </span>
      </span>
    )
  }
  const id = counterpart(c)
  return id ? <Avatar id={id} size={size} status={c.kind === 'dm'} /> : null
}

// ── @mentions ─────────────────────────────────────────────────────────────────
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const mentionNames = [...new Set(people.flatMap(p => [p.name, p.short]))].sort((a, b) => b.length - a.length)
const mentionRe = new RegExp(`(@(?:${[...mentionNames.map(esc), 'channel', 'here', 'everyone'].join('|')}))`, 'g')
const meMentions = new Set(['@Ashton', '@Ashton Teo', '@channel', '@here', '@everyone'])

/** Message text with @mentions in accent ink; mentions of you get a soft highlight. */
export function RichText({ text }: { text: string }) {
  const parts = text.split(mentionRe)
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <span key={i} className={cx('font-semibold text-accent-ink', meMentions.has(p) && 'rounded bg-accent-soft px-0.5')}>{p}</span>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  )
}

/** Plain-text summary of a message, for the list preview and task titles. */
export function messageGist(m: Message, sessionTitle?: string): string {
  if (m.deleted) return 'Message deleted'
  switch (m.kind) {
    case 'voice':
      return m.voice?.transcript ?? 'Voice message'
    case 'file':
      return m.text || m.file?.name || 'File'
    case 'notes':
      return `Meeting notes · ${sessionTitle ?? 'Session'}`
    case 'suggest':
      return m.suggestion?.teaser ?? 'Suggestion'
    default:
      return m.text ?? ''
  }
}

export function taskTitleFrom(m: Message): string {
  const base =
    m.kind === 'file' && m.file ? `Review ${m.file.name}` : m.kind === 'voice' ? m.voice?.transcript ?? 'Follow up on voice message' : (m.text ?? '').split('\n')[0]
  const clean = base.replace(/\s+/g, ' ').trim()
  return clean.length > 90 ? `${clean.slice(0, 87).trimEnd()}…` : clean || 'Follow up on message'
}

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}
