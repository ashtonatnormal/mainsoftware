// Every path the app registers inside its shell (T21 item 5, OD-02). It imports no module but a
// type, so main.ts's static graph may reach it (D-02): the return path kept across sign-in and the kit's
// Back fallback are checked against this list, never against whatever a URL held. The router
// (router/router.tsx) registers exactly APP_PATHS inside its shell, and its test RO-01 holds
// the two equal; /sign-in and /notice sit outside the shell, and the splat route that catches
// unknown paths is not an app path. Reserved for a later step and deliberately absent: /admin
// (C0.16) (T21 item 5).
//
// Two lists (T21 item 5, C0.9 PD-26, PD-47):
// - NAV_PATHS: the places the phone's tab bar and More page and the rail reach (shell/nav.ts),
//   each from both layouts (NV-01);
// - APP_PATHS: NAV_PATHS and the pages no navigation lists, which a menu or a link opens: Settings
//   and its sections (/settings/*), from the avatar menu; and the DPO's pages (/dpo/*), reached
//   from the avatar menu and moved under /admin by C0.16.
import type { NoticeStanding } from '@hearth/shared'

export const NAV_PATHS = ['/today', '/chats', '/rooms', '/tasks', '/calendar', '/drive', '/more'] as const

export const APP_PATHS = [
  ...NAV_PATHS,
  '/settings',
  '/settings/privacy',
  '/dpo/purposes',
  '/dpo/transfers',
  '/dpo/notice',
] as const

export type NavPath = (typeof NAV_PATHS)[number]
export type AppPath = (typeof APP_PATHS)[number]

export const isAppPath = (path: string): path is AppPath => (APP_PATHS as readonly string[]).includes(path)

// The privacy notice's own screen, outside the shell (C0.9 PD-46).
export const NOTICE_PATH = '/notice'

// Whether a person may be on a path in the shell, by their standing with the privacy notice
// (C0.9 PD-44, PD-46; TECH-SPEC T22 items 29 and 31): having acknowledged the current version,
// anywhere; before any version is published, the DPO (registers: the session answer's capability)
// on their own pages alone, to record the registers and publish; anyone else nowhere, so the
// router sends them to /notice. The server decides every request itself (noticeAdmits() in
// packages/access); this only keeps a screen from opening that the server would refuse.
export function noticeAllowsPath(standing: NoticeStanding, registers: boolean, path: string): boolean {
  if (standing === 'acknowledged') return true
  return standing === 'unpublished' && registers && path.startsWith('/dpo/')
}
