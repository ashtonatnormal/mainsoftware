// The page's first focusable element (T21; SHL-42, X6): "Skip to content", to #main. Hidden until
// it has focus, then a 44 px pill inside the safe area, in the inverse ink and ground (bg on fg, a
// TEXT_PAIRS pair). Its focus ring is the base rule's accent ring, which sits 2 px outside the pill,
// on the page's own ground, so it takes the page's accent (accent on each ground, UI_PAIRS), not
// the inverse accent, which is for a ring drawn on an inverse ground (SHL-35). The press moves
// focus to #main itself, without a fragment navigation, which the router would read as a change of
// location.
import type { MouseEvent } from 'react'
import { UI } from './strings.ts'

export function SkipLink() {
  const skip = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    document.getElementById('main')?.focus()
  }
  return (
    // biome-ignore lint/a11y/useValidAnchor: a skip link is a link to a section of the page; the press moves focus itself, so the router never sees a fragment navigation as a change of location
    <a
      href="#main"
      onClick={skip}
      className="sr-only focus:not-sr-only focus:fixed focus:top-[max(0.75rem,env(safe-area-inset-top))] focus:left-[max(1rem,env(safe-area-inset-left))] focus:z-50 focus:inline-flex focus:min-h-11 focus:items-center focus:rounded-full focus:bg-fg focus:px-5 focus:font-semibold focus:text-bg"
    >
      {UI.skipToContent}
    </a>
  )
}
