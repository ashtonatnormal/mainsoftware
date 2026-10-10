// Item actions for the Drive and file previews (FILE-02/03): the "More" menu
// (a popover on desktop, a sheet on phones), Rename, Move to…, Make a copy,
// Share, Download and Move to trash.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, ChevronLeft, ChevronRight, Copy, Download, ExternalLink, Folder as FolderIcon, FolderInput, HardDrive, Pencil, Star, Trash2, UserPlus } from 'lucide-react'
import type { Deck, Doc, Folder, Sheet as SheetDoc } from '../../types'
import { newId, useStore } from '../../store'
import { canEdit, findEntry, folderPath, isInMyDrive, routeFor, type DriveEntry } from '../../drive'
import { ME } from '../../data/people'
import { Button, cx, Sheet } from '../../ui'
import { ShareDialog } from '../../ui/share'
import { KindIcon } from './art'
import { canAddTo, canOpen, isEditableKind, modifiedLabel, teamFolders, whoCanChange, type DriveState } from './model'
import { focusSoon, useWide } from './hooks'

interface DriveActions {
  /** Opens the "More" menu for an item, anchored to the button that opened it. */
  menu: (id: string, anchor: HTMLElement) => void
  share: (id: string) => void
  rename: (id: string) => void
  move: (id: string) => void
}

const Ctx = createContext<DriveActions | null>(null)

export function useDriveActions() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useDriveActions outside DriveActionsProvider')
  return v
}

type Dialog = { kind: 'share' | 'rename' | 'move'; id: string }

export function DriveActionsProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const api = useMemo<DriveActions>(() => ({
    menu: (id, anchor) => setMenu({ id, anchor }),
    share: id => setDialog({ kind: 'share', id }),
    rename: id => setDialog({ kind: 'rename', id }),
    move: id => setDialog({ kind: 'move', id }),
  }), [])
  const close = useCallback(() => setDialog(null), [])
  const closeMenu = useCallback(() => setMenu(null), [])
  return (
    <Ctx.Provider value={api}>
      {children}
      {menu && <ItemMenu id={menu.id} anchor={menu.anchor} onClose={closeMenu} onDialog={d => { setMenu(null); setDialog(d) }} />}
      {dialog?.kind === 'share' && <ShareDialog itemId={dialog.id} open onClose={close} />}
      {dialog?.kind === 'rename' && <RenameDialog id={dialog.id} onClose={close} />}
      {dialog?.kind === 'move' && <MoveDialog id={dialog.id} onClose={close} />}
    </Ctx.Provider>
  )
}

// ── Shared operations ────────────────────────────────────────────────────────
export function folderName(s: DriveState, id: string | null) {
  return id ? s.folders.find(f => f.id === id)?.title ?? 'a folder' : 'My Drive'
}

/** Make a copy (docs, sheets and decks): "Copy of …", owned by you, next to the original if you can add there. */
export function useCopy() {
  const store = useStore()
  return (e: DriveEntry) => {
    const s = store.state
    const dest = canAddTo(s, e.item.folderId) ? e.item.folderId : null
    const title = `Copy of ${e.item.title}`
    const clean = { ownerId: ME, editors: [ME], commenters: 'none' as const, presence: [], starred: false, trashed: false, trashedAt: undefined, lastOpenedAt: undefined, sharedWith: undefined, access: undefined, updatedAt: s.clock, updatedBy: ME, folderId: dest }
    const version = { id: newId('v'), authorId: ME, ts: s.clock, summary: `Copied from “${e.item.title}”` }
    let id: string
    if (e.kind === 'doc') {
      const doc = e.item as Doc
      id = store.createDoc({ folderId: dest, title, open: false })
      store.updateDoc({ ...doc, ...clean, id, title, space: dest ? folderName(s, dest) : 'My Drive', blocks: structuredClone(doc.blocks), comments: [], versions: [version] })
    } else if (e.kind === 'sheet') {
      const sheet = e.item as SheetDoc
      id = store.createSheet({ folderId: dest, title, tabs: structuredClone(sheet.tabs), open: false })
      store.updateSheet({ ...sheet, ...clean, id, title, tabs: structuredClone(sheet.tabs), cursors: {}, versions: [version] })
    } else if (e.kind === 'slides') {
      const deck = e.item as Deck
      id = store.createDeck({ folderId: dest, title, slides: structuredClone(deck.slides), open: false })
      store.updateDeck({ ...deck, ...clean, id, title, slides: structuredClone(deck.slides), versions: [version] })
    } else return
    store.toast(`Copy saved to ${folderName(s, dest)}`, { label: 'Open', route: routeFor({ kind: e.kind, item: { id } }) })
  }
}

