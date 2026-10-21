// The token contrast gate (T21, X8, QA-01, SHL-23): every ink and ground the kit pairs
// (contrast-pairs.ts) keeps its WCAG minimum in both themes, read from tokens.css as written, and
// TK-11 reads Button.tsx's own variant classes for what a button paints under the pointer and
// pressed, which no token pair can see. The stylesheet and index.html come in with ?raw, which
// Vitest leaves '' for a .css file unless CSS processing is on for it (vitest.config.ts scopes that
// to src/styles/), so TK-00 fails on an empty or unparsed sheet instead of every other case passing
// on nothing.
import { describe, expect, it } from 'vitest'
import indexHtml from '../../index.html?raw'
import { BUTTON_VARIANTS, INERT_BUTTON } from '../ui/Button.tsx'
import { GROUNDS, type Pair, TEXT_PAIRS, UI_PAIRS } from './contrast-pairs.ts'
import {
  blocksOf,
  brightened,
  contrastRatio,
  DARK_QUERY,
  parseHex,
  readTokenSheet,
  relativeLuminance,
  tokenValue,
  withoutComments,
} from './token-sheet.ts'
import tokensCss from './tokens.css?raw'

const sheet = readTokenSheet(tokensCss)
const THEMES = ['light', 'dark'] as const
const customProperties = (block: ReadonlyMap<string, string>) => [...block.keys()].filter(name => name.startsWith('--'))
const colourTokens = customProperties(sheet.light).filter(name => name !== '--shadow')

// Each pair's ratio in each theme, and the ones below their minimum.
function belowMinimum(pairs: readonly Pair[]) {
  return pairs.flatMap(([fg, bg, min, why]) =>
    THEMES.flatMap(theme => {
      const ratio = contrastRatio(parseHex(tokenValue(sheet, theme, fg)), parseHex(tokenValue(sheet, theme, bg)))
      return ratio >= min ? [] : [`${fg} on ${bg} (${why}) in ${theme}: ${ratio.toFixed(2)} < ${min}`]
    }),
  )
}

// A Button's classes, folded into what it paints in each state: the fill and ink tokens and the
// brightness() factor. A state's classes override the ones before it, as the stylesheet orders
// them (hover, then active). A class this reader doesn't know fails the case, so a new state
// class can't pass unread.
type ButtonState = 'at rest' | 'under the pointer' | 'pressed with a pointer' | 'pressed by touch'
const STATE_PREFIXES: Record<ButtonState, readonly string[]> = {
  'at rest': [''],
  'under the pointer': ['', 'hover:'],
  'pressed with a pointer': ['', 'hover:', 'active:'],
  // Tailwind's hover: applies only where the pointer can hover, so a tap is rest plus active:.
  'pressed by touch': ['', 'active:'],
}
const LAYOUT_CLASS = /^cursor-not-allowed$/

function paintOf(classes: string, prefixes: readonly string[]) {
  let fill: string | undefined
  let ink: string | undefined
  let brightness = 1
  for (const name of classes.split(/\s+/).filter(Boolean)) {
    const match = /^(hover:|active:)?(?:(bg|text)-([a-z0-9-]+)|brightness-(\d+))$/.exec(name)
    if (match === null) {
      if (LAYOUT_CLASS.test(name)) continue
      throw new Error(`${name} is not a class TK-11 reads`)
    }
    const [, prefix = '', kind, token, percent] = match
    if (!prefixes.includes(prefix)) continue
    if (kind === 'bg') fill = token
    else if (kind === 'text') ink = token
    else brightness = Number(percent) / 100
  }
  return { fill, ink, brightness }
}

