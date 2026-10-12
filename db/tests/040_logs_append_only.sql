-- ADM-06, T12, CLAUDE.md Database: audit_events and data_access_events are append-only. hearth_app
-- can add a row for its own org and nothing else: no reading (not even through INSERT ...
-- RETURNING), changing, deleting or emptying them, and no reaching a data_access_events partition
-- directly.
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

-- Adding partitions is the owner's (and later the scheduler's) job.
select pg_temp.expect_error($$select public.create_data_access_partitions(1)$$, '42501');

-- The rows added above are there, unchanged, as the owner sees them.
reset role;
select pg_temp.check(count(*) = 1, 'the audit row hearth_app added is missing or doubled')
from public.audit_events where action = 'test.added' and request_id = 'req-1';
select pg_temp.check(count(*) = 1, 'the data access row hearth_app added is missing or doubled')
from public.data_access_events where type = 'share' and object_id = 'f-1';
