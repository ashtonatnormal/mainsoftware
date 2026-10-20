// The server's configuration, read once from the environment and validated with zod. Every
// variable is documented in the root .env.example. Error messages name the variable and the
// problem, never its value: DATABASE_URL, WORKER_DATABASE_URL and AUTH_SECRET are secrets.
import { isIP } from 'node:net'
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

export const DEPLOY_ENVS = ['local', 'test', 'nonprod', 'prod'] as const
export type DeployEnv = (typeof DEPLOY_ENVS)[number]

// The local stack's sign-in secret, as .env.example sets it. It is public, so it's refused
// anywhere but this machine (see isLoopbackOrigin). Low in entropy on purpose, so secret scanners
// don't flag the example file (config.test.ts checks .env.example holds exactly this).
export const LOCAL_AUTH_SECRET = 'hearth-local-hearth-local-hearth-local-hearth'

// True when the app's origin is on this machine. A deployment people use can't have one, because
// their browsers' Origin header would never match it, so this is a second condition for the
// local-only settings, independent of DEPLOY_ENV (T14). It allows the fake provider and the local
// AUTH_SECRET and refuses Twilio, so it must know every localhost origin, or Twilio's refusal
// fails open: the name localhost or any name under it, with or without a trailing dot (browsers
// treat both as this machine), 127.0.0.0/8, ::1, and the unspecified addresses 0.0.0.0 and ::,
// which connect to this machine too, each also in IPv4-mapped form. The URL parser has already
// lower-cased the name and written each address one way (127.1 as 127.0.0.1, ::0:1 as ::1).
export function isLoopbackOrigin(appOrigin: string): boolean {
  if (!URL.canParse(appOrigin)) return false
  const host = new URL(appOrigin).hostname
  const name = host.endsWith('.') ? host.slice(0, -1) : host
  if (name === 'localhost' || name.endsWith('.localhost')) return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host === '0.0.0.0') return true
  return ['[::1]', '[::]', '[::ffff:0:0]'].includes(host) || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host)
}

// TRUST_PROXY: a comma-separated list of IP addresses or CIDR ranges. Fastify ignores a hop count
// (it trusts nothing for a number), and a count could be spoofed by a client that reaches the load
// balancer directly, so only a list is accepted.
function proxyList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
}

function isProxyEntry(entry: string): boolean {
  const [address = '', prefix, ...rest] = entry.split('/')
  const version = isIP(address)
  if (version === 0 || rest.length > 0) return false
  if (prefix === undefined) return true
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (version === 4 ? 32 : 128)
}

function percentEncoded(value: string): boolean {
  // Not a URL at all is reported once, by the URL check.
  if (!URL.canParse(value)) return true
  try {
    const url = new URL(value)
    decodeURIComponent(url.username)
    decodeURIComponent(url.password)
    return true
  } catch {
    return false
  }
}

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// URL' })

// Each role reads only its own database login (TECH-SPEC T18 item 6): the api and realtime roles
// DATABASE_URL (hearth_app), the worker WORKER_DATABASE_URL (hearth_worker), so in AWS no task
// holds another service's credential (C0.11). Locally one .env.example serves all three, and each
// role ignores the other's variables.
const serving = z.object({ DATABASE_URL: postgresUrl })
const working = z.object({
  WORKER_DATABASE_URL: postgresUrl,
  // How many jobs one worker process runs at once; its work pool has this many connections plus one
  // per outbox consumer (T18 item 8).
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
})

const schema = z.object({
  ROLE: z.enum(ROLES).default('api'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_ORIGIN: origin,
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
  // Where this server runs. Settings meant only for this machine are refused anywhere else.
  DEPLOY_ENV: z.enum(DEPLOY_ENVS),
  // The api role's sign-in secret; every sign-in key is derived from it (auth/crypto.ts).
  AUTH_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),
  // How sign-in codes are sent: fake (this machine only: auth/sms/fake.ts), twilio (Twilio Verify,
  // never on this machine: auth/sms/twilio.ts; TECH-SPEC T7, T20) or unset (none can be sent).
  SMS_PROVIDER: z.enum(['fake', 'twilio']).optional(),
  // Twilio Verify's credentials, only with SMS_PROVIDER=twilio: a Restricted API Key scoped to
  // Verify (its SID and secret) and the Verify Service's SID, from Secrets Manager (C0.12). The SIDs
  // take hex digits in either case, as Twilio's API spec's patterns do.
  TWILIO_API_KEY_SID: z
    .string()
    .regex(/^SK[0-9a-fA-F]{32}$/, 'must be an API key SID: SK and 32 hex digits')
    .optional(),
  TWILIO_API_KEY_SECRET: z
    .string()
    .regex(/^[A-Za-z0-9]{32}$/, 'must be 32 letters and digits')
    .optional(),
  TWILIO_VERIFY_SERVICE_SID: z
    .string()
    .regex(/^VA[0-9a-fA-F]{32}$/, 'must be a Verify Service SID: VA and 32 hex digits')
    .optional(),
  // IPs or CIDR ranges of the proxies in front of the server, comma-separated; unset or empty: none.
  TRUST_PROXY: z.string().optional(),
})

