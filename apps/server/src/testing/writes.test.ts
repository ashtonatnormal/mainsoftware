import { describe, expect, it, vi } from 'vitest'
import { sweepWrites } from '#src/testing/writes.ts'

// Two entries that could each have made the same write: one exempt, one that needs an event. The
// sweep can't tell which made it, so the real coverage table isn't needed here.
vi.mock('#src/outbox/coverage.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('#src/outbox/coverage.ts')>()),
  coverageOf: (_role: string, table: string) =>
    table === 'jobs'
      ? [{ key: 'purge_jobs(integer)', coverage: { exempt: 'the clean-up', writes: ['jobs:DELETE'] } }]
      : [
          { key: 'purge_jobs(integer)', coverage: { exempt: 'the clean-up', writes: ['people:DELETE'] } },
          { key: 'rename_person(uuid)', coverage: { events: ['person.updated'], writes: ['people:DELETE'] } },
        ],
}))

const PERSON = '00000000-0000-4000-8000-0000000000a8'

// A superuser that answers the sweep's two reads: the recorded writes, then the outbox's events.
function recorded(writes: unknown[], events: unknown[] = []) {
  const answers = [writes, events]
  return { query: (async () => ({ rows: answers.shift() ?? [] })) as never }
}

describe('C0.6 T16 item 7 the sweep', () => {
  it('CONTRACT-1: excuses a write by exemption only when every entry that could have made it is exempt', async () => {
    const write = (table: string) => ({
      xid: '7',
      table_name: table,
      op: 'DELETE',
      columns: null,
      role: 'hearth_app',
      row_ref: PERSON,
    })
    expect((await sweepWrites(recorded([write('jobs')]))).problems).toEqual([])
    const sweep = await sweepWrites(recorded([write('people')]))
    expect(sweep.problems).toEqual([
      `transaction 7 wrote people (DELETE) of ${PERSON} as hearth_app but appended none of person.updated naming it (it appended no event)`,
    ])
    // With the event the other entry needs, it passes.
    const covered = await sweepWrites(
      recorded([write('people')], [{ tx_id: '7', type: 'person.updated', entity_id: PERSON, subject_ids: [] }]),
    )
    expect(covered.problems).toEqual([])
    expect(covered.checked).toBe(1)
  })
})
