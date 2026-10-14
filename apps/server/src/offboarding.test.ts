import { describe, expect, it, vi } from 'vitest'
import { type InOrg, withOrg } from '#src/db/database.ts'
import type { JobContext } from '#src/jobs/context.ts'
import { PermanentJobError } from '#src/jobs/errors.ts'
import {
  type OffboardingHandler,
  type OffboardingPayload,
  OffboardingRegistry,
  offboardingConsumer,
  offboardingJob,
  offboardingRegistry,
  socketsHandler,
} from '#src/offboarding.ts'
import type { OutboxRow } from '#src/outbox/positions.ts'
import { captureLogger } from '#src/testing/logs.ts'
import { type Statement, scriptedPool, systemPrincipal } from '#src/testing/pool.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const PERSON = 'b0000000-0000-4000-8000-000000000001'
const ADMIN = 'b0000000-0000-4000-8000-000000000002'
const SYSTEM = 'c0000000-0000-4000-8000-000000000001'
const JOB = 'd0000000-0000-4000-8000-000000000009'
const SESSIONS = ['d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002']

const logger = () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() })

// A job's context whose reads run as hearth_job_offboarding on a scripted pool.
function jobContext(
  answer: (statement: Statement) => unknown[],
  payload: OffboardingPayload = { person: PERSON, handler: 'sockets' },
) {
  const p = scriptedPool(statement =>
    statement.text.includes("from principals where org_id = $1 and kind = 'system'")
      ? [{ id: SYSTEM }]
      : answer(statement),
  )
  const log = captureLogger()
  const ctx: JobContext<OffboardingPayload> = {
    job: { id: JOB, orgId: ORG, kind: 'offboarding.handler', attempt: 1, maxAttempts: 10, subjectId: PERSON, payload },
    signal: new AbortController().signal,
    log: log.logger,
    step: () => {},
    read: work => withOrg(p.db, { orgId: ORG, system: true, as: 'hearth_job_offboarding' }, work, { readOnly: true }),
    commit: () => Promise.reject(new Error('the handler made no commit here')),
  }
  return { p, ctx, log }
}

function event(id: number, person = PERSON): OutboxRow {
  return {
    id: String(id),
    txId: String(1000 + id),
    at: new Date(),
    type: 'person.deactivated',
    version: 1,
    entity: { type: 'person', id: person },
    container: null,
    acl: null,
    actor: { id: ADMIN, kind: 'human' },
    subjects: [person],
    purpose: 'accounts',
    tombstone: false,
    ids: {},
  }
}

describe('C0.5 ACC-05 the offboarding registry (the seam A2, A4, C2.2, C4.1 and C4.3 register on)', () => {
  it('keeps handlers by name, in the order they registered, and refuses a second of one name', () => {
    const registry = new OffboardingRegistry()
    const sockets: OffboardingHandler = { name: 'sockets', run: async () => {} }
    registry.register(sockets)
    expect(registry.get('sockets')).toBe(sockets)
    expect(registry.get('drive')).toBeUndefined()
    expect(registry.names()).toEqual(['sockets'])
    expect(() => registry.register(sockets)).toThrow(/already registered/)
  })

  it('refuses a handler whose name isn’t listed, since a job’s payload names it as a code', () => {
    const registry = new OffboardingRegistry()
    expect(() => registry.register({ name: 'Drive files' as never, run: async () => {} })).toThrow(
      /OFFBOARDING_HANDLERS/,
    )
  })

  it('the worker’s registry holds this version’s handlers', () => {
    expect(offboardingRegistry({ valkey: { publish: vi.fn() }, keyPrefix: 'it:', logger: logger() }).names()).toEqual([
      'sockets',
    ])
  })
})

describe('C0.6 T16 item 9 the offboarding consumer: the event is a claim, the row is the proof', () => {
  const registry = () => offboardingRegistry({ valkey: { publish: vi.fn() }, keyPrefix: 'it:', logger: logger() })

  it('queues one offboarding.handler job per handler for a person who has left, keyed by person and handler', async () => {
    const reg = registry()
    const p = scriptedPool(statement =>
      statement.text.startsWith('select id from people') ? [{ id: PERSON }] : systemPrincipal(SYSTEM)(statement),
    )
    const consumer = offboardingConsumer(reg, offboardingJob(reg))
    expect(consumer).toMatchObject({
      name: 'offboarding',
      role: 'hearth_job_offboarding',
      feature: 'core.system',
      purpose: 'accounts',
      types: ['person.deactivated'],
      start: 'oldest',
      lagBudgetMs: 10_000,
    })
    const log = captureLogger()
    await withOrg(p.db, { orgId: ORG, system: true, as: 'hearth_job_offboarding' }, (trx: InOrg) =>
      consumer.handle(trx, [event(7)], { orgId: ORG, log: log.logger }),
    )
    const read = p.statements.find(s => s.text.startsWith('select id from people'))
    expect(read?.text).toContain('and deactivated_at is not null')
    expect(read?.values).toEqual([ORG, PERSON])
    const inserts = p.statements.filter(s => s.text.startsWith('insert into jobs'))
    expect(inserts).toHaveLength(1)
    // id, org, kind, feature, purpose, subject, payload, key, attempts, run_after.
    expect(inserts[0]?.values.slice(1)).toEqual([
      ORG,
      'offboarding.handler',
      'core.system',
      'accounts',
      PERSON,
      JSON.stringify({ person: PERSON, handler: 'sockets' }),
      `${PERSON}:sockets`,
      10,
      null,
    ])
    expect(inserts[0]?.text).toContain('on conflict do nothing')
    // A producer may not name a schedule run.
    expect(inserts[0]?.text).not.toContain('schedule_run_id')
  })

  it('queues nothing for a person still at the org, and logs it at error level by the event’s id', async () => {
    const reg = registry()
    const p = scriptedPool(systemPrincipal(SYSTEM))
    const consumer = offboardingConsumer(reg, offboardingJob(reg))
    const log = captureLogger()
    await withOrg(p.db, { orgId: ORG, system: true, as: 'hearth_job_offboarding' }, (trx: InOrg) =>
      consumer.handle(trx, [event(8)], { orgId: ORG, log: log.logger }),
    )
    expect(p.statements.filter(s => s.text.startsWith('insert into jobs'))).toEqual([])
    expect(log.events('offboarding_not_deactivated')).toEqual([expect.objectContaining({ level: 50, eventId: '8' })])
    expect(JSON.stringify(log.lines)).not.toContain(PERSON)
  })
})

