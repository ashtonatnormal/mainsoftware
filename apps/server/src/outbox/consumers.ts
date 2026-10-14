// Outbox consumers (INF-OUTBOX, TECH-SPEC T16 items 1-6, 9 and 18): code in the worker that
// acts on events, each with a checkpoint per org that moves in the same transaction as the effects
// of the events it passes, so an effect in Postgres happens once however often an event is
// delivered. Delivery is at least once: a consumer must converge (re-read the entity's current
// state, or deduplicate by what it does), and re-read the base row before anything it can't undo
// (T16 item 9). Effects outside Postgres go through jobs keyed by what they do.
//
// One round, for one consumer in one org, is one transaction as the consumer's own job role (the
// only role that may move its checkpoint), on the worker's work pool:
//   1. admit: the consumer's feature must be on for the org in the flag cache, and the gate must
//      allow its purpose and every provider it names; otherwise the round is skipped and the
//      consumer keeps its place;
//   2. one instance: pg_try_advisory_xact_lock on (consumer, org), or the round stops (busy);
//   3. the checkpoint: a new consumer's is made at its start (the oldest kept event, or now) and
//      the round ends there, so no round writes before it has read its batch: a write takes a
//      transaction id, which would hold back the consumer's own horizon;
//   4. the floor and the batch in one statement; a floor above the checkpoint means the clean-up
//      deleted events this consumer never saw, so it stops and logs an error until it is rebuilt;
//   5. handle the events of its types, passing over (and logging) any whose subject's processing
//      switch refuses its purpose; move the checkpoint by compare-and-set from the position read
//      (no row: a reset slipped in, so the round rolls back); end with feature_fence(), with the
//      flag revisions the round was admitted under, so nothing commits after its flag changed.
// A full batch runs the next round at once; otherwise the next comes after the poll (500 ms).
//
// Before an org's first round, the restore check (T16 item 18, at start only: A3) stops every
// consumer of an org whose stored positions are ahead of the cluster's transaction ids, which only a
// logical restore or a Blue/Green upgrade can cause.
import { performance } from 'node:perf_hooks'
import type { EventType, ProviderKey, PurposeKey } from '@hearth/shared'
import { sql } from 'kysely'
import type { Logger } from 'pino'
import { type Database, type InOrg, TRANSACTION_TIMEOUT, withOrg } from '#src/db/database.ts'
import type { JobRole } from '#src/db/roles.ts'
import { failureFields } from '#src/db/sqlstate.ts'
import type { FlagCache } from '#src/flags/cache.ts'
import { FeatureOff, fenceFeature } from '#src/flags/fence.ts'
import type { Gate } from '#src/jobs/gate.ts'
import {
  futureRows,
  lockConsumer,
  moveCheckpoint,
  type OutboxRow,
  type Position,
  positionOf,
  readBatch,
  readCheckpoint,
  type Start,
  setCheckpoint,
  startCheckpoint,
  tryLockConsumer,
} from '#src/outbox/positions.ts'

export interface OutboxConsumer {
  // Its checkpoint's key: lower case, at most 63 characters.
  name: string
  // The job role its transactions take; it alone moves its checkpoint.
  role: JobRole
  // It consumes only while this flag is on for the whole org, and keeps its place while it's off.
  feature: string
  // Why it processes the events' subjects (the gate, T15 item 10).
  purpose: PurposeKey
  // Outside providers it sends personal data to (PDPA-10); each must be cleared.
  providers?: readonly ProviderKey[]
  // The events handle() receives; it reads past the rest.
  types: readonly EventType[]
  start: Start
  // At most this many events a round (500 by default).
  batch?: number
  // outbox_lag warns when the consumer is further behind than this (lag.ts).
  lagBudgetMs: number
  // Applies the events' effects in the round's transaction, which then moves the checkpoint.
  handle(trx: InOrg, events: readonly OutboxRow[], context: { orgId: string; log: Logger }): Promise<void>
}

export const OUTBOX_POLL_MS = 500
export const OUTBOX_BATCH = 500
// A loop that has failed this many times in a row logs at error level.
const FAILURES_BEFORE_ERROR = 3

export type RoundResult =
  // More may be waiting (a full batch, or a checkpoint just made): the next round runs at once.
  | 'full'
  // Nothing more to read for now.
  | 'idle'
  // Not admitted: the feature is off, or the gate refuses the purpose or a provider.
  | 'refused'
  // Another round for this consumer and org holds the lock.
  | 'busy'
  // The clean-up has deleted events past the checkpoint; the consumer must be rebuilt.
  | 'behind'
  // A reset moved the checkpoint during the round, which rolled back.
  | 'moved'
  // The fence refused: a flag changed during the round, which rolled back.
  | 'fenced'
  // The restore check found positions from the future; the org's consumers stop.
  | 'future'

