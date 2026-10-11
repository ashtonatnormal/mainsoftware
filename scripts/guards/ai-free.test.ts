import { describe, expect, it } from 'vitest'
import { BANNED_CONSTRAINT, BANNED_GLOBALS, bannedReason, importsOf, lockfilePackages, packageOf } from './ai-free'
import { isScript, readRepoFile, repoFiles } from './repo-files'

const files = repoFiles()
const parse = (path: string) => JSON.parse(readRepoFile(path))

describe('D41 AI-free guard: the matcher', () => {
  it('bans model, speech, ML and OCR packages by name or pattern', () => {
    expect(bannedReason('openai')).toBe('a model SDK')
    expect(bannedReason('@anthropic-ai/sdk')).toBe('a model SDK')
    expect(bannedReason('@aws-sdk/client-bedrock-runtime')).toBe('a model SDK')
    expect(bannedReason('nodejs-whisper')).toBe('speech-to-text or speech detection')
    expect(bannedReason('@ricky0123/vad-web')).toBe('speech-to-text or speech detection')
    expect(bannedReason('onnxruntime-web')).toBe('on-device ML or noise suppression')
    expect(bannedReason('tesseract.js')).toBe('OCR')
  })

  it('allows the core stack, including AWS clients that call no model', () => {
    for (const name of [
      'react',
      'fastify',
      'ws',
      'zod',
      'pg-boss',
      '@aws-sdk/client-s3',
      'livekit-server-sdk',
      'aim',
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
      `import OpenAI from 'https://esm.sh/openai@4'`,
    ]
    for (const source of planted) expect(importsOf(source).map(packageOf), source).toContain('openai')
  })

  it('ignores comments, strings, relative paths, built-ins and the @/ alias', () => {
    expect(importsOf(`// import OpenAI from 'openai'\nconst s = "require('openai')"`)).toEqual([])
    for (const spec of ['./openai', '../ai', 'node:fs', '#ai', '@/ai', 'data:text/javascript,1']) {
      expect(packageOf(spec), spec).toBeUndefined()
    }
    expect(packageOf('@anthropic-ai/sdk/resources')).toBe('@anthropic-ai/sdk')
  })

  it('reads package names out of a lockfile, nested copies included', () => {
    const lock = {
      packages: {
        '': { name: 'hearth' },
        'node_modules/react': {},
        'node_modules/a/node_modules/@ai-sdk/openai': {},
        'apps/web': { name: '@hearth/web' },
      },
    }
    expect(lockfilePackages(lock)).toEqual(['hearth', 'react', '@ai-sdk/openai', '@hearth/web'])
  })
})

describe('D41 AI-free guard: the repo', () => {
  it('no package.json depends on a model, speech, ML or OCR package', () => {
    const found = files
      .filter(path => /(^|\/)package\.json$/.test(path))
      .flatMap(path => {
        const pkg = parse(path)
        const names = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(field =>
          Object.keys(pkg[field] ?? {}),
        )
        return names.filter(name => bannedReason(name)).map(name => `${path}: ${name} (${bannedReason(name)})`)
      })
    expect(found).toEqual([])
  })

  it('the lockfile installs none, directly or as a dependency of a dependency', () => {
    const found = lockfilePackages(parse('package-lock.json'))
      .filter(name => bannedReason(name))
      .map(name => `${name} (${bannedReason(name)}); run \`npm explain ${name}\` to see what pulls it in`)
    expect(found).toEqual([])
  })

  it('no source file imports one', () => {
    const found = files.filter(isScript).flatMap(path =>
      importsOf(readRepoFile(path)).flatMap(spec => {
        const name = packageOf(spec)
        const why = name && bannedReason(name)
        return why ? [`${path}: imports '${spec}' (${why})`] : []
      }),
    )
    expect(found).toEqual([])
  })

  it('no source file asks the browser for voice isolation', () => {
    const found = files
      .filter(path => isScript(path) && !path.startsWith('scripts/guards/ai-free'))
      .filter(path => BANNED_CONSTRAINT.test(readRepoFile(path)))
    expect(found).toEqual([])
  })

  it("biome.json refuses the browser's speech recognition and built-in AI", () => {
    const denied = parse('biome.json').linter.rules.style.noRestrictedGlobals.options.deniedGlobals
    expect(Object.keys(denied)).toEqual(expect.arrayContaining(BANNED_GLOBALS))
  })
})