describe('C0.6 T16 item 9 the offboarding.handler job', () => {
  it('holds the design’s numbers and logs offboarding_handler_dead when it goes dead', () => {
    const job = offboardingJob(new OffboardingRegistry())
    expect(job).toMatchObject({
      kind: 'offboarding.handler',
      feature: 'core.system',
      purpose: 'accounts',
      role: 'hearth_job_offboarding',
      maxAttempts: 10,
      backoff: { baseMs: 5000, capMs: 600_000 },
      timeoutMs: 60_000,
      deadEvent: 'offboarding_handler_dead',
    })
  })

  it('reads the person again and runs the handler with who deactivated them from the row, never the payload', async () => {
    const registry = new OffboardingRegistry()
    const run = vi.fn(async () => {})
    registry.register({ name: 'sockets', run })
    const { p, ctx } = jobContext(s =>
      s.text.startsWith('select deactivated_by from people') ? [{ deactivated_by: ADMIN }] : [],
    )
    await offboardingJob(registry).run(ctx)
    const read = p.statements.find(s => s.text.startsWith('select deactivated_by from people'))
    expect(read?.text).toContain('and deactivated_at is not null')
    expect(read?.values).toEqual([ORG, PERSON])
    expect(p.texts()[0]).toBe('start transaction isolation level read committed read only')
    expect(run).toHaveBeenCalledWith({ orgId: ORG, personId: PERSON, actorId: ADMIN }, ctx)
  })

  it('goes dead (not_deactivated) for someone still at the org, and runs nothing', async () => {
    const registry = new OffboardingRegistry()
    const run = vi.fn(async () => {})
    registry.register({ name: 'sockets', run })
    const { ctx } = jobContext(() => [])
    const error = await offboardingJob(registry)
      .run(ctx)
      .catch(e => e)
    expect(error).toBeInstanceOf(PermanentJobError)
    expect(error.code).toBe('not_deactivated')
    expect(run).not.toHaveBeenCalled()
  })

  it('finishes with a warning when its handler is no longer registered', async () => {
    const { ctx, log } = jobContext(s =>
      s.text.startsWith('select deactivated_by from people') ? [{ deactivated_by: ADMIN }] : [],
    )
    await offboardingJob(new OffboardingRegistry()).run(ctx)
    expect(log.events('offboarding_handler_unregistered')).toEqual([expect.objectContaining({ handler: 'sockets' })])
  })
})

describe('C0.5 T5 ACC-05 the sockets handler', () => {
  it('publishes the sessions the deactivation ended, read through the job as its role', async () => {
    const { p, ctx } = jobContext(s => (s.text.includes('from "sessions"') ? SESSIONS.map(id => ({ id })) : []))
    const published: [string, string][] = []
    const valkey = { publish: async (channel: string, message: string) => published.push([channel, message]) }
    await socketsHandler({ valkey, keyPrefix: 'it:unit:', logger: logger() }).run(
      { orgId: ORG, personId: PERSON, actorId: ADMIN },
      ctx,
    )
    expect(p.texts()).toContain(
      'select "id" from "sessions" where "org_id" = $1 and "user_id" = $2 and "revoke_reason" = $3',
    )
    expect(p.statements.find(s => s.text.includes('from "sessions"'))?.values).toEqual([ORG, PERSON, 'deactivated'])
    expect(p.statements.find(s => s.text.startsWith("select set_config('role'"))?.values[0]).toBe(
      'hearth_job_offboarding',
    )
    expect(published).toHaveLength(1)
    const [channel, message] = published[0] ?? []
    expect(channel).toBe('it:unit:revoked')
    expect(JSON.parse(message ?? '')).toEqual({ v: 1, at: expect.any(Number), sessions: SESSIONS })
  })

  it('publishes nothing when the deactivation ended no session, so it can run again safely', async () => {
    const { ctx } = jobContext(() => [])
    const valkey = { publish: vi.fn() }
    await socketsHandler({ valkey, keyPrefix: 'it:unit:', logger: logger() }).run(
      { orgId: ORG, personId: PERSON, actorId: ADMIN },
      ctx,
    )
    expect(valkey.publish).not.toHaveBeenCalled()
  })
})
