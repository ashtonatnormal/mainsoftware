// An in-memory stand-in for the Valkey commands the gateway's stream code uses, for unit tests
// (test-only; the image leaves testing/ out). client is the command client (GET, SET with NX and
// PX, PEXPIRE, XRANGE, XREVRANGE, a MULTI of XRANGE and XREVRANGE, run at once at its EXEC as Valkey
// runs one, and the producer's script through EVALSHA, which answers NOSCRIPT until EVAL has run it
// once, as Valkey after a restart does); reader is the blocking reader's connection (XREAD BLOCK,
// which waits for an append or its block, and 'ready'). Ids, and the script's age trim, take their
// time from a clock the test sets, and every entry is numbered as the script numbers it (the
// stream's count of entries ever added). Each command can be made to fail, a test can trim, delete
// or lose the tail of a stream as Valkey would, and a test's hook (between) can land a write between
// two of the reader's commands.
import { EventEmitter } from 'node:events'
import type { Redis } from 'ioredis'
import { vi } from 'vitest'
import { compareIds, PUBLISH_TOPIC_EVENT } from '#src/realtime/stream.ts'

type Entry = [id: string, fields: string[]]

interface Stream {
  entries: Entry[]
  // Entries ever appended (XINFO STREAM's entries-added), and the last id made.
  added: number
  lastMs: number
  lastSeq: number
}

function inRange(id: string, start: string, end: string): boolean {
  if (start.startsWith('(')) {
    if (compareIds(id, start.slice(1)) <= 0) return false
  } else if (start !== '-' && compareIds(id, start) < 0) return false
  return end === '+' || compareIds(id, end) <= 0
}

function countOf(args: readonly unknown[]): number {
  const at = args.findIndex(arg => String(arg).toUpperCase() === 'COUNT')
  return at < 0 ? Number.POSITIVE_INFINITY : Number(args[at + 1])
}

