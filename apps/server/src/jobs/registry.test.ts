import { FLAGS, type FlagSpec } from '@hearth/shared'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineJob, type JobKind, type Registries, validateRegistries } from '#src/jobs/kinds.ts'
import { MAINTENANCE_KINDS, partitionsJob, purgeJob, SCHEDULES } from '#src/jobs/maintenance.ts'
import { DEFAULT_BACKOFF, DEFAULT_MAX_ATTEMPTS, DEFAULT_TIMEOUT_MS } from '#src/jobs/policy.ts'
import { OFFBOARDING_HANDLERS, OffboardingPayload } from '#src/offboarding.ts'
import type { OutboxConsumer } from '#src/outbox/consumers.ts'
import { productionRegistries } from '#src/worker/index.ts'

const registry: Readonly<Record<string, FlagSpec>> = {
  ...FLAGS,
  'it.optional': { ...FLAGS['core.system'], class: 'optional', locked: false, purposes: ['service_operation'] },
}

const kind = (change: Partial<JobKind> = {}): JobKind =>
  defineJob({
    kind: 'it.work',
    feature: 'it.optional',
    purpose: 'service_operation',
    role: 'hearth_job_offboarding',
    payload: z.strictObject({ person: z.uuid().optional() }),
    run: async () => {},
    ...change,
  })

const consumer = (change: Partial<OutboxConsumer> = {}): OutboxConsumer => ({
  name: 'it_consumer',
  role: 'hearth_job_offboarding',
  feature: 'core.system',
  purpose: 'accounts',
  types: ['person.deactivated'],
  start: 'oldest',
  lagBudgetMs: 1000,
  handle: async () => {},
  ...change,
})

const valid = (): Registries => ({
  kinds: [kind()],
  schedules: [{ key: 'it.work', kind: 'it.work', cron: '0 * * * *', onInterrupt: 'rerun' }],
  consumers: [consumer()],
})

function problemsOf(registries: Registries): string {
  try {
    validateRegistries(registries, registry)
  } catch (error) {
    return (error as Error).message
  }
  return ''
}

const quiet = { valkey: { publish: async () => 0 }, keyPrefix: 'it:unit:', logger: { warn: () => {}, error: () => {} } }

