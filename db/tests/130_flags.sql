-- INF-FLAGS, T17, ADM-06, D41, CLAUDE.md Database: feature flags (0007). Every org has every flag
-- the migrations list, from the start; every ai.* flag is off and locked, past even the owner;
-- a flag changes only through set_feature_flag(), for an Owner or Admin who is still at the org,
-- never a locked one, with a cohort of this org's people and org-wide roles, writing one audit row
-- per change and nothing for a no-op; and feature_fence() refuses once a flag is off or has
-- changed. Every case runs as hearth_app (act_as) or the job role it tests unless it says it
-- arranges data as the superuser.
\ir fixtures/two_orgs.sql

-- What one org's flags look like, key by key, as the superuser reads them.
create function pg_temp.flags_of(o text) returns text[] language sql as $$
  select array_agg(format('%s %s %s', f.key, f.enabled, f.locked) order by f.key)
  from public.feature_flags f where f.org_id = pg_temp.id(o, '00')
$$;
create function pg_temp.default_flags() returns text[] language sql as $$
  select array_agg(format('%s %s %s', d.key, d.enabled, d.locked) order by d.key) from public.feature_flag_defaults() d
$$;
-- A call to set_feature_flag with the request's details, as the admin route makes it.
create function pg_temp.set_flag(flag text, enabled boolean, audience text, people uuid[], roles text[]) returns bigint
language sql as $$
  select public.set_feature_flag(flag, enabled, audience, people, roles, 'req-flags', pg_temp.id('1', 'e1'), '192.0.2.10')
$$;

-- 1. Every org has every flag at its default, untouched (revision 1, nobody has changed it), from
-- the orgs trigger; core.system is on and locked, and every ai.* flag off and locked.
select pg_temp.check(pg_temp.flags_of('1') = pg_temp.default_flags() and pg_temp.flags_of('2') = pg_temp.default_flags(),
                     'a fixture org does not have exactly the default flags');
select pg_temp.check(bool_and(revision = 1 and updated_by is null and audience = 'org' and cohort_people = '{}' and cohort_roles = '{}'),
                     'a flag starts changed or with a cohort')
from public.feature_flags where org_id in (pg_temp.id('1', '00'), pg_temp.id('2', '00'));
select pg_temp.check((select count(*) from public.feature_flag_defaults() d where d.key ~ '^ai(\.|$)' and (d.enabled or not d.locked)) = 0
                     and (select count(*) from public.feature_flag_defaults() d where d.key = 'core.system' and d.enabled and d.locked) = 1
                     and (select count(*) from public.feature_flag_defaults() d where d.key ~ '^ai(\.|$)') >= 17,
                     'the defaults do not lock every ai.* flag off and core.system on');
insert into public.orgs (id, name) values ('f3000000-0000-4000-8000-000000000000', 'A new org');
select pg_temp.check(pg_temp.flags_of('3') = pg_temp.default_flags(), 'a new org did not get every flag');

-- 2. No ai.* flag can be turned on or unlocked, by anyone: the constraint holds for the owner and
-- the superuser alike (23514). Only A0's migration replaces it.
select pg_temp.expect_error($$update public.feature_flags set enabled = true where key = 'ai.ask'$$, '23514', '%feature_flags_ai_locked_off%');
select pg_temp.expect_error($$update public.feature_flags set locked = false where key = 'ai'$$, '23514', '%feature_flags_ai_locked_off%');
select pg_temp.expect_error($$insert into public.feature_flags (org_id, key, enabled, locked)
  values ('f1000000-0000-4000-8000-000000000000', 'ai.agents.x1', true, true)$$, '23514', '%feature_flags_ai_locked_off%');
select pg_temp.expect_error($$insert into public.feature_flags (org_id, key, enabled, locked)
  values ('f1000000-0000-4000-8000-000000000000', 'ai.agents.x1', false, false)$$, '23514', '%feature_flags_ai_locked_off%');
set local role hearth_owner;
select pg_temp.expect_error($$update public.feature_flags set enabled = true, locked = false where key = 'ai.transcription'$$, '23514',
                            '%feature_flags_ai_locked_off%');
reset role;

