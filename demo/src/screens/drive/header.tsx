// Pieces every file header shares (Docs, Sheets, Slides and file previews), so
// they read the same: where the file lives ("Drive › Q4 launch") and the Share
// button.
import type { ReactNode } from 'react'
import { Lock, UserPlus, Users } from 'lucide-react'
import type { DriveMeta, Route } from '../../types'
import { useStore } from '../../store'
import { findEntry, folderPath } from '../../drive'
import { ME } from '../../data/people'
import { Button, cx, IconButton } from '../../ui'
import { isShared } from './model'

/** "Drive › Q4 launch › Contract and pricing · <trailing>". Phones show just the folder it's in. */
export function FileCrumbs({ item, compact, trailing }: { item: DriveMeta; compact?: boolean; trailing?: ReactNode }) {
  const { state, navigate } = useStore()
  const path = folderPath(state.folders, item.folderId)
  const crumbs: { label: string; route: Route }[] = [
    { label: 'Drive', route: { name: 'drive' } },
    ...(path.length
      ? path.map(f => ({ label: f.title, route: { name: 'drive', folderId: f.id } as Route }))
      : [{ label: item.ownerId === ME ? 'My Drive' : 'Shared with me', route: { name: 'drive', view: item.ownerId === ME ? 'my' : 'shared' } as Route }]),
  ]
  const shown = compact ? crumbs.slice(-1) : crumbs
  return (
    <nav aria-label="Location" className="flex min-w-0 items-center gap-1 text-xs text-muted">
      {/* The folder keeps its room before the status line does. Clipped sideways only,
          so the crumbs' taller tap area isn't cut off. */}
      <span className={cx('flex min-w-0 items-center gap-1 overflow-x-clip whitespace-nowrap', !!trailing && 'max-w-[65%] shrink-0')}>
        {shown.map((c, i) => (
          <span key={i} className={cx('flex items-center gap-1', i === shown.length - 1 ? 'min-w-0' : 'shrink-0')}>
            {i > 0 && <span aria-hidden>›</span>}
            <button
              onClick={() => navigate(c.route)}
              className="-my-1 truncate rounded py-1 hover:text-fg hover:underline"
              title={compact ? crumbs.map(x => x.label).join(' › ') : undefined}
            >
              {c.label}
            </button>
          </span>
        ))}
      </span>
      {trailing && <span aria-hidden>·</span>}
      {trailing && <span className="flex min-w-0 items-center gap-1 whitespace-nowrap">{trailing}</span>}
    </nav>
  )
}

/** Share: a primary button with a padlock until people beyond the owner can open the file (same rule as the Drive's shared icon). */
export function ShareButton({ itemId, onClick, compact }: { itemId: string; onClick: () => void; compact?: boolean }) {
  const { state } = useStore()
  const entry = findEntry(state, itemId)
  const shared = !!entry && isShared(state, entry)
  if (compact) return <IconButton label="Share" onClick={onClick}><UserPlus size={20} /></IconButton>
  return (
    <Button size="sm" variant="primary" icon={shared ? <Users size={14} aria-hidden /> : <Lock size={14} aria-hidden />} onClick={onClick} title={shared ? 'Shared with others' : 'Only the people added can open it'}>
      Share
    </Button>
  )
}
