// A stand-in for the process's Valkey subscriber connection in unit tests (test-only; the image
// leaves testing/ out): the methods pubsub.ts and closeValkey use, with an emitter a test drives
// ('message', 'ready', 'close'), a subscribe that can fail a given number of times first, a ping a
// test can make fail, and a status it can set.
import { EventEmitter } from 'node:events'
import type { Redis } from 'ioredis'
import { vi } from 'vitest'

export function fakeSubscriber(options: { failures?: number } = {}) {
  const events = new EventEmitter()
  let failures = options.failures ?? 0
  const subscribe = vi.fn(async (_channel: string) => {
    if (failures > 0) {
      failures--
      throw new Error('Connection is closed.')
    }
    return 1
  })
  const ping = vi.fn(async () => 'PONG')
  const client = {
    status: 'ready',
    on: (event: string, listener: (...args: string[]) => void) => {
      events.on(event, listener)
      return client
    },
    subscribe,
    ping,
    quit: vi.fn(async () => 'OK'),
    disconnect: vi.fn(),
  }
  return { client, events, subscribe, ping, asRedis: client as unknown as Redis }
}
