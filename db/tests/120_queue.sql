-- INF-QUEUE, T15, CLAUDE.md Database: the job queue (0007). Only the worker's roles queue jobs in
-- C0.6, never choosing who made one; a job's state, lease and attempts hold together; a job commits
-- its effect only while its feature is on, at the revisions the worker checked, and while it still
-- holds the lease (job_fence, job_finish), which only the roles jobs run as may call; finished jobs
-- leave only through purge_jobs(). Every case runs as hearth_app or the job role it tests unless it
-- says it arranges data as the superuser.
\ir fixtures/two_orgs.sql

-- Test flags in org 1 (as the superuser): t above t.child, both on and unlocked, at revision 1. A
-- running job on t.child holds lease c1 (j1); one on core.system belongs to a schedule run (j2).
insert into public.feature_flags (org_id, key, enabled, locked)
values (pg_temp.id('1', '00'), 't', true, false), (pg_temp.id('1', '00'), 't.child', true, false),
       (pg_temp.id('2', '00'), 't', true, false), (pg_temp.id('2', '00'), 't.child', true, false);
select set_config('app.user_id', pg_temp.id('1', 'a0')::text, true);
insert into public.jobs (id, org_id, kind, feature_key, purpose, state, attempts, lease_token, lease_expires_at, claimed_by, started_at)
values (pg_temp.id('1', 'c3'), pg_temp.id('1', '00'), 'test.effect', 't.child', 'service_operation', 'running', 1,
        pg_temp.id('1', 'c1'), now() + interval '30 seconds', 'test', now());
insert into public.schedules (id, org_id, key, kind, cron, on_interrupt, next_run_at)
values (pg_temp.id('1', 'c4'), pg_temp.id('1', '00'), 'test.nightly', 'test.nightly', '17 3 * * *', 'rerun', now() + interval '1 day');
insert into public.schedule_runs (id, org_id, schedule_id, scheduled_for, on_interrupt, state, started_at)
values (pg_temp.id('1', 'c5'), pg_temp.id('1', '00'), pg_temp.id('1', 'c4'), now(), 'rerun', 'running', now());
insert into public.jobs (id, org_id, kind, feature_key, purpose, state, attempts, lease_token, lease_expires_at, claimed_by,
                         started_at, schedule_run_id)
values (pg_temp.id('1', 'c6'), pg_temp.id('1', '00'), 'test.nightly', 'core.system', 'service_operation', 'running', 1,
        pg_temp.id('1', 'c2'), now() + interval '30 seconds', 'test', now(), pg_temp.id('1', 'c5'));
select set_config('app.user_id', '', true);

-- 1. hearth_app can't queue, read, change or delete a job (42501): the first api producer (C0.14)
-- adds that grant with a check of which role may queue which kind.
select pg_temp.act_as('1', 'a1');
select pg_temp.expect_error($$insert into public.jobs (org_id, kind, feature_key, purpose)
  values ('f1000000-0000-4000-8000-000000000000', 'test.api', 'core.system', 'accounts')$$, '42501');
select pg_temp.expect_error($$insert into public.jobs (org_id, kind, feature_key, purpose)
  values ('f1000000-0000-4000-8000-000000000000', 'test.api', 'core.system', 'accounts') on conflict do nothing$$, '42501');
select pg_temp.expect_error($$select count(*) from public.jobs$$, '42501');
select pg_temp.expect_error($$update public.jobs set run_after = now()$$, '42501');
select pg_temp.expect_error($$delete from public.jobs$$, '42501');
reset role;

-- 2. The worker's roles queue jobs; created_by is the principal the transaction acts as (Hearth),
-- which neither may choose (42501). The offboarding role, which can't read jobs, queues by key with
-- ON CONFLICT DO NOTHING, which needs only INSERT: the same key twice makes one job.
select pg_temp.act_as_job('1', 'hearth_queue');
select pg_temp.expect_rows($$insert into public.jobs (id, org_id, kind, feature_key, purpose, payload)
  values ('f1000000-0000-4000-8000-0000000000c7', 'f1000000-0000-4000-8000-000000000000', 'test.queued', 'core.system',
          'service_operation', '{"run": "f1000000-0000-4000-8000-0000000000c5"}')$$, 1);
