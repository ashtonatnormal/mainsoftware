// Drive rules the screens share: who can open or add to what, which items a
// view shows, how they sort and filter, the text search looks at, and labels.
// Pure functions over the store's state (no React).
import type { Conversation, Deck, Doc, DriveKind, DriveMeta, DriveUpload, FileVersion, Folder, GeneralAccess, PersonId, Sheet, UploadKind } from '../../types'
import { accessOf, canEdit, driveEntries, folderPath, isInMyDrive, isSharedWithMe, isTrashed, teamFolderOf, type DriveEntry, type DriveSource } from '../../drive'
import { ME, ORG_NAME, personById } from '../../data/people'
import { uploads as seedUploads } from '../../data/drive'
import { clock, isToday, NOW, shortDay } from '../../time'

export type DriveState = DriveSource & { conversations: Conversation[]; clock: number }
export type TypeFilter = 'folder' | 'doc' | 'sheet' | 'slides' | 'pdf' | 'image' | 'video'
export type SortKey = 'name' | 'modified' | 'owner'

export const typeFilters: { value: TypeFilter; label: string }[] = [
  { value: 'folder', label: 'Folders' },
  { value: 'doc', label: 'Docs' },
  { value: 'sheet', label: 'Sheets' },
  { value: 'slides', label: 'Slides' },
  { value: 'pdf', label: 'PDFs' },
  { value: 'image', label: 'Images' },
  { value: 'video', label: 'Videos' },
]

export const sortLabels: Record<SortKey, string> = { name: 'Name', modified: 'Last modified', owner: 'Owner' }

export const isEditableKind = (k: DriveKind) => k === 'doc' || k === 'sheet' || k === 'slides'
export const editorsOf = (e: DriveEntry): PersonId[] => ('editors' in e.item ? (e.item as Doc | Sheet | Deck).editors : [])

// ── Access (FILE-03, Rule 1: the Drive and search mirror what you can open) ──
/** A team folder's team: the people whose directory team has that name, or a group chat named after it. */
export function inTeam(team: string, conversations: Conversation[], person: PersonId = ME) {
  return personById[person]?.team === team || conversations.some(c => c.name === team && c.members.includes(person))
}

/** The team that "team" access refers to: the team folder's team, else the owner's team. */
export function teamNameOf(s: DriveSource, item: DriveMeta) {
  return teamFolderOf(s.folders, item)?.team ?? personById[item.ownerId]?.team ?? 'the team'
}

export function canOpen(s: DriveState, e: DriveEntry, person: PersonId = ME): boolean {
  const it = e.item
  if (it.ownerId === person || canEdit(it as DriveMeta & { editors?: PersonId[] }, person)) return true
  if (it.sharedWith?.some(g => g.personId === person)) return true
  // Named on a folder above it.
  if (folderPath(s.folders, it.folderId).some(f => f.ownerId === person || f.sharedWith?.some(g => g.personId === person))) return true
  const access = accessOf(s.folders, it)
  if (access === 'org') return true
  if (access === 'team' && inTeam(teamNameOf(s, it), s.conversations, person)) return true
  // FILE-08: shared in a chat you're in.
  const conv = 'fromConversationId' in it ? (it as DriveUpload).fromConversationId : undefined
  return !!conv && s.conversations.some(c => c.id === conv && c.members.includes(person))
}

/** Can you add files to this folder (null = My Drive)? */
export function canAddTo(s: DriveState, folderId: string | null): boolean {
  if (!folderId) return true
  const f = s.folders.find(x => x.id === folderId)
  if (!f || isTrashed(s.folders, f)) return false
  if (canEdit(f)) return true
  const path = folderPath(s.folders, folderId)
  if (path[0]?.ownerId === ME) return true
  const team = teamFolderOf(s.folders, f)
  return !!team?.team && inTeam(team.team, s.conversations)
}

/** Who can change sharing, rename, move or trash: the owner and editors. */
export function whoCanChange(e: DriveEntry) {
  const owner = personName(e.item.ownerId)
  return isEditableKind(e.kind) ? `${owner} and editors` : owner
}

export function generalAccessLabel(s: DriveSource, item: DriveMeta, a: GeneralAccess = accessOf(s.folders, item)) {
  if (a === 'org') return `Everyone at ${ORG_NAME}`
  if (a === 'team') return `Everyone in ${teamNameOf(s, item)}`
  return 'Restricted'
}

