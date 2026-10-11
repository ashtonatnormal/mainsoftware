// Side panels and sheets for an open doc: comments (DOC-05), version history
// with diffs and restore (DOC-04), who can do what (DOC-03) and details.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CheckCircle2, Eye, FileText, Lock, MessageSquare, Pencil, RotateCcw, Send, Type, Users } from 'lucide-react'
import type { Doc, DocComment, DocVersion } from '../../types'
import { newId, useStore } from '../../store'
import { ME, ORG_NAME } from '../../data/people'
import { accessOf, folderPath } from '../../drive'
import { Avatar, Button, Card, cx, EmptyState, IconButton, Pill, SectionTitle, Sheet } from '../../ui'
import { clock, listStamp, shortDay } from '../../time'
import { teamNameOf } from '../drive/model'
import { byName, cap, editorIds, fullName, nameList, permissionLine, wordCount } from './model'
import type { DocDraft } from './useDocDraft'

export const stamp = (ms: number) => `${listStamp(ms)}${listStamp(ms).includes(':') ? '' : `, ${clock(ms)}`}`

// ── Comments (DOC-05) ───────────────────────────────────────────────────────
export function Comments({ doc, draft, focus, canComment, newAnchor, onDoneNew, offReason = 'Comments are off for this doc.' }: { doc: Doc; draft: DocDraft; focus: string | null; canComment: boolean; newAnchor: string | null; onDoneNew: () => void; offReason?: string }) {
  const [showResolved, setShowResolved] = useState(false)
  const open = doc.comments.filter(c => !c.resolved)
  const resolved = doc.comments.filter(c => c.resolved)
  return (
    <div className="flex flex-col gap-3">
      {newAnchor && canComment && <NewComment doc={doc} draft={draft} anchor={newAnchor} onDone={onDoneNew} />}
      {!doc.comments.length && !newAnchor && (
        <EmptyState
          icon={<MessageSquare size={26} />}
          title="No comments yet"
          body={canComment ? 'Select text in the doc, then choose Comment. Everyone who can open the doc sees comments.' : offReason}
        />
      )}
      {open.map(c => <CommentCard key={c.id} doc={doc} draft={draft} c={c} focused={focus === c.id} canComment={canComment} />)}
      {doc.comments.length > 0 && !open.length && <p className="py-4 text-center text-sm text-muted">All comments are resolved.</p>}
      {doc.comments.length > 0 && canComment && !newAnchor && <p className="text-xs text-muted">To add a comment, select text in the doc and choose Comment.</p>}
      {resolved.length > 0 && (
        <>
          <Button size="sm" variant="ghost" className="self-start" onClick={() => setShowResolved(s => !s)}>
            {showResolved ? 'Hide' : 'Show'} resolved ({resolved.length})
          </Button>
          {showResolved && resolved.map(c => <CommentCard key={c.id} doc={doc} draft={draft} c={c} focused={false} canComment={canComment} />)}
        </>
      )}
    </div>
  )
}

function NewComment({ doc, draft, anchor, onDone }: { doc: Doc; draft: DocDraft; anchor: string; onDone: () => void }) {
  const { state, toast } = useStore()
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [anchor])
  const submit = () => {
    if (!text.trim()) return
    const c: DocComment = { id: newId('cm'), authorId: ME, ts: state.clock, anchor, text: text.trim() }
    draft.patchDoc({ comments: [...doc.comments, c] })
    toast('Comment added')
    onDone()
  }
  return (
    <Card className="anim-in flex flex-col gap-2 p-3 ring-2 ring-accent">
      <p className="line-clamp-2 border-l-2 border-warn pl-2 text-xs text-muted">“{anchor}”</p>
      <label htmlFor="new-comment" className="sr-only">Your comment</label>
      <textarea
        id="new-comment"
        ref={ref}
        rows={3}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit() }}
        placeholder="Add a comment…"
        className="w-full resize-none rounded-xl bg-surface-2 px-3 py-2 text-sm outline-none placeholder:text-muted focus:ring-2 focus:ring-accent"
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={!text.trim()} onClick={submit}>Comment</Button>
      </div>
    </Card>
  )
}

