// The dynamic half of the outbox's contract (test-only; the image leaves testing/ out): every write
// a runtime role commits during an integration run is recorded, and each suite's afterAll checks
// that each one is exempt in outbox/coverage.ts or had, in its own transaction, an event of a type
// its entry lists naming the row (its MATCH column) as the event's entity or among its subjects
// (TECH-SPEC T16 item 7). The static half is apps/server/scripts/check-catalogues.ts.
//
// The harness installs it in its throwaway database, as the superuser, after the migrations:
//   - it_writes, owned by the superuser, which no runtime role can read;
//   - it_track_write(), a SECURITY DEFINER row trigger the superuser owns (so writers need no
//     grant), recording the writer's transaction id, the table (a partition's root), the operation,
//     for an UPDATE the columns whose values changed, the row's MATCH column, and the acting role:
//     the role the transaction took (`role`), or else the login (session_user), since inside a
//     definer current_user is always its owner;
//   - an AFTER row trigger on every table in public but the outbox, the migrator's ledger and the
//     tests' own it_* tables;
//   - it_events, a copy of each outbox event's position and what it names, made by a trigger on
//     the outbox, so a run whose clean-up deletes events can still be swept.
// A write that rolls back takes its record with it, so only committed writes are checked. The
// harness's own writes run as the superuser, which isn't a runtime role, and are skipped; its age()
// switches every trigger off (session_replication_role = replica).
import type { EmittedEventType } from '@hearth/shared'
import type { Client as PgClient } from 'pg'
import { coverageOf, EMITTED_BY, MATCH, type WriteOp } from '#src/outbox/coverage.ts'

// The roles a runtime transaction acts as: hearth_app's login, and the worker's job roles.
export const RUNTIME_ROLES = [
  'hearth_app',
  'hearth_queue',
  'hearth_job_offboarding',
  'hearth_job_partitions',
  'hearth_job_purge',
] as const

