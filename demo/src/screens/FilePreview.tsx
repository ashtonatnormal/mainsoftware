// File preview (FILE-04/05/06/08): images, PDFs, video, audio and text files,
// with details, location, who has access, where it was shared, and versions
// (upload a new one, restore an old one).
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { AlertTriangle, ArrowRight, Download, EllipsisVertical, FileQuestion, Folder as FolderIcon, Hash, HardDrive, History, Lock, Play, RotateCcw, Search, Star, Trash2, Upload, UserPlus, Users } from 'lucide-react'
import type { DriveUpload, FileVersion } from '../types'
import { newId, useStore } from '../store'
import { accessOf, canEdit, findEntry, folderPath, isInMyDrive, isTrashed, routeFor } from '../drive'
import { ME } from '../data/people'
import { duration } from '../time'
import { Avatar, AvatarStack, Button, cx, EmptyState, IconButton, personName, Pill, ScreenHeader, SectionTitle } from '../ui'
import { conversationLabel } from './ask/search'
import { DriveActionsProvider, useDriveActions } from './drive/actions'
import { GeneratedArt, KindIcon } from './drive/art'
import { formatBytes, fullWhen, generalAccessLabel, isTextFile, kindFromFile, kindNames, peopleWithAccess, readStart, versionsOf, when, whoCanChange } from './drive/model'

export default function FilePreviewScreen() {
  return (
    <DriveActionsProvider>
      <Preview />
    </DriveActionsProvider>
  )
}

function Preview() {
  const { state, navigate, back, patchItem } = useStore()
  const fileId = state.route.name === 'file' ? state.route.fileId : undefined
  const entry = fileId ? findEntry(state, fileId) : undefined

  // Opening a file counts as opening it, wherever you came from (Recent).
  useEffect(() => {
    if (!entry) return
    if (entry.kind === 'folder' || entry.kind === 'doc' || entry.kind === 'sheet' || entry.kind === 'slides') {
      navigate(routeFor(entry), { replace: true })
      return
    }
    patchItem(entry.item.id, { lastOpenedAt: state.clock })
  }, [fileId]) // eslint-disable-line react-hooks/exhaustive-deps

  const goBack = () => {
    if (state.history.length) back()
    else navigate(entry?.item.folderId ? { name: 'drive', folderId: entry.item.folderId } : { name: 'drive' })
  }

  if (!entry || !('size' in entry.item)) {
    return (
      <div className="flex h-full flex-col">
        <ScreenHeader back={goBack} title="File" />
        <EmptyState
          icon={<FileQuestion size={30} />}
          title="This file isn’t here any more"
          body="It may have been deleted forever, or you no longer have access."
          action={<Button variant="primary" onClick={() => navigate({ name: 'drive' })}>Go to Drive</Button>}
        />
      </div>
    )
  }
  return <FileView u={entry.item as DriveUpload} onBack={goBack} />
}

