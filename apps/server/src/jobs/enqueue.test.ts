// enqueue()'s refusals before any SQL (TECH-SPEC T15 items 7 and 8): a key made of anything but ids
// and codes never reaches the jobs table, whose CHECK refuses the same (0007, DB test 120).
import { randomUUID } from 'node:crypto'
import {
  type CompiledQuery,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { InOrg } from '#src/db/database.ts'
import { EnqueueRefused, enqueue, IDEMPOTENCY_KEY } from '#src/jobs/enqueue.ts'
import { defineJob } from '#src/jobs/kinds.ts'

// A transaction that records each statement and answers none.
function recording(): { trx: InOrg; sent: CompiledQuery[] } {
  const sent: CompiledQuery[] = []
  class Recording extends DummyDriver {
    override async acquireConnection() {
      return {
        executeQuery: async (query: CompiledQuery) => {
          sent.push(query)
          return { rows: [] }
        },
        // biome-ignore lint/correctness/useYield: a connection that never streams
        streamQuery: async function* () {
          throw new Error('not streamed')
        },
      }
    }
  }
  const db = new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new Recording(),
      createIntrospector: inner => new PostgresIntrospector(inner),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  })
  return { trx: db as unknown as InOrg, sent }
}

const kind = defineJob({
  kind: 'test.enqueue',
  feature: 'core.system',
  purpose: 'service_operation',
  role: 'hearth_queue',
  payload: z.strictObject({}),
  run: async () => {},
})
const org = randomUUID()

describe('T15 item 7 R2E2E-1: an idempotency key is codes and uuids joined by colons', () => {
  it('accepts the keys the scheduler and the offboarding consumer make', async () => {
    for (const key of [
      `run:${randomUUID()}`,
      `${randomUUID()}:sockets`,
      'effect:e06b',
      `${randomUUID()}:sockets:again`,
    ]) {
      expect(IDEMPOTENCY_KEY.test(key), key).toBe(true)
      const { trx, sent } = recording()
      await enqueue(trx, org, kind, { payload: {}, idempotencyKey: key })
      expect(sent[0]?.parameters).toContain(key)
    }
  })

  it('refuses free text, upper case, empty parts and an overlong key, before any SQL', async () => {
    for (const key of [
      'Priya Nair, +65 9123 4567, resigned',
      'reminder:Buy milk',
      'Run:1',
      'a::b',
      ':a',
      'a:',
      '',
      'a'.repeat(201),
      'person@example.com',
      // Each part is a code or a uuid: not a slug, a number or a dotted name.
      'priya-nair-resigned',
      'run:6591234567',
      'a.b_c-d',
      'effect:06b',
    ]) {
      const { trx, sent } = recording()
      await expect(enqueue(trx, org, kind, { payload: {}, idempotencyKey: key }), key).rejects.toThrow(EnqueueRefused)
      expect(sent).toEqual([])
    }
  })
})
