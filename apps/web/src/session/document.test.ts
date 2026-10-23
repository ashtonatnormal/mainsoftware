import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChannelLike, DocumentEnv, TabStorage } from './document.ts'

// document.ts keeps the document's one identity channel in module state, so each test loads a
// fresh copy, as a new document would.
let doc: typeof import('./document.ts')
beforeEach(async () => {
  vi.resetModules()
  doc = await import('./document.ts')
})

// A Storage over a Map, in insertion order, as sessionStorage keeps it.
function memoryStorage(entries: Record<string, string> = {}): TabStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(entries))
  return {
    map,
    get length() {
      return map.size
    },
    key: index => [...map.keys()][index] ?? null,
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
    removeItem: key => {
      map.delete(key)
    },
  }
}

// Storage the browser refuses: every call throws.
function throwingStorage(): TabStorage {
  const refuse = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError')
  }
  return {
    get length(): number {
      return refuse()
    },
    key: refuse,
    getItem: refuse,
    setItem: refuse,
    removeItem: refuse,
  }
}

// BroadcastChannel as the HTML spec has it: a message goes to every other open object of the same
// name, never back to the one that posted it, in a later task; a closed object neither sends nor
// receives.
function channels() {
  const open = new Set<FakeChannel>()
  const posted: { from: FakeChannel; data: unknown }[] = []
  class FakeChannel implements ChannelLike {
    onmessage: ((event: MessageEvent) => void) | null = null
    closed = false
    readonly name: string
    constructor(name: string) {
      this.name = name
      open.add(this)
    }
    postMessage(data: unknown) {
      if (this.closed) throw new DOMException('closed', 'InvalidStateError')
      posted.push({ from: this, data })
      const targets = [...open].filter(other => other !== this && other.name === this.name)
      setTimeout(() => {
        for (const target of targets)
          if (!target.closed) target.onmessage?.(new MessageEvent('message', { data: structuredClone(data) }))
      }, 0)
    }
    close() {
      this.closed = true
      open.delete(this)
    }
  }
  return { FakeChannel, open, posted }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

// With no argument, fresh storage; with undefined, a tab whose browser refuses storage.
function fakeEnv(...given: [TabStorage | undefined] | []) {
  const storage = given.length === 0 ? memoryStorage() : given[0]
  const steps: string[] = []
  const pagehide: (() => void)[] = []
  const bus = channels()
  const env: DocumentEnv = {
    location: {
      replace: (url: string | URL) => {
        steps.push(`replace ${String(url)}`)
      },
      reload: () => {
        steps.push('reload')
      },
    },
    storage,
    addEventListener: (type, listener) => {
      steps.push(`listen ${type}`)
      pagehide.push(listener)
    },
    BroadcastChannel: bus.FakeChannel,
  }
  return { env, steps, pagehide, bus }
}

describe('T21 D-01: a session is a document (session/document.ts)', () => {
  it('DC-01 D-02: leaveDocument marks the reason and the focus flag, tells other tabs, removes every tsr-scroll-restoration* key now and again on pagehide, then replaces with /sign-in', async () => {
    const storage = memoryStorage({
      'tsr-scroll-restoration-v1_3': '{"/chats":{}}',
      'tanstack_router_reload:Failed to fetch dynamically imported module': '1',
      'hearth:return-to': '/tasks',
    })
    const { env, steps, pagehide, bus } = fakeEnv(storage)
    const otherTab = new bus.FakeChannel(doc.IDENTITY_CHANNEL)
    const heard: unknown[] = []
    otherTab.onmessage = event => heard.push(event.data)

    doc.leaveDocument('signed_out_here', env)

    expect(steps).toEqual(['listen pagehide', 'replace /sign-in'])
    expect(storage.map.get('hearth:left')).toBe('signed_out_here')
    expect(storage.map.get('hearth:focus-heading')).toBe('1')
    expect(storage.map.has('tsr-scroll-restoration-v1_3')).toBe(false)
    // The router's reload marker and other Hearth keys stay.
    expect(storage.map.has('tanstack_router_reload:Failed to fetch dynamically imported module')).toBe(true)
    expect(storage.map.get('hearth:return-to')).toBe('/tasks')

    // The router writes its whole cache back on pagehide; the wipe after it removes it again.
    storage.setItem('tsr-scroll-restoration-v1_3', '{"/chats":{"#screen":{"scrollY":40}}}')
    storage.setItem('tsr-scroll-restoration-v2', '{}')
    for (const listener of pagehide) listener()
    expect([...storage.map.keys()].filter(key => key.startsWith('tsr-scroll-restoration'))).toEqual([])

    await tick()
    // { t: 'identity' } and nothing else: no id, no data.
    expect(heard).toEqual([{ t: 'identity' }])
  })

  it('DC-01 T21 item 2: every other reason but other_tab tells the other tabs; other_tab reloads instead of replacing, and posts nothing', async () => {
    for (const reason of ['session_ended', 'person_changed'] as const) {
      const { env, steps, bus } = fakeEnv()
      doc.leaveDocument(reason, env)
      expect(steps.at(-1)).toBe('replace /sign-in')
      expect(bus.posted.map(post => post.data)).toEqual([{ t: 'identity' }])
    }
    const storage = memoryStorage()
    const { env, steps, bus } = fakeEnv(storage)
    doc.leaveDocument('other_tab', env)
    expect(steps.at(-1)).toBe('reload')
    expect(bus.posted).toEqual([])
    expect(storage.map.get('hearth:left')).toBe('other_tab')
  })

  it("DC-02 T21 item 2: an identity message from another tab calls the listener; this tab's own post doesn't, and other messages are ignored", async () => {
    const { env, bus } = fakeEnv()
    const heard = vi.fn()
    const channel = doc.openIdentityChannel(env, heard)

    // This document's own posts go through its one channel object, so they never come back.
    channel.post()
    doc.leaveDocument('signed_out_here', env)
    doc.enterDocument(env)
    await tick()
    expect(heard).not.toHaveBeenCalled()
    expect(bus.open.size).toBe(1)

    const otherTab = new bus.FakeChannel(doc.IDENTITY_CHANNEL)
    otherTab.postMessage({ t: 'something else' })
    otherTab.postMessage('identity')
    await tick()
    expect(heard).not.toHaveBeenCalled()
    otherTab.postMessage({ t: 'identity' })
    await tick()
    expect(heard).toHaveBeenCalledTimes(1)

    // A second listener in the same document shares the one channel; closing both closes it.
    const second = vi.fn()
    const again = doc.openIdentityChannel(env, second)
    expect(bus.open.size).toBe(2)
    otherTab.postMessage({ t: 'identity' })
    await tick()
    expect([heard.mock.calls.length, second.mock.calls.length]).toEqual([2, 1])
    channel.close()
    expect(bus.open.size).toBe(2)
    again.close()
    expect(bus.open.size).toBe(1)
  })

  it("NTW-06 C0.9 PD-46 T22 item 31: the notice message is { t: 'notice' } alone; another tab's calls onNotice and never onIdentity, this tab's own doesn't come back, and a listener without onNotice (a signed-out tab) ignores it", async () => {
    const { env, bus } = fakeEnv()
    const identity = vi.fn()
    const notice = vi.fn()
    const channel = doc.openIdentityChannel(env, identity, notice)
    const otherTab = new bus.FakeChannel(doc.IDENTITY_CHANNEL)
    const heard: unknown[] = []
    otherTab.onmessage = event => heard.push(event.data)

    channel.postNotice()
    await tick()
    // No id, no data, and never back to this document.
    expect(heard).toEqual([{ t: 'notice' }])
    expect(doc.NOTICE_MESSAGE).toEqual({ t: 'notice' })
    expect([identity.mock.calls.length, notice.mock.calls.length]).toEqual([0, 0])

    otherTab.postMessage({ t: 'notice' })
    await tick()
    expect([identity.mock.calls.length, notice.mock.calls.length]).toEqual([0, 1])
    otherTab.postMessage({ t: 'identity' })
    await tick()
    expect([identity.mock.calls.length, notice.mock.calls.length]).toEqual([1, 1])

    // A document that listens for identity alone, as a signed-out one does (app/boot.tsx), hears
    // nothing from a notice message.
    channel.close()
    const signedOut = vi.fn()
    doc.openIdentityChannel(env, signedOut)
    otherTab.postMessage({ t: 'notice' })
    await tick()
    expect(signedOut).not.toHaveBeenCalled()
    expect(notice).toHaveBeenCalledTimes(1)
  })

  it('DC-02: with no channel open, a post goes through a channel opened for it and closed at once', async () => {
    const { env, bus } = fakeEnv()
    const otherTab = new bus.FakeChannel(doc.IDENTITY_CHANNEL)
    const heard = vi.fn()
    otherTab.onmessage = heard
    doc.enterDocument(env)
    expect(bus.open.size).toBe(1)
    await tick()
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('DC-03 T21 item 5: rememberReturnTo keeps only a registered app path, never a query or another origin; takeReturnTo validates again and reads once', () => {
    const storage = memoryStorage()
    doc.rememberReturnTo('/tasks', storage)
    expect(doc.takeReturnTo(storage)).toBe('/tasks')
    expect(doc.takeReturnTo(storage)).toBeUndefined()

    for (const path of [
      '/tasks?x=1',
      '/tasks/',
      'https://elsewhere.example/tasks',
      '//elsewhere.example/tasks',
      '/admin',
      '/sign-in',
      '/',
      '/xyz',
    ]) {
      doc.rememberReturnTo('/drive', storage)
      doc.rememberReturnTo(path, storage)
      // An unregistered path forgets the older one: sign-in opens what was asked for last, or Chats.
      expect(storage.map.has('hearth:return-to'), path).toBe(false)
    }

    // Whatever else wrote the key, only an app path comes back.
    storage.setItem('hearth:return-to', 'https://elsewhere.example/')
    expect(doc.takeReturnTo(storage)).toBeUndefined()
    expect(storage.map.has('hearth:return-to')).toBe(false)
  })

  it('DC-03 T21 item 5: enterDocument opens the kept path, else /chats (OD-03)', () => {
    const storage = memoryStorage()
    doc.rememberReturnTo('/rooms', storage)
    const first = fakeEnv(storage)
    doc.enterDocument(first.env)
    expect(first.steps).toEqual(['replace /rooms'])
    const second = fakeEnv(storage)
    doc.enterDocument(second.env)
    expect(second.steps).toEqual(['replace /chats'])
  })

  it('DC-04 T21 item 4: reloadForUpdate reloads once per 60 s, then answers blocked', () => {
    const storage = memoryStorage()
    const { env, steps } = fakeEnv(storage)
    const at = 1_760_000_000_000
    expect(doc.reloadForUpdate(env, at)).toBe('reloaded')
    expect(doc.reloadForUpdate(env, at + 1)).toBe('blocked')
    expect(doc.reloadForUpdate(env, at + 59_999)).toBe('blocked')
    expect(doc.reloadForUpdate(env, at + 60_000)).toBe('reloaded')
    expect(steps).toEqual(['reload', 'reload'])
    expect(storage.map.get('hearth:reloaded-at')).toBe(String(at + 60_000))
    // A stamp from the future (the clock went back) or one that doesn't read doesn't block.
    storage.setItem('hearth:reloaded-at', String(at + 3_600_000))
    expect(doc.reloadForUpdate(env, at + 61_000)).toBe('reloaded')
    storage.setItem('hearth:reloaded-at', 'soon')
    expect(doc.reloadForUpdate(env, at + 62_000)).toBe('reloaded')
  })

  it('DC-05: storage that throws or is absent is treated as absent, and the document still leaves', () => {
    for (const storage of [throwingStorage(), undefined]) {
      const { env, steps } = fakeEnv(storage)
      doc.leaveDocument('session_ended', env)
      expect(steps.at(-1)).toBe('replace /sign-in')
      doc.enterDocument(env)
      expect(steps.at(-1)).toBe('replace /chats')
      expect(() => doc.rememberReturnTo('/tasks', storage)).not.toThrow()
      expect(doc.takeReturnTo(storage)).toBeUndefined()
      expect(doc.takeLeftReason(storage)).toBeUndefined()
      expect(doc.takeFocusHeading(storage)).toBe(false)
      // With no way to record the reload, a reload loop can't be ruled out: blocked.
      expect(doc.reloadForUpdate(env, 1)).toBe('blocked')
      expect(steps).not.toContain('reload')
    }
    // A browser without BroadcastChannel leaves all the same.
    const { env, steps } = fakeEnv()
    const bare: DocumentEnv = { ...env, BroadcastChannel: undefined }
    expect(() => doc.openIdentityChannel(bare, () => {})).not.toThrow()
    doc.leaveDocument('signed_out_here', bare)
    expect(steps.at(-1)).toBe('replace /sign-in')
  })

  it('DC-06 X6: enterDocument sets the focus-heading flag before it replaces; takeFocusHeading answers true once, then false', () => {
    const storage = memoryStorage()
    const { env } = fakeEnv(storage)
    const flagAtReplace: (string | undefined)[] = []
    const watched: DocumentEnv = {
      ...env,
      location: {
        replace: () => {
          flagAtReplace.push(storage.map.get('hearth:focus-heading'))
        },
        reload: () => {},
      },
    }
    doc.enterDocument(watched)
    doc.leaveDocument('session_ended', watched)
    expect(flagAtReplace).toEqual(['1', '1'])
    expect(doc.takeFocusHeading(storage)).toBe(true)
    expect(doc.takeFocusHeading(storage)).toBe(false)
  })

  it('takeLeftReason reads a known reason once, and nothing else', () => {
    const storage = memoryStorage({ 'hearth:left': 'person_changed' })
    expect(doc.takeLeftReason(storage)).toBe('person_changed')
    expect(doc.takeLeftReason(storage)).toBeUndefined()
    storage.setItem('hearth:left', 'you were bad')
    expect(doc.takeLeftReason(storage)).toBeUndefined()
    expect(storage.map.has('hearth:left')).toBe(false)
    // A sign-in clears a reason nobody read.
    storage.setItem('hearth:left', 'session_ended')
    doc.enterDocument(fakeEnv(storage).env)
    expect(storage.map.has('hearth:left')).toBe(false)
  })
})
