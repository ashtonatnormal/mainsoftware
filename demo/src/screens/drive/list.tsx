// Rows, cards and folder tiles for the Drive, in list or grid layout.
import { useState, type ReactNode } from 'react'
import { ArrowDown, EllipsisVertical, RotateCcw, Star, Trash2, Users } from 'lucide-react'
import type { DriveUpload, Folder } from '../../types'
import { useStore } from '../../store'
import { folderPath, isInMyDrive, routeFor, type DriveEntry } from '../../drive'
import { conversationLabel } from '../ask/search'
import { Button, cx, IconButton } from '../../ui'
import { KindIcon, Thumb } from './art'
import { useDriveActions } from './actions'
import { justCreated } from './create'
import { childrenOf, isShared, modifiedLabel, ownerLabel, sizeOf, sortLabels, when, type SortKey } from './model'

export type RowMode = 'default' | 'shared' | 'search' | 'trash' | 'recent'
export type Layout = 'list' | 'grid'

export function Highlight({ text, q }: { text: string; q?: string }) {
  const needle = q?.trim().toLowerCase()
  if (!needle) return <>{text}</>
  const parts: ReactNode[] = []
  const lower = text.toLowerCase()
  let i = 0
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, i)) {
    if (at > i) parts.push(text.slice(i, at))
    parts.push(<mark key={at} className="rounded-sm bg-accent-soft px-0.5 text-accent-ink">{text.slice(at, at + needle.length)}</mark>)
    i = at + needle.length
  }
  parts.push(text.slice(i))
  return <>{parts}</>
}

function StarToggle({ entry, className }: { entry: DriveEntry; className?: string }) {
  const { toggleStar } = useStore()
  const on = !!entry.item.starred
  return (
    <IconButton
      label={on ? `Remove ${entry.item.title} from Starred` : `Star ${entry.item.title}`}
      aria-pressed={on}
      onClick={() => toggleStar(entry.item.id)}
      className={cx('size-9', on ? 'text-warn' : 'text-muted', className)}
    >
      <Star size={17} fill={on ? 'currentColor' : 'none'} />
    </IconButton>
  )
}

function MoreButton({ entry, className }: { entry: DriveEntry; className?: string }) {
  const actions = useDriveActions()
  return (
    <IconButton label={`More actions for ${entry.item.title}`} aria-haspopup="menu" onClick={e => actions.menu(entry.item.id, e.currentTarget)} className={cx('size-9 text-muted', className)}>
      <EllipsisVertical size={18} />
    </IconButton>
  )
}

/** Where an item came from: a chat (FILE-08) or the person who shared it. */
function SharedFrom({ entry }: { entry: DriveEntry }) {
  const { state } = useStore()
  const conv = 'fromConversationId' in entry.item ? (entry.item as DriveUpload).fromConversationId : undefined
  if (!conv) return <>Shared by {ownerLabel(entry.item.ownerId)}</>
  const c = state.conversations.find(x => x.id === conv)
  return <>Shared in {conversationLabel(c)} by {ownerLabel(entry.item.ownerId)}</>
}

function Location({ entry }: { entry: DriveEntry }) {
  const { state } = useStore()
  const path = folderPath(state.folders, entry.item.folderId)
  return <>{path.length ? `In ${path.map(f => f.title).join(' › ')}` : isInMyDrive(state, entry) ? 'In My Drive' : 'Shared with me'}</>
}

// ── List ─────────────────────────────────────────────────────────────────────
// Rows and the header share these widths so the columns line up.
const ACTIONS_W = 'w-[76px]'
const TRASH_W = 'w-[84px] sm:w-[148px]'

function modifiedCell(it: DriveEntry['item'], mode: RowMode, clock: number) {
  if (mode === 'trash') return `Trashed ${when(it.trashedAt ?? clock)}`
  if (mode === 'recent' && it.lastOpenedAt) return `You opened ${when(it.lastOpenedAt)}`
  return modifiedLabel(it)
}

