// The theme stylesheet's rules (SHL-46, SHL-69, X9, T21 items 5 and 6): only the tokens compile as
// colours, reduced motion stops everything, the rail needs room both ways, forced colours keep the
// Switch's state visible, the wash stays inside what the contrast pairs cover, and no stylesheet
// fetches from another host. app.css and tokens.css come in with ?raw, as in contrast.test.ts, so
// TK-10 fails on an empty or unparsed sheet instead of every other case passing on nothing.
import { describe, expect, it } from 'vitest'
import appCss from './app.css?raw'
import { GROUNDS } from './contrast-pairs.ts'
import {
  blocksOf,
  declarationsOf,
  onlyBlock,
  parseHex,
  readTokenSheet,
  statementsOf,
  tokenValue,
  withoutComments,
} from './token-sheet.ts'
import tokensCss from './tokens.css?raw'

const blocks = blocksOf(appCss)
const theme = declarationsOf(onlyBlock(blocks, '@theme').body)
const themeInline = declarationsOf(onlyBlock(blocks, '@theme inline').body)
const sheet = readTokenSheet(tokensCss)
const colourTokens = [...sheet.light.keys()].filter(name => name.startsWith('--') && name !== '--shadow')
// The two keywords the palette reset removes, declared again on their own.
const KEYWORDS = new Map([
  ['--color-transparent', 'transparent'],
  ['--color-current', 'currentColor'],
])
const mappedColours = [...themeInline].filter(([name]) => name.startsWith('--color-') && !KEYWORDS.has(name))