function FileView({ u, onBack }: { u: DriveUpload; onBack: () => void }) {
  const { state, toggleStar, restoreItem, toast } = useStore()
  const actions = useDriveActions()
  const trashed = isTrashed(state.folders, u)
  const editable = canEdit(u)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScreenHeader
        back={onBack}
        leading={<KindIcon kind={u.kind} size="md" className="hidden sm:grid" />}
        title={u.title}
        subtitle={`${kindNames[u.kind]} · ${u.size}`}
        actions={
          <>
            <IconButton label={u.starred ? 'Remove from Starred' : 'Add to Starred'} aria-pressed={!!u.starred} onClick={() => toggleStar(u.id)} className={u.starred ? 'text-warn' : 'text-muted'}>
              <Star size={19} fill={u.starred ? 'currentColor' : 'none'} />
            </IconButton>
            <span className="hidden sm:block"><Button size="sm" variant="primary" icon={<UserPlus size={15} />} onClick={() => actions.share(u.id)}>Share</Button></span>
            <IconButton label="Share" onClick={() => actions.share(u.id)} className="sm:hidden"><UserPlus size={19} /></IconButton>
            <IconButton label="More actions" aria-haspopup="menu" onClick={e => actions.menu(u.id, e.currentTarget)}><EllipsisVertical size={19} /></IconButton>
          </>
        }
      />
      {trashed && (
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-warn-soft px-4 py-2.5 text-sm text-warn">
          <Trash2 size={16} className="shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{u.trashed ? 'This file is in the trash. It’s deleted forever after 30 days.' : 'This file’s folder is in the trash.'}</span>
          {u.trashed && editable && <Button size="sm" variant="secondary" icon={<RotateCcw size={14} />} onClick={() => { restoreItem(u.id); toast(`Restored “${u.title}”`) }}>Restore</Button>}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto md:flex md:overflow-hidden">
        <div className="bg-wall md:min-h-0 md:flex-1 md:overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-3 px-4 py-6 md:px-8 md:py-8">
            <Body u={u} />
          </div>
        </div>
        <aside aria-label="File details" className="border-t border-line bg-surface md:w-[340px] md:shrink-0 md:overflow-y-auto md:border-t-0 md:border-l">
          <Details u={u} />
        </aside>
      </div>
    </div>
  )
}

// ── Preview body by kind ─────────────────────────────────────────────────────
const sentences = (t: string) => t.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map(s => s.trim()).filter(Boolean)
const isPlan = (u: DriveUpload) => /floor plan|layout/i.test(`${u.title} ${u.previewText ?? ''}`)

function Body({ u }: { u: DriveUpload }) {
  const { toast } = useStore()
  const [noFootage, setNoFootage] = useState(false)
  switch (u.kind) {
    case 'image':
      return u.url ? (
        <img src={u.url} alt={u.title} className="max-h-[70vh] w-full rounded-2xl bg-surface object-contain shadow-card" />
      ) : (
        <>
          <figure className="w-full overflow-hidden rounded-2xl bg-surface shadow-card">
            <GeneratedArt hue={u.hue} plan={isPlan(u)} className="block aspect-[4/3] w-full" />
          </figure>
          <Caption>Example file: the demo draws this preview from the image’s description.</Caption>
          {u.previewText && <p className="w-full max-w-xl text-center text-sm">{u.previewText}</p>}
        </>
      )
    case 'pdf':
      return <PdfPages u={u} />
    case 'video':
      return u.url ? (
        <video src={u.url} controls playsInline className="max-h-[70vh] w-full rounded-2xl bg-surface-2 shadow-card" aria-label={u.title} />
      ) : (
        <>
          <div className="relative w-full overflow-hidden rounded-2xl shadow-card">
            <GeneratedArt hue={u.hue} className="block aspect-video w-full" />
            <button onClick={() => setNoFootage(true)} aria-label={`Play ${u.title}`} className="absolute inset-0 grid place-items-center">
              <span className="grid size-16 place-items-center rounded-full bg-black/55 text-white transition hover:scale-105"><Play size={28} className="ml-1" fill="currentColor" aria-hidden /></span>
            </button>
            {u.durationSec !== undefined && <span className="absolute right-3 bottom-3 rounded-md bg-black/60 px-2 py-0.5 text-xs font-medium text-white tabular">{duration(u.durationSec)}</span>}
          </div>
          {noFootage ? (
            <p role="status" className="anim-in flex max-w-xl items-start gap-2 rounded-xl bg-surface px-3 py-2 text-sm text-muted shadow-card">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" aria-hidden />
              <span className="min-w-0">This example video has no footage in the demo. Upload a video of your own and it plays here.</span>
            </p>
          ) : <Caption>Example file: the poster is drawn from the video’s description.</Caption>}
          {u.previewText && <p className="w-full max-w-xl text-center text-sm">{u.previewText}</p>}
        </>
      )
    case 'audio':
      return u.url ? (
        <div className="flex w-full max-w-xl flex-col gap-3 rounded-2xl bg-surface p-5 shadow-card">
          <p className="truncate font-medium">{u.title}</p>
          <audio src={u.url} controls className="w-full" aria-label={u.title} />
        </div>
      ) : <NoPreview u={u} onDownload={() => toast('Downloads aren’t part of the demo.')} />
    default:
      return u.previewText ? (
        <>
          <article className="w-full max-w-[640px] rounded-sm bg-surface px-6 py-7 shadow-card sm:px-10">
            <pre className="font-mono text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-fg">{u.previewText}</pre>
          </article>
          <Caption>{u.previewText.length >= 2000 ? 'Showing the first 2,000 characters.' : 'Plain text file.'}</Caption>
        </>
      ) : <NoPreview u={u} onDownload={() => toast('Downloads aren’t part of the demo.')} />
  }
}

const Caption = ({ children }: { children: ReactNode }) => <p className="text-center text-xs text-muted">{children}</p>

function NoPreview({ u, onDownload }: { u: DriveUpload; onDownload: () => void }) {
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-2xl bg-surface px-6 py-10 text-center shadow-card">
      <KindIcon kind={u.kind} size="lg" />
      <p className="font-display text-lg font-semibold">No preview for this file type</p>
      <p className="text-sm text-muted">You can still share it, move it or keep versions of it here.</p>
      <Button icon={<Download size={15} />} onClick={onDownload}>Download</Button>
    </div>
  )
}

