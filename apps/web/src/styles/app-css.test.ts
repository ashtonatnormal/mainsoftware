// The theme stylesheet's rules (T21, R-15, R-17, R-18, OD-28, OD-30): only the tokens compile as
// colours, reduced motion stops everything, the rail needs room both ways, forced colours keep the
// Switch's state visible, and no stylesheet fetches from another host. app.css and tokens.css come
// in with ?raw, as in contrast.test.ts, so TK-10 fails on an empty or unparsed sheet instead of
// every other case passing on nothing.
import { describe, expect, it } from 'vitest'
import appCss from './app.css?raw'
import { blocksOf, declarationsOf, onlyBlock, readTokenSheet, statementsOf, withoutComments } from './token-sheet.ts'
import tokensCss from './tokens.css?raw'

const blocks = blocksOf(appCss)
const theme = declarationsOf(onlyBlock(blocks, '@theme').body)
const themeInline = declarationsOf(onlyBlock(blocks, '@theme inline').body)
const colourTokens = [...readTokenSheet(tokensCss).light.keys()].filter(
  name => name.startsWith('--') && name !== '--shadow',
)
// The two keywords the palette reset removes, declared again on their own.
const KEYWORDS = new Map([
  ['--color-transparent', 'transparent'],
  ['--color-current', 'currentColor'],
])
const mappedColours = [...themeInline].filter(([name]) => name.startsWith('--color-') && !KEYWORDS.has(name))

describe('T21: app.css', () => {
  it('TK-10 sanity: the @theme inline block maps all 36 colour tokens', () => {
    expect(appCss.length).toBeGreaterThan(0)
    expect(colourTokens).toHaveLength(36)
    expect(mappedColours).toHaveLength(36)
  })

  it('TK-05 R-18 OD-28: the palette is reset, every @theme inline colour names a declared token, and transparent and current are explicit', () => {
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

  it('TK-06 R-15 SHL-46: a global reduced-motion rule ends animations and transitions', () => {
    const reduced = blocksOf(onlyBlock(blocks, '@media (prefers-reduced-motion: reduce)').body)
    const all = declarationsOf(onlyBlock(reduced, '*, *::before, *::after').body)
    expect(all.get('animation-duration')).toBe('0.01ms !important')
    expect(all.get('animation-iteration-count')).toBe('1 !important')
    expect(all.get('transition-duration')).toBe('0.01ms !important')
    expect(all.get('scroll-behavior')).toBe('auto !important')
  })

  it('TK-07 OD-30 D-08: the rail variant needs 48rem wide and 30rem tall, so a phone on its side keeps the tab bar', () => {
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
    ])
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

  it('TK-08 R-17 SHL-69: no url() or @import names another host', () => {
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
