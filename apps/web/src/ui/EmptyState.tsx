// What a screen shows when it has nothing yet (T21; OD-02). Its title is an h2, because the
// screen's h1 is in ScreenHeader. The copy says what is true now and nothing about features to
// come (CLAUDE.md, Conventions; decision 8).
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

export interface EmptyStateProps {
  icon: LucideIcon
  title: string
  body?: string
  action?: ReactNode
}

export function EmptyState({ icon: Icon, title, body, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <Icon aria-hidden size={32} className="mb-1 text-muted" />
      <h2 className="break-words font-display text-xl font-semibold">{title}</h2>
      {body !== undefined && <p className="max-w-sm text-muted">{body}</p>}
      {action}
    </div>
  )
}
