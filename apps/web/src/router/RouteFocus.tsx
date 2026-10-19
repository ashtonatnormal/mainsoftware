// What a route change does for focus and the document's title (T21; X6, SHL-42, WCAG 2.4.2, 2.4.3).
// It renders nothing; the root route mounts it once per document.
//
// Each time the router resolves a location:
// - the document's title becomes "{the route's title} – Hearth" (a route with no title leaves it,
//   and a screen outside the router sets its own, screens/PlainScreen.tsx);
// - when the path changed, focus moves to the new screen's visible h1, or to #main when it has none,
//   without scrolling, once React has committed (lib/focus.ts). The h1 is focusable and reading it
//   announces the screen, so nothing else is said. A screen's own changes (a sign-in step) move
//   focus themselves.
// The first location of a document moves focus only when the last document asked for it (the
// one-shot hearth:focus-heading flag that session/document.ts sets on sign-in and sign-out), so a
// person who signed in lands on the new screen's h1, while a plain load or reload leaves focus where
// the browser puts it.
import { useRouter, useRouterState } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { focusAfter } from '@/lib/focus.ts'
import { takeFocusHeading } from '@/session/document.ts'
import { documentTitle } from '@/strings/shell.ts'

export function RouteFocus(): null {
  const router = useRouter()
  const resolved = useRouterState({ select: state => state.resolvedLocation?.pathname })
  const last = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (resolved === undefined) return
    const title = router.state.matches.at(-1)?.staticData.title
    if (title !== undefined) document.title = documentTitle(title)
    const first = last.current === undefined
    const moved = first ? takeFocusHeading() : resolved !== last.current
    last.current = resolved
    if (moved) focusAfter(() => undefined)
  }, [resolved, router])

  return null
}
