import { describe, expect, it, vi } from 'vitest'
import { Subscriptions } from '#src/pubsub.ts'
import { listenRevoked, publishRevoked, REVOKED_CHUNK, RevokedMessage } from '#src/revocation.ts'
import { fakeSubscriber } from '#src/testing/subscriber.ts'

const id = (n: number) => `d0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const logger = () => ({ warn: vi.fn(), error: vi.fn() })

describe('C0.5 T5 publishing ended sessions to the realtime role', () => {
  it('publishes nothing when no session ended', async () => {
    const valkey = { publish: vi.fn() }
    await publishRevoked(valkey, 'it:unit:', [], logger())
    expect(valkey.publish).not.toHaveBeenCalled()
  })

  it('publishes session ids only, in messages of at most 500, on the prefix revoked channel', async () => {
    const published: [string, string][] = []
    const valkey = { publish: async (channel: string, message: string) => published.push([channel, message]) }
    const ids = Array.from({ length: REVOKED_CHUNK * 2 + 1 }, (_, n) => id(n))
    await publishRevoked(valkey, 'it:unit:', ids, logger())
    expect(published.map(([channel]) => channel)).toEqual(['it:unit:revoked', 'it:unit:revoked', 'it:unit:revoked'])
    const messages = published.map(([, message]) => RevokedMessage.parse(JSON.parse(message)))
    expect(messages.map(m => m.sessions.length)).toEqual([500, 500, 1])
    expect(messages.flatMap(m => m.sessions)).toEqual(ids)
  })

  it('logs and swallows a failed publish: the realtime re-check closes those sockets instead', async () => {
    const log = logger()
    const valkey = { publish: vi.fn().mockRejectedValue(new Error('Connection is closed.')) }
    await expect(publishRevoked(valkey, 'it:unit:', [id(1)], log)).resolves.toBeUndefined()
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'revocation_publish_failed', sessions: 1 }))
  })
})

describe('C0.5 T5 listening for ended sessions', () => {
  it('subscribes to the channel and hands on the ids of a well-formed message', async () => {
    const sub = fakeSubscriber()
    const seen: [string[], number][] = []
    await listenRevoked(
      new Subscriptions(sub.asRedis, { info: vi.fn(), warn: vi.fn() }),
      'it:unit:',
      (ids, at) => seen.push([ids, at]),
      logger(),
    )
    expect(sub.subscribe.mock.calls.map(([channel]) => channel)).toEqual(['it:unit:revoked'])
    sub.events.emit('message', 'it:unit:revoked', JSON.stringify({ v: 1, at: 1234, sessions: [id(1), id(2)] }))
    expect(seen).toEqual([[[id(1), id(2)], 1234]])
  })

  it("ignores another channel's messages, and logs and drops one that isn't ours", async () => {
    const sub = fakeSubscriber()
    const log = logger()
    const onRevoked = vi.fn()
    await listenRevoked(new Subscriptions(sub.asRedis, { info: vi.fn(), warn: vi.fn() }), 'it:unit:', onRevoked, log)
    sub.events.emit('message', 'h:prod:revoked', JSON.stringify({ v: 1, at: 1, sessions: [id(1)] }))
    for (const bad of [
      'not json',
      JSON.stringify({ v: 2, at: 1, sessions: [] }),
      JSON.stringify({ v: 1, at: 1, sessions: ['x'] }),
    ]) {
      sub.events.emit('message', 'it:unit:revoked', bad)
    }
    expect(onRevoked).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledTimes(3)
    expect(log.warn).toHaveBeenCalledWith({ event: 'revocation_message_unreadable' })
  })
})
