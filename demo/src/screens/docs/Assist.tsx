// Help me write (DOC-09, D16): suggest-only. Every suggestion is computed from
// things the user can open, shown as a preview with the AI marker and its
// sources, and only enters the doc when they choose Insert.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { BookOpen, Check, Compass, Copy, Hand, Mic, NotebookPen, PenLine, ScrollText, Sparkles, X } from 'lucide-react'
import type { Doc, DocBlock, DocTemplateId, Session, SourceRef } from '../../types'
import { useStore } from '../../store'
import { ME } from '../../data/people'
import { docTemplates } from '../../data/drive'
import { AIMarker, AvatarStack, Button, cx, IconButton, Sheet, SourceChips } from '../../ui'
import { clock, minutesLabel, shortDay } from '../../time'
import { hasText, isBlank, meetingDraft, meetingTitle, newKey, openLine, summarise, SUMMARY_PREFIX, templateTitle, toItems, type Item } from './model'
import type { DocDraft } from './useDocDraft'
import type { MenuItem } from './ui'

export type AssistKind = 'paragraph' | 'meeting' | 'summary'

type Where = 'top' | 'end' | 'body' | { after: string }

interface Proposal {
  kind: AssistKind
  heading: string
  blocks: DocBlock[]
  sources: SourceRef[]
  note?: string
  where: Where
  session?: Session
}