describe('T21: the tokens and their contrast', () => {
  // Colours here are channel triples, not literals: tokens.css is the only file in src/ that holds a
  // colour literal.
  it('the WCAG formula itself: white on black is 21:1, grey 118 on white 4.54:1, a colour on itself 1:1', () => {
    expect(relativeLuminance([255, 255, 255])).toBe(1)
    expect(relativeLuminance([0, 0, 0])).toBe(0)
    expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBe(21)
    expect(contrastRatio([118, 118, 118], [255, 255, 255])).toBeCloseTo(4.54, 2)
    expect(contrastRatio([255, 255, 255], [118, 118, 118])).toBe(contrastRatio([118, 118, 118], [255, 255, 255]))
    expect(contrastRatio([200, 77, 10], [200, 77, 10])).toBe(1)
    expect(() => parseHex('red')).toThrow(/#rrggbb/)
    expect(() => parseHex('#12')).toThrow(/#rrggbb/)
  })

  it('TK-00 sanity: the light block holds exactly its 37 custom properties (36 colours and --shadow) and the dark block 24 (the 13 avatar tokens don’t change), so an empty ?raw fails instead of passing', () => {
    expect(tokensCss.length).toBeGreaterThan(0)
    expect(customProperties(sheet.light)).toHaveLength(37)
    expect(customProperties(sheet.dark)).toHaveLength(24)
    expect(colourTokens).toHaveLength(36)
    // The light block holds tokens only; the dark block adds the canvas's scheme.
    expect([...sheet.light.keys()].filter(name => !name.startsWith('--'))).toEqual([])
    expect([...sheet.dark.keys()].filter(name => !name.startsWith('--'))).toEqual(['color-scheme'])
    // Every colour token is #rrggbb in both themes, so the pairs below read every one.
    for (const name of colourTokens) {
      for (const theme of THEMES) expect(() => parseHex(tokenValue(sheet, theme, name.slice(2))), name).not.toThrow()
    }
    // Every token a pair names is declared.
    for (const [fg, bg] of [...TEXT_PAIRS, ...UI_PAIRS]) {
      expect(colourTokens, fg).toContain(`--${fg}`)
      expect(colourTokens, bg).toContain(`--${bg}`)
    }
  })

  it('TK-01 X8 SHL-35 SHL-36 RMS-36: every text pair reaches 4.5:1 in light and dark', () => {
    expect(TEXT_PAIRS.length).toBeGreaterThan(30)
    expect(TEXT_PAIRS.every(([, , min]) => min === 4.5)).toBe(true)
    expect(belowMinimum(TEXT_PAIRS)).toEqual([])
  })

  it('TK-02 X8 SHL-37 WCAG 1.4.11: every UI pair reaches 3:1 in both themes', () => {
    expect(UI_PAIRS.length).toBeGreaterThan(10)
    expect(UI_PAIRS.every(([, , min]) => min === 3)).toBe(true)
    expect(belowMinimum(UI_PAIRS)).toEqual([])
  })

  it('TK-03 QA-01: avatar-fg reaches 4.5:1 on every avatar token, in both themes', () => {
    const avatars = colourTokens.filter(name => /^--avatar-\d+$/.test(name))
    expect(avatars).toEqual(Array.from({ length: 12 }, (_, n) => `--avatar-${n}`))
    const failures = avatars.flatMap(name =>
      THEMES.flatMap(theme => {
        const ratio = contrastRatio(
          parseHex(tokenValue(sheet, theme, 'avatar-fg')),
          parseHex(tokenValue(sheet, theme, name.slice(2))),
        )
        return ratio >= 4.5 ? [] : [`avatar-fg on ${name} in ${theme}: ${ratio.toFixed(2)}`]
      }),
    )
    expect(failures).toEqual([])
    // Each avatar fill is its own colour, so twelve people side by side get twelve fills.
    expect(new Set(avatars.map(name => sheet.light.get(name))).size).toBe(12)
  })

  it('TK-04 SHL-23 OD-08: dark values are declared once, in one prefers-color-scheme block, every token that changes has both, and no data-theme selector exists', () => {
    const text = withoutComments(tokensCss)
    const blocks = blocksOf(tokensCss)
    expect(blocks.map(block => block.prelude)).toEqual([':root', DARK_QUERY])
    expect(blocksOf(blocks[1]?.body ?? '').map(block => block.prelude)).toEqual([':root'])
    expect(text.match(/prefers-color-scheme/g)).toHaveLength(1)
    expect(text).not.toMatch(/data-theme/)
    // A dark value overrides a light one, and differs from it (a copy would be dead weight that
    // drifts); the avatar tokens stay the same in both themes.
    for (const name of customProperties(sheet.dark)) {
      expect(sheet.light.has(name), name).toBe(true)
      expect(sheet.dark.get(name), name).not.toBe(sheet.light.get(name))
    }
    expect(customProperties(sheet.dark).filter(name => name.startsWith('--avatar-'))).toEqual([])
    expect(sheet.dark.get('color-scheme')).toBe('dark')
  })

  it('TK-09 SHL-11: index.html’s two theme-color metas equal --bg in light and in dark', () => {
    const metas = [...indexHtml.matchAll(/<meta\s[^>]*name="theme-color"[^>]*>/g)].map(match => match[0])
    expect(metas).toHaveLength(2)
    const themeColour = (scheme: 'light' | 'dark') => {
      const meta = metas.find(tag => tag.includes(`media="(prefers-color-scheme: ${scheme})"`))
      return meta?.match(/\scontent="([^"]*)"/)?.[1]
    }
    for (const theme of THEMES) expect(themeColour(theme), theme).toBe(tokenValue(sheet, theme, 'bg'))
    // The canvas and form controls follow the system before the CSS arrives.
    expect(indexHtml).toMatch(/<meta name="color-scheme" content="light dark" \/>/)
  })

  it('TK-11 X8 WCAG 1.4.3: every Button variant keeps 4.5:1 at rest, under the pointer and pressed, in both themes, read from Button.tsx’s own classes (a brightness() filter scales the ink with the fill)', () => {
    const states = Object.keys(STATE_PREFIXES) as ButtonState[]
    const rows = [
      ...Object.entries(BUTTON_VARIANTS).map(([variant, classes]) => [variant, classes] as const),
      ['inert', INERT_BUTTON] as const,
    ]
    const failures = rows.flatMap(([variant, classes]) =>
      states.flatMap(state => {
        const { fill, ink, brightness } = paintOf(classes, STATE_PREFIXES[state])
        if (ink === undefined) return [`${variant} ${state}: no ink class`]
        // A variant with no fill of its own (ghost) sits on whichever page ground is behind it,
        // which the filter, if any, doesn't reach.
        const grounds: readonly string[] = fill === undefined ? GROUNDS : [fill]
        return grounds.flatMap(ground =>
          THEMES.flatMap(theme => {
            const own = fill !== undefined
            const inkRgb = brightened(parseHex(tokenValue(sheet, theme, ink)), brightness)
            const groundRgb = parseHex(tokenValue(sheet, theme, ground))
            const ratio = contrastRatio(inkRgb, own ? brightened(groundRgb, brightness) : groundRgb)
            return ratio >= 4.5
              ? []
              : [
                  `${variant} ${state}: ${ink} on ${ground} at brightness ${brightness} in ${theme}: ${ratio.toFixed(2)}`,
                ]
          }),
        )
      }),
    )
    expect(failures).toEqual([])
    // The reader sees the states it checks: the primary's hover fill, danger's filters.
    expect(paintOf(BUTTON_VARIANTS.primary, STATE_PREFIXES['under the pointer']).fill).toBe('accent-ink')
    expect(paintOf(BUTTON_VARIANTS.danger, STATE_PREFIXES['under the pointer']).brightness).toBe(1.05)
    expect(paintOf(BUTTON_VARIANTS.danger, STATE_PREFIXES['pressed with a pointer']).brightness).toBe(0.95)
    // The demo's primary hover, brightness-105 on ember, is what this case refuses.
    const demo = contrastRatio(
      brightened(parseHex(tokenValue(sheet, 'light', 'accent-fg')), 1.05),
      brightened(parseHex(tokenValue(sheet, 'light', 'accent')), 1.05),
    )
    expect(demo).toBeLessThan(4.5)
    expect(brightened([255, 255, 255], 1.05)).toEqual([255, 255, 255])
    expect(() => paintOf('bg-accent focus:bg-rec', STATE_PREFIXES['at rest'])).toThrow(/focus:bg-rec/)
  })
})
