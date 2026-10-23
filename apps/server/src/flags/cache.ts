// The flags a process keeps (TECH-SPEC T17 items 6 and 7). Postgres holds every org's flags
// (feature_flags, migration 0007); each process holds a copy of the orgs it serves, so it can
// decide whether a feature is on for someone without a query. A change reaches every process within
// 10 s (PRD-65, BUILD-PLAN C0's done-when list) two ways:
//   - the api publishes on the flags channel after the change commits (channel.ts), and each
//     process reloads that org at once;
//   - each process polls every org it keeps every 2 s (±10%, so processes drift apart), so a lost
//     message, or Valkey down, costs at most about 5 s. Each read's statements are bounded to 2 s by
//     Postgres, and the process stops waiting for the whole read after 2.5 s whatever happens (a
//     connection whose peer went silent never hears Postgres's timeout), counts it as failed and
//     polls again; a read it stopped waiting for can't change anything when it ends. Such a read
//     keeps its pool connection until the pool's query_timeout ends it (31 s), so at most 3 reads
//     are in flight at once across the cache: the poll of an org past that waits until one ends
//     (the org may go unconfirmed meanwhile, the safe direction), and most of the pool stays free.
// A process that hasn't confirmed an org's flags for 8 s reads every flag not locked on as off
// (fail closed), and the database's fences refuse any effect after a change whatever this copy
// says (fence.ts; feature_fence, job_fence and job_finish compare revisions).
//
// The api keeps the org of every signed-in request, realtime the org of every socket, the worker
// every org it lists (as hearth_queue, T18), forgetting one that leaves the list (untrack()). A
// caller that serves values to someone (C0.8's GET /api/flags, web/flags.ts) waits for the org's
// first load (track()), for at most FLAG_READ_WAIT_MS.
//
// The worker's cache also keeps each org's registers (C0.9, TECH-SPEC T22 item 9; the `registers`
// option): each purpose's current entry, each provider's revision, review date and open clearance,
// and the live processing restrictions, read in the same read-only transaction as the flags, so one
// confirmedAt, the same 8 s, the same 2 s bound and the same 3 reads in flight cover both. A
// register statement that fails fails the whole read: the org goes unconfirmed, flags and registers
// together, and register() answers undefined, so the purpose gate allows only the pinned purposes
// (compliance/gate.ts, PD-07). A change reaches the worker within one poll (there is no channel for
// it) and is logged register_changed; it calls no onChange listener, since no flag's revision moved.
// An open clearance whose review date has passed is logged transfer_review_overdue at warn, once a
// day per org and provider (PD-13). The api and realtime keep no register (T22 items 8 and 11).
import { performance } from 'node:perf_hooks'
import { FLAGS, type FlagSpec, flagLineage, isLockedOn } from '@hearth/shared'
import { sql } from 'kysely'
import type { Logger } from 'pino'
import { type RegisterState, readRegisterState, registerDigest } from '#src/compliance/registers.ts'
import { type Database, withOrg } from '#src/db/database.ts'
import type { JobRole } from '#src/db/roles.ts'
import { failureFields } from '#src/db/sqlstate.ts'
import { readFlagsMessage } from '#src/flags/channel.ts'
import { evaluate, type FlagState, type FlagSubject, lineageEnabled } from '#src/flags/evaluate.ts'
import type { Subscriptions } from '#src/pubsub.ts'

// How often each org's flags are read again (±10%), how long each of a read's statements may take
// (Postgres's bound), how long the process waits for a whole read (its own), and how long a process
// trusts what it last read.
export const FLAG_POLL_MS = 2000
export const FLAG_READ_TIMEOUT = '2s'
export const FLAG_READ_WAIT_MS = 2500
export const FLAG_STALE_MS = 8000
// How many reads may be in flight at once, those the process stopped waiting for included: few
// enough that most of the pool they share stays free (the worker's control pool has 8 connections,
// the api's 10 and realtime's 12, TECH-SPEC T19 item 11), however long silent connections hold them.
export const FLAG_READS_IN_FLIGHT = 3