// The checkpoint wasn't where the round read it: a reset slipped in.
class CheckpointMoved extends Error {
  override name = 'CheckpointMoved'
}

// A reset to a position the clean-up has already deleted past.
export class BelowFloor extends Error {
  override name = 'BelowFloor'
  constructor() {
    super('that position is below the outbox floor: rebuild the consumer from the base tables instead')
  }
}

// A consumer that can't move in an org until a person acts: the clean-up deleted events it never
// saw (behind_floor: rebuild it, then reset it), or the org's stored positions are ahead of the
// cluster's transaction ids (future_rows: the restore runbook, then a restart, A3).
export interface Blocked {
  consumer: string
  org: string
  reason: 'behind_floor' | 'future_rows'
}

export interface ConsumerRunnerOptions {
  // The worker's work pool, as hearth_worker (a job role per transaction).
  db: Database
  consumers: readonly OutboxConsumer[]
  flags: Pick<FlagCache, 'isOn' | 'revisionsOf' | 'reload'>
  gate: Gate
  logger: Logger
  pollMs?: number
  // A monotonic clock (performance.now), for lastRound() and stop()'s deadline.
  now?: () => number
}

export class ConsumerRunner {
  readonly #db: Database
  readonly #consumers: readonly OutboxConsumer[]
  readonly #flags: Pick<FlagCache, 'isOn' | 'revisionsOf' | 'reload'>
  readonly #gate: Gate
  readonly #logger: Logger
  readonly #pollMs: number
  readonly #now: () => number
  // Per org, the restore check's answer (run once, at the org's first round).
  readonly #futures = new Map<string, Promise<boolean>>()
  // Per consumer and org: why it was last refused, why it is blocked, its failures in a row.
  readonly #refused = new Map<string, string>()
  readonly #blocked = new Map<string, Blocked>()
  readonly #failures = new Map<string, number>()
  // Per consumer, when its last pass over every org finished without an error.
  readonly #lastPass = new Map<string, number>()
  readonly #loops: Promise<void>[] = []
  readonly #wakers = new Set<() => void>()
  #startedAt: number | undefined
  #stopping = false

