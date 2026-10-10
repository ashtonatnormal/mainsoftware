// Drive (FILE-01..08): one place for docs, sheets, slides, uploaded files and
// folders. Home, My Drive, Shared with me, Recent, Starred, Trash and team
// folders; list or grid; search over names and the text inside files; New
// (folders, docs from templates, sheets, slides, uploads); and per-item
// actions (share, move, rename, copy, star, trash).
import { useMemo, useState, type DragEvent, type ReactNode } from 'react'
import { ArrowLeft, Clock, FolderOpen, HardDrive, Plus, RotateCcw, Search, Star, Trash2, Upload, Users } from 'lucide-react'
import type { DriveView, Folder } from '../types'
import { useStore } from '../store'
import { folderPath, isTrashed, type DriveEntry } from '../drive'
import { isToday } from '../time'
import { Button, EmptyState, IconButton, SectionTitle } from '../ui'
import { DriveActionsProvider } from './drive/actions'
import { Breadcrumbs, FolderInfo, SearchField, Sidebar, Toolbar, TypeChips, ViewChips, views } from './drive/chrome'
import { destinationFor, NewMenu, UploadInputs, useUploader } from './drive/create'
import { readPref, writePref } from './drive/hooks'
import { EntryList, FolderTile, ItemCard, type Layout } from './drive/list'
import { canAddTo, childrenOf, filterByQuery, liveEntries, matchesType, myDriveRoot, recent, recentKey, rootViewOf, sharedWithMe, sortEntries, starred, suggested, teamFolders, trashTop, typeFilters, when, type SortKey, type TypeFilter } from './drive/model'

// Remembered for this visit (and in this browser where storage works).
let layoutPref: Layout = readPref('layout', ['list', 'grid'] as const, 'list')
let sortPref: SortKey = readPref('sort', ['name', 'modified', 'owner'] as const, 'modified')

export default function DriveScreen() {
  return (
    <DriveActionsProvider>
      <DriveBody />
    </DriveActionsProvider>
  )
}

function DriveBody() {
  const { state } = useStore()
  const r = state.route
  const folderId = r.name === 'drive' ? r.folderId : undefined
  const view: DriveView = r.name === 'drive' && !folderId ? r.view ?? 'home' : 'home'
  const [layout, setLayoutState] = useState<Layout>(layoutPref)
  const [sort, setSortState] = useState<SortKey>(sortPref)
  const setLayout = (l: Layout) => { layoutPref = l; writePref('layout', l); setLayoutState(l) }
  const setSort = (s: SortKey) => { sortPref = s; writePref('sort', s); setSortState(s) }
  return (
    <div className="flex h-full min-h-0">
      <Sidebar view={view} folderId={folderId} />
      {/* Search and filters reset when you move to another view or folder. */}
      <Main key={folderId ?? view} view={view} folderId={folderId} layout={layout} setLayout={setLayout} sort={sort} setSort={setSort} />
    </div>
  )
}

