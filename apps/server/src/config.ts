// The server's configuration, read once from the environment and validated with zod. Every
// variable is documented in the root .env.example. Error messages name the variable and the
// problem, never its value: DATABASE_URL holds a password.
import { z } from 'zod'

export const ROLES = ['api', 'realtime', 'worker'] as const
export type Role = (typeof ROLES)[number]

// An origin such as https://hearth.example.com: a scheme, a host and an optional port, nothing
// else. The Origin check compares it with the browser's Origin header exactly (CLAUDE.md,
// Security and privacy), so a trailing slash or a path would refuse every request.
const origin = z.string().refine(value => URL.canParse(value) && new URL(value).origin === value, {
  message: 'must be an origin such as https://hearth.example.com, with no path or trailing slash',
})

const flag = z.enum(['true', 'false']).transform(value => value === 'true')

function percentEncoded(value: string): boolean {
  try {
    const url = new URL(value)
    decodeURIComponent(url.username)
    decodeURIComponent(url.password)
    return true
  } catch {
    return false
  }
}

const schema = z.object({
  ROLE: z.enum(ROLES).default('api'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_ORIGIN: origin,
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// URL' }),
  // redis:// locally, rediss:// (TLS) for ElastiCache. ioredis reads only these two schemes, and
  // it decodes the user name and password itself, throwing at start on a bare % in either.
  VALKEY_URL: z
    .url({ protocol: /^rediss?$/, error: 'must be a redis:// or rediss:// URL' })
    .refine(percentEncoded, { message: 'the user name and password must be percent-encoded' }),
  S3_BUCKET: z.string().min(3),
  S3_REGION: z.string().min(1).default('ap-southeast-1'),
  // Only for a local S3-compatible store; unset in AWS, where the SDK uses S3's own endpoint.
  S3_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
  S3_FORCE_PATH_STYLE: flag.default(false),
  // Only for the local store's dummy keys; unset in AWS, where the ECS task role signs requests.
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
})

export interface Config {
  role: Role
  host: string
  port: number
  logLevel: z.infer<typeof schema>['LOG_LEVEL']
  appOrigin: string
  databaseUrl: string
  valkeyUrl: string
  s3: {
    bucket: string
    region: string
    endpoint: string | undefined
    forcePathStyle: boolean
    credentials: { accessKeyId: string; secretAccessKey: string } | undefined
  }
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An empty variable counts as unset, so a blank line in .env falls back to the default.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''))
  const parsed = schema
    .refine(e => (e.S3_ACCESS_KEY_ID === undefined) === (e.S3_SECRET_ACCESS_KEY === undefined), {
      message: 'set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither',
      path: ['S3_SECRET_ACCESS_KEY'],
    })
    .safeParse(present)
  if (!parsed.success) {
    const problems = parsed.error.issues.map(issue => `  ${issue.path.join('.')}: ${issue.message}`)
    throw new ConfigError(`Invalid configuration (see .env.example):\n${problems.join('\n')}`)
  }
  const e = parsed.data
  return {
    role: e.ROLE,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    appOrigin: e.APP_ORIGIN,
    databaseUrl: e.DATABASE_URL,
    valkeyUrl: e.VALKEY_URL,
    s3: {
      bucket: e.S3_BUCKET,
      region: e.S3_REGION,
      endpoint: e.S3_ENDPOINT,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
      credentials:
        e.S3_ACCESS_KEY_ID && e.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY }
          : undefined,
    },
  }
}