select pg_temp.check(created_by = pg_temp.id('1', 'a0') and state = 'queued' and attempts = 0 and give_backs = 0
                     and lease_token is null and finished_at is null and run_after <= now(),
                     'a new job does not start queued, unleased and made by Hearth')
from public.jobs where id = pg_temp.id('1', 'c7');
select pg_temp.expect_error($$insert into public.jobs (org_id, kind, feature_key, purpose, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'test.queued', 'core.system', 'service_operation',
          'f1000000-0000-4000-8000-0000000000a1')$$, '42501');
select pg_temp.expect_error($$insert into public.jobs (org_id, kind, feature_key, purpose, state)
  values ('f1000000-0000-4000-8000-000000000000', 'test.queued', 'core.system', 'service_operation', 'succeeded')$$, '42501');
reset role;
select pg_temp.act_as_job('1', 'hearth_job_offboarding');
select pg_temp.expect_rows($$insert into public.jobs (org_id, kind, feature_key, purpose, subject_id, payload, idempotency_key, max_attempts)
  values ('f1000000-0000-4000-8000-000000000000', 'offboarding.handler', 'core.system', 'accounts',
          'f1000000-0000-4000-8000-0000000000a9', '{"person": "f1000000-0000-4000-8000-0000000000a9", "handler": "sockets"}',
          'f1000000-0000-4000-8000-0000000000a9:sockets', 10) on conflict do nothing$$, 1);
select pg_temp.expect_rows($$insert into public.jobs (org_id, kind, feature_key, purpose, subject_id, payload, idempotency_key, max_attempts)
  values ('f1000000-0000-4000-8000-000000000000', 'offboarding.handler', 'core.system', 'accounts',
          'f1000000-0000-4000-8000-0000000000a9', '{"person": "f1000000-0000-4000-8000-0000000000a9", "handler": "sockets"}',
          'f1000000-0000-4000-8000-0000000000a9:sockets', 10) on conflict do nothing$$, 0);
select pg_temp.expect_error($$insert into public.jobs (org_id, kind, feature_key, purpose, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'offboarding.handler', 'core.system', 'accounts',
          'f1000000-0000-4000-8000-0000000000a5')$$, '42501');
select pg_temp.expect_error($$select count(*) from public.jobs$$, '42501');
select pg_temp.expect_error($$update public.jobs set run_after = now()$$, '42501');
reset role;
select pg_temp.check(count(*) = 1 and min(created_by::text) = pg_temp.id('1', 'a0')::text,
                     'the same key queued two jobs, or one not made by Hearth')
from public.jobs where idempotency_key = 'f1000000-0000-4000-8000-0000000000a9:sockets';
-- The same key in another org, or for another kind, is another job.
select pg_temp.act_as_job('2', 'hearth_job_offboarding');
select pg_temp.expect_rows($$insert into public.jobs (org_id, kind, feature_key, purpose, idempotency_key)
  values ('f2000000-0000-4000-8000-000000000000', 'offboarding.handler', 'core.system', 'accounts',
          'f1000000-0000-4000-8000-0000000000a9:sockets') on conflict do nothing$$, 1);
reset role;
select pg_temp.act_as_job('1', 'hearth_queue');
select pg_temp.expect_rows($$insert into public.jobs (org_id, kind, feature_key, purpose, idempotency_key)
  values ('f1000000-0000-4000-8000-000000000000', 'test.other', 'core.system', 'service_operation',
          'f1000000-0000-4000-8000-0000000000a9:sockets') on conflict do nothing$$, 1);