export function ItemRow({ entry, mode = 'default', snippet, q }: { entry: DriveEntry; mode?: RowMode; snippet?: string; q?: string }) {
  const { state, openItem, restoreItem, deleteForever, toast } = useStore()
  const [confirm, setConfirm] = useState(false)
  const fresh = justCreated.has(entry.item.id)
  const size = sizeOf(entry)
  const shared = isShared(state, entry)
  const it = entry.item
  const trash = mode === 'trash'
  const phoneSub = [modifiedCell(it, mode, state.clock), size].filter(Boolean).join(' · ')
  return (
    <li className={cx('group flex flex-wrap items-center gap-x-1 pr-1 transition hover:bg-surface-2/60', fresh && 'anim-in bg-accent-soft/40')}>
      <button
        onClick={() => (trash ? undefined : openItem(it.id))}
        disabled={trash}
        className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-1 text-left disabled:cursor-default"
      >
        <KindIcon kind={entry.kind} color={(it as Folder).color} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium"><Highlight text={it.title} q={q} /></span>
            {shared && <Users size={13} className="shrink-0 text-muted" aria-label="Shared" />}
          </span>
          <span className={cx('block truncate text-xs text-muted', mode !== 'shared' && mode !== 'search' && 'lg:hidden')}>
            {mode === 'shared' ? <SharedFrom entry={entry} /> : mode === 'search' ? <Location entry={entry} /> : phoneSub}
          </span>
          {snippet && <span className="mt-0.5 line-clamp-2 text-xs text-muted"><Highlight text={snippet} q={q} /></span>}
        </span>
        <span className="hidden w-40 shrink-0 truncate text-sm text-muted lg:block">{ownerLabel(it.ownerId)}</span>
        <span className="hidden w-40 shrink-0 truncate text-sm text-muted lg:block">{modifiedCell(it, mode, state.clock)}</span>
        <span className="hidden w-20 shrink-0 text-right text-sm text-muted tabular lg:block">{size ?? '—'}</span>
      </button>
      {trash ? (
        <div className={cx('flex shrink-0 items-center justify-end gap-1', TRASH_W)}>
          <Button size="sm" variant="secondary" aria-label={`Restore ${it.title}`} icon={<RotateCcw size={14} />} onClick={() => { restoreItem(it.id); toast(`Restored “${it.title}”`, { label: 'Open', route: routeFor(entry) }) }}>
            <span className="hidden sm:inline">Restore</span>
          </Button>
          <IconButton label={`Delete ${it.title} forever`} aria-expanded={confirm} className="size-9 text-rec" onClick={() => setConfirm(true)}><Trash2 size={17} /></IconButton>
        </div>
      ) : (
        <div className={cx('flex shrink-0 items-center justify-end gap-1', ACTIONS_W)}>
          <StarToggle entry={entry} className={cx(!it.starred && 'md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100')} />
          <MoreButton entry={entry} />
        </div>
      )}
      {trash && confirm && (
        <div role="alertdialog" aria-label={`Delete ${it.title} forever?`} className="anim-in mb-2.5 flex basis-full flex-wrap items-center gap-2 rounded-xl bg-rec-soft px-3 py-2 sm:ml-[52px]">
          <p className="min-w-0 basis-full text-sm text-rec sm:flex-1 sm:basis-auto">Delete “{it.title}” forever? You can’t undo this.</p>
          <span className="ml-auto flex shrink-0 gap-2">
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button size="sm" variant="danger" onClick={() => { deleteForever(it.id); toast(`Deleted “${it.title}” forever`) }}>Delete forever</Button>
          </span>
        </div>
      )}
    </li>
  )
}

/** Desktop column headings; clicking one sorts by it. */
export function ListHeader({ sort, onSort, mode }: { sort?: SortKey; onSort?: (s: SortKey) => void; mode?: RowMode }) {
  const col = (key: SortKey | null, label: string, className: string) => {
    const active = key && sort === key
    return key && onSort ? (
      <button onClick={() => onSort(key)} className={cx('flex items-center gap-1 text-left hover:text-fg', active && 'text-fg', className)} aria-label={`Sort by ${label}`}>
        {label}{active && <ArrowDown size={12} aria-hidden />}
      </button>
    ) : <span className={className}>{label}</span>
  }
  return (
    <div className="hidden items-center gap-x-1 border-b border-line pr-1 pb-2 text-xs font-semibold text-muted lg:flex">
      <div className="flex min-w-0 flex-1 items-center gap-3 pl-1">
        <span className="w-10 shrink-0" aria-hidden />
        {col('name', 'Name', 'min-w-0 flex-1')}
        {col('owner', 'Owner', 'w-40 shrink-0')}
        {mode === 'trash' ? <span className="w-40 shrink-0">Trashed</span> : mode === 'recent' ? <span className="w-40 shrink-0">Last opened or changed</span> : col('modified', sortLabels.modified, 'w-40 shrink-0')}
        <span className="w-20 shrink-0 text-right">Size</span>
      </div>
      <span className={cx('shrink-0', mode === 'trash' ? TRASH_W : ACTIONS_W)} aria-hidden />
    </div>
  )
}

