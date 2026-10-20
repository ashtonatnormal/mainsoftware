// Every path the app registers inside its shell (T21 item 5, OD-02). It imports nothing, so
// main.ts's static graph may reach it (D-02): the return path kept across sign-in and the kit's
// Back fallback are checked against this list, never against whatever a URL held. The router
// (router/router.tsx) registers exactly these inside its shell, and its test RO-01 holds
// the two equal; /sign-in sits outside the shell, and the splat route that catches unknown paths is
// not an app path. Reserved for later steps and deliberately absent: /admin (C0.16), /settings and
// /notice (C0.9) (T21 item 5).
export const APP_PATHS = ['/today', '/chats', '/rooms', '/tasks', '/calendar', '/drive', '/more'] as const

export type AppPath = (typeof APP_PATHS)[number]

export const isAppPath = (path: string): path is AppPath => (APP_PATHS as readonly string[]).includes(path)
