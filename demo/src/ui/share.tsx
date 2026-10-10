// Share dialog for any Drive item (FILE-03, DOC-03): people with access and
// their roles, adding people, general access (restricted / the team / the
// whole organisation), a copyable link, and the rule that search and the
// assistant only show the item to people who can open it. Read-only for
// people who can't change sharing. Every editor's Share button opens this.
import { useId, useMemo, useRef, useState } from 'react'
import { Building2, Check, Link2, Lock, ShieldCheck, Users, X } from 'lucide-react'
import type { AccessRole, Doc, DriveMeta, GeneralAccess, PersonId } from '../types'
import { useStore } from '../store'
import { accessOf, canEdit, findEntry, teamFolderOf, type DriveEntry } from '../drive'
import { humans, ME, ORG_NAME, personById } from '../data/people'
import { Avatar, Button, cx, IconButton, Sheet } from './index'

export function ShareDialog({ itemId, open, onClose }: { itemId: string; open: boolean; onClose: () => void }) {
  const { state } = useStore()
  const entry = findEntry(state, itemId)
  if (!open) return null
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={<span className="block truncate">{entry ? `Share “${entry.item.title}”` : 'Share'}</span>}
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}
    >
      {entry ? <ShareBody entry={entry} /> : <p className="pb-4 text-sm text-muted">This item isn’t in the Drive any more.</p>}
    </Sheet>
  )
}

const roleLabel: Record<AccessRole | 'owner', string> = { owner: 'Owner', editor: 'Editor', commenter: 'Commenter', viewer: 'Viewer' }
const roleHint: Record<AccessRole, string> = { editor: 'Can change it and share it', commenter: 'Can view and comment', viewer: 'Can view' }
const LINK_BASE = 'https://hearth.tembusu.example/d/'

type Named = { personId: PersonId; role: AccessRole | 'owner' }

function named(e: DriveEntry): Named[] {
  const out: Named[] = [{ personId: e.item.ownerId, role: 'owner' }]
  const editors = 'editors' in e.item ? (e.item as Doc).editors : []
  for (const id of editors) if (!out.some(o => o.personId === id)) out.push({ personId: id, role: 'editor' })
  for (const g of e.item.sharedWith ?? []) if (!out.some(o => o.personId === g.personId)) out.push({ personId: g.personId, role: g.role })
  return out
}

