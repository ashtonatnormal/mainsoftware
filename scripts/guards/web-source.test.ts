// The web app's source guard (BUILD-PLAN C0.8, T21 items 11 and 13). It reads
// every file under apps/web/src (runtime code; tests only for tsconfig coverage) with comments
// stripped, and both of the workspace's tsconfigs. Each case first proves its pattern on planted
// source, so a rule that matches nothing can't pass by accident, then holds the tree to it.
import { dirname, join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { readRepoFile, repoFiles, root } from './repo-files'
import {
  ABSOLUTE_URL,
  ARBITRARY_COLOUR,
  ARBITRARY_TEXT,
  CLIPBOARD_FIELD_FILES,
  CODE_FROM_STRINGS,
  COLOUR_LITERAL,
  COLOUR_LITERAL_FILES,
  clipboardHandlers,
  codeOf,
  DEFAULT_PALETTE,
  DISPLAY_FAMILY,
  DUNDER_WRITES_ALLOWED,
  displayListsOf,
  displayOffFace,
  dunderWrites,
  ENTRY_APP,
  entryGraph,
  FETCH_FILES,
  FLAG_READERS,
  FLAGS_PATH,
  FLAGS_QUERY_HOLDERS,
  globalReads,
  HTML_FROM_STRINGS,
  identifiersOf,
  isRuntimeSource,
  isSignInOrSessionCode,
  loadsOf,
  matchesOf,
  misplacedSignInOrSessionFolder,
  NEW_QUERY_CLIENT,
  NO_OUTLINE_CLASS,
  NO_OUTLINE_CSS,
  OPACITY,
  POPOVER,
  PROCESS_ENV,
  QUERY_CLIENT_FILE,
  SESSION_STORAGE,
  SESSION_STORAGE_FILES,
  STORAGE,
  specifiersOf,
  srcTarget,
  stringsOf,
  takesAuthInput,
  textOpacity,
  WEB_DIR,
  WEB_SRC,
  WEBSOCKET_FILES,
  webAuthnUses,
} from './web-source'

const files = repoFiles()
const src = files.filter(path => path.startsWith(WEB_SRC)).map(path => path.slice(WEB_SRC.length))
const runtime = src.filter(isRuntimeSource)
const sources = new Map(runtime.map(path => [path, readRepoFile(WEB_SRC + path)]))
const code = new Map(runtime.map(path => [path, codeOf(path, sources.get(path) ?? '')]))
const scripts = runtime.filter(path => !path.endsWith('.css'))

// Every match of a pattern in the stripped code of these files, as "path: match".
function found(pattern: RegExp, inFiles: readonly string[] = runtime): string[] {
  return inFiles.flatMap(path => matchesOf(pattern, code.get(path) ?? '').map(match => `${path}: ${match}`))
}

// A planted file's stripped code.
const planted = (source: string, path = 'fixture.tsx') => codeOf(path, source)

// The colour names app.css maps (bg, surface, …, transparent, current), for WS-05's text/NN rule.
const COLOURS = [...readRepoFile(`${WEB_SRC}styles/app.css`).matchAll(/--color-([a-z0-9-]+):/g)]
  .map(match => match[1] ?? '')
  .filter(name => name !== '' && name !== '*')

describe('T21: the web source guard (apps/web/src)', () => {
  it('sanity: the kit and styles are read, and comments are stripped before any rule looks', () => {
    for (const path of [
      'ui/Button.tsx',
      'ui/Menu.tsx',
      'ui/Dialog.tsx',
      'styles/app.css',
      'styles/tokens.css',
      'main.ts',
    ])
      expect(runtime, path).toContain(path)
    expect(runtime.some(path => path.endsWith('.test.ts') || path.endsWith('.test.tsx'))).toBe(false)
    expect(planted('// localStorage\n/* innerHTML */\nconst a = 1\n')).not.toMatch(/localStorage|innerHTML/)
    expect(planted("const a = 'localStorage'\n")).toMatch(/localStorage/)
    expect(codeOf('a.css', '/* #fff */ a { color: red }')).not.toContain('#fff')
    expect(COLOURS).toEqual(expect.arrayContaining(['bg', 'fg', 'surface-2', 'avatar-11', 'transparent', 'current']))
  })

  it('WS-01 T21 item 2 PRD-74 CHT-60: no localStorage, indexedDB or caches; sessionStorage only in boot/pre-boot.ts and session/document.ts', () => {
    expect(
      matchesOf(STORAGE, planted('window.localStorage.setItem("k", v); indexedDB.open("x"); caches.open("y")')),
    ).toEqual(['localStorage', 'indexedDB', 'caches'])
    expect(matchesOf(SESSION_STORAGE, planted('sessionStorage.getItem("hearth:left")'))).toEqual(['sessionStorage'])
    expect(found(STORAGE)).toEqual([])
    expect(
      found(
        SESSION_STORAGE,
        runtime.filter(path => !SESSION_STORAGE_FILES.has(path)),
      ),
    ).toEqual([])
  })

  it("WS-02 D-01 SHL-26 T21 item 7: new QueryClient( only in session/query-client.ts; no eval or new Function; no window.__ read, and no __ member written through any alias but pre-boot's __zod_globalConfig", () => {
    expect(matchesOf(NEW_QUERY_CLIENT, planted('const q = new QueryClient({})'))).toHaveLength(1)
    expect(
      matchesOf(
        CODE_FROM_STRINGS,
        planted('eval(s); new Function("a", s); Function(s); window.__hearth = x; globalThis["__x"] = 1'),
      ),
    ).toEqual(['eval(', 'new Function(', 'Function(', 'window.__', 'globalThis["__'])
    expect(matchesOf(CODE_FROM_STRINGS, planted('const isFunction = (f: unknown) => typeof f === "function"'))).toEqual(
      [],
    )
    expect(
      found(
        NEW_QUERY_CLIENT,
        runtime.filter(path => path !== QUERY_CLIENT_FILE),
      ),
    ).toEqual([])
    expect(found(CODE_FROM_STRINGS)).toEqual([])

    // A __ member written through an alias of the window, or any object, is a write too.
    expect(
      dunderWrites(
        'fixture.ts',
        [
          'const w = window; w.__a = f',
          'function hook(scope: { __b?: object }) { scope.__b ??= {} }',
          '(window as unknown as Record<string, unknown>).__c = 1',
          'globalThis["__d"] = 1',
          'self.__e.list = []',
          'w.__f += 1; w.__g ||= f; w.__h &&= f',
          'w.__i++; --w.__j',
          '({ a: w.__k } = o); [w.__l, ...w.__m] = list; [w.__n = 1] = list',
          'for (w.__o of list) {}',
          'delete w.__p',
          'Object.assign(w, { __q: f }, { ["__r"]: f }); Object.defineProperty(w, "__s", {}); Reflect.set(w, `__t`, 1)',
          'Object.defineProperties(w, { __u: {} }); Reflect.defineProperty(w!, "__v", {})',
        ].join(';\n'),
      ),
    ).toEqual([...'abcdefghijklmnopqrstuv'].map(letter => `__${letter}`))
    // Reads, declarations, keys of a plain object, locals and other members aren't.
    expect(
      dunderWrites(
        'fixture.ts',
        'const v = w.__a; f(w.__b); interface Z { __c?: number }; const o = { __d: 1 }; const { __e } = w; let __f = 1; __f = 2; ({ __g } = w); w.a = 1; w[k] = f; Object.freeze({ __h: 1 })',
      ),
    ).toEqual([])
    // The tree writes only the members DUNDER_WRITES_ALLOWED names, where it names them, and each
    // allowance is still in use, so it goes when its write does.
    const writes = scripts.flatMap(path => dunderWrites(path, sources.get(path) ?? '').map(name => `${path}: ${name}`))
    const allowed = [...DUNDER_WRITES_ALLOWED].flatMap(([path, names]) => [...names].map(name => `${path}: ${name}`))
    expect(allowed).toEqual(['boot/pre-boot.ts: __zod_globalConfig'])
    expect(writes.filter(write => !allowed.includes(write))).toEqual([])
    expect([...new Set(writes)]).toEqual(allowed)
  })

  it('WS-03 T21 item 3: fetch only in api/http.ts and WebSocket only in live/gateway-client.ts and session/runtime.ts, never with an absolute URL', () => {
    const net = new Set(['fetch', 'WebSocket'])
    expect(
      globalReads(
        'fixture.ts',
        'fetch("/api/x"); const f = { fetch }; window.fetch("/a"); globalThis["WebSocket"]; new WebSocket(u)',
        net,
      ),
    ).toEqual(['fetch', 'fetch', 'window.fetch', "globalThis['WebSocket']", 'WebSocket'])
    // Types, keys and injected copies read no global.
    expect(
      globalReads(
        'fixture.ts',
        'interface E { fetch: typeof fetch; WebSocket: typeof WebSocket }\nconst e = { fetch: env.fetch }\nenv.fetch(x)\nlet s: WebSocket',
        net,
      ),
    ).toEqual([])
    expect(
      stringsOf('fixture.ts', `a("https://x.example/api"); b(\`wss://\${h}/ws\`); c("/api/session")`).filter(s =>
        ABSOLUTE_URL.test(s),
      ),
    ).toEqual(['https://x.example/api', 'wss://'])
    expect(['//cdn.example/x.js', 'http://x', 'ws://x'].every(s => ABSOLUTE_URL.test(s))).toBe(true)
    expect(['/api/flags', '//', '#main', 'wss:'].some(s => ABSOLUTE_URL.test(s))).toBe(false)
    // The gateway's URL, built from this page's location, names no host of its own.
    const fromLocation = `const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'\nnew WebSocket(\`\${scheme}//\${location.host}/ws\`)`
    expect(stringsOf('fixture.ts', fromLocation).filter(s => ABSOLUTE_URL.test(s))).toEqual([])

    const misplaced = scripts.flatMap(path => {
      const source = sources.get(path) ?? ''
      const fetches = FETCH_FILES.has(path) ? [] : globalReads(path, source, new Set(['fetch']))
      const sockets = WEBSOCKET_FILES.has(path) ? [] : globalReads(path, source, new Set(['WebSocket']))
      return [...fetches, ...sockets].map(name => `${path}: ${name}`)
    })
    expect(misplaced).toEqual([])
    const absolute = scripts.flatMap(path =>
      stringsOf(path, sources.get(path) ?? '')
        .filter(text => ABSOLUTE_URL.test(text))
        .map(text => `${path}: ${text}`),
    )
    expect(absolute).toEqual([])
  })

  it('WS-04 X9 CL Conventions: no colour literal (hex, rgb, hsl, oklch) outside styles/tokens.css; no text-white, bg-black or default-palette class; no arbitrary colour value', () => {
    expect(
      matchesOf(
        COLOUR_LITERAL,
        planted('const a = "#fff"; const b = "#1b2130"; const c = "rgb(0 0 0)"; const d = "oklch(0.5 0.1 20)"'),
      ),
    ).toEqual(['#fff', '#1b2130', 'rgb(', 'oklch('])
    expect(matchesOf(COLOUR_LITERAL, planted('<a href="#main">Skip</a>; document.getElementById("screen")'))).toEqual(
      [],
    )
    expect(
      matchesOf(
        DEFAULT_PALETTE,
        planted('<p className="text-white bg-black hover:bg-red-500 border-x-slate-200 ring-blue-950" />'),
      ),
    ).toEqual(['text-white', 'bg-black', 'bg-red-500', 'border-x-slate-200', 'ring-blue-950'])
    expect(
      matchesOf(DEFAULT_PALETTE, planted('<p className="bg-accent text-accent-fg text-avatar-fg bg-avatar-10" />')),
    ).toEqual([])
    expect(
      matchesOf(
        ARBITRARY_COLOUR,
        planted('<p className="bg-[#fff] text-[rgb(0_0_0)] border-[var(--x)] bg-(--accent) fill-[color:red]" />'),
      ),
    ).toHaveLength(5)
    expect(
      matchesOf(ARBITRARY_COLOUR, planted('<p className="max-w-[min(18rem,calc(100vw-2rem))] max-h-[88dvh]" />')),
    ).toEqual([])

    expect(
      found(
        COLOUR_LITERAL,
        runtime.filter(path => !COLOUR_LITERAL_FILES.has(path)),
      ),
    ).toEqual([])
    expect(found(DEFAULT_PALETTE)).toEqual([])
    expect(found(ARBITRARY_COLOUR)).toEqual([])
    // The one file allowed literals holds them, so the exemption names a real file.
    expect(found(COLOUR_LITERAL, [...COLOUR_LITERAL_FILES]).length).toBeGreaterThan(30)
  })

  it('WS-05 X9 D-02: no opacity-* class, no text colour /NN modifier, no arbitrary text-[Npx]', () => {
    const textAlpha = textOpacity(COLOURS)
    expect(matchesOf(OPACITY, planted('<p className="opacity-50 disabled:opacity-40 opacity-[.3]" />'))).toHaveLength(3)
    expect(
      matchesOf(textAlpha, planted('<p className="text-muted/70 text-fg/50 hover:text-surface-2/40" />')),
    ).toHaveLength(3)
    // A font size with a line height is not a colour.
    expect(matchesOf(textAlpha, planted('<p className="text-sm/6 text-body bg-fg/40" />'))).toEqual([])
    expect(
      matchesOf(ARBITRARY_TEXT, planted('<p className="text-[11px] text-[0.7rem] text-(--size)" />')),
    ).toHaveLength(3)
    expect(matchesOf(ARBITRARY_TEXT, planted('<p className="text-xs text-small text-body text-base" />'))).toEqual([])
    const scriptsOnly = runtime.filter(path => !path.endsWith('.css'))
    expect(found(OPACITY, scriptsOnly)).toEqual([])
    expect(found(textAlpha, scriptsOnly)).toEqual([])
    expect(found(ARBITRARY_TEXT, scriptsOnly)).toEqual([])
  })

  it('WS-06 WCAG 2.4.7: no outline-none or outline-0', () => {
    expect(
      matchesOf(NO_OUTLINE_CLASS, planted('<b className="outline-none focus:outline-0 outline-hidden" />')),
    ).toHaveLength(3)
    expect(matchesOf(NO_OUTLINE_CLASS, planted('<b className="outline-2 outline-accent outline-offset-2" />'))).toEqual(
      [],
    )
    expect(
      matchesOf(
        NO_OUTLINE_CSS,
        codeOf('a.css', 'a:focus { outline: none; } b { outline: 0 } c { outline-width: 0px; }'),
      ),
    ).toHaveLength(3)
    expect(matchesOf(NO_OUTLINE_CSS, codeOf('a.css', ':focus-visible { outline: 2px solid var(--accent); }'))).toEqual(
      [],
    )
    expect(found(NO_OUTLINE_CLASS, scripts)).toEqual([])
    expect(
      found(
        NO_OUTLINE_CSS,
        runtime.filter(path => path.endsWith('.css')),
      ),
    ).toEqual([])
  })

  it('WS-07 PRD-70: no dangerouslySetInnerHTML, innerHTML, outerHTML, insertAdjacentHTML or document.write', () => {
    expect(
      matchesOf(
        HTML_FROM_STRINGS,
        planted(
          '<div dangerouslySetInnerHTML={{ __html: x }} />; el.innerHTML = s; el.outerHTML; el.insertAdjacentHTML("a", s); document.write(s)',
        ),
      ),
    ).toHaveLength(5)
    expect(matchesOf(HTML_FROM_STRINGS, planted('root.textContent = "Can\'t reach Hearth."'))).toEqual([])
    expect(found(HTML_FROM_STRINGS, scripts)).toEqual([])
  })

  it('WS-08 D-09: no Popover API (popover attribute, showPopover) and no process.env in src', () => {
    expect(
      matchesOf(POPOVER, planted('<div popover="auto" />; el.showPopover(); <button popoverTarget="m" />')),
    ).toHaveLength(3)
    expect(matchesOf(PROCESS_ENV, planted('const x = process.env.NODE_ENV'))).toHaveLength(1)
    expect(found(POPOVER, scripts)).toEqual([])
    expect(found(PROCESS_ENV, scripts)).toEqual([])
  })

  it('WS-09 CL Testing: every .ts and .tsx file in apps/web is covered by tsconfig.json (src) or tsconfig.node.json (e2e, configs), and none by both', () => {
    const covered = (config: string) => {
      const path = join(root, WEB_DIR, config)
      const read = ts.readConfigFile(path, ts.sys.readFile)
      expect(read.error, config).toBeUndefined()
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(path), undefined, path)
      return new Set(parsed.fileNames.map(name => relative(root, name)))
    }
    const browser = covered('tsconfig.json')
    const node = covered('tsconfig.node.json')
    const web = files.filter(path => path.startsWith(WEB_DIR) && /\.(?:[cm]?ts|tsx)$/.test(path))
    expect(web).toEqual(expect.arrayContaining(['apps/web/vite.config.ts', 'apps/web/src/ui/kit.markup.test.tsx']))
    expect(web.filter(path => !browser.has(path) && !node.has(path))).toEqual([])
    expect(web.filter(path => browser.has(path) && node.has(path))).toEqual([])
  })

  it("WS-10 D-02 T21 item 2: src/main.ts's static import graph, followed through relative imports, holds only .css files and modules with no package import (import type aside), nothing in it uses import.meta.glob, and main.ts loads ./app/boot.tsx by one dynamic import after preBoot()", () => {
    const graph = (planted: Record<string, string>) => entryGraph(path => planted[path])
    const entry = (before = '', after = '') =>
      `import '@fontsource-variable/inter/index.css'\nimport './styles/app.css'\nimport { preBoot } from './boot/pre-boot.ts'\nimport { reloadForUpdate } from './session/document.ts'\n${before}preBoot(window, () => reloadForUpdate())\n${after}import('${ENTRY_APP}').then(app => app.boot())\n`
    const good = {
      'main.ts': entry(),
      'styles/app.css': "@import 'tailwindcss';",
      'boot/pre-boot.ts': 'export function preBoot() {}',
      'session/document.ts':
        "import type { QueryClient } from '@tanstack/react-query'\nimport { isAppPath } from '@/router/paths.ts'\nexport { type AppPath } from '../router/paths.ts'\nexport const reloadForUpdate = () => isAppPath('/chats')",
      'router/paths.ts': 'export const isAppPath = (p: string) => p.length > 0',
    }
    expect(graph(good)).toEqual({
      files: ['main.ts', 'styles/app.css', 'boot/pre-boot.ts', 'session/document.ts', 'router/paths.ts'],
      problems: [],
    })
    // Static and dynamic loads are told apart, and inline `type` names still load their module.
    expect(loadsOf('a.ts', "import type { A } from 'x'\nimport { type B } from 'y'\nconst c = import('z')")).toEqual([
      { specifier: 'x', typeOnly: true, dynamic: false },
      { specifier: 'y', typeOnly: false, dynamic: false },
      { specifier: 'z', typeOnly: false, dynamic: true },
    ])

    // Each way the graph can reach a package before the wipe.
    expect(
      graph({
        ...good,
        'main.ts': entry("import 'react'\n"),
        'session/document.ts':
          "import { z } from 'zod'\nimport { type QueryClient } from '@tanstack/react-query'\nexport * from 'idb'\nimport { isAppPath } from '@/router/paths.ts'\nexport const reloadForUpdate = () => z",
        'router/paths.ts': "const lazy = () => import('@/app/boot.tsx')\nconst r = require('dayjs')",
      }).problems,
    ).toEqual([
      'main.ts: imports the package react',
      'session/document.ts: imports the package zod',
      'session/document.ts: imports the package @tanstack/react-query',
      'session/document.ts: imports the package idb',
      'router/paths.ts: loads @/app/boot.tsx dynamically; only main.ts may',
      'router/paths.ts: imports the package dayjs',
    ])
    // Vite's import.meta.glob, eager (static imports) or lazy (dynamic ones), anywhere in the graph:
    // the eager form here would evaluate app/boot.tsx's graph, packages and all, before preBoot().
    expect(loadsOf('a.ts', "const all = import.meta.glob('./*.ts')\nconst g = import.meta.glob")).toEqual([
      { specifier: undefined, typeOnly: false, dynamic: false, glob: true },
      { specifier: undefined, typeOnly: false, dynamic: false, glob: true },
    ])
    expect(
      graph({
        ...good,
        'main.ts': entry("const lazy = import.meta.glob('./app/*.tsx')\n"),
        'boot/pre-boot.ts':
          "const app = import.meta.glob('../app/*.tsx', { eager: true })\nexport function preBoot() {}",
      }).problems,
    ).toEqual([
      "main.ts: loads modules by import.meta.glob, which this guard can't follow",
      "boot/pre-boot.ts: loads modules by import.meta.glob, which this guard can't follow",
    ])
    // A module the graph names that doesn't exist is no proof of anything.
    expect(graph({ ...good, 'boot/pre-boot.ts': "import { x } from './gone.ts'" }).problems).toEqual([
      'boot/gone.ts: no such file',
    ])
    // main.ts's own shape: the app loads after preBoot(), once, and only ./app/boot.tsx.
    expect(graph({ ...good, 'main.ts': entry().replace(/^preBoot.*$/m, '') }).problems).toEqual([
      'main.ts: calls preBoot() in no top-level statement of its own',
    ])
    expect(
      graph({ ...good, 'main.ts': entry().replace(/^(preBoot.*)$/m, 'function later() {\n$1\n}') }).problems,
    ).toEqual(['main.ts: calls preBoot() in no top-level statement of its own'])
    expect(
      graph({ ...good, 'main.ts': entry(`const early = import('${ENTRY_APP}')\n`).replace(/^import\('.*$/m, '') })
        .problems,
    ).toEqual(['main.ts: loads the app before preBoot() has run'])
    expect(graph({ ...good, 'main.ts': entry('', "import('./app/other.tsx')\n") }).problems).toEqual([
      `main.ts: makes 2 dynamic imports (./app/other.tsx, ${ENTRY_APP}); exactly one, of ${ENTRY_APP}, is allowed`,
    ])

    // The tree: main.ts reaches only these, and nothing in them loads a package.
    const tree = entryGraph(path => sources.get(path))
    expect(tree.problems).toEqual([])
    expect(tree.files.sort()).toEqual([
      'boot/pre-boot.ts',
      'main.ts',
      'router/paths.ts',
      'session/document.ts',
      'strings/boot.ts',
      'styles/app.css',
    ])
  })

  it('WS-11 T21 item 13 D46 CL Database C0.9 PD-43 C-10: no file under sign-in/ or session/, or named for either, reads the flags client (flags never gate an access control, the notice store included), and no folder elsewhere is named for either', () => {
    const problems = (path: string, source: string): string[] => {
      const modules = specifiersOf(path, source)
        .filter(specifier => srcTarget(path, specifier)?.startsWith('flags/'))
        .map(specifier => `imports ${specifier}`)
      const names = identifiersOf(path, source).filter(
        name => FLAG_READERS.has(name) && !(name === 'flagsQuery' && FLAGS_QUERY_HOLDERS.has(path)),
      )
      const routes = stringsOf(path, source).filter(text => FLAGS_PATH.test(text))
      return [...modules, ...names, ...routes]
    }
    // Planted: every way a flag could reach a sign-in step or the session code.
    expect(srcTarget('sign-in/PhoneStep.tsx', '../flags/FlagSlot.tsx')).toBe('flags/FlagSlot.tsx')
    expect(srcTarget('session/runtime.ts', '@/flags/ai-slots.tsx')).toBe('flags/ai-slots.tsx')
    expect(srcTarget('session/runtime.ts', 'react')).toBeUndefined()
    expect(
      problems(
        'sign-in/CodeStep.tsx',
        "import { FlagSlot } from '../flags/FlagSlot.tsx'\nimport { useFlag } from '@/api/queries.ts'\nimport * as q from '@/api/queries.ts'\nconst on = q.useFlags()\nconst lazy = () => import('@/flags/ai-slots.tsx')\nfetchJson('/api/flags')\n",
      ),
    ).toEqual([
      'imports ../flags/FlagSlot.tsx',
      'imports @/flags/ai-slots.tsx',
      'FlagSlot',
      'useFlag',
      'useFlags',
      '/api/flags',
    ])
    // The session runtime may invalidate and probe through flagsQuery, and nothing else may.
    const runtimeSource =
      "import { flagsQuery } from '@/api/queries.ts'\nqueryClient.invalidateQueries({ queryKey: flagsQuery.queryKey })\n"
    expect(problems('session/runtime.ts', runtimeSource)).toEqual([])
    expect(problems('session/document.ts', runtimeSource)).toEqual(['flagsQuery', 'flagsQuery'])
    expect(
      problems(
        'sign-in/api.ts',
        "import { ApiFailure } from '@/api/http.ts'\nimport { SIGN_IN } from '@/strings/sign-in.ts'\n",
      ),
    ).toEqual([])

    // Which files the rule reads: under sign-in/ or session/, or named for either; never a folder so
    // named anywhere else, where the rule's readers might not look.
    expect(
      ['sign-in/PhoneStep.tsx', 'session/runtime.ts', 'screens/SignInScreen.tsx', 'boot/load-session.ts'].every(
        isSignInOrSessionCode,
      ),
    ).toBe(true)
    expect(['ui/Button.tsx', 'lib/focus.ts', 'api/queries.ts', 'lib/signing.ts'].some(isSignInOrSessionCode)).toBe(
      false,
    )
    expect(
      [
        'screens/sign-in/PhoneStep.tsx',
        'app/session/runtime.ts',
        'Session/runtime.ts',
        'signin/CodeStep.tsx',
        'shell/sessions/List.tsx',
      ].every(misplacedSignInOrSessionFolder),
    ).toBe(true)
    expect(
      ['sign-in/PhoneStep.tsx', 'session/runtime.ts', 'sign-in/steps/PinStep.tsx', 'boot/load-session.ts'].some(
        misplacedSignInOrSessionFolder,
      ),
    ).toBe(false)
    expect(src.filter(misplacedSignInOrSessionFolder)).toEqual([])

    // The files the rule reads, pinned so it can't read nothing unnoticed: the session code, the
    // sign-in screen's frame and copy, and its steps, model, store and calls. A file that lands fails
    // this line until it is named, and a renamed folder fails it instead of leaving the rule reading
    // nothing.
    const guarded = runtime.filter(path => isSignInOrSessionCode(path) && !path.endsWith('.css'))
    const READS: readonly string[] = [
      'boot/load-session.ts',
      'session/document.ts',
      // The notice store: the acknowledgement gate is never a flag (C0.9 PD-43, C-10).
      'session/notice.ts',
      'session/query-client.ts',
      'session/runtime.ts',
      'sign-in/CodeStep.tsx',
      'sign-in/PhoneStep.tsx',
      'sign-in/PinStep.tsx',
      'sign-in/SignInScreen.tsx',
      'sign-in/StepFrame.tsx',
      'sign-in/api.ts',
      'sign-in/controller.ts',
      'sign-in/sign-in-model.ts',
      'strings/sign-in.ts',
    ]
    expect([...guarded].sort()).toEqual(READS)
    expect(
      guarded.flatMap(path => problems(path, sources.get(path) ?? '').map(problem => `${path}: ${problem}`)),
    ).toEqual([])
  })

  it('WS-12 T20 item 8 OD-01 D46: apps/web/src has no WebAuthn ceremony: no create read from navigator.credentials (directly, through a name bound to it, or destructured), no publicKey name, key or string, no PublicKeyCredential', () => {
    const uses = (source: string) => webAuthnUses('fixture.tsx', source)
    expect(
      uses(
        'await navigator.credentials.create({ publicKey: options }); PublicKeyCredential.isConditionalMediationAvailable()',
      ),
    ).toEqual(['credentials.create', 'publicKey', 'PublicKeyCredential'])
    // The shorthand either ceremony takes, with get as much as with create.
    expect(uses('const publicKey = toOptions(json)\nawait navigator.credentials.get({ publicKey })')).toEqual([
      'publicKey',
      'publicKey',
    ])
    expect(uses("const o = { ['publicKey']: x }; const p = { 'publicKey': x }")).toEqual(["'publicKey'", "'publicKey'"])
    expect(uses('let c: PublicKeyCredential | null = null')).toEqual(['PublicKeyCredential'])
    // create, however it is reached from navigator.credentials.
    expect(uses('const c = navigator.credentials\nawait c.create(o)')).toEqual(['credentials.create'])
    expect(uses('const n = window.navigator\nconst c = n.credentials\nconst d = c\nawait d.create(o)')).toEqual([
      'credentials.create',
    ])
    expect(uses("let c\nc = (navigator as Navigator).credentials\nc?.['create'](o)")).toEqual(['credentials.create'])
    expect(uses('const { credentials } = navigator\ncredentials.create(o)')).toEqual(['credentials.create'])
    expect(uses('const { credentials: store } = globalThis.navigator\nstore.create(o)')).toEqual(['credentials.create'])
    expect(uses('const { create } = navigator.credentials\ncreate(o)')).toEqual(['{ create } = credentials'])
    expect(uses('const { credentials: { create: make } } = navigator\nmake(o)')).toEqual([
      '{ credentials: { create } } = navigator',
    ])
    expect(uses('const make = navigator.credentials.create.bind(navigator.credentials)')).toEqual([
      'credentials.create',
    ])
    // Comments hold nothing; WebOTP reads a texted code through credentials.get with otp options,
    // which stays allowed, and other create calls are no ceremony.
    expect(uses('// navigator.credentials.create({ publicKey })\nconst a = 1')).toEqual([])
    expect(
      uses(
        "const otp = await navigator.credentials.get({ otp: { transport: ['sms'] }, signal })\nconst o = Object.create(null)\nconst r = createRouter({ routeTree })\nconst k = keys.create(1)",
      ),
    ).toEqual([])
    expect(scripts.flatMap(path => webAuthnUses(path, sources.get(path) ?? '').map(use => `${path}: ${use}`))).toEqual(
      [],
    )
  })

  it('WS-13 WCAG 3.3.8 SHL-49 T21 item 13: the code and PIN fields, the sign-in steps and whatever renders the fields block no paste or copy: no onPaste, onCopy, onCut or onBeforeInput, and no paste, copy, cut or beforeinput listener', () => {
    const handlers = (source: string) => clipboardHandlers('fixture.tsx', source)
    // Planted: every way a handler could reach an input.
    expect(
      handlers('<input onPaste={e => e.preventDefault()} onCopyCapture={stop} onCut={stop} onBeforeInput={stop} />'),
    ).toEqual(['onPaste', 'onCopyCapture', 'onCut', 'onBeforeInput'])
    expect(
      handlers(
        "input.onpaste = stop\ninput.addEventListener('paste', stop)\nel.addEventListener(\"beforeinput\", stop, true)\nconst p = { ['onCopy']: stop }",
      ),
    ).toEqual(['onpaste', "'paste'", "'beforeinput'", "'onCopy'"])
    // Comments hold nothing, and the words inside longer text or names are no handler.
    expect(
      handlers(
        "// onPaste={stop} addEventListener('paste')\nconst text = 'Paste the code'\nconst pasted = normaliseCode(v)\n<p>Copy it</p>",
      ),
    ).toEqual([])

    // Which files the rule reads: the fields, sign-in/, and any file that renders a field, however
    // it imports it; a file that only names a field in a comment isn't one.
    expect(takesAuthInput('ui/PinField.tsx', '')).toBe(true)
    expect(takesAuthInput('sign-in/sign-in-model.ts', '')).toBe(true)
    expect(takesAuthInput('shell/ReauthSheet.tsx', "import { CodeField } from '@/ui/CodeField.tsx'")).toBe(true)
    expect(takesAuthInput('ui/Sheet.tsx', "import { PinField } from './PinField.tsx'")).toBe(true)
    expect(takesAuthInput('api/reauth.ts', '// the fields the sheet reuses (ui/CodeField.tsx)')).toBe(false)

    // The files it reads, pinned so it can't read nothing unnoticed: a new file that renders a field
    // fails this line until it is named.
    const guarded = runtime.filter(path => takesAuthInput(path, sources.get(path) ?? ''))
    expect([...guarded].sort()).toEqual(
      [
        ...CLIPBOARD_FIELD_FILES,
        'dpo/ReauthPin.tsx',
        'sign-in/CodeStep.tsx',
        'sign-in/PhoneStep.tsx',
        'sign-in/PinStep.tsx',
        'sign-in/SignInScreen.tsx',
        'sign-in/StepFrame.tsx',
        'sign-in/api.ts',
        'sign-in/controller.ts',
        'sign-in/sign-in-model.ts',
      ].sort(),
    )
    expect(
      guarded.flatMap(path => clipboardHandlers(path, sources.get(path) ?? '').map(handler => `${path}: ${handler}`)),
    ).toEqual([])
  })

  it('WS-14 T21 items 1 and 6: every class list that sets font-display sets font-semibold with no variant, and no other weight or italic: the one face Newsreader ships', () => {
    expect(
      displayOffFace([
        'font-display text-xl font-semibold',
        'font-display text-xl not-italic font-semibold',
        'text-small font-medium italic',
        'font-display text-xl',
        'font-display rail:font-semibold',
        'font-display font-semibold font-bold',
        'font-display font-semibold rail:font-normal',
        'font-display font-semibold hover:font-medium',
        'font-display font-semibold font-[650]',
        'font-display font-semibold hover:font-(weight:--heading-weight)',
        'font-display font-semibold font-(--heading-weight)',
        'font-display font-semibold rail:[font-weight:700]',
        'font-display font-semibold [font-style:italic]',
        'font-display font-semibold [font:700_1rem_serif]',
        'font-display font-semibold font-bold!',
        'font-display font-semibold italic',
        'rail:font-display font-semibold md:italic',
        'font-display font-semibold [letter-spacing:-0.01em]',
      ]),
    ).toEqual([
      'font-display text-xl',
      'font-display rail:font-semibold',
      'font-display font-semibold font-bold',
      'font-display font-semibold rail:font-normal',
      'font-display font-semibold hover:font-medium',
      'font-display font-semibold font-[650]',
      'font-display font-semibold hover:font-(weight:--heading-weight)',
      'font-display font-semibold font-(--heading-weight)',
      'font-display font-semibold rail:[font-weight:700]',
      'font-display font-semibold [font-style:italic]',
      'font-display font-semibold [font:700_1rem_serif]',
      'font-display font-semibold font-bold!',
      'font-display font-semibold italic',
      'rail:font-display font-semibold md:italic',
    ])
    // Each string is read alone and each class expression whole: a string that names font-display
    // carries font-semibold itself, and a weight or italic a condition, a template, a same-file const,
    // a variant map or a helper adds to a font-display list counts; another element's weight in the
    // same file doesn't, and names that refer to each other end.
    const offFace = (source: string) => displayOffFace(displayListsOf('fixture.tsx', source))
    expect(offFace(`<h2 className={cx('font-display font-semibold', open && 'font-bold')} />;`)).toEqual([
      'font-display font-semibold font-bold',
    ])
    expect(offFace(`<h2 className={cx(quoted ? 'font-display font-semibold' : 'font-bold')} />;`)).toEqual([
      'font-display font-semibold font-bold',
    ])
    expect(offFace(`<h2 className={cx('font-display', large ? 'font-semibold text-4xl' : 'text-xl')} />;`)).toEqual([
      'font-display',
    ])
    expect(
      offFace(`const BOLD = 'font-bold';\n<h2 className={cx('font-display font-semibold', open && BOLD)} />;`),
    ).toEqual(['font-display font-semibold font-bold'])
    expect(
      offFace(`const HEADING = 'font-display font-semibold' as const;\nconst h = cx(HEADING, open && 'italic');`),
    ).toEqual(['font-display font-semibold italic'])
    expect(
      offFace(
        `const SIZES = { page: 'text-2xl', section: 'text-xl font-bold' } as const;\n<h2 className={cx('font-display font-semibold', SIZES[size])} />;`,
      ),
    ).toEqual(['font-display font-semibold text-2xl text-xl font-bold'])
    expect(
      offFace(
        `function toneOf(quoted: boolean) { return quoted ? 'italic' : '' }\n<h2 className={cx('font-display font-semibold', toneOf(q))} />;`,
      ),
    ).toEqual(['font-display font-semibold italic'])
    expect(offFace(`<h2 className={\`font-display font-semibold \${open ? 'font-bold' : ''}\`} />;`)).toEqual([
      'font-display font-semibold font-bold',
    ])
    expect(
      offFace(
        `const A = B;\nconst B = A;\n<h2 className={cx(hidden ? 'sr-only' : 'font-display font-semibold', 'text-xl', A)} />;\n<p className="font-medium" />;`,
      ),
    ).toEqual([])
    const lists = scripts.flatMap(path =>
      displayListsOf(path, sources.get(path) ?? '')
        .filter(text => DISPLAY_FAMILY.test(text))
        .map(text => ({ path, text })),
    )
    // ScreenHeader, Dialog, EmptyState, StepFrame, PlainScreen and ErrorScreen set it today.
    expect(lists.length).toBeGreaterThanOrEqual(6)
    expect(displayOffFace(lists.map(({ path, text }) => `${path}: ${text}`))).toEqual([])
  })
})
