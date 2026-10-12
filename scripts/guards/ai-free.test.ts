import { describe, expect, it } from 'vitest'
import {
  aliasTarget,
  BANNED_CONSTRAINT,
  BANNED_GLOBALS,
  BROWSER_AI,
  bannedReason,
  CDN_URL,
  lockfilePackages,
} from './ai-free'
import { codeOf, importsOf, packageOf, scriptsOf } from './imports'
import { isScript, readRepoFile, repoFiles } from './repo-files'

const files = repoFiles()
const parse = (path: string) => JSON.parse(readRepoFile(path))
const cdnUrls = (text: string) => [...text.matchAll(CDN_URL)].map(match => match[0])
// Scripts and HTML pages, the files that can load or call code in the browser. The guard's own
// files hold the planted examples below, so the text checks skip them.
const codeFiles = files.filter(path => isScript(path) || /\.html?$/.test(path))
const textChecked = codeFiles.filter(path => !path.startsWith('scripts/guards/'))

describe('D41 AI-free guard: the matcher', () => {
  it('bans model, speech, ML and OCR packages by name or pattern', () => {
    const cases: Record<string, string> = {
      openai: 'a model SDK',
      '@anthropic-ai/sdk': 'a model SDK',
      '@aws-sdk/client-bedrock-runtime': 'a model SDK',
      'nodejs-whisper': 'speech-to-text or speech detection',
      '@ricky0123/vad-web': 'speech-to-text or speech detection',
      'react-speech-recognition': 'speech-to-text or speech detection',
      'node-vad': 'speech-to-text or speech detection',
      'onnxruntime-web': 'on-device ML or noise suppression',
      '@mlc-ai/web-llm': 'on-device ML or noise suppression',
      '@livekit/noise-cancellation-node': 'on-device ML or noise suppression',
      '@shiguredo/rnnoise-wasm': 'on-device ML or noise suppression',
      '@types/dom-chromium-ai': 'on-device ML or noise suppression',
      'tesseract.js': 'OCR',
      'node-tesseract-ocr': 'OCR',
      '@aws-sdk/client-rekognitionstreaming': 'OCR',
      'ibm-watson': 'a model SDK',
      '@soniox/speech-to-text-web': 'speech-to-text or speech detection',
      onnxjs: 'on-device ML or noise suppression',
    }
    for (const [name, why] of Object.entries(cases)) expect(bannedReason(name), name).toBe(why)
  })

  it('allows the core stack, including AWS and LiveKit clients that call no model', () => {
    for (const name of [
      'react',
      'fastify',
      'ws',
      'zod',
      'pg-boss',
      '@aws-sdk/client-s3',
      '@aws-sdk/client-quicksight',
      'livekit-client',
      'livekit-server-sdk',
      'aim',
      'autocrat',
    ]) {
      expect(bannedReason(name), name).toBeUndefined()
    }
  })

  it('finds a planted openai import however it is written', () => {
    const planted = [
      `import OpenAI from 'openai'`,
      `import type { ChatCompletion } from "openai/resources"`,
      `export * from 'openai'`,
      `const { OpenAI } = require('openai')`,
      `const sdk = await import('openai')`,
      `import x = require('openai')`,
      `import 'npm:openai@4'`,
      `export * as sdk from 'openai'`,
      'const sdk = await import(`openai`)',
      `const re = [/'/, await import('openai')]`,
      `type Client = import('openai').OpenAI`,
      `const a = await import('openai' as string)`,
      `const b = await import('openai' satisfies string)`,
      `const c = await import('openai'!)`,
      `const d = require(('openai') as string)`,
      `const e = module.require('openai')`,
      `define(['openai'], sdk => sdk)`,
    ]
    for (const source of planted) expect(importsOf(source).map(packageOf), source).toContain('openai')
  })

  it('ignores comments, strings, relative paths, URLs, built-ins and the @/ alias', () => {
    expect(importsOf(`// import OpenAI from 'openai'\nconst s = "require('openai')"`)).toEqual([])
    for (const spec of ['./openai', '../ai', 'node:fs', '#ai', '@/ai', 'data:text/javascript,1', 'https://x.dev/ai']) {
      expect(packageOf(spec), spec).toBeUndefined()
    }
    expect(packageOf('@anthropic-ai/sdk/resources')).toBe('@anthropic-ai/sdk')
  })

  it('reads the package behind an npm alias', () => {
    expect(aliasTarget('npm:openai@^4')).toBe('openai')
    expect(aliasTarget('npm:@anthropic-ai/sdk@1')).toBe('@anthropic-ai/sdk')
    expect(aliasTarget('^1.2.3')).toBeUndefined()
  })

  it('reads package names out of a lockfile, by folder and by real name', () => {
    const lock = {
      packages: {
        '': { name: 'hearth' },
        'node_modules/react': {},
        'node_modules/a/node_modules/@ai-sdk/openai': {},
        'node_modules/llm': { name: 'openai' }, // "llm": "npm:openai@4"
        'apps/web': { name: '@hearth/web' },
      },
    }
    expect(lockfilePackages(lock)).toEqual(['hearth', 'react', '@ai-sdk/openai', 'llm', 'openai', '@hearth/web'])
  })

  it("finds the browser's speech recognition and built-in AI however it is reached", () => {
    const planted = [
      'const recogniser = new window.webkitSpeechRecognition()',
      'const Recogniser = (globalThis as any).SpeechRecognition',
      'const session = await LanguageModel.create()',
      "const S = globalThis['Summarizer']",
      'if (self.Translator) {}',
      'const writer = await Writer.create({ tone: "formal" })',
      'await Proofreader.availability()',
      'const lm = await window.ai.languageModel.create()',
      'const api = (self as unknown as AiGlobals).Summarizer',
      "const LM = (window as any)['LanguageModel']",
      'await (globalThis as any).LanguageModel?.create()',
      "if ('Summarizer' in self) {}",
      'declare const LanguageModel: unknown',
      'const t = (self as any).Translator',
      'await Translator?.create({ sourceLanguage: "en" })',
      "if ('Writer' in self) {}",
      'const s = await (window as any).ai.summarizer.create()',
      'const lm = window.ai.languageModel',
      'await window.ai?.languageModel?.create?.()',
      'await (self as any).ai?.languageModel?.capabilities?.()',
      'await Translator?.create?.({ sourceLanguage: "en" })',
    ]
    for (const source of planted) expect(BROWSER_AI.test(source), source).toBe(true)
    for (const source of [
      'type R = SpeechRecognitionResultList',
      'class Translator {}',
      'new Writer(stream)',
      'const w = stream.getWriter()',
      'new HTMLRewriter()',
      "const flags = { 'ai.assistant': { default: false } }",
      'if (flags.ai.assistant) {}',
      'const on = settings.ai.summarizer.enabled',
      'const on = useFlags().ai.assistant',
      'const on = getFlags().ai.summarizer',
    ]) {
      expect(BROWSER_AI.test(source), source).toBe(false)
    }
  })

  it('refuses any request for voice isolation, and allows turning it off or reading it', () => {
    for (const source of [
      'voiceIsolation: true',
      'voiceIsolation: { ideal: true }',
      '{ voiceIsolation }',
      'track.applyConstraints({ voiceIsolation: true })',
      'c.audio.voiceIsolation = true',
      "c['voiceIsolation'] = true",
      'c.audio.voiceIsolation ??= true',
      'c.audio.voiceIsolation ||= true',
      'c.audio.voiceIsolation &&= true',
      'class O { voiceIsolation?: boolean = true }',
      'const { voiceIsolation } = settings',
      'voiceIsolation: false || true',
      'c.audio.voiceIsolation = false || wanted',
      'voiceIsolation: { exact: false } && x',
    ]) {
      expect(BANNED_CONSTRAINT.test(source), source).toBe(true)
    }
    for (const source of [
      'voiceIsolation: false',
      '"voiceIsolation": false',
      'voiceIsolation: { exact: false }',
      'voiceIsolation: { ideal: false }',
      'c.audio.voiceIsolation = false',
      'expect(track.mediaStreamTrack.getSettings().voiceIsolation).not.toBe(true)',
      'const on = room.options.audioCaptureDefaults?.voiceIsolation === true',
      'c.audio.voiceIsolation ??= false',
      'const audio = { voiceIsolation: false, echoCancellation: true }',
      'createLocalAudioTrack({ voiceIsolation: false })',
      'c.audio.voiceIsolation = false;',
      'interface MediaTrackSettings { voiceIsolation?: boolean }',
      'interface MediaTrackConstraintSet {\n  voiceIsolation?: ConstrainBoolean\n}',
      'const on = (s as { voiceIsolation?: boolean }).voiceIsolation',
    ]) {
      expect(BANNED_CONSTRAINT.test(source), source).toBe(false)
    }
  })

  it('reads code without its comments, in scripts and in pages', () => {
    const script = '// livekit-client turns voiceIsolation on by default\nconst audio = { voiceIsolation: false }\n'
    expect(BANNED_CONSTRAINT.test(codeOf('apps/web/src/room.ts', script))).toBe(false)
    expect(BROWSER_AI.test(codeOf('apps/web/src/a.ts', '/* no LanguageModel before A0 */ export {}'))).toBe(false)
    expect(codeOf('apps/web/src/a.ts', "const s = '// LanguageModel'")).toContain('LanguageModel')
    const page = '<!-- Summarizer --><script type="module">await Summarizer.create()</script>'
    expect(BROWSER_AI.test(codeOf('apps/web/index.html', page))).toBe(true)
    expect(scriptsOf('apps/web/index.html', page)).toEqual(['await Summarizer.create()'])
    // A page's attributes run code too, so they stay in view.
    expect(BROWSER_AI.test(codeOf('a.html', '<button onclick="new webkitSpeechRecognition().start()">'))).toBe(true)
    expect(
      BROWSER_AI.test(codeOf('a.html', '<script src="data:text/javascript,LanguageModel.create()"></script>')),
    ).toBe(true)
    const onload = '<body onload="navigator.mediaDevices.getUserMedia({ audio: { voiceIsolation: true } })">'
    expect(BANNED_CONSTRAINT.test(codeOf('a.html', onload))).toBe(true)
    expect(BROWSER_AI.test(codeOf('a.html', '<!-- no Summarizer here --><p>Hello</p>'))).toBe(false)
  })

  it('finds code loaded from a public CDN, in a script or a page', () => {
    expect(cdnUrls(`import OpenAI from 'https://esm.sh/openai@4'`)).toEqual(['https://esm.sh/openai@4'])
    expect(cdnUrls(`importScripts('https://cdn.jsdelivr.net/npm/@ricky0123/vad-web')`)).toHaveLength(1)
    expect(cdnUrls(`<script src="//unpkg.com/tesseract.js"></script>`)).toEqual(['//unpkg.com/tesseract.js'])
    expect(cdnUrls(`import 'https://UNPKG.COM/tesseract.js'`)).toEqual(['https://UNPKG.COM/tesseract.js'])
    expect(cdnUrls(`import 'https://testingcf.jsdelivr.net/npm/@ricky0123/vad-web'`)).toHaveLength(1)
    expect(cdnUrls(`<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">`)).toEqual([])
  })
})