describe('T21: app.css', () => {
  it('TK-10 sanity: the @theme inline block maps all 39 colour tokens', () => {
    expect(appCss.length).toBeGreaterThan(0)
    expect(colourTokens).toHaveLength(39)
    expect(mappedColours).toHaveLength(39)
  })

  it('TK-05 X9 T21 item 6: the palette is reset, every @theme inline colour names a declared token, and transparent and current are explicit', () => {
    // Tailwind's default colours and families go, so bg-red-500 and text-white compile to nothing.
    expect(theme.get('--color-*')).toBe('initial')
    expect(theme.get('--font-*')).toBe('initial')
    expect([...theme.keys()].filter(name => name.startsWith('--color-') && name !== '--color-*')).toEqual([])
    // Each utility colour is its own token, by the same name: --color-wall reads var(--wall).
    for (const [name, value] of mappedColours) {
      const token = name.slice('--color-'.length)
      expect(value, name).toBe(`var(--${token})`)
      expect(colourTokens, name).toContain(`--${token}`)
    }
    expect(mappedColours.map(([name]) => `--${name.slice('--color-'.length)}`).sort()).toEqual([...colourTokens].sort())
    for (const [name, value] of KEYWORDS) expect(themeInline.get(name), name).toBe(value)
    // No other @theme block adds a colour.
    const themes = blocks.filter(block => block.prelude.startsWith('@theme'))
    expect(themes.map(block => block.prelude)).toEqual(['@theme', '@theme inline'])
  })

  it('TK-06 SHL-46: a global reduced-motion rule ends animations and transitions', () => {
    const reduced = blocksOf(onlyBlock(blocks, '@media (prefers-reduced-motion: reduce)').body)
    const all = declarationsOf(onlyBlock(reduced, '*, *::before, *::after').body)
    expect(all.get('animation-duration')).toBe('0.01ms !important')
    expect(all.get('animation-iteration-count')).toBe('1 !important')
    expect(all.get('transition-duration')).toBe('0.01ms !important')
    expect(all.get('scroll-behavior')).toBe('auto !important')
  })

  it('TK-07 T21 item 5 D-08: the rail variant needs 48rem wide and 30rem tall, so a phone on its side keeps the tab bar', () => {
    const variants = statementsOf(appCss).filter(statement => statement.startsWith('@custom-variant'))
    expect(variants).toEqual(['@custom-variant rail (@media (min-width: 48rem) and (min-height: 30rem))'])
  })

  it('TK-12 SHL-37 WCAG 1.4.11: in forced colours the Switch draws its knob and on track in system colours, so on and off differ, and the current tab keeps its outline', () => {
    const forced = blocksOf(onlyBlock(blocks, '@media (forced-colors: active)').body)
    const rule = (selector: string) => declarationsOf(onlyBlock(forced, selector).body)
    expect(forced.map(block => block.prelude)).toEqual([
      '[aria-current]:not([aria-current="false"])',
      '.switch-track',
      '.switch-knob',
      '.switch-track.switch-on',
      '.switch-on .switch-knob',
      '.wash',
    ])
    expect(rule('.wash').get('background-image')).toBe('none')
    expect(rule('[aria-current]:not([aria-current="false"])').get('outline')).toBe('2px solid CanvasText')
    // Without forced-color-adjust: none the browser repaints both backgrounds Canvas.
    const track = rule('.switch-track')
    const knob = rule('.switch-knob')
    expect(track.get('forced-color-adjust')).toBe('none')
    expect(knob.get('forced-color-adjust')).toBe('none')
    // Off: a CanvasText knob on a Canvas track; on: a HighlightText knob on a Highlight track.
    const off = { track: track.get('background-color'), knob: knob.get('background-color') }
    const on = {
      track: rule('.switch-track.switch-on').get('background-color'),
      knob: rule('.switch-on .switch-knob').get('background-color'),
    }
    expect(off).toEqual({ track: 'Canvas', knob: 'CanvasText' })
    expect(on).toEqual({ track: 'Highlight', knob: 'HighlightText' })
    expect(track.get('border')).toBe('1px solid CanvasText')
    expect(rule('.switch-track.switch-on').get('border-color')).toBe('Highlight')
  })

  it('TK-13 T21 item 6 WCAG 1.4.3: the wash is opaque and drawn only from --bg and the two wash tokens, in finance’s geometry, and each wash token moves every channel of --bg one way, so every pixel lies on a line the contrast pairs bound', () => {
    const wash = declarationsOf(onlyBlock(blocks, '@utility wash').body)
    // Nothing else: no filter, opacity, mask or blend mode that would move a pixel off those lines.
    expect([...wash.keys()]).toEqual([
      'background-color',
      'background-image',
      'background-size',
      'background-position',
      'background-repeat',
    ])
    expect(wash.get('background-color')).toBe('var(--bg)')
    // Each layer runs from its token through 40 % of it mixed into --bg to --bg itself. No stop is
    // see-through, so the top layer hides only what it draws, and no colour stop is anything else.
    // Biome lays a long value out over lines, so the comparison drops the spaces inside brackets.
    const tight = (value: string | undefined) => value?.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')')
    const layer = (token: string, circle: string) =>
      `radial-gradient(${circle}, var(--${token}), color-mix(in srgb, var(--${token}) 40%, var(--bg)) 64%, var(--bg))`
    expect(tight(wash.get('background-image'))).toBe(
      `${layer('wash-b', 'circle 32.5vmax at 32.5vmax 32.5vmax')}, ${layer('wash-a', 'circle 35vmax at 15vmax 10vmax')}`,
    )
    // The lavender layer is a 45 × 35 vmax tile in the bottom-right corner, its circle touching the
    // tile's top and left edges. The teal circle (centre 15, 10 vmax, radius 35) reaches 50 vmax
    // across and 45 down, so it can meet that tile only in a frame under 95 vmax wide and 80 vmax
    // tall; even then a pixel is --bg or one layer's, never a mix of the two.
    expect(wash.get('background-size')).toBe('45vmax 35vmax, 100% 100%')
    expect(wash.get('background-position')).toBe('100% 100%, 0 0')
    expect(wash.get('background-repeat')).toBe('no-repeat')
    // Every channel of each wash token lies one way from --bg (darker in light, lighter in dark),
    // so luminance, and with it each pair's ratio, moves one way from --bg to the token, and the
    // pairs on bg and on the token (GROUNDS) bound every pixel between.
    for (const theme of ['light', 'dark'] as const) {
      const bg = parseHex(tokenValue(sheet, theme, 'bg'))
      for (const token of ['wash-a', 'wash-b']) {
        const deltas = parseHex(tokenValue(sheet, theme, token)).map((channel, i) => channel - (bg[i] ?? 0))
        expect(
          deltas.every(delta => (theme === 'light' ? delta <= 0 : delta >= 0)),
          `${token} in ${theme}`,
        ).toBe(true)
        expect(
          deltas.some(delta => delta !== 0),
          `${token} in ${theme}`,
        ).toBe(true)
      }
    }
    expect(GROUNDS).toEqual(expect.arrayContaining(['bg', 'wash-a', 'wash-b']))

    // Nothing else styles the wash: in either sheet, at any depth (inside @layer, @supports or
    // @media too), the only rules naming it are the utility and forced colours' plain ground. A
    // .wash rule with a filter or an opacity elsewhere would move pixels off those lines.
    const rulesOf = (css: string, within: readonly string[] = []): string[] =>
      blocksOf(css).flatMap(block => [
        [...within, block.prelude].join(' > '),
        ...(block.prelude.startsWith('@') ? rulesOf(block.body, [...within, block.prelude]) : []),
      ])
    const namesWash = (rule: string) => /(?:\.wash|^@utility wash|> @utility wash)(?![\w-])/.test(rule)
    expect(rulesOf(appCss).filter(namesWash)).toEqual(['@utility wash', '@media (forced-colors: active) > .wash'])
    expect(rulesOf(tokensCss).filter(namesWash)).toEqual([])
  })

  it('TK-08 SHL-69: no url() or @import names another host', () => {
    for (const [file, css] of [
      ['app.css', appCss],
      ['tokens.css', tokensCss],
    ] as const) {
      const text = withoutComments(css)
      // Tailwind itself, and relative stylesheets beside this one; never a URL.
      const imports = statementsOf(css).filter(statement => statement.startsWith('@import'))
      for (const statement of imports) expect(statement, file).toMatch(/^@import "(?:tailwindcss|\.\/[a-z-]+\.css)"$/)
      for (const [, target] of text.matchAll(/url\(\s*["']?([^"')]*)/g)) {
        expect(target, file).not.toMatch(/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i)
      }
      expect(text, file).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/)
    }
    expect(statementsOf(appCss).filter(statement => statement.startsWith('@import'))).toEqual([
      '@import "tailwindcss"',
      '@import "./tokens.css"',
    ])
  })
})
