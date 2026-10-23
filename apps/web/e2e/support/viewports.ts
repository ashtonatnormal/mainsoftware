// The sizes the suite looks at (PRD-66, NFR-02, T21 items 5 and 11). Phones in portrait
// from the smallest the pilot supports (320 × 568) to a common large one (390 × 844); a short wide
// window (640 × 512) and a phone on its side (667 × 375), which keep the tab bar; a tablet in
// portrait (768 × 1024), the first width with the rail; and a desktop (1440 × 900).
export interface Size {
  readonly width: number
  readonly height: number
}

export const SIZES = {
  w320: { width: 320, height: 568 },
  w360: { width: 360, height: 740 },
  w375: { width: 375, height: 667 },
  w390: { width: 390, height: 844 },
  w640: { width: 640, height: 512 },
  landscape: { width: 667, height: 375 },
  short: { width: 768, height: 480 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1440, height: 900 },
} as const satisfies Record<string, Size>

// NFR-02's phones.
export const PHONES: readonly Size[] = [SIZES.w320, SIZES.w360, SIZES.w375, SIZES.w390]

// The widths every screen is checked at with axe and for one h1 (BUILD-PLAN C0.8 Done).
export const CHECK_SIZES: readonly Size[] = [SIZES.w320, SIZES.w390, SIZES.desktop]

export const SCHEMES = ['light', 'dark'] as const

// Every route the shell serves to everyone, with its h1 (router/router.tsx): C0.8's, and Settings
// with its Privacy section (C0.9 PD-47). The DPO's pages are dpo.spec.ts's, and /notice, outside
// the shell, is sign-in.spec.ts's (SI-10) and session-end.spec.ts's (SE-05).
export const SCREENS = [
  { path: '/today', title: 'Today' },
  { path: '/chats', title: 'Chats' },
  { path: '/rooms', title: 'Rooms' },
  { path: '/tasks', title: 'Tasks' },
  { path: '/calendar', title: 'Calendar' },
  { path: '/drive', title: 'Drive' },
  { path: '/more', title: 'More' },
  { path: '/settings', title: 'Settings' },
  { path: '/settings/privacy', title: 'Privacy' },
  { path: '/xyz', title: 'Page not found' },
] as const

// Where a size puts the navigation: the rail from 48rem wide and 30rem tall (app.css's rail
// variant), the tab bar otherwise.
export const hasRail = (size: Size) => size.width >= 768 && size.height >= 480
