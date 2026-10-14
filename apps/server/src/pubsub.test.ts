import { afterEach, describe, expect, it, vi } from 'vitest'
import { SUBSCRIBE_RETRY_MS, Subscriptions } from '#src/pubsub.ts'
import { fakeSubscriber } from '#src/testing/subscriber.ts'

const logger = () => ({ info: vi.fn(), warn: vi.fn() })

describe('C0.5 C0.6 T14 the pub/sub channels on one subscriber connection', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps trying to subscribe while Valkey is down, logging the failure once, until it works', async () => {
    vi.useFakeTimers()
    const { asRedis, subscribe } = fakeSubscriber({ failures: 3 })
    const log = logger()
    const subscriptions = new Subscriptions(asRedis, log)
    let subscribed = false
    void subscriptions
      .add('it:unit:revoked', 'revoked', () => {})
      .then(() => {
        subscribed = true
      })
    await vi.advanceTimersByTimeAsync(SUBSCRIBE_RETRY_MS * 2)
    expect(subscribed).toBe(false)
    await vi.advanceTimersByTimeAsync(SUBSCRIBE_RETRY_MS * 3)
    expect(subscribe).toHaveBeenCalledTimes(4)
    expect(subscribe.mock.calls.every(([channel]) => channel === 'it:unit:revoked')).toBe(true)
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'channel_subscribe_failed', channel: 'revoked' }),
      expect.any(String),
    )
    expect(log.info).toHaveBeenCalledWith({ event: 'channel_subscribed', channel: 'revoked' }, expect.any(String))
    expect(subscribed).toBe(true)
  })

  it('subscribes every channel again on each new connection after a reconnect, and keeps trying if that fails', async () => {
    vi.useFakeTimers()
    const { asRedis, events, subscribe } = fakeSubscriber()
    const log = logger()
    const subscriptions = new Subscriptions(asRedis, log)
    void subscriptions.add('it:unit:revoked', 'revoked', () => {})
    void subscriptions.add('it:unit:flags', 'flags', () => {})
    // The first connection's 'ready' finds the first subscribes still pending: no second ones.
    events.emit('ready')
    await vi.advanceTimersByTimeAsync(0)
    expect(subscribe).toHaveBeenCalledTimes(2)

    // A reconnect: Valkey has forgotten the subscriptions, and one new subscribe fails once.
    subscribe.mockRejectedValueOnce(new Error('Command timed out'))
    events.emit('ready')
    await vi.advanceTimersByTimeAsync(0)
    expect(subscribe).toHaveBeenCalledTimes(4)
    // A 'ready' while the retry waits sends that channel nothing more, and the other one again.
    events.emit('ready')
    await vi.advanceTimersByTimeAsync(SUBSCRIBE_RETRY_MS)
    expect(subscribe.mock.calls.map(([channel]) => channel)).toEqual([
      'it:unit:revoked',
      'it:unit:flags',
      'it:unit:revoked',
      'it:unit:flags',
      'it:unit:flags',
      'it:unit:revoked',
    ])
    await vi.advanceTimersByTimeAsync(SUBSCRIBE_RETRY_MS * 3)
    expect(subscribe).toHaveBeenCalledTimes(6)
  })

  it('hands each channel its own messages, and nothing once closed', async () => {
    const { asRedis, events, client } = fakeSubscriber()
    const subscriptions = new Subscriptions(asRedis, logger())
    const revoked: string[] = []
    const flags: string[] = []
    await subscriptions.add('it:unit:revoked', 'revoked', text => revoked.push(text))
    await subscriptions.add('it:unit:flags', 'flags', text => flags.push(text))
    events.emit('message', 'it:unit:revoked', 'a')
    events.emit('message', 'it:unit:flags', 'b')
    events.emit('message', 'h:prod:flags', 'c')
    expect(revoked).toEqual(['a'])
    expect(flags).toEqual(['b'])
    await subscriptions.close()
    expect(client.quit).toHaveBeenCalled()
    events.emit('message', 'it:unit:flags', 'd')
    expect(flags).toEqual(['b'])
  })

  it('refuses a second listener on one channel', () => {
    const subscriptions = new Subscriptions(fakeSubscriber().asRedis, logger())
    void subscriptions.add('it:unit:flags', 'flags', () => {})
    expect(() => subscriptions.add('it:unit:flags', 'flags', () => {})).toThrow(/already listening/)
  })

  it('stops trying once closed', async () => {
    vi.useFakeTimers()
    const { asRedis, subscribe } = fakeSubscriber({ failures: 100 })
    const subscriptions = new Subscriptions(asRedis, logger())
    void subscriptions.add('it:unit:revoked', 'revoked', () => {})
    await vi.advanceTimersByTimeAsync(SUBSCRIBE_RETRY_MS * 2)
    const calls = subscribe.mock.calls.length
    await subscriptions.close()
    await vi.advanceTimersByTimeAsync(SUBSCRIBE_RETRY_MS * 5)
    expect(subscribe).toHaveBeenCalledTimes(calls)
  })
})
