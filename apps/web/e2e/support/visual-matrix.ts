// Every screenshot visual.spec.ts takes, by name (BUILD-PLAN C0.8, T21 item 11, D-07).
// Each name is the PNG's file name under e2e/__screenshots__/visual.spec.ts/, so a baseline belongs
// to exactly one shot: scripts/guards/e2e-setup.test.ts (ES-06) refuses a PNG there that isn't
// named here, and a name used twice. Baselines are made only on CI's runner and adopted from its
// artifact (adopt-baselines.ts); a local run takes no screenshot at all (ignoreSnapshots).
//
// The shots: the sign-in phone step, the code step with an error, Chats, the avatar menu open and
// Page not found, at 320, 390 and 1440 px, light and dark; More at 320 and 390 (on the rail it has
// no tab), light and dark. 34 in all.
import { SCHEMES } from './viewports.ts'

export const VISUAL_WIDTHS = [320, 390, 1440] as const
export const VISUAL_SCREENS = ['sign-in-phone', 'sign-in-code-error', 'chats', 'avatar-menu', 'not-found'] as const
export const MORE_WIDTHS = [320, 390] as const

export const shotName = (screen: string, width: number, scheme: string) => `${screen}-${width}-${scheme}.png`

export const VISUAL_SHOTS: readonly string[] = [
  ...VISUAL_SCREENS.flatMap(screen =>
    VISUAL_WIDTHS.flatMap(width => SCHEMES.map(scheme => shotName(screen, width, scheme))),
  ),
  ...MORE_WIDTHS.flatMap(width => SCHEMES.map(scheme => shotName('more', width, scheme))),
]
