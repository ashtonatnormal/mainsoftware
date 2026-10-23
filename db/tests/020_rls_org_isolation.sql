-- ACC-11, CLAUDE.md Database: acting in one org, every runtime role (hearth_app, and from 0007 the
-- worker's job roles) sees exactly that org's rows of every table it can read (none of the other
-- org's), and can't write, change or delete the other org's. The fixture has a row of every table
-- in both orgs, so a table missing from it fails here. (015 pins the policies' text, which covers
-- the write side for every table.)
\ir fixtures/two_orgs.sql

do $$
declare
  r text;
  t record;
  o text;
  key text;
  own bigint;
  seen bigint;
  other bigint;
begin
  foreach r in array pg_temp.runtime_roles() loop
    foreach o in array array['1', '2'] loop
      for t in
        select format('%I.%I', n.nspname, c.relname) as name, c.relname
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname not like 'pg\_%' and n.nspname <> 'information_schema' and c.relkind in ('r', 'p', 'v', 'm', 'f')
          and has_any_column_privilege(r, c.oid, 'SELECT')
      loop
        key := case t.name when 'public.orgs' then 'id' else 'org_id' end;
        execute format('select count(*) from %s where %I = $1', t.name, key) into own using pg_temp.id(o, '00');
        perform pg_temp.check(own > 0, format('%s: the fixture has no row in org %s; add one to db/tests/fixtures/two_orgs.sql', t.name, o));
        -- hearth_app as the Owner; a job role as Hearth's system principal, as the worker acts.
        if r = 'hearth_app' then
          perform pg_temp.act_as(o, 'a1');
        else
          perform pg_temp.act_as_job(o, r);
        end if;
        execute format('select count(*), count(*) filter (where %I <> $1) from %s', key, t.name)
          into seen, other using pg_temp.id(o, '00');
        perform set_config('role', 'none', true);
        perform pg_temp.check(other = 0, format('%s: acting in org %s, %s saw %s row(s) of another org', t.name, o, r, other));
        perform pg_temp.check(seen = own, format('%s: acting in org %s, %s saw %s of its %s row(s)', t.name, o, r, seen, own));
      end loop;
    end loop;
  end loop;
end
$$;

-- Acting in org 2, nothing of org 1's can be added, changed or removed. Updates and deletes name
-- no row, so only the policy limits them to org 2.
select pg_temp.act_as('2', 'a1');
select pg_temp.expect_error($$insert into public.teams (org_id, name, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'Planted', 'f1000000-0000-4000-8000-0000000000a1')$$, '42501');
select pg_temp.expect_error($$insert into public.principals (org_id, kind)
  values ('f1000000-0000-4000-8000-000000000000', 'human')$$, '42501');
select pg_temp.expect_error($$insert into public.sessions (org_id, user_id, device_id, token_hash, expires_at)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000e1',
          sha256('a token chosen in another org'), now() + interval '1 day')$$, '42501');
select pg_temp.expect_error($$insert into public.passkeys (org_id, user_id, credential_id, public_key, backed_up)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8',
          decode(md5('planted credential'), 'hex'), decode(md5('a') || md5('b'), 'hex'), false)$$, '42501');
select pg_temp.expect_error($$insert into public.audit_events (org_id, action)
  values ('f1000000-0000-4000-8000-000000000000', 'test.planted')$$, '42501');
