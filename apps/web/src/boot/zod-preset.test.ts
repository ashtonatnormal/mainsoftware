import { describe, expect, it } from 'vitest'
import { presetZodJitless, type ZodConfigHolder } from './pre-boot.ts'

// zod must know it is jitless before it builds its first object schema, since that is when it tries
// `new Function('')` (T21 item 2), and in the build that happens as soon as the chunk holding zod
// and @hearth/shared's schemas loads. preBoot() sets it in zod's own settings object before zod
// loads (boot/pre-boot.ts item 4). The graph below is fresh: this file loads nothing at the top
// that reaches zod, and Vitest runs each test file in its own worker. Function is wrapped, not
// replaced, so zod still gets a working constructor when the control turns the compiler back on.
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
const MARCUS = {
  personId: 'b0000000-0000-4000-8000-000000000003',
  name: 'Marcus',
  timeZone: 'Asia/Singapore',
  capabilities: { registers: false },
  notice: 'acknowledged' as const,
}

describe('T21: zod without code made from strings (boot/pre-boot.ts presetZodJitless)', () => {
  it('ZJ-02: the preset keeps any other setting already there, and makes the object when there is none', () => {
    const empty: ZodConfigHolder = {}
    presetZodJitless(empty)
    expect(empty.__zod_globalConfig).toEqual({ jitless: true })
    const other = { __zod_globalConfig: { jitless: false, locale: 'en' } } as ZodConfigHolder
    presetZodJitless(other)
    expect(other.__zod_globalConfig).toEqual({ jitless: true, locale: 'en' })
  })

  it("ZJ-01 T21 item 2 WS-02: with the preset made before zod loads, zod adopts it, and the app's start (boot.tsx, then @hearth/shared) never calls Function, building or parsing; with the flag off it probes Function at the next object schema (the control)", async () => {
    // What preBoot() does in main.ts, before the one dynamic import loads the app.
    presetZodJitless(globalThis as ZodConfigHolder)
    const spy = spyOnFunction()
    try {
      // boot.tsx loads the session runtime and load-session.ts, which load @hearth/shared and build
      // every schema the boot needs.
      await import('../app/boot.tsx')
      const shared = await import('@hearth/shared')
      const { z } = await import('zod')
      // zod took the object it found, so the setting was in force from its first schema.
      expect(z.config()).toBe((globalThis as ZodConfigHolder).__zod_globalConfig)
      expect(z.config().jitless).toBe(true)
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
