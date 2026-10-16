import { describe, expect, it, vi } from 'vitest'
import { Subscriptions } from '#src/pubsub.ts'
import {
  ACCESS_CHUNK,
  AccessMessage,
  listenAccess,
  listenRevoked,
  publishAccess,
  publishRevoked,
  REVOKED_CHUNK,
  RevokedMessage,
} from '#src/revocation/channels.ts'
import { fakeSubscriber } from '#src/testing/subscriber.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const id = (n: number) => `d0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const logger = () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() })

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
    // v1 on the wire, unchanged since C0.5: v, at and sessions, nothing else.
    expect(Object.keys(JSON.parse(published[0]?.[1] ?? '{}'))).toEqual(['v', 'at', 'sessions'])
  })

  it('logs and swallows a failed publish: the realtime re-check closes those sockets instead', async () => {
    const log = logger()
    const valkey = { publish: vi.fn().mockRejectedValue(new Error('Connection is closed.')) }
    await expect(publishRevoked(valkey, 'it:unit:', [id(1)], log)).resolves.toBeUndefined()
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'revocation_publish_failed', sessions: 1 }))
  })

  it('OUTBOX-2: with rethrow, logs a failed publish and then throws it, for a retried job', async () => {
    const log = logger()
    const failure = new Error('Connection is closed.')
    const valkey = { publish: vi.fn().mockRejectedValue(failure) }
    await expect(publishRevoked(valkey, 'it:unit:', [id(1)], log, { rethrow: true })).rejects.toBe(failure)
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'revocation_publish_failed', sessions: 1 }))
  })
})

describe('C0.5 T5 C0.7 T19 item 5 listening for ended sessions', () => {
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

  it('C-09 T19 item 5: reads a v1 message with a field it does not know, so a later step can add one', async () => {
    const sub = fakeSubscriber()
    const seen: string[][] = []
    const log = logger()
    await listenRevoked(
      new Subscriptions(sub.asRedis, { info: vi.fn(), warn: vi.fn() }),
      'it:unit:',
      ids => seen.push(ids),
      log,
    )
    sub.events.emit(
      'message',
      'it:unit:revoked',
      JSON.stringify({ v: 1, at: 1, sessions: [id(3)], reason: 'deactivated', path: 'push' }),
    )
    expect(seen).toEqual([[id(3)]])
    expect(log.warn).not.toHaveBeenCalled()
  })

  it("ignores another channel's messages, and logs and drops one that isn't ours, another version's included", async () => {
    const sub = fakeSubscriber()
    const log = logger()
    const onRevoked = vi.fn()
    await listenRevoked(new Subscriptions(sub.asRedis, { info: vi.fn(), warn: vi.fn() }), 'it:unit:', onRevoked, log)
    sub.events.emit('message', 'h:prod:revoked', JSON.stringify({ v: 1, at: 1, sessions: [id(1)] }))
    for (const bad of [
      'not json',
      JSON.stringify({ v: 2, at: 1, sessions: [] }),
      JSON.stringify({ v: 2, at: 1, sessions: [id(1)] }),
      JSON.stringify({ v: 1, at: 1, sessions: ['x'] }),
    ]) {
      sub.events.emit('message', 'it:unit:revoked', bad)
    }
    expect(onRevoked).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledTimes(4)
    expect(log.warn).toHaveBeenCalledWith({ event: 'revocation_message_unreadable' })
  })
})