select pg_temp.expect_error($$insert into public.data_access_events (org_id, type, subject_id, actor_id)
  values ('f1000000-0000-4000-8000-000000000000', 'export', 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000a8')$$, '42501');
select pg_temp.expect_rows($$update public.teams set name = name || ' (renamed)'$$, 2);
select pg_temp.expect_rows($$update public.people set full_name = full_name || ' (renamed)'$$, 10);
select pg_temp.expect_rows($$update public.sessions set last_seen_at = now()$$, 1);
select pg_temp.expect_rows($$update public.passkeys set last_used_at = now()$$, 1);
select pg_temp.expect_rows($$delete from public.working_hours$$, 1);
reset role;
select pg_temp.check(count(*) = 0, 'an org 2 update reached org 1')
from public.people where org_id = 'f1000000-0000-4000-8000-000000000000' and full_name like '%(renamed)';
select pg_temp.check(count(*) = 1, 'an org 2 delete reached org 1')
from public.working_hours where org_id = 'f1000000-0000-4000-8000-000000000000';
select pg_temp.check(count(*) = 0, 'an org 2 update reached an org 1 passkey')
from public.passkeys where org_id = 'f1000000-0000-4000-8000-000000000000' and last_used_at is not null;

-- The same for the outbox and the worker's tables (0007): acting in org 2, no event, job, schedule,
-- run or checkpoint of org 1's can be added, and changes reach only org 2's rows.
select pg_temp.act_as('2', 'a1');
select pg_temp.expect_error($$insert into public.outbox_events (org_id, type, entity_type, entity_id, actor_id, actor_kind, purpose)
  values ('f1000000-0000-4000-8000-000000000000', 'person.deactivated', 'person', 'f1000000-0000-4000-8000-0000000000a8',
          'f2000000-0000-4000-8000-0000000000a1', 'human', 'accounts')$$, '42501');
reset role;
select pg_temp.act_as_job('2', 'hearth_queue');
select pg_temp.expect_error($$insert into public.jobs (org_id, kind, feature_key, purpose)
  values ('f1000000-0000-4000-8000-000000000000', 'test.planted', 'core.system', 'service_operation')$$, '42501');
select pg_temp.expect_error($$insert into public.schedules (org_id, key, kind, cron, on_interrupt, next_run_at)
  values ('f1000000-0000-4000-8000-000000000000', 'test.planted', 'test.planted', '0 * * * *', 'rerun', now())$$, '42501');
select pg_temp.expect_error($$insert into public.schedule_runs (org_id, schedule_id, scheduled_for, on_interrupt)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000b1', now(), 'review')$$, '42501');
select pg_temp.expect_rows($$update public.jobs set run_after = now() + interval '1 hour'$$, 2);
select pg_temp.expect_rows($$update public.schedules set next_run_at = now() + interval '2 hours'$$, 1);
select pg_temp.expect_rows($$update public.schedule_runs set reason = 'moved'$$, 1);
reset role;
select pg_temp.act_as_job('2', 'hearth_job_offboarding');
select pg_temp.expect_error($$insert into public.outbox_checkpoints (org_id, consumer, role_name)
  values ('f1000000-0000-4000-8000-000000000000', 'planted', 'hearth_job_offboarding')$$, '42501');
select pg_temp.expect_rows($$update public.outbox_checkpoints set processed = processed + 1$$, 1);
reset role;
select pg_temp.check(count(*) = 0, 'an org 2 update reached an org 1 job')
from public.jobs where org_id = 'f1000000-0000-4000-8000-000000000000' and run_after > now();
select pg_temp.check(count(*) = 1, 'an org 2 update reached an org 1 schedule')
from public.schedules where org_id = 'f1000000-0000-4000-8000-000000000000' and next_run_at = now() + interval '1 hour';
select pg_temp.check(count(*) = 0, 'an org 2 update reached an org 1 schedule run')
from public.schedule_runs where org_id = 'f1000000-0000-4000-8000-000000000000' and reason = 'moved';
select pg_temp.check(count(*) = 1, 'an org 2 update reached an org 1 checkpoint')
from public.outbox_checkpoints where org_id = 'f1000000-0000-4000-8000-000000000000' and processed = 0;
-- The revocation consumer's role (0008), acting in org 2: it can't start org 1's checkpoint, starts
-- and moves its own, and an update that doesn't name its consumer reaches offboarding's org 2 row,
-- which only offboarding's role may move (outbox_checkpoints_own_row, 42501). Org 1 has its own
-- revocation checkpoint first, started by the role acting in org 1, so the update that names the
-- consumer has another org's row it could reach. After the checks above, so they still see one
-- checkpoint per org.
select pg_temp.act_as_job('1', 'hearth_job_revocation');
select pg_temp.expect_rows($$insert into public.outbox_checkpoints (org_id, consumer, role_name)
  values ('f1000000-0000-4000-8000-000000000000', 'revocation', 'hearth_job_revocation')$$, 1);
reset role;
select pg_temp.act_as_job('2', 'hearth_job_revocation');
select pg_temp.expect_error($$insert into public.outbox_checkpoints (org_id, consumer, role_name)
  values ('f1000000-0000-4000-8000-000000000000', 'revocation', 'hearth_job_revocation')$$, '42501');
select pg_temp.expect_rows($$insert into public.outbox_checkpoints (org_id, consumer, role_name)
  values ('f2000000-0000-4000-8000-000000000000', 'revocation', 'hearth_job_revocation')$$, 1);
select pg_temp.expect_rows($$update public.outbox_checkpoints set processed = processed + 1 where consumer = 'revocation'$$, 1);
select pg_temp.expect_error($$update public.outbox_checkpoints set processed = processed + 1$$, '42501',
                            '%Only the role that runs a consumer%');
reset role;
select pg_temp.check(count(*) = 1 and min(processed) = 0, 'an org 2 insert or update reached org 1''s revocation checkpoint')
from public.outbox_checkpoints where org_id = 'f1000000-0000-4000-8000-000000000000' and consumer = 'revocation';
select pg_temp.check(count(*) = 1 and min(processed) = 1, 'the revocation role did not move exactly its own org 2 checkpoint')
from public.outbox_checkpoints where org_id = 'f2000000-0000-4000-8000-000000000000' and consumer = 'revocation';

-- A row can't point at another org's row: foreign keys between org-scoped tables include
-- org_id. (As the superuser, so only the foreign key stands in the way.)
select pg_temp.expect_error($$insert into public.team_memberships (org_id, team_id, person_id, created_by)
  values ('f2000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000d1', 'f2000000-0000-4000-8000-0000000000a8', 'f2000000-0000-4000-8000-0000000000a1')$$,
  '23503', '%team_memberships_org_id_team_id_fkey%');
select pg_temp.expect_error($$update public.people set manager_id = 'f1000000-0000-4000-8000-0000000000a1'
  where id = 'f2000000-0000-4000-8000-0000000000a8'$$, '23503', '%people_org_id_manager_id_fkey%');
select pg_temp.expect_error($$insert into public.audit_events (org_id, actor_id, action)
  values ('f2000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a1', 'test.cross_org')$$,
  '23503', '%audit_events_org_id_actor_id_fkey%');
select pg_temp.expect_error($$insert into public.data_access_events (org_id, type, subject_id, actor_id)
  values ('f2000000-0000-4000-8000-000000000000', 'export', 'f1000000-0000-4000-8000-0000000000a8', 'f2000000-0000-4000-8000-0000000000a8')$$,
  '23503', '%data_access_events_org_id_subject_id_fkey%');
-- A person can't take an id that is a human principal of another org (a fresh one, so nothing
-- else about it is wrong).
insert into public.principals (id, org_id, kind) values ('f1000000-0000-4000-8000-0000000000ad', 'f1000000-0000-4000-8000-000000000000', 'human');
select pg_temp.expect_error($$insert into public.people (id, org_id, full_name, created_by)
  values ('f1000000-0000-4000-8000-0000000000ad', 'f2000000-0000-4000-8000-000000000000', 'Borrowed id', 'f2000000-0000-4000-8000-0000000000a1')$$,
  '23503', '%people_org_id_id_principal_kind_fkey%');

-- The registers (0009, C0.9 PR 1). Their functions are SECURITY DEFINER, so row level security
-- doesn't hold them; each filters by the org the server set itself. Acting in org 2 as its DPO, a
-- purpose change, a withdrawal and the transfer gate reach only org 2's rows, and org 1's DPO
-- named in an org 2 transaction is refused (42501).
select pg_temp.act_as('2', 'a5');
select pg_temp.check(changed and version = 2, 'org 2''s DPO could not record security_audit')
from public.set_register_purpose('security_audit', 1, 'active', 'legitimate_interests', 'Assessment file 7', null,
                                 '12 months', '{aws}', 'req-isolation', null, null);
select pg_temp.check(changed and not cleared, 'org 2''s DPO could not withdraw aws')
from public.withdraw_transfer_clearance('aws', 'req-isolation', null, null);
select pg_temp.check(not public.transfer_cleared('aws'), 'org 2 still reads aws as cleared');
reset role;
select set_config('app.org_id', pg_temp.id('2', '00')::text, true), set_config('app.user_id', pg_temp.id('1', 'a5')::text, true);
set local role hearth_app;
select pg_temp.expect_error($$select * from public.withdraw_transfer_clearance('aws', null, null, null)$$, '42501');
select pg_temp.expect_error($$select * from public.set_register_purpose('backups', 1, 'planned', null, null, null, null, '{}',
  null, null, null)$$, '42501');
reset role;
select pg_temp.act_as('1', 'a1');
select pg_temp.check(public.transfer_cleared('aws'), 'org 2''s withdrawal reached org 1''s aws');
reset role;
select pg_temp.check(count(*) = 1, 'org 2''s purpose change reached org 1')
from public.processing_register where org_id = pg_temp.id('1', '00') and purpose = 'security_audit';
select pg_temp.check(count(*) = 1 and bool_and(withdrawn_at is null), 'org 2''s withdrawal reached org 1''s clearance')
from public.transfer_clearances where org_id = pg_temp.id('1', '00');
select pg_temp.check(count(*) = 0, 'org 2''s changes wrote an audit row in org 1')
from public.audit_events where org_id = pg_temp.id('1', '00') and action like 'register.%';

-- No register row can point at another org's: a clearance of org 1's entry recorded in org 2, or a
-- withdrawal by org 1's person recorded in org 2 (as the superuser, so only the checks stand in the
-- way).
select pg_temp.expect_error($$insert into public.transfer_clearances (org_id, entry_id, cleared_by, cleared_via)
  select 'f2000000-0000-4000-8000-000000000000', t.id, 'f2000000-0000-4000-8000-0000000000a5', 'app'
  from public.transfer_register t where t.org_id = 'f1000000-0000-4000-8000-000000000000' and t.provider = 'twilio'$$,
  '23503');
select pg_temp.expect_error($$insert into public.processing_restrictions (org_id, person_id, purpose, effective_at, created_by)
  values ('f2000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a7', 'presence_receipts', now(),
          'f2000000-0000-4000-8000-0000000000a5')$$, '23503', '%processing_restrictions_org_id_person_id_fkey%');
select pg_temp.expect_error($$insert into public.processing_register (org_id, purpose, ai, pinned, needs_switch, version, status,
  basis, retention, recorded_by)
  values ('f2000000-0000-4000-8000-000000000000', 'backups', false, false, false, 2, 'active', 'employment', '35 days',
          'f1000000-0000-4000-8000-0000000000a5')$$, '23503', '%processing_register_org_id_recorded_by_fkey%');
