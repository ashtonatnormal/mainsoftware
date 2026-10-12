// One pino logger for the whole process, shared with Fastify. Logs go to CloudWatch, where
// engineers read them, so anything that could carry a credential or a person's contact details
// is replaced before it is written (CLAUDE.md, Security and privacy; PDPA). Redaction is the
// backstop: code still shouldn't log request bodies or secrets in the first place.
import { type DestinationStream, type Logger, type LoggerOptions, pino } from 'pino'
import type { Config, Role } from '#src/config.ts'

// Keys whose values are never written, at the top level and up to three levels down (pino's
// wildcard covers one level each).
const SENSITIVE_KEYS = [
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'pin',
  'otp',
  'token',
  'accessToken',
  'refreshToken',
  'sessionToken',
  'secret',
  'apiKey',
  'phone',
  'phoneNumber',
  'databaseUrl',
  'valkeyUrl',
  'connectionString',
  'secretAccessKey',
]

const key = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? `.${name}` : `["${name}"]`)

export const REDACT_PATHS = [
  ...SENSITIVE_KEYS.flatMap(name => [
    key(name).replace(/^\./, ''),
    `*${key(name)}`,
    `*.*${key(name)}`,
    `*.*.*${key(name)}`,
  ]),
  // ioredis attaches a failed command to its error as `command.args`. When Valkey refuses the
  // connection's HELLO, those are `3 AUTH <user> <password>`; from C0.5 they are rate-limit and
  // session keys. Logged as `err` (or under any key), they are dropped.
  'command.args',
  '*.command.args',
  '*.*.command.args',
]

export const CENSOR = '[redacted]'

// Fastify passes requests to Pino for its automatic request logs. Keep the useful request
// metadata, but never include the query string: URLs are not covered by key-based redaction.
export const requestSerializer = (request: {
  method?: string
  url?: string
  hostname?: string
  ip?: string
  remoteAddress?: string
  remotePort?: number
}) => ({
  method: request.method,
  url: request.url?.split('?')[0],
  hostname: request.hostname,
  remoteAddress: request.remoteAddress ?? request.ip,
  remotePort: request.remotePort,
})

export function loggerOptions(config: Pick<Config, 'logLevel'> & { role: Role }): LoggerOptions {
  return {
    level: config.logLevel,
    base: { role: config.role },
    redact: { paths: REDACT_PATHS, censor: CENSOR },
    serializers: { req: requestSerializer },
  }
}

export function createLogger(
  config: Pick<Config, 'logLevel'> & { role: Role },
  destination?: DestinationStream,
): Logger {
  return pino(loggerOptions(config), destination)
}
