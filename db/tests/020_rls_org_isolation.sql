-- ACC-11, CLAUDE.md Database: acting in one org, hearth_app sees exactly that org's rows of every
-- table it can read (none of the other org's), and can't write, change or delete the other org's.
-- The fixture has a row of every table in both orgs, so a table missing from it fails here.
-- (015 pins the policies' text, which covers the write side for every table.)
\ir fixtures/two_orgs.sql

do $$
declare
  t record;
  o text;
  key text;
  own bigint;
  seen bigint;
  other bigint;
begin
  foreach o in array array['1', '2'] loop
    for t in
      select format('%I.%I', n.nspname, c.relname) as name, c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname not like 'pg\_%' and n.nspname <> 'information_schema' and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and has_any_column_privilege('hearth_app', c.oid, 'SELECT')
    loop
      key := case t.name when 'public.orgs' then 'id' else 'org_id' end;
      execute format('select count(*) from %s where %I = $1', t.name, key) into own using pg_temp.id(o, '00');
      perform pg_temp.check(own > 0, format('%s: the fixture has no row in org %s; add one to db/tests/fixtures/two_orgs.sql', t.name, o));
      perform pg_temp.act_as(o, 'a1');
      execute format('select count(*), count(*) filter (where %I <> $1) from %s', key, t.name)
        into seen, other using pg_temp.id(o, '00');
      perform set_config('role', 'none', true);
      perform pg_temp.check(other = 0, format('%s: acting in org %s, hearth_app saw %s row(s) of another org', t.name, o, other));
      perform pg_temp.check(seen = own, format('%s: acting in org %s, hearth_app saw %s of its %s row(s)', t.name, o, seen, own));
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
select pg_temp.expect_error($$insert into public.audit_events (org_id, action)
  values ('f1000000-0000-4000-8000-000000000000', 'test.planted')$$, '42501');
select pg_temp.expect_error($$insert into public.data_access_events (org_id, type, subject_id, actor_id)
  values ('f1000000-0000-4000-8000-000000000000', 'export', 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000a8')$$, '42501');
select pg_temp.expect_rows($$update public.teams set name = name || ' (renamed)'$$, 2);
select pg_temp.expect_rows($$update public.people set full_name = full_name || ' (renamed)'$$, 10);
select pg_temp.expect_rows($$update public.sessions set last_seen_at = now()$$, 1);
select pg_temp.expect_rows($$delete from public.working_hours$$, 1);
reset role;
select pg_temp.check(count(*) = 0, 'an org 2 update reached org 1')
from public.people where org_id = 'f1000000-0000-4000-8000-000000000000' and full_name like '%(renamed)';
select pg_temp.check(count(*) = 1, 'an org 2 delete reached org 1')
from public.working_hours where org_id = 'f1000000-0000-4000-8000-000000000000';

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