function Main({ view, folderId, layout, setLayout, sort, setSort }: { view: DriveView; folderId?: string; layout: Layout; setLayout: (l: Layout) => void; sort: SortKey; setSort: (s: SortKey) => void }) {
  const store = useStore()
  const { state, navigate } = store
  const [q, setQ] = useState('')
  const [type, setType] = useState<TypeFilter | null>(null)
  const [drag, setDrag] = useState(false)
  const upload = useUploader()
  const folder = folderId ? state.folders.find(f => f.id === folderId) : undefined
  const dest = destinationFor(state, folderId)

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDrag(false)
    const files = Array.from(e.dataTransfer.files ?? [])
    if (files.length) void upload(files, dest)
  }
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types ?? []).includes('Files')

  // Phone: back from a folder goes to its parent, or to where the folder lives.
  const up = () => {
    if (!folderId) return
    const path = folderPath(state.folders, folderId)
    const parent = path[path.length - 2]
    navigate(parent ? { name: 'drive', folderId: parent.id } : { name: 'drive', view: rootViewOf(state, folderId) })
  }

  const title = folderId ? null : views.find(v => v.value === view)?.label ?? 'Drive'

  return (
    <div
      className="relative flex min-w-0 flex-1 flex-col"
      onDragEnter={e => hasFiles(e) && setDrag(true)}
      onDragOver={e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (!drag) setDrag(true) } }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false) }}
      onDrop={onDrop}
    >
      <UploadInputs onFiles={files => void upload(files, dest)} />
      {/* Phones scroll the header away with the list; on a computer it stays put. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3 px-4 pt-3 pb-2 md:sticky md:top-0 md:z-10 md:bg-bg md:px-6 md:pt-5 md:pb-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-3">
            {folderId ? (
              <>
                <div className="flex w-full min-w-0 items-center gap-1 md:hidden">
                  <IconButton label="Back" onClick={up} className="-ml-2"><ArrowLeft size={20} /></IconButton>
                  <div className="min-w-0 flex-1">{folder && <Breadcrumbs folderId={folderId} compact />}</div>
                </div>
                <div className="hidden min-w-0 flex-1 md:block">{folder && <Breadcrumbs folderId={folderId} />}</div>
              </>
            ) : (
              <h1 className="hidden min-w-0 flex-1 truncate font-display text-2xl font-semibold md:block">{title}</h1>
            )}
            <SearchField value={q} onChange={setQ} className="w-full md:w-52 md:shrink-0 lg:w-72 xl:w-96" />
          </div>
          {!folderId && <ViewChips view={view} />}
          {view !== 'trash' && <TypeChips value={type} onChange={setType} />}
        </div>

        <div className="px-4 pb-28 md:px-6 md:pb-10">
          {q.trim() ? (
            <SearchResults q={q} type={type} layout={layout} setLayout={setLayout} />
          ) : folderId ? (
            folder ? <FolderView folder={folder} type={type} layout={layout} setLayout={setLayout} sort={sort} setSort={setSort} /> : <MissingFolder />
          ) : view === 'home' ? (
            <HomeView type={type} layout={layout} setLayout={setLayout} />
          ) : view === 'trash' ? (
            <TrashView />
          ) : (
            <ListView view={view} type={type} layout={layout} setLayout={setLayout} sort={sort} setSort={setSort} />
          )}
        </div>
      </div>

      {/* Phone: floating New, clear of the tab bar (it sits above <main>'s bottom edge). Not in Trash. */}
      {(folderId || view !== 'trash') && (
        <NewMenu
          folderId={folderId}
          trigger={open => (
            <button
              onClick={e => open(e.currentTarget)}
              aria-haspopup="menu"
              className="absolute right-4 bottom-4 z-10 inline-flex h-14 items-center gap-2 rounded-2xl bg-accent pr-5 pl-4 font-semibold text-accent-fg shadow-card transition active:brightness-95 md:hidden"
            >
              <Plus size={22} /> New
            </button>
          )}
        />
      )}

      {drag && (
        <div className="pointer-events-none absolute inset-3 z-20 grid place-items-center rounded-3xl border-2 border-dashed border-accent bg-accent-soft/80" aria-hidden>
          <div className="flex flex-col items-center gap-2 text-accent-ink">
            <Upload size={32} />
            <p className="font-display text-xl font-semibold">Drop to upload to {dest.name}</p>
            {dest.blocked && <p className="text-sm">You can only view {dest.blocked}</p>}
          </div>
        </div>
      )}
    </div>
  )
}

interface ListProps { type: TypeFilter | null; layout: Layout; setLayout: (l: Layout) => void; sort?: SortKey; setSort?: (s: SortKey) => void }

const typeName = (t: TypeFilter | null) => (t ? typeFilters.find(x => x.value === t)!.label.toLowerCase() : 'items')

// ── Home ─────────────────────────────────────────────────────────────────────
function HomeView({ type, layout, setLayout }: ListProps) {
  const { state, navigate } = useStore()
  const sugg = suggested(state).filter(e => matchesType(e, type))
  const teams = type && type !== 'folder' ? [] : teamFolders(state)
  const rec = recent(state).filter(e => matchesType(e, type)).slice(0, 8)
  if (!sugg.length && !teams.length && !rec.length) return <NothingOfType type={type} />
  return (
    <div className="flex flex-col gap-7 pt-2">
      {sugg.length > 0 && (
        <section aria-labelledby="drive-suggested">
          <SectionTitle><span id="drive-suggested">Suggested</span></SectionTitle>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {sugg.map(e => <ItemCard key={e.item.id} entry={e} note={`You opened ${when(e.item.lastOpenedAt!)}`} />)}
          </div>
        </section>
      )}
      {teams.length > 0 && (
        <section aria-labelledby="drive-teams">
          <SectionTitle><span id="drive-teams">Team folders</span></SectionTitle>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {teams.map(f => {
              const n = childrenOf(state, f.id).length
              return <FolderTile key={f.id} folder={f} sub={`${f.team} · ${n} ${n === 1 ? 'item' : 'items'}`} />
            })}
          </div>
        </section>
      )}
      {rec.length > 0 && (
        <section aria-labelledby="drive-recent">
          <Toolbar
            label={<span id="drive-recent">Recent files</span>}
            layout={layout}
            onLayout={setLayout}
          />
          <EntryList entries={rec} layout={layout} mode="recent" />
          <button onClick={() => navigate({ name: 'drive', view: 'recent' })} className="mt-2 inline-flex items-center gap-1.5 rounded-full px-1 py-1 text-sm font-medium text-accent-ink hover:underline">
            <Clock size={14} aria-hidden /> See everything you opened recently
          </button>
        </section>
      )}
    </div>
  )
}

