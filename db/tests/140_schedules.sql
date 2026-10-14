-- INF-SCHED, T15, AGT-10, CLAUDE.md Database: schedules and their runs (0007). A schedule's key
-- never changes what it runs or how, and a retired one stays retired; one run per occurrence and
-- attempt; only a review schedule's run can be interrupted, and it waits for a person (the decision
-- function comes with A4 or A5.4); hearth_queue writes only in its org; runs leave only through
-- purge_schedule_runs(), never one still waiting for review. Every case runs as hearth_app or the
-- job role it tests unless it says it arranges data as the superuser.
\ir fixtures/two_orgs.sql

-- A rerun schedule in org 1 (c1), as the superuser.
insert into public.schedules (id, org_id, key, kind, cron, on_interrupt, next_run_at)
values (pg_temp.id('1', 'c1'), pg_temp.id('1', '00'), 'test.nightly', 'test.nightly', '17 3 * * *', 'rerun', now() + interval '1 day');

-- 1. A run's states hold together (23514), checked as the superuser so only the table stands in
-- the way: only a review run can be interrupted, resumed or dismissed; resumed and dismissed (and
-- only they) carry who decided and when; failed, skipped and interrupted runs say why; a finished
-- run has finished_at and an open one hasn't; only a later attempt resumes a run.
create function pg_temp.run(schedule text, state text, extra text default '') returns text language sql as $$
  select format($r$insert into public.schedule_runs (org_id, schedule_id, scheduled_for, on_interrupt, state, reason, finished_at%s)
    values ('f1000000-0000-4000-8000-000000000000', %L, now() - interval '1 hour',
            (select on_interrupt from public.schedules where id = %L), %L,
            case when %L in ('failed', 'skipped', 'interrupted') then 'crash' end,
            case when %L not in ('queued', 'running') then now() end%s)$r$,
    case when extra = '' then '' else ', ' || split_part(extra, '=', 1) end,
    pg_temp.id('1', schedule), pg_temp.id('1', schedule), state, state, state,
    case when extra = '' then '' else ', ' || split_part(extra, '=', 2) end)
$$;
select pg_temp.expect_error(pg_temp.run('c1', 'interrupted'), '23514', '%schedule_runs_review_only%');
select pg_temp.expect_error(pg_temp.run('c1', 'resumed', $x$reviewed_at, reviewed_by=now(), 'f1000000-0000-4000-8000-0000000000a1'$x$),
                            '23514', '%schedule_runs_review_only%');
select pg_temp.expect_error(pg_temp.run('b1', 'dismissed'), '23514', '%schedule_runs_reviewed%');
select pg_temp.expect_error(pg_temp.run('b1', 'interrupted', $x$reviewed_at, reviewed_by=now(), 'f1000000-0000-4000-8000-0000000000a1'$x$),
                            '23514', '%schedule_runs_reviewed%');
select pg_temp.expect_error(pg_temp.run('b1', 'dismissed', $x$reviewed_at=now()$x$), '23514');
select pg_temp.expect_error($$insert into public.schedule_runs (org_id, schedule_id, scheduled_for, on_interrupt, state, finished_at)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000c1', now(), 'rerun', 'failed', now())$$,
  '23514', '%schedule_runs_reason%');
select pg_temp.expect_error($$insert into public.schedule_runs (org_id, schedule_id, scheduled_for, on_interrupt, state)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000c1', now(), 'rerun', 'succeeded')$$,
  '23514', '%schedule_runs_finished%');
select pg_temp.expect_error($$insert into public.schedule_runs (org_id, schedule_id, scheduled_for, on_interrupt, finished_at)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000c1', now(), 'rerun', now())$$,
  '23514', '%schedule_runs_finished%');
select pg_temp.expect_error($$insert into public.schedule_runs (org_id, schedule_id, scheduled_for, on_interrupt, resumed_from)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000b1', now(), 'review',
          'f1000000-0000-4000-8000-0000000000b2')$$, '23514');