  constructor(options: ConsumerRunnerOptions) {
    this.#db = options.db
    this.#consumers = options.consumers
    this.#flags = options.flags
    this.#gate = options.gate
    this.#logger = options.logger
    this.#pollMs = options.pollMs ?? OUTBOX_POLL_MS
    this.#now = options.now ?? (() => performance.now())
    const names = new Set<string>()
    for (const consumer of options.consumers) {
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(consumer.name))
        throw new Error(`a consumer name must be a code: ${consumer.name}`)
      if (names.has(consumer.name)) throw new Error(`two outbox consumers are named ${consumer.name}`)
      names.add(consumer.name)
    }
  }

  // Runs every consumer, each in a loop of its own over the orgs `orgs` lists at each pass, its
  // first round at once.
  start(orgs: () => readonly string[]): void {
    if (this.#startedAt !== undefined) throw new Error('the consumers have started already')
    this.#startedAt = this.#now()
    for (const consumer of this.#consumers) this.#loops.push(this.#loop(consumer, orgs))
  }

  // Stops starting rounds and waits for those in progress, never past `deadline` (on the runner's
  // monotonic clock). A round cut off rolls back when its connection goes.
  async stop(deadline: number): Promise<void> {
    this.#stopping = true
    for (const wake of this.#wakers) wake()
    const left = Math.max(0, deadline - this.#now())
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.allSettled(this.#loops),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, left)
      }),
    ])
    clearTimeout(timer)
  }

  // When the last pass of every consumer over every org finished without an error (monotonic), or
  // undefined if one hasn't yet: that the loops are running, for the worker's readiness. With no
  // consumers, when it started. A blocked consumer's rounds end without an error, so readiness also
  // asks blocked().
  lastRound(): number | undefined {
    if (this.#consumers.length === 0) return this.#startedAt
    let oldest: number | undefined
    for (const consumer of this.#consumers) {
      const pass = this.#lastPass.get(consumer.name)
      if (pass === undefined) return undefined
      oldest = oldest === undefined ? pass : Math.min(oldest, pass)
    }
    return oldest
  }

  // Each consumer and org whose last round found it blocked, until a later round reads or finds
  // nothing to read: the worker is unready while any is (T18 item 9).
  blocked(): Blocked[] {
    return [...this.#blocked.values()]
  }

  // Moves a consumer's checkpoint, for replay and tests (T16 item 5): to the oldest kept event, to
  // now, or to a position, never below the floor (BelowFloor). It runs as the consumer's own role
  // and takes the same lock as a round, waiting for one in progress, so the round can't then
  // overwrite it; a round that read the checkpoint before the reset finds it moved and rolls back.
  // A round may hold the lock for as long as its transaction lasts (30 s), longer than withOrg()'s
  // 2 s lock_timeout, so the reset waits as long as that.
  static async reset(db: Database, consumer: OutboxConsumer, orgId: string, to: Start | Position): Promise<void> {
    await withOrg(db, { orgId, system: true, as: consumer.role }, async trx => {
      await sql`set local lock_timeout = ${sql.lit(TRANSACTION_TIMEOUT)}`.execute(trx)
      await lockConsumer(trx, consumer.name, orgId)
      if (!(await setCheckpoint(trx, orgId, consumer.name, consumer.role, to))) throw new BelowFloor()
    })
  }

  // One round of one consumer in one org. Throws what a round can't handle itself (a lost
  // connection, a handler's failure), after which the transaction has rolled back.
  async round(consumer: OutboxConsumer, orgId: string): Promise<RoundResult> {
    const result = await this.#round(consumer, orgId)
    this.#noteBlock(consumer, orgId, result)
    return result
  }

  async #round(consumer: OutboxConsumer, orgId: string): Promise<RoundResult> {
    const key = `${consumer.name}:${orgId}`
    const refusal = this.#refusal(consumer, orgId)
    this.#noteRefusal(consumer, orgId, key, refusal)
    if (refusal !== undefined) return 'refused'
    const seen = this.#flags.revisionsOf(orgId, consumer.feature)
    if (seen === undefined) {
      // On only because it is locked on, before the org's flags were first read: read them, and
      // admit the next round with the revisions the fence will compare.
      void this.#flags.reload(orgId)
      return 'refused'
    }
    if (await this.#future(orgId)) return 'future'
    const log = this.#logger.child({ consumer: consumer.name, org: orgId })
    const size = consumer.batch ?? OUTBOX_BATCH
    const types = new Set<string>(consumer.types)
    try {
      return await withOrg(this.#db, { orgId, system: true, as: consumer.role }, async trx => {
        if (!(await tryLockConsumer(trx, consumer.name, orgId))) return 'busy'
        const from = await readCheckpoint(trx, orgId, consumer.name)
        if (from === undefined) {
          await startCheckpoint(trx, orgId, consumer.name, consumer.role, consumer.start)
          return 'full'
        }
        const batch = await readBatch(trx, orgId, from, size)
        if (batch.fellBehind) return 'behind'
        const last = batch.rows.at(-1)
        if (last === undefined) return 'idle'
        const events = batch.rows.filter(
          row => types.has(row.type) && this.#processingAllowed(consumer, orgId, row, log),
        )
        if (events.length > 0) await consumer.handle(trx, events, { orgId, log })
        if (!(await moveCheckpoint(trx, orgId, consumer.name, from, positionOf(last), batch.rows.length))) {
          throw new CheckpointMoved()
        }
        await fenceFeature(trx, consumer.feature, seen)
        return batch.rows.length >= size ? 'full' : 'idle'
      })
    } catch (error) {
      if (error instanceof CheckpointMoved) {
        log.warn({ event: 'outbox_checkpoint_moved' }, 'a reset moved the checkpoint during the round')
        return 'moved'
      }
      if (error instanceof FeatureOff) {
        // The flags changed since the round was admitted: read them again before the next round.
        await this.#flags.reload(orgId)
        return 'fenced'
      }
      throw error
    }
  }

  async #loop(consumer: OutboxConsumer, orgs: () => readonly string[]): Promise<void> {
    while (!this.#stopping) {
      let again = false
      let clean = true
      for (const orgId of orgs()) {
        if (this.#stopping) return
        const key = `${consumer.name}:${orgId}`
        try {
          const result = await this.round(consumer, orgId)
          this.#failures.delete(key)
          if (result === 'full') again = true
        } catch (error) {
          clean = false
          const failures = (this.#failures.get(key) ?? 0) + 1
          this.#failures.set(key, failures)
          const line = {
            event: 'worker_loop_failed',
            loop: `outbox:${consumer.name}`,
            org: orgId,
            failures,
            failure: failureFields(error),
          }
          if (failures >= FAILURES_BEFORE_ERROR) this.#logger.error(line, 'an outbox round failed')
          else this.#logger.warn(line, 'an outbox round failed')
        }
      }
      if (clean) this.#lastPass.set(consumer.name, this.#now())
      if (!again && !this.#stopping) await this.#sleep(this.#pollMs)
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const wake = () => {
        clearTimeout(timer)
        this.#wakers.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, ms)
      this.#wakers.add(wake)
    })
  }

  // A round that found the consumer behind the floor or the org's positions from the future blocks
  // it; one that read, or found nothing to read, frees it. The rest (refused, busy, moved, fenced)
  // say nothing about either, so the block stands. Logged once each time it changes: the block at
  // error level (outbox_future_rows, logged once per org by the restore check, says why too).
  #noteBlock(consumer: OutboxConsumer, orgId: string, result: RoundResult): void {
    const key = `${consumer.name}:${orgId}`
    const line = { consumer: consumer.name, org: orgId }
    if (result === 'behind' || result === 'future') {
      const reason = result === 'behind' ? 'behind_floor' : 'future_rows'
      if (this.#blocked.get(key)?.reason === reason) return
      this.#blocked.set(key, { ...line, reason })
      if (reason === 'behind_floor') {
        this.#logger.error(
          { event: 'outbox_consumer_fell_behind', ...line, reason },
          'the clean-up deleted events this consumer never handled: rebuild it',
        )
      } else {
        this.#logger.error(
          { event: 'outbox_consumer_blocked', ...line, reason },
          'this consumer is stopped until the restore runbook is run',
        )
      }
    } else if ((result === 'full' || result === 'idle') && this.#blocked.delete(key)) {
      this.#logger.info({ event: 'outbox_consumer_unblocked', ...line }, 'the consumer is moving again')
    }
  }

  // Why the consumer may not run in this org now, or undefined.
  #refusal(consumer: OutboxConsumer, orgId: string): string | undefined {
    if (!this.#flags.isOn(orgId, consumer.feature, null)) return 'flag_off'
    if (!this.#gate.purposeAllowed(orgId, consumer.purpose)) return 'purpose_refused'
    if ((consumer.providers ?? []).some(provider => !this.#gate.providerCleared(orgId, provider))) {
      return 'provider_not_cleared'
    }
    return undefined
  }

  // Logged once each time the answer changes: a flag being off is the normal way to pause a
  // consumer (info); a gate refusal means a consumer is registered that can't run (warn).
  #noteRefusal(consumer: OutboxConsumer, orgId: string, key: string, reason: string | undefined): void {
    const before = this.#refused.get(key)
    if (before === reason) return
    if (reason === undefined) {
      this.#refused.delete(key)
      this.#logger.info({ event: 'outbox_consumer_admitted', consumer: consumer.name, org: orgId }, 'consuming again')
      return
    }
    this.#refused.set(key, reason)
    const line = { consumer: consumer.name, org: orgId, reason }
    if (reason === 'flag_off') this.#logger.info({ event: 'outbox_consumer_paused', ...line }, 'consumer paused')
    else this.#logger.warn({ event: 'outbox_consumer_refused', ...line }, 'the gate refuses this consumer')
  }

  // Whether every subject's processing switch allows the consumer's purpose (PDPA-04); an event
  // whose subject refuses it is passed over, and logged by id.
  #processingAllowed(consumer: OutboxConsumer, orgId: string, row: OutboxRow, log: Logger): boolean {
    if (row.subjects.every(subject => this.#gate.processingAllowed(orgId, subject, consumer.purpose))) return true
    log.info({ event: 'outbox_event_withheld', eventId: row.id }, 'an event was passed over for its subject')
    return false
  }

  // The restore check, once per org (A3), as hearth_queue and read only. A check that fails is
  // tried again at the org's next round.
  #future(orgId: string): Promise<boolean> {
    let check = this.#futures.get(orgId)
    if (check === undefined) {
      check = withOrg(this.#db, { orgId, system: true, as: 'hearth_queue' }, trx => futureRows(trx, orgId), {
        readOnly: true,
      }).then(future => {
        if (future) {
          this.#logger.error(
            { event: 'outbox_future_rows', org: orgId },
            'stored outbox positions are ahead of this cluster: run the restore runbook',
          )
        }
        return future
      })
      check.catch(() => this.#futures.delete(orgId))
      this.#futures.set(orgId, check)
    }
    return check
  }
}
