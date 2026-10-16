import { afterEach, describe, expect, it, vi } from 'vitest'
import { SUBSCRIBE_RETRY_MS, SUBSCRIBER_PING_MS, Subscriptions } from '#src/pubsub.ts'
import { fakeSubscriber } from '#src/testing/subscriber.ts'

const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() })

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

  it('OD-30 T19 item 12: sends PING every 5 s while the connection is ready, one at a time, and a failed one is harmless', async () => {
    vi.useFakeTimers()
    const { asRedis, client, ping } = fakeSubscriber()
    const log = logger()
    const subscriptions = new Subscriptions(asRedis, log)
    await subscriptions.add('it:unit:revoked', 'revoked', () => {})
    expect(SUBSCRIBER_PING_MS).toBe(5000)
    await vi.advanceTimersByTimeAsync(SUBSCRIBER_PING_MS - 1)
    expect(ping).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(ping).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(SUBSCRIBER_PING_MS * 2)
    expect(ping).toHaveBeenCalledTimes(3)

    // A failed PING is logged at debug and changes nothing: the connection's own handling (its
    // socket timeout, the reconnect, the subscribe again on 'ready') does the rest.
    ping.mockRejectedValueOnce(new Error('Command timed out'))
    await vi.advanceTimersByTimeAsync(SUBSCRIBER_PING_MS)
    expect(log.debug).toHaveBeenCalledWith(expect.objectContaining({ event: 'subscriber_ping_failed' }))
    expect(log.warn).not.toHaveBeenCalled()
    expect(subscriptions.isLive('revoked')).toBe(true)

    // One awaiting its reply holds back the next.
    let answer: (value: string) => void = () => {}
    ping.mockImplementationOnce(() => new Promise<string>(resolve => (answer = resolve)))
    await vi.advanceTimersByTimeAsync(SUBSCRIBER_PING_MS * 3)
    expect(ping).toHaveBeenCalledTimes(5)
    answer('PONG')
    await vi.advanceTimersByTimeAsync(SUBSCRIBER_PING_MS)
    expect(ping).toHaveBeenCalledTimes(6)

    // Nothing while the connection isn't ready (it would wait in the offline queue), or once closed.
    client.status = 'reconnecting'
    await vi.advanceTimersByTimeAsync(SUBSCRIBER_PING_MS * 2)
    expect(ping).toHaveBeenCalledTimes(6)
    client.status = 'ready'
    await subscriptions.close()
    await vi.advanceTimersByTimeAsync(SUBSCRIBER_PING_MS * 2)
    expect(ping).toHaveBeenCalledTimes(6)
  })

  it('OD-22 T19 item 12: a channel is live from its subscribe until the connection closes, and again once subscribed on the next', async () => {
    vi.useFakeTimers()
    const { asRedis, events, subscribe } = fakeSubscriber()
    const subscriptions = new Subscriptions(asRedis, logger())
    expect(subscriptions.isLive('revoked')).toBe(false)
    let answer: () => void = () => {}
    subscribe.mockImplementationOnce(() => new Promise<number>(resolve => (answer = () => resolve(1))))
    const added = subscriptions.add('it:unit:revoked', 'revoked', () => {})
    await subscriptions.add('it:unit:access', 'access', () => {})
    // Sent, not yet answered: not live.
    expect(subscriptions.isLive('revoked')).toBe(false)
    expect(subscriptions.isLive('access')).toBe(true)
    answer()
    await added
    expect(subscriptions.isLive('revoked')).toBe(true)
    // A channel never asked for is never live.
    expect(subscriptions.isLive('flags')).toBe(false)

    events.emit('close')
    expect(subscriptions.isLive('revoked')).toBe(false)
    expect(subscriptions.isLive('access')).toBe(false)
    // The next connection: subscribing again fails once for one channel, which stays down until
    // its retry works.
    subscribe.mockRejectedValueOnce(new Error('Command timed out'))
    events.emit('ready')
    await vi.advanceTimersByTimeAsync(0)
    expect(subscriptions.isLive('revoked')).toBe(false)
    expect(subscriptions.isLive('access')).toBe(true)
    await vi.advanceTimersByTimeAsync(SUBSCRIBE_RETRY_MS)
    expect(subscriptions.isLive('revoked')).toBe(true)
  })
})
