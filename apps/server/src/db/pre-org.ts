// The only queries outside withOrg() besides the worker's org list: the two lookups sign-in makes
// before it knows the org (CLAUDE.md, Database; 0006). Each runs in a transaction of its own, READ
// COMMITTED and read-write, because the functions read FOR SHARE, and short, so their row locks
// never outlive the lookup. It waits at most 2 s for a lock, and lasts at most 30 s, as every
// transaction the server opens does (database.ts: a FOR SHARE read takes an xid, which holds the
// outbox's consumers back). It doesn't wait for its commit to be flushed: it writes nothing but row
// locks, and losing those in a crash costs nothing, while a flush would add a WAL wait (and on RDS
// Multi-AZ a standby round trip) to every signed-in request. Nothing here sets app.org_id or
// app.user_id, and nothing else goes through it (scripts/guards/db-entry.test.ts).
import { type RawBuilder, sql } from 'kysely'
import { type Database, LOCK_TIMEOUT, TRANSACTION_TIMEOUT } from '#src/db/database.ts'

export interface SessionIds {
  sessionId: string
  orgId: string
  userId: string
  deviceId: string
}

export interface PhoneMatch {
  phoneNumberId: string
  orgId: string
  personId: string
}

function lookup<Row>(db: Database, query: RawBuilder<Row>): Promise<Row[]> {
  return db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async trx => {
      await sql`select set_config('lock_timeout', ${sql.lit(LOCK_TIMEOUT)}, true), set_config('synchronous_commit', 'off', true), set_config('transaction_timeout', ${sql.lit(TRANSACTION_TIMEOUT)}, true)`.execute(
        trx,
      )
      return (await query.execute(trx)).rows
    })
}

// The live session a cookie's token belongs to, from the token's SHA-256 (T5), or undefined.
// maxIdle is the idle limit as a Postgres interval (auth/policy.ts). A failed lookup throws, and
// its caller answers 503 unavailable.
export async function sessionByToken(
  db: Database,
  tokenHash: Buffer,
  maxIdle: string,
): Promise<SessionIds | undefined> {
  // session_by_token returns nothing for any other length; this saves the round trip.
  if (tokenHash.length !== 32) return undefined
  const rows = await lookup(
    db,
    sql<{
      session_id: string
      org_id: string
      user_id: string
      device_id: string
    }>`select session_id, org_id, user_id, device_id from public.session_by_token(${tokenHash}, ${maxIdle}::interval)`,
  )
  // token_hash is unique, so a second row means the function is wrong.
  if (rows.length > 1) throw new Error('session_by_token returned more than one row')
  const row = rows[0]
  return row && { sessionId: row.session_id, orgId: row.org_id, userId: row.user_id, deviceId: row.device_id }
}

// The current roster entries for an E.164 number: none, one, or (if two orgs hold it) more, which
// the caller treats as none.
export async function personByPhone(db: Database, e164: string): Promise<PhoneMatch[]> {
  const rows = await lookup(
    db,
    sql<{
      phone_number_id: string
      org_id: string
      person_id: string
    }>`select phone_number_id, org_id, person_id from public.person_by_phone(${e164})`,
  )
  return rows.map(row => ({ phoneNumberId: row.phone_number_id, orgId: row.org_id, personId: row.person_id }))
}
