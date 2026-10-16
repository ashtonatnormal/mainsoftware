import { FLAGS, idsProblems, PURPOSES } from '@hearth/shared'
import { describe, expect, it, vi } from 'vitest'
import { type InOrg, withOrg } from '#src/db/database.ts'
import type { JobContext } from '#src/jobs/context.ts'
import { PermanentJobError } from '#src/jobs/errors.ts'
import type { Gate } from '#src/jobs/gate.ts'
import { validateRegistries } from '#src/jobs/kinds.ts'
import { backoffMs } from '#src/jobs/policy.ts'
import { ConsumerRunner } from '#src/outbox/consumers.ts'
import type { OutboxRow } from '#src/outbox/positions.ts'
import { AccessMessage } from '#src/revocation/channels.ts'
import {
  jobInput,
  REVOCATION_CAUSES,
  REVOCATION_HANDLERS,
  type RevocationHandler,
  RevocationPayload,
  RevocationRegistry,
  revocationConsumer,
  revocationJob,
  revocationOf,
  revocationOfPayload,
  revocationRegistry,
  socketsHandler,
  topicsHandler,
} from '#src/revocation/registry.ts'
import { captureLogger } from '#src/testing/logs.ts'
import { type Statement, scriptedPool, systemPrincipal } from '#src/testing/pool.ts'
import { productionRegistries, WORKER_GATE } from '#src/worker/index.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const PERSON = 'b0000000-0000-4000-8000-000000000001'
const OTHER = 'b0000000-0000-4000-8000-000000000002'
const ADMIN = 'b0000000-0000-4000-8000-000000000003'
const SYSTEM = 'c0000000-0000-4000-8000-000000000001'
const JOB = 'd0000000-0000-4000-8000-000000000009'
const S1 = 'e0000000-0000-4000-8000-000000000001'
const S2 = 'e0000000-0000-4000-8000-000000000002'
const S3 = 'e0000000-0000-4000-8000-000000000003'
const T1 = new Date('2026-10-16T01:00:00.250Z')
const T2 = new Date('2026-10-16T01:00:00.100Z')

const quiet = () => ({ warn: vi.fn(), error: vi.fn() })

// A valkey whose publishes are kept, as [channel, message].
function valkey() {
  const published: [string, string][] = []
  return {
    published,
    client: { publish: async (channel: string, message: string) => published.push([channel, message]) },
    messages: () => published.map(([, text]) => AccessMessage.parse(JSON.parse(text))),
  }
}

function event(id: number, type: OutboxRow['type'], ids: Record<string, unknown>, change: Partial<OutboxRow> = {}) {
  const row: OutboxRow = {
    id: String(id),
    txId: String(1000 + id),
    at: new Date(),
    type,
    version: 1,
    entity: { type: 'person', id: PERSON },
    container: null,
    acl: null,
    actor: { id: ADMIN, kind: 'human' },
    subjects: [PERSON],
    purpose: 'accounts',
    tombstone: false,
    ids,
    ...change,
  }
  return row
}
const ended = (id: number, sessions: string[], reason = 'deactivated', change: Partial<OutboxRow> = {}) =>
  event(id, 'signin.ended', { sessions, devices: [], reason }, change)
const keys = (id: number, subjects: string[], change: 'keys' | 'rows' = 'keys') =>
  event(id, 'acl.changed', { change, reason: 'deactivated' }, { subjects })

// Runs the production consumer's handle() over the events in one scripted round, as its role.
async function consume(events: OutboxRow[]) {
  const registry = revocationRegistry({ valkey: valkey().client, keyPrefix: 'it:unit:', logger: quiet() })
  const consumer = revocationConsumer(registry, revocationJob(registry))
  const p = scriptedPool(systemPrincipal(SYSTEM))
  const log = captureLogger()
  await withOrg(p.db, { orgId: ORG, system: true, as: 'hearth_job_revocation' }, (trx: InOrg) =>
    consumer.handle(trx, events, { orgId: ORG, log: log.logger }),
  )
  // id, org, kind, feature, purpose, subject, payload, key, attempts, run_after.
  const jobs = p.statements
    .filter(s => s.text.startsWith('insert into jobs'))
    .map(s => ({
      kind: s.values[2],
      subject: s.values[5],
      payload: JSON.parse(String(s.values[6])),
      key: s.values[7],
      attempts: s.values[8],
    }))
  return { jobs, log, p }
}

