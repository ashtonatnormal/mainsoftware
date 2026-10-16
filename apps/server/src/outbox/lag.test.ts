import { describe, expect, it } from 'vitest'
import { logOutboxLag, logQueueDepth, readOutboxLag, readQueueDepth } from '#src/outbox/lag.ts'
import { captureLogger } from '#src/testing/logs.ts'
import { type Statement, scriptedPool } from '#src/testing/pool.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const SYSTEM = 'c0000000-0000-4000-8000-000000000001'

function pool(rows: (statement: Statement) => unknown[] | undefined) {
  return scriptedPool(statement => {
    if (statement.text.includes("from principals where org_id = $1 and kind = 'system'")) return [{ id: SYSTEM }]
    return rows(statement) ?? []
  })
}

describe('C0.6 T16 item 19 the outbox_lag lines', () => {
  it('reads every checkpoint’s lag, and what the horizon holds back, in one read-only statement as hearth_queue', async () => {
    const p = pool(({ text }) =>
      text.startsWith('with held as')
        ? [
            {
              consumer: 'offboarding',
              seconds_behind: '12.5',
              events_behind: '40',
              checkpoint_age: '30.000',
              held_events: '3',
              held_seconds: '2.25',
            },
          ]
        : undefined,
    )
    expect(await readOutboxLag(p.db, ORG)).toEqual([
      {
        consumer: 'offboarding',
        org: ORG,
        secondsBehind: 12.5,
        eventsBehind: 40,
        checkpointAgeSeconds: 30,
        heldBackEvents: 3,
        heldBackSeconds: 2.25,
      },
    ])
    expect(p.texts()[0]).toBe('start transaction isolation level read committed read only')
    expect(p.statements.find(s => s.text.startsWith("select set_config('role'"))?.values[0]).toBe('hearth_queue')
    const read = p.texts().find(text => text.startsWith('with held as')) ?? ''
    // It reads only the columns hearth_queue may: positions and times, never the envelope.
    expect(read).toContain('e.tx_id >= pg_snapshot_xmin(pg_current_snapshot())')
    expect(read).toMatch(/limit \$\d+\) behind/)
    expect(read).not.toMatch(/\b(subject_ids|ids|entity_id|actor_id)\b/)
    expect(p.statements.find(s => s.text.startsWith('with held as'))?.values).toContain(100_000)
  })

  it('warns for a consumer behind its own budget, and says nothing of a budget it does not know', () => {
    const { logger, events } = captureLogger()
    const lag = {
      org: ORG,
      eventsBehind: 1,
      checkpointAgeSeconds: 1,
      heldBackEvents: 0,
      heldBackSeconds: 0,
    }
    logOutboxLag(
      logger,
      [
        { ...lag, consumer: 'offboarding', secondsBehind: 11 },
        { ...lag, consumer: 'search', secondsBehind: 5 },
        { ...lag, consumer: 'retired', secondsBehind: 1000 },
      ],
      [
        { name: 'offboarding', lagBudgetMs: 10_000 },
        { name: 'search', lagBudgetMs: 30_000 },
      ],
    )
    expect(events('outbox_lag').map(line => [line.consumer, line.level, line.budgetMs])).toEqual([
      ['offboarding', 40, 10_000],
      ['search', 30, 30_000],
      ['retired', 30, null],
    ])
  })
})

describe('C0.6 T15 the queue_depth line', () => {
  it('counts queued, running and dead jobs and interrupted runs, and the oldest due job’s wait', async () => {
    const p = pool(({ text }) =>
      text.startsWith('select count(*) filter')
        ? [{ queued: '4', running: '1', dead: '2', interrupted: '1', oldest_queued: '7.5' }]
        : undefined,
    )
    const depth = await readQueueDepth(p.db, ORG)
    expect(depth).toEqual({ org: ORG, queued: 4, running: 1, dead: 2, interrupted: 1, oldestQueuedSeconds: 7.5 })
    const read = p.texts().find(text => text.startsWith('select count(*) filter')) ?? ''
    expect(read).toContain("min(j.run_after) filter (where j.state = 'queued' and j.run_after <= now())")
    expect(read).toContain("r.state = 'interrupted'")
    const { logger, events } = captureLogger()
    logQueueDepth(logger, depth)
    expect(events('queue_depth')).toEqual([expect.objectContaining({ level: 30, queued: 4, dead: 2, interrupted: 1 })])
  })

  it('reads an empty queue as zeros', async () => {
    const p = pool(({ text }) =>
      text.startsWith('select count(*) filter')
        ? [{ queued: '0', running: '0', dead: '0', interrupted: '0', oldest_queued: null }]
        : undefined,
    )
    expect(await readQueueDepth(p.db, ORG)).toMatchObject({ queued: 0, oldestQueuedSeconds: 0 })
  })
})
