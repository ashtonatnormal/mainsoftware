import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { describe, expect, it } from 'vitest'
import { ConfigError, isLoopbackOrigin, LOCAL_AUTH_SECRET, loadConfig } from '#src/config.ts'

// A low-entropy test value: secret scanners read test files too.
const SECRET = 'test-secret-test-secret-test-secret'

const env = {
  APP_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgres://hearth:a-db-password@127.0.0.1:5432/hearth',
  VALKEY_URL: 'redis://127.0.0.1:6379',
  S3_BUCKET: 'hearth-local',
  DEPLOY_ENV: 'local',
  AUTH_SECRET: SECRET,
}

const WORKER_URL = 'postgres://hearth_worker:a-worker-password@127.0.0.1:5432/hearth'

// Localhost origins beyond localhost, 127.0.0.1 and [::1], each a valid APP_ORIGIN: names under
// localhost, a trailing dot, the rest of 127.0.0.0/8, the unspecified addresses and IPv4-mapped
// forms. Twilio must be refused at every one (T14 item 1, T20 item 10).
const LOOPBACK = [
  'http://hearth.localhost:5173',
  'https://hearth.localhost',
  'http://localhost.:5173',
  'http://a.localhost.:5173',
  'http://127.0.0.2:3000',
  'http://127.255.255.254:3000',
  'http://0.0.0.0:3000',
  'http://[::]:3000',
  'http://[::ffff:7f00:1]:3000',
  'http://[::ffff:7fff:fffe]:3000',
  'http://[::ffff:0:0]:3000',
] as const