function PdfPages({ u }: { u: DriveUpload }) {
  const n = u.pages ?? 1
  const shown = Math.min(n, 3)
  const lines = sentences(u.previewText ?? '')
  return (
    <>
      {Array.from({ length: shown }, (_, i) => (
        <div key={i} className="flex w-full flex-col items-center gap-2">
          <article aria-label={`Page ${i + 1} of ${n}`} className="aspect-[1/1.414] w-full max-w-[600px] overflow-hidden rounded-sm bg-surface px-[8%] py-[9%] shadow-card">
            {i === 0 ? (
              lines.length ? (
                <div className="flex flex-col gap-3 text-[12px] leading-relaxed sm:text-[14px]">
                  <p className="font-display text-[15px] font-semibold sm:text-lg">{lines[0]}</p>
                  <div className="h-px bg-line" aria-hidden />
                  {lines.slice(1).map((l, j) => <p key={j}>{l}</p>)}
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                  <KindIcon kind="pdf" size="lg" />
                  <p className="text-sm font-medium">{u.title}</p>
                  <p className="max-w-xs text-xs text-muted">Hearth extracts text from PDFs on its servers, so the demo can’t show the inside of a PDF you upload.</p>
                </div>
              )
            ) : (
              <div className="flex flex-col gap-2.5" aria-hidden>
                {Array.from({ length: 16 }, (_, j) => <span key={j} className="h-2 rounded-full bg-surface-2" style={{ width: `${j % 5 === 4 ? 55 : 82 + ((j * 7) % 18)}%` }} />)}
              </div>
            )}
          </article>
          <p className="text-xs text-muted tabular">Page {i + 1} of {n}</p>
        </div>
      ))}
      {n > shown && <p className="text-sm text-muted">{n - shown} more {n - shown === 1 ? 'page' : 'pages'} in this file</p>}
      {u.previewText && <Caption>Example file: the demo shows the text Hearth extracted from it.</Caption>}
    </>
  )
}

