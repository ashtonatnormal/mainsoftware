// The web bundle's budget and a scan of what it ships (T21 item 12; DESIGN-SHELL §10.6, OD-15,
// R-61, K-01, QA-01). It runs after the build, in CI's check job and before a PR:
//
//   npm run build && node scripts/check-web-dist.ts
//
// From apps/web/dist/.vite/manifest.json it measures four figures and compares each with
// apps/web/bundle-budget.json, set at what the build measured plus about 20% (OD-15). Raising one
// is a reviewed change that says why.
// - initialJsGzip: what every first visit loads before a screen shows, gzip: index.html's entry
//   chunk and the app/boot.tsx chunk it always loads (main.ts imports it dynamically, after
//   preBoot(); WS-10), with every chunk either reaches through static imports;
// - initialCssGzip: the CSS those chunks link, gzip;
// - largestLazyJsGzip: the largest of every other JS chunk (a screen loaded on its route), gzip;
// - fontsLatinBytes: the latin font files the CSS names, as stored (woff2 is compressed already).
// gzip is Node's default level, as a CDN compresses; brotli is printed beside it, for information.
//
// Then it scans every text file in dist/ and fails on:
// - an inline script (an element without src, or with a body), an inline event handler, a style
//   element or a style attribute in index.html, which the CSP without 'unsafe-inline' would block
//   (K-01);
// - a data: URL in CSS, which the CSP doesn't allow either;
// - a public npm CDN or a model host (the patterns ai-free.ts keeps), or Google Fonts: the app
//   loads its code and fonts from its own origin only (R-61, R-17);
// - __hearth, a test hook that must never ship (SHL-26);
// - a built CSS without a .bg-avatar-N rule for each of the twelve avatar fills, which proves
//   Tailwind compiled the class names AVATAR_BG spells whole (R2-09).
// It prints a table and exits 1 on any failure.
//
// It holds no CDN or model host itself, since ai-free's text check reads every script outside
// scripts/guards/: the patterns come from scripts/guards/ai-free.ts, and its tests, which plant
// those hosts on purpose, are scripts/guards/web-dist.test.ts (DT-01 to DT-05). It runs under plain
// Node 24, so its relative imports name the .ts file.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { AVATAR_BG } from '../apps/web/src/ui/avatar-hue.ts'
import { CDN_URL, MODEL_HOST } from './guards/ai-free.ts'

export const REPO_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const WEB_DIR = join(REPO_DIR, 'apps/web')
export const DIST_DIR = join(WEB_DIR, 'dist')
export const BUDGET_FILE = join(WEB_DIR, 'bundle-budget.json')

// The chunk index.html's entry always loads by its one dynamic import (src/main.ts).
export const BOOT_SRC = 'src/app/boot.tsx'

// One entry of Vite's build manifest (build.manifest in apps/web/vite.config.ts).
export interface ManifestChunk {
  file: string
  src?: string
  name?: string
  isEntry?: boolean
  isDynamicEntry?: boolean
  imports?: string[]
  dynamicImports?: string[]
  css?: string[]
  assets?: string[]
}
export type Manifest = Record<string, ManifestChunk>

// The budget's figures, in this order in the table and in bundle-budget.json.
export const FIGURES = ['initialJsGzip', 'initialCssGzip', 'largestLazyJsGzip', 'fontsLatinBytes'] as const
export type Figure = (typeof FIGURES)[number]
export type Figures = Record<Figure, number>

const LABELS: Record<Figure, string> = {
  initialJsGzip: 'initial JS, gzip',
  initialCssGzip: 'initial CSS, gzip',
  largestLazyJsGzip: 'largest lazy chunk, gzip',
  fontsLatinBytes: 'latin fonts, bytes',
}

// What a first visit loads (DT-01): the manifest keys of the initial chunks, their JS files and the
// CSS files they link. The one HTML entry and the boot chunk, each with every chunk its static
// imports reach (a cycle back to the entry, as boot's import of it, is followed once).
export function initialSet(manifest: Manifest): { keys: string[]; js: string[]; css: string[] } {
  const entries = Object.entries(manifest).filter(([key, chunk]) => chunk.isEntry && /\.html$/.test(chunk.src ?? key))
  if (entries.length !== 1) {
    throw new Error(`expected one HTML entry in the manifest, found ${entries.length}`)
  }
  const [entryKey, entry] = entries[0] as [string, ManifestChunk]
  if (!entry.dynamicImports?.includes(BOOT_SRC) || manifest[BOOT_SRC] === undefined) {
    throw new Error(`${entryKey} no longer loads ${BOOT_SRC}: update check-web-dist.ts's initial set`)
  }
  const keys: string[] = []
  const visit = (key: string) => {
    if (keys.includes(key)) return
    const chunk = manifest[key]
    if (chunk === undefined) throw new Error(`the manifest names ${key} but has no entry for it`)
    keys.push(key)
    for (const next of chunk.imports ?? []) visit(next)
  }
  visit(entryKey)
  visit(BOOT_SRC)
  const chunks = keys.map(key => manifest[key] as ManifestChunk)
  return {
    keys,
    js: chunks.map(chunk => chunk.file).filter(file => /\.m?js$/.test(file)),
    css: [...new Set(chunks.flatMap(chunk => chunk.css ?? []))],
  }
}

