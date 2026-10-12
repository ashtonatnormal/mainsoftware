import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '#src/config.ts'

const env = {
  APP_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgres://hearth:a-db-password@127.0.0.1:5432/hearth',
  VALKEY_URL: 'redis://127.0.0.1:6379',
  S3_BUCKET: 'hearth-local',
}

describe('C0.2 config', () => {
  it('reads a valid environment, with defaults for the rest', () => {
    expect(loadConfig(env)).toEqual({
      role: 'api',
      host: '127.0.0.1',
      port: 3000,
      logLevel: 'info',
      appOrigin: 'http://localhost:5173',
      databaseUrl: env.DATABASE_URL,
      valkeyUrl: env.VALKEY_URL,
      s3: { bucket: 'hearth-local', region: 'ap-southeast-1', endpoint: undefined, forcePathStyle: false },
    })
  })

  it('reads the role, port and local S3 settings', () => {
    const config = loadConfig({
      ...env,
      ROLE: 'worker',
      PORT: '3002',
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      S3_FORCE_PATH_STYLE: 'true',
    })
    expect(config.role).toBe('worker')
    expect(config.port).toBe(3002)
    expect(config.s3).toMatchObject({ endpoint: 'http://127.0.0.1:9000', forcePathStyle: true })
  })

  it('treats an empty variable as unset', () => {
    expect(loadConfig({ ...env, PORT: '', ROLE: '' })).toMatchObject({ port: 3000, role: 'api' })
  })

  it('names every missing or invalid variable', () => {
    const load = () => loadConfig({ ROLE: 'admin', PORT: '99999', APP_ORIGIN: 'https://hearth.example.com/' })
    expect(load).toThrow(ConfigError)
    const message = (() => {
      try {
        load()
      } catch (error) {
        return (error as Error).message
      }
    })()
    for (const name of ['ROLE', 'PORT', 'APP_ORIGIN', 'DATABASE_URL', 'VALKEY_URL', 'S3_BUCKET']) {
      expect(message).toContain(`${name}:`)
    }
  })

  it('never echoes a value in its error, since some hold passwords', () => {
    const secret = 'postgres://hearth:a-db-password@'
    try {
      loadConfig({ ...env, DATABASE_URL: `${secret}not a url`, VALKEY_URL: 'http://user:valkey-secret@x' })
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).not.toContain('a-db-password')
      expect((error as Error).message).not.toContain('valkey-secret')
    }
  })

  it('refuses an app origin with a path, and a database URL of another scheme', () => {
    expect(() => loadConfig({ ...env, APP_ORIGIN: 'https://hearth.example.com/app' })).toThrow(/APP_ORIGIN/)
    expect(() => loadConfig({ ...env, DATABASE_URL: 'mysql://x@y/z' })).toThrow(/DATABASE_URL/)
  })
})