// ── Grid ─────────────────────────────────────────────────────────────────────
export function ItemCard({ entry, note, q }: { entry: DriveEntry; note?: string; q?: string }) {
  const { openItem } = useStore()
  const it = entry.item
  return (
    <div className={cx('group relative flex min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface transition hover:border-muted', justCreated.has(it.id) && 'anim-in ring-2 ring-accent/40')}>
      <button onClick={() => openItem(it.id)} tabIndex={-1} aria-hidden className="relative block h-32 overflow-hidden bg-surface-2 text-left">
        <Thumb entry={entry} />
      </button>
      {it.starred && <span className="pointer-events-none absolute top-[6.1rem] left-2 grid size-7 place-items-center rounded-full bg-surface text-warn shadow-card" aria-hidden><Star size={14} fill="currentColor" /></span>}
      <MoreButton entry={entry} className="absolute top-1.5 right-1.5 size-8 bg-surface/90 shadow-card hover:bg-surface" />
      <button onClick={() => openItem(it.id)} className="flex min-w-0 flex-1 flex-col gap-0.5 border-t border-line px-3 pt-2 pb-2.5 text-left">
        <span className="flex min-w-0 items-start gap-2">
          <KindIcon kind={entry.kind} size="sm" className="mt-px" />
          <span className="line-clamp-2 min-w-0 flex-1 text-sm leading-snug font-medium [overflow-wrap:anywhere]"><Highlight text={it.title} q={q} /></span>
        </span>
        <span className="block truncate text-[11px] text-muted">{note ?? modifiedLabel(it)}</span>
      </button>
    </div>
  )
}

export function FolderTile({ folder, sub, q }: { folder: Folder; sub?: string; q?: string }) {
  const { state, openItem } = useStore()
  const entry: DriveEntry = { kind: 'folder', item: folder }
  const count = childrenOf(state, folder.id).length
  return (
    <div className={cx('group flex min-w-0 items-center gap-1 rounded-2xl border border-line bg-surface pr-1 transition hover:border-muted', justCreated.has(folder.id) && 'anim-in ring-2 ring-accent/40')}>
      <button onClick={() => openItem(folder.id)} className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-2.5 text-left">
        <KindIcon kind="folder" color={folder.color} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium"><Highlight text={folder.title} q={q} /></span>
            {folder.starred && <Star size={12} className="shrink-0 text-warn" fill="currentColor" aria-label="Starred" />}
          </span>
          <span className="block truncate text-xs text-muted">{sub ?? `${count} ${count === 1 ? 'item' : 'items'}`}</span>
        </span>
      </button>
      <MoreButton entry={entry} className="size-8" />
    </div>
  )
}

/** A list or grid of entries. Grids put folders in a row of tiles above the file cards. */
export function EntryList({ entries, layout, mode = 'default', q, snippets, sort, onSort, header = true }: {
  entries: DriveEntry[]
  header?: boolean
  layout: Layout
  mode?: RowMode
  q?: string
  snippets?: Record<string, string | undefined>
  sort?: SortKey
  onSort?: (s: SortKey) => void
}) {
  if (layout === 'grid' && mode !== 'trash') {
    const folders = entries.filter(e => e.kind === 'folder')
    const files = entries.filter(e => e.kind !== 'folder')
    return (
      <div className="flex flex-col gap-4">
        {folders.length > 0 && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {folders.map(f => <FolderTile key={f.item.id} folder={f.item as Folder} q={q} />)}
          </div>
        )}
        {files.length > 0 && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(190px,1fr))]">
            {files.map(e => <ItemCard key={e.item.id} entry={e} q={q} note={mode === 'search' && snippets?.[e.item.id] ? snippets[e.item.id] : undefined} />)}
          </div>
        )}
      </div>
    )
  }
  return (
    <div>
      {mode !== 'search' && header && <ListHeader sort={sort} onSort={onSort} mode={mode} />}
      <ul className="divide-y divide-line">
        {entries.map(e => <ItemRow key={e.item.id} entry={e} mode={mode} q={q} snippet={snippets?.[e.item.id]} />)}
      </ul>
    </div>
  )
}