export interface Config {
  role: Role
  host: string
  port: number
  logLevel: z.infer<typeof schema>['LOG_LEVEL']
  appOrigin: string
  // The database login this role connects with: DATABASE_URL for api and realtime,
  // WORKER_DATABASE_URL for the worker.
  databaseUrl: string
  valkeyUrl: string
  s3: {
    bucket: string
    region: string
    endpoint: string | undefined
    forcePathStyle: boolean
    credentials: { accessKeyId: string; secretAccessKey: string } | undefined
  }
  deployEnv: DeployEnv
  // The proxies to trust for X-Forwarded-For; false when there are none (locally).
  trustProxy: string[] | false
  // The api role's sign-in settings; undefined for realtime and worker, which never read the secret.
  auth: { secret: string; smsProvider: SmsProviderName | undefined; twilio?: TwilioSettings } | undefined
  // The worker role's settings; undefined for api and realtime.
  worker: { concurrency: number } | undefined
}

export type SmsProviderName = 'fake' | 'twilio'

export interface TwilioSettings {
  apiKeySid: string
  apiKeySecret: string
  serviceSid: string
}

const TWILIO_VARIABLES = ['TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET', 'TWILIO_VERIFY_SERVICE_SID'] as const

export class ConfigError extends Error {
  override name = 'ConfigError'
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An empty variable counts as unset, so a blank line in .env falls back to the default.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''))
  const parsed = schema
    .superRefine((e, ctx) => {
      const problem = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message })
      if ((e.S3_ACCESS_KEY_ID === undefined) !== (e.S3_SECRET_ACCESS_KEY === undefined)) {
        problem('S3_SECRET_ACCESS_KEY', 'set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither')
      }
      const onThisMachine = isLoopbackOrigin(e.APP_ORIGIN)
      if (e.ROLE === 'api' && e.AUTH_SECRET === undefined) problem('AUTH_SECRET', 'required for the api role')
      // Refused whatever the role: the value is public, so no deployment may hold it.
      const localOrTest = e.DEPLOY_ENV === 'local' || e.DEPLOY_ENV === 'test'
      if (e.AUTH_SECRET === LOCAL_AUTH_SECRET && !(localOrTest && onThisMachine)) {
        problem(
          'AUTH_SECRET',
          "the local stack's value from .env.example works only on this machine (DEPLOY_ENV local or test, and a localhost APP_ORIGIN)",
        )
      }
      if (e.SMS_PROVIDER === 'fake' && !(localOrTest && onThisMachine)) {
        problem(
          'SMS_PROVIDER',
          'fake prints codes, so it runs only on this machine (DEPLOY_ENV local or test, and a localhost APP_ORIGIN)',
        )
      }
      // Twilio sends real texts, so it never runs on this machine, by either condition: DEPLOY_ENV is
      // only an enum the operator picks, and a localhost APP_ORIGIN can't be a deployment people use.
      if (e.SMS_PROVIDER === 'twilio' && (localOrTest || onThisMachine)) {
        problem(
          'SMS_PROVIDER',
          'twilio sends real texts, so it never runs on this machine (DEPLOY_ENV nonprod or prod, and an APP_ORIGIN other than localhost)',
        )
      }
      for (const name of TWILIO_VARIABLES) {
        if (e.SMS_PROVIDER === 'twilio' && e[name] === undefined) problem(name, 'required with SMS_PROVIDER=twilio')
        if (e.SMS_PROVIDER !== 'twilio' && e[name] !== undefined) problem(name, 'set only with SMS_PROVIDER=twilio')
      }
      if (!proxyList(e.TRUST_PROXY).every(isProxyEntry)) {
        problem('TRUST_PROXY', 'each entry must be an IP address or CIDR range')
      }
    })
    .safeParse(present)
  // A ROLE that isn't valid is reported above, and its login checked as the api's would be.
  const isWorker = present.ROLE === 'worker'
  const login = isWorker ? working.safeParse(present) : serving.safeParse(present)
  if (!parsed.success || !login.success) {
    const issues = [...(parsed.error?.issues ?? []), ...(login.error?.issues ?? [])]
    const problems = issues.map(issue => `  ${issue.path.join('.')}: ${issue.message}`)
    throw new ConfigError(`Invalid configuration (see .env.example):\n${problems.join('\n')}`)
  }
  const e = parsed.data
  const connection = login.data
  const proxies = proxyList(e.TRUST_PROXY)
  return {
    role: e.ROLE,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    appOrigin: e.APP_ORIGIN,
    databaseUrl: 'WORKER_DATABASE_URL' in connection ? connection.WORKER_DATABASE_URL : connection.DATABASE_URL,
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
    deployEnv: e.DEPLOY_ENV,
    trustProxy: proxies.length > 0 ? proxies : false,
    auth:
      e.ROLE === 'api' && e.AUTH_SECRET !== undefined
        ? {
            secret: e.AUTH_SECRET,
            smsProvider: e.SMS_PROVIDER,
            ...(e.SMS_PROVIDER === 'twilio' &&
            e.TWILIO_API_KEY_SID !== undefined &&
            e.TWILIO_API_KEY_SECRET !== undefined &&
            e.TWILIO_VERIFY_SERVICE_SID !== undefined
              ? {
                  twilio: {
                    apiKeySid: e.TWILIO_API_KEY_SID,
                    apiKeySecret: e.TWILIO_API_KEY_SECRET,
                    serviceSid: e.TWILIO_VERIFY_SERVICE_SID,
                  },
                }
              : {}),
          }
        : undefined,
    worker: 'WORKER_CONCURRENCY' in connection ? { concurrency: connection.WORKER_CONCURRENCY } : undefined,
  }
}