// Every JS chunk outside the initial set: the screens and anything only they import.
export function lazyChunks(manifest: Manifest): string[] {
  const initial = new Set(initialSet(manifest).js)
  const files = Object.values(manifest)
    .map(chunk => chunk.file)
    .filter(file => /\.m?js$/.test(file) && !initial.has(file))
  return [...new Set(files)]
}

// The latin font files a stylesheet names (url(…) of a *-latin-*.woff2, not latin-ext), as paths
// relative to dist/: Vite writes them from the site's root (/assets/…), and a relative URL is
// resolved against the stylesheet's own folder.
export function latinFonts(css: string, cssPath: string): string[] {
  const urls = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map(match => match[2] ?? '')
  const fonts = urls
    .filter(url => /-latin-(?!ext-)[\w-]*\.woff2$/.test(url))
    .map(url => (url.startsWith('/') ? url.slice(1) : posix.join(posix.dirname(cssPath), url)))
  return [...new Set(fonts)]
}

// bundle-budget.json, which must hold exactly the four figures, each a positive whole number.
export function parseBudget(json: unknown): Figures {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('the budget is not an object')
  const keys = Object.keys(json)
  const unknown = keys.filter(key => !(FIGURES as readonly string[]).includes(key))
  const missing = FIGURES.filter(figure => !keys.includes(figure))
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `the budget's figures are ${FIGURES.join(', ')} (unknown: ${unknown.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'})`,
    )
  }
  const budget = json as Record<string, unknown>
  for (const figure of FIGURES) {
    const value = budget[figure]
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error(`the budget's ${figure} is not a positive whole number of bytes`)
    }
  }
  return budget as Figures
}

const bytes = (n: number) => n.toLocaleString('en-GB')

// Each figure over its budget, named (DT-03). A figure equal to its budget passes.
export function overBudget(measured: Figures, budget: Figures): string[] {
  return FIGURES.filter(figure => measured[figure] > budget[figure]).map(
    figure =>
      `${figure} (${LABELS[figure]}) is ${bytes(measured[figure])} bytes, over its budget of ${bytes(budget[figure])}`,
  )
}

// A file under dist/, its path relative to dist/ with forward slashes, and its text.
export interface DistFile {
  path: string
  text: string
}

// The files the scan reads as text; fonts and images are binary.
export const isTextFile = (path: string) => /\.(?:html?|m?js|css|json|svg|txt|xml|webmanifest|map)$/i.test(path)