export function fakeStreams(options: { now?: () => number } = {}) {
  const now = options.now ?? (() => Date.now())
  const streams = new Map<string, Stream>()
  const strings = new Map<string, string>()
  // Each key's expiry, as last set (ms).
  const ttls = new Map<string, number>()
  const appended = new EventEmitter()
  const failures = new Map<string, Error[]>()
  // The scripts EVAL has run, by SHA-1.
  const loaded = new Set<string>()
  // A test's hook, awaited after each command of the command client but the producer's script has
  // run and before its reply goes back (a MULTI counts as one command, at its EXEC), so a test can
  // land a write, through the producer's script, between two of the reader's commands.
  let hook: ((command: string, args: readonly unknown[]) => Promise<void> | void) | undefined

  async function afterCommand(command: string, args: readonly unknown[]): Promise<void> {
    await hook?.(command, args)
  }

  function failIfAsked(command: string): void {
    const error = failures.get(command)?.shift()
    if (error !== undefined) throw error
  }

  // Appends an entry with the next id from the clock (or the next sequence number, if the clock
  // stands still or went back), as XADD * does, numbered as the producer's script numbers it (n: the
  // stream's entries-added once it is in) unless unnumbered, as something other than the script
  // would write it. With quiet, a blocked XREAD isn't woken, so a test can write several entries
  // (and trim) before one read sees them, as one MULTI would.
  function add(stream: string, value: string, at = now(), o: { unnumbered?: boolean; quiet?: boolean } = {}): string {
    let s = streams.get(stream)
    if (s === undefined) {
      s = { entries: [], added: 0, lastMs: 0, lastSeq: 0 }
      streams.set(stream, s)
    }
    const ms = Math.max(Math.floor(at), s.lastMs)
    const seq = ms === s.lastMs && s.added > 0 ? s.lastSeq + 1 : 0
    s.lastMs = ms
    s.lastSeq = seq
    s.added++
    const id = `${ms}-${seq}`
    s.entries.push([id, o.unnumbered === true ? ['f', value] : ['n', String(s.added), 'f', value]])
    if (o.quiet !== true) appended.emit('added', stream)
    return id
  }

  function xrange(stream: string, start: string, end: string, ...args: unknown[]): Entry[] {
    const entries = streams.get(stream)?.entries ?? []
    return entries.filter(([id]) => inRange(id, start, end)).slice(0, countOf(args))
  }

  function xrevrange(stream: string, end: string, start: string, ...args: unknown[]): Entry[] {
    const entries = streams.get(stream)?.entries ?? []
    return entries
      .filter(([id]) => inRange(id, start, end))
      .reverse()
      .slice(0, countOf(args))
  }

  // A MULTI of reads: the commands queued, then all run at once at EXEC, so nothing lands between
  // them. EXEC answers each command's [error, reply], as ioredis's does.
  function multi() {
    const queued: (() => Entry[])[] = []
    const transaction = {
      xrange: (stream: string, start: string, end: string, ...args: unknown[]) => {
        queued.push(() => xrange(stream, start, end, ...args))
        return transaction
      },
      xrevrange: (stream: string, end: string, start: string, ...args: unknown[]) => {
        queued.push(() => xrevrange(stream, end, start, ...args))
        return transaction
      },
      exec: async (): Promise<[Error | null, unknown][]> => {
        failIfAsked('multi')
        const replies = queued.map((read): [Error | null, unknown] => [null, read()])
        await afterCommand('multi', [])
        return replies
      },
    }
    return transaction
  }

  const client = {
    get: vi.fn(async (key: string) => {
      failIfAsked('get')
      const value = strings.get(key) ?? null
      await afterCommand('get', [key])
      return value
    }),
    set: vi.fn(async (key: string, value: string, ...args: (string | number)[]) => {
      failIfAsked('set')
      const tokens = args.map(arg => String(arg).toUpperCase())
      let reply: 'OK' | null = null
      if (!(tokens.includes('NX') && strings.has(key))) {
        strings.set(key, value)
        const px = tokens.indexOf('PX')
        if (px >= 0) ttls.set(key, Number(args[px + 1]))
        reply = 'OK'
      }
      await afterCommand('set', [key, value, ...args])
      return reply
    }),
    pexpire: vi.fn(async (key: string, ms: number) => {
      failIfAsked('pexpire')
      let reply = 0
      if (strings.has(key) || streams.has(key)) {
        ttls.set(key, Number(ms))
        reply = 1
      }
      await afterCommand('pexpire', [key, ms])
      return reply
    }),
    xrange: vi.fn(async (stream: string, start: string, end: string, ...args: unknown[]) => {
      failIfAsked('xrange')
      const reply = xrange(stream, start, end, ...args)
      await afterCommand('xrange', [stream, start, end, ...args])
      return reply
    }),
    xrevrange: vi.fn(async (stream: string, end: string, start: string, ...args: unknown[]) => {
      failIfAsked('xrevrange')
      const reply = xrevrange(stream, end, start, ...args)
      await afterCommand('xrevrange', [stream, end, start, ...args])
      return reply
    }),
    multi: vi.fn(multi),
    evalsha: vi.fn(async (sha: string, _keys: number, ...args: (string | number)[]) => {
      failIfAsked('evalsha')
      const run = scripts.get(sha)
      if (!loaded.has(sha) || run === undefined) throw new Error('NOSCRIPT No matching script.')
      return run(args)
    }),
    eval: vi.fn(async (lua: string, _keys: number, ...args: (string | number)[]) => {
      failIfAsked('eval')
      const script = [PUBLISH_TOPIC_EVENT].find(known => known.lua === lua)
      const run = script === undefined ? undefined : scripts.get(script.sha)
      if (script === undefined || run === undefined) throw new Error('ERR unknown script')
      loaded.add(script.sha)
      return run(args)
    }),
  }

  // The producer's script: SET NX PX the epoch, XADD of the numbered entry with MINID (entries older
  // than the age by the clock) and then MAXLEN (both trimmed exactly here, where Valkey's ~ trims
  // whole nodes), PEXPIRE both.
  function runPublish([stream, epoch, maxAge, maxLen, ttl, newEpoch, entry]: (string | number)[]): string {
    const [s, e] = [String(stream), String(epoch)]
    if (!strings.has(e)) strings.set(e, String(newEpoch))
    const oldest = Math.max(0, Math.floor(now()) - Number(maxAge))
    const id = add(s, String(entry))
    const kept = streams.get(s) as Stream
    const head = () => kept.entries[0]?.[0]
    for (let at = head(); at !== undefined && compareIds(at, `${oldest}-0`) < 0; at = head()) kept.entries.shift()
    while (kept.entries.length > Number(maxLen)) kept.entries.shift()
    ttls.set(s, Number(ttl))
    ttls.set(e, Number(ttl))
    return id
  }

  const scripts = new Map<string, (args: (string | number)[]) => string>([[PUBLISH_TOPIC_EVENT.sha, runPublish]])

  const readerEvents = new EventEmitter()
  const reader = {
    on: (event: string, listener: () => void) => {
      readerEvents.on(event, listener)
      return reader
    },
    // XREAD COUNT n BLOCK ms STREAMS k1 .. kn id1 .. idn: the entries after each id, or once one is
    // appended, or null after the block.
    xread: vi.fn((...args: (string | number)[]) => {
      try {
        failIfAsked('xread')
      } catch (error) {
        return Promise.reject(error)
      }
      const count = countOf(args)
      const block = Number(args[args.findIndex(arg => String(arg).toUpperCase() === 'BLOCK') + 1])
      const named = args.slice(args.findIndex(arg => String(arg).toUpperCase() === 'STREAMS') + 1).map(String)
      const keys = named.slice(0, named.length / 2)
      const ids = named.slice(named.length / 2)
      const read = () => {
        const reply: [string, Entry[]][] = []
        keys.forEach((key, at) => {
          const after = streams.get(key)?.entries.filter(([id]) => compareIds(id, ids[at] as string) > 0) ?? []
          if (after.length > 0) reply.push([key, after.slice(0, count)])
        })
        return reply.length > 0 ? reply : null
      }
      const now = read()
      if (now !== null) return Promise.resolve(now)
      return new Promise<[string, Entry[]][] | null>(resolve => {
        const onAdded = (stream: string) => {
          if (!keys.includes(stream)) return
          clearTimeout(timer)
          appended.off('added', onAdded)
          resolve(read())
        }
        const timer = setTimeout(() => {
          appended.off('added', onAdded)
          resolve(null)
        }, block)
        appended.on('added', onAdded)
      })
    }),
  }

  return {
    client,
    reader,
    asClient: client as unknown as Redis,
    asReader: reader as unknown as Redis,
    streams,
    strings,
    ttls,
    add,
    // The hook awaited between the command client's commands (undefined to remove it).
    between(next: typeof hook): void {
      hook = next
    },
    // The next call of a command fails with this error (once per call to fail()); for multi, its
    // EXEC.
    fail(command: keyof typeof client | 'xread', error = new Error('Connection is closed.')): void {
      const queue = failures.get(command) ?? []
      queue.push(error)
      failures.set(command, queue)
    },
    // Trims the stream to its newest n entries, as MAXLEN does (its count of entries added stays).
    trim(stream: string, n: number): void {
      const s = streams.get(stream)
      if (s !== undefined) s.entries.splice(0, Math.max(0, s.entries.length - n))
    },
    // Loses the stream's newest n entries, as a failover to a replica that lacked them does: its
    // count of entries added goes back with them, so the new primary numbers its next entry as the
    // first it lost. The stream keeps its last id, so the new primary's ids come above the lost ones
    // (the harder case: a read from the reader's position returns them).
    loseTail(stream: string, n: number): void {
      const s = streams.get(stream)
      if (s === undefined) return
      s.added -= s.entries.splice(-n, n).length
    },
    // Deletes keys, as a restart without persistence does.
    del(...keys: string[]): void {
      for (const key of keys) {
        streams.delete(key)
        strings.delete(key)
        ttls.delete(key)
      }
    },
    // The reader's connection came back after a reconnect.
    reconnected(): void {
      readerEvents.emit('ready')
    },
  }
}