// ── My Drive, Shared, Recent, Starred ────────────────────────────────────────
const emptyCopy: Record<Exclude<DriveView, 'home' | 'trash'>, { icon: ReactNode; title: string; body: string }> = {
  my: { icon: <HardDrive size={30} />, title: 'Nothing in My Drive yet', body: 'Use New to create a folder, a doc, a sheet or slides, or to upload files from your device.' },
  shared: { icon: <Users size={30} />, title: 'Nothing shared with you yet', body: 'Files people share with you, and files shared in your chats, show up here.' },
  recent: { icon: <Clock size={30} />, title: 'Nothing opened yet', body: 'Files you open or change show up here, newest first.' },
  starred: { icon: <Star size={30} />, title: 'No starred files', body: 'Tap the star on any file or folder to keep it here.' },
}

function ListView({ view, type, layout, setLayout, sort, setSort }: ListProps & { view: Exclude<DriveView, 'home' | 'trash'> }) {
  const { state } = useStore()
  const base = view === 'my' ? myDriveRoot(state) : view === 'shared' ? sharedWithMe(state) : view === 'recent' ? recent(state) : starred(state)
  const list = base.filter(e => matchesType(e, type))
  if (!base.length) return <EmptyState {...emptyCopy[view]} />
  if (!list.length) return <NothingOfType type={type} />

  if (view === 'recent') {
    // Grouped by when you last opened or changed them.
    const day = 86_400_000
    const groups: { label: string; items: DriveEntry[] }[] = [
      { label: 'Today', items: list.filter(e => isToday(recentKey(e.item))) },
      { label: 'Past week', items: list.filter(e => !isToday(recentKey(e.item)) && state.clock - recentKey(e.item) < 7 * day) },
      { label: 'Earlier', items: list.filter(e => state.clock - recentKey(e.item) >= 7 * day) },
    ].filter(g => g.items.length)
    return (
      <div className="flex flex-col gap-6 pt-1">
        {groups.map((g, i) => (
          <section key={g.label}>
            {i === 0 ? <Toolbar label={g.label} layout={layout} onLayout={setLayout} /> : <SectionTitle>{g.label}</SectionTitle>}
            <EntryList entries={g.items} layout={layout} mode="recent" header={i === 0} />
          </section>
        ))}
      </div>
    )
  }

  const sorted = sortEntries(list, sort ?? 'modified')
  return (
    <div className="pt-1">
      <Toolbar label={`${list.length} ${list.length === 1 ? 'item' : 'items'}`} sort={sort} onSort={setSort} layout={layout} onLayout={setLayout} />
      <EntryList entries={sorted} layout={layout} mode={view === 'shared' ? 'shared' : 'default'} sort={sort} onSort={setSort} />
      {view === 'my' && <DropHint name="My Drive" />}
    </div>
  )
}

function NothingOfType({ type }: { type: TypeFilter | null }) {
  return <EmptyState icon={<Search size={28} />} title={`No ${typeName(type)} here`} body="Clear the filter to see everything." />
}

