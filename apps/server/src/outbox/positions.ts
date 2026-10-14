// Positions in the outbox and the statements a consumer's round is made of (TECH-SPEC T16 items
// 1-6). An event's position is (tx_id, id): the writer's top-level transaction id
// (xid8, which only the column default sets), then the row's own id. Consumers read in that order,
// and only below the horizon, pg_snapshot_xmin(pg_current_snapshot()): no transaction still running
// can then commit an event behind a consumer's checkpoint, so none is skipped. Events are delayed
// while a transaction holds the horizon, never lost (every transaction the server opens lasts at
// most 30 s). Positions are compared only in SQL, xid8 parameters cast, since a tx_id doesn't fit a
// JavaScript number.
//
// The clean-up deletes events by position, lowest first, and records how far it went (the floor,
// outbox_floors): every event at or below the floor is gone and none can appear there again, so a
// consumer at or above it has missed nothing, and one below it has fallen behind and must be
// rebuilt from the base tables (C1.7's enumerators).
import type { EventType } from '@hearth/shared'
import { sql } from 'kysely'
import type { InOrg } from '#src/db/database.ts'

export interface Position {
  // xid8 and bigint, as the decimal strings Postgres sends.
  txId: string
  id: string
}

// Before everything.
export const ORIGIN: Position = { txId: '0', id: '0' }

export interface OutboxRow {
  id: string
  txId: string
  at: Date
  type: EventType
  version: number
  entity: { type: string; id: string }
  container: { type: string; id: string } | null
  acl: { tokens: string[]; more: string[][]; indexClass: string; epoch: number } | null
  actor: { id: string; kind: string }
  subjects: string[]
  purpose: string
  tombstone: boolean
  ids: Record<string, unknown>
}

export const positionOf = (row: Pick<OutboxRow, 'txId' | 'id'>): Position => ({ txId: row.txId, id: row.id })

// Where a new consumer starts: the oldest kept event (the floor, or the beginning when nothing has
// been purged), or the current horizon, after the newest event a reader could see now (for a
// consumer that bootstraps from enumerators, C1.7). Used in SQL as a whole statement, so both read
// one snapshot.
export type Start = 'oldest' | 'now'

// One transaction-scoped advisory lock per (consumer, org): only one round, or reset, at a time.
// The try form gives up at once (a round elsewhere has it); the waiting form waits (a reset).
// Neither takes a transaction id.
function lockKey(consumer: string, orgId: string) {
  return sql`hashtextextended(${`hearth.outbox:${consumer}:${orgId}`}, 0)`
}

export async function tryLockConsumer(trx: InOrg, consumer: string, orgId: string): Promise<boolean> {
  const { rows } = await sql<{
    locked: boolean
  }>`select pg_try_advisory_xact_lock(${lockKey(consumer, orgId)}) as locked`.execute(trx)
  return rows[0]?.locked === true
}

