-- ACC-11, CLAUDE.md Database: a transaction with no org set (or an empty one) sees no row of any
-- table a runtime role can read, and can't write one. Every runtime role (hearth_app, and from
-- 0007 the worker's job roles) and every table in every schema are covered, found from the
-- catalogue (any SELECT, whole-table or on some columns), so a new role or table is checked the
-- day it lands.
\ir fixtures/two_orgs.sql

do $$
declare
  r text;
  t record;
  setting text;
  seen bigint;
  checked bigint := 0;
begin
  perform pg_temp.check(pg_temp.runtime_roles() @> array['hearth_app', 'hearth_queue', 'hearth_job_offboarding',
                                                         'hearth_job_partitions', 'hearth_job_purge',
                                                         'hearth_job_revocation'],
                        format('the runtime roles found are %s', pg_temp.runtime_roles()));
  -- First with app.org_id never set in this session, then set to ''.
  foreach setting in array array['unset', ''] loop
    if setting <> 'unset' then
      perform set_config('app.org_id', setting, true);
    end if;
    foreach r in array pg_temp.runtime_roles() loop
      for t in
        select format('%I.%I', n.nspname, c.relname) as name
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname not like 'pg\_%' and n.nspname <> 'information_schema' and c.relkind in ('r', 'p', 'v', 'm', 'f')
          and has_any_column_privilege(r, c.oid, 'SELECT')
      loop
        perform set_config('role', r, true);
        execute format('select count(*) from %s', t.name) into seen;
        perform set_config('role', 'none', true);
        perform pg_temp.check(seen = 0, format('%s: %s saw %s row(s) with app.org_id %s', t.name, r, seen, setting));
        checked := checked + 1;
      end loop;
    end loop;
  end loop;
  -- hearth_app's tables and the job roles' (feature_flags, jobs, schedules, the outbox, ...).
  perform pg_temp.check(checked > 40, format('only %s table reads were checked', checked));
end
$$;

-- Writes with no org set are refused, and updates and deletes find nothing.
select set_config('app.org_id', '', true), set_config('app.user_id', pg_temp.id('1', 'a1')::text, true);
set local role hearth_app;
select pg_temp.expect_error($$insert into public.teams (org_id, name, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'No org', 'f1000000-0000-4000-8000-0000000000a1')$$, '42501');
select pg_temp.expect_error($$insert into public.audit_events (org_id, action)
  values ('f1000000-0000-4000-8000-000000000000', 'test.no_org')$$, '42501');