export function useTrash() {
  const { trashItem, toast } = useStore()
  return (e: DriveEntry) => {
    trashItem(e.item.id)
    toast(`Moved “${e.item.title}” to trash`, { label: 'View trash', route: { name: 'drive', view: 'trash' } })
  }
}

// ── More menu ────────────────────────────────────────────────────────────────
interface MenuItem { key: string; label: string; icon: ReactNode; run: () => void; disabled?: boolean; reason?: string; danger?: boolean; divider?: boolean }

function useMenuItems(e: DriveEntry, onDialog: (d: Dialog) => void, close: () => void): MenuItem[] {
  const store = useStore()
  const copy = useCopy()
  const trash = useTrash()
  const editable = canEdit(e.item as Doc)
  const id = e.item.id
  const items: MenuItem[] = [
    { key: 'open', label: e.kind === 'folder' ? 'Open folder' : 'Open', icon: <ExternalLink size={17} />, run: () => { close(); store.openItem(id) } },
    { key: 'share', label: 'Share', icon: <UserPlus size={17} />, run: () => onDialog({ kind: 'share', id }) },
    { key: 'star', label: e.item.starred ? 'Remove from Starred' : 'Add to Starred', icon: <Star size={17} fill={e.item.starred ? 'currentColor' : 'none'} />, run: () => { close(); store.toggleStar(id); store.toast(e.item.starred ? 'Removed from Starred' : 'Added to Starred') } },
    { key: 'rename', label: 'Rename', icon: <Pencil size={17} />, run: () => onDialog({ kind: 'rename', id }), disabled: !editable, reason: editable ? undefined : `Only ${whoCanChange(e)} can rename it` },
    { key: 'move', label: 'Move to…', icon: <FolderInput size={17} />, run: () => onDialog({ kind: 'move', id }), disabled: !editable, reason: editable ? undefined : `Only ${whoCanChange(e)} can move it` },
  ]
  if (isEditableKind(e.kind)) items.push({ key: 'copy', label: 'Make a copy', icon: <Copy size={17} />, run: () => { close(); copy(e) } })
  items.push({ key: 'download', label: 'Download', icon: <Download size={17} />, run: () => { close(); store.toast('Downloads aren’t part of the demo. In Hearth this saves the file to your device.') } })
  items.push({
    key: 'trash', label: 'Move to trash', icon: <Trash2 size={17} />, danger: true, divider: true,
    run: () => { close(); trash(e) },
    disabled: !editable, reason: editable ? undefined : `Only ${whoCanChange(e)} can move it to trash`,
  })
  return items
}

function ItemMenu({ id, anchor, onClose, onDialog }: { id: string; anchor: HTMLElement; onClose: () => void; onDialog: (d: Dialog) => void }) {
  const { state } = useStore()
  const wide = useWide()
  const entry = findEntry(state, id)
  if (!entry) return null
  return wide ? <MenuPopover entry={entry} anchor={anchor} onClose={onClose} onDialog={onDialog} /> : <MenuSheet entry={entry} onClose={onClose} onDialog={onDialog} />
}

function MenuRow({ item, big }: { item: MenuItem; big?: boolean }) {
  return (
    <>
      {item.divider && <div className="my-1 border-t border-line" role="separator" />}
      <button
        role="menuitem"
        disabled={item.disabled}
        onClick={item.run}
        className={cx(
          'flex w-full items-start gap-3 px-4 text-left text-sm transition outline-none hover:bg-surface-2 focus-visible:bg-surface-2 disabled:pointer-events-none',
          big ? 'py-3 text-[15px]' : 'py-2',
          item.danger && !item.disabled && 'text-rec',
        )}
      >
        <span className={cx('mt-0.5 shrink-0', item.disabled ? 'text-muted opacity-60' : item.danger ? 'text-rec' : 'text-muted')} aria-hidden>{item.icon}</span>
        <span className="min-w-0 flex-1">
          <span className={cx('block', item.disabled && 'text-muted')}>{item.label}</span>
          {item.reason && <span className="block text-xs text-muted">{item.reason}</span>}
        </span>
      </button>
    </>
  )
}

