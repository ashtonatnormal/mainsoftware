// A logger that keeps every line it writes, parsed, for unit tests (test-only; the image leaves
// testing/ out). It is the server's own logger (redaction included), at debug.
import { Writable } from 'node:stream'
import type { Logger } from 'pino'
import type { Role } from '#src/config.ts'
import { createLogger } from '#src/logger.ts'

export function captureLogger(role: Role = 'worker'): {
  logger: Logger
  lines: Record<string, unknown>[]
  // The lines with this event field.
  events: (event: string) => Record<string, unknown>[]
} {
  const lines: Record<string, unknown>[] = []
  const stream = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split('\n')) if (line.trim() !== '') lines.push(JSON.parse(line))
      done()
    },
  })
  return {
    logger: createLogger({ logLevel: 'debug', role }, stream),
    lines,
    events: event => lines.filter(line => line.event === event),
  }
}