/** Everyone named on an item: owner first, then editors, then people it's shared with. */
export function peopleWithAccess(e: DriveEntry): { personId: PersonId; role: 'owner' | 'editor' | 'commenter' | 'viewer' }[] {
  const out: { personId: PersonId; role: 'owner' | 'editor' | 'commenter' | 'viewer' }[] = [{ personId: e.item.ownerId, role: 'owner' }]
  for (const id of editorsOf(e)) if (!out.some(o => o.personId === id)) out.push({ personId: id, role: 'editor' })
  for (const g of e.item.sharedWith ?? []) if (!out.some(o => o.personId === g.personId)) out.push({ personId: g.personId, role: g.role })
  return out
}

/** Shared beyond its owner: general access isn't restricted, or other people are named on it. */
export function isShared(s: DriveSource, e: DriveEntry) {
  return accessOf(s.folders, e.item) !== 'restricted' || peopleWithAccess(e).length > 1
}

// ── Views ────────────────────────────────────────────────────────────────────
/** Everything you can open that isn't in the trash. */
export function liveEntries(s: DriveState) {
  return driveEntries(s).filter(e => !isTrashed(s.folders, e.item) && canOpen(s, e))
}

export function childrenOf(s: DriveState, folderId: string) {
  return driveEntries(s).filter(e => e.item.folderId === folderId && !e.item.trashed && canOpen(s, e))
}

export const myDriveRoot = (s: DriveState) => liveEntries(s).filter(e => e.item.folderId === null && isInMyDrive(s, e))
export const sharedWithMe = (s: DriveState) => liveEntries(s).filter(e => isSharedWithMe(s, e))
export const starred = (s: DriveState) => liveEntries(s).filter(e => e.item.starred)
export const teamFolders = (s: DriveState) => s.folders.filter(f => f.team && f.folderId === null && !f.trashed && canOpen(s, { kind: 'folder', item: f }))

/** "Recent": files by when you last opened them, else when they last changed. */
export const recentKey = (it: DriveMeta) => it.lastOpenedAt ?? it.updatedAt
export const recent = (s: DriveState) => liveEntries(s).filter(e => e.kind !== 'folder').sort((a, b) => recentKey(b.item) - recentKey(a.item))
export const suggested = (s: DriveState) => liveEntries(s).filter(e => e.kind !== 'folder' && e.item.lastOpenedAt).sort((a, b) => b.item.lastOpenedAt! - a.item.lastOpenedAt!).slice(0, 4)

/** Trashed items whose folder isn't itself in the trash (those come back with it). */
export const trashTop = (s: DriveState) =>
  driveEntries(s).filter(e => e.item.trashed && !folderPath(s.folders, e.item.folderId).some(f => f.trashed) && canOpen(s, e)).sort((a, b) => (b.item.trashedAt ?? 0) - (a.item.trashedAt ?? 0))

/** Where a folder lives in the sidebar: a team folder, My Drive or Shared with me. */
export function rootViewOf(s: DriveState, folderId: string | null | undefined): 'home' | 'my' | 'shared' {
  if (!folderId) return 'my'
  const f = s.folders.find(x => x.id === folderId)
  if (!f) return 'home'
  if (teamFolderOf(s.folders, f)) return 'home'
  return isInMyDrive(s, { kind: 'folder', item: f }) ? 'my' : 'shared'
}

export const rootLabel = { home: 'Team folders', my: 'My Drive', shared: 'Shared with me' } as const

// ── Sort and filter ──────────────────────────────────────────────────────────
export function matchesType(e: DriveEntry, t: TypeFilter | null) {
  return !t || e.kind === t
}

export function sortEntries(list: DriveEntry[], key: SortKey, foldersFirst = true) {
  const byName = (a: DriveEntry, b: DriveEntry) => a.item.title.localeCompare(b.item.title, 'en', { numeric: true, sensitivity: 'base' })
  const cmp = (a: DriveEntry, b: DriveEntry) => {
    if (foldersFirst && (a.kind === 'folder') !== (b.kind === 'folder')) return a.kind === 'folder' ? -1 : 1
    if (key === 'name') return byName(a, b)
    if (key === 'owner') {
      const oa = a.item.ownerId === ME ? '' : personName(a.item.ownerId)
      const ob = b.item.ownerId === ME ? '' : personName(b.item.ownerId)
      return oa.localeCompare(ob) || byName(a, b)
    }
    return b.item.updatedAt - a.item.updatedAt
  }
  return [...list].sort(cmp)
}