// What verdict() says about a feature for someone.
export type FlagVerdict = 'on' | 'off' | 'not_in_cohort' | 'unconfirmed'
// A read that has failed this many times in a row is logged at error level (C0.13 alarms on it).
const FAILURES_BEFORE_ERROR = 3

export interface FlagCacheOptions {
  db: Database
  // The role its reads take: the worker's cache reads as hearth_queue; the api's and realtime's
  // as their own login (hearth_app).
  as?: JobRole
  // The flags this process knows (FLAGS unless a test adds its own, A5): a row with no entry here
  // is kept, logged once, and evaluates off.
  registry?: Readonly<Record<string, FlagSpec>>
  // The worker's alone: also keep each org's registers, with its live processing restrictions when
  // asked (hearth_queue's grants; T22 item 9).
  registers?: { restrictions: boolean }
  logger: Pick<Logger, 'info' | 'warn' | 'error'>
  pollMs?: number
  staleMs?: number
  // A monotonic clock (performance.now) and the jitter's randomness, for tests.
  now?: () => number
  random?: () => number
}

interface OrgFlags {
  // What the last successful read found, and when (monotonic): the flags, and the registers when
  // the cache keeps them, with the registers' digest.
  states: Map<string, FlagState> | undefined
  register: { state: RegisterState; digest: string } | undefined
  confirmedAt: number | undefined
  // The read in progress; a reload asked for meanwhile runs once more after it (coalesced).
  loading: boolean
  again: boolean
  // reload() callers, waiting for a read that started after they asked.
  waiters: Array<() => void>
  timer: NodeJS.Timeout | undefined
  // Resolves at the first successful read (track()).
  confirmed: Promise<void>
  confirm: () => void
  failures: number
  // Whether flags_unconfirmed has been logged since the org was last confirmed.
  unconfirmed: boolean
}

type Row = {
  key: string
  enabled: boolean
  locked: boolean
  audience: 'org' | 'cohort'
  cohort_people: string[]
  cohort_roles: string[]
  // A bigint, which pg returns as a string.
  revision: unknown
}

// One read of an org: its flags' rows, and its registers when the cache keeps them.
interface OrgRead {
  rows: Row[]
  register: RegisterState | undefined
}

// A read of the flags that didn't end within FLAG_READ_WAIT_MS.
export class FlagReadTimeout extends Error {
  override name = 'FlagReadTimeout'
  constructor() {
    super(`the flags read took longer than ${FLAG_READ_WAIT_MS} ms`)
  }
}

export class FlagCache {
  readonly registry: Readonly<Record<string, FlagSpec>>
  readonly #db: Database
  readonly #as: JobRole | undefined
  readonly #registers: { restrictions: boolean } | undefined
  readonly #logger: Pick<Logger, 'info' | 'warn' | 'error'>
  readonly #pollMs: number
  readonly #staleMs: number
  readonly #now: () => number
  readonly #random: () => number
  readonly #orgs = new Map<string, OrgFlags>()
  readonly #listeners = new Set<(orgId: string, keys: readonly string[]) => void>()
  // org:key of each unregistered row already logged.
  readonly #unregistered = new Set<string>()
  // org:provider of each overdue review, with the UTC day it was last logged (PD-13).
  readonly #overdue = new Map<string, string>()
  // Reads started and not yet settled (a read the cache stopped waiting for counts until it ends),
  // and the polls deferred while FLAG_READS_IN_FLIGHT are, in the order they were due.
  #inFlight = 0
  readonly #deferred = new Map<string, OrgFlags>()
  // Whether flags_reads_limited has been logged in this episode: from the first poll deferred until
  // fewer than FLAG_READS_IN_FLIGHT reads are in flight and no poll is deferred.
  #limited = false
  #stopped = false

