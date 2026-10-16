import { Writable } from 'node:stream'
import { Redis } from 'ioredis'
import { describe, expect, it } from 'vitest'
import { createLogger } from '#src/logger.ts'
import { GATEWAY_POLICY } from '#src/realtime/policy.ts'
import { createBlockingReader, createSubscriber } from '#src/valkey.ts'

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

describe('C0.5 C0.6 the pub/sub connection (the revocation and flags channels)', () => {
  it('is a second connection of its own, which queues commands while it connects and leaves subscribing again to pubsub.ts', () => {
    const { logger } = capture()
    // lazyConnect, so nothing here reaches a Valkey; the duplicate inherits it.
    const client = new Redis({ lazyConnect: true, enableOfflineQueue: false })
    const sub = createSubscriber(client, logger)
    try {
      expect(sub).not.toBe(client)
      expect(sub.options.connectionName).toBe('hearth-subscriber')
      expect(sub.options.enableOfflineQueue).toBe(true)
      expect(client.options.enableOfflineQueue).toBe(false)
      // ioredis's own re-subscribe after a reconnect is off: its failure would be unhandled.
      expect(sub.options.autoResubscribe).toBe(false)
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

describe('C0.7 T19 item 9 the gateway’s blocking-reader connection', () => {
  it('CR-01: is a connection of its own whose timeouts can’t cut a healthy XREAD BLOCK, and still drop a silent peer', () => {
    const { logger, lines } = capture()
    // The command client's own settings (valkey.ts createValkey), which duplicate() would copy.
    const client = new Redis({
      lazyConnect: true,
      commandTimeout: 1000,
      socketTimeout: 2000,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    })
    const reader = createBlockingReader(client, logger)
    try {
      expect(reader).not.toBe(client)
      expect(reader.options.connectionName).toBe('hearth-gateway-reader')
      expect(reader.options.commandTimeout).toBeUndefined()
      expect(reader.options.socketTimeout).toBeGreaterThan(GATEWAY_POLICY.readerBlockMs)
      expect(reader.options.socketTimeout).toBe(GATEWAY_POLICY.readerBlockMs + 3000)
      expect(reader.options.blockingTimeout).toBe(GATEWAY_POLICY.readerBlockMs + 2000)
      expect(reader.options.blockingTimeout).toBeLessThan(reader.options.socketTimeout as number)
      // The loop retries and re-reads from its own position: nothing queues or is resent.
      expect(reader.options.enableOfflineQueue).toBe(false)
      expect(reader.options.autoResendUnfulfilledCommands).toBe(false)
      expect(reader.options.maxRetriesPerRequest).toBe(1)
      expect(reader.options.autoResubscribe).toBe(false)
      // The command client keeps its own.
      expect(client.options.commandTimeout).toBe(1000)
      expect(client.options.socketTimeout).toBe(2000)
      // Its connection errors are logged as the others' are.
      reader.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:6379'))
      expect(lines.map(line => line.msg)).toEqual(['valkey reader connection error'])
    } finally {
      reader.disconnect()
      client.disconnect()
    }
  })
})
