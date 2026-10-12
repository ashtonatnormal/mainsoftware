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
      s3: {
        bucket: 'hearth-local',
        region: 'ap-southeast-1',
        endpoint: undefined,
        forcePathStyle: false,
        credentials: undefined,
      },
    })
  })

  it('reads the role, port and local S3 settings', () => {
    const config = loadConfig({
      ...env,
      ROLE: 'worker',
      PORT: '3002',
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY_ID: 'hearth-local',
      S3_SECRET_ACCESS_KEY: 'hearth-local-secret',
    })
    expect(config.role).toBe('worker')
    expect(config.port).toBe(3002)
    expect(config.s3).toMatchObject({
      endpoint: 'http://127.0.0.1:9000',
      forcePathStyle: true,
      credentials: { accessKeyId: 'hearth-local', secretAccessKey: 'hearth-local-secret' },
    })
  })

  it('needs both S3 keys or neither', () => {
    expect(() => loadConfig({ ...env, S3_ACCESS_KEY_ID: 'hearth-local' })).toThrow(/S3_SECRET_ACCESS_KEY/)
  })

  it('accepts only the Valkey URL schemes ioredis reads, so TLS is never silently dropped', () => {
    expect(loadConfig({ ...env, VALKEY_URL: 'rediss://cache.example:6379' }).valkeyUrl).toBe(
      'rediss://cache.example:6379',
    )
    expect(() => loadConfig({ ...env, VALKEY_URL: 'valkeys://cache.example:6379' })).toThrow(/VALKEY_URL/)
  })

  it('refuses a Valkey URL whose password has a bare %, which ioredis would throw on at start', () => {
    expect(() => loadConfig({ ...env, VALKEY_URL: 'redis://:ab%zz@127.0.0.1:6379' })).toThrow(/percent-encoded/)
    expect(loadConfig({ ...env, VALKEY_URL: 'rediss://default:p%2Fw@cache:6379' }).valkeyUrl).toContain('p%2Fw')
  })

  it('reports a Valkey URL that is not a URL once', () => {
    try {
      loadConfig({ ...env, VALKEY_URL: 'not a url' })
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message.match(/VALKEY_URL:/g)).toHaveLength(1)
    }
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