function CommentCard({ doc, draft, c, focused, canComment }: { doc: Doc; draft: DocDraft; c: DocComment; focused: boolean; canComment: boolean }) {
  const { state, toast } = useStore()
  const [reply, setReply] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [focused])
  const update = (next: DocComment) => draft.patchDoc({ comments: doc.comments.map(x => (x.id === c.id ? next : x)) })
  return (
    <div ref={ref}>
      <Card className={cx('flex flex-col gap-2 p-3', focused && 'ring-2 ring-warn', c.resolved && 'opacity-70')}>
        <p className="truncate border-l-2 border-warn pl-2 text-xs text-muted">“{c.anchor}”</p>
        <div className="flex items-start gap-2">
          <Avatar id={c.authorId} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="text-sm"><span className="font-semibold">{fullName(c.authorId)}</span> <span className="text-xs text-muted">{stamp(c.ts)}</span></p>
            <p className="text-sm [overflow-wrap:anywhere]">{c.text}</p>
          </div>
        </div>
        {c.replies?.map((r, i) => (
          <div key={i} className="ml-9 flex items-start gap-2">
            <Avatar id={r.authorId} size="xs" className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-sm"><span className="font-semibold">{fullName(r.authorId)}</span> <span className="text-xs text-muted">{stamp(r.ts)}</span></p>
              <p className="text-sm [overflow-wrap:anywhere]">{r.text}</p>
            </div>
          </div>
        ))}
        {canComment && (!c.resolved ? (
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
              <label htmlFor={`reply-${c.id}`} className="sr-only">Reply to {fullName(c.authorId)}</label>
              <input id={`reply-${c.id}`} value={reply} onChange={e => setReply(e.target.value)} placeholder="Reply…" className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-muted" />
              <IconButton label="Send reply" type="submit" className="size-8" disabled={!reply.trim()}><Send size={15} /></IconButton>
            </form>
            <Button size="sm" variant="ghost" className="self-start" icon={<CheckCircle2 size={14} />} onClick={() => { update({ ...c, resolved: true }); toast('Comment resolved') }}>Resolve</Button>
          </div>
        ) : (
          <Button size="sm" variant="ghost" className="self-start" icon={<RotateCcw size={14} />} onClick={() => update({ ...c, resolved: false })}>Reopen</Button>
        ))}
      </Card>
    </div>
  )
}

// ── Version history (DOC-04) ────────────────────────────────────────────────
const PENDING = '__pending'

export function Versions({ doc, draft, editable, lockedReason = 'Only people who can edit can restore a version.' }: { doc: Doc; draft: DocDraft; editable: boolean; lockedReason?: string }) {
  const { state, toast } = useStore()
  const pending = draft.pendingVersion()
  const [sel, setSel] = useState<string>(pending ? PENDING : doc.versions[0]?.id ?? '')
  const v = sel === PENDING ? undefined : doc.versions.find(x => x.id === sel)
  const restore = (x: DocVersion) => {
    draft.restore(x)
    toast('Restored as a new version')
    setSel('')
  }
  useEffect(() => {
    if (!sel || (sel === PENDING && !pending)) setSel(doc.versions[0]?.id ?? '')
  }, [sel, pending, doc.versions])
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-1">
        {pending && (
          <li>
            <button
              aria-pressed={sel === PENDING}
              onClick={() => setSel(PENDING)}
              className={cx('flex w-full items-start gap-2.5 rounded-xl px-2 py-2 text-left transition', sel === PENDING ? 'bg-accent-soft' : 'hover:bg-surface-2')}
            >
              <Avatar id={ME} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">Your edits so far</span>
                <span className="block text-xs text-muted">You · {shortDay(state.clock)}, {clock(state.clock)} · added to history when you leave</span>
              </span>
              <Pill tone="accent">Now</Pill>
            </button>
          </li>
        )}
        {doc.versions.map((x, i) => (
          <li key={x.id}>
            <button
              aria-pressed={sel === x.id}
              onClick={() => setSel(x.id)}
              className={cx('flex w-full items-start gap-2.5 rounded-xl px-2 py-2 text-left transition', sel === x.id ? 'bg-accent-soft' : 'hover:bg-surface-2')}
            >
              <Avatar id={x.authorId} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium [overflow-wrap:anywhere]">{x.summary}</span>
                <span className="block text-xs text-muted">{fullName(x.authorId)} · {shortDay(x.ts)}, {clock(x.ts)}</span>
              </span>
              {i === 0 && !pending && <Pill tone="ok">Current</Pill>}
            </button>
          </li>
        ))}
      </ul>
      {sel === PENDING && pending && (
        <Diff added={pending.added} removed={pending.removed} formatted={pending.formatted} footer={<p className="mt-1 flex items-center gap-1.5 text-xs text-muted"><Eye size={13} aria-hidden />Saved to Drive. This becomes a “You edited” version when you leave the doc.</p>} />
      )}
      {v && (
        <Diff
          added={v.added ?? []}
          removed={v.removed ?? []}
          formatted={v.formatted ?? []}
          empty={v === doc.versions[doc.versions.length - 1] ? `${v.summary}. There’s no earlier version to compare with.` : 'Layout changes only. No text changed.'}
          footer={
            v.id === doc.versions[0]?.id && !pending ? (
              <p className="mt-1 flex items-center gap-1.5 text-xs text-muted"><Eye size={13} aria-hidden />You’re looking at this version now.</p>
            ) : editable ? (
              <Button size="sm" variant="secondary" className="mt-1 self-start" icon={<RotateCcw size={14} />} onClick={() => restore(v)}>Restore this version</Button>
            ) : (
              <p className="mt-1 flex items-center gap-1.5 text-xs text-muted"><Lock size={13} className="shrink-0" aria-hidden />{lockedReason}</p>
            )
          }
        />
      )}
    </div>
  )
}