function ShareBody({ entry }: { entry: DriveEntry }) {
  const { state, patchItem, toast } = useStore()
  const uid = useId()
  const item = entry.item
  const editableKind = 'editors' in item
  const mayChange = canEdit(item as DriveMeta & { editors?: PersonId[] })
  const people = named(entry)
  const access = accessOf(state.folders, item)
  const teamFolder = teamFolderOf(state.folders, item)
  const team = teamFolder?.team ?? personById[item.ownerId]?.team ?? 'the team'
  const owner = personById[item.ownerId]?.name ?? 'The owner'
  const commenters = editableKind ? (item as Doc).commenters : undefined

  // ── Changes ──
  const setRole = (pid: PersonId, role: AccessRole | null) => {
    const editors = editableKind ? (item as Doc).editors.filter(x => x !== pid) : undefined
    const sharedWith = (item.sharedWith ?? []).filter(g => g.personId !== pid)
    if (role === 'editor' && editors) editors.push(pid)
    else if (role) sharedWith.push({ personId: pid, role })
    patchItem(item.id, editors ? { editors, sharedWith } : { sharedWith })
  }
  const setAccess = (a: GeneralAccess) => {
    const patch: Parameters<typeof patchItem>[1] = { access: a }
    if (editableKind && a === 'restricted') patch.commenters = 'none'
    else if (editableKind && commenters !== 'none') patch.commenters = a === 'org' ? 'org' : 'team'
    patchItem(item.id, patch)
  }
  const setGeneralRole = (r: 'viewer' | 'commenter') => patchItem(item.id, { commenters: r === 'viewer' ? 'none' : access === 'org' ? 'org' : 'team' })

  // ── Add people ──
  const [q, setQ] = useState('')
  const [addRole, setAddRole] = useState<AccessRole>('viewer')
  const [added, setAdded] = useState<PersonId | null>(null)
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return []
    return humans.filter(p => !people.some(x => x.personId === p.id) && `${p.name} ${p.title} ${p.team}`.toLowerCase().includes(needle)).slice(0, 5)
  }, [q, people])
  const add = (pid: PersonId) => {
    setRole(pid, addRole)
    setQ('')
    setAdded(pid)
    toast(`Shared with ${personById[pid]?.name} as ${roleLabel[addRole]}`)
  }

  // ── Link ──
  const link = `${LINK_BASE}${item.id}`
  const [copied, setCopied] = useState(false)
  const [manual, setManual] = useState(false)
  const linkInput = useRef<HTMLInputElement>(null)
  const copy = () => {
    const fallback = () => {
      setManual(true)
      window.setTimeout(() => linkInput.current?.select(), 30)
    }
    try {
      if (!navigator.clipboard?.writeText) return fallback()
      navigator.clipboard.writeText(link).then(() => {
        setCopied(true)
        toast('Link copied')
        window.setTimeout(() => setCopied(false), 2500)
      }, fallback)
    } catch {
      fallback()
    }
  }

  const generalIcon = access === 'org' ? <Building2 size={18} /> : access === 'team' ? <Users size={18} /> : <Lock size={18} />
  const generalHint = access === 'org' ? `Anyone at ${ORG_NAME} can open it` : access === 'team' ? `Anyone in ${team} can open it` : 'Only the people above can open it'

  return (
    <div className="flex flex-col gap-5 pb-1">
      {!mayChange && (
        <p className="flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted">
          <Lock size={15} className="mt-0.5 shrink-0" aria-hidden />
          <span className="min-w-0">You can see who has access. Only {owner}{editableKind ? ' and editors' : ''} can change it.</span>
        </p>
      )}

      {mayChange && (
        <div className="flex flex-col gap-2">
          <label htmlFor={`${uid}-add`} className="text-sm font-semibold">Add people</label>
          <div className="flex gap-2">
            <input
              id={`${uid}-add`}
              value={q}
              onChange={e => { setQ(e.target.value); setAdded(null) }}
              placeholder="Search people at Tembusu"
              autoComplete="off"
              className="h-10 min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 text-[15px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
            />
            <label htmlFor={`${uid}-add-role`} className="sr-only">Role for people you add</label>
            <select id={`${uid}-add-role`} value={addRole} onChange={e => setAddRole(e.target.value as AccessRole)} className="h-10 shrink-0 rounded-xl border border-line bg-surface px-2 text-sm outline-none focus:ring-2 focus:ring-accent">
              <option value="viewer">Viewer</option>
              <option value="commenter">Commenter</option>
              <option value="editor">Editor</option>
            </select>
          </div>
          {q.trim() && (
            <ul className="overflow-hidden rounded-xl border border-line" aria-label="People found">
              {matches.length === 0 && <li className="px-3 py-2.5 text-sm text-muted">No one else matches “{q.trim()}”.</li>}
              {matches.map((p, i) => (
                <li key={p.id} className={cx(i > 0 && 'border-t border-line')}>
                  <button onClick={() => add(p.id)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-2">
                    <Avatar id={p.id} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{p.name}</span>
                      <span className="block truncate text-xs text-muted">{p.title}</span>
                    </span>
                    <span className="shrink-0 text-xs font-medium text-accent-ink">Add as {roleLabel[addRole]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <section aria-labelledby={`${uid}-people`}>
        <h3 id={`${uid}-people`} className="mb-1 text-sm font-semibold">People with access</h3>
        <ul className="divide-y divide-line">
          {people.map(p => {
            const person = personById[p.personId]
            const me = p.personId === ME
            return (
              <li key={p.personId} className={cx('flex items-center gap-3 py-2', added === p.personId && 'anim-in')}>
                <Avatar id={p.personId} size="md" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{person?.name ?? 'Someone'}{me && <span className="font-normal text-muted"> (you)</span>}</span>
                  <span className="block truncate text-xs text-muted">{p.role === 'owner' ? person?.title : roleHint[p.role]}</span>
                </span>
                {p.role === 'owner' || me || !mayChange ? (
                  <span className="shrink-0 text-sm text-muted">{roleLabel[p.role]}</span>
                ) : (
                  <>
                    <label htmlFor={`${uid}-role-${p.personId}`} className="sr-only">Role for {person?.name}</label>
                    <select
                      id={`${uid}-role-${p.personId}`}
                      value={p.role}
                      onChange={e => setRole(p.personId, e.target.value as AccessRole)}
                      className="h-9 shrink-0 rounded-lg border border-line bg-surface px-2 text-sm outline-none focus:ring-2 focus:ring-accent"
                    >
                      <option value="viewer">Viewer</option>
                      <option value="commenter">Commenter</option>
                      <option value="editor">Editor</option>
                    </select>
                    <IconButton label={`Remove ${person?.name}`} className="size-9 text-muted" onClick={() => { setRole(p.personId, null); toast(`Removed ${person?.name}`) }}>
                      <X size={16} />
                    </IconButton>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      <section aria-labelledby={`${uid}-general`}>
        <h3 id={`${uid}-general`} className="mb-2 text-sm font-semibold">General access</h3>
        <div className="flex items-start gap-3">
          <span className={cx('grid size-9 shrink-0 place-items-center rounded-full', access === 'restricted' ? 'bg-surface-2 text-muted' : 'bg-ok-soft text-ok')} aria-hidden>{generalIcon}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor={`${uid}-access`} className="sr-only">Who can open it</label>
              <select
                id={`${uid}-access`}
                value={access}
                disabled={!mayChange}
                onChange={e => setAccess(e.target.value as GeneralAccess)}
                className="h-9 max-w-full min-w-0 rounded-lg border border-line bg-surface px-2 text-sm font-medium outline-none focus:ring-2 focus:ring-accent disabled:border-transparent disabled:bg-transparent disabled:px-0 disabled:opacity-100"
              >
                <option value="restricted">Restricted</option>
                <option value="team">Everyone in {team}</option>
                <option value="org">Everyone at {ORG_NAME}</option>
              </select>
              {editableKind && access !== 'restricted' && (
                <>
                  <label htmlFor={`${uid}-general-role`} className="sr-only">What they can do</label>
                  <select
                    id={`${uid}-general-role`}
                    value={commenters === 'none' ? 'viewer' : 'commenter'}
                    disabled={!mayChange}
                    onChange={e => setGeneralRole(e.target.value as 'viewer' | 'commenter')}
                    className="h-9 rounded-lg border border-line bg-surface px-2 text-sm outline-none focus:ring-2 focus:ring-accent disabled:border-transparent disabled:bg-transparent disabled:px-0 disabled:opacity-100"
                  >
                    <option value="viewer">can view</option>
                    <option value="commenter">can comment</option>
                  </select>
                </>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted">
              {generalHint}
              {!item.access && teamFolder && ` · from the ${teamFolder.title} team folder`}
              {entry.kind === 'folder' && ' · this applies to everything inside'}
            </p>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" icon={copied ? <Check size={14} /> : <Link2 size={14} />} onClick={copy}>{copied ? 'Copied' : 'Copy link'}</Button>
          <span className="min-w-0 truncate text-xs text-muted">{access === 'restricted' ? 'Only people with access can use the link' : 'Works for anyone who can open it'}</span>
        </div>
        {manual && (
          <div className="anim-in flex flex-col gap-1">
            <label htmlFor={`${uid}-link`} className="text-xs text-muted">Copying isn’t allowed here. Select the link and copy it yourself.</label>
            <input id={`${uid}-link`} ref={linkInput} readOnly value={link} onFocus={e => e.currentTarget.select()} className="h-9 rounded-lg border border-line bg-surface-2 px-2 font-mono text-xs outline-none focus:ring-2 focus:ring-accent" />
          </div>
        )}
      </section>

      <p className="flex items-start gap-2 rounded-xl bg-agent-soft px-3 py-2.5 text-sm text-agent">
        <ShieldCheck size={16} className="mt-0.5 shrink-0" aria-hidden />
        <span className="min-w-0">Search and the assistant only show this to people who can open it.</span>
      </p>
    </div>
  )
}