// ── Text (FILE-06): what search reads inside each kind ───────────────────────
export function textOf(e: DriveEntry): string {
  switch (e.kind) {
    case 'folder': return e.item.description ?? ''
    case 'doc': return e.item.blocks.map(b => b.text).join(' ')
    case 'sheet': return e.item.tabs.flatMap(t => Object.values(t.cells).map(c => c.v).filter(v => v && !v.startsWith('='))).join(' ')
    case 'slides': return e.item.slides.map(slideText).join(' ')
    default: return (e.item as DriveUpload).previewText ?? ''
  }
}

export const slideText = (sl: Deck['slides'][number]) =>
  [sl.title, sl.subtitle, ...(sl.bullets ?? []), sl.left?.heading, ...(sl.left?.bullets ?? []), sl.right?.heading, ...(sl.right?.bullets ?? []), sl.stat, sl.statLabel].filter(Boolean).join(' · ')

/** Case-insensitive filter over names and extracted text; returns a snippet for text hits. */
export function filterByQuery(list: DriveEntry[], q: string): { entry: DriveEntry; snippet?: string }[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return list.map(entry => ({ entry }))
  const out: { entry: DriveEntry; snippet?: string; score: number }[] = []
  for (const entry of list) {
    const inTitle = entry.item.title.toLowerCase().includes(needle)
    const snippet = snippetFor(entry, needle)
    if (!inTitle && !snippet) continue
    out.push({ entry, snippet, score: inTitle ? 2 : 1 })
  }
  return out.sort((a, b) => b.score - a.score || recentKey(b.entry.item) - recentKey(a.entry.item))
}

/** The line of a file's text that matches: a doc block, a sheet row, a slide line, or a window of an upload's text. */
function snippetFor(e: DriveEntry, needle: string): string | undefined {
  const has = (t?: string) => !!t && t.toLowerCase().includes(needle)
  switch (e.kind) {
    case 'doc': {
      const b = e.item.blocks.find(x => x.type !== 'h1' && has(x.text))
      return b ? around(b.text, needle) : undefined
    }
    case 'sheet': {
      for (const t of e.item.tabs) {
        const typed = Object.entries(t.cells).filter(([, c]) => c.v && !c.v.startsWith('='))
        const hit = typed.find(([, c]) => has(c.v))
        if (!hit) continue
        const row = hit[0].replace(/^[A-Z]+/, '')
        const vals = typed.filter(([a]) => a.replace(/^[A-Z]+/, '') === row).sort(([a], [b]) => a.localeCompare(b)).map(([, c]) => (Number.isNaN(Number(c.v)) ? c.v : Number(c.v).toLocaleString('en-SG')))
        return `${e.item.tabs.length > 1 ? `${t.name} · ` : ''}Row ${row}: ${vals.join(' · ')}`
      }
      return undefined
    }
    case 'slides': {
      for (const [i, sl] of e.item.slides.entries()) {
        const line = [sl.title, sl.subtitle, ...(sl.bullets ?? []), sl.left?.heading, ...(sl.left?.bullets ?? []), sl.right?.heading, ...(sl.right?.bullets ?? []), sl.stat && `${sl.stat} ${sl.statLabel ?? ''}`].find(x => has(x || undefined))
        if (line) return `Slide ${i + 1}: ${around(line, needle)}`
      }
      return undefined
    }
    default: {
      const text = textOf(e)
      return has(text) ? around(text, needle) : undefined
    }
  }
}

function around(text: string, needle: string, max = 120) {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const at = clean.toLowerCase().indexOf(needle)
  let start = Math.max(0, at - 40)
  if (start > 0) start = clean.lastIndexOf(' ', start) + 1
  const end = Math.min(clean.length, start + max)
  return `${start > 0 ? '…' : ''}${clean.slice(start, end).trim()}${end < clean.length ? '…' : ''}`
}

