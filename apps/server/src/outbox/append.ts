// Appending to the outbox (INF-OUTBOX, TECH-SPEC T16): one row per business event, in the
// transaction that makes the change, so a rolled-back change leaves no event and a committed one
// always has its event. The append goes beside the write, in the helper that makes it, never inside
// writeAudit (T16 item 8), and one business event is one event however many rows it touched: a
// deactivation that ends N sessions is one signin.ended naming them.
//
// The catalogue (packages/shared EVENTS) is checked here before any SQL: the type must be emitted,
// the ids must pass its schema (ids only: uuids, codes, booleans and bounded numbers), the purpose
// must be one it allows, and a content event must carry its ACL snapshot and nothing else may. The
// database checks the rest: the type list, the ids shape (is_ids_only), the snapshot's shape, and
// the actor, which must be the principal the transaction acts as unless Hearth is acting (a
// sign-in before a session exists names the person, as its audit row does; a job names whoever its
// work is for).
//
// hearth_app may only insert into the outbox, never read it (migration 0007), so this is a plain
// INSERT, never INSERT … RETURNING, and the database chooses id, tx_id and at.
import type { AclRow } from '@hearth/access'
import { type EmittedEventType, EVENTS, type IdsOf, isEmitted } from '@hearth/shared'
import { sql } from 'kysely'
import type { InOrg } from '#src/db/database.ts'

export type ActorKind = 'human' | 'agent' | 'assistant' | 'system'

export interface NewEvent<T extends EmittedEventType> {
  orgId: string
  type: T
  // What the event is about, and for content the place whose ACL the snapshot came from.
  entity: { type: string; id: string }
  container?: { type: string; id: string }
  // Content events only (the catalogue says which): aclOf's row and the container's acl_epoch.
  acl?: AclRow & { epoch: number }
  // Who caused it: the principal the transaction acts as (app.user_id) when left out. Only a
  // transaction acting as Hearth may name someone else (T16 item 10).
  actor?: { id: string; kind: ActorKind }
  // The people whose personal data it concerns: at most 100.
  subjects: readonly string[]
  purpose: (typeof EVENTS)[T]['purposes'][number]
  // The other ids consumers need. A list longer than 100 is split across several events of the
  // same type, each with the rest of the ids.
  ids: IdsOf<T>
}

// An event the catalogue refuses. Its message names the type and the rule, never a value.
export class OutboxEventRefused extends Error {
  override name = 'OutboxEventRefused'
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const NAME = /^[a-z][a-z0-9_]{0,62}$/
const ACTOR_KINDS = new Set<string>(['human', 'agent', 'assistant', 'system'])
// The most ids one list in an event's ids may hold, and the most subjects (0007's checks).
export const IDS_PER_EVENT = 100
export const SUBJECTS_PER_EVENT = 100

// The ids split into events: every list cut into slices of at most 100, the n-th event taking
// each list's n-th slice (an empty list once a shorter one runs out) and every other field whole.
export function splitIds(ids: Readonly<Record<string, unknown>>): Record<string, unknown>[] {
  const lists = Object.values(ids).filter((value): value is unknown[] => Array.isArray(value))
  const count = Math.max(1, ...lists.map(list => Math.ceil(list.length / IDS_PER_EVENT)))
  return Array.from({ length: count }, (_, n) =>
    Object.fromEntries(
      Object.entries(ids).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.slice(n * IDS_PER_EVENT, (n + 1) * IDS_PER_EVENT) : value,
      ]),
    ),
  )
}

// The rows to insert, each one's ids checked against the type's schema, or a refusal.
export function rowsOf<T extends EmittedEventType>(event: NewEvent<T>): Record<string, unknown>[] {
  const type: string = event.type
  if (!isEmitted(type)) throw new OutboxEventRefused(`${type} is not an emitted event type`)
  const spec = EVENTS[event.type]
  if (!(spec.purposes as readonly string[]).includes(event.purpose)) {
    throw new OutboxEventRefused(`${type} can't carry the purpose given`)
  }
  if (event.entity.type !== spec.entity || !UUID.test(event.entity.id)) {
    throw new OutboxEventRefused(`${type} is about a ${spec.entity}, named by a lower-case uuid`)
  }
  if (event.container !== undefined && (!NAME.test(event.container.type) || !UUID.test(event.container.id))) {
    throw new OutboxEventRefused(`${type}'s container needs a type and a lower-case uuid`)
  }
  const snapshot = (spec.acl as string) === 'snapshot'
  if (snapshot !== (event.acl !== undefined)) {
    throw new OutboxEventRefused(
      snapshot ? `${type} must carry its ACL snapshot` : `${type} is not content and carries no ACL snapshot`,
    )
  }
  if (event.actor !== undefined && (!UUID.test(event.actor.id) || !ACTOR_KINDS.has(event.actor.kind))) {
    throw new OutboxEventRefused(`${type}'s actor needs a lower-case uuid and a principal kind`)
  }
  if (event.subjects.length > SUBJECTS_PER_EVENT || event.subjects.some(subject => !UUID.test(subject))) {
    throw new OutboxEventRefused(`${type} names at most ${SUBJECTS_PER_EVENT} subjects, each a lower-case uuid`)
  }
  return splitIds(event.ids as Record<string, unknown>).map(ids => {
    const parsed = spec.ids.safeParse(ids)
    // The message names the type only: zod's would echo the values.
    if (!parsed.success) throw new OutboxEventRefused(`${type}'s ids don't match its schema`)
    return parsed.data as Record<string, unknown>
  })
}

// Adds the event in the caller's transaction, so it commits or rolls back with the change.
export async function appendOutbox<T extends EmittedEventType>(trx: InOrg, event: NewEvent<T>): Promise<void> {
  const rows = rowsOf(event)
  const spec = EVENTS[event.type]
  const acl = event.acl
  for (const ids of rows) {
    const values = sql`${event.orgId}::uuid, ${event.type}, ${event.entity.type}, ${event.entity.id}::uuid,
      ${event.container?.type ?? null}, ${event.container?.id ?? null}::uuid,
      ${acl === undefined ? null : [...acl.tokens]}::text[], ${acl === undefined ? null : JSON.stringify(acl.more)}::jsonb,
      ${acl?.indexClass ?? null}, ${acl?.epoch ?? null}::bigint`
    const tail = sql`${[...event.subjects]}::uuid[], ${event.purpose}, ${spec.tombstone}, ${JSON.stringify(ids)}::jsonb`
    const columns = sql`(org_id, type, entity_type, entity_id, container_type, container_id, acl_tokens, acl_more,
      index_class, acl_epoch, actor_id, actor_kind, subject_ids, purpose, tombstone, ids)`
    // Without an actor, the transaction's acting principal and its kind, read in the same statement.
    // A transaction acting as nobody inserts nothing, which is refused below.
    const result =
      event.actor === undefined
        ? await sql`insert into outbox_events ${columns}
            select ${values}, p.id, p.kind, ${tail} from principals p
            where p.org_id = ${event.orgId}::uuid and p.id = nullif(current_setting('app.user_id', true), '')::uuid`.execute(
            trx,
          )
        : await sql`insert into outbox_events ${columns}
            values (${values}, ${event.actor.id}::uuid, ${event.actor.kind}, ${tail})`.execute(trx)
    if (result.numAffectedRows !== 1n) {
      throw new OutboxEventRefused(`${event.type} was not appended: the transaction acts as no principal of the org`)
    }
  }
}
