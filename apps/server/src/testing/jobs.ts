// The tables the worker's integration tests write to (test-only; the image leaves testing/ out),
// made by the superuser in the run's throwaway database (TECH-SPEC T15, T16). Each is org-scoped under the
// standard policy and granted to hearth_job_offboarding, the role the test kinds and the test
// consumer run as, so no test role is created on the shared server; grants are per database, so
// nothing reaches another run's. None deduplicates where a duplicate must show:
//   it_job_effects   one row per committed effect of a job (no unique constraint)
//   it_posts         one row per post an it.posts job committed
//   it_deliveries    every event a consumer round committed, with the round's transaction id
//   it_effects       a deduplicated one-off effect per (consumer, event), standing in for a push
//   it_projection    a convergent projection of each person: left, live sessions, passkeys
// and it_fail_next, whose actions make the next audit row with that action fail, so a test can make
// a real route's transaction fail after all its writes (the C0 exit's "rolled-back writes emit nothing").
import type { Stack } from '#src/testing/stack.ts'

const POLICY = `using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid)`

export async function installJobTables(s: Pick<Stack, 'query'>): Promise<void> {
  await s.query(`
    create table if not exists it_job_effects (
      org_id uuid not null, job_id uuid not null, n integer not null, at timestamptz not null default clock_timestamp());
    create table if not exists it_posts (
      org_id uuid not null, job_id uuid not null, n integer not null, at timestamptz not null default clock_timestamp());
    create table if not exists it_deliveries (
      org_id uuid not null, consumer text not null, event_id bigint not null, type text not null,
      round_xid xid8 not null default pg_current_xact_id());
    create table if not exists it_effects (
      org_id uuid not null, consumer text not null, event_id bigint not null, type text not null,
      unique (consumer, event_id));
    create table if not exists it_projection (
      org_id uuid not null, person_id uuid primary key, deactivated boolean not null, live_sessions integer not null,
      passkeys integer not null);
    create table if not exists it_fail_next (action text primary key);
    create or replace function it_fail_audit() returns trigger language plpgsql security definer set search_path = '' as $$
    begin
      if exists (select 1 from public.it_fail_next f where f.action = new.action) then
        raise exception 'it_fail_next: this audit row fails on purpose';
      end if;
      return new;
    end
    $$;
    revoke execute on function it_fail_audit() from public;
    drop trigger if exists it_fail_next on audit_events;
    create trigger it_fail_next before insert on audit_events for each row execute function it_fail_audit();`)
  for (const table of ['it_job_effects', 'it_posts', 'it_deliveries', 'it_effects', 'it_projection']) {
    await s.query(`alter table ${table} enable row level security`)
    await s.query(`drop policy if exists org_isolation on ${table}`)
    await s.query(`create policy org_isolation on ${table} ${POLICY}`)
    await s.query(`grant select, insert, update, delete on ${table} to hearth_job_offboarding`)
  }
  // What the projection re-reads: whether someone has left, their live sessions, their passkeys.
  await s.query('grant select (revoked_at, expires_at) on sessions to hearth_job_offboarding')
  await s.query('grant select (id, org_id, user_id, removed_at) on passkeys to hearth_job_offboarding')
}