// A drafted paragraph for the Q4 proposal, grounded in a chat and a meeting the user was in.
const paragraphs: Record<string, { text: string; sources: SourceRef[] }> = {
  d_q4: {
    text: 'To cover the ramp-up, we will hire a spare forklift from 26 Oct to 30 Nov and keep cold-room picks on the morning shift until forklift 3 is back. Meridian pricing follows the Q3 review: list prices hold for Q4, with a 5% tier above 200 pallets a month.',
    sources: [
      { label: 'Farah in #ops-north-site · forklift 3', kind: 'message', route: { name: 'chats', conversationId: 'c_ops' } },
      { label: 'Q3 pricing review · Fri 9 Oct', kind: 'session', route: { name: 'session', sessionId: 's_pricing' } },
    ],
  },
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Sessions with AI notes that you can open (restricted ones only if you were in them). */
export function meetingsYouCanOpen(sessions: Session[]) {
  return sessions.filter(s => s.notes && (!s.restricted || s.participants.includes(ME))).sort((a, b) => b.startedAt - a.startedAt)
}

export function useAssist({ doc, draft, editable, title }: { doc: Doc; draft: DocDraft; editable: boolean; title: string }) {
  const { state, toast } = useStore()
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [thinking, setThinking] = useState<{ label: string; where: Where } | null>(null)
  const [picker, setPicker] = useState(false)
  const pickAt = useRef<string | undefined>(undefined)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const blocks = draft.items.map(i => i.block)
  const blank = isBlank(blocks)

  const think = (label: string, where: Where, make: () => Proposal | null) => {
    setProposal(null)
    setThinking({ label, where })
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      setThinking(null)
      const p = make()
      if (p) setProposal(p)
      else toast('There’s no text to summarise yet.')
    }, reducedMotion() ? 150 : 900)
  }

  /** at: the block the caret is in, so drafts go in there rather than at the end. */
  const run = (kind: AssistKind, at?: string) => {
    if (kind === 'meeting') { pickAt.current = at; setPicker(true); return }
    if (kind === 'summary') {
      think('Reading this doc…', 'top', () => {
        const text = summarise(draft.itemsRef.current.map(i => i.block))
        return text ? {
          kind, heading: 'Summary of this doc', where: 'top', blocks: [{ type: 'quote', text }],
          sources: [{ label: `${title || doc.title} (this doc)`, kind: 'doc', route: { name: 'docs', docId: doc.id } }],
          note: editable ? 'Built from the first sentence of each section. Nothing is added that isn’t in the doc.' : 'Built from the first sentence of each section. You can’t edit this doc, so copy the summary if you need it.',
        } : null
      })
      return
    }
    const para = paragraphs[doc.id]
    if (!para) return
    const where: Where = at ? { after: at } : 'end'
    think('Drafting from your messages, meetings and docs…', where, () => ({ kind, heading: 'Suggested paragraph', where, blocks: [{ type: 'p', text: para.text }], sources: para.sources }))
  }

  const pickSession = (s: Session) => {
    setPicker(false)
    const at = pickAt.current
    const where: Where = isBlank(draft.itemsRef.current.map(i => i.block)) ? 'body' : at && draft.itemsRef.current.some(i => i.key === at) ? { after: at } : 'end'
    think(`Drafting from ${s.title}…`, where, () => ({
      kind: 'meeting', heading: `Draft from ${s.title}`, where, session: s, blocks: meetingDraft(s),
      sources: [{ label: `${s.title} · ${shortDay(s.startedAt)} · meeting notes`, kind: 'session', route: { name: 'session', sessionId: s.id } }],
      note: 'Meeting notes are machine-generated. Check them against the recording before you share this doc.',
    }))
  }

  const insert = () => {
    if (!proposal || !editable) return
    const all = draft.itemsRef.current
    const added: Item[] = proposal.blocks.map(block => ({ key: newKey(), block }))
    let next: Item[]
    let nextTitle: string | undefined
    if (proposal.kind === 'summary') {
      const at = all[0]?.block.type === 'h1' ? 1 : 0
      const existing = all[at]?.block.type === 'quote' && all[at].block.text.startsWith(SUMMARY_PREFIX)
      next = [...all.slice(0, at), ...added, ...all.slice(existing ? at + 1 : at)]
    } else if (proposal.kind === 'meeting' && isBlank(all.map(i => i.block))) {
      const head = all[0]?.block.type === 'h1' ? all[0] : { key: newKey(), block: { type: 'h1' as const, text: '' } }
      if (!head.block.text.trim() && proposal.session) nextTitle = meetingTitle(proposal.session)
      next = [nextTitle ? { ...head, block: { ...head.block, text: nextTitle } } : head, ...added]
      if (draft.emoji === '📄') draft.setEmoji('🗒️')
    } else {
      const at = typeof proposal.where === 'object' ? all.findIndex(i => i.key === (proposal.where as { after: string }).after) : -1
      if (at !== -1) {
        // Into the empty line the caret was on, or just below the block.
        const empty = !all[at].block.text && all[at].block.type === 'p'
        next = [...all.slice(0, empty ? at : at + 1), ...added, ...all.slice(at + 1)]
      } else {
        const trimmed = all.length > 1 && !all[all.length - 1].block.text && all[all.length - 1].block.type === 'p' ? all.slice(0, -1) : all
        next = [...trimmed, ...added]
      }
    }
    draft.change(next, nextTitle ? { title: nextTitle } : {})
    draft.markAI(added.map(a => a.key))
    window.setTimeout(() => document.getElementById(`blk-${added[0].key}`)?.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' }), 50)
    toast(proposal.kind === 'summary' ? 'Summary added to the top' : proposal.kind === 'meeting' ? `Added the draft from ${proposal.session?.title ?? 'the meeting'}` : 'Paragraph added')
    setProposal(null)
  }

  const copy = () => {
    if (!proposal) return
    const text = proposal.blocks.map(b => b.text).join('\n\n')
    const ok = () => toast('Summary copied')
    const fail = () => toast('Couldn’t copy here. Select the summary and copy it instead.')
    try { navigator.clipboard.writeText(text).then(ok, fail) } catch { fail() }
  }

  /** The Help me write menu; at = the block a draft should go into. */
  const items = (at?: string): MenuItem[] => editable
    ? [
        ...(paragraphs[doc.id] ? [{ id: 'paragraph', label: 'Suggest a paragraph', note: 'From messages and meetings you can open', icon: <PenLine size={17} />, onSelect: () => run('paragraph', at) }] : []),
        { id: 'meeting', label: 'Draft from a meeting', note: 'Decisions, action items and open questions', icon: <Mic size={17} />, onSelect: () => run('meeting', at) },
        { id: 'summary', label: 'Summarise this doc', note: hasText(blocks) ? 'Key points as a quote at the top' : 'Add some text first', disabled: !hasText(blocks), icon: <ScrollText size={17} />, onSelect: () => run('summary') },
      ]
    : [{ id: 'summary', label: 'Summarise this doc', note: 'Key points from each section, to read or copy', disabled: !hasText(blocks), icon: <ScrollText size={17} />, onSelect: () => run('summary') }]

  const card = (p: Proposal) => <ProposalCard p={p} editable={editable} onInsert={insert} onCopy={copy} onDiscard={() => setProposal(null)} />
  const slot = (where: 'top' | 'end' | 'body') => {
    if (thinking?.where === where) return <Thinking label={thinking.label} />
    if (proposal?.where === where) return card(proposal)
    return null
  }
  /** A suggestion that goes in at the caret shows under that block. */
  const afterBlock = (): { key: string; node: ReactNode } | null => {
    const w = thinking?.where ?? proposal?.where
    if (!w || typeof w !== 'object' || !draft.items.some(i => i.key === w.after)) return null
    return { key: w.after, node: thinking ? <Thinking label={thinking.label} /> : proposal ? card(proposal) : null }
  }

  const pickerSheet = (
    <MeetingPicker open={picker} onClose={() => setPicker(false)} sessions={meetingsYouCanOpen(state.sessions)} onPick={pickSession} />
  )

  // A suggestion whose block has gone falls back to the end of the doc.
  const orphan = (w?: Where) => !!w && typeof w === 'object' && !draft.items.some(i => i.key === w.after)
  const endSlot = () => slot('end') ?? (orphan(thinking?.where) ? <Thinking label={thinking!.label} /> : orphan(proposal?.where) && proposal ? card(proposal) : null)

  return { run, items, slot, endSlot, afterBlock, pickerSheet, blank, busy: !!thinking || !!proposal }
}