// ── Details ──────────────────────────────────────────────────────────────────
function Details({ u }: { u: DriveUpload }) {
  const { state, navigate } = useStore()
  const actions = useDriveActions()
  const entry = { kind: u.kind, item: u }
  const path = folderPath(state.folders, u.folderId)
  const access = accessOf(state.folders, u)
  const people = peopleWithAccess(entry).map(p => p.personId)
  const conv = u.fromConversationId ? state.conversations.find(c => c.id === u.fromConversationId) : undefined
  const ext = u.title.includes('.') ? u.title.split('.').pop()!.toUpperCase() : undefined
  const rows: [string, ReactNode][] = [
    ['Type', `${kindNames[u.kind]}${ext && ext.length <= 5 && u.kind !== 'pdf' ? ` (${ext})` : ''}`],
    ['Size', u.size],
  ]
  if (u.pages) rows.push(['Pages', String(u.pages)])
  if (u.durationSec) rows.push(['Length', duration(u.durationSec)])
  rows.push(['Owner', <span className="inline-flex min-w-0 items-center gap-1.5"><Avatar id={u.ownerId} size="xs" /><span className="truncate">{u.ownerId === ME ? 'You' : personName(u.ownerId)}</span></span>])
  rows.push(['Modified', `${fullWhen(u.updatedAt)} by ${u.updatedBy === ME || (!u.updatedBy && u.ownerId === ME) ? 'you' : personName(u.updatedBy ?? u.ownerId)}`])
  if (u.lastOpenedAt) rows.push(['Opened', `${fullWhen(u.lastOpenedAt)} by you`])

  return (
    <div className="flex flex-col gap-6 px-5 py-5">
      <section>
        <SectionTitle>Details</SectionTitle>
        <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-2 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="min-w-0">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section>
        <SectionTitle>Location</SectionTitle>
        <div className="flex flex-wrap items-center gap-1 text-sm">
          {path.length === 0 ? (
            <button onClick={() => navigate({ name: 'drive', view: isInMyDrive(state, entry) ? 'my' : 'shared' })} className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 font-medium hover:bg-line">
              {isInMyDrive(state, entry) ? <HardDrive size={14} aria-hidden /> : <Users size={14} aria-hidden />}
              {isInMyDrive(state, entry) ? 'My Drive' : 'Shared with me'}
            </button>
          ) : path.map((f, i) => (
            <span key={f.id} className="inline-flex min-w-0 items-center gap-1">
              {i > 0 && <span className="text-muted" aria-hidden>›</span>}
              <button onClick={() => navigate({ name: 'drive', folderId: f.id })} className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 font-medium hover:bg-line">
                <FolderIcon size={14} className="shrink-0" aria-hidden /><span className="truncate">{f.title}</span>
              </button>
            </span>
          ))}
        </div>
      </section>

      <section>
        <SectionTitle>Who has access</SectionTitle>
        <div className="flex items-center gap-3">
          <AvatarStack ids={people} max={5} size="sm" />
          <p className="min-w-0 flex-1 text-sm">
            {access === 'restricted' ? (people.length > 1 ? `${people.length} people` : 'Only the owner') : generalAccessLabel(state, u, access)}
          </p>
        </div>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
          {access === 'restricted' && <Lock size={12} aria-hidden />}
          {access === 'restricted' ? 'Restricted to the people named on it' : people.length > 1 ? `Plus ${people.length - 1} named ${people.length - 1 === 1 ? 'person' : 'people'}` : `Owned by ${u.ownerId === ME ? 'you' : personName(u.ownerId)}`}
        </p>
        <Button size="sm" className="mt-2.5" icon={<UserPlus size={14} />} onClick={() => actions.share(u.id)}>{canEdit(u) ? 'Manage access' : 'See who has access'}</Button>
      </section>

      {conv && (
        <section>
          <SectionTitle>Shared in a chat</SectionTitle>
          <button onClick={() => navigate({ name: 'chats', conversationId: conv.id })} className="flex w-full items-center gap-3 rounded-2xl border border-line px-3 py-2.5 text-left transition hover:border-muted">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-muted"><Hash size={17} aria-hidden /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">Shared in {conversationLabel(conv)}</span>
              <span className="block truncate text-xs text-muted">by {personName(u.ownerId)} · {when(u.updatedAt)}</span>
            </span>
            <ArrowRight size={16} className="shrink-0 text-muted" aria-hidden />
          </button>
          <p className="mt-1.5 text-xs text-muted">Everyone in {conversationLabel(conv)} can open it. It’s listed in the chat’s shared files.</p>
        </section>
      )}

      <p className="flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-xs text-muted">
        <Search size={14} className="mt-0.5 shrink-0" aria-hidden />
        <span className="min-w-0">{u.previewText ? 'Text in this file is searchable by people who can open it.' : 'No text found in this file, so search finds it by its name only.'}</span>
      </p>

      <Versions u={u} />
    </div>
  )
}

