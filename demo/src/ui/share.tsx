// Share dialog for any Drive item (FILE-03, DOC-03). Placeholder: the Drive
// area replaces the body; the props are the contract every editor uses.
import { useStore } from '../store'
import { findEntry } from '../drive'
import { Sheet } from './index'

export function ShareDialog({ itemId, open, onClose }: { itemId: string; open: boolean; onClose: () => void }) {
  const { state } = useStore()
  const entry = findEntry(state, itemId)
  return (
    <Sheet open={open} onClose={onClose} title={entry ? `Share “${entry.item.title}”` : 'Share'}>
      <p className="pb-4 text-sm text-muted">Sharing settings are coming.</p>
    </Sheet>
  )
}
