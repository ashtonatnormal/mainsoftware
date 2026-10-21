// The signed-in frame every screen sits in (D-08, OD-02, T21 item 5, PRD-66, WCAG 2.4.11). The
// router renders it for the pathless _app route, which lets nobody in without a session runtime.
//
// A grid as tall as the visible viewport (100dvh), with no fixed bars: on a phone, the screen above
// and the tab bar below; from the rail breakpoint (48rem wide and 30rem tall), the rail on the left
// and the screen beside it. Inside <main>:
// - ScreenHeader, the screen's one h1 at every width (the route's title), in flow and never
//   scrolled away, with the avatar menu beside it on a phone (on the rail it is in the rail's foot).
//   It is keyed by the screen's path, so each screen gets a new h1: RouteFocus's move to it is then
//   a real focus change that a screen reader announces, even when the last screen's h1 had focus
//   (a tab press leaves it there, and Back or Forward comes next; X6, X12);
// - ConnectionBanner, which renders nothing while the live connection is fine;
// - #screen, the one scroll container, whose position the router restores within the document
//   (data-scroll-restoration-id; never across a document, D-02);
// - the Toaster, over the bottom of <main>, after #screen in reading order.
// Neither <main> nor the frame scrolls or clips, so a Menu opening from the header or the rail's foot
// lies over the screen in full (the Menu contract, ui/Menu.tsx).
//
// Focus order: on a phone, the skip link, the avatar button, the screen, the toasts, the tab bar;
// on the rail, the skip link, the rail's links, the avatar button, then the screen.
//
// A route marked immersive (C1's conversation view) hides the tab bar; none is in C0.8.
import { Outlet, useMatches } from '@tanstack/react-router'
import { useRuntime } from '@/app/runtime-context.ts'
import { ConnectionBanner } from '@/live/ConnectionBanner.tsx'
import { SHELL } from '@/strings/shell.ts'
import { ScreenHeader } from '@/ui/ScreenHeader.tsx'
import { SkipLink } from '@/ui/SkipLink.tsx'
import { Toaster } from '@/ui/Toaster.tsx'
import { AvatarMenu } from './AvatarMenu.tsx'
import { InShell } from './in-shell.ts'
import { Rail } from './Rail.tsx'
import { TabBar } from './TabBar.tsx'

export function Shell() {
  const runtime = useRuntime()
  // The deepest match's path and static data, as plain values, so the shell renders again only
  // when one of them changes.
  const path = useMatches({ select: matches => matches.at(-1)?.pathname })
  const title = useMatches({ select: matches => matches.at(-1)?.staticData.title })
  const immersive = useMatches({ select: matches => matches.at(-1)?.staticData.immersive === true })
  return (
    <>
      <SkipLink />
      <div className="wash grid h-dvh grid-rows-[minmax(0,1fr)_auto] rail:grid-cols-[auto_minmax(0,1fr)] rail:grid-rows-[minmax(0,1fr)]">
        <Rail />
        <main id="main" tabIndex={-1} className="relative flex min-h-0 min-w-0 flex-col">
          <ScreenHeader
            key={path}
            title={title ?? SHELL.appName}
            actions={
              <div className="rail:hidden">
                <AvatarMenu placement="bottom-end" />
              </div>
            }
          />
          <ConnectionBanner live={runtime.live} />
          <div
            id="screen"
            data-scroll-restoration-id="screen"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            <InShell value>
              <Outlet />
            </InShell>
          </div>
          <Toaster />
        </main>
        {!immersive && <TabBar />}
      </div>
    </>
  )
}
