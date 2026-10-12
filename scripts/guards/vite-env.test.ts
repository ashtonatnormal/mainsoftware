import { describe, expect, it } from 'vitest'
import { readRepoFile, repoFiles } from './repo-files'
import { ENV_PREFIX, isSecretShaped, isViteConfig, mayNameVariables, viteNames } from './vite-env'

const files = repoFiles()

describe('VITE_ guard: no server secret reaches the browser (CLAUDE.md, Database)', () => {
  it('flags VITE_ names shaped like a secret', () => {
    for (const name of [
      'VITE_API_KEY',
      'VITE_LIVEKIT_API_SECRET',
      'VITE_SESSION_TOKEN',
      'VITE_DB_URL',
      'VITE_DATABASE_HOST',
      'VITE_PGHOST',
      'VITE_ADMIN_PASSWORD',
      'VITE_PRIVATE_BUCKET',
      'VITE_apiKey',
      'VITE_Db_Password',
    ]) {
      expect(isSecretShaped(name), name).toBe(true)
    }
  })

  it('allows public names, including the VAPID public key', () => {
    for (const name of ['VITE_VAPID_PUBLIC_KEY', 'VITE_APP_ORIGIN', 'VITE_USER_CONTENT_ORIGIN', 'VITE_RELEASE']) {
      expect(isSecretShaped(name), name).toBe(false)
    }
  })

  it('finds names in code and env files, whatever their case', () => {
    expect(viteNames('const k = import.meta.env.VITE_API_KEY\nVITE_RELEASE=1\nVITE_apiKey=x\n')).toEqual([
      'VITE_API_KEY',
      'VITE_RELEASE',
      'VITE_apiKey',
    ])
  })

  it('reads Dockerfiles, env examples and config, but not docs or lockfiles', () => {
    for (const path of ['apps/server/Dockerfile', 'Dockerfile.web', 'infra/web.dockerfile', '.env.example', 'ci.yml']) {
      expect(mayNameVariables(path), path).toBe(true)
    }
    for (const path of ['docs/PRD.md', 'package-lock.json', 'spike/x/package-lock.json']) {
      expect(mayNameVariables(path), path).toBe(false)
    }
  })

  it('no source, config or .env.example file names a secret-shaped VITE_ variable', () => {
    const found = files
      .filter(path => mayNameVariables(path) && !path.startsWith('scripts/guards/vite-env'))
      .flatMap(path =>
        viteNames(readRepoFile(path))
          .filter(isSecretShaped)
          .map(name => `${path}: ${name}`),
      )
    expect(found).toEqual([])
  })

  it('no Vite config changes envPrefix, so VITE_ stays the only prefix that reaches the browser', () => {
    const found = files.filter(isViteConfig).filter(path => ENV_PREFIX.test(readRepoFile(path)))
    expect(found).toEqual([])
  })
})