-- 3. The shape of a cohort (23514): people or roles exactly when the audience is a cohort, at most
-- 1,000 of them, no empty entry, and only org-wide roles (Team Admin, whose powers end with its
-- team, comes with team cohorts).
insert into public.feature_flags (org_id, key, enabled, locked)
values (pg_temp.id('1', '00'), 't', true, false), (pg_temp.id('1', '00'), 't.child', true, false),
       (pg_temp.id('1', '00'), 't.locked', true, true), (pg_temp.id('2', '00'), 't', true, false);
select pg_temp.expect_error($$update public.feature_flags set cohort_people = '{f1000000-0000-4000-8000-0000000000a8}'
  where key = 't' and org_id = 'f1000000-0000-4000-8000-000000000000'$$, '23514', '%feature_flags_cohort%');
select pg_temp.expect_error($$update public.feature_flags set audience = 'cohort'
  where key = 't' and org_id = 'f1000000-0000-4000-8000-000000000000'$$, '23514', '%feature_flags_cohort%');
select pg_temp.expect_error($$update public.feature_flags set audience = 'cohort', cohort_roles = '{team_admin}'
  where key = 't' and org_id = 'f1000000-0000-4000-8000-000000000000'$$, '23514', '%feature_flags_cohort_roles_check%');
select pg_temp.expect_error($$update public.feature_flags set audience = 'cohort', cohort_people = array[null]::uuid[]
  where key = 't' and org_id = 'f1000000-0000-4000-8000-000000000000'$$, '23514', '%feature_flags_cohort%');
select pg_temp.expect_error($$update public.feature_flags set audience = 'cohort',
  cohort_people = array(select gen_random_uuid() from generate_series(1, 1000)), cohort_roles = '{owner}'
  where key = 't' and org_id = 'f1000000-0000-4000-8000-000000000000'$$, '23514', '%feature_flags_cohort%');
-- A revision and who changed it go together.
select pg_temp.expect_error($$update public.feature_flags set revision = 2
  where key = 't' and org_id = 'f1000000-0000-4000-8000-000000000000'$$, '23514');

-- 4. hearth_app reads flags but writes none directly (42501).
select set_config('test.flag_count', (cardinality(pg_temp.default_flags()) + 3)::text, true);
select pg_temp.act_as('1', 'a1');
select pg_temp.check((select count(*) from public.feature_flags) = current_setting('test.flag_count')::bigint,
                     'hearth_app did not see its org''s flags');
select pg_temp.expect_error($$update public.feature_flags set enabled = false where key = 't'$$, '42501');
select pg_temp.expect_error($$insert into public.feature_flags (org_id, key, enabled, locked)
  values ('f1000000-0000-4000-8000-000000000000', 't.new', true, false)$$, '42501');
select pg_temp.expect_error($$delete from public.feature_flags where key = 't'$$, '42501');
reset role;

-- 5. set_feature_flag for every role (ACC-10): the Owner and an Admin may change a flag; AI Admin,
-- Leadership, the DPO, the Compliance Officer, a Team Admin, a Member, a DPO who has left, a
-- former Admin, an agent, an assistant and Hearth itself may not (42501), and nor may another
-- org's Owner.
select set_config('test.audit_max', (select coalesce(max(id), 0)::text from public.audit_events), true);
select pg_temp.act_as('1', 'a1');
select pg_temp.check(pg_temp.set_flag('t', false, 'org', '{}', '{}') = 2, 'the Owner could not change a flag');
reset role;
select pg_temp.act_as('1', 'a2');
select pg_temp.check(pg_temp.set_flag('t', true, 'org', '{}', '{}') = 3, 'an Admin could not change a flag');
reset role;
do $$
declare
  who text;