// A revocation.handler job's context, its reads as hearth_job_revocation on a scripted pool.
function jobContext(payload: RevocationPayload, answer: (statement: Statement) => unknown[] = () => []) {
  const p = scriptedPool(statement =>
    statement.text.includes("from principals where org_id = $1 and kind = 'system'")
      ? [{ id: SYSTEM }]
      : answer(statement),
  )
  const log = captureLogger()
  const ctx: JobContext<RevocationPayload> = {
    job: { id: JOB, orgId: ORG, kind: 'revocation.handler', attempt: 1, maxAttempts: 20, subjectId: null, payload },
    signal: new AbortController().signal,
    log: log.logger,
    step: () => {},
    read: work => withOrg(p.db, { orgId: ORG, system: true, as: 'hearth_job_revocation' }, work, { readOnly: true }),
    commit: () => Promise.reject(new Error('the handler made no commit here')),
  }
  return { p, ctx, log }
}

const isSessionsRead = (statement: Statement) => statement.text.startsWith('select id, revoked_at from sessions')

describe('C0.7 T19 item 3 REG-01 the revocation registry', () => {
  const handler = (name: string, causes: string[] = ['keys_changed']): RevocationHandler =>
    ({ name, causes, run: async () => {} }) as unknown as RevocationHandler

  it('lists its handlers and causes as codes, and registers sockets, then topics, in production', () => {
    expect(REVOCATION_HANDLERS).toEqual(['sockets', 'topics'])
    expect(REVOCATION_CAUSES).toEqual(['sessions_ended', 'keys_changed'])
    const registry = revocationRegistry({ valkey: valkey().client, keyPrefix: 'it:unit:', logger: quiet() })
    expect(registry.names()).toEqual(['sockets', 'topics'])
    expect(registry.handling('sessions_ended').map(h => h.name)).toEqual(['sockets'])
    expect(registry.handling('keys_changed').map(h => h.name)).toEqual(['topics'])
  })

  it('refuses an unlisted name, a duplicate, a handler with no causes, and an unknown cause', () => {
    const registry = new RevocationRegistry()
    expect(() => registry.register(handler('livekit'))).toThrow(/REVOCATION_HANDLERS/)
    registry.register(handler('topics'))
    expect(() => registry.register(handler('topics'))).toThrow(/already registered/)
    expect(() => registry.register(handler('sockets', []))).toThrow(/acts on no cause/)
    expect(() => registry.register(handler('sockets', ['rows_changed']))).toThrow(/unknown cause/)
    expect(registry.names()).toEqual(['topics'])
  })

  it('hands each cause to the handlers that act on it, in the order they registered', () => {
    const registry = new RevocationRegistry()
    registry.register(handler('topics', ['keys_changed', 'sessions_ended']))
    registry.register(handler('sockets', ['sessions_ended']))
    expect(registry.handling('sessions_ended').map(h => h.name)).toEqual(['topics', 'sockets'])
    expect(registry.handling('keys_changed').map(h => h.name)).toEqual(['topics'])
    expect(registry.get('sockets')?.name).toBe('sockets')
    expect(registry.get('livekit')).toBeUndefined()
  })
})