select pg_temp.expect_error($$insert into public.schedule_runs (org_id, schedule_id, scheduled_for, on_interrupt, attempt)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000c1', now(), 'rerun', 1001)$$, '23514');
-- A run belongs to a schedule of its own org (23503).
select pg_temp.expect_error($$insert into public.schedule_runs (org_id, schedule_id, scheduled_for, on_interrupt)
  values ('f2000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000c1', now(), 'rerun')$$, '23503');
-- One run per occurrence and attempt (23505), so two schedulers firing at once make one.
insert into public.schedule_runs (org_id, schedule_id, scheduled_for, on_interrupt)
values (pg_temp.id('1', '00'), pg_temp.id('1', 'c1'), '2026-10-01 03:17:00+00', 'rerun');
select pg_temp.expect_error($$insert into public.schedule_runs (org_id, schedule_id, scheduled_for, on_interrupt)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000c1', '2026-10-01 03:17:00+00', 'rerun')$$, '23505');

-- 2. A person's decision on an interrupted run (as A4's or A5.4's review_schedule_run() will make
-- it; the superuser stands in): resumed, the next attempt names the run it resumes, once (23505);
-- and who decided and when can't change afterwards (23514).
update public.schedule_runs set state = 'resumed', reviewed_at = now(), reviewed_by = pg_temp.id('1', 'a1'),
  review_note = 'Checked the notes; run it again.'
where id = pg_temp.id('1', 'b2');
insert into public.schedule_runs (id, org_id, schedule_id, scheduled_for, attempt, on_interrupt, resumed_from)
select pg_temp.id('1', 'c2'), org_id, schedule_id, scheduled_for, 2, on_interrupt, id from public.schedule_runs where id = pg_temp.id('1', 'b2');
select pg_temp.expect_error($$insert into public.schedule_runs (org_id, schedule_id, scheduled_for, attempt, on_interrupt, resumed_from)
  select org_id, schedule_id, scheduled_for, 3, on_interrupt, id from public.schedule_runs
  where id = 'f1000000-0000-4000-8000-0000000000b2'$$, '23505', '%schedule_runs_resumed_once%');
select pg_temp.expect_error($$update public.schedule_runs set reviewed_by = 'f1000000-0000-4000-8000-0000000000a2'
  where id = 'f1000000-0000-4000-8000-0000000000b2'$$, '23514');
select pg_temp.expect_error($$update public.schedule_runs set reviewed_at = now() - interval '1 day'
  where id = 'f1000000-0000-4000-8000-0000000000b2'$$, '23514');

-- 3. origin is 'registry' only until A5 widens it (23514).
select pg_temp.expect_error($$insert into public.schedules (org_id, key, origin, kind, cron, on_interrupt, next_run_at)
  values ('f1000000-0000-4000-8000-000000000000', 'test.people_made', 'person', 'test.digest', '0 9 * * 1', 'review', now())$$,
  '23514');

-- 4. hearth_queue, the scheduler: adds schedules and runs in its own org only (42501 for another),
-- moves a schedule's times and retires it, and moves a run through its states; it never changes
-- what a key runs or how (kind, cron, payload, policy, key or origin), never un-retires a key
-- (23514), never stores text in a payload (23514), never deletes, never records a review decision
-- or a run's next attempt (42501: those come with review_schedule_run()).
select pg_temp.act_as_job('1', 'hearth_queue');
select pg_temp.expect_rows($$insert into public.schedules (org_id, key, kind, cron, on_interrupt, payload, next_run_at)
  values ('f1000000-0000-4000-8000-000000000000', 'maintenance.purge', 'maintenance.purge', '47 3 * * *', 'rerun', '{}',
          now() + interval '1 day')$$, 1);
select pg_temp.expect_rows($$insert into public.schedules (org_id, key, kind, cron, on_interrupt, next_run_at)
  values ('f1000000-0000-4000-8000-000000000000', 'maintenance.purge', 'maintenance.purge', '47 3 * * *', 'rerun', now())
  on conflict do nothing$$, 0);
select pg_temp.expect_error($$insert into public.schedules (org_id, key, kind, cron, on_interrupt, next_run_at)
  values ('f2000000-0000-4000-8000-000000000000', 'maintenance.purge', 'maintenance.purge', '47 3 * * *', 'rerun', now())$$, '42501');
select pg_temp.expect_error($$insert into public.schedules (org_id, key, kind, cron, on_interrupt, payload, next_run_at)
  values ('f1000000-0000-4000-8000-000000000000', 'test.texty', 'test.texty', '0 * * * *', 'rerun', '{"note": "Remind Mel"}', now())$$,
  '23514', '%schedules_payload_ids_only%');
-- Free text as a key is refused too (SQL-1).
select pg_temp.expect_error($$insert into public.schedules (org_id, key, kind, cron, on_interrupt, payload, next_run_at)
  values ('f1000000-0000-4000-8000-000000000000', 'test.texty', 'test.texty', '0 * * * *', 'rerun', '{"Remind Mel": true}', now())$$,
  '23514', '%schedules_payload_ids_only%');
select pg_temp.expect_error($$insert into public.schedules (org_id, key, kind, cron, on_interrupt, next_run_at)
  values ('f1000000-0000-4000-8000-000000000000', 'test.bad_cron', 'test.bad_cron', 'every day', 'rerun', now())$$, '23514');
select pg_temp.expect_error($$insert into public.schedules (org_id, key, origin, kind, cron, on_interrupt, next_run_at)
  values ('f1000000-0000-4000-8000-000000000000', 'test.origin', 'registry', 'test.origin', '0 * * * *', 'rerun', now())$$, '42501');
select pg_temp.expect_rows($$update public.schedules set next_run_at = now() + interval '1 hour', last_fired_at = now()
  where key = 'test.nightly'$$, 1);
do $$
declare
  change text;
begin
  foreach change in array array[$c$kind = 'test.other'$c$, $c$cron = '0 * * * *'$c$, $c$payload = '{}'$c$,
                                $c$on_interrupt = 'review'$c$, $c$key = 'test.renamed'$c$, $c$origin = 'registry'$c$] loop
    perform pg_temp.expect_error(format('update public.schedules set %s where key = %L', change, 'test.nightly'), '42501');
  end loop;
end
$$;
select pg_temp.expect_error($$delete from public.schedules where key = 'test.nightly'$$, '42501');
select pg_temp.expect_rows($$update public.schedules set retired_at = now() where key = 'test.nightly'$$, 1);
select pg_temp.expect_error($$update public.schedules set retired_at = null where key = 'test.nightly'$$, '23514');
select pg_temp.expect_error($$update public.schedules set retired_at = now() - interval '1 day' where key = 'test.nightly'$$, '23514');
-- Runs: a firing (one per occurrence: the same one again adds nothing), its start and its end.
select pg_temp.expect_rows($$insert into public.schedule_runs (id, org_id, schedule_id, scheduled_for, on_interrupt)
  values ('f1000000-0000-4000-8000-0000000000c3', 'f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000c1',
          '2026-10-02 03:17:00+00', 'rerun')$$, 1);
select pg_temp.expect_rows($$insert into public.schedule_runs (org_id, schedule_id, scheduled_for, on_interrupt)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000c1', '2026-10-02 03:17:00+00', 'rerun')
  on conflict do nothing$$, 0);
select pg_temp.expect_rows($$insert into public.schedule_runs (org_id, schedule_id, scheduled_for, on_interrupt, state, reason, finished_at)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000b1', '2026-10-02 04:00:00+00', 'review',
          'skipped', 'flag_off', now())$$, 1);