const GOOGLE_FONTS = /\bfonts\.(?:googleapis|gstatic)\.com\b/i
const TEST_HOOK = /__hearth/
const DATA_URL_IN_CSS = /url\(\s*['"]?\s*data:/i

// What index.html carries inline (K-01): comments aside, since a comment runs nothing.
function inlineInPage(html: string): string[] {
  const page = html.replace(/<!--[\s\S]*?-->/g, '')
  const found: string[] = []
  for (const match of page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attributes = match[1] ?? ''
    if (!/\ssrc\s*=/i.test(` ${attributes}`) || (match[2] ?? '').trim() !== '') found.push('an inline <script>')
  }
  if (/<style\b/i.test(page)) found.push('a <style> element')
  for (const tag of page.matchAll(/<[a-z][\w-]*\b([^>]*)>/gi)) {
    const attributes = tag[1] ?? ''
    if (/\sstyle\s*=/i.test(attributes)) found.push('a style= attribute')
    if (/\son[a-z]+\s*=/i.test(attributes)) found.push('an inline event handler (on…=)')
  }
  return [...new Set(found)]
}

// Every problem the scan finds in dist/ (DT-02), each naming its file.
export function scanDist(files: readonly DistFile[]): string[] {
  const problems: string[] = []
  const page = files.find(file => file.path === 'index.html')
  if (page === undefined) problems.push('index.html: missing')
  else for (const what of inlineInPage(page.text)) problems.push(`index.html: ${what}`)
  for (const file of files) {
    if (/\.css$/i.test(file.path) && DATA_URL_IN_CSS.test(file.text)) problems.push(`${file.path}: a data: URL`)
    const cdn = [...file.text.matchAll(CDN_URL)].map(match => match[0])
    if (cdn.length > 0) problems.push(`${file.path}: a public npm CDN (${[...new Set(cdn)].slice(0, 3).join(', ')})`)
    const model = [...file.text.matchAll(MODEL_HOST)].map(match => match[0])
    if (model.length > 0) problems.push(`${file.path}: a model host (${[...new Set(model)].slice(0, 3).join(', ')})`)
    if (GOOGLE_FONTS.test(file.text)) problems.push(`${file.path}: Google Fonts`)
    if (TEST_HOOK.test(file.text)) problems.push(`${file.path}: the __hearth test hook`)
  }
  return problems
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The avatar fills a built stylesheet has no rule for (DT-04): each AVATAR_BG class needs a rule
// that sets its background to its own token, so .bg-avatar-10 doesn't stand in for .bg-avatar-1.
export function missingAvatarRules(css: string): string[] {
  return AVATAR_BG.filter((name, n) => {
    const rule = new RegExp(
      `\\.${escapeRegExp(name)}(?![\\w-])[^{}]*\\{[^}]*\\bbackground(?:-color)?\\s*:\\s*var\\(\\s*--avatar-${n}\\s*\\)`,
    )
    return !rule.test(css)
  })
}

// Every file under a folder, relative to it, with forward slashes.
function filesUnder(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? filesUnder(path, base) : [relative(base, path).split('\\').join('/')]
  })
}

const gzip = (buffer: Buffer) => gzipSync(buffer).length
const brotli = (buffer: Buffer) => brotliCompressSync(buffer).length

// The four figures of a build, with brotli beside the gzip ones, and the files each counts.
export function measure(distDir: string): {
  figures: Figures
  brotli: Partial<Figures>
  counted: Record<Figure, string[]>
} {
  const manifest = JSON.parse(readFileSync(join(distDir, '.vite/manifest.json'), 'utf8')) as Manifest
  const read = (file: string) => readFileSync(join(distDir, file))
  const sum = (files: string[], size: (buffer: Buffer) => number) =>
    files.reduce((total, file) => total + size(read(file)), 0)
  const initial = initialSet(manifest)
  const lazy = lazyChunks(manifest).map(file => ({ file, gzip: gzip(read(file)) }))
  const largest = lazy.reduce<{ file: string; gzip: number } | undefined>(
    (best, chunk) => (best === undefined || chunk.gzip > best.gzip ? chunk : best),
    undefined,
  )
  const fonts = [...new Set(initial.css.flatMap(file => latinFonts(read(file).toString('utf8'), file)))]
  if (fonts.length === 0) throw new Error('the initial CSS names no latin font file: did the fonts move?')
  return {
    figures: {
      initialJsGzip: sum(initial.js, gzip),
      initialCssGzip: sum(initial.css, gzip),
      largestLazyJsGzip: largest?.gzip ?? 0,
      fontsLatinBytes: sum(fonts, buffer => buffer.length),
    },
    brotli: {
      initialJsGzip: sum(initial.js, brotli),
      initialCssGzip: sum(initial.css, brotli),
      largestLazyJsGzip: largest === undefined ? 0 : brotli(read(largest.file)),
    },
    counted: {
      initialJsGzip: initial.js,
      initialCssGzip: initial.css,
      largestLazyJsGzip: largest === undefined ? [] : [largest.file],
      fontsLatinBytes: fonts,
    },
  }
}

function main(): void {
  if (!existsSync(join(DIST_DIR, '.vite/manifest.json'))) {
    console.error('There is no build with a manifest in apps/web/dist. Build first: npm run build -w @hearth/web')
    process.exit(1)
  }
  const budget = parseBudget(JSON.parse(readFileSync(BUDGET_FILE, 'utf8')))
  const { figures, brotli: brotliFigures, counted } = measure(DIST_DIR)
  const pad = (text: string, width: number) => text.padStart(width)
  console.log(`The web bundle (apps/web/dist) against ${relative(REPO_DIR, BUDGET_FILE)} (T21, OD-15):`)
  console.log(`  ${'figure'.padEnd(28)}${pad('measured', 10)}${pad('budget', 10)}${pad('brotli', 10)}  files`)
  for (const figure of FIGURES) {
    const br = brotliFigures[figure]
    console.log(
      `  ${LABELS[figure].padEnd(28)}${pad(bytes(figures[figure]), 10)}${pad(bytes(budget[figure]), 10)}` +
        `${pad(br === undefined ? '-' : bytes(br), 10)}  ${counted[figure].join(', ')}`,
    )
  }
  const files = filesUnder(DIST_DIR)
    .filter(isTextFile)
    .map(path => ({ path, text: readFileSync(join(DIST_DIR, path), 'utf8') }))
  const css = files
    .filter(file => /\.css$/i.test(file.path))
    .map(file => file.text)
    .join('\n')
  const missing = missingAvatarRules(css)
  const problems = [
    ...overBudget(figures, budget),
    ...scanDist(files),
    ...(missing.length > 0 ? [`the built CSS has no rule for ${missing.join(', ')} (AVATAR_BG, QA-01)`] : []),
  ]
  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log(`\nWithin budget. Scanned ${files.length} text files: nothing inline, no data: URL, CDN, model host,`)
  console.log('Google Fonts or test hook, and all twelve avatar fills compiled.')
}

if (import.meta.main) main()