begin
  foreach who in array array['a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'aa', 'ab', 'ac', 'a0'] loop
    perform pg_temp.act_as('1', who);
    perform pg_temp.expect_error($f$select pg_temp.set_flag('t', false, 'org', '{}', '{}')$f$, '42501',
                                 'Only an Owner or Admin can change a feature flag.');
    perform set_config('role', 'none', true);
  end loop;
end
$$;
select set_config('app.org_id', pg_temp.id('1', '00')::text, true), set_config('app.user_id', pg_temp.id('2', 'a1')::text, true);
set local role hearth_app;
select pg_temp.expect_error($$select pg_temp.set_flag('t', false, 'org', '{}', '{}')$$, '42501');
reset role;
-- Nor may an Admin who has left, though the role was never revoked (org 2's a2, deactivated as the
-- superuser).
update public.people set deactivated_at = now(), deactivated_by = pg_temp.id('2', 'a1') where id = pg_temp.id('2', 'a2');
select pg_temp.act_as('2', 'a2');
select pg_temp.expect_error($$select pg_temp.set_flag('t', false, 'org', '{}', '{}')$$, '42501');
reset role;
select pg_temp.act_as('2', 'a1');
select pg_temp.check(pg_temp.set_flag('t', true, 'org', '{}', '{}') = 1, 'org 2''s Owner could not leave its flag as it is');
reset role;
-- With no org or no acting person set (42501).
select set_config('app.org_id', '', true), set_config('app.user_id', pg_temp.id('1', 'a1')::text, true);
set local role hearth_app;
select pg_temp.expect_error($$select pg_temp.set_flag('t', false, 'org', '{}', '{}')$$, '42501');
reset role;
select set_config('app.org_id', pg_temp.id('1', '00')::text, true), set_config('app.user_id', '', true);
set local role hearth_app;
select pg_temp.expect_error($$select pg_temp.set_flag('t', false, 'org', '{}', '{}')$$, '42501');
reset role;
-- The worker's roles may not call it at all (42501).
do $$
declare
  r text;
begin
  foreach r in array array['hearth_queue', 'hearth_job_offboarding', 'hearth_job_partitions', 'hearth_job_purge', 'hearth_worker'] loop
    perform pg_temp.act_as_job('1', r);
    perform pg_temp.expect_error($f$select public.set_feature_flag('t', false, 'org', '{}', '{}', null, null, null)$f$, '42501');
    perform set_config('role', 'none', true);
  end loop;
end
$$;
select pg_temp.check(revision = 3 and enabled and updated_by = pg_temp.id('1', 'a2'), 'a refused call changed the flag')
from public.feature_flags where org_id = pg_temp.id('1', '00') and key = 't';

-- 6. A locked flag is refused (HF003), core.system and every ai.* flag included, before anything
-- is written; an unknown flag is 22023; a cohort naming anyone who isn't a person still at this org
-- (a person of another org, one who has left, a team, an id that names nothing) is HF004.
select pg_temp.act_as('1', 'a1');
select pg_temp.expect_error($$select pg_temp.set_flag('core.system', false, 'org', '{}', '{}')$$, 'HF003');
select pg_temp.expect_error($$select pg_temp.set_flag('ai.ask', true, 'org', '{}', '{}')$$, 'HF003');
select pg_temp.expect_error($$select pg_temp.set_flag('ai', false, 'org', '{}', '{}')$$, 'HF003');
select pg_temp.expect_error($$select pg_temp.set_flag('t.locked', false, 'org', '{}', '{}')$$, 'HF003');
select pg_temp.expect_error($$select pg_temp.set_flag('no.such_flag', true, 'org', '{}', '{}')$$, '22023');
select pg_temp.expect_error($$select pg_temp.set_flag(null, true, 'org', '{}', '{}')$$, '22023');
select pg_temp.expect_error($$select pg_temp.set_flag('t', true, 'cohort', '{f2000000-0000-4000-8000-0000000000a8}', '{}')$$, 'HF004',
                            'A cohort can only add people who are still at this organisation.');
-- R2E2E-2: nor anyone who has left (a9, deactivated), alone or beside someone still here.
select pg_temp.expect_error($$select pg_temp.set_flag('t', true, 'cohort', '{f1000000-0000-4000-8000-0000000000a9}', '{}')$$, 'HF004');
select pg_temp.expect_error($$select pg_temp.set_flag('t', true, 'cohort', '{f1000000-0000-4000-8000-0000000000a8,f1000000-0000-4000-8000-0000000000a9}', '{}')$$, 'HF004');
select pg_temp.expect_error($$select pg_temp.set_flag('t', true, 'cohort', '{f1000000-0000-4000-8000-0000000000d1}', '{}')$$, 'HF004');
select pg_temp.expect_error($$select pg_temp.set_flag('t', true, 'cohort', '{f1000000-0000-4000-8000-0000000000a8,f1000000-0000-4000-8000-0000000000ff}', '{}')$$, 'HF004');
select pg_temp.expect_error($$select pg_temp.set_flag('t', true, 'cohort', array[null]::uuid[], '{}')$$, 'HF004');
-- The table's own checks still stand behind the function: a cohort with no one in it, or a role
-- that isn't an org-wide one (23514).
select pg_temp.expect_error($$select pg_temp.set_flag('t', true, 'cohort', '{}', '{}')$$, '23514');
select pg_temp.expect_error($$select pg_temp.set_flag('t', true, 'cohort', '{}', '{team_admin}')$$, '23514');
reset role;
select pg_temp.check(count(*) = 2, format('a refused call wrote to the audit log (%s rows)', count(*)))
from public.audit_events where id > current_setting('test.audit_max')::bigint;
select pg_temp.check(bool_and(revision = 1 and updated_by is null), 'a locked flag changed')
from public.feature_flags where org_id = pg_temp.id('1', '00') and (key = 'core.system' or key ~ '^ai(\.|$)' or key = 't.locked');

-- 7. A change: the flag's values, a new revision, who changed it and when, and one flag.set audit
-- row naming the request, device and address, the value before and after, and who joined and left
-- the cohort.
select pg_temp.act_as('1', 'a1');
select pg_temp.check(pg_temp.set_flag('t', true, 'cohort', array[pg_temp.id('1', 'a8'), pg_temp.id('1', 'a5')], '{dpo}') = 4,
                     'narrowing to a cohort did not make revision 4');
select pg_temp.check(pg_temp.set_flag('t', true, 'cohort', array[pg_temp.id('1', 'a7'), pg_temp.id('1', 'a8')], '{leadership}') = 5,
                     'changing the cohort did not make revision 5');
reset role;
select pg_temp.check(f.enabled and f.audience = 'cohort' and f.revision = 5 and f.updated_by = pg_temp.id('1', 'a1')
                     and f.updated_at = now()
                     and f.cohort_people = (select array_agg(x order by x) from unnest(array[pg_temp.id('1', 'a7'), pg_temp.id('1', 'a8')]) x)
                     and f.cohort_roles = '{leadership}',
                     'the flag does not hold the change')
from public.feature_flags f where f.org_id = pg_temp.id('1', '00') and f.key = 't';
select pg_temp.check(a.actor_id = pg_temp.id('1', 'a1') and a.target_type = 'feature_flag' and a.target_id = 't'
                     and a.request_id = 'req-flags' and a.device_id = pg_temp.id('1', 'e1') and a.ip = '192.0.2.10'
                     and a.details ->> 'enabled' = 'true' and a.details ->> 'was_enabled' = 'true'
                     and a.details ->> 'audience' = 'cohort' and (a.details ->> 'revision')::int = 5
                     and a.details -> 'people_added' = jsonb_build_array(pg_temp.id('1', 'a7'))
                     and a.details -> 'people_removed' = jsonb_build_array(pg_temp.id('1', 'a5'))
                     and a.details -> 'roles_added' = '["leadership"]' and a.details -> 'roles_removed' = '["dpo"]',
                     format('the audit row does not record the change: %s', a.details))
from public.audit_events a
where a.id = (select max(id) from public.audit_events where action = 'flag.set');
select pg_temp.check(count(*) = 4 and bool_and(action = 'flag.set' and org_id = pg_temp.id('1', '00')),
                     format('expected one flag.set row per change, got %s', count(*)))
from public.audit_events where id > current_setting('test.audit_max')::bigint;

-- 8. A no-op changes nothing and writes nothing: the same values, the same cohort in another order
-- or with an entry twice, return the current revision.
select set_config('test.audit_max', (select max(id)::text from public.audit_events), true);
select pg_temp.act_as('1', 'a2');
select pg_temp.check(pg_temp.set_flag('t', true, 'cohort', array[pg_temp.id('1', 'a8'), pg_temp.id('1', 'a7')], '{leadership}') = 5
                     and pg_temp.set_flag('t', true, 'cohort', array[pg_temp.id('1', 'a7'), pg_temp.id('1', 'a8'), pg_temp.id('1', 'a7')],
                                          '{leadership,leadership}') = 5,
                     'a no-op made a new revision');
reset role;
select pg_temp.check(count(*) = 0, 'a no-op wrote to the audit log') from public.audit_events
where id > current_setting('test.audit_max')::bigint;
select pg_temp.check(updated_by = pg_temp.id('1', 'a1'), 'a no-op changed who last changed the flag')
from public.feature_flags where org_id = pg_temp.id('1', '00') and key = 't';
-- Back to the whole org.
select pg_temp.act_as('1', 'a2');
select pg_temp.check(pg_temp.set_flag('t', true, 'org', '{}', '{}') = 6, 'widening to the org did not make revision 6');
reset role;
select pg_temp.check(details -> 'people_removed' @> jsonb_build_array(pg_temp.id('1', 'a7'), pg_temp.id('1', 'a8'))
                     and details -> 'roles_removed' = '["leadership"]' and details -> 'people_added' = '[]',
                     format('widening did not record who left the cohort: %s', details))
from public.audit_events where id = (select max(id) from public.audit_events where action = 'flag.set');
-- Another org's flag of the same key is untouched.
select pg_temp.check(revision = 1 and updated_by is null, 'a change reached another org''s flag')
from public.feature_flags where org_id = pg_temp.id('2', '00') and key = 't';

-- 9. feature_fence (as the offboarding consumer's role, the one role that may call it in C0.6):
-- passes while the flag and every flag above it are on at the revisions seen, from the top, and
-- refuses (HF001) once one is off or has moved on, or for a flag that doesn't exist.
select pg_temp.act_as_job('1', 'hearth_job_offboarding');
select public.feature_fence('core.system', '{1}');
select public.feature_fence('t', '{6}');
select public.feature_fence('t.child', '{6,1}');
select pg_temp.expect_error($$select public.feature_fence('t.child', '{1,6}')$$, 'HF001', '%changed since%');
select pg_temp.expect_error($$select public.feature_fence('t.child', '{6}')$$, 'HF001', '%changed since%');
select pg_temp.expect_error($$select public.feature_fence('t', '{5}')$$, 'HF001', '%changed since%');
select pg_temp.expect_error($$select public.feature_fence('t', null)$$, 'HF001', '%changed since%');
select pg_temp.expect_error($$select public.feature_fence('no.such_flag', '{1}')$$, 'HF001', '%no feature flag%');
select pg_temp.expect_error($$select public.feature_fence('ai.ask', '{1,1}')$$, 'HF001', '%switched off (ai)%');
reset role;
select pg_temp.act_as('1', 'a1');
select pg_temp.check(pg_temp.set_flag('t', false, 'org', '{}', '{}') = 7, 'switching off did not make revision 7');
reset role;
select pg_temp.act_as_job('1', 'hearth_job_offboarding');
select pg_temp.expect_error($$select public.feature_fence('t', '{7}')$$, 'HF001', '%switched off (t)%');
select pg_temp.expect_error($$select public.feature_fence('t.child', '{7,1}')$$, 'HF001', '%switched off (t)%');
reset role;

-- 10. Someone a cohort already names who then leaves never blocks the flag: it can still be switched
-- off, resent or narrowed with them in it (they match nothing: evaluate.ts), and only a person the
-- change adds must still be at the org (HF004).
select pg_temp.act_as('1', 'a1');
select pg_temp.check(pg_temp.set_flag('t', true, 'cohort', array[pg_temp.id('1', 'a6')], '{}') = 8,
                     'naming a6 did not make revision 8');
reset role;
update public.people set deactivated_at = now(), deactivated_by = pg_temp.id('1', 'a1') where id = pg_temp.id('1', 'a6');
select pg_temp.act_as('1', 'a1');
select pg_temp.check(pg_temp.set_flag('t', false, 'cohort', array[pg_temp.id('1', 'a6')], '{}') = 9,
                     'a leaver already in the cohort stopped the flag being switched off');
select pg_temp.check(pg_temp.set_flag('t', false, 'cohort', array[pg_temp.id('1', 'a6'), pg_temp.id('1', 'a8')], '{}') = 10,
                     'a leaver already in the cohort stopped someone still here being added');
select pg_temp.expect_error($$select pg_temp.set_flag('t', false, 'cohort', '{f1000000-0000-4000-8000-0000000000a6,f1000000-0000-4000-8000-0000000000a8,f1000000-0000-4000-8000-0000000000a9}', '{}')$$,
                            'HF004', 'A cohort can only add people who are still at this organisation.');
select pg_temp.check(pg_temp.set_flag('t', false, 'org', '{}', '{}') = 11, 'dropping the cohort did not make revision 11');
reset role;
