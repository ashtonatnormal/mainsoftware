// Whether a screen renders inside the shell (T21, D-08). The shell gives every screen its one h1
// (ScreenHeader, from the route's title), its <main> and its navigation, so a screen inside it
// renders only its content. The not-found and error screens can also render outside it (an unknown
// path's backstop, a failure above the shell), where they bring their own <main> and h1; they read
// this to tell which.
import { createContext } from 'react'

export const InShell = createContext(false)
