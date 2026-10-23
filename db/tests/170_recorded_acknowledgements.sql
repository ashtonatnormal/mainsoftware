-- PDPA-03, ACC-12, ADM-06, TECH-SPEC T22 item 43 (C0.9 PR 3a, OD-19): acknowledgements the DPO
-- records (0011). hearth_app records only through record_notice_acknowledgement() (RAD-01); only
-- the DPO who is still at the org records (RAD-02), never for themselves or someone who has left,
-- and only for the org's own people (RAD-03) and its latest version (RAD-04); the day runs from the
-- version's publication day to today in the org's zone, and the note is one line (RAD-05); a record
-- keeps the day and the note, with one audit row that names the day and never the note (RAD-06);
-- once per person and version, whoever acknowledged first (RAD-07); and the table's new checks
-- (RAD-08). Org 1's latest version is the fixture's stand-in e3. Every case runs as hearth_app
-- (act_as), the owner or the role it tests unless it says it arranges data as the superuser. The
-- notes are made up.
\ir fixtures/two_orgs.sql

-- Today in the transaction's org's time zone.
create function pg_temp.today() returns date language sql as $$
  select (now() at time zone o.time_zone)::date from public.orgs o where o.id = current_setting('app.org_id')::uuid
$$;
-- record_notice_acknowledgement with the request's details (the device a plain id), as the api's
-- route calls it.
create function pg_temp.record(person uuid, notice uuid, on_day date, note text)
returns table (version integer, changed boolean) language sql as $$
  select * from public.record_notice_acknowledgement(person, notice, on_day, note, 'req-record',
                                                     'd0000000-0000-4000-8000-0000000000d3', '192.0.2.60')
$$;
-- acknowledge_notice with the request's details, as the api's route calls it.
create function pg_temp.ack(notice uuid, device uuid) returns table (version integer, changed boolean) language sql as $$
  select * from public.acknowledge_notice(notice, 'req-ack', device, '192.0.2.61')
$$;
-- The sources publish_notice() derives (as 160 has them): each active or retired non-AI purpose's
-- key and current version, in key order, and each open non-AI clearance's id.
create function pg_temp.sources(out keys text[], out versions integer[], out clearances uuid[]) language sql as $$
  with cur as (
    select distinct on (r.purpose) r.purpose, r.version, r.status
    from public.processing_register r
    where r.org_id = current_setting('app.org_id')::uuid and not r.ai
    order by r.purpose, r.version desc)
  select array(select c.purpose from cur c where c.status <> 'planned' order by c.purpose),
         array(select c.version from cur c where c.status <> 'planned' order by c.purpose),
         array(select x.id from public.transfer_clearances x join public.transfer_register t on t.id = x.entry_id
               where x.org_id = current_setting('app.org_id')::uuid and x.withdrawn_at is null and not t.ai order by x.id)
$$;
-- The org's latest version, as hearth_app reads it.
create function pg_temp.latest(out id uuid, out version integer) language sql as $$
  select v.id, v.version from public.notice_versions v
  where v.org_id = current_setting('app.org_id')::uuid order by v.version desc limit 1
$$;

-- RAD-01 (CLAUDE.md, Database; C0.9 PD-42): hearth_app records through the function, and still adds
-- no acknowledgement itself (0010) nor changes the day or the note of one (42501); the worker's
-- roles can't run it.
select pg_temp.check(has_function_privilege('hearth_app', 'public.record_notice_acknowledgement(uuid,uuid,date,text,text,uuid,inet)',
                                            'EXECUTE')
                     and not has_any_column_privilege('hearth_app', 'public.notice_acknowledgments', 'INSERT')
                     and not has_any_column_privilege('hearth_app', 'public.notice_acknowledgments', 'UPDATE')
                     and has_column_privilege('hearth_app', 'public.notice_acknowledgments', 'acknowledged_on', 'SELECT')
                     and has_column_privilege('hearth_app', 'public.notice_acknowledgments', 'recorded_note', 'SELECT'),
                     'hearth_app can''t record through the function, writes acknowledgements itself, or can''t read the day and note');
