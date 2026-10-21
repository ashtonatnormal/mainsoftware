// The top of every screen (T21; fixes X16, SHL-43, CHT-44). It renders the screen's one h1, so
// there is exactly one at every width (D-08): tabIndex -1 so focus can land on it after a route
// change or a step (X6), and data-screen-title so RouteFocus and focusAfter() find it. A screen
// whose title isn't shown as a heading (C1's conversation view, say) keeps the h1 for screen
// readers with `srOnlyTitle` (X16). Back goes through the router's history when there is a page
// to go back to in this tab, else to the screen's fallback, never a store of its own (CHT-44).
// `actions` sit at the end of the row (the avatar menu on phones).
import { useCanGoBack, useRouter } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import type { AppPath } from '@/router/paths.ts'
import { IconButton } from './Button.tsx'
import { cx } from './cx.ts'

export interface ScreenHeaderProps {
  title: string
  srOnlyTitle?: boolean
  back?: { label: string; fallback: AppPath }
  actions?: ReactNode
}

export function ScreenHeader({ title, srOnlyTitle = false, back, actions }: ScreenHeaderProps) {
  const heading = (
    <h1
      tabIndex={-1}
      data-screen-title
      className={cx(srOnlyTitle ? 'sr-only' : 'min-w-0 flex-1 break-words font-display text-xl font-semibold')}
    >
      {title}
    </h1>
  )
  if (srOnlyTitle && !back && !actions) return heading
  return (
    <div className="shrink-0 pt-safe px-safe">
      <div className="flex min-h-14 items-center gap-2 px-4 py-1.5">
        {back && <BackButton {...back} />}
        {heading}
        {srOnlyTitle && <span className="flex-1" />}
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
    </div>
  )
}

function BackButton({ label, fallback }: { label: string; fallback: AppPath }) {
  const router = useRouter()
  const canGoBack = useCanGoBack()
  return (
    <IconButton
      label={label}
      icon={<ArrowLeft size={22} />}
      className="-ml-2"
      onClick={() => {
        if (canGoBack) router.history.back()
        else void router.navigate({ to: fallback })
      }}
    />
  )
}
