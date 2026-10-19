// What happens when someone leaves (ACC-05), after their deactivation has committed. The
// deactivation itself ends their sessions and signs their devices out in the same transaction
// (0006, people_end_sessions), and appends person.deactivated, signin.ended and acl.changed to the
// outbox; once committed, the api publishes the sessions it ended, so their sockets close at once
// (admin/people.ts). Closing a leaver's live connections durably is the revocation registry's work
// from C0.7 (revocation/registry.ts; TECH-SPEC T19 item 2), which hears signin.ended and
// acl.changed for any reason, deactivation included. Everything else a departure does to someone's
// things registers a handler here, so the admin service needn't know them all: later steps add
// theirs (A2 the index, A4 their agents and assistant, C2.2 their rooms, C4.1 and C4.3 their Drive
// items), each with a name in OFFBOARDING_HANDLERS. C0.7 has none.
//
// The registry runs in the worker, durably (TECH-SPEC T14 item 13, T16 item 9):
//   - the offboarding consumer reads person.deactivated from the outbox and checks that the person
//     has really left (an event is a claim, never proof: one that names someone still at the org is
//     logged at error level and passed over), then queues one offboarding.handler job per handler,
//     keyed by person and handler, so a repeated or replayed event adds nothing while the job's row
//     lasts;
//   - each offboarding.handler job reads the person again before it runs, and takes who deactivated
//     them from their row, never from the payload, then runs its handler, retried with back-off;
//     one that keeps failing goes dead and logs offboarding_handler_dead (C0.13 alarms on it). A job
//     whose handler is no longer registered (one queued before C0.7 for the retired sockets handler)
//     finishes with offboarding_handler_unregistered.
// The consumer isn't protective (outbox/consumers.ts): offboarding processes a leaver's things, so a
// processing switch may still withhold it. Deactivation can't be undone (0002's keep_history on
// deactivated_at), so a person once read as gone stays gone, and a plain read is enough.
import { sql } from 'kysely'
import { z } from 'zod'
import type { JobContext } from '#src/jobs/context.ts'
import { enqueue } from '#src/jobs/enqueue.ts'
import { PermanentJobError } from '#src/jobs/errors.ts'
import { defineJob, type JobKind } from '#src/jobs/kinds.ts'
import type { OutboxConsumer } from '#src/outbox/consumers.ts'

// Every handler's name: a job's payload names one, and a payload holds codes, never free text.
// 'sockets' was retired in C0.7 (TECH-SPEC T19 item 2): kept so a job queued before it parses,
// finds no handler and finishes (offboarding_handler_unregistered); C2.2 adds the first new one.
export const OFFBOARDING_HANDLERS = ['sockets'] as const
export type OffboardingHandlerName = (typeof OFFBOARDING_HANDLERS)[number]

export const OffboardingPayload = z.strictObject({ person: z.uuid(), handler: z.enum(OFFBOARDING_HANDLERS) })
export type OffboardingPayload = z.infer<typeof OffboardingPayload>

export interface OffboardingContext {
  orgId: string
  personId: string
  // The admin who deactivated them, from the person's row.
  actorId: string
}

// Each handler must be idempotent: its job may run again (a retry, a replay, BUILD-PLAN's
// offboarding test). So a handler works from the context and what it reads now, never from what an
// earlier run left behind, and reads through the job (its read() and commit(), as the job's role).
export interface OffboardingHandler {
  name: OffboardingHandlerName
  run(context: OffboardingContext, job: JobContext<OffboardingPayload>): Promise<void>
}

export class OffboardingRegistry {
  readonly #handlers = new Map<string, OffboardingHandler>()

  register(handler: OffboardingHandler): void {
    if (!(OFFBOARDING_HANDLERS as readonly string[]).includes(handler.name)) {
      throw new Error(`an offboarding handler's name must be listed in OFFBOARDING_HANDLERS: ${handler.name}`)
    }
    if (this.#handlers.has(handler.name)) {
      throw new Error(`an offboarding handler named ${handler.name} is already registered`)
    }
    this.#handlers.set(handler.name, handler)
  }

  get(name: string): OffboardingHandler | undefined {
    return this.#handlers.get(name)
  }

  // In the order they registered.
  names(): OffboardingHandlerName[] {
    return [...this.#handlers.keys()] as OffboardingHandlerName[]
  }
}

// The job that runs one handler for one leaver.
export function offboardingJob(registry: OffboardingRegistry): JobKind<OffboardingPayload> {
  return defineJob({
    kind: 'offboarding.handler',
    feature: 'core.system',
    purpose: 'accounts',
    role: 'hearth_job_offboarding',
    payload: OffboardingPayload,
    maxAttempts: 10,
    backoff: { baseMs: 5000, capMs: 10 * 60_000 },
    timeoutMs: 60_000,
    deadEvent: 'offboarding_handler_dead',
    async run(ctx) {
      const { person, handler: name } = ctx.job.payload
      const gone = await ctx.read(async trx => {
        const { rows } = await sql<{ deactivated_by: string }>`select deactivated_by from people
          where org_id = ${ctx.job.orgId} and id = ${person} and deactivated_at is not null`.execute(trx)
        return rows[0]
      })
      if (gone === undefined) throw new PermanentJobError('not_deactivated')
      const handler = registry.get(name)
      if (handler === undefined) {
        // A handler a later version removed: nothing is left to do.
        ctx.log.warn({ event: 'offboarding_handler_unregistered', handler: name }, 'no such offboarding handler now')
        return
      }
      await handler.run({ orgId: ctx.job.orgId, personId: person, actorId: gone.deactivated_by }, ctx)
    },
  })
}

// The outbox consumer that queues the handlers' jobs for each person.deactivated.
export function offboardingConsumer(registry: OffboardingRegistry, job: JobKind<OffboardingPayload>): OutboxConsumer {
  return {
    name: 'offboarding',
    role: 'hearth_job_offboarding',
    feature: 'core.system',
    purpose: 'accounts',
    types: ['person.deactivated'],
    start: 'oldest',
    lagBudgetMs: 10_000,
    async handle(trx, events, { orgId, log }) {
      for (const event of events) {
        const person = event.entity.id
        const { rows } = await sql<{ id: string }>`select id from people
          where org_id = ${orgId} and id = ${person} and deactivated_at is not null`.execute(trx)
        if (rows.length === 0) {
          log.error(
            { event: 'offboarding_not_deactivated', eventId: event.id },
            'an event says someone left who has not: no offboarding handler runs',
          )
          continue
        }
        for (const handler of registry.names()) {
          await enqueue(trx, orgId, job, {
            payload: { person, handler },
            subjectId: person,
            idempotencyKey: `${person}:${handler}`,
          })
        }
      }
    },
  }
}

// The registry the worker runs, with every handler of this version: none from C0.7, whose
// revocation registry closes a leaver's sockets. The consumer and job kind stay registered, for
// C2.2 onwards and for jobs queued before C0.7.
export function offboardingRegistry(): OffboardingRegistry {
  return new OffboardingRegistry()
}