select pg_temp.expect_rows($$update public.schedule_runs set state = 'running', started_at = now()
  where id = 'f1000000-0000-4000-8000-0000000000c3'$$, 1);
select pg_temp.expect_rows($$update public.schedule_runs set state = 'succeeded', finished_at = now()
  where id = 'f1000000-0000-4000-8000-0000000000c3'$$, 1);
select pg_temp.expect_error($$insert into public.schedule_runs (org_id, schedule_id, scheduled_for, on_interrupt)
  values ('f2000000-0000-4000-8000-000000000000', 'f2000000-0000-4000-8000-0000000000b1', now(), 'review')$$, '42501');
select pg_temp.expect_error($$insert into public.schedule_runs (org_id, schedule_id, scheduled_for, attempt, on_interrupt)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000c1', '2026-10-03 03:17:00+00', 2, 'rerun')$$,
  '42501');
select pg_temp.expect_error($$insert into public.schedule_runs (org_id, schedule_id, scheduled_for, on_interrupt, resumed_from)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000b1', '2026-10-03 03:00:00+00', 'review',
          'f1000000-0000-4000-8000-0000000000c2')$$, '42501');
select pg_temp.expect_error($$update public.schedule_runs set reviewed_at = now(), reviewed_by = 'f1000000-0000-4000-8000-0000000000a0'
  where id = 'f1000000-0000-4000-8000-0000000000c2'$$, '42501');