export async function lockConsumer(trx: InOrg, consumer: string, orgId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(${lockKey(consumer, orgId)})`.execute(trx)
}

export async function readCheckpoint(trx: InOrg, orgId: string, consumer: string): Promise<Position | undefined> {
  const { rows } = await sql<{ last_tx: string; last_id: string }>`select last_tx, last_id from outbox_checkpoints
    where org_id = ${orgId} and consumer = ${consumer}`.execute(trx)
  const row = rows[0]
  return row === undefined ? undefined : { txId: row.last_tx, id: row.last_id }
}

// The position a new consumer starts at, as a row source: oldest (the floor, or the origin) or now
// (the newest event below the horizon, or the floor, or the origin).
function startOf(orgId: string, start: Start) {
  return start === 'oldest'
    ? sql`select coalesce(f.last_tx, '0'::xid8) as last_tx, coalesce(f.last_id, 0) as last_id
        from (select) one left join outbox_floors f on f.org_id = ${orgId}`
    : sql`select coalesce(h.tx_id, f.last_tx, '0'::xid8) as last_tx, coalesce(h.id, f.last_id, 0) as last_id
        from (select) one
        left join lateral (
          select e.tx_id, e.id from outbox_events e
          where e.org_id = ${orgId} and e.tx_id < pg_snapshot_xmin(pg_current_snapshot())
          order by e.tx_id desc, e.id desc limit 1) h on true
        left join outbox_floors f on f.org_id = ${orgId}`
}

// Makes the consumer's checkpoint at its start, in one statement. role_name is the job role the
// consumer runs as, the one role that may move it (outbox_checkpoints_own_row).
export async function startCheckpoint(
  trx: InOrg,
  orgId: string,
  consumer: string,
  role: string,
  start: Start,
): Promise<void> {
  await sql`insert into outbox_checkpoints (org_id, consumer, role_name, last_tx, last_id)
    select ${orgId}, ${consumer}, ${role}, s.last_tx, s.last_id from (${startOf(orgId, start)}) s
    on conflict (org_id, consumer) do nothing`.execute(trx)
}

// Moves the checkpoint to a start or a position, never below the floor (a reset; replay).
// Returns false, changing nothing, when the position is below the floor.
export async function setCheckpoint(
  trx: InOrg,
  orgId: string,
  consumer: string,
  role: string,
  to: Start | Position,
): Promise<boolean> {
  const target =
    typeof to === 'string'
      ? startOf(orgId, to)
      : sql`select ${to.txId}::xid8 as last_tx, ${to.id}::bigint as last_id
          where not exists (select 1 from outbox_floors f
            where f.org_id = ${orgId} and (f.last_tx, f.last_id) > (${to.txId}::xid8, ${to.id}::bigint))`
  const result = await sql`insert into outbox_checkpoints as c (org_id, consumer, role_name, last_tx, last_id)
    select ${orgId}, ${consumer}, ${role}, s.last_tx, s.last_id from (${target}) s
    on conflict (org_id, consumer) do update set last_tx = excluded.last_tx, last_id = excluded.last_id,
      updated_at = now()`.execute(trx)
  return result.numAffectedRows === 1n
}

export interface Batch {
  // The floor, if the clean-up has deleted anything, and whether it is above the checkpoint.
  floor: Position | undefined
  fellBehind: boolean
  rows: OutboxRow[]
}

type BatchRow = {
  floor_tx: string | null
  floor_id: string | null
  fell_behind: boolean
  id: string | null
  tx_id: string
  at: Date
  type: EventType
  version: number
  entity_type: string
  entity_id: string
  container_type: string | null
  container_id: string | null
  acl_tokens: string[] | null
  acl_more: string[][] | null
  index_class: string | null
  acl_epoch: string | null
  actor_id: string
  actor_kind: string
  subject_ids: string[]
  purpose: string
  tombstone: boolean
  ids: Record<string, unknown>
}

// The floor and the next batch after `from`, below the horizon, in one statement: one snapshot
// covers both, so a clean-up committing meanwhile can't hide a gap (it writes the floor in the
// transaction of its deletion). The checkpoint is passed as parameters, which keeps the read an
// index condition on outbox_events_cursor.
export async function readBatch(trx: InOrg, orgId: string, from: Position, limit: number): Promise<Batch> {
  const { rows } = await sql<BatchRow>`
    with f as (select last_tx, last_id from outbox_floors where org_id = ${orgId}),
    b as (
      select id, tx_id, at, type, version, entity_type, entity_id, container_type, container_id, acl_tokens,
             acl_more, index_class, acl_epoch, actor_id, actor_kind, subject_ids, purpose, tombstone, ids
      from outbox_events
      where org_id = ${orgId} and (tx_id, id) > (${from.txId}::xid8, ${from.id}::bigint)
        and tx_id < pg_snapshot_xmin(pg_current_snapshot())
      order by tx_id, id
      limit ${limit})
    select f.last_tx as floor_tx, f.last_id as floor_id,
           coalesce((f.last_tx, f.last_id) > (${from.txId}::xid8, ${from.id}::bigint), false) as fell_behind, b.*
    from (select) one left join f on true left join b on true
    order by b.tx_id, b.id`.execute(trx)
  const first = rows[0]
  const floor =
    first?.floor_tx == null || first.floor_id == null ? undefined : { txId: first.floor_tx, id: first.floor_id }
  return {
    floor,
    fellBehind: first?.fell_behind === true,
    rows: rows.flatMap(row =>
      row.id === null
        ? []
        : [
            {
              id: row.id,
              txId: row.tx_id,
              at: row.at,
              type: row.type,
              version: row.version,
              entity: { type: row.entity_type, id: row.entity_id },
              container:
                row.container_type === null || row.container_id === null
                  ? null
                  : { type: row.container_type, id: row.container_id },
              acl:
                row.acl_tokens === null || row.acl_more === null || row.index_class === null || row.acl_epoch === null
                  ? null
                  : {
                      tokens: row.acl_tokens,
                      more: row.acl_more,
                      indexClass: row.index_class,
                      epoch: Number(row.acl_epoch),
                    },
              actor: { id: row.actor_id, kind: row.actor_kind },
              subjects: row.subject_ids,
              purpose: row.purpose,
              tombstone: row.tombstone,
              ids: row.ids,
            },
          ],
    ),
  }
}

// Moves the checkpoint from the position the round read to the last event it handled, only if it
// is still there (compare-and-set): false means a reset moved it meanwhile, and the round must roll
// back so the reset's position stands.
export async function moveCheckpoint(
  trx: InOrg,
  orgId: string,
  consumer: string,
  from: Position,
  to: Position,
  handled: number,
): Promise<boolean> {
  const result = await sql`update outbox_checkpoints
    set last_tx = ${to.txId}::xid8, last_id = ${to.id}::bigint, processed = processed + ${handled}, updated_at = now()
    where org_id = ${orgId} and consumer = ${consumer}
      and last_tx = ${from.txId}::xid8 and last_id = ${from.id}::bigint`.execute(trx)
  return result.numAffectedRows === 1n
}

// The restore check (T16 item 18): whether any stored position (an event, a checkpoint, the floor)
// is at or above the next transaction id this cluster will hand out, which happens only after a
// logical restore or a Blue/Green upgrade that didn't keep transaction ids. Consumers of the org
// then stop until the runbook (C0.17; C0.11 for Blue/Green) has purged the outbox and rebuilt
// them. It takes no transaction id.
export async function futureRows(trx: InOrg, orgId: string): Promise<boolean> {
  const { rows } = await sql<{ future: boolean | null }>`select greatest(
      (select max(tx_id) from outbox_events where org_id = ${orgId}),
      (select max(last_tx) from outbox_checkpoints where org_id = ${orgId}),
      (select last_tx from outbox_floors where org_id = ${orgId})) >= pg_snapshot_xmax(pg_current_snapshot()) as future`.execute(
    trx,
  )
  return rows[0]?.future === true
}