select pg_temp.act_as('1', 'a5');
select pg_temp.expect_error($$insert into public.notice_acknowledgments (org_id, person_id, notice_version_id, method, recorded_by,
  acknowledged_on, recorded_note)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a7', 'f1000000-0000-4000-8000-0000000000e3',
          'recorded_by_dpo', 'f1000000-0000-4000-8000-0000000000a5', current_date, 'Planted')$$, '42501');
select pg_temp.expect_error($$update public.notice_acknowledgments set acknowledged_on = current_date$$, '42501');
select pg_temp.expect_error($$update public.notice_acknowledgments set recorded_note = 'Rewritten'$$, '42501');
reset role;
do $$
declare
  r text;
begin
  foreach r in array array['hearth_queue', 'hearth_job_offboarding', 'hearth_job_partitions', 'hearth_job_purge',
                           'hearth_job_revocation', 'hearth_worker'] loop
    perform pg_temp.act_as_job('1', r);
    perform pg_temp.expect_error(format($f$select * from public.record_notice_acknowledgement(%L, %L, current_date, 'Signed',
                                          null, null, null)$f$, pg_temp.id('1', 'a7'), pg_temp.id('1', 'e3')),
                                 '42501', 'permission denied%');
    perform set_config('role', 'none', true);
  end loop;
end
$$;

