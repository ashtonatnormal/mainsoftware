// Docs (DOC-01..13, J6): spaces and recent docs, a reading view with live
// presence, restricted editing (DOC-03), anchored comments (DOC-05), version
// history with diffs (DOC-04) and an AI draft the user must accept (DOC-09).
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { BookOpen, Check, CheckCircle2, ChevronRight, Eye, FileText, History, Lock, MessageSquare, MessageSquareText, Pencil, RotateCcw, Rocket, Send, Shield, Sparkles, Users } from 'lucide-react'
import type { Doc, DocBlock, DocComment, DocVersion, SourceRef } from '../types'
import { newId, useStore } from '../store'
import DriveScreen from './Drive'
import { ME, personById } from '../data/people'
import { AIMarker, Avatar, AvatarStack, Button, Card, cx, EmptyState, IconButton, personName, personShort, Pill, ScreenHeader, Segmented, SectionTitle, Sheet, SourceChips } from '../ui'
import { clock, listStamp, shortDay } from '../time'

function useWide() {
  const q = '(min-width: 1024px)'
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches)
  useEffect(() => {
    const mq = window.matchMedia(q)
    const on = () => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return wide
}

const stamp = (ms: number) => `${listStamp(ms)}${listStamp(ms).includes(':') ? '' : `, ${clock(ms)}`}`
const names = (ids: string[]) => {
  const n = ids.map(id => (id === ME ? 'you' : personShort(id)))
  return n.length <= 1 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export default function DocsScreen() {
  const { state } = useStore()
  const docId = state.route.name === 'docs' ? state.route.docId : undefined
  const doc = state.docs.find(d => d.id === docId)
  // Without a doc, the Docs route shows the Drive (FILE-01).
  return doc ? <DocView key={doc.id} doc={doc} /> : <DriveScreen />
}

// ── Home ──────────────────────────────────────────────────────────────────────
const SPACES: { name: string; icon: ReactNode; blurb: string }[] = [
  { name: 'Q4 launch', icon: <Rocket size={18} />, blurb: 'Meridian launch plan' },
  { name: 'HR wiki', icon: <BookOpen size={18} />, blurb: 'Policies and benefits' },
  { name: 'Ops wiki', icon: <Shield size={18} />, blurb: 'Runbooks for the sites' },
  { name: 'People', icon: <Users size={18} />, blurb: 'Onboarding and teams' },
]

function DocsHome() {
  const { state, navigate, toast } = useStore()
  const [space, setSpace] = useState<string | null>(null)
  const recent = [...state.docs].sort((a, b) => b.updatedAt - a.updatedAt).filter(d => !space || d.space === space)

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6">
        <div className="mb-5 flex items-center justify-between gap-3">
          <h1 className="hidden font-display text-2xl font-semibold md:block">Docs</h1>
          <Button size="sm" variant="primary" icon={<Pencil size={14} />} className="ml-auto" onClick={() => toast('Creating docs comes later in the demo')}>New doc</Button>
        </div>

        <SectionTitle>Spaces</SectionTitle>
        <div className="mb-8 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {SPACES.map(s => {
            const count = state.docs.filter(d => d.space === s.name).length
            const active = space === s.name
            return (
              <button
                key={s.name}
                aria-pressed={active}
                onClick={() => setSpace(active ? null : s.name)}
                className={cx('flex min-w-0 flex-col gap-2 rounded-2xl border bg-surface p-3 text-left transition hover:border-muted', active ? 'border-accent ring-1 ring-accent' : 'border-line')}
              >
                <span className="grid size-9 place-items-center rounded-xl bg-accent-soft text-accent-ink">{s.icon}</span>
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{s.name}</span>
                  <span className="block truncate text-xs text-muted">{s.blurb}</span>
                </span>
                <span className="text-xs text-muted tabular">{count} {count === 1 ? 'doc' : 'docs'}</span>
              </button>
            )
          })}
        </div>

        <SectionTitle action={space ? <Button size="sm" variant="ghost" onClick={() => setSpace(null)}>Show all</Button> : undefined}>
          {space ? `In ${space}` : 'Recent'}
        </SectionTitle>
        {recent.length === 0 ? (
          <EmptyState icon={<FileText size={28} />} title="No docs here yet" />
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {recent.map(d => (
              <li key={d.id}>
                <button onClick={() => navigate({ name: 'docs', docId: d.id })} className="flex w-full items-center gap-3 py-3 text-left transition hover:bg-surface-2/60 sm:px-2">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-xl" aria-hidden>{d.emoji ?? '📄'}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{d.title}</span>
                    <span className="block truncate text-xs text-muted">{d.space} · {personName(d.ownerId)} · edited {stamp(d.updatedAt)}</span>
                  </span>
                  {d.presence.length > 0 && (
                    <span className="flex shrink-0 items-center gap-1.5">
                      <AvatarStack ids={d.presence} max={3} size="xs" />
                      <span className="hidden text-xs text-ok sm:inline">here now</span>
                    </span>
                  )}
                  {d.comments.some(c => !c.resolved) && (
                    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted" aria-label={`${d.comments.filter(c => !c.resolved).length} open comments`}>
                      <MessageSquare size={13} aria-hidden />{d.comments.filter(c => !c.resolved).length}
                    </span>
                  )}
                  <ChevronRight size={16} className="shrink-0 text-muted" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ── Doc view ──────────────────────────────────────────────────────────────────
type Panel = 'comments' | 'history'

// DOC-09: canned drafts per doc, grounded in things the user can open.
const aiDrafts: Record<string, { text: string; sources: SourceRef[] }> = {
  d_q4: {
    text: 'To cover the ramp-up, we will hire a spare forklift from 26 Oct to 30 Nov and keep cold-room picks on the morning shift until forklift 3 is back. Meridian pricing follows the Q3 review: list prices hold for Q4, with a 5% tier above 200 pallets a month.',
    sources: [
      { label: 'Farah in #ops-north-site · forklift 3', kind: 'message', route: { name: 'chats', conversationId: 'c_ops' } },
      { label: 'Q3 pricing review · Fri 9 Oct', kind: 'session', route: { name: 'session', sessionId: 's_pricing' } },
    ],
  },
}

function DocView({ doc }: { doc: Doc }) {
  const { navigate } = useStore()
  const wide = useWide()
  const [panel, setPanel] = useState<Panel>('comments')
  const [sheet, setSheet] = useState<Panel | null>(null)
  const [permOpen, setPermOpen] = useState(false)
  const [focusComment, setFocusComment] = useState<string | null>(null)
  const canEdit = doc.editors.includes(ME)
  const openComments = doc.comments.filter(c => !c.resolved)

  const showComment = (id: string) => {
    setFocusComment(id)
    if (wide) setPanel('comments')
    else setSheet('comments')
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScreenHeader
        back={() => navigate({ name: 'docs' })}
        leading={<span className="text-xl" aria-hidden>{doc.emoji ?? '📄'}</span>}
        title={doc.title}
        subtitle={<span>Docs <span aria-hidden>›</span> {doc.space}</span>}
        actions={
          !wide && (
            <>
              <IconButton label={`Comments (${openComments.length})`} onClick={() => setSheet('comments')} className="relative">
                <MessageSquareText size={20} />
                {openComments.length > 0 && <span className="absolute top-1 right-1 grid size-4 place-items-center rounded-full bg-accent text-[10px] font-bold text-accent-fg">{openComments.length}</span>}
              </IconButton>
              <IconButton label="Version history" onClick={() => setSheet('history')}><History size={20} /></IconButton>
            </>
          )
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[68ch] px-5 py-5 sm:px-8 sm:py-8">
            <MetaBar doc={doc} canEdit={canEdit} onPermissions={() => setPermOpen(true)} />
            <DocBody doc={doc} canEdit={canEdit} onAnchor={showComment} focusComment={focusComment} />
            {canEdit && <AIDraft doc={doc} />}
          </div>
        </div>
        {wide && (
          <aside className="flex w-[360px] shrink-0 flex-col border-l border-line bg-surface">
            <div className="border-b border-line px-4 py-3">
              <Segmented
                value={panel}
                onChange={setPanel}
                options={[
                  { value: 'comments', label: `Comments · ${openComments.length}` },
                  { value: 'history', label: 'History' },
                ]}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {panel === 'comments' ? <Comments doc={doc} focus={focusComment} /> : <Versions doc={doc} />}
            </div>
          </aside>
        )}
      </div>

      {!wide && (
        <Sheet open={sheet !== null} onClose={() => setSheet(null)} title={sheet === 'history' ? 'Version history' : `Comments · ${openComments.length}`}>
          {sheet === 'history' ? <Versions doc={doc} /> : <Comments doc={doc} focus={focusComment} />}
        </Sheet>
      )}
      <PermissionsSheet open={permOpen} onClose={() => setPermOpen(false)} doc={doc} />
    </div>
  )
}

function permissionLine(doc: Doc) {
  const editors = doc.editors
  const who = names(editors.includes(ME) ? [...editors.filter(id => id !== ME), ME] : editors)
  const comment = doc.commenters === 'team' ? 'team can comment' : doc.commenters === 'org' ? 'everyone can comment' : 'no comments'
  return `Only ${who} can edit · ${comment}`
}

function MetaBar({ doc, canEdit, onPermissions }: { doc: Doc; canEdit: boolean; onPermissions: () => void }) {
  const here = doc.presence.filter(id => id !== ME)
  const editedBy = doc.versions[0]?.authorId ?? doc.ownerId
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line pb-4 text-xs text-muted">
      {here.length > 0 && (
        <span className="flex items-center gap-2">
          <AvatarStack ids={here} max={3} size="xs" />
          <span><span className="text-fg">{cap(names(here))}</span> {here.length === 1 ? 'is' : 'are'} here</span>
        </span>
      )}
      <button onClick={onPermissions} className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 font-medium text-fg transition hover:bg-line">
        {canEdit ? <Pencil size={12} className="shrink-0" aria-hidden /> : <Lock size={12} className="shrink-0" aria-hidden />}
        <span className="truncate">{permissionLine(doc)}</span>
      </button>
      <span>Edited {stamp(doc.updatedAt)} by {editedBy === ME ? 'you' : personName(editedBy)}</span>
    </div>
  )
}

/** Splits text around comment anchors so they can be highlighted. */
function withAnchors(text: string, comments: DocComment[], onAnchor: (id: string) => void, focus: string | null): ReactNode {
  const hit = comments.find(c => !c.resolved && text.includes(c.anchor))
  if (!hit) return text
  const i = text.indexOf(hit.anchor)
  return (
    <>
      {text.slice(0, i)}
      <button
        onClick={() => onAnchor(hit.id)}
        aria-label={`Comment from ${personName(hit.authorId)} on “${hit.anchor}”`}
        className={cx('inline rounded-sm border-b-2 border-warn bg-warn-soft px-0.5 text-left text-inherit [box-decoration-break:clone] transition hover:brightness-95', focus === hit.id && 'ring-2 ring-warn')}
      >
        {hit.anchor}
      </button>
      {withAnchors(text.slice(i + hit.anchor.length), comments.filter(c => c.id !== hit.id), onAnchor, focus)}
    </>
  )
}

function LiveCursor({ personId }: { personId: string }) {
  const p = personById[personId]
  if (!p) return null
  const color = `oklch(0.58 0.12 ${p.hue})`
  return (
    <span className="whitespace-nowrap" aria-label={`${p.short} is editing here`}>
      <span className="ml-0.5 inline-block h-[1.1em] w-0.5 translate-y-[0.2em] anim-pulse" style={{ background: color }} aria-hidden />
      <span className="ml-0.5 rounded px-1 py-px align-[0.15em] text-[10px] leading-none font-semibold text-white" style={{ background: color }} aria-hidden>{p.short}</span>
    </span>
  )
}

function DocBody({ doc, canEdit, onAnchor, focusComment }: { doc: Doc; canEdit: boolean; onAnchor: (id: string) => void; focusComment: string | null }) {
  const { updateDoc } = useStore()
  // A simulated live cursor for the first other person here, parked in the body.
  const cursorBy = doc.presence.find(id => id !== ME)
  const [cursorAt] = useState(() => (cursorBy ? lastIndex(doc.blocks, b => b.type === 'p' || b.type === 'li') : -1))
  const toggle = (i: number) => {
    updateDoc({ ...doc, blocks: doc.blocks.map((b, j) => (j === i ? { ...b, done: !b.done } : b)) })
  }

  const items: ReactNode[] = []
  doc.blocks.forEach((b, i) => {
    const content = (
      <>
        {withAnchors(b.text, doc.comments, onAnchor, focusComment)}
        {i === cursorAt && cursorBy && <LiveCursor personId={cursorBy} />}
      </>
    )
    items.push(<Fragment key={i}>{renderBlock(b, i, content, canEdit, toggle)}</Fragment>)
  })
  return <article className="flex flex-col gap-3 text-[16px] leading-relaxed">{items}</article>
}

function lastIndex<T>(arr: T[], fn: (x: T) => boolean) {
  for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i])) return i
  return -1
}

function renderBlock(b: DocBlock, i: number, content: ReactNode, canEdit: boolean, toggle: (i: number) => void) {
  switch (b.type) {
    case 'h1':
      return <h2 className="font-display text-3xl leading-tight font-semibold">{content}</h2>
    case 'h2':
      return <h3 className="mt-4 font-display text-xl font-semibold">{content}</h3>
    case 'p':
      return <p>{content}</p>
    case 'li':
      return <p className="flex gap-3 pl-1"><span className="mt-[0.7em] size-1.5 shrink-0 rounded-full bg-fg" aria-hidden /><span className="min-w-0">{content}</span></p>
    case 'quote':
      return <blockquote className="border-l-4 border-accent py-1 pl-4 text-muted italic">{content}</blockquote>
    case 'todo':
      return (
        <div className="flex items-start gap-3">
          <button
            role="checkbox"
            aria-checked={!!b.done}
            aria-label={b.text}
            disabled={!canEdit}
            title={canEdit ? undefined : 'Only editors can tick this'}
            onClick={() => toggle(i)}
            className={cx('mt-1 grid size-5 shrink-0 place-items-center rounded-md border-2 transition disabled:cursor-not-allowed', b.done ? 'border-ok bg-ok text-white' : 'border-muted', canEdit && !b.done && 'hover:border-accent')}
          >
            {b.done && <Check size={13} strokeWidth={3} />}
          </button>
          <span className={cx('min-w-0', b.done && 'text-muted line-through')}>{content}</span>
        </div>
      )
  }
}

// ── AI draft (DOC-09) ─────────────────────────────────────────────────────────
function AIDraft({ doc }: { doc: Doc }) {
  const { state: store, updateDoc, toast } = useStore()
  const [state, setState] = useState<'idle' | 'thinking' | 'shown'>('idle')
  const draft = aiDrafts[doc.id]
  useEffect(() => {
    if (state !== 'thinking') return
    const t = window.setTimeout(() => setState('shown'), 900)
    return () => clearTimeout(t)
  }, [state])

  if (state === 'idle') {
    return (
      <div className="mt-8 border-t border-line pt-5">
        <Button variant="agent" icon={<Sparkles size={15} />} onClick={() => setState('thinking')}>Ask AI to draft</Button>
        <p className="mt-2 text-xs text-muted">Suggests a paragraph from what you can open. Nothing goes in until you insert it.</p>
      </div>
    )
  }

  if (state === 'thinking') {
    return (
      <div className="mt-8 flex items-center gap-2 border-t border-line pt-5 text-sm text-muted" aria-live="polite">
        <Sparkles size={15} className="text-agent anim-pulse" aria-hidden /> Drafting from your messages, meetings and docs…
      </div>
    )
  }

  const text = draft?.text ?? 'I couldn’t find enough in the messages, meetings and docs you can open to draft something useful here. Try adding a heading first.'
  return (
    <div className="anim-in mt-8 rounded-2xl border border-agent/30 bg-agent-soft/40 p-4" aria-live="polite">
      <div className="mb-2 flex items-center gap-2">
        <AIMarker label="Suggested paragraph" />
      </div>
      <p className="mb-3 leading-relaxed">{text}</p>
      {draft && <div className="mb-3"><SourceChips sources={draft.sources} /></div>}
      <div className="flex flex-wrap gap-2">
        {draft && (
          <Button size="sm" variant="primary" icon={<Check size={14} />} onClick={() => {
            updateDoc({
              ...doc,
              updatedAt: store.clock,
              blocks: [...doc.blocks, { type: 'p', text: draft.text }],
              versions: [{ id: newId('v'), authorId: ME, ts: store.clock, summary: 'Added a paragraph drafted with AI', added: [draft.text] }, ...doc.versions],
            })
            setState('idle')
            toast('Paragraph inserted at the end of the doc')
          }}>Insert</Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setState('idle')}>Discard</Button>
      </div>
    </div>
  )
}

// ── Comments (DOC-05) ─────────────────────────────────────────────────────────
function Comments({ doc, focus }: { doc: Doc; focus: string | null }) {
  const [showResolved, setShowResolved] = useState(false)
  const open = doc.comments.filter(c => !c.resolved)
  const resolved = doc.comments.filter(c => c.resolved)
  if (!doc.comments.length) {
    return <EmptyState icon={<MessageSquare size={26} />} title="No comments" body={doc.commenters === 'none' ? 'Comments are off for this doc.' : 'Comments on this doc will show here.'} />
  }
  return (
    <div className="flex flex-col gap-3">
      {open.map(c => <CommentCard key={c.id} doc={doc} c={c} focused={focus === c.id} />)}
      {!open.length && <p className="py-4 text-center text-sm text-muted">All comments are resolved.</p>}
      {resolved.length > 0 && (
        <>
          <Button size="sm" variant="ghost" className="self-start" onClick={() => setShowResolved(s => !s)}>
            {showResolved ? 'Hide' : 'Show'} resolved ({resolved.length})
          </Button>
          {showResolved && resolved.map(c => <CommentCard key={c.id} doc={doc} c={c} focused={false} />)}
        </>
      )}
    </div>
  )
}

function CommentCard({ doc, c, focused }: { doc: Doc; c: DocComment; focused: boolean }) {
  const { state, updateDoc, toast } = useStore()
  const [reply, setReply] = useState('')
  const update = (next: DocComment) => updateDoc({ ...doc, comments: doc.comments.map(x => (x.id === c.id ? next : x)) })
  return (
    <Card className={cx('flex flex-col gap-2 p-3', focused && 'ring-2 ring-warn', c.resolved && 'opacity-70')}>
      <p className="truncate border-l-2 border-warn pl-2 text-xs text-muted">“{c.anchor}”</p>
      <div className="flex items-start gap-2">
        <Avatar id={c.authorId} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="text-sm"><span className="font-semibold">{personName(c.authorId)}</span> <span className="text-xs text-muted">{stamp(c.ts)}</span></p>
          <p className="text-sm">{c.text}</p>
        </div>
      </div>
      {c.replies?.map((r, i) => (
        <div key={i} className="ml-9 flex items-start gap-2">
          <Avatar id={r.authorId} size="xs" className="mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="text-sm"><span className="font-semibold">{r.authorId === ME ? 'You' : personName(r.authorId)}</span> <span className="text-xs text-muted">{stamp(r.ts)}</span></p>
            <p className="text-sm">{r.text}</p>
          </div>
        </div>
      ))}
      {!c.resolved ? (
        <div className="flex flex-col gap-2 pt-1">
          <form
            className="flex items-center gap-1 rounded-full bg-surface-2 py-0.5 pr-0.5 pl-3 focus-within:ring-2 focus-within:ring-accent"
            onSubmit={e => {
              e.preventDefault()
              if (!reply.trim()) return
              update({ ...c, replies: [...(c.replies ?? []), { authorId: ME, text: reply.trim(), ts: state.clock }] })
              setReply('')
            }}
          >
            <label htmlFor={`reply-${c.id}`} className="sr-only">Reply to {personName(c.authorId)}</label>
            <input id={`reply-${c.id}`} value={reply} onChange={e => setReply(e.target.value)} placeholder="Reply…" className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-muted" />
            <IconButton label="Send reply" type="submit" className="size-8" disabled={!reply.trim()}><Send size={15} /></IconButton>
          </form>
          <Button size="sm" variant="ghost" className="self-start" icon={<CheckCircle2 size={14} />} onClick={() => { update({ ...c, resolved: true }); toast('Comment resolved') }}>Resolve</Button>
        </div>
      ) : (
        <Button size="sm" variant="ghost" className="self-start" icon={<RotateCcw size={14} />} onClick={() => update({ ...c, resolved: false })}>Reopen</Button>
      )}
    </Card>
  )
}

// ── Version history (DOC-04) ──────────────────────────────────────────────────
function Versions({ doc }: { doc: Doc }) {
  const { toast } = useStore()
  const [sel, setSel] = useState<string>(doc.versions[0]?.id ?? '')
  const v = doc.versions.find(x => x.id === sel)
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-1">
        {doc.versions.map((x, i) => (
          <li key={x.id}>
            <button
              aria-pressed={sel === x.id}
              onClick={() => setSel(x.id)}
              className={cx('flex w-full items-start gap-2.5 rounded-xl px-2 py-2 text-left transition', sel === x.id ? 'bg-accent-soft' : 'hover:bg-surface-2')}
            >
              <Avatar id={x.authorId} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{x.summary}</span>
                <span className="block text-xs text-muted">{personName(x.authorId)} · {shortDay(x.ts)}, {clock(x.ts)}</span>
              </span>
              {i === 0 && <Pill tone="ok">Current</Pill>}
            </button>
          </li>
        ))}
      </ul>
      {v && <Diff v={v} isCurrent={v.id === doc.versions[0]?.id} onRestore={() => toast('Restored as a new version')} />}
    </div>
  )
}

function Diff({ v, isCurrent, onRestore }: { v: DocVersion; isCurrent: boolean; onRestore: () => void }) {
  const has = (v.added?.length ?? 0) + (v.removed?.length ?? 0) > 0
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-4">
      <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted">Changes in this version</p>
      {!has && <p className="text-sm text-muted">{v.summary}. No earlier version to compare with.</p>}
      {v.removed?.map((l, i) => (
        <p key={`r${i}`} className="rounded-lg bg-rec-soft px-2.5 py-1.5 text-sm text-fg line-through decoration-rec"><span className="sr-only">Removed: </span>{l}</p>
      ))}
      {v.added?.map((l, i) => (
        <p key={`a${i}`} className="rounded-lg bg-ok-soft px-2.5 py-1.5 text-sm text-fg"><span className="sr-only">Added: </span>{l}</p>
      ))}
      {!isCurrent ? (
        <Button size="sm" variant="secondary" className="mt-1 self-start" icon={<RotateCcw size={14} />} onClick={onRestore}>Restore this version</Button>
      ) : (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted"><Eye size={13} aria-hidden />You’re looking at this version now.</p>
      )}
    </div>
  )
}

// ── Permissions (DOC-03) ──────────────────────────────────────────────────────
function PermissionsSheet({ open, onClose, doc }: { open: boolean; onClose: () => void; doc: Doc }) {
  const roleOf = (id: string) => (id === doc.ownerId ? 'Owner' : doc.editors.includes(id) ? 'Editor' : 'Commenter')
  const people = [...new Set([doc.ownerId, ...doc.editors])]
  const roles = [
    { name: 'Owner', body: 'Edits, comments, shares and decides who else can edit.' },
    { name: 'Editor', body: 'Edits and comments. Can’t change who has access.' },
    { name: 'Commenter', body: 'Reads and comments, but can’t change the text.' },
    { name: 'Viewer', body: 'Reads only.' },
  ]
  return (
    <Sheet open={open} onClose={onClose} title="Who can do what">
      <div className="flex flex-col gap-5">
        <p className="text-sm">{permissionLine(doc)}.</p>
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {people.map(id => (
            <li key={id} className="flex items-center gap-3 py-2">
              <Avatar id={id} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm">{id === ME ? 'You' : personName(id)}</span>
              <Pill tone={roleOf(id) === 'Owner' ? 'accent' : 'neutral'}>{roleOf(id)}</Pill>
            </li>
          ))}
          <li className="flex items-center gap-3 py-2">
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-2 text-muted"><Users size={14} /></span>
            <span className="min-w-0 flex-1 truncate text-sm">{doc.commenters === 'team' ? `Everyone in ${doc.space}` : 'Everyone at Tembusu Logistics'}</span>
            <Pill>{doc.commenters === 'none' ? 'Viewer' : 'Commenter'}</Pill>
          </li>
        </ul>
        <div>
          <SectionTitle>Roles</SectionTitle>
          <dl className="flex flex-col gap-2 text-sm">
            {roles.map(r => (
              <div key={r.name} className="flex gap-3">
                <dt className="w-24 shrink-0 font-semibold">{r.name}</dt>
                <dd className="min-w-0 text-muted">{r.body}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </Sheet>
  )
}
