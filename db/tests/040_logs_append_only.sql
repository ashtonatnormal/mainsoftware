-- ADM-06, T12, T16, CLAUDE.md Database: audit_events, data_access_events and (from 0007) the outbox
-- are append-only. hearth_app can add a row for its own org and nothing else: no reading (not even
-- through INSERT ... RETURNING), changing, deleting or emptying them, no choosing a row's id, time
-- or (for the outbox) position, and no reaching a data_access_events partition directly. Only the
-- partitions job's role adds partitions.
\ir fixtures/two_orgs.sql

select pg_temp.act_as('1', 'a2');

-- Adding rows for the org works.
insert into public.audit_events (org_id, actor_id, action, target_type, target_id, request_id)
values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a2', 'test.added', 'person', 'x', 'req-1');
insert into public.data_access_events (org_id, type, subject_id, actor_id, object_type, object_id)
values ('f1000000-0000-4000-8000-000000000000', 'share', 'f1000000-0000-4000-8000-0000000000a8',
        'f1000000-0000-4000-8000-0000000000a2', 'file', 'f-1');

-- Nothing else.
select pg_temp.expect_error($$select count(*) from public.audit_events$$, '42501');
select pg_temp.expect_error($$update public.audit_events set action = 'test.changed'$$, '42501');
select pg_temp.expect_error($$update public.audit_events set reason = 'changed'$$, '42501');
select pg_temp.expect_error($$delete from public.audit_events$$, '42501');
select pg_temp.expect_error($$truncate public.audit_events$$, '42501');
select pg_temp.expect_error($$insert into public.audit_events (org_id, action)
  values ('f1000000-0000-4000-8000-000000000000', 'test.returning') returning id$$, '42501');
-- Ids come from the sequence in order, and the time is the write's (C0.16's hash chain relies on
-- both): an entry can't be backdated or given a chosen id.
select pg_temp.expect_error($$insert into public.audit_events (id, org_id, action)
  values (1, 'f1000000-0000-4000-8000-000000000000', 'test.chosen_id')$$, '428C9');
select pg_temp.expect_error($$insert into public.audit_events (org_id, action, at)
  values ('f1000000-0000-4000-8000-000000000000', 'test.backdated', now() - interval '1 year')$$, '42501');
-- Privileged access (Rule 9) names its case and reason.
select pg_temp.expect_error($$insert into public.audit_events (org_id, actor_id, action, target_type, target_id)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a5', 'privileged.read', 'message', 'm-1')$$,
  '23514', '%audit_events_privileged_has_case%');
insert into public.audit_events (org_id, actor_id, action, target_type, target_id, case_id, reason)
values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a5', 'privileged.read', 'message', 'm-1',
        gen_random_uuid(), 'Access request 2026-04');

