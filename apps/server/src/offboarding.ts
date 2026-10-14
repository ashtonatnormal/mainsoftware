// What happens when someone leaves (ACC-05), after their deactivation has committed. The
// deactivation itself ends their sessions and signs their devices out in the same transaction
// (0006, people_end_sessions); everything else a leaver's departure touches registers a handler
// here, so the admin service needn't know them all. C0.5 has one, which closes the leaver's live
// sockets; later steps add theirs (A2 the index, A4 their agents and assistant, C2.2 their rooms,
// C4.1 and C4.3 their Drive items). From C0.6 the api no longer runs the registry after the commit:
// the deactivation appends person.deactivated to the outbox in its own transaction, and publishes
// the sessions it ended itself, so sockets close as fast as before; the worker's offboarding
// consumer reads the event and runs these handlers durably, with retries (TECH-SPEC T16).
import type { Redis } from 'ioredis'
import type { Logger } from 'pino'
import { type Database, withOrg } from '#src/db/database.ts'
import { publishRevoked } from '#src/revocation.ts'

export interface OffboardingContext {
  orgId: string
  personId: string
  // The admin who deactivated them.
  actorId: string
}

// Each handler must be idempotent: the registry may run it again (C0.6 retries through the
// outbox, and BUILD-PLAN's offboarding test re-runs every handler as more register). So a handler
// works from the context alone, never from what an earlier run left behind.
export interface OffboardingHandler {
  name: string
  run(context: OffboardingContext): Promise<void>
}

// Each handler gets at most this long, so one that hangs can't hold the admin's reply.
export const HANDLER_TIMEOUT_MS = 5000

export class OffboardingRegistry {
  readonly #handlers: OffboardingHandler[] = []
  readonly #logger: Pick<Logger, 'info' | 'error'>

  constructor(logger: Pick<Logger, 'info' | 'error'>) {
    this.#logger = logger
  }

  register(handler: OffboardingHandler): void {
    if (this.#handlers.some(h => h.name === handler.name)) {
      throw new Error(`an offboarding handler named ${handler.name} is already registered`)
    }
    this.#handlers.push(handler)
  }

  // Runs every handler in the order they registered. A failure, or a handler still running after
  // HANDLER_TIMEOUT_MS, is logged and reported, and the rest still run.
  async run(context: OffboardingContext): Promise<Array<{ name: string; ok: boolean }>> {
    const results: Array<{ name: string; ok: boolean }> = []
    for (const handler of this.#handlers) {
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<'timed out'>(resolve => {
        timer = setTimeout(() => resolve('timed out'), HANDLER_TIMEOUT_MS)
      })
      try {
        const outcome = await Promise.race([handler.run(context).then(() => 'done' as const), timeout])
        if (outcome === 'timed out') {
          this.#logger.error({
            event: 'offboarding_handler_timed_out',
            handler: handler.name,
            personId: context.personId,
          })
          results.push({ name: handler.name, ok: false })
        } else {
          this.#logger.info({ event: 'offboarding_handler_done', handler: handler.name, personId: context.personId })
          results.push({ name: handler.name, ok: true })
        }
      } catch (error) {
        this.#logger.error({
          event: 'offboarding_handler_failed',
          handler: handler.name,
          personId: context.personId,
          err: error,
        })
        results.push({ name: handler.name, ok: false })
      } finally {
        clearTimeout(timer)
      }
    }
    return results
  }
}

// C0.5's one handler: tells the realtime role to close the leaver's sockets (T5's 60 s). It reads
// the sessions their deactivation ended, so it can run again from the context alone. It acts as
// the org's system principal: the admin's session has nothing to do with this work.
export function socketsHandler(deps: {
  db: Database
  valkey: Pick<Redis, 'publish'>
  keyPrefix: string
  logger: Pick<Logger, 'warn' | 'error'>
}): OffboardingHandler {
  return {
    name: 'sockets',
    async run({ orgId, personId }) {
      const rows = await withOrg(deps.db, { orgId, system: true }, trx =>
        trx
          .selectFrom('sessions')
          .select('id')
          .where('org_id', '=', orgId)
          .where('user_id', '=', personId)
          .where('revoke_reason', '=', 'deactivated')
          .execute(),
      )
      await publishRevoked(
        deps.valkey,
        deps.keyPrefix,
        rows.map(row => row.id),
        deps.logger,
      )
    },
  }
}