describe('C0.6 T15 the job registries', () => {
  it('passes the production registries: maintenance, offboarding and the two schedules', () => {
    const production = productionRegistries(quiet)
    expect(() => validateRegistries(production, FLAGS)).not.toThrow()
    expect(production.kinds.map(k => k.kind)).toEqual([
      'maintenance.data_access_partitions',
      'maintenance.purge',
      'offboarding.handler',
    ])
    expect(production.consumers.map(c => c.name)).toEqual(['offboarding'])
    expect(production.schedules).toBe(SCHEDULES)
  })

  it('C0.6 T15 items 16 and 17: the maintenance kinds and their schedules hold TECH-SPEC’s numbers', () => {
    expect(MAINTENANCE_KINDS).toEqual([partitionsJob, purgeJob])
    expect(partitionsJob).toMatchObject({
      feature: 'core.system',
      purpose: 'service_operation',
      role: 'hearth_job_partitions',
      maxAttempts: 20,
      backoff: { baseMs: 30_000, capMs: 600_000 },
      timeoutMs: 30_000,
    })
    expect(partitionsJob.idempotentCommits).toBeUndefined()
    expect(purgeJob).toMatchObject({
      feature: 'core.system',
      purpose: 'service_operation',
      role: 'hearth_job_purge',
      maxAttempts: 5,
      backoff: { baseMs: 60_000, capMs: 600_000 },
      timeoutMs: 300_000,
      idempotentCommits: true,
    })
    expect(SCHEDULES).toEqual([
      { key: 'maintenance.data_access_partitions', kind: partitionsJob.kind, cron: '17 3 * * *', onInterrupt: 'rerun' },
      { key: 'maintenance.purge', kind: purgeJob.kind, cron: '47 3 * * *', onInterrupt: 'rerun' },
    ])
  })

  it('fills a kind’s defaults: 5 attempts, 5 s doubling to 10 minutes, 5 minutes an attempt (T15 item 4)', () => {
    expect(kind()).toMatchObject({
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      backoff: DEFAULT_BACKOFF,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    })
    expect([DEFAULT_MAX_ATTEMPTS, DEFAULT_BACKOFF, DEFAULT_TIMEOUT_MS]).toEqual([
      5,
      { baseMs: 5000, capMs: 600_000 },
      300_000,
    ])
  })

  it('accepts a valid test registry', () => {
    expect(problemsOf(valid())).toBe('')
  })

  it('refuses, until A0, any kind or consumer with an AI purpose or a feature under ai. (D41)', () => {
    const aiRegistry = { ...registry, 'it.ai': { ...registry['it.optional'], purposes: ['org_brain'] } } as Record<
      string,
      FlagSpec
    >
    const message = (() => {
      try {
        validateRegistries(
          { ...valid(), kinds: [kind({ feature: 'it.ai', purpose: 'org_brain' })], consumers: [] },
          aiRegistry,
        )
      } catch (error) {
        return (error as Error).message
      }
      return ''
    })()
    expect(message).toMatch(/AI flag or purpose until A0/)
    expect(problemsOf({ ...valid(), kinds: [kind({ feature: 'ai.ask', purpose: 'org_brain' })] })).toMatch(
      /AI flag or purpose until A0/,
    )
    expect(problemsOf({ ...valid(), consumers: [consumer({ feature: 'ai.brain', purpose: 'org_brain' })] })).toMatch(
      /outbox consumer it_consumer: nothing may serve an AI flag or purpose/,
    )
  })

  it('refuses a kind whose flag, purpose, role or providers aren’t registered, or whose purpose isn’t its flag’s', () => {
    expect(problemsOf({ ...valid(), kinds: [kind({ feature: 'it.nothing' })] })).toMatch(/not a registered flag/)
    expect(problemsOf({ ...valid(), kinds: [kind({ purpose: 'accounts' })] })).toMatch(/not one of it.optional's/)
    expect(problemsOf({ ...valid(), kinds: [kind({ purpose: 'made_up' as never })] })).toMatch(/not a purpose/)
    expect(problemsOf({ ...valid(), kinds: [kind({ role: 'hearth_queue' })] })).toMatch(/not a role that runs jobs/)
    expect(problemsOf({ ...valid(), kinds: [kind({ role: 'hearth_app' as never })] })).toMatch(
      /not a role that runs jobs/,
    )
    expect(problemsOf({ ...valid(), kinds: [kind({ providers: ['carrier_pigeon' as never] })] })).toMatch(
      /not a provider/,
    )
  })

  it('refuses a kind with a bad name, a second kind of one name, bad numbers, or a payload that isn’t ids only', () => {
    expect(problemsOf({ ...valid(), kinds: [kind({ kind: 'Work' })] })).toMatch(/dotted lower case/)
    expect(problemsOf({ ...valid(), kinds: [kind({ kind: 'work' })] })).toMatch(/dotted lower case/)
    expect(problemsOf({ ...valid(), kinds: [kind(), kind()] })).toMatch(/two job kinds have this name/)
    expect(problemsOf({ ...valid(), kinds: [kind({ maxAttempts: 0 })] })).toMatch(/maxAttempts is 1 to 100/)
    expect(problemsOf({ ...valid(), kinds: [kind({ maxAttempts: 101 })] })).toMatch(/maxAttempts is 1 to 100/)
    expect(problemsOf({ ...valid(), kinds: [kind({ backoff: { baseMs: 10, capMs: 5 } })] })).toMatch(/back-off/)
    expect(problemsOf({ ...valid(), kinds: [kind({ timeoutMs: 0 })] })).toMatch(/timeoutMs/)
    for (const payload of [
      z.strictObject({ note: z.string() }),
      z.strictObject({ count: z.int() }),
      z.strictObject({ nested: z.strictObject({ id: z.uuid() }) }),
      z.object({ id: z.uuid() }),
    ]) {
      expect(problemsOf({ ...valid(), kinds: [kind({ payload: payload as never })] })).toMatch(/must hold ids only/)
    }
  })

  it('refuses a schedule with a bad or repeated key, an unknown kind, a cron that can’t fire, or a payload its kind refuses', () => {
    const schedule = valid().schedules[0] as { key: string; kind: string; cron: string; onInterrupt: 'rerun' }
    const with_ = (change: object) => ({ ...valid(), schedules: [{ ...schedule, ...change }] })
    expect(problemsOf(with_({ key: 'It Work' }))).toMatch(/a key is dotted lower case/)
    expect(problemsOf({ ...valid(), schedules: [schedule, { key: schedule.key, retired: true }] })).toMatch(
      /two schedules have this key/,
    )
    expect(problemsOf(with_({ kind: 'it.unknown' }))).toMatch(/not a registered job kind/)
    expect(problemsOf(with_({ cron: '0 0 31 2 *' }))).toMatch(/never matches/)
    expect(problemsOf(with_({ cron: 'every day' }))).toMatch(/cron:/)
    expect(problemsOf(with_({ payload: { person: 'Ann' } }))).toMatch(/payload is not one its kind accepts/)
    // A retired key needs only its key.
    expect(problemsOf({ ...valid(), schedules: [schedule, { key: 'it.old', retired: true }] })).toBe('')
  })

  it('refuses a consumer with a bad or repeated name, a role that can’t move a checkpoint, unknown types or bad numbers', () => {
    expect(problemsOf({ ...valid(), consumers: [consumer({ name: 'It Consumer' })] })).toMatch(
      /a consumer name is a code/,
    )
    expect(problemsOf({ ...valid(), consumers: [consumer(), consumer()] })).toMatch(/two consumers have this name/)
    expect(problemsOf({ ...valid(), consumers: [consumer({ role: 'hearth_job_purge' })] })).toMatch(
      /can't move a checkpoint/,
    )
    expect(problemsOf({ ...valid(), consumers: [consumer({ types: ['person.left' as never] })] })).toMatch(
      /not an event type/,
    )
    expect(problemsOf({ ...valid(), consumers: [consumer({ batch: 0 })] })).toMatch(/a batch is 1 to 10,000/)
    expect(problemsOf({ ...valid(), consumers: [consumer({ lagBudgetMs: 0 })] })).toMatch(/lagBudgetMs/)
    expect(
      problemsOf({ ...valid(), consumers: [consumer({ purpose: 'service_operation', feature: 'it.nothing' })] }),
    ).toMatch(/not a registered flag/)
  })

  it('C0.7 T19: hearth_job_revocation (0008) may run jobs and move a checkpoint, as its grants allow', () => {
    expect(problemsOf({ ...valid(), kinds: [kind({ role: 'hearth_job_revocation' })] })).toBe('')
    expect(problemsOf({ ...valid(), consumers: [consumer({ role: 'hearth_job_revocation' })] })).toBe('')
  })

  it('names every problem at once', () => {
    const message = problemsOf({
      kinds: [kind({ maxAttempts: 0 }), kind({ kind: 'it.other', feature: 'it.nothing' })],
      schedules: [],
      consumers: [consumer({ lagBudgetMs: 0 })],
    })
    expect(message.split('\n').filter(line => line.startsWith('  '))).toHaveLength(3)
  })

  it('C0.6 T16 item 9: the offboarding payload names a person and a listed handler, ids only', () => {
    expect(OFFBOARDING_HANDLERS).toEqual(['sockets'])
    expect(
      OffboardingPayload.safeParse({ person: 'b0000000-0000-4000-8000-000000000001', handler: 'sockets' }).success,
    ).toBe(true)
    expect(
      OffboardingPayload.safeParse({ person: 'b0000000-0000-4000-8000-000000000001', handler: 'drive' }).success,
    ).toBe(false)
  })
})
