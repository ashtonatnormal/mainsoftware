import { afterEach, describe, expect, it, vi } from 'vitest'
import { HANDLER_TIMEOUT_MS, type OffboardingHandler, OffboardingRegistry, socketsHandler } from '#src/offboarding.ts'
import { scriptedPool, systemPrincipal } from '#src/testing/pool.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const PERSON = 'b0000000-0000-4000-8000-000000000001'
const ADMIN = 'b0000000-0000-4000-8000-000000000002'
const SYSTEM = 'c0000000-0000-4000-8000-000000000001'
const SESSIONS = ['d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002']
const context = { orgId: ORG, personId: PERSON, actorId: ADMIN }

const logger = () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() })

function handler(name: string, ran: string[], run: () => Promise<void> = async () => {}): OffboardingHandler {
  return {
    name,
    run: async () => {
      ran.push(name)
      await run()
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('C0.5 ACC-05 the offboarding registry (the seam A2, A4, C2.2, C4.1 and C4.3 register on)', () => {
  it('runs every handler in the order they registered', async () => {
    const ran: string[] = []
    const registry = new OffboardingRegistry(logger())
    registry.register(handler('sockets', ran))
    registry.register(handler('rooms', ran))
    registry.register(handler('drive', ran))
    expect(await registry.run(context)).toEqual([
      { name: 'sockets', ok: true },
      { name: 'rooms', ok: true },
      { name: 'drive', ok: true },
    ])
    expect(ran).toEqual(['sockets', 'rooms', 'drive'])
  })

  it('reports a handler that throws, logs it, and still runs the rest', async () => {
    const ran: string[] = []
    const log = logger()
    const registry = new OffboardingRegistry(log)
    registry.register(
      handler('sockets', ran, async () => {
        throw new Error('valkey is down')
      }),
    )
    registry.register(handler('rooms', ran))
    expect(await registry.run(context)).toEqual([
      { name: 'sockets', ok: false },
      { name: 'rooms', ok: true },
    ])
    expect(ran).toEqual(['sockets', 'rooms'])
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'offboarding_handler_failed', handler: 'sockets', personId: PERSON }),
    )
  })

  it('cuts a handler off after 5 s and goes on to the next', async () => {
    vi.useFakeTimers()
    const ran: string[] = []
    const log = logger()
    const registry = new OffboardingRegistry(log)
    registry.register(handler('hangs', ran, () => new Promise(() => {})))
    registry.register(handler('rooms', ran))
    const running = registry.run(context)
    await vi.advanceTimersByTimeAsync(HANDLER_TIMEOUT_MS - 1)
    expect(ran).toEqual(['hangs'])
    await vi.advanceTimersByTimeAsync(1)
    expect(await running).toEqual([
      { name: 'hangs', ok: false },
      { name: 'rooms', ok: true },
    ])
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ event: 'offboarding_handler_timed_out' }))
  })

  it('runs every handler again when run again, since each must be idempotent', async () => {
    const ran: string[] = []
    const registry = new OffboardingRegistry(logger())
    registry.register(handler('sockets', ran))
    registry.register(handler('rooms', ran))
    await registry.run(context)
    await registry.run(context)
    expect(ran).toEqual(['sockets', 'rooms', 'sockets', 'rooms'])
  })

  it('refuses two handlers with the same name', () => {
    const registry = new OffboardingRegistry(logger())
    registry.register(handler('sockets', []))
    expect(() => registry.register(handler('sockets', []))).toThrow(/already registered/)
  })
})

describe('C0.5 T5 ACC-05 the sockets handler', () => {
  it("publishes the sessions the deactivation ended, read as the org's system principal", async () => {
    const { db, texts, statements } = scriptedPool(statement =>
      statement.text.includes('from "sessions"') ? SESSIONS.map(id => ({ id })) : systemPrincipal(SYSTEM)(statement),
    )
    const published: [string, string][] = []
    const valkey = { publish: async (channel: string, message: string) => published.push([channel, message]) }
    await socketsHandler({ db, valkey, keyPrefix: 'it:unit:', logger: logger() }).run(context)
    expect(texts()).toContain(
      'select "id" from "sessions" where "org_id" = $1 and "user_id" = $2 and "revoke_reason" = $3',
    )
    expect(statements.find(s => s.text.includes('from "sessions"'))?.values).toEqual([ORG, PERSON, 'deactivated'])
    expect(published).toHaveLength(1)
    const [channel, message] = published[0] ?? []
    expect(channel).toBe('it:unit:revoked')
    expect(JSON.parse(message ?? '')).toEqual({ v: 1, at: expect.any(Number), sessions: SESSIONS })
  })

  it('publishes nothing when the deactivation ended no session, so it can run again safely', async () => {
    const { db } = scriptedPool(systemPrincipal(SYSTEM))
    const valkey = { publish: vi.fn() }
    await socketsHandler({ db, valkey, keyPrefix: 'it:unit:', logger: logger() }).run(context)
    expect(valkey.publish).not.toHaveBeenCalled()
  })
})
