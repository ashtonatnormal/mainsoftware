import { sql } from 'kysely'
import { describe, expect, it, vi } from 'vitest'
import { withOrg } from '#src/db/database.ts'
import { publishFlags, readFlagsMessage } from '#src/flags/channel.ts'
import { FeatureOff, fenceFeature } from '#src/flags/fence.ts'
import { pgError, scriptedPool } from '#src/testing/pool.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const USER = 'b0000000-0000-4000-8000-000000000001'
const message = { v: 1, org: ORG, key: 'it.optional', revision: 2, at: 1_760_000_000_000 } as const

describe('C0.6 T17 item 6 the flags channel', () => {
  it('publishes ids, a key and numbers on the prefixed flags channel', async () => {
    const published: [string, string][] = []
    const valkey = { publish: async (channel: string, text: string) => published.push([channel, text]) }
    await publishFlags(valkey, 'it:unit:', message, { warn: vi.fn() })
    expect(published).toEqual([['it:unit:flags', JSON.stringify(message)]])
    expect(readFlagsMessage(published[0]?.[1] ?? '')).toEqual(message)
  })

  it('logs and swallows a failed publish: every process sees the change at its next poll', async () => {
    const warn = vi.fn()
    const valkey = { publish: vi.fn().mockRejectedValue(new Error('Connection is closed.')) }
    await expect(publishFlags(valkey, 'it:unit:', message, { warn })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'flags_publish_failed' }), expect.any(String))
  })

  it('reads only a well-formed message of its version', () => {
    for (const bad of [
      'not json',
      JSON.stringify({ ...message, v: 2 }),
      JSON.stringify({ ...message, org: 'x' }),
      JSON.stringify({ ...message, key: 'Not A Key' }),
      JSON.stringify({ ...message, revision: 0 }),
      JSON.stringify({ ...message, person: USER }),
    ]) {
      expect(readFlagsMessage(bad), bad).toBeUndefined()
    }
  })
})

describe('C0.6 T17 item 8 the feature fence', () => {
  it('ends the transaction with feature_fence(), passing the revisions the server evaluated', async () => {
    const p = scriptedPool()
    await withOrg(p.db, { orgId: ORG, userId: USER }, async trx => {
      await sql`select 1`.execute(trx)
      await fenceFeature(trx, 'it.optional', [3, 5])
    })
    const fence = p.statements.find(s => s.text.startsWith('select public.feature_fence'))
    expect(fence).toEqual({ text: 'select public.feature_fence($1, $2::bigint[])', values: ['it.optional', [3, 5]] })
    expect(p.texts().at(-1)).toBe('commit')
  })

  it('turns HF001 into FeatureOff, rolling the transaction back, and rethrows anything else', async () => {
    const off = scriptedPool(({ text }) => (text.startsWith('select public.feature_fence') ? pgError('HF001') : []))
    await expect(
      withOrg(off.db, { orgId: ORG, userId: USER }, trx => fenceFeature(trx, 'it.optional', [3])),
    ).rejects.toBeInstanceOf(FeatureOff)
    expect(off.texts().at(-1)).toBe('rollback')
    const other = scriptedPool(({ text }) => (text.startsWith('select public.feature_fence') ? pgError('42501') : []))
    await expect(
      withOrg(other.db, { orgId: ORG, userId: USER }, trx => fenceFeature(trx, 'it.optional', [3])),
    ).rejects.toMatchObject({ code: '42501' })
  })
})