describe('C0.7 T19 item 4 REG-02 the revocation consumer: readable events', () => {
  it('runs as hearth_job_revocation under core.system, purpose accounts, protective, from now, for signin.ended and acl.changed', () => {
    const registry = new RevocationRegistry()
    expect(revocationConsumer(registry, revocationJob(registry))).toMatchObject({
      name: 'revocation',
      role: 'hearth_job_revocation',
      feature: 'core.system',
      purpose: 'accounts',
      protective: true,
      types: ['signin.ended', 'acl.changed'],
      start: 'now',
      lagBudgetMs: 10_000,
    })
  })

  it('queues one sockets job for a signin.ended with sessions, keyed by its first session, naming no subject', async () => {
    const { jobs } = await consume([ended(1, [S1, S2])])
    expect(jobs).toEqual([
      {
        kind: 'revocation.handler',
        subject: null,
        payload: { handler: 'sockets', cause: 'sessions_ended', person: PERSON, sessions: [S1, S2] },
        key: `sockets:${S1}`,
        attempts: 20,
      },
    ])
  })

  it('accepts any reason, a C0.16 one included, and queues nothing for a signin.ended with no session (debug)', async () => {
    const { jobs, log } = await consume([ended(2, [S3], 'phone_changed'), ended(3, [])])
    expect(jobs.map(job => job.key)).toEqual([`sockets:${S3}`])
    expect(log.events('revocation_event_passed')).toEqual([
      expect.objectContaining({ level: 20, eventId: '3', reason: 'no_sessions' }),
    ])
  })

  it('queues one topics job for an acl.changed keys, with no key and no subject, and passes over rows (debug)', async () => {
    const { jobs, log } = await consume([keys(4, [PERSON, OTHER]), keys(5, [PERSON], 'rows')])
    expect(jobs).toEqual([
      {
        kind: 'revocation.handler',
        subject: null,
        payload: { handler: 'topics', cause: 'keys_changed', people: [PERSON, OTHER] },
        key: null,
        attempts: 20,
      },
    ])
    expect(log.events('revocation_event_passed')).toEqual([
      expect.objectContaining({ level: 20, eventId: '5', reason: 'rows' }),
    ])
  })

  it('jobInput: keys a sessions job by handler and first session, a keys job not at all', () => {
    expect(jobInput('sockets', { cause: 'sessions_ended', person: PERSON, sessions: [S2, S1] })).toEqual({
      payload: { handler: 'sockets', cause: 'sessions_ended', person: PERSON, sessions: [S2, S1] },
      idempotencyKey: `sockets:${S2}`,
    })
    expect(jobInput('topics', { cause: 'keys_changed', people: [OTHER] })).toEqual({
      payload: { handler: 'topics', cause: 'keys_changed', people: [OTHER] },
    })
  })
})

describe('C0.7 T19 item 4 m4 the revocation consumer: unreadable events are passed over, never thrown', () => {
  const many = Array.from({ length: 101 }, (_, n) => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`)
  const unreadable: [string, OutboxRow][] = [
    ['a signin.ended with 101 sessions', ended(11, many)],
    ['a signin.ended with a session that is not a uuid', ended(12, ['not-a-session'])],
    ['a signin.ended with an upper-case session', ended(13, [S1.toUpperCase()])],
    [
      'a signin.ended whose entity is not a lower-case uuid',
      ended(14, [S1], 'deactivated', { entity: { type: 'person', id: PERSON.toUpperCase() } }),
    ],
    ['a signin.ended with no sessions field', event(15, 'signin.ended', { devices: [] })],
    ['an acl.changed with no change', event(16, 'acl.changed', { reason: 'deactivated' })],
    ['an acl.changed naming 101 people', keys(17, many)],
    ['an acl.changed naming an upper-case person', keys(18, [PERSON.toUpperCase()])],
    ['an event of a type it does not read', event(19, 'person.deactivated', {})],
  ]
  for (const [label, row] of unreadable) {
    it(`passes over ${label} with an error line by the event's id, and queues nothing`, async () => {
      const { jobs, log } = await consume([row])
      expect(jobs).toEqual([])
      expect(log.events('revocation_event_unreadable')).toEqual([
        expect.objectContaining({ level: 50, eventId: row.id, type: row.type }),
      ])
      // Its id, never its ids.
      expect(JSON.stringify(log.lines)).not.toContain(PERSON.slice(0, 8))
      expect(JSON.stringify(log.lines)).not.toContain('e0000000')
    })
  }

  it('passes over an acl.changed keys with no subjects at warn, and still queues the round’s readable events', async () => {
    const { jobs, log } = await consume([keys(21, []), ended(22, [S1])])
    expect(log.events('revocation_event_unreadable')).toEqual([expect.objectContaining({ level: 40, eventId: '21' })])
    expect(jobs.map(job => job.key)).toEqual([`sockets:${S1}`])
  })

  it('revocationOf reads leniently where later steps may add fields', () => {
    const log = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
    expect(revocationOf(event(23, 'signin.ended', { sessions: [S1], devices: [], reason: 'x', more: 1 }), log)).toEqual(
      {
        cause: 'sessions_ended',
        person: PERSON,
        sessions: [S1],
      },
    )
    expect(
      revocationOf(event(24, 'acl.changed', { change: 'keys', reason: 'team_left' }, { subjects: [OTHER] }), log),
    ).toEqual({ cause: 'keys_changed', people: [OTHER] })
    expect(log.error).not.toHaveBeenCalled()
  })
})