select pg_temp.expect_error($$insert into public.data_access_events (org_id, type, subject_id, actor_id)
  values ('f1000000-0000-4000-8000-000000000000', 'export', 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000a8')$$, '42501');
select pg_temp.expect_error($$insert into public.outbox_events (org_id, type, entity_type, entity_id, actor_id, actor_kind, purpose)
  values ('f1000000-0000-4000-8000-000000000000', 'person.deactivated', 'person', 'f1000000-0000-4000-8000-0000000000a8',
          'f1000000-0000-4000-8000-0000000000a1', 'human', 'accounts')$$, '42501');
select pg_temp.expect_rows($$update public.teams set name = 'Renamed'$$, 0);
select pg_temp.expect_rows($$update public.people set full_name = 'Renamed'$$, 0);
select pg_temp.expect_rows($$delete from public.working_hours$$, 0);
-- The worker's roles, as Hearth's system principal but with no org: nothing to claim, fire or move.
reset role;
select set_config('app.user_id', pg_temp.id('1', 'a0')::text, true);
set local role hearth_queue;
select pg_temp.expect_error($$insert into public.jobs (org_id, kind, feature_key, purpose)
  values ('f1000000-0000-4000-8000-000000000000', 'test.no_org', 'core.system', 'service_operation')$$, '42501');
select pg_temp.expect_error($$insert into public.schedules (org_id, key, kind, cron, on_interrupt, next_run_at)
  values ('f1000000-0000-4000-8000-000000000000', 'test.no_org', 'test.no_org', '0 * * * *', 'rerun', now())$$, '42501');
select pg_temp.expect_rows($$update public.jobs set run_after = now()$$, 0);
select pg_temp.expect_rows($$update public.schedules set next_run_at = now()$$, 0);
select pg_temp.expect_rows($$update public.schedule_runs set reason = 'test'$$, 0);
reset role;
set local role hearth_job_offboarding;
select pg_temp.expect_error($$insert into public.outbox_checkpoints (org_id, consumer, role_name)
  values ('f1000000-0000-4000-8000-000000000000', 'no_org', 'hearth_job_offboarding')$$, '42501');
select pg_temp.expect_error($$insert into public.jobs (org_id, kind, feature_key, purpose)
  values ('f1000000-0000-4000-8000-000000000000', 'test.no_org', 'core.system', 'accounts')$$, '42501');
select pg_temp.expect_rows($$update public.outbox_checkpoints set processed = processed + 1$$, 0);
reset role;
-- The revocation consumer's role (0008): no checkpoint or job to start, and its own checkpoints
-- out of reach. It starts one in each org first, acting in that org, so the update (which names
-- its consumer, as the consumer's does) has rows it would move if no org meant every org.
select pg_temp.act_as_job('1', 'hearth_job_revocation');
select pg_temp.expect_rows($$insert into public.outbox_checkpoints (org_id, consumer, role_name)
  values ('f1000000-0000-4000-8000-000000000000', 'revocation', 'hearth_job_revocation')$$, 1);
reset role;
select pg_temp.act_as_job('2', 'hearth_job_revocation');
select pg_temp.expect_rows($$insert into public.outbox_checkpoints (org_id, consumer, role_name)
  values ('f2000000-0000-4000-8000-000000000000', 'revocation', 'hearth_job_revocation')$$, 1);
reset role;
select set_config('app.org_id', '', true), set_config('app.user_id', pg_temp.id('1', 'a0')::text, true);
set local role hearth_job_revocation;
select pg_temp.expect_error($$insert into public.outbox_checkpoints (org_id, consumer, role_name)
  values ('f1000000-0000-4000-8000-000000000000', 'revocation', 'hearth_job_revocation')$$, '42501');
select pg_temp.expect_error($$insert into public.jobs (org_id, kind, feature_key, purpose)
  values ('f1000000-0000-4000-8000-000000000000', 'revocation.handler', 'core.system', 'accounts')$$, '42501');
select pg_temp.expect_rows($$update public.outbox_checkpoints set processed = processed + 1 where consumer = 'revocation'$$, 0);
reset role;
-- The registers (0009, C0.9 PR 1): with no org set, the DPO's functions and the transfer gate refuse
-- (42501) rather than act on every org or none silently, and a register row can't be written
-- directly by any runtime role (no grant; the functions are the only writers).
select set_config('app.org_id', '', true), set_config('app.user_id', pg_temp.id('1', 'a5')::text, true);
set local role hearth_app;
select pg_temp.expect_error($$select * from public.set_register_purpose('security_audit', 1, 'planned', null, null, null,
  null, '{}', null, null, null)$$, '42501');
select pg_temp.expect_error($$select * from public.record_transfer_entry('twilio', 1, 'Codes', null, '{}', '{}', null, null,
  null, null, false, null, null, null, null, null, null, false, null, null, null)$$, '42501');
select pg_temp.expect_error($$select * from public.clear_transfer_entry('aws', 2, null, null, null)$$, '42501');
select pg_temp.expect_error($$select * from public.withdraw_transfer_clearance('aws', null, null, null)$$, '42501');
select pg_temp.expect_error($$select public.transfer_cleared('aws')$$, '42501');
select pg_temp.expect_error($$insert into public.processing_register (org_id, purpose, ai, pinned, needs_switch, version, status)
  values ('f1000000-0000-4000-8000-000000000000', 'accounts', false, true, false, 9, 'active')$$, '42501');
select pg_temp.expect_error($$update public.transfer_register set review_on = current_date$$, '42501');
reset role;
select set_config('app.user_id', pg_temp.id('1', 'a0')::text, true);
set local role hearth_queue;
select pg_temp.expect_error($$update public.transfer_register set review_on = current_date$$, '42501');
select pg_temp.expect_error($$insert into public.processing_restrictions (org_id, person_id, purpose, effective_at, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 'presence_receipts', now(),
          'f1000000-0000-4000-8000-0000000000a5')$$, '42501');
reset role;
-- Nothing changed in either fixture org (CI loads the seed's org beside them).
select pg_temp.check(count(*) = 2 * (select count(*) from public.processing_register_defaults()) + 2,
                     format('the registers changed with no org set (%s purpose versions)', count(*)))
from public.processing_register where org_id in (pg_temp.id('1', '00'), pg_temp.id('2', '00'));
select pg_temp.check(count(*) = 2 and bool_and(withdrawn_at is null), 'a clearance changed with no org set')
from public.transfer_clearances where org_id in (pg_temp.id('1', '00'), pg_temp.id('2', '00'));