// ── Versions (FILE-05) ───────────────────────────────────────────────────────
const article = (w: string) => (/^[AEIOU]/i.test(w) ? `an ${w.toLowerCase()}` : `a ${w.toLowerCase()}`)

function Versions({ u }: { u: DriveUpload }) {
  const { state, patchItem, toast } = useStore()
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const editable = canEdit(u)
  const versions = versionsOf(u)
  const entry = { kind: u.kind, item: u }

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    const kind = kindFromFile(f)
    if (kind !== u.kind) {
      setError(`That’s ${article(kindNames[kind])}. A new version of this file needs to be ${article(kindNames[u.kind])} too. To keep both, upload it as a new file.`)
      return
    }
    setError(null)
    let url: string | undefined
    if (kind === 'image' || kind === 'video' || kind === 'audio') {
      try { url = URL.createObjectURL(f) } catch { url = undefined }
    }
    const previewText = isTextFile(f) ? (await readStart(f)) || undefined : undefined
    const v: FileVersion = { id: newId('fv'), ts: state.clock, by: ME, name: f.name, size: formatBytes(f.size), url, previewText }
    patchItem(u.id, { versions: [v, ...versions], size: v.size, url, previewText, updatedAt: state.clock, updatedBy: ME })
    toast('New version uploaded. The previous one is kept below.')
  }

  const restore = (v: FileVersion) => {
    const copy: FileVersion = { ...v, id: newId('fv'), ts: state.clock, by: ME, note: `Restored from ${when(v.ts)}` }
    patchItem(u.id, { versions: [copy, ...versions], size: v.size, url: v.url, previewText: v.previewText, updatedAt: state.clock, updatedBy: ME })
    toast(`Restored the version from ${when(v.ts)}`)
  }

  return (
    <section>
      <SectionTitle count={versions.length}>Versions</SectionTitle>
      <ol className="divide-y divide-line">
        {versions.map((v, i) => (
          <li key={v.id} className={cx('flex items-start gap-3 py-2.5', i === 0 && 'anim-in')}>
            <span className={cx('mt-0.5 grid size-8 shrink-0 place-items-center rounded-full', i === 0 ? 'bg-accent-soft text-accent-ink' : 'bg-surface-2 text-muted')} aria-hidden><History size={15} /></span>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium">{v.name}</span>
                {i === 0 && <Pill tone="accent">Current</Pill>}
              </span>
              <span className="block text-xs text-muted">{fullWhen(v.ts)} · {v.by === ME ? 'You' : personName(v.by)} · {v.size}</span>
              {v.note && <span className="block truncate text-xs text-muted">{v.note}</span>}
            </span>
            {i > 0 && editable && <Button size="sm" variant="ghost" onClick={() => restore(v)}>Restore</Button>}
          </li>
        ))}
      </ol>
      {error && (
        <p role="alert" className="anim-in mt-2 flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
          <span className="min-w-0">{error}</span>
        </p>
      )}
      {editable ? (
        <>
          <label htmlFor="file-version-input" className="sr-only">Upload a new version</label>
          <input id="file-version-input" ref={input} type="file" className="sr-only" tabIndex={-1} onChange={onFile} />
          <Button size="sm" className="mt-2" icon={<Upload size={14} />} onClick={() => input.current?.click()}>Upload a new version</Button>
          <p className="mt-1.5 text-xs text-muted">Older versions are kept, and you can restore any of them.</p>
        </>
      ) : (
        <p className="mt-2 text-xs text-muted">Only {whoCanChange(entry)} can upload new versions.</p>
      )}
    </section>
  )
}
