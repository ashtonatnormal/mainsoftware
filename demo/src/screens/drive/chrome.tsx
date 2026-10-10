// The Drive's frame: the desktop sidebar (New, views, team folders, storage),
// view chips for phones, the search field, type filters, sort and layout
// controls, breadcrumbs and a folder's details.
import type { ReactNode } from 'react'
import { Building2, ChevronRight, Clock, Cloud, HardDrive, Home, LayoutGrid, List, Lock, Plus, Search, Star, Trash2, UserPlus, Users, X } from 'lucide-react'
import type { DriveView, Folder } from '../../types'
import { useStore } from '../../store'
import { canEdit, folderPath } from '../../drive'
import { AvatarStack, cx, IconButton } from '../../ui'
import { NewMenu } from './create'
import { useDriveActions } from './actions'
import { childrenOf, folderDot, generalAccessLabel, generalAccessOf, inheritedPeople, peopleWithAccess, rootLabel, rootViewOf, sortLabels, storage, teamFolders, trashTop, typeFilters, when, type SortKey, type TypeFilter } from './model'
import type { Layout } from './list'

export const views: { value: DriveView; label: string; short: string; icon: typeof Home }[] = [
  { value: 'home', label: 'Home', short: 'Home', icon: Home },
  { value: 'my', label: 'My Drive', short: 'My Drive', icon: HardDrive },
  { value: 'shared', label: 'Shared with me', short: 'Shared', icon: Users },
  { value: 'recent', label: 'Recent', short: 'Recent', icon: Clock },
  { value: 'starred', label: 'Starred', short: 'Starred', icon: Star },
  { value: 'trash', label: 'Trash', short: 'Trash', icon: Trash2 },
]