describe('D41 AI-free guard: the repo', () => {
  it('no package.json depends on a model, speech, ML or OCR package, by name, alias or override', () => {
    const found = files
      .filter(path => /(^|\/)package\.json$/.test(path))
      .flatMap(path => {
        const pkg = parse(path)
        const entries = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(field =>
          Object.entries(pkg[field] ?? {}),
        )
        // overrides nest: { "a": { "b": "npm:openai@4" } }
        const walk = (value: unknown): [string, unknown][] =>
          value && typeof value === 'object'
            ? Object.entries(value).flatMap(([key, inner]) => [[key, inner] as [string, unknown], ...walk(inner)])
            : []
        return [...entries, ...walk(pkg.overrides)].flatMap(([name, value]) =>
          [name, aliasTarget(value)]
            .filter((target): target is string => !!target && !!bannedReason(target))
            .map(target => `${path}: ${name} installs ${target} (${bannedReason(target)})`),
        )
      })
    expect(found).toEqual([])
  })

  it('no npm lockfile installs one, directly or as a dependency of a dependency', () => {
    const found = files
      .filter(path => /(^|\/)(package-lock|npm-shrinkwrap)\.json$/.test(path))
      .flatMap(path =>
        lockfilePackages(parse(path))
          .filter(name => bannedReason(name))
          .map(name => `${path}: ${name} (${bannedReason(name)}); run \`npm explain ${name}\` to see what pulls it in`),
      )
    expect(found).toEqual([])
  })

  it('every lockfile is npm, the only kind this guard can read', () => {
    expect(files.filter(path => /(^|\/)(yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(path))).toEqual([])
  })

  it('no script or page imports one', () => {
    const found = codeFiles.flatMap(path => {
      // A page's inline scripts are read as code too.
      return scriptsOf(path, readRepoFile(path))
        .flatMap(script => importsOf(script, path))
        .flatMap(spec => {
          const name = packageOf(spec)
          const why = name && bannedReason(name)
          return why ? [`${path}: imports '${spec}' (${why})`] : []
        })
    })
    expect(found).toEqual([])
  })

  it("no script or page uses the browser's speech recognition or built-in AI", () => {
    expect(textChecked.filter(path => BROWSER_AI.test(codeOf(path, readRepoFile(path))))).toEqual([])
  })

  it('no script or page asks the browser for voice isolation', () => {
    expect(textChecked.filter(path => BANNED_CONSTRAINT.test(codeOf(path, readRepoFile(path))))).toEqual([])
  })

  it('no script or page loads code from a public CDN', () => {
    const found = textChecked.flatMap(path => cdnUrls(readRepoFile(path)).map(url => `${path}: ${url}`))
    expect(found).toEqual([])
  })

  it("biome.json also refuses the bare globals for the browser's speech recognition and built-in AI", () => {
    const denied = parse('biome.json').linter.rules.style.noRestrictedGlobals.options.deniedGlobals
    expect(Object.keys(denied)).toEqual(expect.arrayContaining(BANNED_GLOBALS))
  })
})