describe('C0.7 T19 item 5 the access channel', () => {
  const message = (change: Partial<AccessMessage> = {}): AccessMessage => ({
    v: 1,
    org: ORG,
    path: 'durable',
    cause: 'sessions_ended',
    at: 1_700_000_000_000,
    sessions: [id(1)],
    ...change,
  })

  it('reads an unknown cause (a re-check of the people it names), refuses a message that names nobody, and strips unknown fields', () => {
    expect(
      AccessMessage.safeParse(message({ cause: 'rows_changed', sessions: undefined, people: [id(2)] })).success,
    ).toBe(true)
    expect(AccessMessage.safeParse(message({ sessions: undefined })).success).toBe(false)
    expect(AccessMessage.safeParse(message({ sessions: [], people: [] })).success).toBe(false)
    expect(AccessMessage.safeParse(message({ cause: 'Not a code' })).success).toBe(false)
    expect(AccessMessage.safeParse(message({ path: 'recheck' as never })).success).toBe(false)
    expect(AccessMessage.safeParse(message({ at: -1 })).success).toBe(false)
    expect(AccessMessage.safeParse(message({ sessions: ['x'] })).success).toBe(false)
    expect(AccessMessage.safeParse(message({ sessions: Array.from({ length: 501 }, (_, n) => id(n)) })).success).toBe(
      false,
    )
    expect(AccessMessage.parse({ ...message(), items: [id(9)] })).toEqual(message())
  })

  it('publishes on the prefix access channel, in parts of at most 500 sessions and 500 people each', async () => {
    const published: [string, string][] = []
    const valkey = { publish: async (channel: string, text: string) => published.push([channel, text]) }
    const sessions = Array.from({ length: ACCESS_CHUNK + 1 }, (_, n) => id(n))
    const people = Array.from({ length: ACCESS_CHUNK * 2 + 1 }, (_, n) => id(10_000 + n))
    await publishAccess(valkey, 'it:unit:', message({ sessions, people }), logger())
    expect(published.map(([channel]) => channel)).toEqual(['it:unit:access', 'it:unit:access', 'it:unit:access'])
    const parts = published.map(([, text]) => AccessMessage.parse(JSON.parse(text)))
    expect(parts.map(part => [part.sessions?.length, part.people?.length])).toEqual([
      [500, 500],
      [1, 500],
      [undefined, 1],
    ])
    expect(parts.flatMap(part => part.sessions ?? [])).toEqual(sessions)
    expect(parts.flatMap(part => part.people ?? [])).toEqual(people)
    // Each part carries the message's org, path, cause and start.
    for (const part of parts) expect(part).toMatchObject({ v: 1, org: ORG, path: 'durable', cause: 'sessions_ended' })
    expect(JSON.parse(published[0]?.[1] ?? '{}').at).toBe(1_700_000_000_000)
  })

  it('publishes nothing for a message that names nobody, and logs (rethrow: throws) one the schema refuses', async () => {
    const valkey = { publish: vi.fn(async () => 0) }
    await publishAccess(valkey, 'it:unit:', message({ sessions: [] }), logger())
    expect(valkey.publish).not.toHaveBeenCalled()
    const log = logger()
    await publishAccess(valkey, 'it:unit:', message({ sessions: ['B0000000-0000-4000-8000-00000000000Z'] }), log)
    expect(valkey.publish).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledWith({
      event: 'revocation_message_invalid',
      channel: 'access',
      sessions: 1,
      people: 0,
    })
    await expect(
      publishAccess(valkey, 'it:unit:', message({ cause: 'Bad' }), logger(), { rethrow: true }),
    ).rejects.toThrow(/AccessMessage/)
  })

  it('OUTBOX-2: logs and swallows a failed publish, or with rethrow throws it for a retried job', async () => {
    const failure = new Error('Connection is closed.')
    const valkey = { publish: vi.fn().mockRejectedValue(failure) }
    const log = logger()
    await expect(publishAccess(valkey, 'it:unit:', message(), log)).resolves.toBeUndefined()
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'revocation_publish_failed', channel: 'access', sessions: 1, people: 0 }),
    )
    await expect(publishAccess(valkey, 'it:unit:', message(), logger(), { rethrow: true })).rejects.toBe(failure)
  })

  it('hands on a well-formed message, ignores another version at debug, and logs and drops anything else', async () => {
    const sub = fakeSubscriber()
    const log = logger()
    const seen: AccessMessage[] = []
    await listenAccess(
      new Subscriptions(sub.asRedis, { info: vi.fn(), warn: vi.fn() }),
      'it:unit:',
      m => seen.push(m),
      log,
    )
    expect(sub.subscribe.mock.calls.map(([channel]) => channel)).toEqual(['it:unit:access'])
    const people = { v: 1, org: ORG, path: 'push', cause: 'keys_changed', people: [id(4)], later: true }
    sub.events.emit('message', 'it:unit:access', JSON.stringify(people))
    sub.events.emit('message', 'it:unit:revoked', JSON.stringify(message()))
    sub.events.emit('message', 'it:unit:access', JSON.stringify({ ...message(), v: 2 }))
    for (const bad of ['not json', JSON.stringify({ ...message(), sessions: [] }), JSON.stringify({ v: 1 })]) {
      sub.events.emit('message', 'it:unit:access', bad)
    }
    expect(seen).toEqual([{ v: 1, org: ORG, path: 'push', cause: 'keys_changed', people: [id(4)] }])
    expect(log.debug).toHaveBeenCalledWith({ event: 'access_message_ignored', reason: 'version' })
    expect(log.warn).toHaveBeenCalledTimes(3)
    expect(log.warn).toHaveBeenCalledWith({ event: 'revocation_message_unreadable', channel: 'access' })
  })
})