function Diff({ added, removed, formatted, empty, footer }: { added: string[]; removed: string[]; formatted: string[]; empty?: string; footer: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-4">
      <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted">Changes in this version</p>
      {!added.length && !removed.length && !formatted.length && <p className="text-sm text-muted">{empty ?? 'No text changed.'}</p>}
      {removed.map((l, i) => (
        <p key={`r${i}`} className="rounded-lg bg-rec-soft px-2.5 py-1.5 text-sm text-fg line-through decoration-rec [overflow-wrap:anywhere]"><span className="sr-only">Removed: </span>{l}</p>
      ))}
      {added.map((l, i) => (
        <p key={`a${i}`} className="rounded-lg bg-ok-soft px-2.5 py-1.5 text-sm text-fg [overflow-wrap:anywhere]"><span className="sr-only">Added: </span>{l}</p>
      ))}
      {formatted.length > 0 && (
        <>
          <p className={cx('flex items-center gap-1.5 text-xs text-muted', (added.length > 0 || removed.length > 0) && 'mt-1')}><Type size={13} className="shrink-0" aria-hidden />Formatting changed{!added.length && !removed.length ? ', no text changed' : ''}</p>
          {formatted.map((l, i) => (
            <p key={`f${i}`} className="rounded-lg border border-dashed border-line px-2.5 py-1.5 text-sm text-fg [overflow-wrap:anywhere]"><span className="sr-only">Formatting changed: </span>{l}</p>
          ))}
        </>
      )}
      {footer}
    </div>
  )
}

