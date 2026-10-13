import type { FileFact, FolderFact, Grantee, GrantRole, Id, ItemRole, Token } from './model.ts'
import { ITEM_ROLE_RANK } from './model.ts'
import { allows, granteeToken, ownerTokens, readersOf, trashRoot } from './readers.ts'
import type { World } from './world.ts'

export type DriveRef = { kind: 'folder' | 'file'; id: Id }

// Whether these keys make someone the item's own Owner: the owning person, or a current Team
// Admin of the owning team while it isn't archived (T13). Owning a folder above never makes you
// Owner of someone else's item.
export function isItemOwner(item: FolderFact | FileFact, keys: ReadonlySet<Token>): boolean {
  return ownerTokens(item.owner).some(token => keys.has(token))
}

// The highest role someone holds on a Drive item, ignoring the Trash: Owner for its own owner;
// otherwise the highest grant on it or a folder above it whose grantee they are, with Editor for
// the owners of the folders above (DRV-02: they rename, move, trash and re-version what's inside),
// and Viewer on a chat attachment for whoever reads its message (CHAT-06). Restricted editing
// leaves an Editor who isn't named with Commenter (DOC-03, D19). null: no role.
export function roleOn(world: World, ref: DriveRef, personId: Id, keys: ReadonlySet<Token>): ItemRole | null {
  const chain = world.driveChain(ref)
  if (!chain) return null
  const [item] = chain
  if (!item) return null
  if (isItemOwner(item, keys)) return 'owner'
  let best: GrantRole | null = null
  const raise = (role: GrantRole) => {
    if (best === null || ITEM_ROLE_RANK[role] > ITEM_ROLE_RANK[best]) best = role
  }
  const parent = 'subtype' in item ? item.parent : undefined
  if (parent?.kind === 'message') {
    if (allows(readersOf(world, { kind: 'message', id: parent.id }), keys)) raise('viewer')
  } else {
    for (const ancestor of chain.slice(1)) if (isItemOwner(ancestor, keys)) raise('editor')
  }
  for (const node of chain) {
    for (const grant of node.grants) {
      const token = granteeToken(world, grant.grantee)
      if (token && keys.has(token)) raise(grant.role)
    }
  }
  const role = best as GrantRole | null
  if (role === 'editor' && 'subtype' in item && item.editingLimitedTo !== null) {
    if (!item.editingLimitedTo.includes(personId)) return 'commenter'
  }
  return role
}

export function atLeast(role: ItemRole | null, needed: ItemRole): boolean {
  return role !== null && ITEM_ROLE_RANK[role] >= ITEM_ROLE_RANK[needed]
}

// Whether the item, or a folder above it, is in the Trash, and if so the one that was trashed.
export function trashState(
  world: World,
  ref: DriveRef,
): { inTrash: false } | { inTrash: true; root: FolderFact | FileFact } {
  const chain = world.driveChain(ref)
  const root = chain ? trashRoot(chain) : undefined
  return root ? { inTrash: true, root } : { inTrash: false }
}

// Whether someone may change who an item is shared with: its Owner, or an Editor while the Owner
// lets Editors share it (FILE-03, decision 17), a folder as much as a file. Restricted editing
// leaves an unnamed Editor out. A folder's grants reach everything in it, whatever an item's own
// switch says: an item is never less shared than its folder.
export function maySetSharing(world: World, ref: DriveRef, personId: Id, keys: ReadonlySet<Token>): boolean {
  const role = roleOn(world, ref, personId, keys)
  if (role === 'owner') return true
  if (role !== 'editor') return false
  const item =
    ref.kind === 'folder' ? world.get({ kind: 'folder', id: ref.id }) : world.get({ kind: 'file', id: ref.id })
  return item?.editorsCanShare === true
}

// Whether a grantee names someone in this org: an active person, a team in the snapshot, or the
// org itself (ACC-11). Anything else is refused as a share target.
export function granteeInOrg(world: World, grantee: Grantee): boolean {
  switch (grantee.kind) {
    case 'person':
      return world.isActivePerson(grantee.id)
    case 'team':
      return world.team(grantee.id) !== undefined
    case 'org':
      return grantee.id === world.orgId
    default:
      return false
  }
}

export function sameGrantee(a: Grantee, b: Grantee): boolean {
  return a.kind === b.kind && a.id === b.id
}
