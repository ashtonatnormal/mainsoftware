// scripts/check-web-dist.ts's pure parts on planted fixtures (T21 items 7, 11 and 12; OD-15,
// QA-01): the initial set it measures, the scan of dist/, the budget comparison and the avatar
// rules, and that CI's check job runs it straight after the build. It sits in scripts/guards/
// because its fixtures plant CDN and model URLs on purpose, which ai-free's text check refuses in
// every script outside this folder.

import { describe, expect, it } from 'vitest'
import { AVATAR_BG } from '../../apps/web/src/ui/avatar-hue'
import {
  BOOT_SRC,
  type DistFile,
  type Figures,
  initialSet,
  latinFonts,
  lazyChunks,
  type Manifest,
  missingAvatarRules,
  overBudget,
  parseBudget,
  scanDist,
} from '../check-web-dist'
import { readRepoFile } from './repo-files'
import { workflowJobs } from './workflow'

// A manifest shaped like the real build's: the entry imports a shared chunk and loads boot by one
// dynamic import; boot imports the entry back (a cycle), two libraries (one importing a third) and
// the shared chunk, and loads the screens; a screen imports a chunk only screens use.
const MANIFEST: Manifest = {
  'index.html': {
    file: 'assets/index-a.js',
    src: 'index.html',
    isEntry: true,
    imports: ['_shared-a.js'],
    dynamicImports: [BOOT_SRC],
    css: ['assets/index-a.css'],
  },
  '_shared-a.js': { file: 'assets/shared-a.js' },
  [BOOT_SRC]: {
    file: 'assets/boot-a.js',
    src: BOOT_SRC,
    isDynamicEntry: true,
    imports: ['index.html', '_router-a.js', '_query-a.js', '_shared-a.js'],
    dynamicImports: ['src/shell/Shell.tsx', 'src/sign-in/SignInScreen.tsx'],
  },
  '_router-a.js': { file: 'assets/router-a.js', imports: ['_history-a.js'] },
  '_history-a.js': { file: 'assets/history-a.js' },
  '_query-a.js': { file: 'assets/query-a.js' },
  'src/shell/Shell.tsx': {
    file: 'assets/Shell-a.js',
    src: 'src/shell/Shell.tsx',
    isDynamicEntry: true,
    imports: [BOOT_SRC, '_nav-a.js'],
  },
  '_nav-a.js': { file: 'assets/nav-a.js' },
  'src/sign-in/SignInScreen.tsx': {
    file: 'assets/SignInScreen-a.js',
    src: 'src/sign-in/SignInScreen.tsx',
    isDynamicEntry: true,
    imports: [BOOT_SRC],
  },
  'node_modules/font/latin.woff2': { file: 'assets/font-latin-a.woff2', src: 'node_modules/font/latin.woff2' },
}

const CLEAN_PAGE = `<!doctype html>
<!-- One module script loads everything; nothing inline (an old note said <script>inline</script>). -->
<html lang="en-GB">
  <head>
    <meta charset="UTF-8" />
    <title>Hearth</title>
    <script type="module" crossorigin src="/assets/index-a.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-a.css">
  </head>
  <body><div id="root">Loading Hearth…</div></body>
</html>`

const avatarCss = (names: readonly string[] = AVATAR_BG) =>
  names.map(name => `.${name}{background-color:var(--avatar-${name.slice('bg-avatar-'.length)})}`).join('')

const CLEAN_DIST: DistFile[] = [
  { path: 'index.html', text: CLEAN_PAGE },
  {
    path: 'assets/index-a.css',
    text: `@font-face{font-family:Inter;src:url(/assets/inter-latin-wght-normal-a.woff2)}${avatarCss()}`,
  },
  { path: 'assets/boot-a.js', text: 'const e="https://react.dev/errors/";fetch("/api/session")' },
  { path: '.vite/manifest.json', text: JSON.stringify(MANIFEST) },
]

// The clean dist with one file's text changed.
const planted = (path: string, text: string): DistFile[] => [
  ...CLEAN_DIST.filter(file => file.path !== path),
  { path, text },
]

const FIGURES_OK: Figures = {
  initialJsGzip: 150_000,
  initialCssGzip: 7_000,
  largestLazyJsGzip: 7_500,
  fontsLatinBytes: 61_500,
}