describe('C0.7 T19 item 4 the revocation.handler job', () => {
  it('holds its numbers: 20 attempts of at most 30 s, from 1 s doubling to 15 s, and logs revocation_handler_dead', () => {
    expect(revocationJob(new RevocationRegistry())).toMatchObject({
      kind: 'revocation.handler',
      feature: 'core.system',
      purpose: 'accounts',
      role: 'hearth_job_revocation',
      maxAttempts: 20,
      backoff: { baseMs: 1000, capMs: 15_000 },
      timeoutMs: 30_000,
      deadEvent: 'revocation_handler_dead',
    })
  })

  it('CR-02: its back-off makes at least 5 attempts within 60 s, with the jitter at either end', () => {
    const { backoff, maxAttempts } = revocationJob(new RevocationRegistry())
    for (const random of [() => 0, () => 1 - Number.EPSILON]) {
      let at = 0
      let attempts = 0
      for (let attempt = 1; attempt <= maxAttempts && at <= 60_000; attempt++) {
        attempts++
        at += backoffMs(attempt, backoff, random)
      }
      expect(attempts).toBeGreaterThanOrEqual(5)
    }
  })

  it('T15 item 8: its payload is ids only, and the production registries pass validateRegistries', () => {
    expect(idsProblems(RevocationPayload)).toEqual([])
    expect(() =>
      validateRegistries(productionRegistries({ valkey: valkey().client, keyPrefix: 'it:', logger: quiet() }), FLAGS),
    ).not.toThrow()
    expect(
      RevocationPayload.safeParse({ handler: 'sockets', cause: 'sessions_ended', person: PERSON.toUpperCase() })
        .success,
    ).toBe(false)
    expect(RevocationPayload.safeParse({ handler: 'livekit', cause: 'keys_changed', people: [PERSON] }).success).toBe(
      false,
    )
  })

  it('reads the payload’s shape: sessions_ended needs a person and sessions, keys_changed people alone', () => {
    expect(
      revocationOfPayload({ handler: 'sockets', cause: 'sessions_ended', person: PERSON, sessions: [S1] }),
    ).toEqual({ cause: 'sessions_ended', person: PERSON, sessions: [S1] })
    expect(revocationOfPayload({ handler: 'topics', cause: 'keys_changed', people: [PERSON] })).toEqual({
      cause: 'keys_changed',
      people: [PERSON],
    })
    for (const bad of [
      { handler: 'sockets', cause: 'sessions_ended', sessions: [S1] },
      { handler: 'sockets', cause: 'sessions_ended', person: PERSON, sessions: [] },
      { handler: 'sockets', cause: 'sessions_ended', person: PERSON, sessions: [S1], people: [PERSON] },
      { handler: 'topics', cause: 'keys_changed', people: [] },
      { handler: 'topics', cause: 'keys_changed', people: [PERSON], person: PERSON },
      { handler: 'topics', cause: 'keys_changed', people: [PERSON], sessions: [S1] },
    ] as RevocationPayload[]) {
      const error = (() => {
        try {
          revocationOfPayload(bad)
        } catch (e) {
          return e
        }
      })()
      expect(error, JSON.stringify(bad)).toBeInstanceOf(PermanentJobError)
      expect((error as PermanentJobError).code).toBe('payload_shape')
    }
  })

  it('finishes with a warning when its handler is no longer registered, and dies when the handler doesn’t act on the cause', async () => {
    const { ctx, log } = jobContext({ handler: 'topics', cause: 'keys_changed', people: [PERSON] })
    await revocationJob(new RevocationRegistry()).run(ctx)
    expect(log.events('revocation_handler_unregistered')).toEqual([
      expect.objectContaining({ level: 40, handler: 'topics' }),
    ])
    const registry = new RevocationRegistry()
    const run = vi.fn(async () => {})
    registry.register({ name: 'topics', causes: ['sessions_ended'], run })
    const error = await revocationJob(registry)
      .run(ctx)
      .catch(e => e)
    expect(error).toBeInstanceOf(PermanentJobError)
    expect(error.code).toBe('cause_not_handled')
    expect(run).not.toHaveBeenCalled()
  })

  it('runs the named handler with the revocation and the job’s org', async () => {
    const registry = new RevocationRegistry()
    const run = vi.fn(async () => {})
    registry.register({ name: 'sockets', causes: ['sessions_ended'], run })
    const { ctx } = jobContext({ handler: 'sockets', cause: 'sessions_ended', person: PERSON, sessions: [S1] })
    await revocationJob(registry).run(ctx)
    expect(run).toHaveBeenCalledWith({ cause: 'sessions_ended', person: PERSON, sessions: [S1] }, { orgId: ORG }, ctx)
  })
})

