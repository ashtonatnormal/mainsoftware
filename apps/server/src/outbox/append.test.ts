import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { withOrg } from '#src/db/database.ts'
import { appendOutbox, type NewEvent, OutboxEventRefused, rowsOf, splitIds } from '#src/outbox/append.ts'
import { appended, scriptedPool } from '#src/testing/pool.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const PERSON = 'b0000000-0000-4000-8000-000000000001'
const ADMIN = 'b0000000-0000-4000-8000-000000000002'
const id = (n: number) => `d0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

const ended = (sessions: string[], devices: string[]): NewEvent<'signin.ended'> => ({
  orgId: ORG,
  type: 'signin.ended',
  entity: { type: 'person', id: PERSON },
  subjects: [PERSON],
  purpose: 'accounts',
  ids: { sessions, devices, reason: 'deactivated' },
})

describe('C0.6 T16 appending to the outbox: the catalogue is checked before any SQL', () => {
  it('refuses a reserved type, a purpose the type does not allow and an entity of the wrong kind', () => {
    const reserved = { ...ended([], []), type: 'message.created' } as unknown as NewEvent<'signin.ended'>
    expect(() => rowsOf(reserved)).toThrow(OutboxEventRefused)
    expect(() => rowsOf({ ...ended([], []), purpose: 'org_brain' as 'accounts' })).toThrow(/purpose/)
    expect(() => rowsOf({ ...ended([], []), entity: { type: 'device', id: PERSON } })).toThrow(/about a person/)
    expect(() => rowsOf({ ...ended([], []), entity: { type: 'person', id: 'Not An Id' } })).toThrow(OutboxEventRefused)
  })

  it('refuses ids that fail the type’s schema without echoing them, and a snapshot on an event that is not content', () => {
    const named = {
      ...ended([], []),
      ids: { sessions: [], devices: [], reason: 'Sentinel Tan' },
    } as unknown as NewEvent<'signin.ended'>
    expect(() => rowsOf(named)).toThrow(OutboxEventRefused)
    expect(() => rowsOf(named)).not.toThrow(/Sentinel/)
    const extra = {
      ...ended([], []),
      ids: { sessions: [], devices: [], reason: 'deactivated', name: 'x' },
    } as unknown as NewEvent<'signin.ended'>
    expect(() => rowsOf(extra)).toThrow(/schema/)
    const snapshot = { ...ended([], []), acl: { tokens: [], more: [], indexClass: 'normal' as const, epoch: 1 } }
    expect(() => rowsOf(snapshot)).toThrow(/carries no ACL snapshot/)
  })

  it('refuses more than 100 subjects, a malformed one, and a malformed actor', () => {
    const many = Array.from({ length: 101 }, (_, n) => id(n))
    expect(() => rowsOf({ ...ended([], []), subjects: many })).toThrow(/at most 100 subjects/)
    expect(() => rowsOf({ ...ended([], []), subjects: ['x'] })).toThrow(OutboxEventRefused)
    expect(() => rowsOf({ ...ended([], []), actor: { id: PERSON, kind: 'robot' as 'human' } })).toThrow(/actor/)
  })

  it('splits id lists longer than 100 across events, the n-th taking each list’s n-th slice', () => {
    const sessions = Array.from({ length: 150 }, (_, n) => id(n))
    const devices = Array.from({ length: 30 }, (_, n) => id(1000 + n))
    const rows = rowsOf(ended(sessions, devices))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ sessions: sessions.slice(0, 100), devices, reason: 'deactivated' })
    expect(rows[1]).toEqual({ sessions: sessions.slice(100), devices: [], reason: 'deactivated' })
    expect(splitIds({ enabled: true })).toEqual([{ enabled: true }])
    expect(splitIds({ sessions: [] })).toEqual([{ sessions: [] }])
  })
})

describe('C0.6 T16 the append: a plain INSERT in the caller’s transaction', () => {
  it('takes the actor from the transaction’s acting principal, read in the INSERT, and never reads the outbox back', async () => {
    const pool = scriptedPool()
    await withOrg(pool.db, { orgId: ORG, userId: ADMIN }, trx =>
      appendOutbox(trx, {
        orgId: ORG,
        type: 'person.deactivated',
        entity: { type: 'person', id: PERSON },
        subjects: [PERSON],
        purpose: 'accounts',
        ids: {},
      }),
    )
    const insert = pool.texts().find(text => text.startsWith('insert into outbox_events'))
    expect(insert).toContain(
      "from principals p where p.org_id = $15::uuid and p.id = nullif(current_setting('app.user_id', true), '')::uuid",
    )
    expect(insert).not.toMatch(/returning/i)
    // Exactly the columns hearth_app may insert: the database chooses id, tx_id and at.
    expect(/^insert into outbox_events \(([^)]*)\)/.exec(insert ?? '')?.[1]?.split(', ')).toEqual([
      'org_id',
      'type',
      'entity_type',
      'entity_id',
      'container_type',
      'container_id',
      'acl_tokens',
      'acl_more',
      'index_class',
      'acl_epoch',
      'actor_id',
      'actor_kind',
      'subject_ids',
      'purpose',
      'tombstone',
      'ids',
    ])
    expect(appended(pool.statements)).toEqual([
      { type: 'person.deactivated', entity: PERSON, subjects: [PERSON], ids: {}, actor: undefined },
    ])
  })

  it('names an actor when one is given (a sign-in acting as Hearth), and appends one row per slice', async () => {
    const pool = scriptedPool()
    const sessions = Array.from({ length: 101 }, (_, n) => id(n))
    await withOrg(pool.db, { orgId: ORG, userId: ADMIN }, async trx => {
      await appendOutbox(trx, { ...ended(sessions, []), actor: { id: PERSON, kind: 'human' } })
    })
    const events = appended(pool.statements)
    expect(events.map(event => event.actor)).toEqual([PERSON, PERSON])
    expect(events.map(event => (event.ids as { sessions: string[] }).sessions.length)).toEqual([100, 1])
  })

  it('refuses an append that inserted nothing: the transaction acts as no principal of the org', async () => {
    const pool = scriptedPool(({ text }) => (text.startsWith('insert into outbox_events') ? { affected: 0 } : []))
    await expect(
      withOrg(pool.db, { orgId: ORG, userId: ADMIN }, async trx => {
        await appendOutbox(trx, ended([], []))
        await sql`select 1`.execute(trx)
      }),
    ).rejects.toThrow(/acts as no principal/)
    expect(pool.texts().at(-1)).toBe('rollback')
  })
})
