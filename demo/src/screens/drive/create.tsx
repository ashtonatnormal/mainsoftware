// Creating things in the Drive (FILE-02, DOC-08): the "New" menu, the doc
// template picker, a new folder, and real file uploads (picker, camera roll
// and drag-and-drop), with text extracted from text files for search (FILE-06).
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { Camera, FileText, FolderPlus, Info, Presentation, Sheet as SheetIcon, Upload } from 'lucide-react'
import type { DocBlock, DriveUpload } from '../../types'
import { useStore } from '../../store'
import { docTemplates } from '../../data/drive'
import { shortDay } from '../../time'
import { Button, cx, Sheet } from '../../ui'
import { templateIcons } from '../docs/ui'
import { DocLines } from './art'
import { Popover } from './actions'
import { focusSoon, useWide } from './hooks'
import { canAddTo, extractText, formatBytes, kindFromFile, type DriveState } from './model'

/** Where new things go: the folder you're in if you can add to it, else My Drive. */
export function destinationFor(s: DriveState, folderId: string | undefined) {
  const want = folderId ?? null
  const ok = canAddTo(s, want)
  const folder = want ? s.folders.find(f => f.id === want) : undefined
  return { folderId: ok ? want : null, name: ok && folder ? folder.title : 'My Drive', blocked: !ok && folder ? folder.title : undefined }
}

// ── Uploads ──────────────────────────────────────────────────────────────────
export function useUploader() {
  const { addUpload, toast } = useStore()
  return useCallback(async (files: File[], dest: { folderId: string | null; name: string }) => {
    if (!files.length) return []
    const items = await Promise.all(files.map(async f => {
      const kind = kindFromFile(f)
      let url: string | undefined
      if (kind === 'image' || kind === 'video' || kind === 'audio') {
        try { url = URL.createObjectURL(f) } catch { url = undefined }
      }
      const previewText = await extractText(f)
      const upload: Omit<DriveUpload, 'id' | 'ownerId' | 'updatedAt' | 'updatedBy'> = { kind, title: f.name || 'Untitled file', size: formatBytes(f.size), folderId: dest.folderId, url, previewText }
      return upload
    }))
    const ids = items.map(addUpload)
    ids.forEach(markNew)
    toast(`Uploaded ${ids.length} ${ids.length === 1 ? 'file' : 'files'} to ${dest.name}`)
    return ids
  }, [addUpload, toast])
}

/** Hidden file inputs the New menu and the FAB click. */
export function UploadInputs({ onFiles }: { onFiles: (files: File[]) => void }) {
  const take = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    onFiles(files)
  }
  return (
    <>
      <label htmlFor="drive-upload" className="sr-only">Upload files</label>
      <input id="drive-upload" type="file" multiple className="sr-only" tabIndex={-1} onChange={take} />
      <label htmlFor="drive-upload-media" className="sr-only">Upload a photo or video</label>
      <input id="drive-upload-media" type="file" multiple accept="image/*,video/*" className="sr-only" tabIndex={-1} onChange={take} />
    </>
  )
}

const pick = (id: string) => document.getElementById(id)?.click()

// ── New menu ─────────────────────────────────────────────────────────────────
type NewDialog = 'folder' | 'template' | null

/** The New menu plus its dialogs. `trigger` renders the button that opens it. */
export function NewMenu({ folderId, trigger: renderTrigger }: { folderId?: string; trigger: (open: (el: HTMLElement) => void) => ReactNode }) {
  const store = useStore()
  const wide = useWide()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [dialog, setDialog] = useState<NewDialog>(null)
  const dest = destinationFor(store.state, folderId)
  // Stable callbacks: Sheet re-focuses itself whenever onClose changes, which would
  // pull focus out of the name field on every store update (the clock ticks).
  const trigger = useRef<HTMLElement | null>(null)
  const openMenu = useCallback((el: HTMLElement) => { trigger.current = el; setAnchor(el) }, [])
  const close = useCallback(() => setAnchor(null), [])
  const refocus = useCallback(() => { if (trigger.current?.isConnected) trigger.current.focus() }, [])
  const dismiss = useCallback(() => { setAnchor(null); refocus() }, [refocus])
  const closeDialog = useCallback(() => { setDialog(null); refocus() }, [refocus])
  const items: { key: string; label: string; icon: ReactNode; run: () => void; phoneOnly?: boolean; divider?: boolean }[] = [
    { key: 'folder', label: 'New folder', icon: <FolderPlus size={18} />, run: () => { close(); setDialog('folder') } },
    { key: 'doc', label: 'Doc', icon: <FileText size={18} className="text-accent-ink" />, run: () => { close(); setDialog('template') }, divider: true },
    { key: 'sheet', label: 'Sheet', icon: <SheetIcon size={18} className="text-ok" />, run: () => { close(); store.createSheet({ folderId: dest.folderId }) } },
    { key: 'slides', label: 'Slides', icon: <Presentation size={18} className="text-warn" />, run: () => { close(); store.createDeck({ folderId: dest.folderId }) } },
    { key: 'upload', label: 'Upload files', icon: <Upload size={18} />, run: () => { close(); pick('drive-upload') }, divider: true },
    { key: 'media', label: 'Photo or video', icon: <Camera size={18} />, run: () => { close(); pick('drive-upload-media') }, phoneOnly: true },
  ]
  const shown = items.filter(i => wide ? !i.phoneOnly : true)
  const where = (
    <p className="flex items-start gap-2 px-4 pt-1 pb-2 text-xs text-muted">
      <Info size={13} className="mt-0.5 shrink-0" aria-hidden />
      <span className="min-w-0">{dest.blocked ? `You can only view ${dest.blocked}, so new files go to My Drive.` : `New files go to ${dest.name}.`}</span>
    </p>
  )
  const rows = (big: boolean) => shown.map(i => (
    <div key={i.key}>
      {i.divider && <div className="my-1 border-t border-line" role="separator" />}
      <button role="menuitem" onClick={i.run} className={cx('flex w-full items-center gap-3 px-4 text-left transition hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:-outline-offset-2', big ? 'py-3 text-[15px]' : 'py-2 text-sm')}>
        <span className="shrink-0 text-muted" aria-hidden>{i.icon}</span>
        {i.label}
      </button>
    </div>
  ))
  return (
    <>
      {renderTrigger(openMenu)}
      {anchor && wide && <Popover anchor={anchor} onClose={dismiss} label="New" width={248} align="start">{where}{rows(false)}</Popover>}
      {anchor && !wide && (
        <Sheet open onClose={dismiss} title="New">
          <div role="menu" aria-label="New" className="-mx-5 -mt-2">{where}{rows(true)}</div>
        </Sheet>
      )}
      {dialog === 'folder' && <NewFolderDialog dest={dest} onClose={closeDialog} />}
      {dialog === 'template' && <TemplatePicker dest={dest} onClose={closeDialog} />}
    </>
  )
}

