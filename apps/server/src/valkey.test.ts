import { Writable } from 'node:stream'
import { Redis } from 'ioredis'
import { describe, expect, it } from 'vitest'
import { createLogger } from '#src/logger.ts'
import { createSubscriber } from '#src/valkey.ts'

function capture() {
  const lines: Record<string, unknown>[] = []
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(JSON.parse(String(chunk)))
      done()
    },
  })
  return { logger: createLogger({ logLevel: 'info', role: 'realtime' }, stream), lines }
}

describe('C0.5 the revocation channel connection', () => {
  it('is a second connection of its own, which queues commands while it connects', () => {
    const { logger } = capture()
    // lazyConnect, so nothing here reaches a Valkey; the duplicate inherits it.
    const client = new Redis({ lazyConnect: true, enableOfflineQueue: false })
    const sub = createSubscriber(client, logger)
    try {
      expect(sub).not.toBe(client)
      expect(sub.options.connectionName).toBe('hearth-revocations')
      expect(sub.options.enableOfflineQueue).toBe(true)
      expect(client.options.enableOfflineQueue).toBe(false)
    } finally {
      sub.disconnect()
      client.disconnect()
    }
  })

  it('logs a repeated connection error once, and says when the connection is back', () => {
    const { logger, lines } = capture()
    const client = new Redis({ lazyConnect: true })
    const sub = createSubscriber(client, logger)
    try {
      sub.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:6379'))
      sub.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:6379'))
      sub.emit('ready')
      sub.emit('ready')
      expect(lines.map(line => line.msg)).toEqual([
        'valkey subscriber connection error',
        'valkey subscriber connection restored',
      ])
    } finally {
      sub.disconnect()
      client.disconnect()
    }
  })
})
