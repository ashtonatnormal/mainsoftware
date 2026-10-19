// The sign-in screen's frame (T21, T20; DESIGN-SHELL §5.8, AUTH-DESIGN §10): the router's /sign-in
// route, the only screen a signed-out document shows. It sits outside the shell, in its own <main>
// with its own h1. On a phone it is a column whose content sits low, in the thumb's reach (PRD-66);
// from the rail breakpoint it is a centred card.
//
// When the last document left with a reason (session/document.ts, takeLeftReason), a status line
// under the h1 says so: "You've signed out." after this tab's own Sign out, "You've been signed
// out." after anything else. The reason is read once, when the screen first renders.
//
// C0.8 S11 adds the steps (phone, code, and the PIN for privileged roles) inside this frame.
import { Flame } from 'lucide-react'
import { useState } from 'react'
import { type LeftReason, takeLeftReason } from '@/session/document.ts'
import { SIGN_IN } from '@/strings/sign-in.ts'

const leftText = (reason: LeftReason) => (reason === 'signed_out_here' ? SIGN_IN.signedOutHere : SIGN_IN.signedOut)

export function SignInScreen() {
  const [left] = useState(takeLeftReason)
  return (
    <main
      id="main"
      tabIndex={-1}
      className="flex min-h-dvh flex-col justify-end pt-safe pb-safe px-safe rail:items-center rail:justify-center"
    >
      <div className="flex w-full flex-col gap-3 px-6 py-8 rail:max-w-md rail:rounded-2xl rail:border rail:border-line rail:bg-surface rail:shadow-card">
        <span aria-hidden className="grid size-12 place-items-center rounded-2xl bg-accent text-accent-fg">
          <Flame size={26} />
        </span>
        <h1 tabIndex={-1} data-screen-title className="font-display text-2xl font-semibold">
          {SIGN_IN.heading}
        </h1>
        {left !== undefined && (
          <p role="status" className="text-muted">
            {leftText(left)}
          </p>
        )}
      </div>
    </main>
  )
}