  constructor(options: FlagCacheOptions) {
    this.#db = options.db
    this.#as = options.as
    this.#registers = options.registers
    this.registry = options.registry ?? FLAGS
    this.#logger = options.logger
    this.#pollMs = options.pollMs ?? FLAG_POLL_MS
    this.#staleMs = options.staleMs ?? FLAG_STALE_MS
    this.#now = options.now ?? (() => performance.now())
    this.#random = options.random ?? Math.random
  }

  // Starts keeping an org's flags, reading them at once and then every poll. Resolves at the first
  // successful read, for a caller that serves values to wait on; never rejects (it keeps trying).
  track(orgId: string): Promise<void> {
    let entry = this.#orgs.get(orgId)
    if (entry === undefined) {
      let confirm: () => void = () => {}
      const confirmed = new Promise<void>(resolve => {
        confirm = resolve
      })
      entry = {
        states: undefined,
        register: undefined,
        confirmedAt: undefined,
        loading: false,
        again: false,
        waiters: [],
        timer: undefined,
        confirmed,
        confirm,
        failures: 0,
        unconfirmed: false,
      }
      this.#orgs.set(orgId, entry)
      if (!this.#stopped) void this.#load(orgId, entry)
    }
    return entry.confirmed
  }

  // Stops keeping an org's flags: its poll ends, a read in progress changes nothing when it ends,
  // and the org reads as unconfirmed (a later track() starts again). The worker calls it when an org
  // leaves its org list. The api and realtime never do: they serve one org (D1), so what they keep
  // can't grow.
  untrack(orgId: string): void {
    const entry = this.#orgs.get(orgId)
    if (entry === undefined) return
    this.#orgs.delete(orgId)
    this.#deferred.delete(orgId)
    for (const key of this.#overdue.keys()) if (key.startsWith(`${orgId}:`)) this.#overdue.delete(key)
    clearTimeout(entry.timer)
    entry.timer = undefined
    for (const waiter of entry.waiters.splice(0)) waiter()
  }

  // Reloads an org at once when the flags channel says it changed (channel.ts). A message for an
  // org this process doesn't keep is ignored. Resolves once subscribed.
  listen(subscriptions: Pick<Subscriptions, 'add'>, channel: string): Promise<void> {
    return subscriptions.add(channel, 'flags', text => {
      const message = readFlagsMessage(text)
      if (message === undefined) {
        this.#logger.warn({ event: 'flags_message_unreadable' }, 'dropped a message on the flags channel')
        return
      }
      if (this.#orgs.has(message.org)) void this.reload(message.org)
    })
  }

  // Reads an org's flags again at once (after a push, or a fence's HF001), and resolves when a read
  // that started after this call has finished, whether or not it worked. An org this process
  // doesn't keep is left alone (it resolves at once and the org stays unconfirmed): only track()
  // starts keeping one, so a job or consumer still running in an org the worker has untracked
  // can't keep it again.
  reload(orgId: string): Promise<void> {
    const entry = this.#orgs.get(orgId)
    if (entry === undefined) return Promise.resolve()
    return new Promise(resolve => {
      entry.waiters.push(resolve)
      if (entry.loading) entry.again = true
      else if (!this.#stopped) void this.#load(orgId, entry)
      else resolve()
    })
  }

  // Whether the feature is on for this person (or, with no subject, for the whole org): it and
  // every flag above it enabled, with the subject in each one's cohort (evaluate.ts). Off for a key
  // this process doesn't know. While the org's flags are unconfirmed (never read, or not read for
  // 8 s), only a flag locked on, with everything above it locked on, counts as on.
  isOn(orgId: string, key: string, subject: FlagSubject | null): boolean {
    return this.verdict(orgId, key, subject) === 'on'
  }

  // isOn() with the reason when it isn't (the job runner's outcomes, T15 items 9 and 11): 'off' when
  // the feature or a flag above it is switched off (or the key isn't known here), 'not_in_cohort'
  // when every flag is enabled but a cohort leaves the subject out, 'unconfirmed' when the org's
  // flags are unconfirmed and the feature isn't locked on.
  verdict(orgId: string, key: string, subject: FlagSubject | null): FlagVerdict {
    if (!Object.hasOwn(this.registry, key)) return 'off'
    const entry = this.#orgs.get(orgId)
    if (entry?.states === undefined || !this.#fresh(entry)) return isLockedOn(key, this.registry) ? 'on' : 'unconfirmed'
    const registered = (level: string) => Object.hasOwn(this.registry, level)
    if (evaluate(entry.states, key, subject, registered) === 'on') return 'on'
    return lineageEnabled(entry.states, key, registered) ? 'not_in_cohort' : 'off'
  }

  // Whether the org's flags were read within the last 8 s: the worker claims nothing for an org
  // whose flags it hasn't confirmed (T15 item 11).
  confirmed(orgId: string): boolean {
    const entry = this.#orgs.get(orgId)
    return entry !== undefined && this.#fresh(entry)
  }

  // The revisions of the feature's flag and every flag above it that has a row, registered or not,
  // from the top ('ai', 'ai.agents', …): exactly what the fences read and compare. Undefined when
  // the org's flags have never been read or the feature has no row.
  revisionsOf(orgId: string, key: string): readonly number[] | undefined {
    const states = this.#orgs.get(orgId)?.states
    if (states === undefined || !states.has(key)) return undefined
    return flagLineage(key).flatMap(level => {
      const state = states.get(level)
      return state === undefined ? [] : [state.revision]
    })
  }

  // When the org's flags were last read successfully (monotonic), or undefined.
  confirmedAt(orgId: string): number | undefined {
    return this.#orgs.get(orgId)?.confirmedAt
  }

  // The org's registers as last read, only while that read is confirmed (within 8 s), else
  // undefined: never read, not read lately, not kept, or a cache that keeps no registers. The
  // worker's purpose gate reads it (compliance/gate.ts).
  register(orgId: string): RegisterState | undefined {
    const entry = this.#orgs.get(orgId)
    return entry !== undefined && this.#fresh(entry) ? entry.register?.state : undefined
  }

  // Called with an org and the keys whose revision changed (added and removed rows included) after
  // each read that found a change. Not called for an org's first read. Returns a function that
  // stops it.
  onChange(listener: (orgId: string, keys: readonly string[]) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  // Stops polling. A read in progress finishes but schedules nothing.
  stop(): void {
    this.#stopped = true
    this.#deferred.clear()
    for (const entry of this.#orgs.values()) {
      clearTimeout(entry.timer)
      entry.timer = undefined
      for (const waiter of entry.waiters.splice(0)) waiter()
    }
  }

  #fresh(entry: OrgFlags): boolean {
    return entry.confirmedAt !== undefined && this.#now() - entry.confirmedAt <= this.#staleMs
  }

  async #load(orgId: string, entry: OrgFlags): Promise<void> {
    clearTimeout(entry.timer)
    entry.timer = undefined
    if (this.#inFlight >= FLAG_READS_IN_FLIGHT) {
      this.#defer(orgId, entry)
      return
    }
    entry.loading = true
    entry.again = false
    const waiters = entry.waiters.splice(0)
    const kept = () => this.#orgs.get(orgId) === entry
    this.#inFlight++
    const read = this.#read(orgId)
    // Counted until the read itself settles, not the wait for it.
    const settled = () => {
      this.#inFlight--
      this.#runDeferred()
    }
    read.then(settled, settled)
    try {
      const found = await this.#bounded(read)
      if (kept()) this.#confirm(orgId, entry, found)
    } catch (error) {
      if (kept()) this.#failed(orgId, entry, error)
    } finally {
      entry.loading = false
      for (const waiter of waiters) waiter()
    }
    // Untracked during the read: nothing more for this entry.
    if (!kept()) {
      for (const waiter of entry.waiters.splice(0)) waiter()
      return
    }
    if (this.#stopped) {
      for (const waiter of entry.waiters.splice(0)) waiter()
      return
    }
    if (entry.again) {
      void this.#load(orgId, entry)
      return
    }
    const delay = this.#pollMs * (0.9 + 0.2 * this.#random())
    entry.timer = setTimeout(() => void this.#load(orgId, entry), delay)
    entry.timer.unref()
  }

  // Too many reads are in flight: the org's poll waits until one settles. Whoever waits on a reload
  // is let go at once, as after a failed read; the org goes unconfirmed if this lasts, logged once
  // (flags_unconfirmed) as for a read that fails, when it does.
  #defer(orgId: string, entry: OrgFlags): void {
    for (const waiter of entry.waiters.splice(0)) waiter()
    if (this.#stopped) return
    this.#deferred.set(orgId, entry)
    if (!this.#fresh(entry)) this.#unconfirmed(orgId, entry)
    else {
      // When its last read goes stale, if it is still deferred then; #load, untrack() and stop()
      // clear the timer.
      const left = (entry.confirmedAt ?? 0) + this.#staleMs - this.#now()
      entry.timer = setTimeout(() => {
        if (this.#deferred.get(orgId) === entry && !this.#fresh(entry)) this.#unconfirmed(orgId, entry)
      }, left + 1)
      entry.timer.unref()
    }
    if (!this.#limited) {
      this.#limited = true
      this.#logger.warn(
        { event: 'flags_reads_limited', inFlight: this.#inFlight },
        'too many flag reads are in flight: further polls wait until one ends',
      )
    }
  }

  // Runs the deferred polls, oldest first, while reads are free.
  #runDeferred(): void {
    for (const [orgId, entry] of this.#deferred) {
      if (this.#inFlight >= FLAG_READS_IN_FLIGHT) return
      this.#deferred.delete(orgId)
      if (this.#stopped || this.#orgs.get(orgId) !== entry || entry.loading) continue
      void this.#load(orgId, entry)
    }
    // The episode ends only once reads are free again with nothing waiting, not each time the
    // deferred polls run and fill the reads again.
    if (this.#deferred.size === 0 && this.#inFlight < FLAG_READS_IN_FLIGHT) this.#limited = false
  }

  // The read, or a FlagReadTimeout once it has taken FLAG_READ_WAIT_MS. Postgres's statement_timeout
  // and transaction_timeout don't help when the connection's peer has gone silent (a failover, a
  // dropped network path): their error never arrives. The race settles without the read, and a read
  // that ends later changes nothing (Promise.race keeps the first outcome and handles the rest). Its
  // connection is freed by the pool's query_timeout: once a statement has gone unanswered for 31 s,
  // the client ends itself and the pool drops it (BoundedClient, pool.ts). Until then it counts
  // towards FLAG_READS_IN_FLIGHT.
  async #bounded<T>(read: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new FlagReadTimeout()), FLAG_READ_WAIT_MS)
      timer.unref()
    })
    try {
      return await Promise.race([read, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  // One read of the org's flags, and its registers when the cache keeps them, read only, each
  // statement bounded, as the org's system principal (and the worker's hearth_queue).
  #read(orgId: string): Promise<OrgRead> {
    const acting =
      this.#as === undefined ? { orgId, system: true as const } : { orgId, system: true as const, as: this.#as }
    const registers = this.#registers
    return withOrg(
      this.#db,
      acting,
      async trx => {
        await sql`set local statement_timeout = ${sql.lit(FLAG_READ_TIMEOUT)}`.execute(trx)
        const rows = await trx
          .selectFrom('feature_flags')
          .select(['key', 'enabled', 'locked', 'audience', 'cohort_people', 'cohort_roles', 'revision'])
          .where('org_id', '=', orgId)
          .execute()
        const register = registers === undefined ? undefined : await readRegisterState(trx, orgId, registers)
        return { rows, register }
      },
      { readOnly: true },
    )
  }

  #confirm(orgId: string, entry: OrgFlags, { rows, register }: OrgRead): void {
    const states = new Map<string, FlagState>()
    for (const row of rows) {
      states.set(row.key, {
        key: row.key,
        enabled: row.enabled,
        locked: row.locked,
        // Revisions stay far below 2^53.
        revision: Number(row.revision),
        audience: row.audience,
        cohort: { people: row.cohort_people, roles: row.cohort_roles },
      })
      if (!Object.hasOwn(this.registry, row.key) && !this.#unregistered.has(`${orgId}:${row.key}`)) {
        this.#unregistered.add(`${orgId}:${row.key}`)
        this.#logger.warn(
          { event: 'flag_unregistered', org: orgId, key: row.key },
          'a flag this process does not know reads as off',
        )
      }
    }
    const previous = entry.states
    const previousRegister = entry.register
    entry.states = states
    entry.register = register === undefined ? undefined : { state: register, digest: registerDigest(register) }
    entry.confirmedAt = this.#now()
    entry.failures = 0
    if (entry.unconfirmed) {
      entry.unconfirmed = false
      this.#logger.info({ event: 'flags_confirmed', org: orgId }, 'the flags can be read again')
    }
    entry.confirm()
    if (entry.register !== undefined) this.#noteRegister(orgId, previousRegister?.digest, entry.register)
    if (previous === undefined) return
    const changed = [...new Set([...previous.keys(), ...states.keys()])].filter(
      key => previous.get(key)?.revision !== states.get(key)?.revision,
    )
    if (changed.length === 0) return
    for (const key of changed) {
      this.#logger.info(
        { event: 'flags_changed', org: orgId, key, revision: states.get(key)?.revision ?? null },
        'a flag changed',
      )
    }
    for (const listener of this.#listeners) listener(orgId, changed)
  }

  // A change of the registers since the last read (never on the first), and each open clearance
  // whose review date is before today, as a UTC day: logged at most once a day for each (PD-13).
  // The page judges review dates in the org's zone; a day's slack is enough for a log line.
  #noteRegister(orgId: string, previous: string | undefined, current: { state: RegisterState; digest: string }): void {
    if (previous !== undefined && previous !== current.digest) {
      this.#logger.info({ event: 'register_changed', org: orgId }, 'the registers changed')
    }
    const today = new Date().toISOString().slice(0, 10)
    for (const [provider, entry] of current.state.providers) {
      if (entry.clearance === null || entry.reviewOn === null || entry.reviewOn >= today) continue
      const key = `${orgId}:${provider}`
      if (this.#overdue.get(key) === today) continue
      this.#overdue.set(key, today)
      this.#logger.warn(
        { event: 'transfer_review_overdue', org: orgId, provider, reviewOn: entry.reviewOn },
        'a cleared provider is past its review date',
      )
    }
  }

  #failed(orgId: string, entry: OrgFlags, error: unknown): void {
    entry.failures++
    const line = { event: 'flags_poll_failed', org: orgId, failures: entry.failures, failure: failureFields(error) }
    if (entry.failures >= FAILURES_BEFORE_ERROR) this.#logger.error(line, 'could not read the flags')
    else this.#logger.warn(line, 'could not read the flags')
    if (!this.#fresh(entry)) this.#unconfirmed(orgId, entry)
  }

  // The org's flags are unconfirmed: logged once until they are read again (flags_confirmed).
  #unconfirmed(orgId: string, entry: OrgFlags): void {
    if (entry.unconfirmed) return
    entry.unconfirmed = true
    this.#logger.warn(
      { event: 'flags_unconfirmed', org: orgId },
      'the flags are unconfirmed: only what is locked on counts as on',
    )
  }
}