select pg_temp.expect_error($$select count(*) from public.data_access_events$$, '42501');
select pg_temp.expect_error($$update public.data_access_events set type = 'share'$$, '42501');
select pg_temp.expect_error($$delete from public.data_access_events$$, '42501');
select pg_temp.expect_error($$truncate public.data_access_events$$, '42501');
select pg_temp.expect_error($$insert into public.data_access_events (org_id, type, subject_id, actor_id)
  values ('f1000000-0000-4000-8000-000000000000', 'export', 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000a2')
  returning id$$, '42501');
select pg_temp.expect_error($$insert into public.data_access_events (org_id, type, subject_id, actor_id, at)
  values ('f1000000-0000-4000-8000-000000000000', 'export', 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000a2', now() - interval '1 day')$$, '42501');
select pg_temp.expect_error($$insert into public.data_access_events (id, org_id, type, subject_id, actor_id)
  values (gen_random_uuid(), 'f1000000-0000-4000-8000-000000000000', 'export', 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000a2')$$, '42501');
-- Nor a notice acknowledgment's time (PDPA-03 records when it was given).
select pg_temp.expect_error($$insert into public.notice_acknowledgments (org_id, person_id, notice_version_id, method, acknowledged_at)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a7', 'f1000000-0000-4000-8000-0000000000e3', 'in_app', '2020-01-01')$$, '42501');

-- Every partition, directly.
do $$
declare
  p record;
begin
  for p in
    select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'public.data_access_events'::regclass
  loop
    perform pg_temp.expect_error(format('select count(*) from public.%I', p.relname), '42501');
    perform pg_temp.expect_error(format($i$insert into public.%I (org_id, type, subject_id, actor_id)
      values ('f1000000-0000-4000-8000-000000000000', 'export', 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000a2')$i$,
      p.relname), '42501');
    perform pg_temp.expect_error(format('delete from public.%I', p.relname), '42501');
  end loop;
end
$$;

-- The outbox: hearth_app adds an event in its own org, as the person acting, and nothing else.
insert into public.outbox_events (org_id, type, entity_type, entity_id, actor_id, actor_kind, subject_ids, purpose, ids)
values ('f1000000-0000-4000-8000-000000000000', 'person.deactivated', 'person', 'f1000000-0000-4000-8000-0000000000a9',
        'f1000000-0000-4000-8000-0000000000a2', 'human', '{f1000000-0000-4000-8000-0000000000a9}', 'accounts', '{}');
select pg_temp.expect_error($$select count(*) from public.outbox_events$$, '42501');
select pg_temp.expect_error($$select tx_id from public.outbox_events$$, '42501');
select pg_temp.expect_error($$update public.outbox_events set purpose = 'accounts'$$, '42501');
select pg_temp.expect_error($$delete from public.outbox_events$$, '42501');
select pg_temp.expect_error($$truncate public.outbox_events$$, '42501');
select pg_temp.expect_error($$insert into public.outbox_events (org_id, type, entity_type, entity_id, actor_id, actor_kind, purpose)
  values ('f1000000-0000-4000-8000-000000000000', 'person.deactivated', 'person', 'f1000000-0000-4000-8000-0000000000a9',
          'f1000000-0000-4000-8000-0000000000a2', 'human', 'accounts') returning id$$, '42501');
-- Its position and time are the database's: a writer that chose its tx_id could hide an event
-- below every consumer's checkpoint.
select pg_temp.expect_error($$insert into public.outbox_events (org_id, tx_id, type, entity_type, entity_id, actor_id, actor_kind, purpose)
  values ('f1000000-0000-4000-8000-000000000000', '3', 'person.deactivated', 'person', 'f1000000-0000-4000-8000-0000000000a9',
          'f1000000-0000-4000-8000-0000000000a2', 'human', 'accounts')$$, '42501');
select pg_temp.expect_error($$insert into public.outbox_events (org_id, at, type, entity_type, entity_id, actor_id, actor_kind, purpose)
  values ('f1000000-0000-4000-8000-000000000000', now() - interval '20 days', 'person.deactivated', 'person',
          'f1000000-0000-4000-8000-0000000000a9', 'f1000000-0000-4000-8000-0000000000a2', 'human', 'accounts')$$, '42501');
select pg_temp.expect_error($$insert into public.outbox_events (id, org_id, type, entity_type, entity_id, actor_id, actor_kind, purpose)
  values (1, 'f1000000-0000-4000-8000-000000000000', 'person.deactivated', 'person', 'f1000000-0000-4000-8000-0000000000a9',
          'f1000000-0000-4000-8000-0000000000a2', 'human', 'accounts')$$, '428C9');

-- Adding partitions is the partitions job's (0007), never hearth_app's. With the furthest month
-- dropped (as the superuser), the job's role makes it again, with row level security on and no
-- grants.
select pg_temp.expect_error($$select public.create_data_access_partitions(1)$$, '42501');
reset role;
select set_config('test.partition',
  'data_access_events_' || to_char(date_trunc('month', now() at time zone 'UTC') + interval '12 months', 'YYYY_MM'), true);
do $$ begin execute format('drop table public.%I', current_setting('test.partition')); end $$;
select pg_temp.act_as_job('1', 'hearth_job_partitions');
select public.create_data_access_partitions(12);
reset role;
select pg_temp.check(c.relrowsecurity and c.relacl is null and c.relowner = 'hearth_owner'::regrole,
                     'the partition the job made has row level security off, a grant, or another owner')
from pg_class c where c.oid = to_regclass('public.' || current_setting('test.partition'));
select pg_temp.check(to_regclass('public.' || current_setting('test.partition')) is not null,
                     'the partitions job did not make the missing month');
-- The other job roles may not.
do $$
declare
  r text;
begin
  foreach r in array array['hearth_queue', 'hearth_job_offboarding', 'hearth_job_purge', 'hearth_worker'] loop
    perform set_config('role', r, true);
    perform pg_temp.expect_error('select public.create_data_access_partitions(1)', '42501');
    perform set_config('role', 'none', true);
  end loop;
end
$$;

-- The rows added above are there, unchanged, as the owner sees them.
select pg_temp.check(count(*) = 1, 'the audit row hearth_app added is missing or doubled')
from public.audit_events where action = 'test.added' and request_id = 'req-1';
select pg_temp.check(count(*) = 1, 'the data access row hearth_app added is missing or doubled')
from public.data_access_events where type = 'share' and object_id = 'f-1';
select pg_temp.check(count(*) = 1 and min(actor_id::text) = 'f1000000-0000-4000-8000-0000000000a2'
                     and min(tx_id::text) = pg_current_xact_id()::text and min(at) >= now(),
                     'the outbox event hearth_app added is missing, doubled, or has another actor, position or time')
from public.outbox_events where type = 'person.deactivated' and entity_id = 'f1000000-0000-4000-8000-0000000000a9';