describe('T21: the web bundle check (scripts/check-web-dist.ts)', () => {
  it("DT-01 OD-15: the initial set is index.html's isEntry chunk, its static imports, and the app/boot.tsx chunk it always loads with its static imports", () => {
    const initial = initialSet(MANIFEST)
    expect(initial.keys).toEqual([
      'index.html',
      '_shared-a.js',
      BOOT_SRC,
      '_router-a.js',
      '_history-a.js',
      '_query-a.js',
    ])
    expect(initial.js).toEqual([
      'assets/index-a.js',
      'assets/shared-a.js',
      'assets/boot-a.js',
      'assets/router-a.js',
      'assets/history-a.js',
      'assets/query-a.js',
    ])
    expect(initial.css).toEqual(['assets/index-a.css'])
    // Everything else that is JS is lazy, the screens and what only they import; fonts aren't JS.
    expect(lazyChunks(MANIFEST).sort()).toEqual(['assets/Shell-a.js', 'assets/SignInScreen-a.js', 'assets/nav-a.js'])
    // A build whose entry no longer loads boot, or that has no HTML entry, can't be measured as if
    // it did: the check fails rather than measuring the wrong set.
    const noBoot: Manifest = {
      ...MANIFEST,
      'index.html': { ...MANIFEST['index.html'], file: 'x.js', dynamicImports: [] },
    }
    expect(() => initialSet(noBoot)).toThrow(/no longer loads src\/app\/boot\.tsx/)
    const noEntry: Manifest = { ...MANIFEST, 'index.html': { ...MANIFEST['index.html'], file: 'x.js', isEntry: false } }
    expect(() => initialSet(noEntry)).toThrow(/one HTML entry/)
    const dangling: Manifest = { ...MANIFEST, '_query-a.js': { file: 'assets/query-a.js', imports: ['_gone.js'] } }
    expect(() => initialSet(dangling)).toThrow(/_gone\.js/)
    // The latin font files a stylesheet names, not latin-ext or another subset, as paths in dist/.
    expect(
      latinFonts(
        '@font-face{src:url(/assets/inter-latin-wght-normal-a.woff2)}' +
          '@font-face{src:url("/assets/inter-latin-ext-wght-normal-b.woff2")}' +
          "@font-face{src:url('./newsreader-latin-600-normal-c.woff2')}" +
          '@font-face{src:url(/assets/newsreader-vietnamese-600-normal-d.woff2)}' +
          '@font-face{src:url(../fonts/serif-latin-wght-normal-e.woff2)}',
        'assets/index-a.css',
      ),
    ).toEqual([
      'assets/inter-latin-wght-normal-a.woff2',
      'assets/newsreader-latin-600-normal-c.woff2',
      'fonts/serif-latin-wght-normal-e.woff2',
    ])
  })

  it('DT-02 T21 item 7 SHL-26: the scan finds an inline script, an inline style, a data: URL, a public npm CDN, a model host, Google Fonts and the test hook in planted fixtures, and passes a clean dist', () => {
    expect(scanDist(CLEAN_DIST)).toEqual([])
    const cases: [DistFile[], string][] = [
      [
        planted('index.html', CLEAN_PAGE.replace('</head>', '<script>boot()</script></head>')),
        'index.html: an inline <script>',
      ],
      [
        planted('index.html', CLEAN_PAGE.replace('</head>', '<script type="module" src="/a.js">x()</script></head>')),
        'index.html: an inline <script>',
      ],
      [
        planted('index.html', CLEAN_PAGE.replace('</head>', '<style>body{}</style></head>')),
        'index.html: a <style> element',
      ],
      [
        planted('index.html', CLEAN_PAGE.replace('<div id="root">', '<div id="root" style="color:red">')),
        'index.html: a style= attribute',
      ],
      [
        planted('index.html', CLEAN_PAGE.replace('<body>', '<body onload="go()">')),
        'index.html: an inline event handler (on…=)',
      ],
      [
        planted('assets/index-a.css', `.a{background:url( "data:image/png;base64,AAAA")}${avatarCss()}`),
        'assets/index-a.css: a data: URL',
      ],
      [
        planted('assets/boot-a.js', 'import("https://cdn.jsdelivr.net/npm/left-pad@1/index.js")'),
        'assets/boot-a.js: a public npm CDN (https://cdn.jsdelivr.net/npm/left-pad@1/index.js)',
      ],
      [planted('assets/boot-a.js', 'fetch("//esm.sh/zod")'), 'assets/boot-a.js: a public npm CDN (//esm.sh/zod)'],
      [
        planted('assets/boot-a.js', 'fetch("https://api.openai.com/v1/responses")'),
        'assets/boot-a.js: a model host (api.openai.com)',
      ],
      [
        planted('assets/boot-a.js', 'new WebSocket("wss://bedrock-runtime.ap-southeast-1.amazonaws.com/")'),
        'assets/boot-a.js: a model host (bedrock-runtime.ap-southeast-1.amazonaws.com)',
      ],
      [
        planted(
          'index.html',
          CLEAN_PAGE.replace(
            '</head>',
            '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"></head>',
          ),
        ),
        'index.html: Google Fonts',
      ],
      [
        planted('assets/index-a.css', `@font-face{src:url(https://fonts.gstatic.com/s/a.woff2)}${avatarCss()}`),
        'assets/index-a.css: Google Fonts',
      ],
      [planted('assets/boot-a.js', 'window.__hearth={query:q}'), 'assets/boot-a.js: the __hearth test hook'],
      [CLEAN_DIST.filter(file => file.path !== 'index.html'), 'index.html: missing'],
    ]
    for (const [files, problem] of cases) expect(scanDist(files), problem).toContain(problem)
    // A data: URL is refused in CSS only; JS may name the scheme in a string (a parser, a regex).
    expect(scanDist(planted('assets/boot-a.js', 'const isData=u=>u.startsWith("data:")'))).toEqual([])
  })

  it('DT-03 T21 OD-15: the budget comparison fails on any figure over bundle-budget.json and names it; the budget holds exactly the four figures', () => {
    expect(overBudget(FIGURES_OK, FIGURES_OK)).toEqual([])
    const over = overBudget({ ...FIGURES_OK, initialJsGzip: 150_001, fontsLatinBytes: 70_000 }, FIGURES_OK)
    expect(over).toHaveLength(2)
    expect(over[0]).toMatch(/^initialJsGzip \(initial JS, gzip\) is 150,001 bytes, over its budget of 150,000$/)
    expect(over[1]).toMatch(/^fontsLatinBytes /)
    expect(overBudget({ ...FIGURES_OK, largestLazyJsGzip: 1 }, FIGURES_OK)).toEqual([])
    expect(parseBudget({ ...FIGURES_OK })).toEqual(FIGURES_OK)
    expect(() => parseBudget({ ...FIGURES_OK, extraGzip: 1 })).toThrow(/unknown: extraGzip/)
    const { fontsLatinBytes: _, ...missing } = FIGURES_OK
    expect(() => parseBudget(missing)).toThrow(/missing: fontsLatinBytes/)
    expect(() => parseBudget({ ...FIGURES_OK, initialCssGzip: '8100' })).toThrow(/initialCssGzip/)
    expect(() => parseBudget({ ...FIGURES_OK, initialCssGzip: 0 })).toThrow(/initialCssGzip/)
    expect(() => parseBudget([])).toThrow(/not an object/)
    // The repo's own budget parses.
    expect(Object.keys(parseBudget(JSON.parse(readRepoFile('apps/web/bundle-budget.json'))))).toHaveLength(4)
  })

  it('DT-04 QA-01 T21 item 12: missingAvatarRules finds a built CSS without a .bg-avatar-N rule for each N in 0–11', () => {
    expect(AVATAR_BG).toHaveLength(12)
    expect(missingAvatarRules(avatarCss())).toEqual([])
    expect(missingAvatarRules(`@layer utilities{${avatarCss()}}`)).toEqual([])
    expect(missingAvatarRules(avatarCss(AVATAR_BG.filter(name => name !== 'bg-avatar-7')))).toEqual(['bg-avatar-7'])
    expect(missingAvatarRules('')).toEqual([...AVATAR_BG])
    // .bg-avatar-10 doesn't stand in for .bg-avatar-1, and each rule sets its own token.
    expect(missingAvatarRules(avatarCss(AVATAR_BG.filter(name => name !== 'bg-avatar-1')))).toEqual(['bg-avatar-1'])
    expect(missingAvatarRules(avatarCss().replace('var(--avatar-3)', 'var(--avatar-4)'))).toEqual(['bg-avatar-3'])
  })

  it('DT-05 T21 item 12 CL Testing and CI: the check job runs node scripts/check-web-dist.ts straight after npm run build', () => {
    const check = workflowJobs(readRepoFile('.github/workflows/ci.yml')).find(job => job.id === 'check')
    const steps = check?.steps ?? []
    const build = steps.findIndex(step => /^run: npm run build$/m.test(step))
    expect(build, 'the build step').toBeGreaterThan(-1)
    expect(steps[build + 1]).toMatch(/^run: node scripts\/check-web-dist\.ts$/m)
  })
})
