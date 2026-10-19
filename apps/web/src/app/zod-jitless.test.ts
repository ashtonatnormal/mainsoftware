import { describe, expect, it } from 'vitest'

// zod-jitless.ts must run before zod builds its first object schema, since that is when zod tries
// `new Function('')` (K-01, K-05). The graph below is fresh: this file loads nothing at the top that
// reaches zod, and Vitest runs each test file in its own worker. Function is wrapped, not replaced,
// so zod still gets a working constructor when the control turns the compiler back on.
function spyOnFunction() {
  const calls: unknown[][] = []
  const original = globalThis.Function
  globalThis.Function = new Proxy(original, {
    apply(target, self, args: unknown[]) {
      calls.push(args)
      return Reflect.apply(target, self, args)
    },
    construct(target, args: unknown[], newTarget) {
      calls.push(args)
      return Reflect.construct(target, args, newTarget)
    },
  })
  return { calls, restore: () => (globalThis.Function = original) }
}

// Marcus, from the Tembusu seed (db/seed/tembusu.sql).
const MARCUS = { personId: 'b0000000-0000-4000-8000-000000000003', name: 'Marcus', timeZone: 'Asia/Singapore' }

describe('T21: zod without code made from strings (app/zod-jitless.ts)', () => {
  it("ZJ-01 K-01 K-05 WS-02: the app's start loads zod-jitless.ts, then @hearth/shared, and zod never calls Function, building or parsing; with the flag off it probes Function at the next object schema (the control)", async () => {
    const spy = spyOnFunction()
    try {
      // boot.tsx imports zod-jitless.ts first, then load-session.ts and the session runtime, which
      // load @hearth/shared and build every schema the boot needs: the order the browser runs.
      await import('./boot.tsx')
      const shared = await import('@hearth/shared')
      const { z } = await import('zod')
      expect(shared.SessionResponseForClient.parse(MARCUS)).toEqual(MARCUS)
      expect(z.object({ a: z.string() }).parse({ a: 'b' })).toEqual({ a: 'b' })
      expect(spy.calls).toEqual([])

      // The control: the spy sees zod's probe, so the empty list above means something.
      z.config({ jitless: false })
      z.object({ a: z.string() })
      expect(spy.calls[0]).toEqual([''])
      z.config({ jitless: true })
    } finally {
      spy.restore()
    }
  })
})