describe('C0.7 T19 items 4 and 5 the sockets handler', () => {
  const revocation = { cause: 'sessions_ended', person: PERSON, sessions: [S1, S2, S3] } as const
  const payload: RevocationPayload = { handler: 'sockets', ...revocation, sessions: [...revocation.sessions] }

  it('re-reads which sessions ended, and when, as its role, and publishes them durable with the earliest revoked_at', async () => {
    const v = valkey()
    const { p, ctx } = jobContext(payload, s =>
      isSessionsRead(s)
        ? [
            { id: S1, revoked_at: T1 },
            { id: S2, revoked_at: T2 },
            { id: S3, revoked_at: T1 },
          ]
        : [],
    )
    await socketsHandler({ valkey: v.client, keyPrefix: 'it:unit:', logger: quiet() }).run(
      revocation,
      { orgId: ORG },
      ctx,
    )
    const read = p.statements.find(isSessionsRead)
    expect(read?.text).toBe(
      'select id, revoked_at from sessions where org_id = $1 and user_id = $2 and id = any($3::uuid[]) and revoked_at is not null',
    )
    expect(read?.values).toEqual([ORG, PERSON, [S1, S2, S3]])
    expect(p.texts()[0]).toBe('start transaction isolation level read committed read only')
    expect(p.statements.find(s => s.text.startsWith("select set_config('role'"))?.values[0]).toBe(
      'hearth_job_revocation',
    )
    expect(v.published.map(([channel]) => channel)).toEqual(['it:unit:access'])
    expect(v.messages()).toEqual([
      { v: 1, org: ORG, path: 'durable', cause: 'sessions_ended', at: T2.getTime(), sessions: [S1, S2, S3] },
    ])
  })

  it('dies (not_ended) when none has ended, logging the count at error level and no id', async () => {
    const v = valkey()
    const { ctx, log } = jobContext(payload)
    const error = await socketsHandler({ valkey: v.client, keyPrefix: 'it:unit:', logger: quiet() })
      .run(revocation, { orgId: ORG }, ctx)
      .catch(e => e)
    expect(error).toBeInstanceOf(PermanentJobError)
    expect(error.code).toBe('not_ended')
    expect(v.published).toEqual([])
    expect(log.events('revocation_not_ended')).toEqual([expect.objectContaining({ level: 50, sessions: 3 })])
    expect(JSON.stringify(log.lines)).not.toContain('e0000000')
    expect(JSON.stringify(log.lines)).not.toContain(PERSON)
  })

  it('publishes those that have ended when only some have, and logs how many have not', async () => {
    const v = valkey()
    const { ctx, log } = jobContext(payload, s => (isSessionsRead(s) ? [{ id: S2, revoked_at: T1 }] : []))
    await socketsHandler({ valkey: v.client, keyPrefix: 'it:unit:', logger: quiet() }).run(
      revocation,
      { orgId: ORG },
      ctx,
    )
    expect(v.messages()).toEqual([
      { v: 1, org: ORG, path: 'durable', cause: 'sessions_ended', at: T1.getTime(), sessions: [S2] },
    ])
    expect(log.events('revocation_not_ended')).toEqual([expect.objectContaining({ level: 50, sessions: 2, ended: 1 })])
  })

  it('OUTBOX-2: fails when the publish fails, so the job is tried again', async () => {
    const failure = new Error('Connection is closed.')
    const logger = quiet()
    const { ctx } = jobContext(payload, s => (isSessionsRead(s) ? [{ id: S1, revoked_at: T1 }] : []))
    await expect(
      socketsHandler({ valkey: { publish: vi.fn().mockRejectedValue(failure) }, keyPrefix: 'it:unit:', logger }).run(
        revocation,
        { orgId: ORG },
        ctx,
      ),
    ).rejects.toBe(failure)
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'revocation_publish_failed' }))
  })
})