// ── Who can do what (DOC-03) ────────────────────────────────────────────────
export function PermissionsSheet({ open, onClose, doc, onShare }: { open: boolean; onClose: () => void; doc: Doc; onShare: () => void }) {
  const { state } = useStore()
  const editors = editorIds(doc)
  const named = (doc.sharedWith ?? []).filter(s => !editors.includes(s.personId))
  const roleOf = (id: string) => (id === doc.ownerId ? 'Owner' : 'Editor')
  const roles = [
    { name: 'Owner', body: 'Edits, comments, shares and decides who else can edit.' },
    { name: 'Editor', body: 'Edits and comments. Can’t change who has access.' },
    { name: 'Commenter', body: 'Reads and comments, but can’t change the text.' },
    { name: 'Viewer', body: 'Reads only.' },
  ]
  // The same team the Share dialog names (a team folder's team, else the owner's team).
  const teamName = teamNameOf(state, doc)
  const access = accessOf(state.folders, doc)
  const everyone = doc.commenters === 'team' ? `Everyone in ${teamName}` : doc.commenters === 'org' ? `Everyone at ${ORG_NAME}` : access === 'org' ? `Everyone at ${ORG_NAME}` : access === 'team' ? `Everyone in ${teamName}` : null
  return (
    <Sheet open={open} onClose={onClose} title="Who can do what" footer={<Button variant="secondary" icon={<Users size={15} />} onClick={() => { onClose(); onShare() }}>Share settings</Button>}>
      <div className="flex flex-col gap-5">
        <p className="text-sm">{permissionLine(doc)}.</p>
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {editors.map(id => (
            <li key={id} className="flex items-center gap-3 py-2">
              <Avatar id={id} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm">{fullName(id)}</span>
              <Pill tone={roleOf(id) === 'Owner' ? 'accent' : 'neutral'}>{roleOf(id)}</Pill>
            </li>
          ))}
          {named.map(s => (
            <li key={s.personId} className="flex items-center gap-3 py-2">
              <Avatar id={s.personId} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm">{fullName(s.personId)}</span>
              <Pill>{s.role === 'commenter' ? 'Commenter' : 'Viewer'}</Pill>
            </li>
          ))}
          {everyone && (
            <li className="flex items-center gap-3 py-2">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-2 text-muted"><Users size={14} /></span>
              <span className="min-w-0 flex-1 truncate text-sm">{everyone}</span>
              <Pill>{doc.commenters === 'none' ? 'Viewer' : 'Commenter'}</Pill>
            </li>
          )}
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

// ── Details ─────────────────────────────────────────────────────────────────
export function DetailsSheet({ open, onClose, doc, draft }: { open: boolean; onClose: () => void; doc: Doc; draft: DocDraft }) {
  const { state, navigate } = useStore()
  const path = folderPath(state.folders, doc.folderId)
  const access = accessOf(state.folders, doc)
  const created = doc.versions[doc.versions.length - 1]
  const words = wordCount(draft.items.map(i => i.block))
  const where = path.length ? path.map(f => f.title).join(' › ') : doc.ownerId === ME ? 'My Drive' : 'Shared with me'
  const rows: [string, ReactNode][] = [
    ['Type', <span className="inline-flex items-center gap-1.5"><FileText size={14} className="text-accent-ink" aria-hidden />Doc</span>],
    ['Location', <button className="text-left font-medium text-accent-ink hover:underline" onClick={() => { onClose(); navigate(path.length ? { name: 'drive', folderId: path[path.length - 1].id } : { name: 'drive', view: doc.ownerId === ME ? 'my' : 'shared' }) }}>Drive › {where}</button>],
    ['Owner', fullName(doc.ownerId)],
    ['Who can open', access === 'org' ? `Everyone at ${ORG_NAME}` : access === 'team' ? `Everyone in ${teamNameOf(state, doc)}` : 'Only people added to it'],
    ['Who can edit', <span className="inline-flex items-center gap-1.5"><Pencil size={13} className="text-muted" aria-hidden />{cap(nameList(editorIds(doc)))}</span>],
    ['Modified', `${stamp(doc.updatedAt)} by ${byName(doc.updatedBy ?? doc.versions[0]?.authorId ?? doc.ownerId)}`],
    ...(created ? [['Created', `${shortDay(created.ts)}, ${clock(created.ts)} by ${byName(created.authorId)}`] as [string, ReactNode]] : []),
    ...(doc.lastOpenedAt ? [['Opened by you', stamp(doc.lastOpenedAt)] as [string, ReactNode]] : []),
    ['Length', `${words.toLocaleString('en-SG')} ${words === 1 ? 'word' : 'words'} · ${doc.versions.length} ${doc.versions.length === 1 ? 'version' : 'versions'}`],
  ]
  return (
    <Sheet open={open} onClose={onClose} title="Details">
      <dl className="flex flex-col divide-y divide-line border-y border-line text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-3 py-2.5">
            <dt className="w-28 shrink-0 text-muted">{k}</dt>
            <dd className="min-w-0 flex-1 [overflow-wrap:anywhere]">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 flex items-start gap-2 text-xs text-muted"><Lock size={13} className="mt-0.5 shrink-0" aria-hidden />Text in this doc is searchable by people who can open it. Search and the assistant only show it to them.</p>
    </Sheet>
  )
}