// ── Sidebar (desktop) ────────────────────────────────────────────────────────
export function Sidebar({ view, folderId }: { view: DriveView; folderId?: string }) {
  const { state, navigate } = useStore()
  const root = folderId ? folderPath(state.folders, folderId)[0] : undefined
  const active: DriveView | null = folderId ? (root?.team ? null : rootViewOf(state, folderId) === 'my' ? 'my' : 'shared') : view
  const trashCount = trashTop(state).length
  const space = storage(state)
  return (
    <aside className="hidden w-60 shrink-0 flex-col overflow-y-auto border-r border-line bg-surface px-3 py-4 md:flex" aria-label="Drive">
      <NewMenu
        folderId={folderId}
        trigger={open => (
          <button
            onClick={e => open(e.currentTarget)}
            aria-haspopup="menu"
            className="mb-4 ml-1 inline-flex h-12 w-fit items-center gap-2 rounded-2xl bg-accent pr-6 pl-4 font-semibold text-accent-fg shadow-card transition hover:brightness-105"
          >
            <Plus size={20} /> New
          </button>
        )}
      />
      <nav className="flex flex-col gap-0.5">
        {views.map(v => (
          <button
            key={v.value}
            onClick={() => navigate({ name: 'drive', view: v.value })}
            aria-current={active === v.value ? 'page' : undefined}
            className={cx('flex h-9 items-center gap-3 rounded-full px-3 text-sm font-medium transition', active === v.value ? 'bg-accent-soft text-accent-ink' : 'text-fg hover:bg-surface-2')}
          >
            <v.icon size={17} className={active === v.value ? '' : 'text-muted'} aria-hidden />
            <span className="flex-1 text-left">{v.label}</span>
            {v.value === 'trash' && trashCount > 0 && <span className="text-xs text-muted tabular">{trashCount}</span>}
          </button>
        ))}
      </nav>
      <p className="mt-5 mb-1 px-3 text-[11px] font-bold tracking-[0.08em] text-muted uppercase">Team folders</p>
      <div className="flex flex-col gap-0.5">
        {teamFolders(state).map(f => {
          const on = root?.id === f.id
          return (
            <button
              key={f.id}
              onClick={() => navigate({ name: 'drive', folderId: f.id })}
              aria-current={on ? 'page' : undefined}
              className={cx('flex h-9 min-w-0 items-center gap-3 rounded-full px-3 text-sm transition', on ? 'bg-accent-soft font-medium text-accent-ink' : 'hover:bg-surface-2')}
            >
              <span className={cx('size-2.5 shrink-0 rounded-full', folderDot[f.color ?? 'slate'])} aria-hidden />
              <span className="truncate">{f.title}</span>
            </button>
          )
        })}
      </div>
      <div className="flex-1" />
      <div className="mt-6 rounded-2xl bg-surface-2 px-3 py-3">
        <p className="flex items-center gap-2 text-sm font-medium"><Cloud size={16} className="text-muted" aria-hidden /> Storage</p>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(space.pct)} aria-label="Storage used">
          <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, space.pct)}%` }} />
        </div>
        <p className="mt-1.5 text-xs text-muted tabular">{space.label}</p>
        <p className="mt-0.5 text-[11px] text-muted">Your quota is set by admins.</p>
      </div>
    </aside>
  )
}

// ── Phone view chips ─────────────────────────────────────────────────────────
export function ViewChips({ view }: { view: DriveView }) {
  const { navigate } = useStore()
  return (
    <div className="-mx-4 overflow-x-auto px-4 md:hidden" role="tablist" aria-label="Drive views">
      <div className="flex w-max gap-1.5">
        {views.map(v => (
          <button
            key={v.value}
            role="tab"
            aria-selected={view === v.value}
            onClick={() => navigate({ name: 'drive', view: v.value }, { replace: true })}
            className={cx('inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition', view === v.value ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line bg-surface text-fg')}
          >
            <v.icon size={14} aria-hidden />
            {v.short}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Search, filters, sort, layout ────────────────────────────────────────────
export function SearchField({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <div className={cx('flex h-11 min-w-0 items-center gap-2 rounded-full bg-surface-2 pr-1 pl-4 text-muted focus-within:ring-2 focus-within:ring-accent', className)}>
      <Search size={17} className="shrink-0" aria-hidden />
      <label htmlFor="drive-search" className="sr-only">Search Drive</label>
      <input
        id="drive-search"
        type="search"
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => e.key === 'Escape' && onChange('')}
        placeholder="Search in Drive"
        autoComplete="off"
        className="min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
      />
      {value && <IconButton label="Clear search" className="size-9" onClick={() => onChange('')}><X size={16} /></IconButton>}
    </div>
  )
}

export function TypeChips({ value, onChange }: { value: TypeFilter | null; onChange: (v: TypeFilter | null) => void }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0" role="group" aria-label="Filter by type">
      <div className="flex w-max gap-1.5 md:w-auto md:flex-wrap">
        {typeFilters.map(t => {
          const on = value === t.value
          return (
            <button
              key={t.value}
              aria-pressed={on}
              onClick={() => onChange(on ? null : t.value)}
              className={cx('inline-flex h-8 items-center gap-1 rounded-full border px-3 text-[13px] font-medium transition', on ? 'border-fg bg-fg text-bg' : 'border-line bg-surface text-fg hover:border-muted')}
            >
              {t.label}
              {on && <X size={13} aria-hidden />}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function Toolbar({ label, sort, onSort, layout, onLayout }: { label: ReactNode; sort?: SortKey; onSort?: (s: SortKey) => void; layout: Layout; onLayout: (l: Layout) => void }) {
  return (
    <div className="flex min-h-10 items-center gap-2">
      <div className="min-w-0 flex-1 truncate text-[11px] font-bold tracking-[0.08em] text-muted uppercase">{label}</div>
      {sort && onSort && (
        <div className="flex shrink-0 items-center">
          <label htmlFor="drive-sort" className="sr-only">Sort by</label>
          <select
            id="drive-sort"
            value={sort}
            onChange={e => onSort(e.target.value as SortKey)}
            className="h-9 rounded-full border border-line bg-surface pr-2 pl-3 text-[13px] font-medium text-fg outline-none focus:ring-2 focus:ring-accent"
          >
            {(Object.keys(sortLabels) as SortKey[]).map(k => <option key={k} value={k}>{sortLabels[k]}</option>)}
          </select>
        </div>
      )}
      <div className="flex shrink-0 rounded-full border border-line bg-surface p-0.5" role="group" aria-label="Layout">
        <button aria-pressed={layout === 'list'} aria-label="List view" title="List view" onClick={() => onLayout('list')} className={cx('grid h-8 w-9 place-items-center rounded-full transition', layout === 'list' ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg')}>
          <List size={16} />
        </button>
        <button aria-pressed={layout === 'grid'} aria-label="Grid view" title="Grid view" onClick={() => onLayout('grid')} className={cx('grid h-8 w-9 place-items-center rounded-full transition', layout === 'grid' ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg')}>
          <LayoutGrid size={16} />
        </button>
      </div>
    </div>
  )
}

// ── Breadcrumbs ──────────────────────────────────────────────────────────────
export function Breadcrumbs({ folderId, compact }: { folderId: string; compact?: boolean }) {
  const { state, navigate } = useStore()
  const path = folderPath(state.folders, folderId)
  const rootView = rootViewOf(state, folderId)
  const crumbs: { label: string; go: () => void }[] = [
    { label: rootLabel[rootView], go: () => navigate({ name: 'drive', view: rootView }) },
    ...path.map(f => ({ label: f.title, go: () => navigate({ name: 'drive', folderId: f.id }) })),
  ]
  // Deep paths fold the middle into "…" (it goes up a level): two crumbs on phones, four on a computer.
  const n = crumbs.length
  const shown = compact && n > 2 ? [{ label: '…', go: crumbs[n - 2].go }, crumbs[n - 1]]
    : !compact && n > 3 ? [crumbs[0], { label: '…', go: crumbs[n - 3].go }, crumbs[n - 2], crumbs[n - 1]]
      : crumbs
  return (
    <nav aria-label="Folder path" className="flex min-w-0 items-center gap-0.5">
      {shown.map((c, i) => {
        const last = i === shown.length - 1
        return (
          // The folder you're in keeps most of the room; the crumbs above it shrink first.
          <span key={i} className={cx('flex min-w-0 items-center gap-0.5', last ? 'shrink' : 'min-w-[2.75rem] shrink-[4]')}>
            {last ? (
              <h1 title={c.label} className={cx('min-w-0 truncate font-display font-semibold', compact ? 'text-lg' : 'text-2xl')} aria-current="page">{c.label}</h1>
            ) : (
              <button onClick={c.go} title={c.label} className={cx('max-w-[12rem] min-w-0 truncate rounded-full px-2 py-1 text-muted transition hover:bg-surface-2 hover:text-fg', compact ? 'text-sm' : 'text-lg')}>{c.label}</button>
            )}
            {!last && <ChevronRight size={compact ? 14 : 18} className="shrink-0 text-muted" aria-hidden />}
          </span>
        )
      })}
    </nav>
  )
}

// ── Folder details ───────────────────────────────────────────────────────────
export function FolderInfo({ folder }: { folder: Folder }) {
  const { state } = useStore()
  const actions = useDriveActions()
  const entry = { kind: 'folder' as const, item: folder }
  const access = generalAccessOf(state, folder)
  const named = [...peopleWithAccess(entry), ...inheritedPeople(state, entry)].map(p => p.personId)
  const count = childrenOf(state, folder.id).length
  const AccessIcon = access === 'org' ? Building2 : access === 'team' ? Users : Lock
  const who = access === 'restricted'
    ? named.length > 1 ? `Only ${named.length} people` : 'Only you'
    : generalAccessLabel(state, folder, access)
  return (
    <section aria-label="Folder details" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface px-4 py-3.5 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {folder.team && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 font-semibold text-fg">
              <span className={cx('size-2 rounded-full', folderDot[folder.color ?? 'slate'])} aria-hidden />
              Team folder · {folder.team}
            </span>
          )}
          <span className="tabular">{count} {count === 1 ? 'item' : 'items'}</span>
          <span>Updated {when(folder.updatedAt)}</span>
        </div>
        {folder.description && <p className="mt-1.5 text-sm">{folder.description}</p>}
        <p className="mt-1.5 flex items-center gap-1.5 text-sm text-muted">
          <AccessIcon size={14} className="shrink-0" aria-hidden />
          <span className="min-w-0">Who can open it: <span className="text-fg">{who}</span></span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <AvatarStack ids={named} max={4} size="sm" />
        <button onClick={() => actions.share(folder.id)} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-surface-2 px-3.5 text-[13px] font-medium transition hover:bg-line">
          <UserPlus size={15} aria-hidden /> {canEdit(folder) ? 'Share' : 'See access'}
        </button>
      </div>
    </section>
  )
}