describe('C0.7 T19 items 4 and 5 the topics handler', () => {
  it('publishes the people, durable, with no start time and no read', async () => {
    const v = valkey()
    const { p, ctx } = jobContext({ handler: 'topics', cause: 'keys_changed', people: [PERSON, OTHER] })
    await topicsHandler({ valkey: v.client, keyPrefix: 'it:unit:', logger: quiet() }).run(
      { cause: 'keys_changed', people: [PERSON, OTHER] },
      { orgId: ORG },
      ctx,
    )
    expect(p.statements).toEqual([])
    expect(v.messages()).toEqual([{ v: 1, org: ORG, path: 'durable', cause: 'keys_changed', people: [PERSON, OTHER] }])
  })
})

describe('C0.7 OD-39 S8 PDPA-04: no processing switch holds back a revocation', () => {
  it('the consumer is protective; core.system is locked on by default; accounts needs no consent; the worker’s default gate allows it', () => {
    const registry = new RevocationRegistry()
    expect(revocationConsumer(registry, revocationJob(registry)).protective).toBe(true)
    expect(FLAGS['core.system']).toMatchObject({ default: true, locked: true, class: 'essential' })
    expect(FLAGS['core.system'].purposes).toContain('accounts')
    expect(PURPOSES.accounts.consent).toBe(false)
    expect(WORKER_GATE.purposeAllowed(ORG, 'accounts')).toBe(true)
  })

  it('a gate that refuses every subject’s switch withholds none of its events: the round still queues the jobs', async () => {
    const registry = revocationRegistry({ valkey: valkey().client, keyPrefix: 'it:unit:', logger: quiet() })
    const consumer = revocationConsumer(registry, revocationJob(registry))
    const row = (id: number, type: string, ids: Record<string, unknown>) => ({
      floor_tx: null,
      floor_id: null,
      fell_behind: false,
      id: String(id),
      tx_id: String(1000 + id),
      at: new Date(),
      type,
      version: 1,
      entity_type: 'person',
      entity_id: PERSON,
      container_type: null,
      container_id: null,
      acl_tokens: null,
      acl_more: null,
      index_class: null,
      acl_epoch: null,
      actor_id: ADMIN,
      actor_kind: 'human',
      subject_ids: [PERSON],
      purpose: 'accounts',
      tombstone: false,
      ids,
    })
    const p = scriptedPool(statement => {
      const { text } = statement
      if (text.includes("from principals where org_id = $1 and kind = 'system'")) return [{ id: SYSTEM }]
      if (text.startsWith('select greatest(')) return [{ future: false }]
      if (text.startsWith('select pg_try_advisory_xact_lock')) return [{ locked: true }]
      if (text.startsWith('select last_tx, last_id from outbox_checkpoints')) return [{ last_tx: '900', last_id: '7' }]
      if (text.startsWith('with f as')) {
        return [
          row(8, 'signin.ended', { sessions: [S1], devices: [], reason: 'deactivated' }),
          row(9, 'acl.changed', { change: 'keys', reason: 'deactivated' }),
        ]
      }
      return []
    })
    const refusing: Gate = { ...WORKER_GATE, processingAllowed: () => false }
    const log = captureLogger()
    const runner = new ConsumerRunner({
      db: p.db,
      consumers: [consumer],
      flags: { isOn: () => true, revisionsOf: () => [1], reload: async () => {} },
      gate: refusing,
      logger: log.logger,
    })
    expect(await runner.round(consumer, ORG)).toBe('idle')
    expect(log.events('outbox_event_withheld')).toEqual([])
    const kinds = p.statements
      .filter(s => s.text.startsWith('insert into jobs'))
      .map(s => JSON.parse(String(s.values[6])))
    expect(kinds.map(payload => payload.handler)).toEqual(['sockets', 'topics'])
  })
})