function MenuPopover({ entry, anchor, onClose, onDialog }: { entry: DriveEntry; anchor: HTMLElement; onClose: () => void; onDialog: (d: Dialog) => void }) {
  const close = useCallback(() => {
    onClose()
    if (anchor.isConnected) anchor.focus()
  }, [onClose, anchor])
  const items = useMenuItems(entry, onDialog, close)
  return (
    <Popover anchor={anchor} onClose={close} label={`Actions for ${entry.item.title}`}>
      {items.map(i => <MenuRow key={i.key} item={i} />)}
    </Popover>
  )
}

function MenuSheet({ entry, onClose, onDialog }: { entry: DriveEntry; onClose: () => void; onDialog: (d: Dialog) => void }) {
  const items = useMenuItems(entry, onDialog, onClose)
  return (
    <Sheet
      open
      onClose={onClose}
      title={
        <span className="flex min-w-0 items-center gap-3">
          <KindIcon kind={entry.kind} color={(entry.item as Folder).color} size="md" />
          <span className="min-w-0">
            <span className="block truncate text-base">{entry.item.title}</span>
            <span className="block truncate font-sans text-xs font-normal text-muted">{modifiedLabel(entry.item)}</span>
          </span>
        </span>
      }
    >
      <div role="menu" aria-label={`Actions for ${entry.item.title}`} className="-mx-5 -my-2">
        {items.map(i => <MenuRow key={i.key} item={i} big />)}
      </div>
    </Sheet>
  )
}

/** A small menu anchored to a button, kept inside the window. */
export function Popover({ anchor, onClose, label, children, width = 264, align = 'end' }: { anchor: HTMLElement; onClose: () => void; label: string; children: ReactNode; width?: number; align?: 'start' | 'end' }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = anchor.getBoundingClientRect()
    const h = el.offsetHeight
    let top = r.bottom + 6
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6)
    const left = Math.max(8, Math.min(align === 'start' ? r.left : r.right - width, window.innerWidth - width - 8))
    setPos({ top, left })
    el.querySelector<HTMLElement>('[role=menuitem]:not([disabled])')?.focus()
  }, [anchor, width, align])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]:not([disabled])') ?? [])]
      if (!items.length) return
      e.preventDefault()
      const i = items.indexOf(document.activeElement as HTMLElement)
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus()
    }
    const onResize = () => onClose()
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize) }
  }, [onClose])
  return createPortal(
    <div className="fixed inset-0 z-50" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="menu"
        aria-label={label}
        className="anim-in fixed max-h-[80vh] overflow-y-auto rounded-2xl border border-line bg-surface py-1.5 text-fg shadow-card"
        style={{ width, top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}

// ── Rename ───────────────────────────────────────────────────────────────────
function RenameDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { state, renameItem, toast } = useStore()
  const entry = findEntry(state, id)
  const [name, setName] = useState(entry?.item.title ?? '')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const t = entry?.item.title ?? ''
    const dot = t.lastIndexOf('.')
    focusSoon(input.current, entry && entry.kind !== 'folder' && !isEditableKind(entry.kind) && dot > 0 ? dot : t.length)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  if (!entry) return null
  const clean = name.trim()
  const submit = (ev?: FormEvent) => {
    ev?.preventDefault()
    if (!clean || clean === entry.item.title) return onClose()
    renameItem(id, clean)
    toast(`Renamed to “${clean}”`)
    onClose()
  }
  return (
    <Sheet
      open
      onClose={onClose}
      title="Rename"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => submit()} disabled={!clean}>Save</Button></>}
    >
      <form onSubmit={submit} className="flex flex-col gap-2 pb-1">
        <label htmlFor="rename-input" className="text-sm font-medium">Name</label>
        <input id="rename-input" ref={input} value={name} onChange={e => setName(e.target.value)} className="h-11 rounded-xl border border-line bg-surface px-3 text-[15px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/25" />
        {!clean && <p className="text-xs text-rec">Give it a name.</p>}
      </form>
    </Sheet>
  )
}

// ── Move to… ─────────────────────────────────────────────────────────────────
type Spot = 'root' | null | string // 'root' = the top: My Drive and team folders; null = My Drive

function MoveDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { state, moveItem, toast } = useStore()
  const entry = findEntry(state, id)
  const [spot, setSpot] = useState<Spot>(entry?.item.folderId ?? null)
  const [warning, setWarning] = useState<string | null>(null)
  if (!entry) return null
  const current = entry.item.folderId
  const s = state

  const folders = (spot === 'root' ? teamFolders(s) : s.folders.filter(f => f.folderId === spot && (spot !== null || isInMyDrive(s, { kind: 'folder', item: f }))))
    .filter(f => !f.trashed && canOpen(s, { kind: 'folder', item: f }))
    .sort((a, b) => a.title.localeCompare(b.title))
  const path = typeof spot === 'string' && spot !== 'root' ? folderPath(s.folders, spot) : []
  const up: Spot = spot === 'root' ? 'root' : spot === null ? 'root' : path.length > 1 ? path[path.length - 2].id : (s.folders.find(f => f.id === spot)?.team ? 'root' : rootIsMine(s, spot) ? null : 'root')
  const here = spot === 'root' ? 'Drive' : spot === null ? 'My Drive' : path[path.length - 1]?.title ?? 'Folder'
  const target = spot === 'root' ? undefined : spot
  const allowed = target !== undefined && canAddTo(s, target)
  const reason = spot === 'root' ? 'Pick a folder' : target === current ? `Already in ${here}` : !allowed ? `You can only view ${here}` : null

  const enter = (f: Folder) => {
    if (f.id === id) {
      setWarning(`You can’t move “${entry.item.title}” into itself. Pick another folder.`)
      return
    }
    setWarning(null)
    setSpot(f.id)
  }
  const doMove = () => {
    if (target === undefined) return
    if (!moveItem(id, target)) {
      setWarning(`You can’t move “${entry.item.title}” into a folder inside it.`)
      return
    }
    toast(`Moved to ${target ? folderPath(s.folders, target).at(-1)?.title : 'My Drive'}`, { label: 'Open folder', route: target ? { name: 'drive', folderId: target } : { name: 'drive', view: 'my' } })
    onClose()
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={<span className="block truncate">Move “{entry.item.title}”</span>}
      footer={
        <div className="flex w-full items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-muted">{reason ?? `Move to ${here}`}</span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!!reason} onClick={doMove}>Move here</Button>
        </div>
      }
    >
      <div className="-mx-1 flex min-h-[300px] flex-col gap-2">
        <div className="flex min-w-0 items-center gap-1">
          {spot !== 'root' && (
            <button onClick={() => { setWarning(null); setSpot(up) }} aria-label="Up one level" className="grid size-9 shrink-0 place-items-center rounded-full hover:bg-surface-2">
              <ChevronLeft size={18} />
            </button>
          )}
          <p className="min-w-0 flex-1 truncate px-1 font-semibold">{here}</p>
          {entry.kind === 'folder' && <span className="shrink-0 text-xs text-muted">Moving a folder moves everything in it</span>}
        </div>
        {warning && (
          <p role="alert" className="anim-in flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
            <span className="min-w-0">{warning}</span>
          </p>
        )}
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
          {spot === 'root' && (
            <li>
              <button onClick={() => setSpot(null)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2"><HardDrive size={18} aria-hidden /></span>
                <span className="min-w-0 flex-1 font-medium">My Drive</span>
                <ChevronRight size={16} className="text-muted" aria-hidden />
              </button>
            </li>
          )}
          {spot === 'root' && <li className="bg-surface-2/60 px-3 py-1.5 text-[11px] font-bold tracking-[0.08em] text-muted uppercase">Team folders</li>}
          {folders.map(f => {
            const self = f.id === id
            const viewOnly = !canAddTo(s, f.id)
            return (
              <li key={f.id}>
                <button onClick={() => enter(f)} className={cx('flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2', self && 'opacity-70')}>
                  <KindIcon kind="folder" color={f.color} size="md" className="size-9" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{f.title}</span>
                    {(self || viewOnly || f.team) && <span className="block truncate text-xs text-muted">{self ? 'The folder you’re moving' : viewOnly ? 'View only' : f.team}</span>}
                  </span>
                  {!self && <ChevronRight size={16} className="text-muted" aria-hidden />}
                </button>
              </li>
            )
          })}
          {folders.length === 0 && spot !== 'root' && (
            <li className="flex items-center gap-3 px-3 py-6 text-sm text-muted">
              <FolderIcon size={18} aria-hidden /> No folders in {here}. You can move it here.
            </li>
          )}
        </ul>
      </div>
    </Sheet>
  )
}

function rootIsMine(s: DriveState, folderId: string) {
  return folderPath(s.folders, folderId)[0]?.ownerId === ME
}
