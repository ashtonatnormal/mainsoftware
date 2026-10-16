// The revocation registry (BUILD-PLAN 669; TECH-SPEC T19 items 2-4; REG-01, REG-02, REG-06): what
// drops someone's live access, for anyone, for any reason, durably. The offboarding registry
// (offboarding.ts) does what a departure does to someone's things; this one takes live access away.
// A deactivation reaches it as signin.ended {deactivated} and acl.changed {keys, deactivated}, both
// appended in the deactivation's own transaction (T16 item 8), so it needn't read person.deactivated.
//
//   the consumer  `revocation`, in the worker, as hearth_job_revocation (0008), under core.system
//                 (locked on) with purpose accounts, from 'now' (the re-check covers anything before
//                 it). It is protective (outbox/consumers.ts): it only takes access away, so no
//                 subject's processing switch withholds one of its events (S8). For each readable
//                 event, and each handler that acts on its cause, it queues one revocation.handler
//                 job in the round's transaction. An event it can't read is passed over with an
//                 error line and the checkpoint moves on: a round that threw would roll back and
//                 repeat at every poll, and every later revocation in the org would lose its durable
//                 path (m4). The event is a claim; the realtime re-check is the guarantee.
//   the jobs      ids only, naming no subject (the role can't read people, and a subject's switch
//                 must never hold back a revocation). Each tries 20 times, from 1 s doubling to 15 s,
//                 so about seven tries start inside Rule 6's minute; one that dies logs
//                 revocation_handler_dead at error level (C0.13 alarms on it).
//   the handlers  sockets (sessions_ended): re-reads which of the sessions have ended, and when, and
//                 publishes those on the access channel (revocation/channels.ts) with the earliest
//                 revoked_at, so realtime closes their sockets at once; none ended means the claim
//                 was forged, and the job dies (not_ended). topics (keys_changed): publishes the
//                 people, whom realtime re-checks against Postgres, so it can only drop what
//                 Postgres says is lost.
//
// A later step adds its handler's name to REVOCATION_HANDLERS and registers it in
// revocationRegistry(), with the grants its reads need in its own migration (§3.6 of the C0.7
// design): C2.2 'livekit', C4.3 'hocuspocus', PRD-99 'previews', A2.3 'ai_cache'. C1.1 and C4.1 add
// the cause 'rows_changed' to REVOCATION_CAUSES and to revocationOf().
import { LowerUuid } from '@hearth/shared'
import type { Redis } from 'ioredis'
import { sql } from 'kysely'
import type { Logger } from 'pino'
import { z } from 'zod'
import type { JobContext } from '#src/jobs/context.ts'
import { type EnqueueInput, enqueue } from '#src/jobs/enqueue.ts'
import { PermanentJobError } from '#src/jobs/errors.ts'
import { defineJob, type JobKind } from '#src/jobs/kinds.ts'
import type { OutboxConsumer } from '#src/outbox/consumers.ts'
import type { OutboxRow } from '#src/outbox/positions.ts'
import { publishAccess } from '#src/revocation/channels.ts'

// Every handler's name (T15 item 8): a job payload names one, as a code.
export const REVOCATION_HANDLERS = ['sockets', 'topics'] as const
export type RevocationHandlerName = (typeof REVOCATION_HANDLERS)[number]

// What lost access, as a job re-reads it.
export const REVOCATION_CAUSES = ['sessions_ended', 'keys_changed'] as const
export type RevocationCause = (typeof REVOCATION_CAUSES)[number]

// At most this many sessions or people in one revocation: what an event's ids may hold (ids.ts).
export const REVOCATION_MAX_IDS = 100

export type Revocation =
  | { cause: 'sessions_ended'; person: string; sessions: readonly string[] }
  | { cause: 'keys_changed'; people: readonly string[] }

// Ids in the database's lower-case form (LowerUuid), which enqueue() and is_ids_only() require.
export const RevocationPayload = z.strictObject({
  handler: z.enum(REVOCATION_HANDLERS),
  cause: z.enum(REVOCATION_CAUSES),
  person: LowerUuid.optional(),
  people: z.array(LowerUuid).max(REVOCATION_MAX_IDS).optional(),
  sessions: z.array(LowerUuid).max(REVOCATION_MAX_IDS).optional(),
})
export type RevocationPayload = z.infer<typeof RevocationPayload>

export interface RevocationContext {
  orgId: string
}

// Each handler is idempotent: its job may run again. It reads only through job.read(), as the
// job's role, and throws to be retried.
export interface RevocationHandler {
  name: RevocationHandlerName
  causes: readonly RevocationCause[]
  run(revocation: Revocation, context: RevocationContext, job: JobContext<RevocationPayload>): Promise<void>
}

export class RevocationRegistry {
  readonly #handlers = new Map<string, RevocationHandler>()

