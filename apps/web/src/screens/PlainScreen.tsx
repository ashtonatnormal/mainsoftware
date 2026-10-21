// The frame of a screen shown without the shell (T21, D-08): the boot error, a failure above every
// screen, and the not-found and error screens when they render outside the shell. It needs no
// session runtime and no router, so it renders whatever else has failed: its own <main>, the Hearth
// mark, one h1 (focusable, data-screen-title, as every screen's is) and the screen's content,
// centred in a column that fits 320 px. It sets the document's title itself, since the router may
// not be there to.
import { Flame } from 'lucide-react'
import { type ReactNode, useEffect } from 'react'
import { documentTitle } from '@/strings/shell.ts'

export interface PlainScreenProps {
  title: string
  children: ReactNode
}

export function PlainScreen({ title, children }: PlainScreenProps) {
  useEffect(() => {
    document.title = documentTitle(title)
  }, [title])
  return (
    <main
      id="main"
      tabIndex={-1}
      className="flex min-h-dvh flex-col items-center justify-center pt-safe pb-safe px-safe"
    >
      <div className="flex w-full max-w-md flex-col items-center gap-4 px-6 py-10 text-center">
        <span aria-hidden className="grid size-12 place-items-center rounded-2xl bg-accent text-accent-fg">
          <Flame size={26} />
        </span>
        <h1 tabIndex={-1} data-screen-title className="break-words font-display text-3xl font-semibold">
          {title}
        </h1>
        {children}
      </div>
    </main>
  )
}
