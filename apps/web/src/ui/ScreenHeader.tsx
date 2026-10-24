// The top of every screen (T21; fixes X16, SHL-43, CHT-44). It renders the screen's one h1, so
// there is exactly one at every width (D-08): tabIndex -1 so focus can land on it after a route
// change or a step (X6), and data-screen-title so RouteFocus and focusAfter() find it. A screen
// whose title isn't shown as a heading (C1's conversation view, say) keeps the h1 for screen
// readers with `srOnlyTitle` (X16). Back goes through the router's history when there is a page
// to go back to in this tab, else to the screen's fallback, never a store of its own (CHT-44).
// `actions` sit at the end of the row (the avatar menu on phones). `titleId` is the h1's id, which
// the shell's scroll container names itself by while it is a tab stop (ui/scroller-focus.ts).
//
// The h1 is finance's page title, Newsreader 600 drawn tight, at 36 px from the rail breakpoint as
// finance's is, and 24 px on a phone, where finance's is 30 (T21 item 6): this bar never scrolls
// away (D-08) and shares its row with Back and the avatar menu, so at 320 px with 200 % text the
// h1 has 152 px, where Today and Rooms at 30 px (157 and 176 px) would break mid-word.
//
// From the rail breakpoint a shown title sits where finance's does (RAIL_TITLE_ROW): 40 px under
// the window's top edge (finance's sm:pt-10; there is no top bar on the rail), 24 px above the
// screen's content (finance's mb-6: this row's 4 px and Page's 20), and in Page's wide column
// (max-w-3xl, px-6 from sm), so the title starts where the content does. KM-05 holds the two
// columns equal.
import { useCanGoBack, useRouter } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import type { AppPath } from '@/router/paths.ts'
import { IconButton } from './Button.tsx'
import { cx } from './cx.ts'

export interface ScreenHeaderProps {
  title: string
  titleId?: string
  srOnlyTitle?: boolean
  back?: { label: string; fallback: AppPath }
  actions?: ReactNode
}

export const RAIL_TITLE_ROW = 'rail:mx-auto rail:w-full rail:max-w-3xl rail:px-6 rail:pt-10 rail:pb-1'

export function ScreenHeader({ title, titleId, srOnlyTitle = false, back, actions }: ScreenHeaderProps) {
  const heading = (
    <h1
      id={titleId}
      tabIndex={-1}
      data-screen-title
      className={cx(
        srOnlyTitle
          ? 'sr-only'
          : 'min-w-0 flex-1 break-words font-display text-2xl font-semibold tracking-tight rail:text-4xl',
      )}
    >
      {title}
    </h1>
  )
  if (srOnlyTitle && !back && !actions) return heading
  return (
    <div className="shrink-0 pt-safe px-safe">
      <div className={cx('flex min-h-14 items-center gap-2 px-4 py-1.5', !srOnlyTitle && RAIL_TITLE_ROW)}>
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
