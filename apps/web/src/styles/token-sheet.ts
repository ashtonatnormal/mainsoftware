// Reads tokens.css and app.css as text, and computes WCAG contrast, for the token tests
// (contrast.test.ts, app-css.test.ts; T21, R-11). Only those tests import it; nothing in the app
// does, so it never reaches the bundle. The stylesheets it reads hold no braces or semicolons in
// strings, so a brace matcher is enough.

export interface CssBlock {
  readonly prelude: string
  readonly body: string
}

export const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

// The blocks at the top level of `css` (comments removed first), each with its prelude, in order.
// A statement at the top level (`@import …;`, `@custom-variant …;`) is not a block and is skipped.
export function blocksOf(css: string): CssBlock[] {
  const text = withoutComments(css)
  const blocks: CssBlock[] = []
  let depth = 0
  let preludeStart = 0
  let bodyStart = 0
  let prelude = ''
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '{') {
      if (depth === 0) {
        prelude = text.slice(preludeStart, i).trim().replace(/\s+/g, ' ')
        bodyStart = i + 1
      }
      depth++
    } else if (char === '}') {
      depth--
      if (depth < 0) throw new Error(`an unmatched } at ${i}`)
      if (depth === 0) {
        blocks.push({ prelude, body: text.slice(bodyStart, i) })
        preludeStart = i + 1
      }
    } else if (char === ';' && depth === 0) {
      preludeStart = i + 1
    }
  }
  if (depth !== 0) throw new Error('an unclosed {')
  return blocks
}

// The statements at the top level (`@import "tailwindcss"`), without their semicolons.
export function statementsOf(css: string): string[] {
  const text = withoutComments(css)
  const statements: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) start = i + 1
    } else if (char === ';' && depth === 0) {
      statements.push(text.slice(start, i).trim().replace(/\s+/g, ' '))
      start = i + 1
    }
  }
  return statements
}

// The declarations of a block that holds no nested block: name → value, in order. A repeated name
// throws, since the later one would silently win.
export function declarationsOf(body: string): Map<string, string> {
  if (body.includes('{')) throw new Error('a nested block where declarations were expected')
  const declarations = new Map<string, string>()
  for (const part of withoutComments(body).split(';')) {
    const declaration = part.trim()
    if (declaration === '') continue
    const colon = declaration.indexOf(':')
    if (colon <= 0) throw new Error(`${JSON.stringify(declaration)} is not a declaration`)
    const name = declaration.slice(0, colon).trim()
    if (declarations.has(name)) throw new Error(`${name} is declared twice`)
    const value = declaration.slice(colon + 1)
    declarations.set(name, value.trim().replace(/\s+/g, ' '))
  }
  return declarations
}

// One block's body by its prelude; throws unless exactly one block has it.
export function onlyBlock(blocks: readonly CssBlock[], prelude: string): CssBlock {
  const found = blocks.filter(block => block.prelude === prelude)
  if (found.length !== 1) throw new Error(`${found.length} blocks are "${prelude}", not 1`)
  return found[0] as CssBlock
}

// The two themes of tokens.css: the light values on :root, and the dark values in the one
// prefers-color-scheme block. Each map holds every declaration of its block, custom or not.
export interface TokenSheet {
  readonly light: ReadonlyMap<string, string>
  readonly dark: ReadonlyMap<string, string>
}

export const DARK_QUERY = '@media (prefers-color-scheme: dark)'

export function readTokenSheet(css: string): TokenSheet {
  const blocks = blocksOf(css)
  const light = declarationsOf(onlyBlock(blocks, ':root').body)
  const dark = declarationsOf(onlyBlock(blocksOf(onlyBlock(blocks, DARK_QUERY).body), ':root').body)
  return { light, dark }
}

// A token's value in a theme: the dark block's value when it has one, else the light value.
export function tokenValue(sheet: TokenSheet, theme: 'light' | 'dark', name: string): string {
  const value = (theme === 'dark' ? sheet.dark.get(`--${name}`) : undefined) ?? sheet.light.get(`--${name}`)
  if (value === undefined) throw new Error(`--${name} is not declared`)
  return value
}

export type Rgb = readonly [red: number, green: number, blue: number]

// Every colour token is written #rrggbb, so this is the only colour syntax the tests read.
export function parseHex(value: string): Rgb {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value)
  if (match === null) throw new Error(`${JSON.stringify(value)} is not a #rrggbb colour`)
  return [Number.parseInt(match[1] ?? '', 16), Number.parseInt(match[2] ?? '', 16), Number.parseInt(match[3] ?? '', 16)]
}

// WCAG 2.2's relative luminance of an sRGB colour (channels 0–255).
export function relativeLuminance([red, green, blue]: Rgb): number {
  const linear = (channel: number) => {
    const c = channel / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
}

// WCAG 2.2's contrast ratio, 1 to 21, unrounded: 4.499 fails a 4.5 minimum.
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number]
  return (lighter + 0.05) / (darker + 0.05)
}