select pg_temp.expect_error($$update public.schedule_runs set review_note = 'Looks fine' where id = 'f1000000-0000-4000-8000-0000000000c2'$$,
  '42501');
select pg_temp.expect_error($$update public.schedule_runs set schedule_id = 'f1000000-0000-4000-8000-0000000000b1'
  where id = 'f1000000-0000-4000-8000-0000000000c3'$$, '42501');
select pg_temp.expect_error($$delete from public.schedule_runs$$, '42501');
-- A rerun run that's cut short goes back to the queue; it can't be left interrupted (23514).
select pg_temp.expect_error($$update public.schedule_runs set state = 'interrupted', reason = 'crash', finished_at = now()
  where id = 'f1000000-0000-4000-8000-0000000000c3'$$, '23514', '%schedule_runs_review_only%');
reset role;

-- 5. hearth_app and the other job roles can't touch schedules or runs (42501).
do $$
declare
  r text;
begin
  foreach r in array array['hearth_app', 'hearth_job_offboarding', 'hearth_job_partitions', 'hearth_job_purge', 'hearth_worker'] loop
    perform pg_temp.act_as_job('1', r);
    perform pg_temp.expect_error('select count(*) from public.schedules', '42501');
    perform pg_temp.expect_error('select count(*) from public.schedule_runs', '42501');
    perform pg_temp.expect_error($s$update public.schedules set next_run_at = now()$s$, '42501');
    perform pg_temp.expect_error($s$insert into public.schedule_runs (org_id, schedule_id, scheduled_for, on_interrupt)
      values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000c1', now(), 'rerun')$s$, '42501');
    perform set_config('role', 'none', true);
  end loop;
end
$$;

-- 6. purge_schedule_runs(): runs finished more than 90 days ago (succeeded, failed, skipped), and
-- decided ones 90 days after the decision, go; a run still waiting for review stays however old,
-- and so does a resumed one whose next attempt hasn't been made, and anything younger. A job that
-- belonged to a purged run keeps going without it. Arranged as the superuser.
delete from public.schedule_runs where org_id = pg_temp.id('1', '00') and id not in (pg_temp.id('1', 'b2'), pg_temp.id('1', 'c2'));
insert into public.schedule_runs (org_id, schedule_id, scheduled_for, attempt, on_interrupt, state, reason, started_at, finished_at,
                                  reviewed_at, reviewed_by)
select pg_temp.id('1', '00'), pg_temp.id('1', r.schedule), now() - r.age - interval '1 hour' + (r.n || ' minutes')::interval, 1,
       case r.schedule when 'b1' then 'review' else 'rerun' end, r.state,
       case when r.state in ('failed', 'skipped', 'interrupted') then 'crash' end, now() - r.age, now() - r.age,
       case when r.state in ('resumed', 'dismissed') then now() - r.reviewed end,
       case when r.state in ('resumed', 'dismissed') then pg_temp.id('1', 'a1') end
from (values (1, 'c1', 'succeeded', interval '91 days', null::interval), (2, 'c1', 'failed', interval '91 days', null),
             (3, 'b1', 'skipped', interval '91 days', null), (4, 'c1', 'succeeded', interval '89 days', null),
             (5, 'b1', 'interrupted', interval '200 days', null), (6, 'b1', 'dismissed', interval '200 days', interval '91 days'),
             (7, 'b1', 'dismissed', interval '200 days', interval '10 days'), (8, 'b1', 'resumed', interval '200 days', interval '91 days'))
  as r (n, schedule, state, age, reviewed);
-- The fixture's resumed run b2 (decided above, today) is made old too, so b2 goes (its next attempt
-- c2 exists) while run 8, resumed long ago with no next attempt, stays. Its decision is backdated
-- with triggers off for the one statement, since keep_history refuses to move it.
update public.schedule_runs set finished_at = now() - interval '200 days' where id = pg_temp.id('1', 'b2');
set local session_replication_role = replica;
update public.schedule_runs set reviewed_at = now() - interval '100 days' where id = pg_temp.id('1', 'b2');
set local session_replication_role = origin;
select set_config('app.user_id', pg_temp.id('1', 'a0')::text, true);
insert into public.jobs (id, org_id, kind, feature_key, purpose, schedule_run_id)
select pg_temp.id('1', 'c9'), pg_temp.id('1', '00'), 'test.nightly', 'core.system', 'service_operation', r.id
from public.schedule_runs r where r.org_id = pg_temp.id('1', '00') and r.state = 'succeeded' and r.finished_at < now() - interval '90 days';
select set_config('app.user_id', '', true);
select set_config('test.audit_max', (select coalesce(max(id), 0)::text from public.audit_events), true);
-- Only Hearth itself cleans up (SQL-4): with a person (the DPO) or another org's Hearth as the
-- transaction's principal, the purge job's role is refused (42501), so the audit row can't name them.
select set_config('app.org_id', pg_temp.id('1', '00')::text, true), set_config('app.user_id', pg_temp.id('1', 'a5')::text, true);
set local role hearth_job_purge;
select pg_temp.expect_error($$select public.purge_schedule_runs(10)$$, '42501', 'Only Hearth itself cleans up%');
reset role;
select set_config('app.user_id', pg_temp.id('2', 'a0')::text, true);
set local role hearth_job_purge;
select pg_temp.expect_error($$select public.purge_schedule_runs(10)$$, '42501', 'Only Hearth itself cleans up%');
reset role;
select pg_temp.act_as_job('1', 'hearth_job_purge');
select pg_temp.expect_error($$select public.purge_schedule_runs(0)$$, '22023');
select pg_temp.expect_error($$select public.purge_schedule_runs(10001)$$, '22023');
select pg_temp.check(public.purge_schedule_runs(3) = 3, 'the first batch did not delete three runs');
select pg_temp.check(public.purge_schedule_runs(5000) = 2, 'the second batch did not delete the other two');
select pg_temp.check(public.purge_schedule_runs(5000) = 0, 'a third batch deleted something');
reset role;
select pg_temp.check(coalesce(array_agg(format('%s %s', state, case when id = pg_temp.id('1', 'c2') then 'c2' else
                                                 extract(day from now() - finished_at)::int::text end) order by state, finished_at), '{}')
                     = array['dismissed 200', 'interrupted 200', 'queued c2', 'resumed 200', 'succeeded 89'],
                     format('purge_schedule_runs left %s', array_agg(format('%s %s', state, finished_at) order by state, finished_at)))
