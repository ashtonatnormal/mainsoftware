-- T18, CLAUDE.md Database: the worker's roles (0007). The worker logs in as hearth_worker, which
-- holds nothing itself and takes one job role per transaction; each job role gets only the grants
-- its jobs need. This pins every privilege each job role can use on every table, column, sequence
-- and function, however it got it, as 030 does hearth_app's, so any new grant must be added here on
-- purpose. It also pins who the roles are: hearth_worker NOINHERIT with no privilege of its own and
-- SET (never INHERIT) on exactly the four job roles; each job role NOLOGIN, owning nothing, a
-- member of nothing, and usable by hearth_worker alone. And who may add to the outbox (T16 item
-- 20), and what worker_org_ids() gives whom.
\ir fixtures/two_orgs.sql

-- Every privilege each job role holds, by any route.
select pg_temp.expect_privileges('hearth_queue', array[
  -- The runner and the scheduler: claim, renew, retry, cancel and end jobs; fire schedules and record
  -- their runs (never a run's next attempt after a review, which comes with review_schedule_run()).
  'jobs: SELECT',
  'jobs.feature_key: INSERT', 'jobs.id: INSERT', 'jobs.idempotency_key: INSERT', 'jobs.kind: INSERT',
  'jobs.max_attempts: INSERT', 'jobs.org_id: INSERT', 'jobs.payload: INSERT', 'jobs.purpose: INSERT',
  'jobs.run_after: INSERT', 'jobs.schedule_run_id: INSERT', 'jobs.subject_id: INSERT',
  'jobs.attempts: UPDATE', 'jobs.claimed_by: UPDATE', 'jobs.finished_at: UPDATE', 'jobs.give_backs: UPDATE',
  'jobs.lease_expires_at: UPDATE', 'jobs.lease_token: UPDATE', 'jobs.reason: UPDATE', 'jobs.run_after: UPDATE',
  'jobs.started_at: UPDATE', 'jobs.state: UPDATE',
  'schedules: SELECT',
  'schedules.cron: INSERT', 'schedules.key: INSERT', 'schedules.kind: INSERT', 'schedules.next_run_at: INSERT',
  'schedules.on_interrupt: INSERT', 'schedules.org_id: INSERT', 'schedules.payload: INSERT',
  'schedules.last_fired_at: UPDATE', 'schedules.next_run_at: UPDATE', 'schedules.retired_at: UPDATE',
  'schedule_runs: SELECT',
  'schedule_runs.finished_at: INSERT', 'schedule_runs.id: INSERT', 'schedule_runs.on_interrupt: INSERT',
  'schedule_runs.org_id: INSERT', 'schedule_runs.reason: INSERT', 'schedule_runs.schedule_id: INSERT',
  'schedule_runs.scheduled_for: INSERT', 'schedule_runs.state: INSERT',
  'schedule_runs.finished_at: UPDATE', 'schedule_runs.reason: UPDATE', 'schedule_runs.started_at: UPDATE',
  'schedule_runs.state: UPDATE',
  -- Flags, and what a cohort is checked against: whether the person is still at the org, and their
  -- current roles (people and roles only until C6.8).
  'feature_flags: SELECT',
  'people.deactivated_at: SELECT', 'people.id: SELECT', 'people.org_id: SELECT',
  'role_assignments.org_id: SELECT', 'role_assignments.person_id: SELECT', 'role_assignments.revoked_at: SELECT',
  'role_assignments.role: SELECT',
  -- The outbox's positions and times, never its envelope; the checkpoints and floors.
  'outbox_events.at: SELECT', 'outbox_events.id: SELECT', 'outbox_events.org_id: SELECT', 'outbox_events.tx_id: SELECT',
  'outbox_checkpoints: SELECT', 'outbox_floors: SELECT',
  -- withOrg's system principal.
  'principals.id: SELECT', 'principals.kind: SELECT', 'principals.org_id: SELECT', 'principals.system_key: SELECT',
  'function is_ids_only(jsonb): EXECUTE',
  'function worker_org_ids(): EXECUTE'
]);

select pg_temp.expect_privileges('hearth_job_offboarding', array[
  -- The offboarding consumer: read the outbox, start and move its own checkpoint, read the floors.
  'outbox_events: SELECT', 'outbox_floors: SELECT', 'outbox_checkpoints: SELECT',
  'outbox_checkpoints.consumer: INSERT', 'outbox_checkpoints.last_id: INSERT', 'outbox_checkpoints.last_tx: INSERT',
  'outbox_checkpoints.org_id: INSERT', 'outbox_checkpoints.role_name: INSERT',
  'outbox_checkpoints.last_id: UPDATE', 'outbox_checkpoints.last_tx: UPDATE', 'outbox_checkpoints.processed: UPDATE',
  'outbox_checkpoints.updated_at: UPDATE',
  -- One job per handler, never choosing who made it, its state or its lease.
  'jobs.feature_key: INSERT', 'jobs.id: INSERT', 'jobs.idempotency_key: INSERT', 'jobs.kind: INSERT',
  'jobs.max_attempts: INSERT', 'jobs.org_id: INSERT', 'jobs.payload: INSERT', 'jobs.purpose: INSERT',
  'jobs.run_after: INSERT', 'jobs.subject_id: INSERT',
  -- The re-read: has the person left, and who deactivated them; which sessions a deactivation ended.
  'people.deactivated_at: SELECT', 'people.deactivated_by: SELECT', 'people.id: SELECT', 'people.org_id: SELECT',
  'sessions.id: SELECT', 'sessions.org_id: SELECT', 'sessions.revoke_reason: SELECT', 'sessions.user_id: SELECT',
  'principals.id: SELECT', 'principals.kind: SELECT', 'principals.org_id: SELECT', 'principals.system_key: SELECT',
  'function feature_fence(text,bigint[]): EXECUTE',
  'function is_ids_only(jsonb): EXECUTE',
  'function job_fence(uuid,uuid,bigint[]): EXECUTE',
  'function job_finish(uuid,uuid,bigint[]): EXECUTE'
]);

select pg_temp.expect_privileges('hearth_job_partitions', array[
  'principals.id: SELECT', 'principals.kind: SELECT', 'principals.org_id: SELECT', 'principals.system_key: SELECT',
  'function create_data_access_partitions(integer): EXECUTE',
  'function job_fence(uuid,uuid,bigint[]): EXECUTE',
  'function job_finish(uuid,uuid,bigint[]): EXECUTE'
]);

select pg_temp.expect_privileges('hearth_job_purge', array[
  'principals.id: SELECT', 'principals.kind: SELECT', 'principals.org_id: SELECT', 'principals.system_key: SELECT',
  'function job_fence(uuid,uuid,bigint[]): EXECUTE',
  'function job_finish(uuid,uuid,bigint[]): EXECUTE',
  'function purge_jobs(integer): EXECUTE',
  'function purge_outbox(integer): EXECUTE',
  'function purge_schedule_runs(integer): EXECUTE'
]);

-- hearth_worker can use nothing until it takes a job role: no privilege of its own, none inherited.
select pg_temp.expect_privileges('hearth_worker', '{}');

-- None of them can create anything: no schema, no object in one, no temporary table.
select pg_temp.check(not exists (
  select 1 from unnest(array['hearth_worker', 'hearth_queue', 'hearth_job_offboarding', 'hearth_job_partitions',
                             'hearth_job_purge']) r
  where has_database_privilege(r, current_database(), 'CREATE') or has_database_privilege(r, current_database(), 'TEMPORARY')
     or exists (select 1 from pg_namespace n
                where n.nspname not like 'pg\_%' and n.nspname <> 'information_schema' and has_schema_privilege(r, n.oid, 'CREATE'))),
  'a worker role can create a schema, an object in one, or a temporary table');

-- hearth_worker: NOINHERIT, with no power, and a member, by SET and never INHERIT or ADMIN, of
-- exactly the four job roles (and on RDS of rds_iam, if that has no powers and belongs to nothing).
-- Whether it can log in is set outside migrations (scripts/db-local.sh locally, IAM on RDS).
select pg_temp.check(not (rolinherit or rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication),
                     'hearth_worker inherits, or has a power it must not have')
from pg_roles where rolname = 'hearth_worker';
select pg_temp.check(
  coalesce((select array_agg(distinct format('%s %s%s%s', g.rolname, case when m.admin_option then 'A' end,
                                             case when m.inherit_option then 'I' end, case when m.set_option then 'S' end))
            from pg_auth_members m join pg_roles g on g.oid = m.roleid
            where m.member = 'hearth_worker'::regrole
              and not (g.rolname = 'rds_iam' and not g.rolsuper and not g.rolbypassrls
                       and not exists (select 1 from pg_auth_members x where x.member = g.oid))), '{}')
  = array['hearth_job_offboarding S', 'hearth_job_partitions S', 'hearth_job_purge S', 'hearth_queue S'],
  'hearth_worker holds a role other than the four job roles, or holds one by INHERIT or ADMIN');
-- Nobody may act as hearth_worker; its creator keeps only Postgres's ADMIN-only grant.
select pg_temp.check(
  coalesce((select array_agg(distinct format('%s %s%s%s', x.rolname, case when m.admin_option then 'A' end,
                                             case when m.inherit_option then 'I' end, case when m.set_option then 'S' end))
            from pg_auth_members m join pg_roles x on x.oid = m.member
            where m.roleid = 'hearth_worker'::regrole), '{}')
  <@ array['hearth_owner A'],
  'someone may act as hearth_worker');

-- Each job role: NOLOGIN and powerless, a member of nothing, usable by hearth_worker alone (SET),
-- beside its creator's ADMIN-only grant, and owning nothing.
do $$
declare
  job text;
  r pg_roles%rowtype;
  members text[];
begin
  foreach job in array array['hearth_queue', 'hearth_job_offboarding', 'hearth_job_partitions', 'hearth_job_purge'] loop
    select * into r from pg_roles where rolname = job;
    perform pg_temp.check(found, format('%s does not exist', job));
    perform pg_temp.check(not (r.rolcanlogin or r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication),
                          format('%s can log in or has a power it must not have', job));
    perform pg_temp.check(not exists (select 1 from pg_auth_members m where m.member = r.oid),
                          format('%s is a member of another role', job));
    select array_agg(distinct format('%s %s%s%s', x.rolname, case when m.admin_option then 'A' end,
                                     case when m.inherit_option then 'I' end, case when m.set_option then 'S' end)
                     order by format('%s %s%s%s', x.rolname, case when m.admin_option then 'A' end,
                                     case when m.inherit_option then 'I' end, case when m.set_option then 'S' end))
      into members
    from pg_auth_members m join pg_roles x on x.oid = m.member
    where m.roleid = r.oid;
    perform pg_temp.check(members = array['hearth_owner A', 'hearth_worker S'],
                          format('who may act as %s: %s (only hearth_worker, by SET; its creator ADMIN only)', job, members));
    perform pg_temp.check(not exists (select 1 from pg_class c where c.relowner = r.oid)
                          and not exists (select 1 from pg_proc p where p.proowner = r.oid)
                          and not exists (select 1 from pg_namespace n where n.nspowner = r.oid)
                          and not exists (select 1 from pg_type t where t.typowner = r.oid)
                          and (select datdba from pg_database where datname = current_database()) <> r.oid,
                          format('%s owns something', job));
  end loop;
end
$$;

-- Who may add to the outbox (T16 item 20): exactly hearth_app, by any route (a grant, a role it
-- inherits, or one it can SET), and none of them skips row level security. A later step that lets
-- a job append (C2.1's overdue job, A1's transcript jobs) adds its role here in its own migration;
-- the Rule 9 role (C1.11) never may. The owner, superusers and Postgres's own roles aside.
select pg_temp.check(
  coalesce((select array_agg(r.rolname::text order by r.rolname)
            from pg_roles r
            where not r.rolsuper and r.rolname <> 'hearth_owner' and r.rolname not like 'pg\_%'
              and not pg_has_role(r.oid, 'hearth_owner', 'USAGE') and not pg_has_role(r.oid, 'hearth_owner', 'SET')
              and exists (select 1 from pg_roles h
                          where has_any_column_privilege(h.oid, 'public.outbox_events', 'INSERT')
                            and pg_has_role(r.oid, h.oid, 'SET'))), '{}')
  = array['hearth_app'],
  'a role other than hearth_app may add to the outbox');
select pg_temp.check(not exists (
  select 1 from pg_roles r
  where has_any_column_privilege(r.oid, 'public.outbox_events', 'INSERT') and r.rolbypassrls and r.rolname <> 'hearth_owner'
    and not r.rolsuper),
  'a role that may add to the outbox skips row level security');

-- worker_org_ids() (T18): to hearth_queue, the id of every org and nothing else, whatever org the
-- transaction has set; ids only. Nobody else may call it, hearth_worker itself included.
select set_config('test.orgs', (select array_agg(id order by id)::text from public.orgs), true);
select pg_temp.check(current_setting('test.orgs')::uuid[] @> array[pg_temp.id('1', '00'), pg_temp.id('2', '00')],
                     'the fixture orgs are missing');
select pg_temp.check(pg_get_function_result('public.worker_org_ids()'::regprocedure) = 'SETOF uuid',
                     'worker_org_ids returns more than ids');
select set_config('app.org_id', '', true), set_config('app.user_id', '', true);
set local role hearth_queue;
select pg_temp.check((select array_agg(x order by x)::text from public.worker_org_ids() x) = current_setting('test.orgs'),
                     'worker_org_ids did not return every org with no org set');
reset role;
select pg_temp.act_as_job('2', 'hearth_queue');
select pg_temp.check((select array_agg(x order by x)::text from public.worker_org_ids() x) = current_setting('test.orgs'),
                     'worker_org_ids used the org set in the transaction');
reset role;
do $$
declare
  r text;
begin
  foreach r in array array['hearth_app', 'hearth_worker', 'hearth_job_offboarding', 'hearth_job_partitions', 'hearth_job_purge'] loop
    perform set_config('role', r, true);
    perform pg_temp.expect_error('select count(*) from public.worker_org_ids()', '42501');
    perform set_config('role', 'none', true);
  end loop;
end
$$;