-- R2E2E-1: a key is ids and codes joined by ':', so free text (someone's details) is refused (23514).
select pg_temp.expect_error($$insert into public.jobs (org_id, kind, feature_key, purpose, idempotency_key)
  values ('f1000000-0000-4000-8000-000000000000', 'test.other', 'core.system', 'service_operation',
          'Priya Nair, +65 9123 4567, resigned')$$, '23514', '%jobs_idempotency_key_check%');
select pg_temp.expect_error($$insert into public.jobs (org_id, kind, feature_key, purpose, idempotency_key)
  values ('f1000000-0000-4000-8000-000000000000', 'test.other', 'core.system', 'service_operation',
          'reminder:Buy milk')$$, '23514', '%jobs_idempotency_key_check%');
-- Each part is a code or a uuid, so neither a slug of someone's details nor a phone number passes.
select pg_temp.expect_error($$insert into public.jobs (org_id, kind, feature_key, purpose, idempotency_key)
  values ('f1000000-0000-4000-8000-000000000000', 'test.other', 'core.system', 'service_operation',
          'priya-nair-resigned')$$, '23514', '%jobs_idempotency_key_check%');
select pg_temp.expect_error($$insert into public.jobs (org_id, kind, feature_key, purpose, idempotency_key)
  values ('f1000000-0000-4000-8000-000000000000', 'test.other', 'core.system', 'service_operation',
          'run:6591234567')$$, '23514', '%jobs_idempotency_key_check%');

-- 3. A job names a feature that has a flag in its org (23503), a person of its org (23503), and a
-- payload of ids only (23514).
select pg_temp.expect_error($$insert into public.jobs (org_id, kind, feature_key, purpose)
  values ('f1000000-0000-4000-8000-000000000000', 'test.queued', 'no.such_flag', 'service_operation')$$, '23503',
  '%jobs_org_id_feature_key_fkey%');
select pg_temp.expect_error($$insert into public.jobs (org_id, kind, feature_key, purpose, subject_id)
  values ('f1000000-0000-4000-8000-000000000000', 'test.queued', 'core.system', 'service_operation',
          'f2000000-0000-4000-8000-0000000000a8')$$, '23503', '%jobs_org_id_subject_id_fkey%');
select pg_temp.expect_error($$insert into public.jobs (org_id, kind, feature_key, purpose, payload)
  values ('f1000000-0000-4000-8000-000000000000', 'test.queued', 'core.system', 'service_operation',
          '{"note": "Call Mel on +6591234567"}')$$, '23514', '%jobs_payload_ids_only%');
-- Free text as a key is refused too (SQL-1).
select pg_temp.expect_error($$insert into public.jobs (org_id, kind, feature_key, purpose, payload)
  values ('f1000000-0000-4000-8000-000000000000', 'test.queued', 'core.system', 'service_operation',
          '{"Call Mel on +6591234567": true}')$$, '23514', '%jobs_payload_ids_only%');
select pg_temp.expect_error($$insert into public.jobs (org_id, kind, feature_key, purpose)
  values ('f1000000-0000-4000-8000-000000000000', 'nodot', 'core.system', 'service_operation')$$, '23514');

-- 4. hearth_queue moves jobs through their states, and the states hold together (23514): running
-- only under a lease that expires; finished exactly when succeeded, dead or cancelled; dead and
-- cancelled with a reason; never more attempts than allowed.
select pg_temp.expect_error($$update public.jobs set state = 'running' where id = 'f1000000-0000-4000-8000-0000000000c7'$$,
  '23514', '%jobs_lease%');
select pg_temp.expect_error($$update public.jobs set state = 'running', lease_token = gen_random_uuid()
  where id = 'f1000000-0000-4000-8000-0000000000c7'$$, '23514', '%jobs_lease%');
select pg_temp.expect_error($$update public.jobs set state = 'dead', reason = 'job_mismatch'
  where id = 'f1000000-0000-4000-8000-0000000000c7'$$, '23514', '%jobs_finished%');
select pg_temp.expect_error($$update public.jobs set state = 'cancelled', finished_at = now()
  where id = 'f1000000-0000-4000-8000-0000000000c7'$$, '23514', '%jobs_reason%');
select pg_temp.expect_error($$update public.jobs set attempts = 6 where id = 'f1000000-0000-4000-8000-0000000000c7'$$, '23514');
select pg_temp.expect_error($$update public.jobs set give_backs = 1001 where id = 'f1000000-0000-4000-8000-0000000000c7'$$, '23514');
-- A claim, a renewal, then a retry: legal moves pass.
select pg_temp.expect_rows($$update public.jobs set state = 'running', attempts = attempts + 1, lease_token = gen_random_uuid(),
  lease_expires_at = now() + interval '30 seconds', started_at = now(), claimed_by = 'worker-1'
  where id = 'f1000000-0000-4000-8000-0000000000c7' and state = 'queued'$$, 1);
select pg_temp.expect_rows($$update public.jobs set lease_expires_at = now() + interval '30 seconds'
  where id = 'f1000000-0000-4000-8000-0000000000c7' and state = 'running'$$, 1);
select pg_temp.expect_rows($$update public.jobs set state = 'queued', lease_token = null, lease_expires_at = null, reason = 'retry',
  run_after = now() + interval '5 seconds' where id = 'f1000000-0000-4000-8000-0000000000c7'$$, 1);
-- It can't change what a job is, or who made it (42501).
select pg_temp.expect_error($$update public.jobs set kind = 'test.other' where id = 'f1000000-0000-4000-8000-0000000000c7'$$, '42501');
select pg_temp.expect_error($$update public.jobs set feature_key = 't' where id = 'f1000000-0000-4000-8000-0000000000c7'$$, '42501');
select pg_temp.expect_error($$update public.jobs set payload = '{}' where id = 'f1000000-0000-4000-8000-0000000000c7'$$, '42501');
select pg_temp.expect_error($$update public.jobs set created_by = 'f1000000-0000-4000-8000-0000000000a1'
  where id = 'f1000000-0000-4000-8000-0000000000c7'$$, '42501');
select pg_temp.expect_error($$delete from public.jobs where id = 'f1000000-0000-4000-8000-0000000000c7'$$, '42501');
reset role;

-- 5. job_fence: the right lease and the flags at the revisions the worker saw (t, then t.child)
-- pass, and lock the job until the transaction ends. A wrong lease, a job that isn't running, or
-- another org's job: HF002. The flag or a flag above it off, a revision moved on, or the wrong
-- number of revisions: HF001.
select pg_temp.act_as_job('1', 'hearth_job_offboarding');
select public.job_fence(pg_temp.id('1', 'c3'), pg_temp.id('1', 'c1'), '{1,1}');
select pg_temp.expect_error($$select public.job_fence('f1000000-0000-4000-8000-0000000000c3', gen_random_uuid(), '{1,1}')$$, 'HF002');
select pg_temp.expect_error($$select public.job_fence('f1000000-0000-4000-8000-0000000000b3', gen_random_uuid(), '{1}')$$, 'HF002');
select pg_temp.expect_error($$select public.job_fence('f2000000-0000-4000-8000-0000000000b4', 'f2000000-0000-4000-8000-0000000000b5', '{1}')$$,
  'HF002');
select pg_temp.expect_error($$select public.job_fence(gen_random_uuid(), gen_random_uuid(), '{1}')$$, 'HF002');
select pg_temp.expect_error($$select public.job_fence('f1000000-0000-4000-8000-0000000000c3', 'f1000000-0000-4000-8000-0000000000c1', '{1}')$$,
  'HF001', '%changed since%');
select pg_temp.expect_error($$select public.job_fence('f1000000-0000-4000-8000-0000000000c3', 'f1000000-0000-4000-8000-0000000000c1', null)$$,
  'HF001', '%changed since%');
reset role;
-- (That the fence's locks make a flag change or a lease sweep wait is check-concurrency.ts's to show.)
-- A revision moved on (a cohort narrowed, say, as the superuser stands in for set_feature_flag()).
update public.feature_flags set revision = 2, updated_by = pg_temp.id('1', 'a1')
where org_id = pg_temp.id('1', '00') and key = 't.child';
select pg_temp.act_as_job('1', 'hearth_job_offboarding');
select pg_temp.expect_error($$select public.job_fence('f1000000-0000-4000-8000-0000000000c3', 'f1000000-0000-4000-8000-0000000000c1', '{1,1}')$$,
  'HF001', '%changed since%');
select public.job_fence(pg_temp.id('1', 'c3'), pg_temp.id('1', 'c1'), '{1,2}');
reset role;
-- A flag above it switched off; then the feature itself.
update public.feature_flags set enabled = false, revision = 2, updated_by = pg_temp.id('1', 'a1')
where org_id = pg_temp.id('1', '00') and key = 't';
select pg_temp.act_as_job('1', 'hearth_job_offboarding');
select pg_temp.expect_error($$select public.job_fence('f1000000-0000-4000-8000-0000000000c3', 'f1000000-0000-4000-8000-0000000000c1', '{2,2}')$$,
  'HF001', '%switched off (t)%');
reset role;
update public.feature_flags set enabled = true, revision = 3 where org_id = pg_temp.id('1', '00') and key = 't';
update public.feature_flags set enabled = false, revision = 3 where org_id = pg_temp.id('1', '00') and key = 't.child';
select pg_temp.act_as_job('1', 'hearth_job_offboarding');
select pg_temp.expect_error($$select public.job_fence('f1000000-0000-4000-8000-0000000000c3', 'f1000000-0000-4000-8000-0000000000c1', '{3,3}')$$,
  'HF001', '%switched off (t.child)%');
reset role;
update public.feature_flags set enabled = true, revision = 4 where org_id = pg_temp.id('1', '00') and key = 't.child';

-- 6. Only the roles jobs run as may fence or finish a job; hearth_app, hearth_queue and
-- hearth_worker may not (42501). feature_fence and job_fence need an org (42501).
do $$
declare
  r text;
begin
  foreach r in array array['hearth_app', 'hearth_queue', 'hearth_worker'] loop
    perform pg_temp.act_as_job('1', r);
    perform pg_temp.expect_error($f$select public.job_fence('f1000000-0000-4000-8000-0000000000c3', 'f1000000-0000-4000-8000-0000000000c1', '{3,4}')$f$, '42501');
    perform pg_temp.expect_error($f$select public.job_finish('f1000000-0000-4000-8000-0000000000c3', 'f1000000-0000-4000-8000-0000000000c1', '{3,4}')$f$, '42501');
    perform pg_temp.expect_error($f$select public.feature_fence('core.system', '{1}')$f$, '42501');
    perform set_config('role', 'none', true);
  end loop;
  foreach r in array array['hearth_job_partitions', 'hearth_job_purge'] loop
    perform pg_temp.act_as_job('1', r);
    perform public.job_fence(pg_temp.id('1', 'c3'), pg_temp.id('1', 'c1'), '{3,4}');
    perform pg_temp.expect_error($f$select public.feature_fence('core.system', '{1}')$f$, '42501');
    perform set_config('role', 'none', true);
  end loop;
end
$$;
select set_config('app.org_id', '', true), set_config('app.user_id', pg_temp.id('1', 'a0')::text, true);
set local role hearth_job_offboarding;
select pg_temp.expect_error($$select public.feature_fence('core.system', '{1}')$$, '42501');
select pg_temp.expect_error($$select public.job_fence('f1000000-0000-4000-8000-0000000000c3', 'f1000000-0000-4000-8000-0000000000c1', '{3,4}')$$, '42501');
select pg_temp.expect_error($$select public.job_finish('f1000000-0000-4000-8000-0000000000c3', 'f1000000-0000-4000-8000-0000000000c1', '{3,4}')$$, '42501');
reset role;

-- 7. job_finish ends the job (succeeded, lease gone) and its schedule run in one go, and a second
-- finish, or one under a lease that has gone, is refused (HF002).
select pg_temp.act_as_job('1', 'hearth_job_purge');
select public.job_finish(pg_temp.id('1', 'c6'), pg_temp.id('1', 'c2'), '{1}');
select pg_temp.expect_error($$select public.job_finish('f1000000-0000-4000-8000-0000000000c6', 'f1000000-0000-4000-8000-0000000000c2', '{1}')$$,
  'HF002');
select public.job_finish(pg_temp.id('1', 'c3'), pg_temp.id('1', 'c1'), '{3,4}');
reset role;
select pg_temp.check(j.state = 'succeeded' and j.finished_at is not null and j.lease_token is null and j.lease_expires_at is null
                     and r.state = 'succeeded' and r.finished_at is not null,
                     'job_finish did not end the job and its run')
from public.jobs j join public.schedule_runs r on r.id = j.schedule_run_id
where j.id = pg_temp.id('1', 'c6');
select pg_temp.check(state = 'succeeded', 'job_finish did not end a job with no run') from public.jobs where id = pg_temp.id('1', 'c3');
-- Another org's job can't be finished from org 1, even with its lease (HF002), and is unchanged.
select pg_temp.act_as_job('1', 'hearth_job_purge');
select pg_temp.expect_error($$select public.job_finish('f2000000-0000-4000-8000-0000000000b4', 'f2000000-0000-4000-8000-0000000000b5', '{1}')$$,
  'HF002');
reset role;
select pg_temp.check(state = 'running', 'another org''s job was finished') from public.jobs where id = pg_temp.id('2', 'b4');

-- 8. purge_jobs(): succeeded and cancelled jobs go 14 days after they finished, dead ones after
-- 30; queued and running jobs, younger finished ones and a dead one 15 days old stay. One audit
-- row per batch, with Hearth acting. Arranged as the superuser.
select set_config('app.user_id', pg_temp.id('1', 'a0')::text, true);
insert into public.jobs (org_id, kind, feature_key, purpose, state, attempts, reason, started_at, finished_at, payload)
select pg_temp.id('1', '00'), 'test.old', 'core.system', 'service_operation', s.state, 1, s.reason, now() - s.age, now() - s.age,
       jsonb_build_object('name', s.name)
from (values ('succeeded_15', 'succeeded', null, interval '15 days'), ('cancelled_15', 'cancelled', 'flag_off', interval '15 days'),
             ('dead_31', 'dead', 'job_mismatch', interval '31 days'), ('dead_15', 'dead', 'job_mismatch', interval '15 days'),
             ('succeeded_13', 'succeeded', null, interval '13 days')) as s (name, state, reason, age);
insert into public.jobs (org_id, kind, feature_key, purpose, run_after, created_at, payload)
values (pg_temp.id('1', '00'), 'test.old', 'core.system', 'service_operation', now() - interval '40 days', now() - interval '40 days',
        '{"name": "queued_40"}');
select set_config('app.user_id', pg_temp.id('2', 'a0')::text, true);
insert into public.jobs (org_id, kind, feature_key, purpose, state, attempts, reason, started_at, finished_at, payload)
values (pg_temp.id('2', '00'), 'test.old', 'core.system', 'service_operation', 'succeeded', 1, null, now() - interval '20 days',
        now() - interval '20 days', '{"name": "other_org"}');
select set_config('app.user_id', '', true);
select set_config('test.audit_max', (select coalesce(max(id), 0)::text from public.audit_events), true);
-- Only Hearth itself cleans up (SQL-4): with a person (the DPO) or another org's Hearth as the
-- transaction's principal, the purge job's role is refused (42501), so the audit row can't name them.
select set_config('app.org_id', pg_temp.id('1', '00')::text, true), set_config('app.user_id', pg_temp.id('1', 'a5')::text, true);
set local role hearth_job_purge;
select pg_temp.expect_error($$select public.purge_jobs(10)$$, '42501', 'Only Hearth itself cleans up%');
reset role;
select set_config('app.user_id', pg_temp.id('2', 'a0')::text, true);
set local role hearth_job_purge;
select pg_temp.expect_error($$select public.purge_jobs(10)$$, '42501', 'Only Hearth itself cleans up%');
reset role;
select pg_temp.act_as_job('1', 'hearth_job_purge');
select pg_temp.expect_error($$select public.purge_jobs(0)$$, '22023');
select pg_temp.expect_error($$select public.purge_jobs(10001)$$, '22023');
select pg_temp.check(public.purge_jobs(2) = 2, 'the first batch did not delete two jobs');
select pg_temp.check(public.purge_jobs(5000) = 1, 'the second batch did not delete the last one');
select pg_temp.check(public.purge_jobs(5000) = 0, 'a third batch deleted something');
select pg_temp.expect_error($$delete from public.jobs$$, '42501');
reset role;
select pg_temp.check(coalesce(array_agg(payload ->> 'name' order by payload ->> 'name'), '{}')
                     = array['dead_15', 'other_org', 'queued_40', 'succeeded_13'],
                     format('purge_jobs left %s', array_agg(payload ->> 'name' order by payload ->> 'name')))
from public.jobs where kind = 'test.old';
select pg_temp.check(array_agg(format('%s %s %s %s %s', org_id = pg_temp.id('1', '00'), action, actor_id = pg_temp.id('1', 'a0'),
                                       target_type, details ->> 'rows') order by id)
                     = array['t maintenance.purge t jobs 2', 't maintenance.purge t jobs 1'],
                     format('purge_jobs did not write one audit row per batch, with Hearth acting: %s', array_agg(details order by id)))
from public.audit_events where id > current_setting('test.audit_max')::bigint;
select set_config('app.org_id', '', true), set_config('app.user_id', pg_temp.id('1', 'a0')::text, true);
set local role hearth_job_purge;
select pg_temp.expect_error($$select public.purge_jobs(10)$$, '42501');
reset role;
do $$
declare
  r text;
begin
  foreach r in array array['hearth_app', 'hearth_queue', 'hearth_job_offboarding', 'hearth_job_partitions', 'hearth_worker'] loop
    perform pg_temp.act_as_job('1', r);
    perform pg_temp.expect_error('select public.purge_jobs(10)', '42501');
    perform set_config('role', 'none', true);
  end loop;
end
$$;