from public.schedule_runs where org_id = pg_temp.id('1', '00');
select pg_temp.check(resumed_from is null, 'the next attempt still names the purged run it resumed')
from public.schedule_runs where id = pg_temp.id('1', 'c2');
select pg_temp.check(schedule_run_id is null, 'the job still names its purged run') from public.jobs where id = pg_temp.id('1', 'c9');
select pg_temp.check((select count(*) from public.schedule_runs where org_id = pg_temp.id('2', '00')) = 1, 'the purge reached another org');
select pg_temp.check(array_agg(format('%s %s %s', action, actor_id = pg_temp.id('1', 'a0'), details ->> 'rows') order by id)
                     = array['maintenance.purge t 3', 'maintenance.purge t 2'],
                     'purge_schedule_runs did not write one audit row per batch, with Hearth acting')
from public.audit_events where id > current_setting('test.audit_max')::bigint and target_type = 'schedule_runs';
select set_config('app.org_id', '', true), set_config('app.user_id', pg_temp.id('1', 'a0')::text, true);
set local role hearth_job_purge;
select pg_temp.expect_error($$select public.purge_schedule_runs(10)$$, '42501');
reset role;
do $$
declare
  r text;
begin
  foreach r in array array['hearth_app', 'hearth_queue', 'hearth_job_offboarding', 'hearth_job_partitions', 'hearth_worker'] loop
    perform pg_temp.act_as_job('1', r);
    perform pg_temp.expect_error('select public.purge_schedule_runs(10)', '42501');
    perform set_config('role', 'none', true);
  end loop;
end
$$;