function Thinking({ label }: { label: string }) {
  return (
    <div className="anim-in my-4 flex items-center gap-2 rounded-2xl border border-dashed border-agent/40 px-4 py-3 text-sm text-muted" aria-live="polite">
      <Sparkles size={15} className="anim-pulse shrink-0 text-agent" aria-hidden /> {label}
    </div>
  )
}

function ProposalCard({ p, editable, onInsert, onCopy, onDiscard }: { p: Proposal; editable: boolean; onInsert: () => void; onCopy: () => void; onDiscard: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => ref.current?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' }), [])
  return (
    <div ref={ref} className="anim-in my-4 scroll-mt-6 rounded-2xl border border-agent/30 bg-agent-soft/40 p-4 font-sans not-italic" role="region" aria-label={p.heading} aria-live="polite">
      <div className="mb-3 flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <AIMarker label="Suggestion" />
          <p className="min-w-0 text-sm font-semibold">{p.heading}</p>
        </div>
        <IconButton label="Discard suggestion" className="-mt-2 -mr-2 size-8" onClick={onDiscard}><X size={16} /></IconButton>
      </div>
      <div className="mb-3 flex flex-col gap-1.5 rounded-xl bg-surface p-3 text-[15px] leading-relaxed">
        {p.blocks.map((b, i) => <PreviewBlock key={i} b={b} first={i === 0} />)}
      </div>
      <div className="mb-3"><SourceChips sources={p.sources} /></div>
      {p.note && <p className="mb-3 text-xs text-muted">{p.note}</p>}
      <div className="flex flex-wrap gap-2">
        {editable ? (
          <Button size="sm" variant="primary" icon={<Check size={14} />} onClick={onInsert}>Insert</Button>
        ) : (
          <Button size="sm" variant="primary" icon={<Copy size={14} />} onClick={onCopy}>Copy summary</Button>
        )}
        <Button size="sm" variant="ghost" onClick={onDiscard}>Discard</Button>
      </div>
    </div>
  )
}

function PreviewBlock({ b, first }: { b: DocBlock; first: boolean }) {
  switch (b.type) {
    case 'h1':
    case 'h2':
      return <p className={cx('font-display font-semibold', !first && 'mt-2')}>{b.text}</p>
    case 'li':
      return <p className="flex gap-2.5"><span className="mt-[0.65em] size-1.5 shrink-0 rounded-full bg-fg" aria-hidden /><span className="min-w-0">{b.text}</span></p>
    case 'todo':
      return <p className="flex gap-2.5"><span className="mt-[0.3em] size-4 shrink-0 rounded border-2 border-muted" aria-hidden /><span className="min-w-0">{b.text}</span></p>
    case 'quote':
      return <p className="border-l-4 border-accent pl-3 text-muted italic">{b.text}</p>
    default:
      return <p className={cx(first && b.text.includes(' · ') && 'text-sm text-muted')}>{b.text}</p>
  }
}

function MeetingPicker({ open, onClose, sessions, onPick }: { open: boolean; onClose: () => void; sessions: Session[]; onPick: (s: Session) => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Draft from a meeting">
      <p className="mb-3 text-sm text-muted">Pick a meeting you were in or can open. You’ll see a preview built from its notes before anything goes into the doc.</p>
      {sessions.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">No meetings with notes yet. Notes appear after a recorded session of 2 or more people.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {sessions.map(s => (
            <li key={s.id}>
              <button onClick={() => onPick(s)} className="flex w-full items-center gap-3 py-3 text-left transition hover:bg-surface-2/60 sm:px-2">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-ink"><Mic size={18} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{s.title}</span>
                  <span className="block truncate text-xs text-muted">{shortDay(s.startedAt)}, {clock(s.startedAt)} · {minutesLabel(s.durationSec)} · {s.notes!.decisions.length} {s.notes!.decisions.length === 1 ? 'decision' : 'decisions'} · {s.notes!.actionItems.length} action {s.notes!.actionItems.length === 1 ? 'item' : 'items'}</span>
                </span>
                <AvatarStack ids={s.participants} max={3} size="xs" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  )
}

const templateIcons: Partial<Record<DocTemplateId, ReactNode>> = {
  'meeting-notes': <NotebookPen size={16} />, 'project-brief': <Compass size={16} />, policy: <BookOpen size={16} />, onboarding: <Hand size={16} />,
}

/** A blank doc offers templates (DOC-08) and Help me write. Picking a template replaces the blank body. */
export function BlankStart({ draft, onApplied, onMeeting }: { draft: DocDraft; onApplied: () => void; onMeeting: () => void }) {
  const { state } = useStore()
  const apply = (id: DocTemplateId) => {
    const tpl = docTemplates.find(t => t.id === id)
    if (!tpl) return
    const name = draft.title.trim() || templateTitle(id, tpl.name, state.clock)
    const next = toItems(tpl.blocks(name, shortDay(state.clock)))
    const target = openLine(next.slice(1)) ?? next[next.length - 1]
    draft.change(next, { title: name, focus: { key: target.key, caret: 'end' } })
    draft.setEmoji(tpl.emoji)
    onApplied()
  }
  return (
    <div className="mt-10 flex flex-col gap-5 rounded-2xl border border-dashed border-line p-4 font-sans sm:p-5">
      <div>
        <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.08em] text-muted">Start with a template</p>
        <div className="flex flex-wrap gap-2">
          {docTemplates.filter(t => t.id !== 'blank').map(t => (
            <button key={t.id} onClick={() => apply(t.id)} title={t.blurb} className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-sm font-medium transition hover:border-accent hover:text-accent-ink">
              <span className="text-accent-ink">{templateIcons[t.id]}</span>{t.name}
            </button>
          ))}
        </div>
      </div>
      <div>
        <p className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.08em] text-agent"><Sparkles size={12} aria-hidden />Help me write</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="agent" icon={<Mic size={15} />} onClick={onMeeting}>Draft from a meeting</Button>
          <span className="text-xs text-muted">You’ll see a preview first.</span>
        </div>
      </div>
    </div>
  )
}