// ── New folder ───────────────────────────────────────────────────────────────
function NewFolderDialog({ dest, onClose }: { dest: { folderId: string | null; name: string }; onClose: () => void }) {
  const { state, createFolder, navigate, toast } = useStore()
  const [name, setName] = useState('Untitled folder')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => focusSoon(input.current, 'Untitled folder'.length), [])
  const clean = name.trim()
  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (!clean) return
    const id = createFolder(clean, dest.folderId)
    onClose()
    markNew(id)
    // Show the new folder where it lives.
    const r = state.route
    const inPlace = r.name === 'drive' && (dest.folderId ? r.folderId === dest.folderId : r.view === 'my' && !r.folderId)
    if (!inPlace) navigate(dest.folderId ? { name: 'drive', folderId: dest.folderId } : { name: 'drive', view: 'my' })
    toast(`Created “${clean}” in ${dest.name}`, { label: 'Open', route: { name: 'drive', folderId: id } })
  }
  return (
    <Sheet open onClose={onClose} title="New folder" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!clean} onClick={() => submit()}>Create</Button></>}>
      <form onSubmit={submit} className="flex flex-col gap-2 pb-1">
        <label htmlFor="new-folder-name" className="text-sm font-medium">Folder name</label>
        <input id="new-folder-name" ref={input} value={name} onChange={e => setName(e.target.value)} className="h-11 rounded-xl border border-line bg-surface px-3 text-[15px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/25" />
        <p className="text-xs text-muted">In {dest.name}</p>
      </form>
    </Sheet>
  )
}

/** Ids created in this visit, so lists can highlight them once. */
export const justCreated = new Set<string>()
export function markNew(id: string) {
  justCreated.add(id)
  window.setTimeout(() => justCreated.delete(id), 4000)
}

// ── Template picker (DOC-08) ─────────────────────────────────────────────────
function TemplatePicker({ dest, onClose }: { dest: { folderId: string | null; name: string }; onClose: () => void }) {
  const { state, createDoc } = useStore()
  const day = shortDay(state.clock)
  return (
    <Sheet open onClose={onClose} title="New doc">
      <p className="mb-3 text-sm text-muted">Pick a starting point. It’s saved to {dest.name}.</p>
      <ul className="grid grid-cols-2 gap-3 pb-1">
        {docTemplates.map(t => {
          const blocks: DocBlock[] = t.blocks(t.id === 'blank' ? 'Untitled document' : t.name, day)
          return (
            <li key={t.id}>
              <button
                onClick={() => { onClose(); createDoc({ folderId: dest.folderId, template: t.id }) }}
                className="group flex w-full flex-col overflow-hidden rounded-2xl border border-line bg-surface text-left transition hover:border-accent focus-visible:border-accent"
              >
                <span className="relative block h-28 overflow-hidden bg-surface-2" aria-hidden>
                  <span className="absolute inset-x-3 top-3 bottom-0 overflow-hidden rounded-t-md border border-b-0 border-line bg-surface px-2.5 pt-2 shadow-card">
                    <DocLines blocks={blocks} limit={8} />
                  </span>
                </span>
                <span className="flex min-w-0 items-start gap-2 px-3 py-2.5">
                  <span className="mt-0.5 shrink-0 text-accent-ink" aria-hidden>{templateIcons[t.id]}</span>
                  <span className="min-w-0">
                    <span className="line-clamp-2 text-sm leading-snug font-semibold">{t.name}</span>
                    <span className="line-clamp-2 text-xs text-muted">{t.blurb}</span>
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </Sheet>
  )
}