function problems(load: () => unknown): string {
  try {
    load()
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return (error as Error).message
  }
  throw new Error('expected the configuration to be refused')
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
      deployEnv: 'local',
      trustProxy: false,
      auth: { secret: SECRET, smsProvider: undefined },
      worker: undefined,
    })
  })

  it('reads the role, port and local S3 settings', () => {
    const config = loadConfig({
      ...env,
      ROLE: 'worker',
      WORKER_DATABASE_URL: WORKER_URL,
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
    for (const name of ['ROLE', 'PORT', 'APP_ORIGIN', 'DATABASE_URL', 'VALKEY_URL', 'S3_BUCKET', 'DEPLOY_ENV']) {
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

describe('C0.5 T14 sign-in settings', () => {
  it('needs DEPLOY_ENV, with no default', () => {
    const { DEPLOY_ENV: _, ...rest } = env
    expect(problems(() => loadConfig(rest))).toMatch(/DEPLOY_ENV:/)
    expect(problems(() => loadConfig({ ...env, DEPLOY_ENV: 'staging' }))).toMatch(/DEPLOY_ENV:/)
  })

  it('needs AUTH_SECRET for the api role only, and gives the other roles no sign-in settings', () => {
    const { AUTH_SECRET: _, ...rest } = env
    expect(problems(() => loadConfig(rest))).toMatch(/AUTH_SECRET: required for the api role/)
    expect(problems(() => loadConfig({ ...rest, ROLE: 'api' }))).toMatch(/AUTH_SECRET:/)
    for (const role of ['realtime', 'worker']) {
      expect(loadConfig({ ...rest, ROLE: role, WORKER_DATABASE_URL: WORKER_URL }).auth).toBeUndefined()
      expect(loadConfig({ ...env, ROLE: role, WORKER_DATABASE_URL: WORKER_URL }).auth).toBeUndefined()
    }
  })

  it('refuses a secret shorter than 32 characters', () => {
    expect(problems(() => loadConfig({ ...env, AUTH_SECRET: 'x'.repeat(31) }))).toMatch(
      /AUTH_SECRET: must be at least 32 characters/,
    )
    expect(loadConfig({ ...env, AUTH_SECRET: 'x'.repeat(32) }).auth?.secret).toHaveLength(32)
  })

  it("takes the local stack's public secret only on this machine (DEPLOY_ENV local or test, localhost origin)", () => {
    const local = { ...env, AUTH_SECRET: LOCAL_AUTH_SECRET }
    for (const deployEnv of ['local', 'test']) {
      for (const appOrigin of ['http://localhost:5173', 'https://127.0.0.1:5173', 'http://[::1]:5173']) {
        expect(loadConfig({ ...local, DEPLOY_ENV: deployEnv, APP_ORIGIN: appOrigin }).auth?.secret).toBe(
          LOCAL_AUTH_SECRET,
        )
      }
    }
    for (const deployEnv of ['nonprod', 'prod']) {
      expect(problems(() => loadConfig({ ...local, DEPLOY_ENV: deployEnv }))).toMatch(/AUTH_SECRET: the local stack/)
    }
    expect(problems(() => loadConfig({ ...local, APP_ORIGIN: 'https://hearth.example' }))).toMatch(
      /AUTH_SECRET: the local stack/,
    )
    // Refused for every role, since no deployment may hold a public secret.
    expect(problems(() => loadConfig({ ...local, ROLE: 'realtime', DEPLOY_ENV: 'prod' }))).toMatch(/AUTH_SECRET:/)
  })

  it('T20: runs the fake SMS provider only with DEPLOY_ENV local or test and a localhost origin', () => {
    for (const deployEnv of ['local', 'test']) {
      expect(loadConfig({ ...env, SMS_PROVIDER: 'fake', DEPLOY_ENV: deployEnv }).auth).toEqual({
        secret: SECRET,
        smsProvider: 'fake',
      })
    }
    for (const deployEnv of ['nonprod', 'prod']) {
      expect(problems(() => loadConfig({ ...env, SMS_PROVIDER: 'fake', DEPLOY_ENV: deployEnv }))).toMatch(
        /SMS_PROVIDER: fake prints codes/,
      )
    }
    expect(problems(() => loadConfig({ ...env, SMS_PROVIDER: 'fake', APP_ORIGIN: 'https://hearth.example' }))).toMatch(
      /SMS_PROVIDER:/,
    )
    // The C0.5 log provider is gone, and AWS isn't built yet.
    for (const provider of ['log', 'aws']) {
      expect(problems(() => loadConfig({ ...env, SMS_PROVIDER: provider }))).toMatch(/SMS_PROVIDER:/)
    }
  })

  // Shapes built at run time, so no file holds a credential's shape; low-entropy values.
  const twilioEnv = {
    SMS_PROVIDER: 'twilio',
    TWILIO_API_KEY_SID: `SK${'0'.repeat(32)}`,
    TWILIO_API_KEY_SECRET: 'a'.repeat(32),
    TWILIO_VERIFY_SERVICE_SID: `VA${'0'.repeat(32)}`,
  }

  it('T7 T20: runs Twilio Verify only off this machine (DEPLOY_ENV nonprod or prod, and an origin other than localhost)', () => {
    const real = { ...env, ...twilioEnv, APP_ORIGIN: 'https://hearth.example' }
    for (const deployEnv of ['nonprod', 'prod']) {
      expect(loadConfig({ ...real, DEPLOY_ENV: deployEnv }).auth).toEqual({
        secret: SECRET,
        smsProvider: 'twilio',
        twilio: {
          apiKeySid: twilioEnv.TWILIO_API_KEY_SID,
          apiKeySecret: twilioEnv.TWILIO_API_KEY_SECRET,
          serviceSid: twilioEnv.TWILIO_VERIFY_SERVICE_SID,
        },
      })
    }
    for (const deployEnv of ['local', 'test']) {
      expect(problems(() => loadConfig({ ...real, DEPLOY_ENV: deployEnv }))).toMatch(
        /SMS_PROVIDER: twilio sends real texts/,
      )
    }
    // Every localhost origin, however it is written, not just the three common spellings.
    for (const appOrigin of [...LOOPBACK, 'http://localhost:5173', 'http://127.0.0.1:3000']) {
      expect(problems(() => loadConfig({ ...real, DEPLOY_ENV: 'nonprod', APP_ORIGIN: appOrigin }))).toMatch(
        /SMS_PROVIDER: twilio sends real texts/,
      )
    }
  })

  it('T20: needs every TWILIO_ variable with twilio, refuses them without it, checks their shapes and never echoes them', () => {
    const real = { ...env, ...twilioEnv, APP_ORIGIN: 'https://hearth.example', DEPLOY_ENV: 'prod' }
    for (const name of ['TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET', 'TWILIO_VERIFY_SERVICE_SID'] as const) {
      expect(problems(() => loadConfig({ ...real, [name]: undefined }))).toContain(
        `${name}: required with SMS_PROVIDER=twilio`,
      )
      expect(problems(() => loadConfig({ ...env, [name]: twilioEnv[name] }))).toContain(
        `${name}: set only with SMS_PROVIDER=twilio`,
      )
    }
    const bad = { TWILIO_API_KEY_SID: 'SKnot-hex', TWILIO_API_KEY_SECRET: 'short', TWILIO_VERIFY_SERVICE_SID: 'VAx' }
    const message = problems(() => loadConfig({ ...real, ...bad }))
    expect(message).toMatch(/TWILIO_API_KEY_SID: must be an API key SID/)
    expect(message).toMatch(/TWILIO_API_KEY_SECRET: must be 32 letters and digits/)
    expect(message).toMatch(/TWILIO_VERIFY_SERVICE_SID: must be a Verify Service SID/)
    for (const value of Object.values(bad)) expect(message).not.toContain(value)
    const secret = 'b'.repeat(32)
    expect(problems(() => loadConfig({ ...env, TWILIO_API_KEY_SECRET: secret }))).not.toContain(secret)
  })

  it('reads TRUST_PROXY as a list of addresses and CIDR ranges, never a hop count', () => {
    expect(loadConfig({ ...env, TRUST_PROXY: '10.0.0.0/16, 2600:9000::/28' }).trustProxy).toEqual([
      '10.0.0.0/16',
      '2600:9000::/28',
    ])
    expect(loadConfig({ ...env, TRUST_PROXY: '127.0.0.1' }).trustProxy).toEqual(['127.0.0.1'])
    expect(loadConfig({ ...env, TRUST_PROXY: ' , ' }).trustProxy).toBe(false)
    for (const value of ['10.0.0.0/33', 'x', '1', '2600:9000::/129', '10.0.0.0/8/8', '10.0.0.0/', '10.0.0.0/-1']) {
      expect(problems(() => loadConfig({ ...env, TRUST_PROXY: value }))).toMatch(
        /TRUST_PROXY: each entry must be an IP address or CIDR range/,
      )
    }
  })

  it('never echoes a sign-in setting in its error', () => {
    const message = problems(() =>
      loadConfig({ ...env, DEPLOY_ENV: 'prod', AUTH_SECRET: LOCAL_AUTH_SECRET, TRUST_PROXY: '10.9.8.7/99' }),
    )
    expect(message).not.toContain(LOCAL_AUTH_SECRET)
    expect(message).not.toContain('10.9.8.7')
    expect(problems(() => loadConfig({ ...env, AUTH_SECRET: 'short-secret-value' }))).not.toContain(
      'short-secret-value',
    )
  })

  it('knows a loopback origin from any other', () => {
    expect(isLoopbackOrigin('http://localhost:5173')).toBe(true)
    expect(isLoopbackOrigin('https://localhost')).toBe(true)
    expect(isLoopbackOrigin('http://127.0.0.1:3000')).toBe(true)
    expect(isLoopbackOrigin('http://[::1]:5173')).toBe(true)
    for (const origin of LOOPBACK) expect(isLoopbackOrigin(origin), origin).toBe(true)
    // Written another way, as createTwilioVerify may be given it: the URL parser settles each.
    for (const origin of ['http://LOCALHOST:5173', 'http://127.1:3000', 'http://[0:0:0:0:0:0:0:1]:5173']) {
      expect(isLoopbackOrigin(origin), origin).toBe(true)
    }
    for (const origin of [
      'https://hearth.example',
      'http://localhost.example',
      'http://localhost.example.',
      'http://notlocalhost:5173',
      'http://127.0.0.1.example',
      'http://128.0.0.1:3000',
      'http://10.0.0.1:3000',
      'http://[::2]:3000',
      'http://[::ffff:a00:1]:3000',
      'not a url',
    ]) {
      expect(isLoopbackOrigin(origin), origin).toBe(false)
    }
  })

  it('loads .env.example for every role, and only the api role reads its secret (T14)', () => {
    const example = parseEnv(readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'))
    expect(example.AUTH_SECRET).toBe(LOCAL_AUTH_SECRET)
    expect(loadConfig({ ...example, ROLE: 'api' }).auth).toEqual({ secret: LOCAL_AUTH_SECRET, smsProvider: 'fake' })
    for (const role of ['realtime', 'worker']) {
      const config = loadConfig({ ...example, ROLE: role })
      expect(config.auth).toBeUndefined()
      expect(config.deployEnv).toBe('local')
      expect(config.trustProxy).toBe(false)
    }
  })
})

describe('C0.6 T18 the worker connects with its own login', () => {
  const { DATABASE_URL: _unused, ...withoutApp } = env

  it('the worker needs WORKER_DATABASE_URL and connects with it, never with DATABASE_URL', () => {
    const config = loadConfig({ ...withoutApp, ROLE: 'worker', WORKER_DATABASE_URL: WORKER_URL })
    expect(config.databaseUrl).toBe(WORKER_URL)
    expect(config.worker).toEqual({ concurrency: 4 })
    // With both set, as .env.example has them locally, it still takes its own.
    expect(loadConfig({ ...env, ROLE: 'worker', WORKER_DATABASE_URL: WORKER_URL }).databaseUrl).toBe(WORKER_URL)
    expect(problems(() => loadConfig({ ...env, ROLE: 'worker' }))).toMatch(/WORKER_DATABASE_URL:/)
    expect(problems(() => loadConfig({ ...env, ROLE: 'worker', WORKER_DATABASE_URL: 'mysql://x@y/z' }))).toMatch(
      /WORKER_DATABASE_URL: must be a postgres:\/\/ URL/,
    )
  })

  it('api and realtime need DATABASE_URL and ignore the worker’s variables, invalid or not', () => {
    for (const role of ['api', 'realtime']) {
      const config = loadConfig({ ...env, ROLE: role, WORKER_DATABASE_URL: 'not a url', WORKER_CONCURRENCY: '99' })
      expect(config.databaseUrl).toBe(env.DATABASE_URL)
      expect(config.worker).toBeUndefined()
      expect(problems(() => loadConfig({ ...withoutApp, ROLE: role, WORKER_DATABASE_URL: WORKER_URL }))).toMatch(
        /DATABASE_URL:/,
      )
    }
  })

  it('WORKER_CONCURRENCY is a whole number from 1 to 32', () => {
    const worker = { ...withoutApp, ROLE: 'worker', WORKER_DATABASE_URL: WORKER_URL }
    expect(loadConfig({ ...worker, WORKER_CONCURRENCY: '1' }).worker).toEqual({ concurrency: 1 })
    expect(loadConfig({ ...worker, WORKER_CONCURRENCY: '32' }).worker).toEqual({ concurrency: 32 })
    for (const value of ['0', '33', '2.5', 'four']) {
      expect(
        problems(() => loadConfig({ ...worker, WORKER_CONCURRENCY: value })),
        value,
      ).toMatch(/WORKER_CONCURRENCY:/)
    }
  })

  it('never echoes the worker’s password in its error', () => {
    const message = problems(() =>
      loadConfig({ ...env, ROLE: 'worker', WORKER_DATABASE_URL: 'postgres://w:a-worker-password@not a url' }),
    )
    expect(message).toContain('WORKER_DATABASE_URL:')
    expect(message).not.toContain('a-worker-password')
  })

  it('.env.example gives the worker hearth_worker and the other roles hearth_app', () => {
    const example = parseEnv(readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'))
    expect(new URL(loadConfig({ ...example, ROLE: 'worker' }).databaseUrl).username).toBe('hearth_worker')
    for (const role of ['api', 'realtime']) {
      expect(new URL(loadConfig({ ...example, ROLE: role }).databaseUrl).username).toBe('hearth_app')
    }
  })
})