// ── Labels ───────────────────────────────────────────────────────────────────
export const personName = (id: PersonId) => (id === ME ? 'You' : personById[id]?.name ?? 'Someone')
export const personFirst = (id: PersonId) => (id === ME ? 'me' : personById[id]?.short ?? 'Someone')
const weekday = new Intl.DateTimeFormat('en-SG', { timeZone: 'Asia/Singapore', weekday: 'short' })
const dayMonth = new Intl.DateTimeFormat('en-SG', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short' })

/** "8:20 am", "Fri 7:20 pm", "28 Sep" */
export function when(ms: number) {
  if (isToday(ms)) return clock(ms)
  if (NOW - ms < 6 * 86_400_000 && ms <= NOW + 86_400_000) return `${weekday.format(ms)} ${clock(ms)}`
  return dayMonth.format(ms)
}

/** "Mon 12 Oct, 8:20 am" */
export const fullWhen = (ms: number) => `${shortDay(ms)}, ${clock(ms)}`

/** "Fri 7:20 pm · Marcus" */
export const modifiedLabel = (it: DriveMeta) => `${when(it.updatedAt)} · ${personFirst(it.updatedBy ?? it.ownerId)}`

export const ownerLabel = (id: PersonId) => (id === ME ? 'me' : personById[id]?.name ?? 'Someone')

export function sizeOf(e: DriveEntry): string | undefined {
  return 'size' in e.item ? (e.item as DriveUpload).size : undefined
}

export const folderDot: Record<NonNullable<Folder['color']>, string> = {
  ember: 'bg-accent', teal: 'bg-agent', green: 'bg-ok', amber: 'bg-warn', slate: 'bg-muted', rose: 'bg-rec',
}

export const kindNames: Record<DriveKind, string> = {
  folder: 'Folder', doc: 'Document', sheet: 'Spreadsheet', slides: 'Presentation', pdf: 'PDF document', image: 'Image', video: 'Video', audio: 'Audio', file: 'File',
}

// ── Files and sizes ──────────────────────────────────────────────────────────
export function kindFromFile(f: { type: string; name: string }): UploadKind {
  const t = f.type.toLowerCase()
  const ext = f.name.toLowerCase().split('.').pop() ?? ''
  if (t === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (t.startsWith('image/')) return 'image'
  if (t.startsWith('video/')) return 'video'
  if (t.startsWith('audio/')) return 'audio'
  return 'file'
}

const TEXT_EXT = ['txt', 'md', 'csv', 'tsv', 'json', 'log', 'xml', 'html', 'htm', 'yml', 'yaml']
export function isTextFile(f: { type: string; name: string }) {
  const ext = f.name.toLowerCase().split('.').pop() ?? ''
  return f.type.startsWith('text/') || f.type === 'application/json' || TEXT_EXT.includes(ext)
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} bytes`
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1).replace(/\.0$/, '')} MB`
  return `${(n / 1024 ** 3).toFixed(1).replace(/\.0$/, '')} GB`
}

export function parseSize(label: string) {
  const m = /([\d.]+)\s*(bytes|KB|MB|GB)/i.exec(label)
  if (!m) return 0
  const unit = { bytes: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[m[2].toLowerCase() as 'bytes'] ?? 1
  return Number(m[1]) * unit
}

/** Reads the first 2,000 characters of a text file for preview and search (FILE-06). */
export function readStart(file: File, chars = 2000): Promise<string> {
  return new Promise(resolve => {
    try {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result ?? '').slice(0, chars))
      r.onerror = () => resolve('')
      r.readAsText(file.slice(0, chars * 4))
    } catch {
      resolve('')
    }
  })
}

// FILE-07: your quota. The seeded figure stands in for files from before the demo.
const QUOTA = 30 * 1024 ** 3
const SEEDED = 3.2 * 1024 ** 3
const seedIds = new Set(seedUploads.map(u => u.id))
export function storage(s: DriveState) {
  const added = s.uploads.filter(u => u.ownerId === ME && !seedIds.has(u.id)).reduce((n, u) => n + parseSize(u.size), 0)
  const used = SEEDED + added
  return { used, quota: QUOTA, label: `${formatBytes(used)} of ${formatBytes(QUOTA)} used`, pct: Math.min(100, (used / QUOTA) * 100) }
}

/** The versions of an upload, newest first. Seeded files have just their original. */
export function versionsOf(u: DriveUpload): FileVersion[] {
  return u.versions?.length ? u.versions : [{ id: `${u.id}_v1`, ts: u.updatedAt, by: u.updatedBy ?? u.ownerId, name: u.title, size: u.size, url: u.url, previewText: u.previewText }]
}

export const linkFor = (id: string) => `https://hearth.tembusu.example/d/${id}`
