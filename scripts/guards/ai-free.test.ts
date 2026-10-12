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
import { importsOf, packageOf } from './imports'
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
    ]
    for (const source of planted) expect(BROWSER_AI.test(source), source).toBe(true)
    for (const source of ['type R = SpeechRecognitionResultList', 'class Translator {}', 'new Writer(stream)']) {
      expect(BROWSER_AI.test(source), source).toBe(false)
    }
  })

  it('allows only voice isolation turned off', () => {
    for (const source of ['voiceIsolation: true', 'voiceIsolation: { ideal: true }', '{ voiceIsolation }']) {
      expect(BANNED_CONSTRAINT.test(source), source).toBe(true)
    }
    for (const source of ['voiceIsolation: false', '"voiceIsolation": false', 'voiceIsolation: { exact: false }']) {
      expect(BANNED_CONSTRAINT.test(source), source).toBe(false)
    }
  })

  it('finds code loaded from a public CDN, in a script or a page', () => {
    expect(cdnUrls(`import OpenAI from 'https://esm.sh/openai@4'`)).toEqual(['https://esm.sh/openai@4'])
    expect(cdnUrls(`importScripts('https://cdn.jsdelivr.net/npm/@ricky0123/vad-web')`)).toHaveLength(1)
    expect(cdnUrls(`<script src="//unpkg.com/tesseract.js"></script>`)).toEqual(['//unpkg.com/tesseract.js'])
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
      const text = readRepoFile(path)
      // A page's inline scripts are read as code too.
      const sources = /\.html?$/.test(path)
        ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(match => match[1] ?? '')
        : [text]
      return sources.flatMap(importsOf).flatMap(spec => {
        const name = packageOf(spec)
        const why = name && bannedReason(name)
        return why ? [`${path}: imports '${spec}' (${why})`] : []
      })
    })
    expect(found).toEqual([])
  })

  it("no script or page uses the browser's speech recognition or built-in AI", () => {
    expect(textChecked.filter(path => BROWSER_AI.test(readRepoFile(path)))).toEqual([])
  })

  it('no script or page asks the browser for voice isolation', () => {
    expect(textChecked.filter(path => BANNED_CONSTRAINT.test(readRepoFile(path)))).toEqual([])
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