  register(handler: RevocationHandler): void {
    if (!(REVOCATION_HANDLERS as readonly string[]).includes(handler.name)) {
      throw new Error(`a revocation handler's name must be listed in REVOCATION_HANDLERS: ${handler.name}`)
    }
    if (this.#handlers.has(handler.name)) {
      throw new Error(`a revocation handler named ${handler.name} is already registered`)
    }
    if (handler.causes.length === 0) throw new Error(`the revocation handler ${handler.name} acts on no cause`)
    for (const cause of handler.causes) {
      if (!(REVOCATION_CAUSES as readonly string[]).includes(cause)) {
        throw new Error(`the revocation handler ${handler.name} names an unknown cause: ${cause}`)
      }
    }
    this.#handlers.set(handler.name, handler)
  }

  get(name: string): RevocationHandler | undefined {
    return this.#handlers.get(name)
  }

  // The handlers that act on this cause, in the order they registered.
  handling(cause: RevocationCause): RevocationHandler[] {
    return [...this.#handlers.values()].filter(handler => handler.causes.includes(cause))
  }

  // In the order they registered.
  names(): RevocationHandlerName[] {
    return [...this.#handlers.keys()] as RevocationHandlerName[]
  }
}

// The payload's own shape: sessions_ended needs a person and 1 to 100 sessions and no people;
// keys_changed needs 1 to 100 people and no person or sessions. Anything else can never run, so the
// job dies (payload_shape).
export function revocationOfPayload(payload: RevocationPayload): Revocation {
  const { cause, person, people, sessions } = payload
  if (cause === 'sessions_ended' && person !== undefined && sessions !== undefined && people === undefined) {
    if (sessions.length > 0) return { cause, person, sessions }
  }
  if (cause === 'keys_changed' && people !== undefined && person === undefined && sessions === undefined) {
    if (people.length > 0) return { cause, people }
  }
  throw new PermanentJobError('payload_shape')
}

// What the consumer reads of each event: leniently where later steps may add fields (any reason,
// so C0.16's need no change here), strictly where the round depends on the value (m4).
const SessionsEnded = z.object({ sessions: z.array(LowerUuid).max(REVOCATION_MAX_IDS) })
const AclChanged = z.object({ change: z.enum(['keys', 'rows']) })
const People = z.array(LowerUuid).min(1).max(REVOCATION_MAX_IDS)

// The revocation an event asks for, or undefined when there is nothing to do or the event can't be
// read. An unreadable event is logged by its id, never its ids.
export function revocationOf(event: OutboxRow, log: Pick<Logger, 'debug' | 'warn' | 'error'>): Revocation | undefined {
  const passed = (reason: string) => {
    log.debug({ event: 'revocation_event_passed', eventId: event.id, reason }, 'nothing to revoke for this event')
    return undefined
  }
  const unreadable = (level: 'warn' | 'error' = 'error') => {
    log[level](
      { event: 'revocation_event_unreadable', eventId: event.id, type: event.type },
      'the revocation consumer passed over an event it could not read',
    )
    return undefined
  }
  if (event.type === 'signin.ended') {
    const ids = SessionsEnded.safeParse(event.ids)
    if (!ids.success || !LowerUuid.safeParse(event.entity.id).success) return unreadable()
    // A device signed out with no live session: nothing to close.
    if (ids.data.sessions.length === 0) return passed('no_sessions')
    return { cause: 'sessions_ended', person: event.entity.id, sessions: ids.data.sessions }
  }
  if (event.type === 'acl.changed') {
    const ids = AclChanged.safeParse(event.ids)
    if (!ids.success) return unreadable()
    // A rewritten stored ACL: C1.1 brings rows_changed.
    if (ids.data.change === 'rows') return passed('rows')
    if (event.subjects.length === 0) return unreadable('warn')
    const people = People.safeParse(event.subjects)
    if (!people.success) return unreadable()
    return { cause: 'keys_changed', people: people.data }
  }
  return unreadable()
}

// One handler's job for one revocation. A sockets job is keyed by its handler and first session,
// unique because a session ends once; a keys job has no key, since a repeated re-check is harmless
// and the only id unique to the event is its bigint, which no key may hold. Neither names a subject.
export function jobInput(handler: RevocationHandlerName, revocation: Revocation): EnqueueInput<RevocationPayload> {
  if (revocation.cause === 'sessions_ended') {
    const [first] = revocation.sessions
    return {
      payload: { handler, cause: revocation.cause, person: revocation.person, sessions: [...revocation.sessions] },
      ...(first === undefined ? {} : { idempotencyKey: `${handler}:${first}` }),
    }
  }
  return { payload: { handler, cause: revocation.cause, people: [...revocation.people] } }
}

// The job that runs one handler for one revocation.
export function revocationJob(registry: RevocationRegistry): JobKind<RevocationPayload> {
  return defineJob({
    kind: 'revocation.handler',
    feature: 'core.system',
    purpose: 'accounts',
    role: 'hearth_job_revocation',
    payload: RevocationPayload,
    maxAttempts: 20,
    backoff: { baseMs: 1000, capMs: 15_000 },
    timeoutMs: 30_000,
    deadEvent: 'revocation_handler_dead',
    async run(ctx) {
      const revocation = revocationOfPayload(ctx.job.payload)
      const handler = registry.get(ctx.job.payload.handler)
      if (handler === undefined) {
        // A handler a later version removed: nothing is left to do.
        ctx.log.warn(
          { event: 'revocation_handler_unregistered', handler: ctx.job.payload.handler },
          'no such revocation handler now',
        )
        return
      }
      if (!handler.causes.includes(revocation.cause)) throw new PermanentJobError('cause_not_handled')
      await handler.run(revocation, { orgId: ctx.job.orgId }, ctx)
    },
  })
}

// The outbox consumer that queues the handlers' jobs for each signin.ended and acl.changed.
export function revocationConsumer(registry: RevocationRegistry, job: JobKind<RevocationPayload>): OutboxConsumer {
  return {
    name: 'revocation',
    role: 'hearth_job_revocation',
    feature: 'core.system',
    purpose: 'accounts',
    // It only takes access away: no subject's processing switch withholds its events (T19 item 4).
    protective: true,
    types: ['signin.ended', 'acl.changed'],
    start: 'now',
    lagBudgetMs: 10_000,
    async handle(trx, events, { orgId, log }) {
      for (const event of events) {
        const revocation = revocationOf(event, log)
        if (revocation === undefined) continue
        for (const handler of registry.handling(revocation.cause)) {
          await enqueue(trx, orgId, job, jobInput(handler.name, revocation))
        }
      }
    },
  }
}

// What a handler needs to publish on the access channel.
export interface PublishDeps {
  valkey: Pick<Redis, 'publish'>
  keyPrefix: string
  logger: Pick<Logger, 'warn' | 'error'>
}

// Closes ended sessions' sockets: re-reads which of the sessions have ended, and when, as the job's
// role, then publishes those, durable, with the earliest revoked_at as the latency's start. The
// sessions' revocation is final (keep_history), so a re-run publishes the same again, harmlessly.
export function socketsHandler(deps: PublishDeps): RevocationHandler {
  return {
    name: 'sockets',
    causes: ['sessions_ended'],
    async run(revocation, { orgId }, job) {
      if (revocation.cause !== 'sessions_ended') throw new PermanentJobError('cause_not_handled')
      const ended = await job.read(async trx => {
        const { rows } = await sql<{ id: string; revoked_at: Date }>`select id, revoked_at from sessions
          where org_id = ${orgId} and user_id = ${revocation.person} and id = any(${[...revocation.sessions]}::uuid[])
            and revoked_at is not null`.execute(trx)
        return rows
      })
      if (ended.length === 0) {
        job.log.error(
          { event: 'revocation_not_ended', sessions: revocation.sessions.length },
          'an event says sessions ended that have not: nothing is published',
        )
        throw new PermanentJobError('not_ended')
      }
      if (ended.length < revocation.sessions.length) {
        job.log.error(
          { event: 'revocation_not_ended', sessions: revocation.sessions.length - ended.length, ended: ended.length },
          'an event names sessions that have not ended: only those that have are published',
        )
      }
      // A failed publish fails the job, which is tried again (T16 item 4).
      await publishAccess(
        deps.valkey,
        deps.keyPrefix,
        {
          v: 1,
          org: orgId,
          path: 'durable',
          cause: 'sessions_ended',
          at: Math.min(...ended.map(row => new Date(row.revoked_at).getTime())),
          sessions: ended.map(row => row.id),
        },
        deps.logger,
        { rethrow: true },
      )
    },
  }
}

// Re-checks people whose keys changed: publishes them, durable, with no start time, since realtime
// derives it from the base rows its re-check reads, and can drop only what Postgres says is lost.
export function topicsHandler(deps: PublishDeps): RevocationHandler {
  return {
    name: 'topics',
    causes: ['keys_changed'],
    async run(revocation, { orgId }) {
      if (revocation.cause !== 'keys_changed') throw new PermanentJobError('cause_not_handled')
      await publishAccess(
        deps.valkey,
        deps.keyPrefix,
        { v: 1, org: orgId, path: 'durable', cause: 'keys_changed', people: [...revocation.people] },
        deps.logger,
        { rethrow: true },
      )
    },
  }
}

// The registry the worker runs, with every handler of this version: sockets, then topics.
export function revocationRegistry(deps: PublishDeps): RevocationRegistry {
  const registry = new RevocationRegistry()
  registry.register(socketsHandler(deps))
  registry.register(topicsHandler(deps))
  return registry
}