export async function installWriteTracking(superuser: Pick<PgClient, 'query'>): Promise<void> {
  await superuser.query(`
    create table public.it_writes (
      xid xid8 not null,
      table_name text not null,
      op text not null,
      columns text[],
      role text not null,
      row_ref text
    );
    create function public.it_track_write() returns trigger
    language plpgsql security definer set search_path = '' as $$
    declare
      changed text[];
      ref text;
    begin
      if tg_op = 'UPDATE' then
        select pg_catalog.array_agg(n.key order by n.key) into changed
        from pg_catalog.jsonb_each(pg_catalog.to_jsonb(new)) n
        where n.value is distinct from (pg_catalog.to_jsonb(old) -> n.key);
        -- An update that changed nothing wrote nothing anyone could see.
        if changed is null then
          return null;
        end if;
      end if;
      if tg_nargs > 0 then
        ref := (case when tg_op = 'DELETE' then pg_catalog.to_jsonb(old) else pg_catalog.to_jsonb(new) end) ->> tg_argv[0];
      end if;
      insert into public.it_writes (xid, table_name, op, columns, role, row_ref)
      values (pg_catalog.pg_current_xact_id(),
              (select c.relname from pg_catalog.pg_class c
               where c.oid = coalesce(pg_catalog.pg_partition_root(tg_relid), tg_relid)),
              tg_op, changed, coalesce(nullif(pg_catalog.current_setting('role'), 'none'), session_user), ref);
      return null;
    end
    $$;
    revoke execute on function public.it_track_write() from public;
    -- Each event's position and what it names, kept where the clean-up can't delete it, so a run
    -- that purges the outbox can still be swept.
    create table public.it_events (xid xid8 not null, type text not null, entity_id uuid not null, subject_ids uuid[] not null);
    create function public.it_track_event() returns trigger
    language plpgsql security definer set search_path = '' as $$
    begin
      insert into public.it_events (xid, type, entity_id, subject_ids)
      values (new.tx_id, new.type, new.entity_id, new.subject_ids);
      return null;
    end
    $$;
    revoke execute on function public.it_track_event() from public;
    create trigger it_track_event after insert on public.outbox_events
      for each row execute function public.it_track_event();
  `)
  const { rows } = await superuser.query<{ name: string }>(`
    select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
      and c.relname not in ('outbox_events', 'kysely_migration', 'kysely_migration_lock')
      and c.relname not like 'it\\_%'
    order by c.relname`)
  for (const { name } of rows) {
    const match = MATCH[name]
    await superuser.query(
      `create trigger it_track_write after insert or update or delete on public.${quote(name)}
       for each row execute function public.it_track_write(${match === undefined ? '' : literal(match)})`,
    )
  }
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`

export interface Sweep {
  // How many recorded writes needed an event (exempt ones aside), and found it.
  checked: number
  // Each write nothing covers, or whose transaction appended no event naming it.
  problems: string[]
  // The event types appended during the run.
  emitted: Set<string>
}

type WriteRow = {
  xid: string
  table_name: string
  op: WriteOp
  columns: string[] | null
  role: string
  row_ref: string | null
}
type EventRow = { tx_id: string; type: string; entity_id: string; subject_ids: string[] }

export async function sweepWrites(superuser: Pick<PgClient, 'query'>): Promise<Sweep> {
  const writes = (
    await superuser.query<WriteRow>(
      'select w.xid::text as xid, w.table_name, w.op, w.columns, w.role, w.row_ref from it_writes w where w.role = any($1) order by w.xid, w.table_name',
      [RUNTIME_ROLES],
    )
  ).rows
  const events = (
    await superuser.query<EventRow>('select xid::text as tx_id, type, entity_id, subject_ids from it_events')
  ).rows
  const byTx = new Map<string, EventRow[]>()
  for (const event of events) byTx.set(event.tx_id, [...(byTx.get(event.tx_id) ?? []), event])
  const problems: string[] = []
  let checked = 0
  for (const write of writes) {
    const parts = write.op === 'UPDATE' ? (write.columns ?? []).map(column => ({ column })) : [{ column: undefined }]
    for (const { column } of parts) {
      const what = `${write.table_name}${column === undefined ? '' : `.${column}`} (${write.op}) of ${write.row_ref ?? '?'} as ${write.role}`
      const candidates = coverageOf(write.role, write.table_name, write.op, column)
      if (candidates.length === 0) {
        problems.push(`transaction ${write.xid} wrote ${what}, which apps/server/src/outbox/coverage.ts doesn't cover`)
        continue
      }
      if (candidates.some(({ coverage }) => 'exempt' in coverage)) continue
      const types = new Set<string>(candidates.flatMap(({ coverage }) => ('events' in coverage ? coverage.events : [])))
      const appended = byTx.get(write.xid) ?? []
      const named = appended.some(
        event =>
          types.has(event.type) &&
          write.row_ref !== null &&
          (event.entity_id === write.row_ref || event.subject_ids.includes(write.row_ref)),
      )
      if (!named) {
        const seen = appended.map(event => `${event.type} naming ${event.entity_id}`).join(', ') || 'no event'
        problems.push(
          `transaction ${write.xid} wrote ${what} but appended none of ${[...types].join(', ')} naming it (it appended ${seen})`,
        )
        continue
      }
      checked++
    }
  }
  return { checked, problems, emitted: new Set(events.map(event => event.type)) }
}

// The suite's share of the contract: every committed write covered, at least one write that needed
// an event checked (so the sweep can't pass by checking nothing), and, when every test in the suite
// ran and passed, every event type EMITTED_BY assigns it appended at least once.
export async function expectEveryWriteCovered(
  superuser: Pick<PgClient, 'query'>,
  suite: 'sign-in' | 'flags' | 'outbox' | 'jobs',
  options: { allPassed: boolean },
): Promise<Sweep> {
  const sweep = await sweepWrites(superuser)
  if (sweep.problems.length > 0) {
    throw new Error(`writes without their outbox events:\n${sweep.problems.join('\n')}`)
  }
  if (sweep.checked === 0) throw new Error('the outbox sweep checked no write that needed an event')
  if (options.allPassed) {
    const missing = (Object.keys(EMITTED_BY) as EmittedEventType[]).filter(
      type => EMITTED_BY[type] === suite && !sweep.emitted.has(type),
    )
    if (missing.length > 0) throw new Error(`the ${suite} suite never appended ${missing.join(', ')}`)
  }
  return sweep
}