-- RAD-02 (PDPA-03, ACC-10, C0.9 PD-76): only the DPO who is still at the org records. Refused
-- (42501, notice_check_dpo()'s message): the Owner, an Admin, AI Admin, Leadership, the Compliance
-- Officer, a Team Admin, a Member, a DPO who has left (a9), a former Admin, an agent, an assistant,
-- Hearth itself, no acting person or no org, and a DPO whose role was revoked (org 2's a5). Nothing
-- is written for any of them.
select set_config('test.audit_max', (select coalesce(max(id), 0)::text from public.audit_events), true);
select set_config('test.acks', (select count(*)::text from public.notice_acknowledgments), true);
do $$
declare
  who text;
begin
  foreach who in array array['a1', 'a2', 'a3', 'a4', 'a6', 'a7', 'a8', 'a9', 'aa', 'ab', 'ac', 'a0'] loop
    perform pg_temp.act_as('1', who);
    perform pg_temp.expect_error(format($f$select * from pg_temp.record(%L, %L, pg_temp.today(), 'Signed a printed copy')$f$,
                                        case when who = 'a7' then pg_temp.id('1', 'a6') else pg_temp.id('1', 'a7') end,
                                        pg_temp.id('1', 'e3')),
                                 '42501', 'Only the Data Protection Officer can publish the notice.');
    perform set_config('role', 'none', true);
  end loop;
end
$$;
select set_config('app.org_id', pg_temp.id('1', '00')::text, true), set_config('app.user_id', '', true);
set local role hearth_app;
select pg_temp.expect_error(format($$select * from pg_temp.record(%L, %L, current_date, 'Signed a printed copy')$$,
                                   pg_temp.id('1', 'a7'), pg_temp.id('1', 'e3')), '42501', 'No org or user is set for this transaction');
select set_config('app.org_id', '', true), set_config('app.user_id', pg_temp.id('1', 'a5')::text, true);
select pg_temp.expect_error(format($$select * from pg_temp.record(%L, %L, current_date, 'Signed a printed copy')$$,
                                   pg_temp.id('1', 'a7'), pg_temp.id('1', 'e3')), '42501', 'No org or user is set%');
reset role;
update public.role_assignments set revoked_at = now(), revoked_by = pg_temp.id('2', 'a1')
where org_id = pg_temp.id('2', '00') and person_id = pg_temp.id('2', 'a5') and role = 'dpo';
select pg_temp.act_as('2', 'a5');
select pg_temp.expect_error(format($$select * from pg_temp.record(%L, %L, pg_temp.today(), 'Signed a printed copy')$$,
                                   pg_temp.id('2', 'a7'), pg_temp.id('2', 'e3')), '42501',
                            'Only the Data Protection Officer can publish the notice.');
reset role;

-- RAD-03 (OD-19; the lock order's exception for an admin action on someone else): never for
-- yourself, who acknowledge in Hearth, nor for no one (42501); never for someone who has left
-- (a9, 42501); and org 2's person named in org 1 is no person of org 1's (22023).
select pg_temp.act_as('1', 'a5');
select pg_temp.expect_error(format($$select * from pg_temp.record(%L, %L, pg_temp.today(), 'Signed a printed copy')$$,
                                   pg_temp.id('1', 'a5'), pg_temp.id('1', 'e3')), '42501',
                            'You acknowledge the notice yourself, in Hearth.');
select pg_temp.expect_error(format($$select * from pg_temp.record(null, %L, pg_temp.today(), 'Signed a printed copy')$$,
                                   pg_temp.id('1', 'e3')), '42501', 'You acknowledge the notice yourself, in Hearth.');
select pg_temp.expect_error(format($$select * from pg_temp.record(%L, %L, pg_temp.today(), 'Signed a printed copy')$$,
                                   pg_temp.id('1', 'a9'), pg_temp.id('1', 'e3')), '42501',
                            'Only someone still at the organisation can have an acknowledgement recorded.');
select pg_temp.expect_error(format($$select * from pg_temp.record(%L, %L, pg_temp.today(), 'Signed a printed copy')$$,
                                   pg_temp.id('2', 'a8'), pg_temp.id('1', 'e3')), '22023',
                            'There is no such person at the organisation.');
select pg_temp.expect_error(format($$select * from pg_temp.record(%L, %L, pg_temp.today(), 'Signed a printed copy')$$,
                                   gen_random_uuid(), pg_temp.id('1', 'e3')), '22023', 'There is no such person at the organisation.');

-- RAD-04 (PDPA-03, OD-19): an unknown version, none, or another org's, is no version of org 1's
-- (22023).
select pg_temp.expect_error(format($$select * from pg_temp.record(%L, %L, pg_temp.today(), 'Signed a printed copy')$$,
                                   pg_temp.id('1', 'a7'), gen_random_uuid()), '22023', 'There is no such version of the notice.');
select pg_temp.expect_error(format($$select * from pg_temp.record(%L, null, pg_temp.today(), 'Signed a printed copy')$$,
                                   pg_temp.id('1', 'a7')), '22023', 'There is no such version of the notice.');
select pg_temp.expect_error(format($$select * from pg_temp.record(%L, %L, pg_temp.today(), 'Signed a printed copy')$$,
                                   pg_temp.id('1', 'a7'), pg_temp.id('2', 'e3')), '22023', 'There is no such version of the notice.');
reset role;
select pg_temp.check(count(*) = 0, 'a refused record wrote to the audit log')
from public.audit_events where id > current_setting('test.audit_max')::bigint;
select pg_temp.check(count(*) = current_setting('test.acks')::bigint, 'a refused record added an acknowledgement')
from public.notice_acknowledgments;

-- Org 1 publishes version 1 (as its DPO, on the fixture's contact e6), with its registers made
-- ready as the superuser (as 160's ready() does). Its stand-in e3 is then no longer the latest, so
-- recording it is refused (HF007).
insert into public.processing_register (org_id, purpose, ai, pinned, needs_switch, version, status, basis, retention, providers,
                                        recorded_by)
select c.org_id, c.purpose, c.ai, c.pinned, c.needs_switch, c.version + 1, 'active', 'employment', 'Kept for 12 months',
       c.providers, pg_temp.id('1', 'a5')
from (select distinct on (r.purpose) r.* from public.processing_register r
      where r.org_id = pg_temp.id('1', '00') order by r.purpose, r.version desc) c
where not c.ai and c.status = 'active'
  and (c.basis is null or c.retention is null or c.basis in ('consent', 'deemed_consent_conduct', 'deemed_consent_notification'));
select pg_temp.act_as('1', 'a5');
select set_config('test.v1', p.notice::text, true)
from pg_temp.sources() s,
     public.publish_notice(0, 'Privacy notice', 'c09.2', s.keys, s.versions, s.clearances, 1, 'req-record', null, null) p;
select pg_temp.check((pg_temp.latest()).version = 1 and (pg_temp.latest()).id = current_setting('test.v1')::uuid,
                     'org 1 could not publish version 1');
select pg_temp.expect_error(format($$select * from pg_temp.record(%L, %L, pg_temp.today(), 'Signed a printed copy')$$,
                                   pg_temp.id('1', 'a7'), pg_temp.id('1', 'e3')), 'HF007',
                            'A newer version of the notice was published. Record the acknowledgement of that one.');

-- RAD-05 (PDPA-03, C0.9 PD-75): the day, from the day the version was published to today in the
-- org's zone, and the note, one line of 1 to 500 characters once trimmed of JavaScript's
-- whitespace (HF008, the day's message naming the version). Org 2's stand-in v1, published ten
-- days ago (as the superuser), shows the first day.
select pg_temp.expect_error(format($$select * from pg_temp.record(%L, %L, null, 'Signed a printed copy')$$,
                                   pg_temp.id('1', 'a7'), current_setting('test.v1')), 'HF008',
                            'Give the day they acknowledged it, from the day version 1 was published to today.');
select pg_temp.expect_error(format($$select * from pg_temp.record(%L, %L, pg_temp.today() + 1, 'Signed a printed copy')$$,
                                   pg_temp.id('1', 'a7'), current_setting('test.v1')), 'HF008', 'Give the day they acknowledged it%');
select pg_temp.expect_error(format($$select * from pg_temp.record(%L, %L, pg_temp.today() - 1, 'Signed a printed copy')$$,
                                   pg_temp.id('1', 'a7'), current_setting('test.v1')), 'HF008', 'Give the day they acknowledged it%');
do $$
declare
  n text;
begin
  foreach n in array array[null, '', E' \t\u00a0\u3000\ufeff', repeat('n', 501), E'Signed a printed copy\nat induction',
                           E'Signed\u0007a printed copy'] loop
    perform pg_temp.expect_error(format($f$select * from pg_temp.record(%L, %L, pg_temp.today(), %L)$f$,
                                        pg_temp.id('1', 'a7'), current_setting('test.v1'), n), 'HF008',
                                 'Say how they acknowledged it, on one line of at most 500 characters.');
  end loop;
end
$$;
-- The day is checked before the note.
select pg_temp.expect_error(format($$select * from pg_temp.record(%L, %L, null, '')$$,
                                   pg_temp.id('1', 'a7'), current_setting('test.v1')), 'HF008', 'Give the day%');
reset role;
insert into public.notice_versions (id, org_id, version, body, published_by, published_at)
values (pg_temp.id('2', 'e9'), pg_temp.id('2', '00'), 1, 'A second stand-in', pg_temp.id('2', 'a1'), now() - interval '10 days');
-- Org 2's a5 is granted the DPO role again (as the superuser), after RAD-02 revoked it.
insert into public.role_assignments (org_id, person_id, role, created_by, approved_by, approved_at)
values (pg_temp.id('2', '00'), pg_temp.id('2', 'a5'), 'dpo', pg_temp.id('2', 'a1'), pg_temp.id('2', 'a2'), now());
select pg_temp.act_as('2', 'a5');
select pg_temp.expect_error(format($$select * from pg_temp.record(%L, %L, pg_temp.today() - 11, 'Signed a printed copy')$$,
                                   pg_temp.id('2', 'a7'), pg_temp.id('2', 'e9')), 'HF008',
                            'Give the day they acknowledged it, from the day version 1 was published to today.');
select pg_temp.check(version = 1 and changed, 'the day org 2''s v1 was published was refused')
from pg_temp.record(pg_temp.id('2', 'a7'), pg_temp.id('2', 'e9'), pg_temp.today() - 10, 'Signed a printed copy');
-- A note of exactly 500 characters, with whitespace around it, is kept trimmed.
select pg_temp.check(version = 1 and changed, 'a note of 500 characters was refused')
from pg_temp.record(pg_temp.id('2', 'a8'), pg_temp.id('2', 'e9'), pg_temp.today(), E'\u3000' || repeat('n', 500) || E' \t');
reset role;
select pg_temp.check(count(*) = 2 and bool_and(length(recorded_note) = 500 or recorded_note = 'Signed a printed copy'),
                     'org 2''s recorded notes were not kept trimmed')
from public.notice_acknowledgments where org_id = pg_temp.id('2', '00') and notice_version_id = pg_temp.id('2', 'e9');

-- RAD-06 (PDPA-03, ADM-06, C0.9 PD-75): org 1's DPO records a7's acknowledgement of version 1: the
-- method, the DPO, no device, the day, the note trimmed, and the moment it was recorded; one audit
-- row naming the person, the version and the day, never the note; and no outbox row (the api
-- appends notice.acknowledged in the same transaction).
select set_config('test.audit_max', (select coalesce(max(id), 0)::text from public.audit_events), true);
select set_config('test.outbox_max', (select coalesce(max(id), 0)::text from public.outbox_events), true);
select pg_temp.act_as('1', 'a5');
select pg_temp.check(version = 1 and changed, 'org 1''s DPO could not record a7''s acknowledgement')
from pg_temp.record(pg_temp.id('1', 'a7'), current_setting('test.v1')::uuid, pg_temp.today(),
                    E' Signed a printed copy at induction\u00a0');
reset role;
select pg_temp.check(count(*) = 1 and bool_and(
                       method = 'recorded_by_dpo' and recorded_by = pg_temp.id('1', 'a5') and device_id is null
                       and acknowledged_on = (now() at time zone 'Asia/Singapore')::date
                       and recorded_note = 'Signed a printed copy at induction' and acknowledged_at = now()),
                     'a7''s acknowledgement was not recorded as the DPO recorded it')
from public.notice_acknowledgments
where person_id = pg_temp.id('1', 'a7') and notice_version_id = current_setting('test.v1')::uuid;
select pg_temp.check(count(*) = 1 and bool_and(
                       a.org_id = pg_temp.id('1', '00') and a.actor_id = pg_temp.id('1', 'a5')
                       and a.action = 'notice.acknowledgement_recorded' and a.target_type = 'person'
                       and a.target_id = pg_temp.id('1', 'a7')::text and a.request_id = 'req-record'
                       and a.device_id = 'd0000000-0000-4000-8000-0000000000d3' and a.ip = '192.0.2.60'
                       and a.reason is null and a.via is null and a.on_behalf_of_id is null
                       and a.details = jsonb_build_object('notice', current_setting('test.v1')::uuid, 'version', 1,
                                                          'acknowledged_on', (now() at time zone 'Asia/Singapore')::date)
                       and a.details::text not like '%Signed%'),
                     format('expected one notice.acknowledgement_recorded row, got %s', array_agg(a.details)))
from public.audit_events a where a.id > current_setting('test.audit_max')::bigint;
select pg_temp.check(count(*) = 0, 'recording an acknowledgement appended an outbox event itself')
from public.outbox_events where id > current_setting('test.outbox_max')::bigint;

-- RAD-07 (PDPA-03, C0.9 PD-42, PD-75): once per person and version. A second record writes nothing
-- (changed false), and so does a record after the person's own acknowledgement in the app (a8), and
-- the person's own acknowledgement after a record (a7, on a device of their own, e8, added as the
-- superuser). Their standing then reads acknowledged, as the api's gate reads it: a row for the
-- latest version, whatever its method.
select set_config('test.audit_max', (select coalesce(max(id), 0)::text from public.audit_events), true);
insert into public.devices (id, org_id, user_id, label) values (pg_temp.id('1', 'e8'), pg_temp.id('1', '00'), pg_temp.id('1', 'a7'), 'Phone');
select pg_temp.act_as('1', 'a8');
select pg_temp.check(version = 1 and changed, 'a8 could not acknowledge version 1 in the app')
from pg_temp.ack(current_setting('test.v1')::uuid, pg_temp.id('1', 'e1'));
reset role;
select set_config('test.audit_max', (select coalesce(max(id), 0)::text from public.audit_events), true);
select pg_temp.act_as('1', 'a5');
select pg_temp.check(version = 1 and not changed, 'recording a7 again changed something')
from pg_temp.record(pg_temp.id('1', 'a7'), current_setting('test.v1')::uuid, pg_temp.today(), 'Signed again');
select pg_temp.check(version = 1 and not changed, 'recording a8, who acknowledged in the app, changed something')
from pg_temp.record(pg_temp.id('1', 'a8'), current_setting('test.v1')::uuid, pg_temp.today(), 'Signed a printed copy');
reset role;
select pg_temp.act_as('1', 'a7');
select pg_temp.check(version = 1 and not changed, 'a7''s own acknowledgement after the DPO''s record changed something')
from pg_temp.ack(current_setting('test.v1')::uuid, pg_temp.id('1', 'e8'));
select pg_temp.check(exists (select 1 from public.notice_acknowledgments a
                             where a.person_id = pg_temp.id('1', 'a7') and a.notice_version_id = (pg_temp.latest()).id),
                     'a7''s standing does not read acknowledged');
reset role;
select pg_temp.check(count(*) = 0, 'a repeated acknowledgement wrote to the audit log')
from public.audit_events where id > current_setting('test.audit_max')::bigint;
select pg_temp.check(array_agg(format('%s %s %s', p.suffix, a.method, a.recorded_note) order by p.suffix)
                     = '{"a7 recorded_by_dpo Signed a printed copy at induction","a8 in_app "}',
                     format('version 1''s acknowledgements are %s', array_agg(format('%s %s', a.method, a.recorded_note))))
from public.notice_acknowledgments a
join (values ('a7'), ('a8')) as p (suffix) on a.person_id = pg_temp.id('1', p.suffix)
where a.notice_version_id = current_setting('test.v1')::uuid;

-- RAD-08 (C0.9 PD-75): the table's new checks, whoever writes (a superuser's insert): the day and
-- the note come together and only on a recorded row (23514, notice_acknowledgments_recorded_details),
-- and the note is one trimmed line of 1 to 500 characters (notice_acknowledgments_recorded_note). A
-- recorded row with neither, as 0010 allowed one, still inserts.
do $$
declare
  c record;
begin
  for c in
    select * from (values
      ('in_app', 'e1', null, current_date, 'Signed', 'notice_acknowledgments_recorded_details'),
      ('recorded_by_dpo', null, 'a5', current_date, null, 'notice_acknowledgments_recorded_details'),
      ('recorded_by_dpo', null, 'a5', null, 'Signed', 'notice_acknowledgments_recorded_details'),
      ('recorded_by_dpo', null, 'a5', current_date, ' Signed', 'notice_acknowledgments_recorded_note'),
      ('recorded_by_dpo', null, 'a5', current_date, E'Signed\nat induction', 'notice_acknowledgments_recorded_note'),
      ('recorded_by_dpo', null, 'a5', current_date, repeat('n', 501), 'notice_acknowledgments_recorded_note')
    ) as v (method, device, recorder, on_day, note, constraint_name)
  loop
    perform pg_temp.expect_error(format($f$insert into public.notice_acknowledgments (org_id, person_id, notice_version_id, method,
                                            device_id, recorded_by, acknowledged_on, recorded_note)
                                          values (%L, %L, %L, %L, %L, %L, %L, %L)$f$,
                                        pg_temp.id('1', '00'), pg_temp.id('1', 'a6'), pg_temp.id('1', 'e3'), c.method,
                                        case when c.device is not null then pg_temp.id('1', c.device) end,
                                        case when c.recorder is not null then pg_temp.id('1', c.recorder) end, c.on_day, c.note),
                                 '23514', '%' || c.constraint_name || '%');
  end loop;
end
$$;
select pg_temp.expect_rows(format($$insert into public.notice_acknowledgments (org_id, person_id, notice_version_id, method, recorded_by)
  values (%L, %L, %L, 'recorded_by_dpo', %L)$$, pg_temp.id('1', '00'), pg_temp.id('1', 'a6'), pg_temp.id('1', 'e3'),
                                  pg_temp.id('1', 'a5')), 1);
select pg_temp.check(convalidated, format('%s was left NOT VALID', conname))
from pg_constraint
where conrelid = 'public.notice_acknowledgments'::regclass
  and conname in ('notice_acknowledgments_recorded_details', 'notice_acknowledgments_recorded_note');
select set_config('app.org_id', '', true), set_config('app.user_id', '', true);
