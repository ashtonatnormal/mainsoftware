// Shared Drive helpers: one flat list of everything in the Drive, plus the
// rules for where an item lives, who can open or edit it, and where it opens.
import type { Deck, Doc, DriveKind, DriveMeta, DriveUpload, Folder, PersonId, Route, Sheet } from './types'
import { ME, personById } from './data/people'

export interface DriveSource {
  folders: Folder[]
  docs: Doc[]
  sheets: Sheet[]
  decks: Deck[]
  uploads: DriveUpload[]
}

export type DriveEntry =
  | { kind: 'folder'; item: Folder }
  | { kind: 'doc'; item: Doc }
  | { kind: 'sheet'; item: Sheet }
  | { kind: 'slides'; item: Deck }
  | { kind: DriveUpload['kind']; item: DriveUpload }

/** Every item in the Drive, trashed ones included (filter with isTrashed). */
export function driveEntries(s: DriveSource): DriveEntry[] {
  return [
    ...s.folders.map(item => ({ kind: 'folder' as const, item })),
    ...s.docs.map(item => ({ kind: 'doc' as const, item })),
    ...s.sheets.map(item => ({ kind: 'sheet' as const, item })),
    ...s.decks.map(item => ({ kind: 'slides' as const, item })),
    ...s.uploads.map(item => ({ kind: item.kind, item }) as DriveEntry),
  ]
}

export function findEntry(s: DriveSource, id: string): DriveEntry | undefined {
  return driveEntries(s).find(e => e.item.id === id)
}

/** Where an item opens. Folders open in the Drive. */
export function routeFor(e: { kind: DriveKind; item: { id: string } }): Route {
  switch (e.kind) {
    case 'folder': return { name: 'drive', folderId: e.item.id }
    case 'doc': return { name: 'docs', docId: e.item.id }
    case 'sheet': return { name: 'sheets', sheetId: e.item.id }
    case 'slides': return { name: 'slides', deckId: e.item.id }
    default: return { name: 'file', fileId: e.item.id }
  }
}

export const kindLabel: Record<DriveKind, string> = {
  folder: 'Folder', doc: 'Doc', sheet: 'Sheet', slides: 'Slides', pdf: 'PDF', image: 'Image', video: 'Video', audio: 'Audio', file: 'File',
}

/** Folders from the top level down to (and including) folderId. */
export function folderPath(folders: Folder[], folderId: string | null | undefined): Folder[] {
  const out: Folder[] = []
  let id = folderId
  for (let guard = 0; id && guard < 20; guard++) {
    const f = folders.find(x => x.id === id)
    if (!f) break
    out.unshift(f)
    id = f.folderId
  }
  return out
}

/** The team folder an item sits in, if any (its top-level folder with a team). */
export function teamFolderOf(folders: Folder[], item: DriveMeta): Folder | undefined {
  const top = folderPath(folders, 'team' in item && (item as Folder).team ? item.id : item.folderId)[0]
  return top?.team ? top : undefined
}

/** Trashed itself, or inside a trashed folder. */
export function isTrashed(folders: Folder[], item: DriveMeta): boolean {
  return !!item.trashed || folderPath(folders, item.folderId).some(f => f.trashed)
}

/** Effective general access: set on the item, else on the nearest folder above it
    (sharing a folder shares what's inside, team folders included), else restricted. */
export function accessOf(folders: Folder[], item: DriveMeta): NonNullable<DriveMeta['access']> {
  if (item.access) return item.access
  return [...folderPath(folders, item.folderId)].reverse().find(f => f.access)?.access ?? 'restricted'
}

export function canEdit(item: DriveMeta & { editors?: PersonId[] }, person: PersonId = ME): boolean {
  if (item.ownerId === person) return true
  if (item.editors?.includes(person)) return true
  return !!item.sharedWith?.some(g => g.personId === person && g.role === 'editor')
}

/** "Shared with me": not mine, not in a team folder, and shared with me by name or in a chat I'm in. */
export function isSharedWithMe(s: DriveSource, e: DriveEntry): boolean {
  const it = e.item
  if (it.ownerId === ME || teamFolderOf(s.folders, it)) return false
  const parent = it.folderId ? s.folders.find(f => f.id === it.folderId) : undefined
  if (parent?.ownerId === ME) return false // it's in one of my folders, so it shows in My Drive
  return canEdit(it as DriveMeta & { editors?: PersonId[] }) || !!it.sharedWith?.some(g => g.personId === ME) || ('fromConversationId' in it && !!it.fromConversationId)
}

/** "My Drive": items I own at my root, or anything in a folder I own. */
export function isInMyDrive(s: DriveSource, e: DriveEntry): boolean {
  const it = e.item
  if (teamFolderOf(s.folders, it)) return false
  const root = folderPath(s.folders, it.folderId)[0]
  return root ? root.ownerId === ME : it.ownerId === ME
}

export const ownerLabel = (id: PersonId) => (id === ME ? 'me' : personById[id]?.name ?? 'Someone')