// ── A folder ─────────────────────────────────────────────────────────────────
function FolderView({ folder, type, layout, setLayout, sort, setSort }: ListProps & { folder: Folder }) {
  const { state, restoreItem, toast } = useStore()
  const trashed = isTrashed(state.folders, folder)
  const all = childrenOf(state, folder.id)
  const list = sortEntries(all.filter(e => matchesType(e, type)), sort ?? 'modified')
  return (
    <div className="flex flex-col gap-4 pt-1">
      {trashed && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-warn-soft px-4 py-3 text-sm text-warn">
          <Trash2 size={16} className="shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">This folder is in the trash.</span>
          {folder.trashed && <Button size="sm" variant="secondary" icon={<RotateCcw size={14} />} onClick={() => { restoreItem(folder.id); toast(`Restored “${folder.title}”`) }}>Restore</Button>}
        </div>
      )}
      <FolderInfo folder={folder} />
      {all.length === 0 ? (
        <EmptyState icon={<FolderOpen size={30} />} title="This folder is empty" body="Use New to add a doc, a sheet, slides or a folder here, or upload files. On a computer you can drop files straight onto this page." />
      ) : list.length === 0 ? (
        <NothingOfType type={type} />
      ) : (
        <div>
          <Toolbar label={`${list.length} ${list.length === 1 ? 'item' : 'items'}`} sort={sort} onSort={setSort} layout={layout} onLayout={setLayout} />
          <EntryList entries={list} layout={layout} sort={sort} onSort={setSort} />
          {canAddTo(state, folder.id) && <DropHint name={folder.title} />}
        </div>
      )}
    </div>
  )
}

/** On a computer, a quiet reminder that files can be dropped onto the page. */
function DropHint({ name }: { name: string }) {
  return (
    <p className="mt-5 hidden items-center justify-center gap-2 rounded-2xl border border-dashed border-line py-5 text-sm text-muted md:flex">
      <Upload size={16} aria-hidden /> Drop files here to upload them to {name}
    </p>
  )
}

function MissingFolder() {
  const { navigate } = useStore()
  return (
    <EmptyState
      icon={<FolderOpen size={30} />}
      title="This folder isn’t here any more"
      body="It may have been deleted, or you no longer have access."
      action={<Button variant="primary" onClick={() => navigate({ name: 'drive', view: 'my' })}>Go to My Drive</Button>}
    />
  )
}

// ── Trash ────────────────────────────────────────────────────────────────────
function TrashView() {
  const { state, deleteForever, toast } = useStore()
  const [confirm, setConfirm] = useState(false)
  const items = trashTop(state)
  return (
    <div className="flex flex-col gap-4 pt-1">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-surface-2 px-4 py-3 text-sm">
        <Trash2 size={16} className="shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1 text-muted">Items in the trash are deleted forever after 30 days. Restore them before then to keep them.</span>
        {items.length > 0 && !confirm && <Button size="sm" variant="ghost" className="text-rec" onClick={() => setConfirm(true)}>Empty trash</Button>}
      </div>
      {confirm && (
        <div role="alertdialog" aria-labelledby="empty-trash-q" className="anim-in flex flex-wrap items-center gap-3 rounded-2xl border border-rec bg-rec-soft px-4 py-3 text-sm">
          <p id="empty-trash-q" className="min-w-0 flex-1 text-rec">Delete all {items.length} {items.length === 1 ? 'item' : 'items'} forever? You can’t undo this.</p>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
          <Button size="sm" variant="danger" onClick={() => { items.forEach(e => deleteForever(e.item.id)); setConfirm(false); toast('Trash emptied') }}>Delete forever</Button>
        </div>
      )}
      {items.length === 0 ? (
        <EmptyState icon={<Trash2 size={30} />} title="Trash is empty" body="Things you move to the trash stay here for 30 days, so you can restore them." />
      ) : (
        <EntryList entries={items} layout="list" mode="trash" />
      )}
    </div>
  )
}

// ── Search ───────────────────────────────────────────────────────────────────
function SearchResults({ q, type, layout, setLayout }: ListProps & { q: string }) {
  const { state } = useStore()
  const results = useMemo(() => filterByQuery(liveEntries(state), q).filter(r => matchesType(r.entry, type)), [state, q, type])
  const snippets = Object.fromEntries(results.map(r => [r.entry.item.id, r.snippet]))
  return (
    <div className="pt-1">
      <Toolbar label={`${results.length} ${results.length === 1 ? 'result' : 'results'} in your Drive`} layout={layout} onLayout={setLayout} />
      {results.length === 0 ? (
        <EmptyState icon={<Search size={28} />} title={`Nothing matches “${q.trim()}”`} body="Search looks at names and the text inside docs, sheets, slides and files you can open." />
      ) : (
        <EntryList entries={results.map(r => r.entry)} layout={layout} mode="search" q={q} snippets={snippets} />
      )}
    </div>
  )
}
