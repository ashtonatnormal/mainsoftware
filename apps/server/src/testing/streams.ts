// An in-memory stand-in for the Valkey commands the gateway's stream code uses, for unit tests
// (test-only; the image leaves testing/ out). client is the command client (GET, SET with NX and
// PX, PEXPIRE, XRANGE, XREVRANGE, XINFO STREAM, and the producer's and the tick's scripts through
// EVALSHA, which answers NOSCRIPT until EVAL has run each once, as Valkey after a restart does);
// reader is the
// blocking reader's connection (XREAD BLOCK, which waits for an append or its block, and 'ready').
// Ids take their time from a clock the test sets. Each command can be made to fail, and a test can
// trim, delete or lose the tail of a stream as Valkey would.
import { EventEmitter } from 'node:events'
import type { Redis } from 'ioredis'
import { vi } from 'vitest'
import { compareIds, PUBLISH_TOPIC_EVENT, TICK } from '#src/realtime/stream.ts'

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

  function failIfAsked(command: string): void {
    const error = failures.get(command)?.shift()
    if (error !== undefined) throw error
  }

  // Appends an entry with the next id from the clock (or one ms later than the last, if the clock
  // stands still or went back), as XADD * does.
  function add(stream: string, value: string, at = now()): string {
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
    s.entries.push([id, ['f', value]])
    appended.emit('added', stream)
    return id
  }

  // Appends an entry with the id given, as XADD <id> does: refused unless it is past the stream's
  // last id.
  function addAt(stream: string, id: string, value: string): string {
    let s = streams.get(stream)
    if (s === undefined) {
      s = { entries: [], added: 0, lastMs: 0, lastSeq: 0 }
      streams.set(stream, s)
    }
    const [ms, seq] = id.split('-').map(Number) as [number, number]
    if (s.added > 0 && compareIds(id, `${s.lastMs}-${s.lastSeq}`) <= 0) {
      throw new Error('ERR The ID specified in XADD is equal or smaller than the target stream top item')
    }
    s.lastMs = ms
    s.lastSeq = seq
    s.added++
    s.entries.push([id, ['f', value]])
    appended.emit('added', stream)
    return id
  }

  const client = {
    get: vi.fn(async (key: string) => {
      failIfAsked('get')
      return strings.get(key) ?? null
    }),
    set: vi.fn(async (key: string, value: string, ...args: (string | number)[]) => {
      failIfAsked('set')
      const tokens = args.map(arg => String(arg).toUpperCase())
      if (tokens.includes('NX') && strings.has(key)) return null
      strings.set(key, value)
      const px = tokens.indexOf('PX')
      if (px >= 0) ttls.set(key, Number(args[px + 1]))
      return 'OK'
    }),
    pexpire: vi.fn(async (key: string, ms: number) => {
      failIfAsked('pexpire')
      if (!strings.has(key) && !streams.has(key)) return 0
      ttls.set(key, Number(ms))
      return 1
    }),
    xrange: vi.fn(async (stream: string, start: string, end: string, ...args: unknown[]) => {
      failIfAsked('xrange')
      const entries = streams.get(stream)?.entries ?? []
      return entries.filter(([id]) => inRange(id, start, end)).slice(0, countOf(args))
    }),
    xrevrange: vi.fn(async (stream: string, end: string, start: string, ...args: unknown[]) => {
      failIfAsked('xrevrange')
      const entries = streams.get(stream)?.entries ?? []
      return entries
        .filter(([id]) => inRange(id, start, end))
        .reverse()
        .slice(0, countOf(args))
    }),
    xinfo: vi.fn(async (_subcommand: 'STREAM', stream: string) => {
      failIfAsked('xinfo')
      const s = streams.get(stream)
      if (s === undefined) throw new Error('ERR no such key')
      return ['length', s.entries.length, 'entries-added', s.added, 'max-deleted-entry-id', '0-0']
    }),
    evalsha: vi.fn(async (sha: string, _keys: number, ...args: (string | number)[]) => {
      failIfAsked('evalsha')
      const run = scripts.get(sha)
      if (!loaded.has(sha) || run === undefined) throw new Error('NOSCRIPT No matching script.')
      return run(args)
    }),
    eval: vi.fn(async (lua: string, _keys: number, ...args: (string | number)[]) => {
      failIfAsked('eval')
      const script = [PUBLISH_TOPIC_EVENT, TICK].find(known => known.lua === lua)
      const run = script === undefined ? undefined : scripts.get(script.sha)
      if (script === undefined || run === undefined) throw new Error('ERR unknown script')
      loaded.add(script.sha)
      return run(args)
    }),
  }

  // The producer's script: SET NX PX the epoch, XADD with MAXLEN (trimmed exactly here), PEXPIRE both.
  function runPublish([stream, epoch, maxLen, ttl, newEpoch, entry]: (string | number)[]): string {
    const [s, e] = [String(stream), String(epoch)]
    if (!strings.has(e)) strings.set(e, String(newEpoch))
    const id = add(s, String(entry))
    const kept = streams.get(s) as Stream
    while (kept.entries.length > Number(maxLen)) kept.entries.shift()
    ttls.set(s, Number(ttl))
    ttls.set(e, Number(ttl))
    return id
  }

  // The tick's script: SET NX PX the epoch, append the tick at <boundary>-0 unless the last entry is
  // at or after it (an append refused is left out), trim, PEXPIRE both, and answer the last id.
  function runTick([stream, epoch, boundary, maxLen, ttl, newEpoch, entry]: (string | number)[]): string | null {
    const [s, e] = [String(stream), String(epoch)]
    if (!strings.has(e)) {
      strings.set(e, String(newEpoch))
      ttls.set(e, Number(ttl))
    }
    const last = streams.get(s)?.entries.at(-1)?.[0]
    if (last === undefined || Number(last.split('-')[0]) < Number(boundary)) {
      try {
        addAt(s, `${boundary}-0`, String(entry))
      } catch {
        // As redis.pcall leaves it.
      }
      const kept = streams.get(s)
      while (kept !== undefined && kept.entries.length > Number(maxLen)) kept.entries.shift()
    }
    if (streams.has(s)) ttls.set(s, Number(ttl))
    if (strings.has(e)) ttls.set(e, Number(ttl))
    return streams.get(s)?.entries.at(-1)?.[0] ?? null
  }

  const scripts = new Map<string, (args: (string | number)[]) => string | null>([
    [PUBLISH_TOPIC_EVENT.sha, runPublish],
    [TICK.sha, runTick],
  ])

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
    addAt,
    // The next call of a command fails with this error (once per call to fail()).
    fail(command: keyof typeof client | 'xread', error = new Error('Connection is closed.')): void {
      const queue = failures.get(command) ?? []
      queue.push(error)
      failures.set(command, queue)
    },
    // Trims the stream to its newest n entries, as MAXLEN does.
    trim(stream: string, n: number): void {
      const s = streams.get(stream)
      if (s !== undefined) s.entries.splice(0, Math.max(0, s.entries.length - n))
    },
    // Loses the stream's newest n entries, as a failover can (the stream keeps its last id).
    loseTail(stream: string, n: number): void {
      streams.get(stream)?.entries.splice(-n, n)
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
